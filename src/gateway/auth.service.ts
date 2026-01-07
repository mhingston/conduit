import { Logger } from 'pino';
import axios from 'axios';

export type AuthType = 'apiKey' | 'oauth2' | 'bearer';

export interface UpstreamCredentials {
    type: AuthType;
    apiKey?: string;
    bearerToken?: string;
    oauth2?: {
        clientId: string;
        clientSecret: string;
        tokenUrl: string;
        refreshToken: string;
        accessToken?: string;
        expiresAt?: number;
    };
}

export class AuthService {
    private logger: Logger;

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
        if (!creds.oauth2) throw new Error('OAuth2 credentials missing');

        const { oauth2 } = creds;

        // Check if token is still valid (with 30s buffer)
        if (oauth2.accessToken && oauth2.expiresAt && oauth2.expiresAt > Date.now() + 30000) {
            return `Bearer ${oauth2.accessToken}`;
        }

        this.logger.info('Refreshing OAuth2 token');

        try {
            const response = await axios.post(oauth2.tokenUrl, {
                grant_type: 'refresh_token',
                refresh_token: oauth2.refreshToken,
                client_id: oauth2.clientId,
                client_secret: oauth2.clientSecret,
            });

            const { access_token, expires_in } = response.data;

            oauth2.accessToken = access_token;
            oauth2.expiresAt = Date.now() + (expires_in * 1000);

            return `Bearer ${access_token}`;
        } catch (err: any) {
            this.logger.error({ err: err.message }, 'Failed to refresh OAuth2 token');
            throw new Error(`OAuth2 refresh failed: ${err.message}`);
        }
    }
}
