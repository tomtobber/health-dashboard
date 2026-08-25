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
3. **Custom metrics** *(complete)* — Let the user define and log their
   own metric types directly in the app (e.g. calories, alcohol units),
   stored in the same normalized model as synced data. See
   `metric_definitions`, "Phase 3 API Surface," and "Enriched Metric Read
   Layer" below for the implemented design.
4. **Other integrations** *(deferred — see below)* — Support additional
   third-party data sources beyond Google Health (e.g. a calorie-tracking
   app), each plugging into the same sync + storage model via a common
   adapter interface.
5. **Customizable charts** *(complete)* — User-configurable dashboard:
   pick metric(s), time range, aggregation, and chart type; save as named
   views. See `dashboard_views`, "Phase 5 Frontend & API Surface," and
   "Multi-Metric Overlay Rendering" below for the implemented design.
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
| health_user_id | provider's own user identifier (e.g. the Google
  `sub` claim from the OAuth id_token) — required for exact-match
  webhook attribution; see "Webhook subscriber model" below |
| access_token / refresh_token | encrypted at rest |
| scopes | |
| status | active / disabled / needs_reauth |

### `metric_entries`
One normalized table for **all** data, regardless of source — synced,
manual, or from future integrations.

| column | notes |
|---|---|
| id | surrogate PK (uuid) |
| user_id | FK to `users.id`, `ON DELETE CASCADE` |
| provider | `google_health`, `manual`, future integration names |
| metric_type | normalized key, e.g. `heart_rate`, `steps`, `vo2_max_daily` |
| external_id | provider's native point ID, when one exists (raw stream only — see uniqueness note below) |
| start_time / end_time | always set; equal for point-in-time samples |
| dimension | nullable text; sub-category axis for compound metrics
  (e.g. heart rate zone name, sleep stage type) — see "Compound and
  range metrics" below |
