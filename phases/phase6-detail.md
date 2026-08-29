# Phase 6 Detail — Conclusions / Insights

## Scope

Phase 6 introduces descriptive statistics only.

The system may describe patterns in the user's own data but must not make diagnostic or prescriptive claims.

Current slices:
1. Personal baselines — complete
2. Trend detection — complete
3. Correlation between user-chosen metric pairs — later, not implemented

Causal or prescriptive claims, if ever considered, require established physiology/sports-science methods and must remain clearly distinguished from observations in the user's data.

## Personal Baselines — Complete

A personal baseline contains:
- mean
- standard deviation
- minimum
- maximum
- sample size

It applies to one numeric/duration metric over a configurable historical window.

No trend detection or cross-metric correlation is part of the baseline implementation.

### Supported Value Types

Only:
- numeric
- duration

Boolean/category requests are `ValidationError`.

Do not return silent zero/empty statistics.

### Data Source

Compute live from entries returned by:

`queryEnrichedMetricEntries`

for the resolved absolute window:

`now - windowDays` through `now`

Do not create a separate SQL aggregation path.

Do not reimplement raw-vs-reconciled precedence.

Do not create a table containing copied raw entries.

### Minimum Sample Size

Fewer than 10 entries means insufficient data.

Use an explicit discriminated union:

```ts
type BaselineResult =
  | {
      ok: true;
      metricType: string;
      windowDays: number;
      windowStart: string;
      windowEnd: string;
      sampleSize: number;
      mean: number;
      stddev: number;
      min: number;
      max: number;
      displayName: string;
      unit?: string;
    }
  | {
      ok: false;
      reason: 'insufficient_data';
      metricType: string;
      displayName: string;
      windowDays: number;
      sampleSize: number;
      minRequired: number;
    };
```

## `metric_baseline_configs`

Per-user/per-metric window override.

Columns:

| Column | Contract |
|---|---|
| `user_id` | FK to `users.id`, `ON DELETE CASCADE` |
| `metric_type` | string, no FK |
| `window_days` | integer, Zod-validated bounds such as 7–3650 |
| `created_at` / `updated_at` | timestamps |

Unique on:

`(user_id, metric_type)`

No row is valid and means "use the default."

Default window:

`90 days`

The same config is intentionally reused by trend detection.

The table name is now slightly misleading but is not being renamed yet because that would require a migration without enough immediate value.

No FK on `metric_type` means config can outlive a deleted custom metric without producing an integrity error.

## Baseline API

### `GET /api/metrics/:metricType/baseline`

Computes the baseline using:
- saved config window, if present
- otherwise 90 days

Optional:

`?windowDays=...`

overrides the window for this request only and does not persist.

### `GET /api/metrics/:metricType/baseline-config`

Returns:
- saved `window_days`, or
- `{ configured: false, default: 90 }`

### `PUT /api/metrics/:metricType/baseline-config`

Upserts:

```json
{ "windowDays": 123 }
```

Zod validated.

Rejects non-numeric/duration metric types as the baseline endpoint does.

## Baseline UI Copy — Approved

| UI element | Exact copy |
|---|---|
| Header nav button | `Personal Baselines` |
| Panel series action | `View Historical Baseline` |
| Modal title | `Personal Baseline: {displayName}` |
| Baseline summary | `Your baseline for {displayName}: {mean} ± {stddev} {unit}, based on your last {windowDays} days (n={sampleSize}).` |
| Range detail | `Observed range in this window: {min} – {max} {unit}` |
| Insufficient-data notice | `Insufficient data to calculate a baseline for {displayName}. Found {sampleSize} entries in the last {windowDays} days (minimum required: {minRequired}).` |
| Window field | `Historical Window (Days)` |
| Window helper | `Calculated over your trailing history up to right now.` |
| Save action | `Save Window` |

Forbidden evaluative/population language:
- normal
- healthy
- abnormal
- target
- goal
- good
- bad

Any future copy change must be checked against this list.

UI entry points:
- `Header.tsx` → global Personal Baselines action
- `MultiMetricPanel.tsx` → per-series View Historical Baseline action
- both open `BaselineModal.tsx`

## Trend Detection — Complete

Trend detection is a directional read for one numeric/duration metric:

- `increasing`
- `decreasing`
- `no_clear_trend`

It uses the same historical window configured for the Personal Baseline.

No new config table.

### Method

