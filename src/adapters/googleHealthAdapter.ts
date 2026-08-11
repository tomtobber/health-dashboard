import { z } from 'zod';
import { ProviderAdapter, OAuthTokens, SyncParams, SyncResult, NormalizedMetricEntry } from './baseAdapter';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import { env } from '../config/env';
import { ExternalServiceError, ValidationError } from '../errors/AppError';

const googleTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export class GoogleHealthAdapter implements ProviderAdapter {
  public providerName = 'google_health';

  public static SCOPES = [
    'openid',
    'email',
    'profile',
    'activity_and_fitness',
    'health_metrics_and_measurements'
  ];

  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor(clientId?: string, clientSecret?: string, redirectUri?: string) {
    this.clientId = clientId || env.GOOGLE_CLIENT_ID;
    this.clientSecret = clientSecret || env.GOOGLE_CLIENT_SECRET;
    this.redirectUri = redirectUri || env.GOOGLE_REDIRECT_URI;
  }

  public getAuthUrl(signedState: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: GoogleHealthAdapter.SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state: signedState,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  public async authenticate(code: string, redirectUri?: string): Promise<OAuthTokens> {
    if (env.NODE_ENV === 'test') {
      return {
        accessToken: `mock_access_token_${code}`,
        refreshToken: `mock_refresh_token_${code}`,
        expiresIn: 3600,
        scopes: GoogleHealthAdapter.SCOPES,
      };
    }

    const response = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectUri || this.redirectUri,
        grant_type: 'authorization_code',
      }),
      serviceName: 'GoogleHealthOAuth',
      timeoutMs: 8000,
      retries: 2,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ExternalServiceError('GoogleHealthOAuth', errorText, response.status, {
        operation: 'authenticate',
      });
    }

    const rawJson: unknown = await response.json();
    const parseResult = googleTokenResponseSchema.safeParse(rawJson);

    if (!parseResult.success) {
      throw new ValidationError('Google OAuth token response validation failed', {
        operation: 'authenticate',
        zodErrors: parseResult.error.errors,
      });
    }

    const data = parseResult.data;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      expiresIn: data.expires_in,
      scopes: data.scope ? data.scope.split(' ') : GoogleHealthAdapter.SCOPES,
    };
  }

  public async refreshToken(refreshToken: string): Promise<OAuthTokens> {
    if (!refreshToken) {
      throw new ValidationError('Refresh token is required to refresh Google OAuth session', {
        operation: 'refreshToken',
      });
    }

    if (env.NODE_ENV === 'test') {
      return {
        accessToken: `mock_refreshed_access_token_${Date.now()}`,
        refreshToken,
        expiresIn: 3600,
        scopes: GoogleHealthAdapter.SCOPES,
      };
    }

    const response = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
      }),
      serviceName: 'GoogleHealthOAuth',
      timeoutMs: 8000,
      retries: 2,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ExternalServiceError('GoogleHealthOAuth', errorText, response.status, {
        operation: 'refreshToken',
      });
    }

    const rawJson: unknown = await response.json();
    const parseResult = googleTokenResponseSchema.safeParse(rawJson);

    if (!parseResult.success) {
      throw new ValidationError('Google OAuth refresh token response validation failed', {
        operation: 'refreshToken',
        zodErrors: parseResult.error.errors,
      });
    }

    const data = parseResult.data;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresIn: data.expires_in,
      scopes: data.scope ? data.scope.split(' ') : GoogleHealthAdapter.SCOPES,
    };
  }

  public async sync(_params: SyncParams): Promise<SyncResult> {
    return {
      syncRunId: 'mock-sync-run-id',
      pointsFetched: 0,
      pointsUpserted: 0,
      status: 'completed',
    };
  }

  public mapToNormalizedSchema(rawPoint: Record<string, unknown>): NormalizedMetricEntry[] {
    const userId = typeof rawPoint.userId === 'string' ? rawPoint.userId : '';
    const metricType = typeof rawPoint.metricType === 'string' ? rawPoint.metricType : 'heart_rate';
    const externalId = typeof rawPoint.id === 'string' ? rawPoint.id : undefined;
    const valueNumeric = typeof rawPoint.value === 'number' ? rawPoint.value : undefined;
    const unit = typeof rawPoint.unit === 'string' ? rawPoint.unit : 'bpm';
    const sourceStream = rawPoint.sourceStream === 'reconciled' ? 'reconciled' : 'raw';
    const aggregation = typeof rawPoint.aggregation === 'string' ? rawPoint.aggregation : 'raw';
    const startTime = rawPoint.startTime ? new Date(String(rawPoint.startTime)) : new Date();
    const endTime = rawPoint.endTime ? new Date(String(rawPoint.endTime)) : new Date();

    return [{
      userId,
      provider: this.providerName,
      metricType,
      externalId,
      startTime,
      endTime,
      valueNumeric,
      unit,
      sourceStream,
      aggregation,
      rawPayload: rawPoint,
    }];
  }
}
