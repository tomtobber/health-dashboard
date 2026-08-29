# Phase 2 Detail — Sync + Storage / Google Health Provider

## Scope

Retrieve Google Health data, store it in the normalized `metric_entries` model, use webhooks where supported and polling/reconciliation where not, and make backfill/sync idempotent and observable.

## Google Health OAuth Scopes

Current scope list:

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`
- `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`
- `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`
- `https://www.googleapis.com/auth/googlehealth.sleep.readonly`
- `https://www.googleapis.com/auth/googlehealth.profile.readonly`

Use literal Google Health scope URLs. Do not substitute legacy Google Fit `fitness.*` scopes.

`googlehealth.profile.readonly` is required for `users.getIdentity`.

Do not add `include_granted_scopes` to the OAuth authorize URL.

## Subscriber Model

Subscribers are scoped to the Google Cloud project, not individual users.

This app uses exactly one subscriber:

`POST https://health.googleapis.com/v4/projects/{project_number}/subscribers?subscriberId={subscriberId}`

Important:
- `{project_number}` is the numeric Google Cloud project number, not the string project ID.
- `subscriberId` is self-chosen, 4–36 characters, matching `[a-z]([a-z0-9-]{2,34}[a-z0-9])`.
- Do not use the literal `"self"`.

Request body:
- `endpointAuthorization.secret` — full auth scheme string, e.g. `Bearer <WEBHOOK_AUTH_TOKEN>`
- `subscriberConfigs` — a list containing one object with a plural `dataTypes` array
- `subscriptionCreatePolicy: AUTOMATIC`

No per-user `Subscription` resources are created.

Connecting a Google account:
- stores OAuth tokens
- obtains identity
- starts backfill
- does not call subscriber registration

Disconnecting:
- disables the local `connected_accounts` row / revokes OAuth token
- does not alter the project subscriber

Subscriber registration is managed by:

`npm run setup:subscriber`

Run manually once initially and again when `WEBHOOK_SUPPORTED_METRICS` changes. Never run it automatically on app startup or every Render deploy.

`GOOGLE_PROJECT_ID` and `GOOGLE_SUBSCRIBER_ID` must fail startup/configuration validation if missing; do not supply silent placeholder defaults.

## Verification Handshake

The provider does not use GET/`hub.challenge`.

Subscriber create/update performs two POST verification requests with:

```json
{"type":"verification"}
```

Authorized request:
- includes configured Authorization header
- endpoint returns `200 OK` or `201 Created`

Unauthorized request:
- has no credentials
- endpoint returns `401 Unauthorized` or `403 Forbidden`

Both must pass or subscriber creation/update fails with `FAILED_PRECONDITION`.

## Notification Payload

Real payload shape:

```json
{
  "data": {
    "healthUserId": "...",
    "operation": "UPSERT | DELETE",
    "dataType": "steps",
    "intervals": [
      {
        "physicalTimeInterval": {
          "startTime": "...",
          "endTime": "..."
        }
      }
    ]
  }
}
```

Respond `204 No Content` immediately and process asynchronously.

Notifications can contain up to 99 messages per push.

Non-success or timeout causes provider retry. Notifications are stored/retried for up to seven days before being discarded.

## Webhook Attribution — Hard Security Invariant

Match the notification's `healthUserId` against `connected_accounts.health_user_id`.

Exact-match only.

Rules:
1. If neither `healthUserId` nor a valid local user identifier is present, reject before constructing a database query.
2. Never allow an empty match condition to broaden into a query.
3. If no active connected account matches, discard/reject and log.
4. Never fall back to the first/any active account.
5. Attribution logic is identical in all environments.
6. Tests may mock/inject the DB client, but must not bypass the attribution logic based on `NODE_ENV`, `DATABASE_URL`, hostname, or similar.
7. Automated coverage must include 2+ simultaneously active accounts and the real nested payload shape.
8. Before production, live-verify two simultaneously connected accounts against the deployed Render instance.

## Identity Mapping

Use:

`GET https://health.googleapis.com/v4/users/me/identity`

Response:

```text
{ name, legacyUserId, healthUserId }
```

Populate `connected_accounts.health_user_id` at connect time.

Do not decode the OAuth `id_token` as the webhook attribution mechanism.

Accounts connected before `googlehealth.profile.readonly` was added need to reconnect because scopes do not retroactively change already-issued tokens.

## Webhook-Supported Metric Types

Individually confirmed accepted by live `subscribers.create`/`update` in kebab-case:

