import { NormalizedMetricEntry } from './baseAdapter';
import {
  WEBHOOK_SUPPORTED_METRICS,
  POLLING_ONLY_METRICS,
  METRICS_14_DAY,
  toKebabCase,
} from './googleHealthAdapter';

export const RESERVED_PROVIDERS = new Set([
  'google_health',
  'google-health',
  'manual',
  'apple_health',
  'apple-health',
  'fitbit',
  'oura',
  'whoop',
  'garmin',
]);

// Build a dynamically derived Set of all reserved metric keys from adapters and providers
const RESERVED_METRIC_SET: Set<string> = new Set();

// Populate from Google Health adapter constants
for (const metric of WEBHOOK_SUPPORTED_METRICS) {
  RESERVED_METRIC_SET.add(metric.toLowerCase());
  RESERVED_METRIC_SET.add(toKebabCase(metric).toLowerCase());
}

for (const metric of POLLING_ONLY_METRICS) {
  RESERVED_METRIC_SET.add(metric.toLowerCase());
  RESERVED_METRIC_SET.add(toKebabCase(metric).toLowerCase());
}

for (const metric of METRICS_14_DAY) {
  RESERVED_METRIC_SET.add(metric.toLowerCase());
  RESERVED_METRIC_SET.add(toKebabCase(metric).toLowerCase());
}

for (const provider of RESERVED_PROVIDERS) {
  RESERVED_METRIC_SET.add(provider.toLowerCase());
}

export function isReservedMetricType(metricType: string): boolean {
  const normalized = metricType.trim().toLowerCase();
  return RESERVED_METRIC_SET.has(normalized) || RESERVED_METRIC_SET.has(toKebabCase(normalized));
}

export interface ManualEntryMappingInput {
  userId: string;
  metricType: string;
  startTime: Date;
  endTime?: Date;
  valueNumeric?: number | null;
  valueText?: string | null;
  valueMin?: number | null;
  valueMax?: number | null;
  unit?: string | null;
  dimension?: string | null;
}

export function mapManualEntryToNormalized(input: ManualEntryMappingInput): NormalizedMetricEntry {
  const start = input.startTime;
  const end = input.endTime || input.startTime;

  return {
    userId: input.userId,
    provider: 'manual',
    metricType: toKebabCase(input.metricType),
    externalId: undefined, // manual entries do not have external upstream IDs
    startTime: start,
    endTime: end,
    valueNumeric: input.valueNumeric !== null && input.valueNumeric !== undefined ? Number(input.valueNumeric) : undefined,
    valueText: input.valueText ?? undefined,
    valueMin: input.valueMin !== null && input.valueMin !== undefined ? Number(input.valueMin) : undefined,
    valueMax: input.valueMax !== null && input.valueMax !== undefined ? Number(input.valueMax) : undefined,
    unit: input.unit || '',
    dimension: input.dimension || 'default',
    sourceStream: undefined as unknown as 'raw' | 'reconciled', // manual has sourceStream: null
    aggregation: 'raw',
    rawPayload: undefined,
  };
}
