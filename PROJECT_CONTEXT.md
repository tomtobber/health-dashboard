# Project Context — Personal Health Dashboard

## Context Loading Rules

This file is the always-loaded project context.

### Default rule

Start every session by reading `PROJECT_CONTEXT.md`.

Do NOT automatically read:
- `DECISIONS.md`
- `phases/*-detail.md`

Only load those files when the current task requires information they contain.

### Task → Context Routing

| If you are working on... | Read |
|---|---|
| Google OAuth, Health API, sync, webhooks, backfill | `phases/phase2-detail.md` |
| Custom metrics, manual entries, metric definitions | `phases/phase3-detail.md` |
| Dashboard, panels, charts, aggregation | `phases/phase5-detail.md` |
| Baselines, trends, insights | `phases/phase6-detail.md` |
| Changing an architectural decision | `DECISIONS.md` |
| Investigating why something was designed this way | `DECISIONS.md` |
| General project work | `PROJECT_CONTEXT.md` only |

### When to open a phase detail file

Open `phases/<phase>-detail.md` when:

1. You are implementing, modifying, debugging, reviewing, or testing code belonging to that phase.
2. You need an API contract, schema detail, UI behavior, validation rule, edge case, or implementation detail that is not fully specified in `PROJECT_CONTEXT.md`.
3. You are changing code that depends materially on a completed phase.
4. You are investigating a regression in a completed phase.
5. You need to verify an exact existing behavior before changing it.

Do NOT open completed-phase detail files merely because the phase is mentioned in the task.

Examples:
- Working on custom metrics → read `phases/phase3-detail.md`.
- Working on dashboard rendering → read `phases/phase5-detail.md`.
- Working on trend detection → read `phases/phase6-detail.md`.
- Working on Google Health sync/webhooks → read `phases/phase2-detail.md`.

### When to open DECISIONS.md

Open `DECISIONS.md` when the task involves **why** something is the way it is, rather than simply **what** it currently is.

Specifically, read it when:

1. You are considering changing an existing architectural decision.
2. You encounter an apparently strange, redundant, restrictive, or non-obvious implementation and need to understand its rationale.
3. You are considering an alternative that appears simpler and want to know whether it was previously rejected.
4. You are debugging behavior where historical incidents or provider-specific mistakes may be relevant.
5. You are about to remove, rename, generalize, or substantially redesign something that looks intentional.
6. `PROJECT_CONTEXT.md` points you to historical rationale for the decision.

Do NOT read `DECISIONS.md` routinely just to understand current implementation.

### Source-of-truth rules

`PROJECT_CONTEXT.md` describes the CURRENT state.

`phases/*-detail.md` describes DETAILED implementation contracts.

`DECISIONS.md` describes HISTORICAL rationale and rejected alternatives.

When they appear to conflict:

1. Treat `PROJECT_CONTEXT.md` as authoritative for current state.
2. Treat phase detail as authoritative for detailed implementation behavior, unless current state explicitly supersedes it.
3. Treat `DECISIONS.md` as historical explanation, not as an instruction to preserve obsolete implementation.
4. If a historical decision appears to conflict with current state, do not silently revert the current state. Ask whether the current state is intentional or inspect the code/tests.

### Before making changes

First determine:

- What phase does this task belong to?
- Is that phase active or completed?
- Which invariants in `PROJECT_CONTEXT.md` apply?
- Do I need the phase detail file?
- Am I questioning an existing decision? If so, read `DECISIONS.md`.

Do not implement future-phase functionality merely because it is described in a detail file.

### After making changes

If the change alters:
- architecture,
- a hard invariant,
- an API contract,
- data-model semantics,
- provider behavior,
- deployment assumptions,
- or an important product decision,

update `PROJECT_CONTEXT.md` if it changes current state.

If the change explains a new important decision, rejected alternative, failure, or lesson that future agents should understand, append it to `DECISIONS.md`.

Keep completed-phase detail files focused on the implementation contract. Do not move historical narratives back into them.

## Vision

A personal (initially single/small-user) web application that aggregates health and lifestyle data from multiple sources — starting with the Google Health API — normalizes it into one data model, lets the user add custom metrics, and surfaces it through customizable charts and eventually lightweight statistical insights.

## Current Phase State