| value_numeric | numeric, duration (seconds), or boolean (0/1) |
| value_text | category label (for `metric_definitions.value_type = category`) |
| value_min / value_max | nullable numeric; for range-based facts (e.g.
  a heart rate zone's bpm boundaries) — see below |
| unit | |
| source_stream | `raw` | `reconciled` (Google Health exposes both) |
| raw_payload | jsonb, original provider response |
| updated_at | |
| deleted_at | nullable; soft delete, see below |

**Compound and range metrics** — found when real synced data revealed
that some provider payloads pack more into one data point than a single
number or label can hold (e.g. `active-zone-minutes` includes a
`heartRateZone` alongside its numeric value; the raw JSON for a sleep
session contains 10+ individual stage transitions, not one summary
number). `raw_payload` always preserves the full original response
regardless, but the point of the columns above is to make this
structure directly queryable without parsing JSON at read time:
- `mapToNormalizedSchema` already returns an **array** by design (see
  `baseAdapter.ts`) specifically so one raw API data point can expand
  into multiple normalized rows — use this rather than collapsing
  compound data into one row.
- **Dimensioned values** (e.g. active zone minutes per heart-rate zone):
  emit one row per dimension value —
  `metric_type='active-zone-minutes', dimension='FAT_BURN', value_numeric=<n>`,
  one row each for `CARDIO`/`PEAK`, etc.
- **Sleep stages**: keep one summary row (`metric_type='sleep'`,
  `value_numeric`=total minutes asleep, spanning the full session) *and*
  emit one row per stage transition (`metric_type='sleep_stage'`,
  `dimension`=stage type, `start_time`/`end_time`=that stage's actual
  interval) — this is what makes "time in each sleep stage over time"
  queryable at all; right now it's invisible inside `raw_payload`.
- **Co-reported component values** (e.g. blood pressure's
  systolic/diastolic): these are **not** a range — they're two
  independently meaningful measurements reported together, not a single
  quantity bounded between two numbers. Use `dimension`, the same as
  heart-rate zones, not `value_min`/`value_max`:
  `metric_type='blood-pressure', dimension='systolic', value_numeric=120`
  and a second row with `dimension='diastolic'`. The distinction that
  matters: `value_min`/`value_max` is for one quantity's boundary (a
  zone's bpm threshold); `dimension` + `value_numeric` is for multiple
  named components that each stand alone as their own time series.
- **Ranges** (e.g. `daily-heart-rate-zones`, where each zone has bpm
  boundaries that are recalculated over time as fitness changes): use
  `value_min`/`value_max` for the boundary, combined with `dimension`
  for which zone and `value_numeric` for an associated point value if
  there is one (e.g. minutes spent in that zone that day) — one row per
  zone per day captures the full fact and keeps zone-boundary drift
  over time directly chartable, not just archaeology in `raw_payload`.
- **Audit before assuming a type doesn't need this**: this pattern was
  found by inspecting real synced payloads, not by reading docs — worth
  auditing a few days of real data across metric types (anything with
  an array, breakdown, or range inside its raw JSON is a candidate)
  rather than assuming only the two examples above are affected.

**Uniqueness / dedup**, enforced via upsert (`ON CONFLICT`), not
insert-then-check. Raw and reconciled streams are keyed differently —
they are not guaranteed to share a stable ID (the reconcile endpoint
merges multiple sources and identifies points via `dataPointName`, not
the raw `name`/point-ID field our `external_id` is based on). **Note:
`dimension` must be included in both key variants below** — a single
raw data point (one `external_id`) can now expand into multiple rows
that share that same ID but differ by dimension (e.g. all sleep stages
from one session share the session's `dataPointName`):
- **Raw stream, with a native point ID**: unique on
  `(user_id, provider, metric_type, dimension, external_id)`.
- **Reconciled stream, or any interval/rollup type without a stable
  point ID** (e.g. steps): unique on
  `(user_id, provider, metric_type, dimension, source_stream, start_time, end_time)`.
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

### `metric_definitions` (phase 3 — implemented)
User-defined custom metric types, referenced by `metric_entries.metric_type`
for that user. `value_type` determines whether a given entry's data lives
in `metric_entries.value_numeric` or `.value_text` (see above).

**`metric_entries` columns relaxed for this table to exist**: `unit` and
`source_stream` are nullable on `metric_entries` (both are meaningless for
`boolean`/`category` value types and for `provider = 'manual'` rows
respectively) — this was the one schema change phase 3 made to the
existing table, everything else is additive.

| column | notes |
|---|---|
| id | surrogate PK (uuid) |
| user_id | FK to `users.id`, `ON DELETE CASCADE` |
| metric_type | user-chosen key, unique per `(user_id, metric_type)`; must not collide with reserved provider metric-type strings |
| display_name | human-readable label shown in UI; the only field editable after entries exist (see below) |
| value_type | enum: `numeric` | `duration` | `boolean` | `category` |
| unit | required for `numeric`/`duration`; null for `boolean`/`category` |
| category_values | jsonb array of allowed labels; only used when `value_type = 'category'` |
| archived_at | nullable; soft "retire," see below |
| created_at / updated_at | |

**`metric_type` format**: strictly enforced kebab-case
(`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, 2–50 chars), validated with a Zod regex
and a descriptive `ValidationError` on mismatch — typed directly by the
user, not derived/slugified from `display_name`. This was a deliberate
choice (explicit control over the stored key vs. friendlier UX) rather
than an oversight.

**Reserved metric-type collisions**: checked against a set derived at
import time directly from the adapters' own metric constants
(`WEBHOOK_SUPPORTED_METRICS`, `POLLING_ONLY_METRICS`, `METRICS_14_DAY`)
plus known provider identifiers — not a separately hand-maintained list
that could drift out of sync with the adapters.

**Category values**: must be a non-empty array of deduplicated,
non-empty trimmed strings — validated at creation and at update — in
addition to the fixed-list rule above.

**Ownership scoping**: every definition lookup used for writes (logging,
updating, deleting an entry) is scoped by `user_id`, not just by `id` —
looking up someone else's definition/entry by ID returns `NotFoundError`
(404) rather than leaking existence or allowing cross-user writes.

**Unique-constraint handling**: the creation path narrows on the actual
Postgres error code (`23505`) before mapping to `ValidationError`
("metric type already exists for this user") — any other DB error is
logged and rethrown as a `DatabaseError`, not silently reattributed.

`value_type` and `unit` are locked as
soon as any `metric_entries` row references this definition — checked at
the service layer (`EXISTS` query) before applying an update, not left to
convention. Attempting to change either after that point is rejected as a
`ValidationError`, not silently ignored. `display_name` has no bearing on
how existing data is interpreted, so it remains editable at any time.

**Category values are a fixed list**, edited only through an explicit
"manage categories" action — not grown implicitly by typing a new value
while logging an entry. Logging validates the submitted value against the
current `category_values` list (Zod `z.enum` built dynamically from it);
an unrecognized value is rejected, not coerced. Removing a category value
that existing entries already use should be blocked, for the same reason
`value_type`/`unit` are locked — don't silently orphan existing data's
meaning.

**Retiring vs. deleting**: a definition with zero associated entries can be
hard-deleted (nothing references it yet). Once entries exist, deletion is
soft (`archived_at`), mirroring the `deleted_at` pattern already used on
`metric_entries` — archived definitions drop out of "log a new entry"
pickers but stay fully intact for historical charts/exports, per
Architecture Principle 5.

**Manual entry as an adapter**: manual/custom-metric entry doesn't map
cleanly onto the full `authenticate` / `sync` / `mapToNormalizedSchema`
adapter interface (Principle 2) — there's no external system to
authenticate against or poll. Treated as a degenerate adapter instead:
`authenticate()` is a no-op (the app's own logged-in user), and
`mapToNormalizedSchema()` is invoked directly from the API route handler
on submission rather than from a `sync()` pull loop. This keeps the single
normalized write path (Principle 1) intact without inventing a fake sync
cycle where none exists. Resulting rows use `provider = 'manual'`,
`external_id = null` (nothing to dedupe against upstream — each submission
is its own row, not an upsert target), and `source_stream = null` (the
raw/reconciled distinction doesn't apply to manual data). Unlike synced
provider data, manual entries support direct user-initiated edit/delete on
individual rows, since the user authored them.

**Combined create-definition-and-log-first-entry flow**: since this is a
likely UX pattern (create a metric and log today's value in one form), it
is a two-step DB mutation and must be wrapped in a transaction — a failure
between the two steps must not leave a definition with no record of
whether the first entry landed.

## Phase 3 API Surface (custom metrics — implemented)

- `POST /api/metric-definitions` — create; Zod-validated body
  (`metric_type`, `display_name`, `value_type`, `unit?`, `category_values?`).
- `GET /api/metric-definitions` — list user's definitions
  (`?includeArchived=true` to include retired ones).
- `GET /api/metric-definitions/:id` — get a single definition.
- `PATCH /api/metric-definitions/:id` — update; server enforces the
  value_type/unit lock above regardless of what the client sends.
- `POST /api/metric-definitions/:id/archive` — soft-retire. **No
  unarchive route exists** — deliberate; create a new definition instead
  of reviving an archived one.
- `DELETE /api/metric-definitions/:id` — permitted only if zero associated
  entries exist; otherwise returns a typed error directing the client to
  archive instead.
- `POST /api/metric-entries/manual` — log an entry against a definition;
  validates the value against the definition's `value_type`/`unit`/
  `category_values` before writing through the shared normalized-row path.
- `POST /api/metric-entries/manual/combined` — create a definition and
  log its first entry in one transactional call (the "define a metric and
  log today's value in one form" flow) — the new definition's `id` is
  passed directly into the entry-logging step rather than re-fetched by
  `metric_type`, avoiding a redundant lookup inside the transaction.
- `PATCH` / `DELETE /api/metric-entries/manual/:id` — correct or remove an
  individual manual entry (expected, since these are user-authored, unlike
  synced provider data). Editing is allowed even if the entry's definition
  is archived (correcting history should still work); logging a *new*
  entry against an archived definition is blocked.
- `GET /api/metric-entries?metric_type=...&start_time=...&end_time=...` —
  enriched read endpoint (see below); also accepts
  `metric_types=a,b,c` for a batched multi-metric fetch. Despite the
  route living in `manualEntryRoutes.ts` for now, it serves both synced
  and custom metrics — a naming/location cleanup worth doing next time
  that file is touched, not urgent.

## Enriched Metric Read Layer (phase 3 — implemented)

Closes the read-side half of Architecture Principle 5: `metric_entries`
already returns manual rows alongside synced ones with no special-casing
(`filterReconciledOverRaw` treats `source_stream = null` manual rows as
valid raw entries), but charting/UI needs metadata — `display_name`,
`value_type`, `unit`, `category_values` — that lives on
`metric_definitions` for custom metrics and nowhere explicit for provider
metrics.

- **`queryEnrichedMetricEntries(filter)`** (`metricsQueryService.ts`) —
  resolves this metadata alongside the normalized entries for one metric:
  `{ metricType, displayName, valueType, unit, categoryValues, entries }`.
  - For a custom metric: reads `metric_definitions`.
  - For a provider metric: reads `CANONICAL_PROVIDER_METRICS`
    (`baseAdapter.ts`) — a single canonical dictionary of `displayName` /
    `valueType` / `unit` / `categoryValues` per known provider metric key,
    with a title-case fallback for any unlisted key so an unrecognized
    provider metric never fails outright, just renders less prettily.
  - **Deliberately does not filter on `archived_at IS NULL`** — an
    archived definition's historical entries must remain 100% chartable
    with full metadata; `archived_at` only controls whether a metric
    appears in "log a new entry" pickers, never whether it's queryable.
- **`queryBatchEnrichedMetrics(filters[])`** — the same resolution for
  multiple metrics at once via two `IN (...)` queries (one for
  definitions, one for entries) instead of N+1 per-metric round trips;
  what the dashboard's multi-metric view actually calls.
- Exposed over HTTP via `GET /api/metric-entries` (single or
  `metric_types=` batched) above.

### `dashboard_views` (phase 5 — implemented)
User-saved chart layouts, referencing metrics by `metric_type` string
(both synced and custom — no FK, since a panel can reference a
subsequently-deleted custom metric; see fallback behavior below).

| column | notes |
|---|---|
| id | surrogate PK (uuid) |
| user_id | FK to `users.id`, `ON DELETE CASCADE` |
| name | display name; unique per `(user_id, name)` |
| config | jsonb, see panel shape below |
| created_at / updated_at | |

**`config` shape**, validated with Zod at the API boundary
(`TimeRangeSchema` as a discriminated union, not a single enum with an
ambiguous `'custom'` value mixed into the relative branch):
```ts
{
  panels: [
    {
      id: string,
      metricTypes: string[],        // 1+, non-empty — overlay when >1
      timeRange: { type: 'relative', value: 'last_24h' | 'last_7d' | 'last_30d' | 'last_90d' | 'last_1y' }
               | { type: 'absolute', startTime: string, endTime: string },
      aggregation: 'raw' | '1m_avg' | '5m_avg' | 'daily_avg' | 'weekly_avg',
      chartType?: 'line' | 'bar'    // optional override; default inferred per-metric from valueType
    }
  ]
}
```

**Relative time ranges are computed at render time, not frozen at save
time** — a view saved as "last 7 days" always means up to now when
reopened, not the 7 days that happened to be current when it was saved.

**Ownership scoping**: every lookup (`get`/`update`/`delete`) is scoped by
`user_id` in the query itself, not just by `id` — same pattern as
`metric_definitions`, same reasoning: don't let one user enumerate or
touch another's saved views. Not-found/unauthorized branches log
structured context (`userId`, `viewId`, `operation`).

**Unique-name collisions**: PG `23505` on `(user_id, name)` is narrowed
and mapped to `ValidationError` on **both** create and rename-via-update
— a rename that collides with an existing view name is rejected the same
way a duplicate create is, not just the initial create path.

**Deleted/missing metric reference in a panel**: since `metricTypes` is a
plain string array with no FK, a panel can reference a custom metric
that's since been hard-deleted (only possible for the zero-entries
delete case). The enriched query returns an empty entries array with
title-case fallback metadata for an unrecognized key rather than erroring
the whole panel — the frontend shows a subtle "no entries found for
`<metric>`" notice on that series without breaking the rest of an
overlaid panel. An *archived* (not deleted) metric renders normally, same
as any other historical query — `archived_at` never affects queryability.

## Phase 5 Frontend & API Surface (customizable charts — implemented)

**Frontend stack**: React 18 + Vite SPA in `client/`, Recharts for
charting, served from the same Render service as the backend —
`express.static(client/dist)` plus a pathless SPA fallback handler
registered after all `/api/*` and `/health` routes (written
Express-4/5-safe: no bare `app.get('*')`, which throws at startup under
Express 5's `path-to-regexp` v6 — a fallback with no path, or a named
wildcard, is used instead). Same-origin serving avoids any CORS
configuration and keeps auth cookies working without cross-site
complications.

**Build pipeline**: root `"build"` runs `build:backend` (`tsc`) then
`build:client` (`npm --prefix client run build`); `render.yaml`'s
buildCommand installs both root and `client/` dependencies before
running it. This was a real gap in the first draft of this phase's plan
— worth remembering for any future additional frontend package, since
Render's build step doesn't recurse into subdirectories on its own.

**API surface**:
- `POST /api/dashboard-views` — create; Zod-validated `config`.
- `GET /api/dashboard-views` — list user's saved views.
- `GET /api/dashboard-views/:id` — get one.
- `PATCH /api/dashboard-views/:id` — update (rename and/or reconfigure
  panels); same unique-name and ownership rules as create.
- `DELETE /api/dashboard-views/:id` — delete.
- **No new data-fetching endpoint** — rendering a view resolves each
  panel's relative time range to absolute timestamps and calls the
  existing Phase 3 batched enriched endpoint
  (`GET /api/metric-entries?metric_types=a,b,c&start_time=...&end_time=...`)
  per panel.

## Multi-Metric Overlay Rendering (phase 5 — implemented)

A single chart panel can overlay multiple metrics together (e.g. steps +
heart rate), not just one metric per chart — this was a deliberate scope
decision, not a default. Rendering rules, since mixed-`valueType`
overlays are a legitimate case the API doesn't reject:
- **Each metric gets its own Y-axis** (Recharts `yAxisId`), never a
  shared axis — different metrics have incomparable scales/units.
- **Numeric/duration metrics** render as lines/bars against their axis,
  sharing one time-based X-axis across all series in the panel.
- **Boolean metrics** render as event marker bands/pins along the
  timeline, not a 0/1 line against a numeric axis.
- **Category metrics** render as discrete colored event markers with
  text labels, not a Y-value.
- Hover tooltips are synchronized/unified across all active series in a
  panel.
- Chart type defaults per-metric from its `valueType` (via the enriched
  query, same as the read layer above), with an optional per-panel
  override (`line`/`bar`) for numeric/duration series.

## Data Volume & Resolution Strategy

Some data types (heart rate confirmed; potentially others at similar
intraday resolution) are returned by the API at very high native
frequency — observed as low as ~5-second intervals, i.e. 8,000+ points
per user per day for heart rate alone. Storing every type at native
resolution indefinitely is not the default assumption for this project;
most data types (daily VO2 max, sleep sessions, weight, etc.) are
naturally low-frequency and are unaffected by this section.

- **Downsample high-frequency types at ingestion**, before writing to
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

**Sync auditability** — every sync operation (webhook-triggered,
reconciliation, or backfill) writes a row to a `sync_runs` table
(user_id, provider, metric_type, trigger, requested_range, status,
points_fetched, points_upserted, pages_fetched, error, started/completed
timestamps). This is queryable state, not just application logs — it's
what answers "when did we last successfully sync X for this user."

**Subscription health** — Google auto-disables webhook subscriptions
for inactive subscribers. A scheduled job periodically confirms the
single project-level subscriber (see "Webhook Subscriber Model" below)
is still active and re-registers it if not; webhook coverage should
never silently degrade.

**Gap detection** — flag suspicious patterns from `sync_runs` /
`metric_entries` (e.g. a zero-data day sandwiched between two
normal-density days) as likely sync failures rather than treating all
gaps as equally explainable (device off, etc.).

**Cross-stream duplication is prevented structurally, not by
convention.** Storage-level duplicates are already impossible (see
uniqueness constraints above). Query-level double-counting — e.g.
summing both raw and reconciled values for an overlapping window — is
avoided by never querying `metric_entries` directly for
charts/analysis/export. Instead, all reads go through one canonical
query path that, per user/metric_type/time-window, prefers reconciled
data and falls back to raw only where reconciled is absent. This
removes the risk rather than relying on every future query remembering
to filter by `source_stream`.

**Raw-vs-reconciled divergence check** — a periodic job compares raw and
reconciled values for the same window and logs (not blocks) cases where
they differ meaningfully. Useful signal on how much reconciliation is
actually correcting, and would surface if the `external_id`/key
assumptions above are behaving unexpectedly.

## Webhook Subscriber Model (Google Health API)

Rebuilt twice after initial implementations wrongly assumed behavior
not actually documented — every claim below is verified against a
direct fetch of developers.google.com/health/webhooks and
developers.google.com/health/reference/rest/v4/users/getIdentity, not
paraphrase. This API surface has repeatedly produced confident-but-wrong
claims (wrong scope format, a non-existent "domain verification" step,
fabricated data types, wrong field names/casing tried three times,
wrong verification mechanism, wrong response codes, a missing required
scope) — re-verify anything below against a live fetch before trusting
it further if it's been more than a few weeks, since this API is
actively evolving.

**Subscriber model:**
- **Subscribers are scoped to the Google Cloud project, not to
  individual users.** Exactly **one** subscriber for this app,
  registered via `POST https://health.googleapis.com/v4/projects/{project_number}/subscribers?subscriberId={subscriberId}`.
  **`{project_number}` must be the numeric Google Cloud project
  number** (e.g. `1041840627764` — extractable from the prefix of an
  OAuth client ID, `{number}-{random}.apps.googleusercontent.com`),
  **not** the string project ID (`health-dashboard-project`) — Google's
  own docs list this specific mistake in their common-errors table.
  `subscriberId` is self-chosen, 4-36 chars, matching
  `[a-z]([a-z0-9-]{2,34}[a-z0-9])` — not the literal string `"self"`,
  which silently 404s.
- **Request body field is `endpointAuthorization.secret`** (not
  `authorizationToken` or `authorization_token` — both tried and
  rejected). The value is the **full auth scheme string**, e.g.
  `"Bearer <WEBHOOK_AUTH_TOKEN>"` — not the bare token.
- **`subscriberConfigs` is a list of one entry** containing a
  `dataTypes` array (plural) of all metric type strings — not one
  entry per metric with a singular `dataType` field.
- **`subscriptionCreatePolicy: AUTOMATIC`** — no per-user `Subscription`
  resource is created or managed; eligibility is computed dynamically
  from each user's granted OAuth consent. Connecting a Google account
  does **not** trigger any subscriber API call — it only stores tokens
  and triggers backfill. Disconnecting does **not** touch the
  subscriber — only disables the local `connected_accounts` row /
  revokes the OAuth token.
- **Managed by a standalone script** (`npm run setup:subscriber`), run
  manually — once initially, again only when `WEBHOOK_SUPPORTED_METRICS`
  changes. Must **never** run automatically on app startup or on every
  Render deploy.
- **`GOOGLE_PROJECT_ID`, `GOOGLE_SUBSCRIBER_ID`** must not have silent
  placeholder defaults — missing values fail startup loudly, same as
  `GOOGLE_CLIENT_ID`.
- **`include_granted_scopes` must never be added to the OAuth authorize
  URL.** This project's OAuth client briefly requested legacy Google Fit
  `fitness.*` scopes early in development before being corrected — if
  that consent is still in the client's history, `include_granted_scopes`
  would union it back into future tokens, and Google Health's data
  plane rejects mixed legacy/new-API scopes with an opaque error.
  Guarded by an automated test asserting its absence.

**Endpoint verification handshake — not a `GET`/`hub.challenge`
pattern (that was never real for this API):**
- Two automated `POST` requests, both with body `{"type": "verification"}`,
  sent synchronously during subscriber create/update.
- **Authorized Handshake**: sent *with* the configured `Authorization`
  header — respond `200 OK` or `201 Created`.
- **Unauthorized Challenge**: sent *without* credentials — respond
  `401 Unauthorized` or `403 Forbidden`.
- Both must pass or the API call fails with `FAILED_PRECONDITION`.

**Real notification payload — nested, not flat:**
```json
{
  "data": {
    "healthUserId": "...",
    "operation": "UPSERT | DELETE",
    "dataType": "steps",
    "intervals": [{ "physicalTimeInterval": { "startTime": "...", "endTime": "..." } }]
  }
}
```
- **Respond `204 No Content` immediately**, process asynchronously
  after (not `200` + JSON body). Any other status/timeout triggers
  Google's retry (stored up to 7 days, exponential backoff, then
  discarded).
- Notifications batch up to 99 messages per push.
- **Not yet implemented, tracked as a future hardening item**: Google
  cryptographically signs every notification payload (Tink/ECDSA P-256,
  keys rotate every 30 days, public keyset at
  `gstatic.com/googlehealthapi/webhooks/webhooks_public_keyset.json`,
  signature in the `GOOGLE-HEALTH-API-SIGNATURE` header). The current
  shared-secret `Authorization` header check only proves "knows the
  secret" — the signature would additionally prove authenticity/
  tamper-evidence. Worth implementing for real security, not just
  MVP-adequate.

**User identity mapping — via `users.getIdentity`, not decoding the
OAuth `id_token`:**
- `GET https://health.googleapis.com/v4/users/me/identity` → 
  `{ name, legacyUserId, healthUserId }`.
- **Requires the `https://www.googleapis.com/auth/googlehealth.profile.readonly`
  scope** — a scope this project didn't discover it needed until
  implementing this call; not part of the original three Health scopes.
  Confirm the full current scope list (below) is genuinely complete
  before assuming no more gaps exist.
- Populates `connected_accounts.health_user_id` at connect time. Scopes
  don't retroactively apply to already-issued tokens — any account
  connected before this scope was added must reconnect for
  `health_user_id` to populate.

**Current full OAuth scope list** (grown twice already — sleep, then
profile.readonly — treat as possibly still incomplete):
- `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`
- `.../auth/googlehealth.activity_and_fitness.readonly`
- `.../auth/googlehealth.health_metrics_and_measurements.readonly`
- `.../auth/googlehealth.sleep.readonly`
- `.../auth/googlehealth.profile.readonly`

**Webhook-supported data types** — see Architecture Principle 3 for the
current cited list; do not assume it's static.

**Webhook attribution — the one piece treated as a hard
security/correctness invariant, not just an implementation detail:**
Matched against `connected_accounts.health_user_id` (populated via
`getIdentity`, above). Attribution must be an **exact match only**:
- If neither `healthUserId` nor a local user identifier is present in
  the payload, reject immediately (before any database query is
  built) — never let an empty match condition (e.g. `or()` with an
  empty array) silently fall through to a broader query.
- If no active connected account matches, discard the notification
  (log + reject) — **never fall back to "the first/any active
  account."** A silent fallback here means one user's real health data
  can get written to another user's records. This exact bug shipped
  once already this project and was caught before production use —
  treat any future change to this function as needing the same
  scrutiny (an explicit test with 2+ simultaneously active accounts,
  confirming cross-attribution is impossible, tested against the real
  nested payload shape above — not a flat mock shape).
- This logic must run **identically in every environment** — no
  branching on `DATABASE_URL` contents, hostname, or `NODE_ENV` to
  skip or alter the safety check. If tests need a mock, inject at the
  database-client level, not by conditionally bypassing the check
  itself.
- **Live-verified, not just test-suite-verified**: before trusting this
  in production, confirm with two real, simultaneously-connected
  accounts against the deployed Render instance that a webhook for one
  never lands in the other's `metric_entries` — automated tests passing
  is necessary but has not been sufficient evidence anywhere else in
  this project.

## Architecture Principles (do not violate, regardless of phase)

1. All data, from any source, is written through an adapter into the
   single normalized `metric_entries` schema. No phase-specific or
   provider-specific tables.
2. Every data source (Google Health, future integrations, manual entry)
   implements the same adapter interface: `authenticate`, `sync`,
   `mapToNormalizedSchema`. Adding a new source should not require
   touching the storage or chart layers.
3. Sync strategy is **per data type, not uniform**. **Resolved finding,
   worth reading carefully — this was the root cause of most of a
   multi-day debugging session**: the webhooks documentation lists data
   types in Title Case prose ("Heart Rate", "Active Zone Minutes") for
   readability, and the correct literal string format for the
   `subscriberConfigs[].dataTypes` field is **kebab-case**
   (`heart-rate`, `active-zone-minutes`) — **not** camelCase
   (`heartRate`). This matches the 14-day-query-window doc language
   quoted elsewhere in this file (`heart-rate`, `active-minutes`,
   `total-calories`), which was sitting there the whole time as an
   unnoticed clue. CamelCase silently fails with an opaque
   `INVALID_ARGUMENT` (no field-level detail), which is why several
   types were briefly and incorrectly believed unsupported during
   bisection before this was found.

   **Individually confirmed accepted by the live `subscribers.create`/
   `update` API, kebab-case, real 200 responses**: `steps`, `altitude`,
   `active-zone-minutes`, `activity-level`, `blood-glucose`, `body-fat`,
   `calories-in-heart-rate-zone`, `daily-heart-rate-variability`,
   `daily-heart-rate-zones`, `daily-oxygen-saturation`,
   `daily-respiratory-rate`, `daily-resting-heart-rate`,
   `daily-sleep-temperature-derivations`, `distance`, `exercise`,
   `floors`, `heart-rate`, `heart-rate-variability`, `height`,
   `hydration-log`, `nutrition-log`, `respiratory-rate-sleep-summary`,
   `run-vo2-max`, `sedentary-period`, `sleep`,
   `time-in-heart-rate-zone`, `weight`. 26 of 27 documented types
   confirmed — use kebab-case for `WEBHOOK_SUPPORTED_METRICS`
   throughout the codebase (sync service, downsampling,
   `METRICS_14_DAY`), and confirm whether the per-user data-point query
   endpoints (`/dataTypes/{type}/...`) also expect kebab-case rather
   than assuming they match the subscriber endpoint's convention.

   **Genuinely rejected, confirmed individually across multiple spelling
   variants (kebab-case, snake_case) — not a casing artifact**:
   `total-calories` / `total_calories`. Move to `POLLING_ONLY_METRICS`.

   For webhook-supported types, webhooks trigger immediate syncs, with
   a scheduled reconciliation job as backup for missed/delayed
   deliveries and disabled subscriptions.
   **Confirmed still polling-only** (no webhook support found in docs):
   generic `vo2Max`/`dailyVo2Max` (note: `runVo2Max`/`run-vo2-max`
   specifically *is* webhook-supported — these are different types),
   `electrocardiogram`, `irregularRhythmNotification`,
   `coreBodyTemperature`, `bloodPressure`, and `total-calories`/`total_calories` (confirmed genuinely unsupported, all spellings).
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
- Triggered right after OAuth completes, but runs as an **async/queued
  background job** — never synchronously in the OAuth callback. A
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
  **Use the literal scope URLs below — do not substitute the older Google
  Fit API scopes (`fitness.*`), which are a different API and can cause
  token rejection if mixed with Google Health scopes on the same client:**
  - `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`
  - `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`
  - `https://www.googleapis.com/auth/googlehealth.sleep.readonly`
  - `https://www.googleapis.com/auth/googlehealth.profile.readonly`
    (required for `users.getIdentity` — see "Webhook Subscriber Model"
    for why, and note this list has already grown twice unexpectedly;
    don't assume it's final)
- Most data types support ~90 days per query; heart rate, active minutes,
  total calories, and calories-in-heart-rate-zone are capped at 14 days per
  request — batch requests accordingly.
- Failed webhook deliveries retry for up to 7 days before being dropped;
  the reconciliation job is the safety net beyond that window (see
  Architecture Principles for which data types this actually applies to).
- Webhook subscriber endpoints **must be public HTTPS (TLS 1.2+)** —
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

- **Backend hosting: Render**, region **Frankfurt** — matches the Neon
  region above to keep backend-to-database latency low and data within
  the EU. Deliberately *not* Google Cloud Run,
  despite already having a GCP project for OAuth — that project is an
  OAuth identity container, not compute infrastructure, so reusing it
  saves little. Render avoids GCP billing-account/IAM overhead, deploys
  directly from the GitHub repo (same repo the CI pipeline already runs
  against), and gives a public HTTPS endpoint with no separate tunnel
  needed once deployed. Cold-start behavior is also more predictable
  than Cloud Run's scale-to-zero default, which matters while validating
  sync-timing logic. **Render is used for compute only — not its own
  Postgres product**, which is a separate offering from the database
  decision below and has a hard 30-day free-tier expiration with
  permanent data deletion. `DATABASE_URL` points at Neon regardless of
  where the app is hosted.
- **Database: Neon** (Postgres), region **AWS Europe (Frankfurt,
  `aws-eu-central-1`)**. Chosen for two reasons: (1) latency — the
  pairing that matters is backend-server-to-database, not
  user-to-database, so this should match wherever Render is deployed;
  (2) data residency — this project stores real personal health data
  (GDPR special category), and the developer is EU-based, so keeping
  storage in the EU is a deliberate default, not just a performance
  choice. **Region is permanent per Neon project** — cannot be changed
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
  `DATABASE_URL` (in local `.env`) points at the **test branch**, used
  by the app locally, the test suite, and CI. The **primary/live branch**
  connection string is not stored in `.env` or anywhere in the project
  at all right now — deliberately, so there's nothing for code or tests
  to accidentally reference. It gets added only when actually going
  live with the real Google account connection, as a conscious step, not
  something left in place "just in case." Never point tests, CI, or a
  Render deployment meant for real use at the same connection string
  simultaneously used for destructive testing (cascade-delete/rollback
  tests specifically).
  **Go-live plan (decided)**: fresh start, not a data migration — test
  branch data is not copied to production. Sequence: (1) confirm data
  quality against test branch, (2) test full backfill against test
  branch, (3) live-verify two-account webhook attribution against test
  branch using a second throwaway Google account — this must happen
  *before* production goes live, since it's the one fix in this project
  with a real data-corruption risk profile, (4) switch Render's
  `DATABASE_URL` to the live branch connection string, (5) disconnect/
  reconnect the real Google account against production and let backfill
  run fresh. After go-live, the test branch reverts to its normal role
  as the dev/CI sandbox for all future phases.
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
  testing. **`CRON_SECRET` and `WEBHOOK_AUTH_TOKEN` must be distinct
  values** — the latter is handed to and stored by Google (as the
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
- **Resolved**: job scheduling — GitHub Actions `schedule` cron pings a
  secret-authenticated `/api/sync/scheduled` endpoint, which checks
  `sync_runs` for what's actually due rather than trusting exact timing
  (see Deployment & Staging Environment).
- **Resolved**: downsampling interval — dual-tier, not a single choice.
  High-frequency types are aggregated to **both** 1-minute (`1m_avg`)
  and 5-minute (`5m_avg`) buckets at ingestion (min/max/avg/sample
  count), with the raw response preserved in `raw_payload`.
- **Still open**: how long full-resolution `raw_payload` data is
  retained before pruning — not yet decided — Phase 2.
- **Resolved & implemented**: Phase 3 in full — schema,
  immutability/retirement rules, category value handling, manual-entry
  adapter treatment, API surface, and the enriched read layer closing out
  Architecture Principle 5 for custom metrics — see `metric_definitions`,
  "Phase 3 API Surface," and "Enriched Metric Read Layer" above.
- **Deferred, not answered**: Phase 4 (other integrations) is on hold
  indefinitely — no second data source is currently planned, so there's
  nothing concrete to design the adapter generalization against yet.
  Decision explicitly postponed rather than forced: whether to generalize
  the adapter interface up front or hardcode around a first concrete
  integration and extract the general interface once a second one exists
  stays open until an actual integration target is chosen. Revisit this
  question when (if) one is.
- **Resolved & implemented**: Frontend is a web page (React + Vite SPA),
  served from the same Render service as the backend — see "Phase 5
  Frontend & API Surface" above. Native app was considered and not
  chosen.