- `steps`
- `altitude`
- `active-zone-minutes`
- `activity-level`
- `blood-glucose`
- `body-fat`
- `calories-in-heart-rate-zone`
- `daily-heart-rate-variability`
- `daily-heart-rate-zones`
- `daily-oxygen-saturation`
- `daily-respiratory-rate`
- `daily-resting-heart-rate`
- `daily-sleep-temperature-derivations`
- `distance`
- `exercise`
- `floors`
- `heart-rate`
- `heart-rate-variability`
- `height`
- `hydration-log`
- `nutrition-log`
- `respiratory-rate-sleep-summary`
- `run-vo2-max`
- `sedentary-period`
- `sleep`
- `time-in-heart-rate-zone`
- `weight`

26 of 27 documented types were confirmed.

Use kebab-case consistently in `WEBHOOK_SUPPORTED_METRICS`, sync service, downsampling, and `METRICS_14_DAY`.

Do not assume the per-user data-point endpoints `/dataTypes/{type}/...` use the same casing without checking.

## Polling-Only / Rejected Types

`total-calories` and `total_calories` were individually rejected across spelling variants and are genuinely unsupported by the webhook subscriber endpoint.

Confirmed polling-only types:
- generic `vo2Max`
- `dailyVo2Max`
- `electrocardiogram`
- `irregularRhythmNotification`
- `coreBodyTemperature`
- `bloodPressure`
- `total-calories` / `total_calories`

Important distinction:
- `runVo2Max` / `run-vo2-max` is webhook-supported.
- generic VO2 Max variants are polling-only.

The provider's supported list has changed materially during the project. Re-verify against current live documentation, with direct quotes, before trusting it after a significant gap.

## Sync Strategy

Webhook-supported types:
- webhook triggers immediate sync
- scheduled reconciliation is the backup for missed/delayed deliveries and disabled subscriptions

Polling-only types:
- scheduled polling/reconciliation

Sync strategy is per data type, not uniform.

## Query Windows

Most types support approximately 90 days per query.

The following are capped at 14 days/request:
- heart rate
- active minutes
- total calories
- calories in heart-rate zone

Batch requests accordingly.

## Initial Backfill

Backfill is separate from ongoing sync.

- Trigger immediately after OAuth completes.
- Run asynchronously/queued, never synchronously inside the OAuth callback.
- UI shows syncing/in-progress state and displays data as it arrives.
- Must be resumable and idempotent.
- Uses the same upsert logic as regular sync.

## Normalized Mapping

`mapToNormalizedSchema` returns an array intentionally.

One provider point can expand into multiple normalized rows.

Dimensioned values:
- one row per dimension, e.g. `active-zone-minutes` + `FAT_BURN`, `CARDIO`, `PEAK`

Sleep:
- one `sleep` summary row for total minutes asleep
- one `sleep_stage` row per stage transition with actual interval and stage dimension

Blood pressure:
- systolic and diastolic are independent components
- use `dimension` + `value_numeric`
- do not encode them as `value_min`/`value_max`

Range metrics:
- use `value_min`/`value_max` for boundaries
- use `dimension` to identify the range
- use `value_numeric` for an associated value such as minutes in that zone

Audit real payloads for arrays/breakdowns/ranges before assuming scalar mapping.

## Deduplication

Raw stream with native point ID:

`(user_id, provider, metric_type, dimension, external_id)`

Reconciled stream / interval or rollup without stable ID:

`(user_id, provider, metric_type, dimension, source_stream, start_time, end_time)`

Use `ON CONFLICT` upsert.

Never insert then check.

`dimension` is mandatory in both uniqueness variants because one external point can expand into multiple normalized rows.

Reconciled data wins over raw data.

## Deletion Reconciliation

There is no reliable per-data-point delete notification.

During reconciliation:
1. fetch current provider data for the window
2. compare with stored rows
3. set `deleted_at` on stored points no longer returned

Use soft deletion. If the point reappears after a provider delay, history remains reversible.

## Observability

Every sync operation writes `sync_runs`:

- `user_id`
- `provider`
- `metric_type`
- `trigger`
- `requested_range`
- `status`
- `points_fetched`
- `points_upserted`
- `pages_fetched`
- `error`
- start/completion timestamps

This is queryable state, not merely logs.

Subscription health:
- Google can auto-disable webhook subscriptions for inactive subscribers.
- Scheduled health check confirms the project subscriber is active and re-registers if necessary.

Gap detection:
- flag suspicious patterns such as a zero-data day between normal-density days
- do not assume every gap is a sync failure; devices can legitimately be absent

Raw-vs-reconciled divergence:
- periodically compare both streams for the same window
- log meaningful differences
- do not block sync merely because values diverge

## Provider Security Hardening Still Outstanding

Google cryptographically signs webhook payloads:
- Tink/ECDSA P-256
- keys rotate every 30 days
- signature is in `GOOGLE-HEALTH-API-SIGNATURE`
- provider public keyset is at its documented Google-hosted location

Current implementation uses shared-secret Authorization checking only.

Signature verification remains a future hardening task.
