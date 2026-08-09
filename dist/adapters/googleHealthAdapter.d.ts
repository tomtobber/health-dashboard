import { ProviderAdapter, OAuthTokens, SyncParams, SyncResult, NormalizedMetricEntry } from './baseAdapter';
export declare class GoogleHealthAdapter implements ProviderAdapter {
    providerName: string;
    static SCOPES: string[];
    private clientId;
    private clientSecret;
    private redirectUri;
    constructor(clientId?: string, clientSecret?: string, redirectUri?: string);
    getAuthUrl(signedState: string): string;
    authenticate(code: string, redirectUri?: string): Promise<OAuthTokens>;
    refreshToken(refreshToken: string): Promise<OAuthTokens>;
    sync(params: SyncParams): Promise<SyncResult>;
    mapToNormalizedSchema(rawPoint: Record<string, unknown>): NormalizedMetricEntry[];
}
