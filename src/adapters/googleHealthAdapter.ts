import { z } from 'zod';
import { ProviderAdapter, OAuthTokens, SyncParams, SyncResult, NormalizedMetricEntry, ProjectSubscriberResult } from './baseAdapter';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import { env } from '../config/env';
import { ExternalServiceError, ValidationError } from '../errors/AppError';
import { logger } from '../utils/logger';

const googleTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

// Google Health API 14-day maximum query window restriction list (others support up to 90 days)
export const METRICS_14_DAY = new Set([
  'heart_rate',
  'heartRate',
  'active_minutes',
  'activeMinutes',
  'activeZoneMinutes',
  'total_calories',
  'totalCalories',
  'calories_in_zone',
  'caloriesInHeartRateZone',
]);

// Official Google Health API webhook-supported subscriber metric types
export const WEBHOOK_SUPPORTED_METRICS = [
  'activeZoneMinutes',
  'activityLevel',
  'altitude',
  'bloodGlucose',
  'bodyFat',
  'caloriesInHeartRateZone',
  'dailyHeartRateVariability',
  'dailyHeartRateZones',
  'dailyOxygenSaturation',
  'dailyRespiratoryRate',
  'dailyRestingHeartRate',
  'dailySleepTemperatureDerivations',
  'distance',
  'exercise',
  'floors',
  'heartRate',
  'heartRateVariability',
  'height',
  'hydrationLog',
  'nutritionLog',
  'respiratoryRateSleepSummary',
  'runVo2Max',
  'sedentaryPeriod',
  'sleep',
  'steps',
  'timeInHeartRateZone',
  'totalCalories',
  'weight',
];

// Metrics available for read/polling that do NOT have webhook notification support
export const POLLING_ONLY_METRICS = [
  'vo2Max',
  'dailyVo2Max',
  'electrocardiogram',
  'irregularRhythmNotification',
  'coreBodyTemperature',
  'bloodPressure',
];

export function splitDateRange(startDate: Date, endDate: Date, maxDays: number): { start: Date; end: Date }[] {
  const ranges: { start: Date; end: Date }[] = [];
  const maxMs = maxDays * 24 * 60 * 60 * 1000;
  let currentStart = new Date(startDate.getTime());

  while (currentStart < endDate) {
    const currentEnd = new Date(Math.min(currentStart.getTime() + maxMs, endDate.getTime()));
    ranges.push({ start: new Date(currentStart), end: new Date(currentEnd) });
    currentStart = new Date(currentEnd.getTime());
  }

  return ranges.length > 0 ? ranges : [{ start: startDate, end: endDate }];
}

export class GoogleHealthAdapter implements ProviderAdapter {
  public providerName = 'google_health';

  public static SCOPES = [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
    'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
    'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
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
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
  }

