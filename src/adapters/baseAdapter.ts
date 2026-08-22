export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  scopes: string[];
  healthUserId?: string;
}

export interface SyncParams {
  userId: string;
  startDate: Date;
  endDate: Date;
  metricTypes?: string[];
  accessToken?: string;
  trigger?: 'webhook' | 'reconciliation' | 'polling' | 'backfill';
  sourceStream?: 'raw' | 'reconciled';
}

export interface SkippedMetricInfo {
  metricType: string;
  status: number;
  reason: string;
}

export interface SyncResult {
  syncRunId: string;
  pointsFetched: number;
  pointsUpserted: number;
  pagesFetched?: number;
  status: 'completed' | 'failed';
  error?: string;
  mappedEntries?: NormalizedMetricEntry[];
  skippedMetrics?: SkippedMetricInfo[];
}

export interface NormalizedMetricEntry {
  userId: string;
  provider: string;
  metricType: string;
  externalId?: string;
  startTime: Date;
  endTime: Date;
  valueNumeric?: number;
  valueText?: string;
  valueMin?: number;
  valueMax?: number;
  unit?: string | null;
  dimension?: string;
  sourceStream?: 'raw' | 'reconciled' | null;
  aggregation: string;
  rawPayload?: Record<string, unknown>;
}

export interface ProjectSubscriberResult {
  active: boolean;
  subscriberId: string;
  endpointUri?: string;
  error?: string;
}

export interface ProviderAdapter {
  providerName: string;
  getAuthUrl(signedState: string): string;
  authenticate(code: string, redirectUri?: string): Promise<OAuthTokens>;
  refreshToken(refreshToken: string): Promise<OAuthTokens>;
  sync(params: SyncParams): Promise<SyncResult>;
  mapToNormalizedSchema(rawPoint: Record<string, unknown>): NormalizedMetricEntry[];
}

export interface CanonicalMetricMetadata {
  displayName: string;
  valueType: 'numeric' | 'duration' | 'boolean' | 'category';
  unit: string | null;
  categoryValues?: string[] | null;
}

export const CANONICAL_PROVIDER_METRICS: Record<string, CanonicalMetricMetadata> = {
  'steps': { displayName: 'Steps', valueType: 'numeric', unit: 'count' },
  'heart-rate': { displayName: 'Heart Rate', valueType: 'numeric', unit: 'bpm' },
  'heart_rate': { displayName: 'Heart Rate', valueType: 'numeric', unit: 'bpm' },
  'sleep': { displayName: 'Sleep', valueType: 'duration', unit: 'seconds' },
  'active-zone-minutes': { displayName: 'Active Zone Minutes', valueType: 'numeric', unit: 'minutes' },
  'distance': { displayName: 'Distance', valueType: 'numeric', unit: 'meters' },
  'weight': { displayName: 'Weight', valueType: 'numeric', unit: 'kg' },
  'blood-pressure': { displayName: 'Blood Pressure', valueType: 'numeric', unit: 'mmHg' },
  'blood-glucose': { displayName: 'Blood Glucose', valueType: 'numeric', unit: 'mg/dL' },
  'hydration-log': { displayName: 'Hydration', valueType: 'numeric', unit: 'ml' },
  'nutrition-log': { displayName: 'Nutrition', valueType: 'numeric', unit: 'kcal' },
  'total-calories': { displayName: 'Total Calories', valueType: 'numeric', unit: 'kcal' },
  'body-fat': { displayName: 'Body Fat Percentage', valueType: 'numeric', unit: '%' },
  'activity-level': {
    displayName: 'Activity Level',
    valueType: 'category',
    unit: null,
    categoryValues: ['sedentary', 'lightly-active', 'moderately-active', 'very-active'],
  },
  'exercise': { displayName: 'Exercise', valueType: 'duration', unit: 'seconds' },
  'height': { displayName: 'Height', valueType: 'numeric', unit: 'cm' },
  'run-vo2-max': { displayName: 'VO2 Max', valueType: 'numeric', unit: 'mL/kg/min' },
};

export function getCanonicalProviderMetricMetadata(metricType: string): CanonicalMetricMetadata {
  const normalized = metricType.trim().toLowerCase();
  if (CANONICAL_PROVIDER_METRICS[normalized]) {
    return CANONICAL_PROVIDER_METRICS[normalized];
  }

  // Fallback: title-case the kebab-case / snake_case metricType
  const displayName = normalized
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return {
    displayName: displayName || metricType,
    valueType: 'numeric',
    unit: null,
    categoryValues: null,
  };
}