Ordinary least-squares linear regression of value against time.

Input entries come from:

`queryEnrichedMetricEntries`

for the resolved window.

No new SQL aggregation path.

### Daily Bucketing

Before regression:
1. group entries by UTC calendar day
2. compute one mean per day
3. use that daily mean as the regression point

The convention matches existing `daily_avg` behavior.

Regression x is:

`actual number of calendar days since window start`

not sequential rank.

Gap days therefore remain gaps and do not compress the time scale.

### Fit Quality Gate

Regression also produces Pearson correlation coefficient `r`.

This is a single-metric fit-quality measure.

It is not the future cross-metric correlation feature.

Only label direction when:

`|r| >= TREND_CORRELATION_THRESHOLD`

Default:

`TREND_CORRELATION_THRESHOLD = 0.3`

Otherwise return:

`no_clear_trend`

regardless of slope sign.

Purpose: avoid labeling noisy data as a trend simply because its fitted slope is positive or negative.

### Sample Size

Use:

`MIN_TREND_SAMPLE_SIZE = 10`

Count distinct daily-bucketed points.

Keep this as a separate named constant from `MIN_BASELINE_SAMPLE_SIZE`, even though both currently equal 10.

### Trend Result

```ts
type TrendResult =
  | {
      ok: true;
      metricType: string;
      displayName: string;
      unit?: string;
      windowDays: number;
      windowStart: string;
      windowEnd: string;
      sampleSize: number;
      direction:
        | 'increasing'
        | 'decreasing'
        | 'no_clear_trend';
      slopePerDay: number;
      correlationCoefficient: number;
    }
  | {
      ok: false;
      reason: 'insufficient_data';
      metricType: string;
      displayName: string;
      windowDays: number;
      sampleSize: number;
      minRequired: number;
    };
```

### Supported Value Types

Only numeric/duration.

Boolean/category requests are `ValidationError`.

### Trend API

`GET /api/metrics/:metricType/trend`

Window resolution:
- saved `metric_baseline_configs` value
- otherwise 90-day default

Optional:

`?windowDays=...`

uses the same shared `BaselineWindowSchema`, does not persist.

No separate trend config endpoints.

`PUT /api/metrics/:metricType/baseline-config` governs the window for both baseline and trend.

Any UI exposing this setting must make that dual use clear; changing it changes both features.

## Trend Framing — Implemented

The exact UI copy was reviewed against Architecture Principle 6 before shipping:

| UI element | Exact copy |
|---|---|
| Section header | `Directional Trend` |
| Increasing | `Trend: Increasing (+${slopePerDay} ${unit}/day over last ${windowDays} days, n=${sampleSize} days)` |
| Decreasing | `Trend: Decreasing (${slopePerDay} ${unit}/day over last ${windowDays} days, n=${sampleSize} days)` |
| No clear trend | `Trend: No clear trend over last ${windowDays} days (n=${sampleSize} days)` |
| Insufficient-data notice | `Insufficient data to determine a trend for ${displayName}. Found ${sampleSize} days with data in the last ${windowDays} days (minimum required: ${minRequired}).` |
| Window config helper | `Calculated over your trailing history up to right now. Governs both Personal Baseline and Directional Trend.` |

`slopePerDay` is prefixed with `+` only on the increasing branch. The decreasing branch uses the signed value directly, avoiding a doubled minus sign. No evaluative framing such as "improving", "worsening", "getting better", or "getting worse" is used.

### Rounding

`slopePerDay` and `correlationCoefficient` are rounded to 3 decimal places using `round3`, with `-0` mapped to `0`. This is intentionally distinct from baseline statistics, which use 2-decimal rounding; 3 decimals preserves useful precision for small daily rate changes such as `+0.025 kg/day`.

### `windowDays` on insufficient-data responses

Both `BaselineResult` and `TrendResult` include `windowDays` on their `ok: false` insufficient-data branches. This is covered by service-level and HTTP-level tests. Insufficient-data notices source the window from the API response rather than local UI input state, preventing an unsaved edit to the window field from desynchronizing the displayed message from the window actually used for the failed response.

## Later Phase 6 Slice — Cross-Metric Correlation

Not implemented yet.

It is separate from the Pearson `r` used internally for trend fit quality.

When implemented, preserve:
- descriptive/correlational framing
- no causal claims
- no prescriptive/diagnostic language
- explicit guardrails
- canonical reconciled-preferred read path
