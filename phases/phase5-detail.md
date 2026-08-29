# Phase 5 Detail — Customizable Charts

## Scope

User-configurable dashboard with saved views, multiple metrics per panel, time ranges, aggregation, and chart types.

Phase 5 is complete.

## Frontend

- React 18
- Vite SPA in `client/`
- Recharts
- served from the same Render service as the backend

Serving:
- `express.static(client/dist)`
- pathless SPA fallback registered after `/api/*` and `/health`
- must be Express 4/5-safe
- do not use bare `app.get('*')` under Express 5 because `path-to-regexp` v6 throws at startup
- same-origin serving avoids CORS and keeps auth cookies straightforward

## Build Pipeline

Root `build`:
1. `build:backend` (`tsc`)
2. `build:client` (`npm --prefix client run build`)

`render.yaml` build command installs root and client dependencies explicitly.

Render does not recurse into subdirectories automatically.

## `dashboard_views`

Columns:

| Column | Contract |
|---|---|
| `id` | UUID surrogate PK |
| `user_id` | FK to `users.id`, `ON DELETE CASCADE` |
| `name` | display name; unique per `(user_id, name)` |
| `config` | JSONB panel configuration |
| `created_at` / `updated_at` | timestamps |

Metric references are plain strings, not FKs.

A panel may therefore reference a subsequently deleted custom metric.

## Panel Config

Validated with Zod at the API boundary using `TimeRangeSchema` as a discriminated union:

```ts
{
  panels: [
    {
      id: string,
      metricTypes: string[],        // 1+, non-empty; overlay when >1
      timeRange:
        { type: 'relative', value:
          'last_24h' |
          'last_7d' |
          'last_30d' |
          'last_90d' |
          'last_1y'
        }
        | { type: 'absolute', startTime: string, endTime: string },
      aggregation:
        'raw' |
        '1m_avg' |
        '5m_avg' |
        'daily_avg' |
        'weekly_avg',
      chartType?: 'line' | 'bar'
    }
  ]
}
```

Do not mix an ambiguous `'custom'` enum value into the relative branch.

## Time Ranges

Relative ranges are calculated when rendering.

A saved `last_7d` view means the seven days ending around the time it is opened, not the seven days that existed when it was saved.

## Aggregation

Supported:
- `raw`
- `1m_avg`
- `5m_avg`
- `daily_avg`
- `weekly_avg`

### Weekly

`weekly_avg` is a fixed ISO calendar-week bucket:
- Monday start
- not rolling 7-day
- fixed bucket, consistent with daily/other display aggregation

Long-range daily line charts such as a year of steps can be noisy, so weekly buckets surface overall shape more usefully.

This is display aggregation only. It must not be described as a trend; trend detection is Phase 6.

### Default

New panels default to `weekly_avg`.

Boolean/category metrics ignore aggregation and render as events, so the universal default is harmless for those types.

The user can override aggregation per panel.

### Shared DB aggregation

`daily_avg` and `weekly_avg` both use:

`queryAggregatedMetricsFromDb`

in `metricsQueryService.ts`.

It was renamed from `queryDailyAggregatedMetricsFromDb` when weekly aggregation was added.

It uses:
- `date_trunc('day' | 'week', start_time)`
- one shared `statement_timeout`

Future bucket granularities should extend this shared function rather than duplicating aggregation logic.

### UTC

Bucket boundaries use UTC.

`start_time` / `end_time` are `TIMESTAMPTZ`.

No `AT TIME ZONE` conversion is applied, so:
- daily bucket = UTC calendar day
- weekly bucket = Monday 00:00 UTC through Sunday 23:59:59.999 UTC

## Ownership

Every get/update/delete lookup is scoped by `user_id`, not just ID.

Unauthorized/not-found branches log structured context:
- `userId`
- `viewId`
- `operation`

## Unique Names

Postgres `23505` on `(user_id, name)` is mapped to `ValidationError` on:
- create
- rename via update

A rename collision behaves like a duplicate create.

## API Surface

- `POST /api/dashboard-views`
  - create
  - Zod validates config
- `GET /api/dashboard-views`
  - list user's views
- `GET /api/dashboard-views/:id`
- `PATCH /api/dashboard-views/:id`
  - rename and/or reconfigure
  - same ownership/name rules
- `DELETE /api/dashboard-views/:id`

No new data-fetching endpoint was added.

Rendering:
1. resolve each panel's relative range to absolute timestamps
2. call Phase 3's batched endpoint:
   `GET /api/metric-entries?metric_types=a,b,c&start_time=...&end_time=...`
3. render returned series

## Multi-Metric Overlay Rendering

A panel can overlay multiple metrics.

This was deliberate scope, not merely a default.

### Axes

Every metric gets its own Recharts `yAxisId`.

Never share a numeric Y-axis between metrics with different scales/units.

### Numeric / Duration

Render as lines or bars against their own Y-axis.

All share one time-based X-axis.

### Boolean

Render as event marker bands/pins along the timeline.

Do not render as a 0/1 numeric line.

### Category

Render as discrete event markers with text labels.

Do not treat category labels as Y-values.

### Tooltips

Hover tooltips are synchronized/unified across all active series in a panel.

### Chart Type

Chart type defaults per metric from its `valueType`, resolved by the enriched metric read layer.

Optional panel override:
- `line`
- `bar`

Override applies to numeric/duration series.

## Missing / Deleted Metrics

Because metric references are strings:
- a hard-deleted zero-entry custom metric can remain in a saved panel
- enriched query returns empty entries plus title-case fallback metadata
- frontend displays a subtle no-data notice for that series
- other overlay series continue rendering

Archived metrics render normally.

## Dependencies on Phase 3

Phase 5 depends on:
- `queryEnrichedMetricEntries`
- `queryBatchEnrichedMetrics`
- canonical reconciled-preferred read behavior
- custom/provider metric metadata resolution

Do not duplicate Phase 3's reconciliation or metadata resolution in dashboard code.