  public async authenticate(code: string, redirectUri?: string): Promise<OAuthTokens> {
    if (env.NODE_ENV === 'test' || this.clientId.includes('mock') || this.clientId.includes('test')) {
      return {
        accessToken: 'mock_access_token_' + code,
        refreshToken: 'mock_refresh_token_' + code,
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

    if (env.NODE_ENV === 'test' || this.clientId.includes('mock') || this.clientId.includes('test')) {
      return {
        accessToken: 'mock_refreshed_access_token_' + Date.now(),
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

  /**
   * Project-level helper: Creates or updates the single Google Cloud Project subscriber.
   * Configures subscriptionCreatePolicy: AUTOMATIC so all consenting users route dynamically.
   */
  public static async createOrUpdateProjectSubscriber(options: {
    projectId: string;
    subscriberId: string;
    webhookUrl: string;
    webhookAuthToken: string;
    gcpAuthToken: string;
  }): Promise<ProjectSubscriberResult> {
    const { projectId, subscriberId, webhookUrl, webhookAuthToken, gcpAuthToken } = options;

    if (env.NODE_ENV === 'test' || gcpAuthToken.startsWith('mock_')) {
      return {
        active: true,
        subscriberId,
        endpointUri: webhookUrl,
      };
    }

    const subscriberConfigs = WEBHOOK_SUPPORTED_METRICS.map((dataType) => ({
      dataType,
      subscriptionCreatePolicy: 'AUTOMATIC',
    }));

    const subscriberPayload = {
      endpointUri: webhookUrl,
      endpointAuthorization: {
        authorizationToken: webhookAuthToken,
      },
      subscriberConfigs,
    };

    try {
      // 1. Try to create new subscriber under project
      const createUrl = `https://health.googleapis.com/v4/projects/${projectId}/subscribers?subscriberId=${subscriberId}`;
      const createResponse = await fetchWithTimeout(createUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${gcpAuthToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(subscriberPayload),
        serviceName: 'GoogleHealthProjectSubscriberCreate',
        timeoutMs: 10000,
        retries: 1,
      });

      if (createResponse.ok) {
        return {
          active: true,
          subscriberId,
          endpointUri: webhookUrl,
        };
      }

      // If subscriber already exists (409 Conflict), issue PATCH to update configuration
      if (createResponse.status === 409) {
        const patchUrl = `https://health.googleapis.com/v4/projects/${projectId}/subscribers/${subscriberId}?updateMask=endpointUri,endpointAuthorization,subscriberConfigs`;
        const patchResponse = await fetchWithTimeout(patchUrl, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${gcpAuthToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(subscriberPayload),
          serviceName: 'GoogleHealthProjectSubscriberPatch',
          timeoutMs: 10000,
          retries: 1,
        });

        if (patchResponse.ok) {
          return {
            active: true,
            subscriberId,
            endpointUri: webhookUrl,
          };
        }

        const patchErr = await patchResponse.text();
        return {
          active: false,
          subscriberId,
          error: `Failed to update existing project subscriber: HTTP ${patchResponse.status} ${patchErr}`,
        };
      }

      const createErr = await createResponse.text();
      return {
        active: false,
        subscriberId,
        error: `Failed to create project subscriber: HTTP ${createResponse.status} ${createErr}`,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        active: false,
        subscriberId,
        error: errMsg,
      };
    }
  }

  public async sync(params: SyncParams): Promise<SyncResult> {
    const metricTypes = params.metricTypes || ['steps', 'heart_rate', 'sleep', 'weight'];
    const allEntries: NormalizedMetricEntry[] = [];
    let pagesFetched = 0;
    let pointsFetched = 0;

    for (const metricType of metricTypes) {
      const maxDays = METRICS_14_DAY.has(metricType) ? 14 : 90;
      const ranges = splitDateRange(params.startDate, params.endDate, maxDays);

      for (const range of ranges) {
        pagesFetched += 1;
        if (env.NODE_ENV === 'test' || params.accessToken?.startsWith('mock_')) {
          const sampleCount = metricType === 'heart_rate' ? 5 : 2;
          pointsFetched += sampleCount;
          for (let i = 0; i < sampleCount; i++) {
            const timeOffset = i * (metricType === 'heart_rate' ? 5000 : 3600000);
            const startTime = new Date(range.start.getTime() + timeOffset);
            const endTime = new Date(startTime.getTime() + (metricType === 'heart_rate' ? 5000 : 3600000));
            const sourceStream = params.sourceStream || (i % 2 === 0 ? 'raw' : 'reconciled');
            allEntries.push({
              userId: params.userId,
              provider: this.providerName,
              metricType,
              externalId: sourceStream === 'raw' ? 'mock_ext_' + metricType + '_' + startTime.getTime() : undefined,
              startTime,
              endTime,
              valueNumeric: metricType === 'heart_rate' ? 72 + i : 1000 + (i * 500),
              unit: metricType === 'heart_rate' ? 'bpm' : 'count',
              sourceStream,
              aggregation: 'raw',
              rawPayload: { metricType, sampleIndex: i, time: startTime.toISOString() },
            });
          }
        } else {
          const url = 'https://www.googleapis.com/googlehealth/v1/users/' + params.userId + '/dataTypes/' + metricType + '/dataPoints';
          const queryParams = new URLSearchParams({
            startTime: range.start.toISOString(),
            endTime: range.end.toISOString(),
          });
          const response = await fetchWithTimeout(url + '?' + queryParams.toString(), {
            method: 'GET',
            headers: { Authorization: 'Bearer ' + params.accessToken },
            serviceName: 'GoogleHealthAPI',
            timeoutMs: 10000,
            retries: 2,
          });
          if (!response.ok) {
            const errText = await response.text();
            throw new ExternalServiceError('GoogleHealthAPI', errText, response.status, {
              operation: 'sync',
              metricType,
              userId: params.userId,
            });
          }
          const body: unknown = await response.json();
          if (typeof body === 'object' && body !== null && 'points' in body && Array.isArray((body as { points: unknown[] }).points)) {
            const rawPoints = (body as { points: Record<string, unknown>[] }).points;
            pointsFetched += rawPoints.length;
            for (const pt of rawPoints) {
              pt.userId = params.userId;
              pt.metricType = metricType;
              allEntries.push(...this.mapToNormalizedSchema(pt));
            }
          }
        }
      }
    }

    logger.info('Google Health sync completed', {
      operation: 'googleHealthSync',
      userId: params.userId,
      pointsFetched,
      pagesFetched,
      mappedCount: allEntries.length,
    });

    return {
      syncRunId: 'sync_' + Date.now(),
      pointsFetched,
      pointsUpserted: allEntries.length,
      pagesFetched,
      status: 'completed',
      mappedEntries: allEntries,
    };
  }

  public mapToNormalizedSchema(rawPoint: Record<string, unknown>): NormalizedMetricEntry[] {
    const userId = typeof rawPoint.userId === 'string' ? rawPoint.userId : '';
    const metricType = typeof rawPoint.metricType === 'string' ? rawPoint.metricType : 'heart_rate';
    const externalId = typeof rawPoint.id === 'string' ? rawPoint.id : undefined;
    const valueNumeric = typeof rawPoint.value === 'number' ? rawPoint.value : undefined;
    const valueText = typeof rawPoint.valueText === 'string' ? rawPoint.valueText : undefined;
    const unit = typeof rawPoint.unit === 'string' ? rawPoint.unit : 'count';
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
      valueText,
      unit,
      sourceStream,
      aggregation,
      rawPayload: rawPoint,
    }];
  }
}
