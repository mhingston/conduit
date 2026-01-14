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
    scopes?: string[];
    tokenRequestFormat?: 'form' | 'json';
    tokenParams?: Record<string, string>;
}

interface CachedToken {
    accessToken: string;
    expiresAt: number;
}

export class AuthService {
    private logger: Logger;
    // Cache tokens separately from credentials to avoid mutation
    private tokenCache = new Map<string, CachedToken>();
    // Keep the latest refresh token in-memory (rotating tokens)
    private refreshTokenCache = new Map<string, string>();
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
        if (!creds.tokenUrl || !creds.refreshToken || !creds.clientId) {
            throw new Error('OAuth2 credentials missing required fields for refresh');
        }

        this.logger.info({ tokenUrl: creds.tokenUrl, clientId: creds.clientId }, 'Refreshing OAuth2 token');

        try {
            const tokenUrl = creds.tokenUrl;
            const cachedRefreshToken = this.refreshTokenCache.get(cacheKey);
            const refreshToken = cachedRefreshToken || creds.refreshToken;

            if (!refreshToken) {
                throw new Error('OAuth2 credentials missing required fields for refresh');
            }

            const payload: Record<string, string> = {
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: creds.clientId,
            };

            if (creds.clientSecret) {
                payload.client_secret = creds.clientSecret;
            }

            if (creds.tokenParams) {
                Object.assign(payload, creds.tokenParams);
            }

            const requestFormat = (() => {
                if (creds.tokenRequestFormat) return creds.tokenRequestFormat;
                try {
                    const hostname = new URL(tokenUrl).hostname;
                    if (hostname === 'auth.atlassian.com') return 'json';
                } catch {
                    // ignore
                }
                return 'form';
            })();

            const response = requestFormat === 'json'
                ? await axios.post(tokenUrl, payload, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                })
                : await axios.post(tokenUrl, new URLSearchParams(payload), {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json',
                    },
                });

            const { access_token, expires_in, refresh_token } = response.data;
            const expiresInRaw = Number(expires_in);
            const expiresInSeconds = Number.isFinite(expiresInRaw) ? expiresInRaw : 3600;

            // Cache the token (don't mutate the input credentials)
            this.tokenCache.set(cacheKey, {
                accessToken: access_token,
                expiresAt: Date.now() + (expiresInSeconds * 1000),
            });

            // Some providers (e.g. Atlassian) rotate refresh tokens
            if (typeof refresh_token === 'string' && refresh_token.length > 0) {
                this.refreshTokenCache.set(cacheKey, refresh_token);
            }

            return `Bearer ${access_token}`;
        } catch (err: any) {
            const errorMsg = err.response?.data?.error_description || err.response?.data?.error || err.message;
            this.logger.error({ err: errorMsg }, 'Failed to refresh OAuth2 token');
            throw new Error(`OAuth2 refresh failed: ${errorMsg}`);
        }
    }
}
