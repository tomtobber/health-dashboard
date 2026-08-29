# Decision Log — Personal Health Dashboard

Append-only rationale/history. This file explains why the current state exists. It is not a replacement for `PROJECT_CONTEXT.md`; current state there wins if wording or decisions differ.

## Project Context File Strategy

The project originally kept vision, all phases, data model, APIs, provider mechanics, deployment, implementation history, and rationale in one always-loaded file.

The current structure separates:
- always-active current state: `PROJECT_CONTEXT.md`
- feature implementation detail: `phases/*.md`
- rationale/history: this file

This preserves institutional memory without forcing every session to re-ingest it.

## Phase 3 — Custom Metrics

### Why `metric_type` is typed directly by the user

The stored key is deliberately user-controlled kebab-case rather than being silently slugified from `display_name`. This gives explicit control over the stable key and avoids treating display naming as an implementation detail.

### Why reserved metric types come from adapter constants

The reserved set is derived at import time from `WEBHOOK_SUPPORTED_METRICS`, `POLLING_ONLY_METRICS`, `METRICS_14_DAY`, plus known provider identifiers. A separate hand-maintained list could drift away from the actual adapters.

### Why `value_type` and `unit` become immutable after first use

Changing either after entries exist could silently change the meaning of historical data. `display_name` remains editable because it does not affect interpretation.

### Why categories are a fixed list

Allowing arbitrary new category values during logging would make the data model unstable. Category management is explicit, and removing an already-used value must be blocked rather than orphaning historical meaning.

### Why archived definitions remain queryable

Retirement controls creation of new entries, not historical access. Historical charts and exports need the definition metadata even after a metric is retired.

### Why manual entry is a degenerate adapter

Manual entry has no external system to authenticate against or sync from. Treating it as a degenerate adapter preserves the single normalized write path without inventing a fake synchronization cycle.

### Why the combined create-and-log operation is transactional

Creating a definition and its first entry are one user-visible operation. A failure between the two DB mutations must not leave ambiguous partial state.

## Phase 5 — Customizable Charts

### Why saved panels use metric-type strings instead of FKs

A saved view should survive deletion of a zero-entry custom metric. The panel can then render a missing series gracefully rather than making the whole saved view invalid.

### Why relative time ranges resolve at render time

"Last 7 days" should mean the seven days immediately preceding the time the user opens the view, not the seven days that existed when the view was saved.

### Why `weekly_avg` is calendar-week

Daily points become low-value over long ranges such as a year. Fixed weekly buckets show shape without drowning the chart in day-to-day noise. It is display aggregation, not a trend conclusion.

### Why `weekly_avg` is the default

Boolean and category metrics ignore aggregation because they render as events. Therefore a universal `weekly_avg` default does not harm those types, while numeric/duration charts start at a useful long-range default.

### Why aggregation uses UTC

The existing daily aggregation already used UTC. Weekly aggregation follows the same convention to avoid introducing a third definition of "day/week" based on user timezone.

### Why overlays use separate Y axes

Metrics such as steps and heart rate have incomparable scales and units. Sharing a Y axis would visually imply a relationship that the values do not support.

### Why missing metrics do not break a panel

A saved panel can outlive a hard-deleted zero-entry custom metric. Returning fallback metadata plus an empty series lets the rest of an overlay continue rendering.

## Phase 6 — Personal Baselines

### Why baselines use the canonical read layer

Per Architecture Principle 7, analysis must not reimplement raw-vs-reconciled precedence. Baselines consume already-reconciled entries from `queryEnrichedMetricEntries`.

### Why there is a minimum sample-size gate

A statistic based on very few observations can look precise while being misleading. Fewer than 10 entries therefore returns an explicit insufficient-data result.

### Why boolean/category metrics are rejected

A mean is not meaningful for these value types. The project consistently prefers explicit validation errors over silent empty or zero results.

### Why the baseline window is configurable

The window is a product-level choice per user and metric, rather than a fixed universal period. The default is 90 days.

### Why the config has no metric FK

A config can remain after a custom metric is deleted. This is intentionally harmless state rather than an integrity error.

## Phase 6 — Trend Detection

### Why trend reuses `metric_baseline_configs`

The trend and baseline operate over the same historical window. Adding a second configuration table would duplicate state and make the two features drift.

