# Phase 3 Detail — Custom Metrics

## Scope

Allow users to define and log custom metric types directly in the app, storing them in the same normalized `metric_entries` model as synced provider data.

Phase 3 is complete.

## `metric_definitions`

Columns:

| Column | Contract |
|---|---|
| `id` | UUID surrogate PK |
| `user_id` | FK to `users.id`, `ON DELETE CASCADE` |
| `metric_type` | unique per `(user_id, metric_type)`; cannot collide with reserved provider types |
| `display_name` | human-readable UI label; editable after entries exist |
| `value_type` | numeric/duration/boolean/category contract |
| `unit` | required for numeric/duration; null for boolean/category |
| `category_values` | JSONB array, only for category |
| `archived_at` | nullable retirement timestamp |
| `created_at` / `updated_at` | timestamps |

`metric_entries.unit` and `metric_entries.source_stream` were relaxed to nullable to support value types and manual rows for which those fields have no meaning. This was the one schema change made by Phase 3; everything else was additive.

## Metric Type Validation

`metric_type` is typed directly by the user.

Strict kebab-case:

```text
/^[a-z0-9]+(?:-[a-z0-9]+)*$/
```

Length: 2–50 characters.

Validate with Zod and return a descriptive `ValidationError` on mismatch.

Do not silently derive or slugify the key from `display_name`.

## Reserved Names

Reserved metric-type collisions are checked against a set derived at import time from:

- `WEBHOOK_SUPPORTED_METRICS`
- `POLLING_ONLY_METRICS`
- `METRICS_14_DAY`
- known provider identifiers

Do not create a separately hand-maintained list.

## Category Values

For `value_type=category`:
- must be a non-empty array
- values must be non-empty after trimming
- values must be deduplicated
- validation occurs at creation and update
- the list is fixed until explicitly managed
- logging does not implicitly create new category values
- submitted values are checked against the current list with a dynamically built Zod enum
- unrecognized values are rejected
- removing a value already used by an entry must be blocked

## Ownership

Every definition/entry lookup used for writes is scoped by `user_id`.

Looking up another user's definition/entry by ID returns `NotFoundError`/404 rather than leaking existence or permitting cross-user writes.

## Database Error Mapping

On creation:
- inspect actual Postgres error code
- `23505` on the unique metric constraint maps to `ValidationError` ("metric type already exists for this user")
- any other DB error is logged and rethrown as `DatabaseError`

Do not classify every DB failure as a duplicate.

## Immutability After First Use

Once any `metric_entries` row references a definition:
- `value_type` cannot change
- `unit` cannot change
- enforce this at service layer with an `EXISTS` query
- reject attempts with `ValidationError`

`display_name` can always change because it does not alter interpretation.

## Retirement / Deletion

Before entries exist:
- definition can be hard-deleted

After entries exist:
- deletion becomes soft retirement via `archived_at`
- archived definitions disappear from "log new entry" pickers
- archived definitions remain intact for historical charts/exports

No unarchive route exists deliberately. Create a new definition rather than reviving an archived one.

## Manual Entry Adapter

Manual/custom entry does not naturally implement a real external sync lifecycle.

Treat it as a degenerate adapter:
- `authenticate()` is a no-op
- `mapToNormalizedSchema()` is called directly by the API route on submission
- no fake `sync()` cycle is invented

Resulting rows:
- `provider = manual`
- `external_id = null`
- `source_stream = null`

Each manual submission is its own row, not an upstream upsert target.

Unlike synced provider data, manual rows support direct user edit/delete because the user authored them.

## Combined Create + First Entry

The combined flow creates a definition and logs its first entry.

These are two DB mutations but one user-visible operation, so the entire operation must be transactional.

Pass the newly created definition's `id` directly to the entry-logging step rather than re-fetching by `metric_type`.

## API Surface

- `POST /api/metric-definitions`
  - body: `metric_type`, `display_name`, `value_type`, `unit?`, `category_values?`
  - Zod validated
- `GET /api/metric-definitions`
  - `?includeArchived=true` includes retired definitions
- `GET /api/metric-definitions/:id`
- `PATCH /api/metric-definitions/:id`
  - server enforces `value_type`/`unit` immutability after use
- `POST /api/metric-definitions/:id/archive`
  - soft retirement
  - no unarchive
- `DELETE /api/metric-definitions/:id`
  - only when zero entries exist
  - otherwise typed error directs client to archive
- `POST /api/metric-entries/manual`
  - validates against definition's value type/unit/category list
  - writes through normalized row path
- `POST /api/metric-entries/manual/combined`
  - transactional definition + first entry
- `PATCH /api/metric-entries/manual/:id`
- `DELETE /api/metric-entries/manual/:id`
  - editing/deleting historical manual entries remains possible even when definition is archived
  - creating new entries against archived definitions is blocked
- `GET /api/metric-entries?metric_type=...&start_time=...&end_time=...`
  - enriched read endpoint
  - also accepts `metric_types=a,b,c`

The read route currently lives in `manualEntryRoutes.ts` even though it serves both synced and custom metrics. Naming/location cleanup is worthwhile when the file is next touched, but is not urgent.

## Enriched Metric Read Layer

Purpose: give charts/UI both normalized entries and the metadata needed to render them.

### `queryEnrichedMetricEntries(filter)`

Returns:

```text
{
  metricType,
  displayName,
  valueType,
  unit,
  categoryValues,
  entries
}
```

Custom metric metadata comes from `metric_definitions`.

Provider metric metadata comes from `CANONICAL_PROVIDER_METRICS` in `baseAdapter.ts`.

`CANONICAL_PROVIDER_METRICS` is the canonical dictionary for provider `displayName`, `valueType`, `unit`, and `categoryValues`.

Unknown provider metric keys use title-case fallback metadata rather than failing.

Do not filter `archived_at IS NULL` during historical reads. Archived custom metrics remain fully chartable.

### `queryBatchEnrichedMetrics(filters[])`

Batch version:
- resolves multiple metrics at once
- uses two `IN (...)` queries
- avoids N+1 per-metric DB calls
- used by dashboard multi-metric rendering

## Cross-Stream Read Rule

`filterReconciledOverRaw` treats manual rows with `source_stream=null` as valid raw entries.

Charts/analysis/export should consume the enriched canonical path rather than query `metric_entries` directly.

## Missing Metric References

A dashboard panel may reference a custom metric that was hard-deleted when it had zero entries.

The enriched query:
- returns empty entries
- supplies title-case fallback metadata
- does not fail the whole panel

Frontend behavior:
- subtle "no entries found for `<metric>`" notice for that series
- other overlay series continue rendering

Archived metrics render normally.

`archived_at` controls new-entry eligibility, not historical queryability.
