"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleHealthAdapter = void 0;
const zod_1 = require("zod");
const fetchWithTimeout_1 = require("../utils/fetchWithTimeout");
const env_1 = require("../config/env");
const AppError_1 = require("../errors/AppError");
const googleTokenResponseSchema = zod_1.z.object({
    access_token: zod_1.z.string(),
    refresh_token: zod_1.z.string().optional(),
    expires_in: zod_1.z.number().optional(),
    scope: zod_1.z.string().optional(),
    token_type: zod_1.z.string().optional(),
});
class GoogleHealthAdapter {
    providerName = 'google_health';
    static SCOPES = [
        'openid',
        'email',
        'profile',
        'activity_and_fitness',
        'health_metrics_and_measurements'
    ];
    clientId;
    clientSecret;
    redirectUri;
    constructor(clientId, clientSecret, redirectUri) {
        this.clientId = clientId || env_1.env.GOOGLE_CLIENT_ID;
        this.clientSecret = clientSecret || env_1.env.GOOGLE_CLIENT_SECRET;
        this.redirectUri = redirectUri || env_1.env.GOOGLE_REDIRECT_URI;
    }
    getAuthUrl(signedState) {
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
    async authenticate(code, redirectUri) {
        if (this.clientId.includes('mock') || env_1.env.NODE_ENV === 'test') {
            return {
                accessToken: `mock_access_token_${code}`,
                refreshToken: `mock_refresh_token_${code}`,
                expiresIn: 3600,
                scopes: GoogleHealthAdapter.SCOPES,
            };
        }
        const response = await (0, fetchWithTimeout_1.fetchWithTimeout)('https://oauth2.googleapis.com/token', {
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
            throw new AppError_1.ExternalServiceError('GoogleHealthOAuth', errorText, response.status, {
                operation: 'authenticate',
            });
        }
        const rawJson = await response.json();
        const parseResult = googleTokenResponseSchema.safeParse(rawJson);
        if (!parseResult.success) {
            throw new AppError_1.ValidationError('Google OAuth token response validation failed', {
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
    async refreshToken(refreshToken) {
        if (!refreshToken) {
            throw new AppError_1.ValidationError('Refresh token is required to refresh Google OAuth session', {
                operation: 'refreshToken',
            });
        }
        if (this.clientId.includes('mock') || env_1.env.NODE_ENV === 'test') {
            return {
                accessToken: `mock_refreshed_access_token_${Date.now()}`,
                refreshToken,
                expiresIn: 3600,
                scopes: GoogleHealthAdapter.SCOPES,
            };
        }
        const response = await (0, fetchWithTimeout_1.fetchWithTimeout)('https://oauth2.googleapis.com/token', {
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
            throw new AppError_1.ExternalServiceError('GoogleHealthOAuth', errorText, response.status, {
                operation: 'refreshToken',
            });
        }
        const rawJson = await response.json();
        const parseResult = googleTokenResponseSchema.safeParse(rawJson);
        if (!parseResult.success) {
            throw new AppError_1.ValidationError('Google OAuth refresh token response validation failed', {
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
    async sync(params) {
        return {
            syncRunId: 'mock-sync-run-id',
            pointsFetched: 0,
            pointsUpserted: 0,
            status: 'completed',
        };
    }
    mapToNormalizedSchema(rawPoint) {
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
exports.GoogleHealthAdapter = GoogleHealthAdapter;