The table name is now slightly misleading because it supports both features. Renaming it is deferred because it would require a migration without providing enough immediate value.

### Why regression uses daily means

Multiple entries on the same day would otherwise overweight high-frequency days. Daily bucketing gives each UTC calendar day one mean value.

### Why regression x uses real calendar distance

Using sequential rank would compress gaps with no data. Real days since the window start preserve the actual time scale of the slope.

### Why slope sign alone does not determine direction

A noisy series can have a positive or negative slope without exhibiting a meaningful directional pattern. Pearson `r` therefore gates directional labels using `|r| >= 0.3`.

### Why trend has its own sample-size constant

`MIN_TREND_SAMPLE_SIZE` starts at 10, like `MIN_BASELINE_SAMPLE_SIZE`, but the concepts differ. They may need to diverge later.

### Why trend language is directional only

Whether increasing or decreasing is desirable depends on the metric. The system must not make that judgment. Therefore the labels are only `increasing`, `decreasing`, and `no_clear_trend`.

## Data Model — Compound and Range Metrics

Real synced payload inspection revealed that some provider points contain multiple independently queryable facts.

Examples:
- active-zone-minutes can include a heart-rate zone alongside its numeric value
- sleep sessions can contain 10+ stage transitions
- blood pressure contains systolic and diastolic components
- heart-rate zones can include changing zone boundaries

This led to:
- array-returning `mapToNormalizedSchema`
- `dimension`
- `value_min` / `value_max`

The important semantic distinction is:
- `dimension + value_numeric` = multiple named measurements/components
- `value_min + value_max` = boundaries of one quantity

The design came from real payloads rather than docs, so future metric types should be audited from actual data before assuming a simple scalar mapping.

## Deduplication / Reconciliation

The raw and reconciled streams are not guaranteed to share stable identifiers. The reconcile endpoint can identify points via `dataPointName`, whereas raw data uses its native point ID.

That is why the uniqueness keys differ and why `dimension` was explicitly added to both key variants: one raw provider point can expand into multiple normalized rows.

Reconciled values take priority over raw values. Reads therefore need one canonical precedence rule rather than expecting every consumer to remember `source_stream` semantics.

## Provider Webhook History — Google Health API

### Repeated incorrect assumptions

The Google Health webhook API caused several confident-but-wrong first-pass assumptions:
- wrong OAuth scope format
- a nonexistent domain-verification step
- fabricated data types
- wrong field names/casing, tried three times
- wrong verification mechanism
- wrong response codes
- a missing required scope
- initially reversed VO2-max webhook support

The webhook implementation was rebuilt twice after these assumptions were corrected against direct Google documentation.

Because this API is actively evolving, provider mechanics should be re-verified against live documentation when they have not been checked for more than a few weeks.

### Kebab-case discovery

The docs use Title Case in prose, but the literal `subscriberConfigs[].dataTypes` values are kebab-case.

CamelCase such as `heartRate` silently produced opaque `INVALID_ARGUMENT` failures. Several types were temporarily believed unsupported during bisection before the casing issue was found.

The 14-day query-window documentation already contained kebab-case names such as `heart-rate`, `active-minutes`, and `total-calories`, but that clue was initially overlooked.

### Webhook subscriber model

The subscriber is project-scoped, not user-scoped. The application uses exactly one subscriber.

The project number must be the numeric Google Cloud project number, not the string project ID. The subscriber ID is self-chosen and must satisfy Google's format rules; the literal `"self"` produced a silent 404.

The authorization field is `endpointAuthorization.secret`, and the stored value is the full scheme such as `Bearer <WEBHOOK_AUTH_TOKEN>`.

`subscriberConfigs` is one entry containing a plural `dataTypes` array.

`subscriptionCreatePolicy=AUTOMATIC` means there is no per-user subscription lifecycle. Connecting an account does not call the subscriber API; it stores tokens and initiates backfill. Disconnecting disables the local account/revokes the token but does not modify the project subscriber.

Subscriber setup is therefore a standalone manual script, `npm run setup:subscriber`, rather than application-startup logic.

### OAuth scope history

The OAuth scope set grew twice during implementation: first when sleep support was added, then when `googlehealth.profile.readonly` was discovered to be required for `users.getIdentity`.

The profile scope was not part of the original three Health scopes, which demonstrated that provider scope assumptions must be verified against the actual API operation being implemented.

