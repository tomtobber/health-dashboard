# Project Context — Personal Health Dashboard

## Vision

A personal (initially single/small-user) web application that aggregates
health and lifestyle data from multiple sources — starting with the Google
Health API — normalizes it into one data model, lets the user add their
own custom metrics, and surfaces it through customizable charts and
(eventually) lightweight statistical insights.

This document is the single source of truth for architecture decisions.
It should be loaded as always-active context. Update it whenever a decision
changes — do not let decisions live only in conversation history.

## Phase Breakdown

Work proceeds one phase at a time. Do not implement a future phase early,
but every phase must be built in a way that does not block or require
rework of a later phase. See "Architecture Principles" below for the
invariants that enforce this.

1. **Connect flow** — OAuth 2.0 flow letting a user link their Google
   Health account. Creates a user + connected-account record with stored,
   encrypted tokens.
2. **Sync + storage** — Retrieve the user's data (webhook-driven where
   Google supports it, polling elsewhere — see Architecture Principle 3
   for the current, verified split) and store it in a normalized,
   provider-agnostic data model.
3. **Custom metrics** — Let the user define and log their own metric types
   directly in the app (e.g. calories, alcohol units), stored in the same
   normalized model as synced data.
4. **Other integrations** — Support additional third-party data sources
   beyond Google Health (e.g. a calorie-tracking app), each plugging into
   the same sync + storage model via a common adapter interface.
5. **Customizable charts** — User-configurable dashboard: pick metric(s),
   time range, aggregation, and chart type; save as named views.
6. **Conclusions / insights** — Start with descriptive statistics only
   (personal baselines, trend detection, correlation between user-chosen
   metric pairs). Explicitly out of scope until this phase, and even then,
   causal or prescriptive claims require citing established
   physiology/sports-science methods rather than inventing new ones —
   always frame results as correlation in the user's own data, never as
   diagnosis or medical advice.

## Data Model

### `connected_accounts`

Generic across providers from day one, even though only Google Health
exists in phase 1.

| column | notes |
|---|---|
| user_id | FK to `users.id`, `ON DELETE CASCADE` |
| provider | e.g. `google_health`, future: other integrations |
| health_user_id | provider's own user identifier (e.g. the Google `sub` claim from the OAuth id_token) — required for exact-match webhook attribution; see "Webhook subscriber model" below |
| access_token / refresh_token | encrypted at rest |
| scopes | |
| status | active / disabled / needs_reauth |

### `metric_entries`

One normalized table for all data, regardless of source — synced,
manual, or from future integrations.

| column | notes |
|---|---|
| id | surrogate PK (uuid) |
| user_id | FK to `users.id`, `ON DELETE CASCADE` |
| provider | `google_health`, `manual`, future integration names |
| metric_type | normalized key, e.g. `heart_rate`, `steps`, `vo2_max_daily` |
| external_id | provider's native point ID, when one exists (raw stream only — see uniqueness note below) |
| start_time / end_time | always set; equal for point-in-time samples |
| value_numeric | numeric, duration (seconds), or boolean (0/1) |
| value_text | category label (for `metric_definitions.value_type = category`) |
| unit | |
| source_stream | `raw` \| `reconciled` (Google Health exposes both) |
| aggregation | `raw`, `1m_avg`, `5m_avg`, `daily_avg`, ... |
| raw_payload | jsonb, original provider response |
| updated_at | |
| deleted_at | nullable; soft delete, see below |

**Uniqueness / dedup**, enforced via upsert (`ON CONFLICT`), not
insert-then-check. Raw and reconciled streams are keyed differently —
they are not guaranteed to share a stable ID (the reconcile endpoint
merges multiple sources and identifies points via `dataPointName`, not
the raw `name`/point-ID field our `external_id` is based on):
- Raw stream, with a native point ID: unique on
  `(user_id, provider, metric_type, external_id)`.
- Reconciled stream, or any interval/rollup type without a stable
  point ID (e.g. steps): unique on
  `(user_id, provider, metric_type, source_stream, start_time, end_time)`.
- `reconciled` stream values take priority over `raw` stream values on
  conflict.

**Deletion handling**: the API has no reliable per-data-point delete
notification (only an account-level "user deletion" webhook event is
planned). Deletions are therefore detected during the reconciliation
sweep: diff what the API currently returns for a window against what's
stored, and set `deleted_at` on anything no longer present. Soft delete,
not hard delete — preserves history and is reversible if a point
reappears after a sync delay.