| Phase | Status | Reference |
|---|---|---|
| 1. Connect flow | complete | implemented OAuth 2.0 flow, user + connected-account records, encrypted tokens |
| 2. Sync + storage | active/foundation for later work | `phases/phase2-detail.md` |
| 3. Custom metrics | complete | `phases/phase3-detail.md` |
| 4. Other integrations | deferred indefinitely | see `DECISIONS.md` |
| 5. Customizable charts | complete | `phases/phase5-detail.md` |
| 6. Conclusions / insights | active (slice 4 in progress) | `phases/phase6-detail.md` |

Phase 6 currently contains:
- Personal baselines: complete (Slice 1).
- Trend detection: complete (Slice 2).
- Correlation between user-chosen metric pairs: complete (Slice 3).
- Baseline history snapshots: in progress (Slice 4).

## Architecture Principles — Hard Invariants

1. **One normalized write model.** All sources write through the adapter into `metric_entries`; no phase-specific or provider-specific data tables.
2. **Common source abstraction.** Google Health, future integrations, and manual entry use the `authenticate`, `sync`, `mapToNormalizedSchema` adapter shape. Manual entry is a degenerate adapter because there is no external system.
3. **Sync strategy is per data type.** Webhook-supported Google Health types use immediate webhook-triggered sync plus scheduled reconciliation; polling-only types use polling/reconciliation.
4. **Idempotent writes.** Sync/reconciliation uses upserts with the uniqueness keys defined below; repeated or overlapping runs must not create duplicates.
5. **Manual/custom metrics are first-class.** They use the same normalized model and canonical read path as synced data.
6. **Insights are descriptive/correlational, never diagnostic or prescriptive.** No diagnostic language. Directional results must not be framed as "improving", "worsening", "better", or "worse" because desirability is metric-specific.
7. **Canonical reads.** Charts, analysis, and exports never aggregate `metric_entries` directly. They use the reconciled-preferred read path so raw and reconciled streams cannot be double-counted.

## Core Data Model

### `connected_accounts`

Generic across providers from day one.

- `user_id`: FK to `users.id`, `ON DELETE CASCADE`
- `provider`: e.g. `google_health`
- `health_user_id`: provider user identifier; required for exact-match webhook attribution
- `access_token` / `refresh_token`: encrypted at rest
- `scopes`
- `status`: `active` / `disabled` / `needs_reauth`

### `metric_entries`

One normalized table for synced, manual, and future-integration data.

- `id`: UUID surrogate PK
- `user_id`: FK to `users.id`, `ON DELETE CASCADE`
- `provider`: `google_health`, `manual`, future integration names
- `metric_type`: normalized key
- `external_id`: native provider point ID where available; raw stream only
- `start_time` / `end_time`: always set
- `dimension`: nullable component/sub-category axis
- `value_numeric`: numeric, duration seconds, or boolean `0/1`
- `value_text`: category label
- `value_min` / `value_max`: nullable range boundaries
- `unit`
- `source_stream`: `raw` / `reconciled`; nullable for manual rows
- `raw_payload`: original provider JSON
- `updated_at`
- `deleted_at`: nullable soft delete

Compound/range rules:
- `mapToNormalizedSchema` returns an array so one provider point may expand into multiple rows.
- Dimensioned values emit one row per dimension.
- Sleep emits a total `sleep` row plus one `sleep_stage` row per actual stage interval.
- Co-reported components such as blood-pressure systolic/diastolic use `dimension` + `value_numeric`, not `value_min`/`value_max`.
- Ranges such as heart-rate zones use `dimension` + `value_min`/`value_max`, with `value_numeric` for an associated point value where applicable.
- Audit real payloads before assuming a metric type does not need expansion.

Deduplication:
- Raw stream with native ID: `(user_id, provider, metric_type, dimension, external_id)`.
- Reconciled stream or interval/rollup without stable ID: `(user_id, provider, metric_type, dimension, source_stream, start_time, end_time)`.
- Reconciled values take priority over raw values.
- Never use insert-then-check; use `ON CONFLICT` upsert.
- `dimension` must be present in both key variants because one provider point may expand into multiple dimensioned rows.