Legacy Google Fit `fitness.*` scopes must not be mixed into the Health API client. `include_granted_scopes` was explicitly prohibited because it could reintroduce legacy consent into future tokens.

### Identity mapping

The project originally considered decoding the OAuth ID token for identity attribution. The provider's `users.getIdentity` endpoint is the actual mechanism used.

It returns `{ name, legacyUserId, healthUserId }` and requires `googlehealth.profile.readonly`.

Scopes do not retroactively change already-issued tokens, so accounts connected before that scope was added need to reconnect.

### Webhook verification history

The endpoint verification handshake is not the familiar GET/`hub.challenge` pattern. The actual provider flow uses two POST verification requests with `{"type":"verification"}`:
- authorized request must receive 200 or 201
- unauthorized request must receive 401 or 403
- failure causes `FAILED_PRECONDITION`

### Notification handling

The notification payload is nested under `data`, including `healthUserId`, `operation`, `dataType`, and intervals.

The endpoint should return `204 No Content` immediately and process asynchronously. Non-success/timeout causes provider retries, stored up to seven days.

### Cross-account attribution bug

A silent fallback to "the first/any active account" existed once and was caught before production use.

This is the most important provider-specific correctness lesson: a webhook for one user must never be allowed to write into another user's `metric_entries`.

The exact-match invariant was elevated to a hard security requirement. Future tests must use at least two simultaneously active accounts and the real nested notification payload shape, not a simplified flat mock.

The logic must not vary by environment. Tests should inject/mock the database client rather than bypassing attribution safety based on environment variables.

Live two-account verification is required before trusting the deployment in production because passing automated tests has not historically been sufficient evidence for this provider integration.

### Webhook signature verification

Google cryptographically signs notification payloads using Tink/ECDSA P-256, with keys rotating every 30 days and a public keyset at the provider's documented location.

The current shared-secret Authorization check proves knowledge of the secret but does not provide the additional authenticity/tamper-evidence of signature verification.

Signature verification is therefore recorded as future hardening rather than silently omitted from the security model.

## Sync Strategy History

The most consequential provider finding was that sync strategy is per data type, not uniform.

26 of 27 documented types were individually confirmed accepted by the live subscriber API in kebab-case. `total-calories` was genuinely rejected across multiple spelling variants and was moved to polling-only.

`run-vo2-max` is webhook-supported while generic `vo2Max` / `dailyVo2Max` are polling-only. Other confirmed polling-only types included electrocardiogram, irregular rhythm notification, core body temperature, blood pressure, and total calories.

The supported list changed materially during the project and must be re-verified rather than treated as permanent.

## Deployment Decisions

### Render rather than Cloud Run

Render was selected for backend compute in Frankfurt.

Reasons:
- aligns with Neon Frankfurt for backend-to-database latency
- keeps storage/compute in the EU
- avoids GCP billing/IAM overhead for compute
- deploys directly from the existing GitHub repo
- supplies public HTTPS without a separate tunnel
- predictable cold-start behavior was useful during sync validation

Render's own Postgres product was deliberately not selected; Neon is the database.

### Neon rather than Render Postgres

Neon Postgres in AWS Europe Frankfurt was chosen for:
1. backend-to-database latency
2. EU data residency

The region is effectively permanent per Neon project, so this was treated as a deliberate architecture decision rather than a temporary default.

Neon remains standard Postgres and works with Drizzle regardless of hosting.

### Test/live separation

The test Neon branch is used locally, by tests, and by CI. The live branch connection string is intentionally absent until production go-live.

The production plan is a fresh start rather than a migration:
1. confirm data quality on test
2. test full backfill on test
3. live-verify two-account webhook attribution on test with a second throwaway Google account
4. point Render at the live branch
5. reconnect the real Google account and run a fresh backfill

After go-live, the test branch returns to being the development/CI sandbox.

### Custom auth rather than Neon Auth

JWT/bcrypt was kept because Neon Auth would couple identity to the database provider and introduce multi-tenant/org features unnecessary for a personal-scale application.

Revisit only if the app grows into genuine multi-user signup.

### Secrets

`CRON_SECRET` and `WEBHOOK_AUTH_TOKEN` were once shared and were separated.

