export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  scopes: string[];
}

export interface SyncParams {
  userId: string;
  startDate: Date;
  endDate: Date;
  metricTypes?: string[];
}

export interface SyncResult {
  syncRunId: string;
  pointsFetched: number;
  pointsUpserted: number;
  status: 'completed' | 'failed';
  error?: string;
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
  sourceStream: 'raw' | 'reconciled';
  aggregation: string;
  rawPayload?: Record<string, unknown>;
}

export interface ProviderAdapter {
  providerName: string;
  getAuthUrl(signedState: string): string;
  authenticate(code: string, redirectUri?: string): Promise<OAuthTokens>;
  refreshToken(refreshToken: string): Promise<OAuthTokens>;
  sync(params: SyncParams): Promise<SyncResult>;
  mapToNormalizedSchema(rawPoint: Record<string, unknown>): NormalizedMetricEntry[];
}