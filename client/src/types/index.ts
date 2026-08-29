export type MetricValueType = 'numeric' | 'duration' | 'boolean' | 'category';

export interface MetricDefinition {
  id: string;
  userId: string;
  metricType: string;
  displayName: string;
  valueType: MetricValueType;
  unit: string | null;
  categoryValues: string[] | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedMetricEntry {
  userId: string;
  provider: string;
  metricType: string;
  externalId?: string;
  startTime: string;
  endTime: string;
  valueNumeric?: number;
  valueText?: string;
  valueMin?: number;
  valueMax?: number;
  unit?: string | null;
  dimension?: string;
  sourceStream?: 'raw' | 'reconciled' | null;
  aggregation?: string;
  rawPayload?: Record<string, unknown>;
  deletedAt?: string | null;
}

export interface EnrichedMetricQueryResult {
  metricType: string;
  displayName: string;
  valueType: MetricValueType;
  unit: string | null;
  categoryValues: string[] | null;
  isCustom: boolean;
  isArchived: boolean;
  entries: NormalizedMetricEntry[];
}

export type TimeRange =
  | { type: 'relative'; value: 'last_24h' | 'last_7d' | 'last_30d' | 'last_90d' | 'last_1y' }
  | { type: 'absolute'; startTime: string; endTime: string };

export interface DashboardPanelConfig {
  id: string;
  metricTypes: string[];
  timeRange: TimeRange;
  aggregation: 'raw' | '1m_avg' | '5m_avg' | 'daily_avg' | 'weekly_avg';
  chartType?: 'line' | 'bar';
}

export interface DashboardViewConfig {
  panels: DashboardPanelConfig[];
}

export interface DashboardView {
  id: string;
  userId: string;
  name: string;
  config: DashboardViewConfig;
  createdAt: string;
  updatedAt: string;
}

export type BaselineResult =
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

export type TrendResult =
  | {
      ok: true;
      metricType: string;
      displayName: string;
      unit?: string;
      windowDays: number;
      windowStart: string;
      windowEnd: string;
      sampleSize: number;
      direction: 'increasing' | 'decreasing' | 'no_clear_trend';
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

export type BaselineConfigResult =
  | { configured: true; metricType: string; windowDays: number }
  | { configured: false; metricType: string; default: number };

export interface PairedDailyAveragePoint {
  day: string; // YYYY-MM-DD
  valueA: number;
  valueB: number;
}

export type CorrelationResult =
  | {
      ok: true;
      metricTypeA: string;
      metricTypeB: string;
      displayNameA: string;
      displayNameB: string;
      unitA?: string;
      unitB?: string;
      windowDays: number;
      windowStart: string;
      windowEnd: string;
      sampleSize: number;
      correlationCoefficient: number;
      hasClearCorrelation: boolean;
      pairedDailyAverages: PairedDailyAveragePoint[];
    }
  | {
      ok: false;
      reason: 'insufficient_data';
      metricTypeA: string;
      metricTypeB: string;
      displayNameA: string;
      displayNameB: string;
      windowDays: number;
      sampleSize: number;
      minRequired: number;
    };