Deletion:
- Provider has no reliable per-point delete notification; reconciliation diffs the API result against stored rows and sets `deleted_at`.
- Soft delete preserves history and allows a point to reappear after sync delay.
- Deleting a `users` row cascades to connected accounts and metric entries.
- A future reversible account-deletion UX would be application-layer scheduling, not a reason to remove DB cascades.

### `metric_baseline_history`

Append-only monthly baseline snapshots. Never updated after insert.

- `user_id`: FK to `users.id`, `ON DELETE CASCADE`
- `metric_type`: string, no FK (can outlive a deleted custom metric)
- `computed_at`: the UTC month-boundary this snapshot represents
- `window_days`, `window_start`, `window_end`
- `mean`, `stddev`, `min`, `max`, `sample_size`
- `created_at` (no `updated_at` — append-only)
- Unique on `(user_id, metric_type, computed_at)`

Full contract in `phases/phase6-detail.md`.

## Completed Feature Contracts

### Phase 3 — Custom metrics

- `metric_definitions` defines user-owned metric types.
- `metric_entries.unit` and `source_stream` are nullable where meaningless for custom/manual data.
- Custom `metric_type` is user-entered kebab-case, regex `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, 2–50 chars.
- Reserved metric types are derived from adapter constants, not a hand-maintained list.
- Category values are a non-empty, deduplicated, trimmed fixed list.
- All definition/entry writes are ownership-scoped by `user_id`.
- PG `23505` is specifically mapped to validation errors; unrelated DB errors remain database errors.
- `value_type` and `unit` lock once entries reference a definition; `display_name` remains editable.
- Removing a category already used by entries must be blocked.
- Definitions with zero entries can be hard-deleted; definitions with entries are archived via `archived_at`.
- Archived definitions remain queryable for historical charts/exports but cannot receive new entries.
- Manual rows use `provider=manual`, `external_id=null`, `source_stream=null`; they can be edited/deleted because the user authored them.
- Combined create-definition + first-entry flow is transactional.
- Canonical enriched read functions are `queryEnrichedMetricEntries` and `queryBatchEnrichedMetrics`.
- Archived definitions must not be filtered out of historical reads.
- Missing/deleted custom metric references must fall back to metadata and an empty entries array rather than breaking an entire chart.

Detailed contract/API: `phases/phase3-detail.md`.

### Phase 5 — Customizable charts

- React 18 + Vite SPA in `client/`; Recharts for charting.
- Same-origin serving from the backend Render service; no CORS dependency.
- SPA fallback is Express 4/5-safe and comes after API/health routes.
- Root build runs backend TypeScript compilation then client build.
- Render explicitly installs root and client dependencies.
- `dashboard_views` stores named dashboard layouts in JSONB. Panels are polymorphic via `panelType`, with `chart` (overlaid time-series) as the default for panels predating the field.
- Panel metric references are strings, not FKs.
- Relative ranges resolve at render time, not save time.
- Supported aggregation: `raw`, `1m_avg`, `5m_avg`, `daily_avg`, `weekly_avg`.
- `weekly_avg` is ISO calendar-week, Monday-start, not rolling 7-day.
- New panels default to `weekly_avg`.
- Boolean/category metrics ignore aggregation and render as events.
- `daily_avg` and `weekly_avg` use shared `queryAggregatedMetricsFromDb`.
- Aggregation buckets are UTC, not user-local time.
- Dashboard ownership is enforced in queries by `user_id`.
- PG `23505` on view names is mapped on both create and rename/update.
- Missing metric references render as empty series with fallback metadata; archived metrics render normally.
- Panels may overlay multiple metrics.
- Numeric/duration series use lines/bars and individual Y-axes.
- Boolean metrics use event markers; category metrics use labeled event markers.
- Hover tooltips are unified across active series.
- Existing Phase 3 batched enriched endpoint supplies panel data; Phase 5 adds no new data-fetching endpoint.
- The dashboard persists the currently selected view and any unsaved panel edits to `localStorage` so a refresh or redeploy restores the exact on-screen state. This is independent of the named-view save mechanism, which remains fully manual and is the only path that writes to `dashboard_views`.

Detailed contract/API/UI: `phases/phase5-detail.md`.

## Phase 6 — Current Feature State

### Personal baselines — complete

- Mean, standard deviation, min, max, sample size.
- Numeric/duration only; boolean/category requests are validation errors.
- Computed live from the canonical enriched reconciled read path.
- Default window: 90 days.
- Minimum sample size: 10.
- Fewer than 10 entries returns an explicit `insufficient_data` result.
- Per-user/per-metric window config lives in `metric_baseline_configs`.
- Config is intentionally not FK-linked to metric definitions so it may outlive a deleted custom metric.
- `GET /api/metrics/:metricType/baseline`
- `GET /api/metrics/:metricType/baseline-config`
- `PUT /api/metrics/:metricType/baseline-config`
- Exact approved UI copy is in `phases/phase6-detail.md`.
- Never use population-referenced/evaluative language such as "normal", "healthy", "abnormal", "target", "goal", "good", or "bad".

### Trend detection — complete

- Single numeric/duration metric.
- Reuses the Personal Baseline window config.
- Ordinary least-squares regression of value against time.
- Entries are bucketed to one mean per UTC calendar day before regression.
- Regression x is actual calendar days since window start, not sequential rank.
- Requires at least 10 distinct daily buckets.
- Pearson `r` gates directional labeling.
- Default `TREND_CORRELATION_THRESHOLD = 0.3`.
- Labels: `increasing`, `decreasing`, `no_clear_trend`.
- `GET /api/metrics/:metricType/trend`
- Uses the same `metric_baseline_configs` endpoint for window configuration.
- Exact implementation detail is in `phases/phase6-detail.md`.

### Cross-metric correlation — complete

- Descriptive Pearson correlation between two user-chosen numeric/duration metrics.
- `metricTypeA !== metricTypeB` enforced; same-metric pairs are validation errors.
- Boolean/category metrics are validation errors, matching baseline/trend.
- Computed from `queryBatchEnrichedMetrics`, aligned by UTC calendar day via inner join (`D = D_A ∩ D_B`).
- Minimum sample size: 10 aligned days, via its own named constant `MIN_CORRELATION_SAMPLE_SIZE`.
- Zero-variance in either series maps to `r = 0` rather than an error.
- Binary significance gate: `|r| >= CORRELATION_SIGNIFICANCE_THRESHOLD` (default `0.3`) → `hasClearCorrelation`. No "strong"/"moderate"/"weak" labels are used anywhere.
- No persisted pairwise config table; `windowDays` is an optional per-request override only, default 90.
- `GET /api/metrics/correlation`
- Exact implementation detail is in `phases/phase6-detail.md`.

### Baseline history — fourth slice, complete

- Append-only monthly snapshots of the same statistics as the live baseline (mean, stddev, min, max, sample size), computed as of each fully-elapsed UTC calendar-month boundary.
- Fixed, non-configurable window: `BASELINE_HISTORY_WINDOW_DAYS = 90`. No config endpoint exists for it.
- Current in-progress month is never snapshotted.
- Snapshots are generated by `POST /api/metrics/:metricType/baseline-history/refresh`, which is strictly scoped to one metric, idempotent, and safely re-callable; it processes up to 50 elapsed months per call rather than looping unboundedly. Baseline panels execute the refresh targeting their specific metric in a `while (hasMore)` loop until complete.
- Existing rows are never recomputed or modified once inserted.
- Rows below the baseline sample-size gate are simply not created for that boundary — there is no stored "insufficient data" row.
- `GET /api/metrics/:metricType/baseline-history?startTime=&endTime=` returns stored rows for the authenticated user in that range.
- The live baseline UI is now a persistent dashboard panel type (`BaselinePanel.tsx`), not a modal popup. Each baseline panel renders current live baseline stats, a chronological monthly snapshot history strip, and a per-panel 'Refresh Baseline History' action.
- Does not change the live baseline or trend endpoints' behavior.
- Exact implementation detail is in `phases/phase6-detail.md`.

## Data Volume / Resolution

- Heart rate has been observed at ~5-second intervals, potentially 8,000+ points/user/day.
- High-frequency types should be downsampled at ingestion before writing normalized rows.
- Intended high-frequency tiers include 1-minute and 5-minute aggregation with min/max/avg/sample count.
- `aggregation` should identify stored resolution (`raw`, `1m_avg`, `5m_avg`, `daily_avg`, ...).
- Full-resolution provider response may remain in `raw_payload` only for a short rolling window if drill-down is later needed.
- Resolution is decided per data type based on actual provider frequency.
- Resolved ingestion choice: high-frequency types use both 1-minute and 5-minute buckets; retention duration of full-resolution `raw_payload` is still open.

## Observability & Data Quality

- Every webhook-triggered, reconciliation, or backfill sync writes `sync_runs` with user/provider/metric/trigger/range/status/fetch/upsert/page/error/timestamps.
- Subscription health is periodically checked because Google may auto-disable inactive subscribers.
- Gap detection should flag suspicious missing-data patterns rather than treating every gap as benign.
- Storage uniqueness prevents structural duplicates.
- All analytical/chart/export reads use the canonical reconciled-preferred query path.
- A periodic raw-vs-reconciled divergence check logs meaningful differences.

## Google Health — Current Provider Contract

This provider contract is detailed in `phases/phase2-detail.md`. The always-active invariants are:

- Webhook subscribers are project-scoped; this app uses exactly one subscriber.
- Subscriber creation/update is managed by `npm run setup:subscriber`, never automatically on startup/deploy.
- `endpointAuthorization.secret` contains the full auth scheme, e.g. `Bearer <WEBHOOK_AUTH_TOKEN>`.
- `subscriberConfigs` contains one entry with a plural `dataTypes` array.
- `subscriptionCreatePolicy` is `AUTOMATIC`.
- Missing `GOOGLE_PROJECT_ID` / `GOOGLE_SUBSCRIBER_ID` must fail loudly; no silent placeholders.
- Never add `include_granted_scopes` to the OAuth authorize URL.
- Webhook verification is the provider's two-POST verification handshake, not GET/hub.challenge.
- Notifications are nested under `data` and the endpoint responds `204 No Content` immediately, then processes asynchronously.
- Webhook attribution is an exact `health_user_id` match. Missing identity or no active match means reject/discard; never choose an arbitrary active account.
- Attribution logic must be identical in every environment.
- Before production trust, perform live two-account attribution verification against the deployed instance.
- Provider notification signature verification is a future hardening item.

Current accepted webhook metric types and polling-only types are maintained in `phases/phase2-detail.md` because the provider API is evolving and must be re-verified live before relying on the list.

## Initial Backfill

- Starts after OAuth but asynchronously/queued, never inside the OAuth callback.
- UI shows syncing/in-progress state and renders data as it arrives.
- Must be resumable and idempotent using the same upsert logic as normal sync.

## Deployment / Environment

- Backend: Render, Frankfurt.
- Database: Neon Postgres, AWS Europe (Frankfurt), `aws-eu-central-1`.
- Render is compute only; `DATABASE_URL` points to Neon.
- Two Neon branches: test branch for local/test/CI; separate live branch for production.
- Test and production must never share a destructive-test database.
- Go-live is a fresh production start, not a migration.
- OAuth project remains in Google Cloud; redirect URI must be a registered real HTTPS URL.
- Auth: custom JWT/bcrypt, not Neon Auth.
- Secrets are deployment configuration, not committed values.
- `CRON_SECRET` and `WEBHOOK_AUTH_TOKEN` must be distinct.
- Google OAuth test-user authorizations currently expire after 7 days while the app is in Testing status.
- Render free-tier spin-down pauses in-process timers. GitHub Actions periodically calls secret-authenticated `POST /api/sync/scheduled`, which checks `sync_runs` for overdue work.
- Render Starter can later be used without code changes.
- Free-tier webhook delivery can have ~30–50s cold-start delay, within Google's retry window.

## Open Decisions

- Phase 2: how long full-resolution `raw_payload` data is retained before pruning.
- Phase 4: adapter generalization strategy remains intentionally deferred until an actual second integration is chosen.
- Provider webhook/identity behavior: re-verify against live Google documentation before trusting details that have not been checked recently.
- Phase 6 Slice 4: confirm the chosen per-request bounding approach (chunked pagination vs. extended timeout) against the actual text of AGENTS.md §4 before considering this finalized.

## Historical Rationale

Historical reasoning, debugging stories, rejected alternatives, and "this bug happened once already" narratives belong in `DECISIONS.md`, not here.