**Account deletion**: `ON DELETE CASCADE` on both FKs above — deleting a
`users` row removes all their `connected_accounts` and `metric_entries`
immediately. For this app, deleting a user always means "remove
everything," so `RESTRICT` would just add friction and `SET NULL` would
leave meaningless orphaned rows. If a reversible/soft "delete my account"
UX is ever wanted, that's an application-layer flag
(`users.scheduled_deletion_at` + a background job) acted on later — not
a reason to avoid CASCADE at the database level.

### `metric_definitions` (phase 3+)

User-defined custom metric types (name, unit, value type: numeric /
duration / boolean / category), referenced by `metric_entries.metric_type`
for that user. `value_type` determines whether a given entry's data lives
in `metric_entries.value_numeric` or `.value_text` (see above).

## Data Volume & Resolution Strategy

Some data types (heart rate confirmed; potentially others at similar
intraday resolution) are returned by the API at very high native
frequency — observed as low as ~5-second intervals, i.e. 8,000+ points
per user per day for heart rate alone. Storing every type at native
resolution indefinitely is not the default assumption for this project;
most data types (daily VO2 max, sleep sessions, weight, etc.) are
naturally low-frequency and are unaffected by this section.

- Downsample high-frequency types at ingestion, before writing to
  `metric_entries` — e.g. aggregate to 1-minute or 5-minute
  min/max/avg rather than storing every raw sample. This keeps the
  normalized store performant for charts and correlation analysis
  without needing aggregation logic in every read path.
- Add an `aggregation` column to `metric_entries` (`raw`, `1m_avg`,
  `5m_avg`, `daily_avg`, ...) so any consumer of the data knows what
  resolution it's looking at.
- The full-resolution response may still be kept in `raw_payload` for a
  short rolling window (days, not months/years) if fine-grained
  drill-down is ever needed — not retained indefinitely at full
  resolution.
- This is decided per data type based on what the API actually returns
  natively — apply it where it's needed, not as a blanket rule.

## Observability & Data Quality

Sync completeness and cross-stream duplication are not assumed —
both are checked deliberately rather than trusted implicitly.

- **Sync auditability** — every sync operation (webhook-triggered,
  reconciliation, or backfill) writes a row to a `sync_runs` table
  (user_id, provider, metric_type, trigger, requested_range, status,
  points_fetched, points_upserted, pages_fetched, error, started/completed
  timestamps). This is queryable state, not just application logs — it's
  what answers "when did we last successfully sync X for this user."
- **Subscription health** — Google auto-disables webhook subscriptions
  for inactive subscribers. A scheduled job periodically confirms the
  single project-level subscriber (see "Webhook subscriber model" below)
  is still active and re-registers it if not; webhook coverage should
  never silently degrade.

## Webhook Subscriber Model (Google Health API)

Corrected after initial implementation wrongly assumed a per-user
subscription lifecycle — verified against direct citations from
`developers.google.com/health/webhooks`.

- **Subscribers are scoped to the Google Cloud project**, not to
  individual users. There is exactly one subscriber for this
  app, registered once via `POST .../projects/{project}/subscribers`
  with an explicit, self-chosen `subscriberId` (4-36 chars, must match
  `[a-z]([a-z0-9-]{2,34}[a-z0-9])`) — not the literal string `"self"`,
  which is not a documented value and silently 404s.
- **`subscriptionCreatePolicy: AUTOMATIC` is used** — per Google's docs,
  this means no per-user `Subscription` resource is created or managed.
  Eligibility for notifications is computed dynamically from each
  user's granted OAuth consent. Connecting a Google account does
  not trigger any subscriber API call — it only stores tokens and
  triggers backfill. Disconnecting does not delete or modify the
  subscriber either — it only disables the local `connected_accounts`
  row / revokes the OAuth token.
- **The project-level subscriber is managed by a standalone script**
  (`npm run setup:subscriber`), run manually — once initially, and
  again only when `WEBHOOK_SUPPORTED_METRICS` changes. It must never
  run automatically on app startup or on every Render deploy.
- **`GOOGLE_PROJECT_ID` and `GOOGLE_SUBSCRIBER_ID` must not have
  silent placeholder defaults** — missing values should fail startup
  loudly, same as `GOOGLE_CLIENT_ID`.
