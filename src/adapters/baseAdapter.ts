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
  unit: string;
  dimension?: string;
  sourceStream: 'raw' | 'reconciled';
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