They serve different trust boundaries:
- `WEBHOOK_AUTH_TOKEN` is provided to/stored by Google
- `CRON_SECRET` authenticates the project's own scheduled endpoint

They must remain distinct.

### Render free-tier scheduling

Free Render instances can spin down and pause in-process timers.

The architecture therefore combines:
- an in-process scheduler when the process is alive
- a secret-authenticated `POST /api/sync/scheduled`
- a GitHub Actions scheduled workflow that pings the endpoint

The endpoint checks `sync_runs` for actual overdue work instead of trusting the ping's exact timing.

The accepted tradeoff is cold-start delay for webhooks (~30–50 seconds), still within Google's seven-day retry window.

## Backfill

Initial backfill was deliberately separated from ongoing sync because months of history can require substantial pagination, especially for high-frequency heart-rate data.

It therefore:
- starts after OAuth asynchronously
- exposes progress in the UI
- uses the same idempotent upsert behavior
- can resume after interruption

## Open Decisions

### Full-resolution raw payload retention

Downsampling is resolved to dual-tier 1-minute and 5-minute ingestion buckets with raw response preservation in `raw_payload`.

The retention duration for the full-resolution provider response remains open.

### Phase 4 adapter generalization

Phase 4 is deferred indefinitely because no second integration is currently planned.

The project intentionally does not force a generalized adapter abstraction beyond what is already justified by the current implementation. If a second provider is selected, decide then whether to generalize the existing interface or extract the common abstraction from two concrete integrations.

## Historical Open-Question Cleanup

The former monolithic file mixed resolved and unresolved questions.

Resolved items now live in current state:
- scheduling: resolved
- downsampling interval: resolved
- Phase 3: implemented
- frontend choice: React/Vite web page served by Render
- native app: not chosen

Only genuinely unresolved decisions remain in `PROJECT_CONTEXT.md`.

### Trend response window provenance

The trend/baseline insufficient-data responses explicitly include `windowDays`, and UI notices read that value from the API response rather than the live window input. An earlier draft used the input field's live value, which could desync from the window actually used by a failed response when a user had an unsaved edit. Service-level and HTTP-level tests now cover the response field.

### Trend display precision and framing

Directional Trend uses 3-decimal rounding for `slopePerDay` and `correlationCoefficient`, with negative zero normalized to zero. This is deliberately different from baseline statistics' 2-decimal rounding because small daily rate changes need the additional precision. The exact directional UI copy was reviewed before shipping to enforce the non-evaluative framing principle.

## Phase 6 — Conclusions / Insights

### Why a binary significance gate was used instead of a magnitude scale

Labels like "strong", "moderate", or "weak" correlation introduce subjective magnitude judgments about a relationship's importance. In alignment with Architecture Principle 6 ("descriptive only, never diagnostic or prescriptive"), cross-metric correlation uses a single binary significance threshold (`CORRELATION_SIGNIFICANCE_THRESHOLD = 0.3` -> `hasClearCorrelation: boolean`) matching the gate used in trend detection. The exact numerical Pearson `r` is always presented transparently without value judgments.

### Why inner-join alignment was chosen over imputation

Health metrics vary substantially in sampling frequency and user logging habits (e.g. daily resting heart rate vs manual weight logging). Imputing or interpolating missing daily values creates synthetic statistical relationships that do not exist in the user's observed data. An inner join on UTC calendar days (`D = D_A ∩ D_B`) guarantees that every paired point represents a day on which both metrics were genuinely recorded.

### Why zero-variance maps to r = 0 rather than an error or null

If all daily-mean values for one metric across the historical window are identical (e.g. `Syy == 0`), mathematical Pearson correlation yields `0 / 0 = NaN`. Rather than surfacing an unexpected error or displaying a broken value, the system defensively sets `r = 0` and classifies the relationship as `hasClearCorrelation: false`. This matches the `-0 → 0` rounding normalization and avoids treating a stable metric as an exceptional system failure.

### Why no pairwise config table was introduced

Unlike single-metric personal baselines (which represent an individual metric's historical normal range and are configured per metric), cross-metric correlation is an exploratory analytical query between any arbitrary pair of metrics. Storing a pairwise configuration matrix (`O(M^2)`) in the database would introduce excessive schema complexity without clear utility. Instead, the endpoint accepts an optional, validated `windowDays` query parameter that defaults to the standard 90-day window.