- **Webhook attribution** — this is the one piece treated as a hard
  security/correctness invariant, not just an implementation detail:
  Google's notification payload includes `healthUserId` (their identifier
  for the user, not this app's local UUID) — matched against
  `connected_accounts.health_user_id`, populated from the OAuth
  `id_token`'s `sub` claim at connect time. Attribution must be an
  exact match only:
  - If neither `healthUserId` nor a local user identifier is present in
    the payload, reject immediately (before any database query is
    built) — never let an empty match condition silently fall through to
    a broader query.
  - If no active connected account matches, discard the notification
    (log + reject) — never fall back to "the first/any active
    account." A silent fallback here means one user's real health data
    can get written to another user's records. This exact bug shipped
    once already this project and was caught before production use —
    treat any future change to this function as needing the same
    scrutiny (an explicit test with 2+ simultaneously active accounts,
    confirming cross-attribution is impossible).
  - This logic must run identically in every environment — no
    branching on `DATABASE_URL` contents, hostname, or `NODE_ENV` to
    skip or alter the safety check. If tests need a mock, inject at the
    database-client level, not by conditionally bypassing the check
    itself.

- **Gap detection** — flag suspicious patterns from `sync_runs` /
  `metric_entries` (e.g. a zero-data day sandwiched between two
  normal-density days) as likely sync failures rather than treating all
  gaps as equally explainable (device off, etc.).
- **Cross-stream duplication is prevented structurally**, not by
  convention. Storage-level duplicates are already impossible (see
  uniqueness constraints above). Query-level double-counting — e.g.
  summing both raw and reconciled values for an overlapping window — is
  avoided by never querying `metric_entries` directly for
  charts/analysis/export. Instead, all reads go through one canonical
  query path that, per user/metric_type/time-window, prefers reconciled
  data and falls back to raw only where reconciled is absent. This
  removes the risk rather than relying on every future query remembering
  to filter by `source_stream`.
- **Raw-vs-reconciled divergence check** — a periodic job compares raw and
  reconciled values for the same window and logs (not blocks) cases where
  they differ meaningfully. Useful signal on how much reconciliation is
  actually correcting, and would surface if the `external_id`/key
  assumptions above are behaving unexpectedly.

## Architecture Principles (do not violate, regardless of phase)

1. All data, from any source, is written through an adapter into the
   single normalized `metric_entries` schema. No phase-specific or
   provider-specific tables.
2. Every data source (Google Health, future integrations, manual entry)
   implements the same adapter interface: `authenticate`, `sync`,
   `mapToNormalizedSchema`. Adding a new source should not require
   touching the storage or chart layers.
3. Sync strategy is per data type, not uniform. As of the May 26,
   2026 release, Google Health API webhooks cover a much wider set than
   originally documented here — confirmed via direct citation from
   `developers.google.com/health/webhooks`: Active Zone Minutes, Activity
   Level, Altitude, Blood Glucose, Body Fat, Calories In Heart Rate Zone,
   Daily Heart Rate Variability, Daily Heart Rate Zones, Daily Oxygen
   Saturation, Daily Respiratory Rate, Daily Resting Heart Rate, Daily
   Sleep Temperature Derivations, Distance, Exercise, Floors, Heart Rate,
   Heart Rate Variability, Height, Hydration Log, Nutrition Log,
   Respiratory Rate Sleep Summary, Run VO2 Max, Sedentary Period, Sleep,
   Steps, Time In Heart Rate Zone, Total Calories, Weight. For those,
   webhooks trigger immediate syncs, with a scheduled reconciliation job
   as backup for missed/delayed deliveries and disabled subscriptions.
   Confirmed still polling-only (no webhook support found): generic
   `vo2Max`/`dailyVo2Max` (note: `runVo2Max` specifically is
   webhook-supported — these are different types), `electrocardiogram`,
   `irregularRhythmNotification`, `coreBodyTemperature`, `bloodPressure`.
   This list has already changed materially once mid-project — re-verify
   against the live docs (with direct quotes, not summary) before trusting
   it again; this exact API surface has produced multiple incorrect
   first-pass claims this project (wrong OAuth scope format, a
   non-existent "domain verification" step, a fabricated data type, and
   an initially-reversed claim about VO2 max webhook support).
4. All writes are idempotent upserts keyed as described above — running
   sync or reconciliation repeatedly, on overlapping ranges, must never
   create duplicates.
