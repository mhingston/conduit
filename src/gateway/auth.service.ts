import { Logger } from 'pino';
import axios from 'axios';

export type AuthType = 'apiKey' | 'oauth2' | 'bearer';

export interface UpstreamCredentials {
    type: AuthType;
    apiKey?: string;
    bearerToken?: string;
    clientId?: string;
    clientSecret?: string;
    tokenUrl?: string;
    refreshToken?: string;
}

interface CachedToken {
    accessToken: string;
    expiresAt: number;
}

export class AuthService {
    private logger: Logger;
    // Cache tokens separately from credentials to avoid mutation
    private tokenCache = new Map<string, CachedToken>();
    // Prevent concurrent refresh requests for the same client
    private refreshLocks = new Map<string, Promise<string>>();

    constructor(logger: Logger) {
        this.logger = logger;
    }

    async getAuthHeaders(creds: UpstreamCredentials): Promise<Record<string, string>> {
        switch (creds.type) {
            case 'apiKey':
                return { 'X-API-Key': creds.apiKey || '' };
            case 'bearer':
                return { 'Authorization': `Bearer ${creds.bearerToken}` };
            case 'oauth2':
                return { 'Authorization': await this.getOAuth2Token(creds) };
            default:
                throw new Error(`Unsupported auth type: ${creds.type}`);
        }
    }

    private async getOAuth2Token(creds: UpstreamCredentials): Promise<string> {
        if (!creds.tokenUrl || !creds.clientId) {
            throw new Error('OAuth2 credentials missing required fields (tokenUrl, clientId)');
        }

        const cacheKey = `${creds.clientId}:${creds.tokenUrl}`;

        // Check cache first (with 30s buffer)
        const cached = this.tokenCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now() + 30000) {
            return `Bearer ${cached.accessToken}`;
        }

        // Check if refresh is already in progress
        const existingRefresh = this.refreshLocks.get(cacheKey);
        if (existingRefresh) {
            return existingRefresh;
        }

        // Start refresh with lock
        const refreshPromise = this.doRefresh(creds, cacheKey);
        this.refreshLocks.set(cacheKey, refreshPromise);

        try {
            return await refreshPromise;
        } finally {
            this.refreshLocks.delete(cacheKey);
        }
    }

    private async doRefresh(creds: UpstreamCredentials, cacheKey: string): Promise<string> {
        if (!creds.tokenUrl || !creds.refreshToken || !creds.clientId || !creds.clientSecret) {
            throw new Error('OAuth2 credentials missing required fields for refresh');
        }

        this.logger.info({ tokenUrl: creds.tokenUrl, clientId: creds.clientId }, 'Refreshing OAuth2 token');

        try {
            const response = await axios.post(creds.tokenUrl, {
                grant_type: 'refresh_token',
                refresh_token: creds.refreshToken,
                client_id: creds.clientId,
                client_secret: creds.clientSecret,
            });

            const { access_token, expires_in } = response.data;

            // Cache the token (don't mutate the input credentials)
            this.tokenCache.set(cacheKey, {
                accessToken: access_token,
                expiresAt: Date.now() + (expires_in * 1000),
            });

            return `Bearer ${access_token}`;
        } catch (err: any) {
            const errorMsg = err.response?.data?.error_description || err.response?.data?.error || err.message;
            this.logger.error({ err: errorMsg }, 'Failed to refresh OAuth2 token');
            throw new Error(`OAuth2 refresh failed: ${errorMsg}`);
        }
    }
}