5. Manual entries and custom metrics are first-class citizens of the same
   schema, not a bolted-on separate system — they should appear in charts
   identically to synced data.
6. Any statistics or "conclusions" work must clearly distinguish
   descriptive/correlational output from causal or prescriptive claims.
   No diagnostic language.
7. Charts, analysis, and exports never query `metric_entries` directly
   for aggregation — they go through the canonical reconciled-preferred
   read path (see Observability & Data Quality). No feature reimplements
   raw-vs-reconciled precedence logic on its own.

## Initial Backfill

When a user first connects, pulling their available history is a
separate task from ongoing sync, not a variant of it:
- Triggered right after OAuth completes, but runs as an async/queued
  background job — never synchronously in the OAuth callback. A
  months-long history at 5-second heart rate resolution can take
  significant time to paginate through.
- The UI shows a syncing/in-progress state and displays data as it
  arrives, rather than blocking until backfill is fully complete.
- Should be resumable/idempotent (same upsert logic as regular sync)
  so a failed or interrupted backfill can safely restart or continue.

## Known Constraints From the Provider

- Google Health API scopes used here are Restricted — production use with
  real (non-test) users requires a Google privacy/security review. For
  personal/small-scale use, register accounts as OAuth test users instead.
- Use the literal scope URLs below — do not substitute the older Google
  Fit API scopes (`fitness.*`), which are a different API and can cause
  token rejection if mixed with Google Health scopes on the same client:
  - `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`
  - `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`
  - `https://www.googleapis.com/auth/googlehealth.sleep.readonly`
- Most data types support ~90 days per query; heart rate, active minutes,
  total calories, and calories-in-heart-rate-zone are capped at 14 days per
  request — batch requests accordingly.
- Failed webhook deliveries retry for up to 7 days before being dropped;
  the reconciliation job is the safety net beyond that window (see
  Architecture Principles for which data types this actually applies to).
- Webhook subscriber endpoints must be public HTTPS (TLS 1.2+) —
  Google performs a verification challenge against the endpoint at
  subscription time. See "Deployment & Staging Environment" for the
  resolved hosting decision. This requirement applies to the backend
  regardless of frontend choice (web page vs. native app) — that's a
  separate, independent decision deferred to Phase 5.

## Deployment & Staging Environment

Resolved ahead of Phase 2, since webhook work hard-requires a public
HTTPS endpoint and reconciliation/backfill logic needs to be tested
against data that persists between sessions (Phase 1 used ephemeral,
discard-on-exit Docker Postgres instances — not sufficient going
forward).

- **Backend hosting**: Render, region Frankfurt — matches the Neon
  region above to keep backend-to-database latency low and data within
  the EU. Deliberately not Google Cloud Run,
  despite already having a GCP project for OAuth — that project is an
  OAuth identity container, not compute infrastructure, so reusing it
  saves little. Render avoids GCP billing-account/IAM overhead, deploys
  directly from the GitHub repo (same repo the CI pipeline already runs
  against), and gives a public HTTPS endpoint with no separate tunnel
  needed once deployed. Cold-start behavior is also more predictable
  than Cloud Run's scale-to-zero default, which matters while validating
  sync-timing logic. Render is used for compute only — not its own
  Postgres product, which is a separate offering from the database
  decision below and has a hard 30-day free-tier expiration with
  permanent data deletion. `DATABASE_URL` points at Neon regardless of
  where the app is hosted.
- **Database**: Neon (Postgres), region AWS Europe (Frankfurt,
  `aws-eu-central-1`). Chosen for two reasons: (1) latency — the
  pairing that matters is backend-server-to-database, not
  user-to-database, so this should match wherever Render is deployed;
  (2) data residency — this project stores real personal health data
  (GDPR special category), and the developer is EU-based, so keeping
  storage in the EU is a deliberate default, not just a performance
  choice. Region is permanent per Neon project — cannot be changed
  without creating a new project and migrating data, so this isn't a
  "fix it later" setting. Free tier, zero GCP setup, standard
  Postgres — works identically with Drizzle regardless of host, and
  easy to swap for Supabase later if ever needed (see earlier hosting
  comparison; the two are functionally interchangeable here). Free-tier
  compute suspends after 5 minutes idle to save compute allowance, but
  storage is persistent and unaffected — data is never at risk from
  inactivity, unlike Render's free Postgres (which is not used here;
  see note below). First query after idle wakes compute in milliseconds
  — expect this as a small, expected latency blip in `sync_runs` timing
  after quiet periods, not a bug.
- **Test vs. live branch separation**: two Neon branches exist —
  `DATABASE_URL` (in local `.env`) points at the test branch, used
  by the app locally, the test suite, and CI. The primary/live branch
  connection string is not stored in `.env` or anywhere in the project
  at all right now — deliberately, so there's nothing for code or tests
  to accidentally reference. It gets added only when actually going
  live with the real Google account connection, as a conscious step, not
  something left in place "just in case." Never point tests, CI, or a
  Render deployment meant for real use at the same connection string
  simultaneously used for destructive testing (cascade-delete/rollback
  tests specifically).
- **OAuth project stays Google Cloud** — unrelated to the above. The
  `GOOGLE_REDIRECT_URI` just needs to be a real HTTPS URL matching what's
  registered as an Authorized redirect URI in Google Cloud Console;
  where the backend actually runs is irrelevant to Google's OAuth flow.
- **Auth**: custom JWT/bcrypt (already built in Phase 1), not Neon Auth.
  Considered and deliberately declined — Neon Auth would couple identity
  to the Neon platform specifically, working against the low-lock-in
  reasoning behind choosing Neon in the first place, and its
  multi-tenant/org features solve a bigger problem than a personal-scale
  app has. Revisit only if this ever grows into genuine multi-user
  signup beyond a handful of manually-added accounts.
- **Secrets**: `ENCRYPTION_KEY`, `JWT_SECRET`, `GOOGLE_CLIENT_SECRET`,
  `DATABASE_URL`, `CRON_SECRET`, and `WEBHOOK_AUTH_TOKEN` must be set via
  Render's environment/secrets config, not committed or left as
  `.env.example` values — this stopped being hypothetical once a real
  account's tokens were encrypted and stored during Phase 1 manual
  testing. `CRON_SECRET` and `WEBHOOK_AUTH_TOKEN` must be distinct
  values — the latter is handed to and stored by Google (as the
  webhook `authorization_token`), the former only authenticates our own
  GitHub Actions cron; sharing one secret across both trust boundaries
  was caught and fixed once already this project.
- **Test-user expiry**: while the app remains in Google's "Testing"
  publishing status, authorizations from test users (including the
  developer's own account) expire after 7 days regardless of hosting —
  expect to periodically re-run the connect flow until the app goes
  through Google's verification process.
- **Scheduling on Render free tier**: the free Web Service spins down
  after 15 minutes idle, pausing in-process timers. Rather than pay for
  an always-on instance now, the scheduler is built
  architecture-agnostic: an in-process scheduler runs when the process
  is alive, plus a secret-authenticated `POST /api/sync/scheduled`
  endpoint that a GitHub Actions scheduled workflow (`on: schedule`)
  pings periodically to wake the instance and run due jobs — no new
  external service/account needed, since GitHub Actions is already used
  for CI. The endpoint checks `sync_runs` for what's actually overdue
  per job type rather than trusting the ping's exact timing, so a missed
  or delayed cron tick doesn't skip work. Upgrading to Render's Starter
  plan ($7/mo, always-on) later requires no code changes. Accepted
  tradeoff: webhook deliveries also get a cold-start delay (~30-50s) on
  free tier, not just polling — fine given Google's 7-day webhook retry
  window, just worth knowing this isn't truly instant yet.

## Open Questions

Remaining items — none block Phase 2 from starting, each is scoped to
the phase it affects:
1. **Resolved: job scheduling** — GitHub Actions `schedule` cron pings a
   secret-authenticated `/api/sync/scheduled` endpoint, which checks
   `sync_runs` for what's actually due rather than trusting exact timing
   (see Deployment & Staging Environment).
2. **Resolved: downsampling interval** — dual-tier, not a single choice.
   High-frequency types are aggregated to both 1-minute (`1m_avg`)
   and 5-minute (`5m_avg`) buckets at ingestion (min/max/avg/sample
   count), with the raw response preserved in `raw_payload`.
3. **Still open: raw_payload pruning** — how long full-resolution `raw_payload`
   data is retained before pruning — not yet decided — Phase 2.
4. **Adapter interface generalization** — Whether phase 4's adapter interface
   should be generalized now or hardcoded for 1–2 known integrations first — Phase 4.
5. **Frontend choice** — web page vs. native app — Phase 5.
