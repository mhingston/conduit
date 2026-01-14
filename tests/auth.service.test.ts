import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from '../src/gateway/auth.service.js';
import pino from 'pino';
import axios from 'axios';

vi.mock('axios');
const logger = pino({ level: 'silent' });

describe('AuthService', () => {
    let authService: AuthService;

    beforeEach(() => {
        authService = new AuthService(logger);
        vi.clearAllMocks();
    });

    it('should return API key header', async () => {
        const headers = await authService.getAuthHeaders({
            type: 'apiKey',
            apiKey: 'test-key',
        });
        expect(headers['X-API-Key']).toBe('test-key');
    });

    it('should refresh OAuth2 token when expired', async () => {
        const creds: any = {
            type: 'oauth2',
            clientId: 'id',
            clientSecret: 'secret',
            tokenUrl: 'http://token',
            refreshToken: 'refresh',
        };

        (axios.post as any).mockResolvedValue({
            data: {
                access_token: 'new-access',
                expires_in: 3600,
            },
        });

        const headers = await authService.getAuthHeaders(creds);
        expect(headers['Authorization']).toBe('Bearer new-access');
        expect(axios.post).toHaveBeenCalled();
    });

    it('should reuse OAuth2 token if not expired', async () => {
        // First call - will trigger refresh
        const creds: any = {
            type: 'oauth2',
            clientId: 'id',
            clientSecret: 'secret',
            tokenUrl: 'http://token',
            refreshToken: 'refresh',
        };

        (axios.post as any).mockResolvedValue({
            data: {
                access_token: 'cached-access',
                expires_in: 3600,
            },
        });

        // First call fetches the token
        const headers1 = await authService.getAuthHeaders(creds);
        expect(headers1['Authorization']).toBe('Bearer cached-access');
        expect(axios.post).toHaveBeenCalledTimes(1);

        // Second call should reuse cached token (no additional post)
        const headers2 = await authService.getAuthHeaders(creds);
        expect(headers2['Authorization']).toBe('Bearer cached-access');
        expect(axios.post).toHaveBeenCalledTimes(1); // Still 1, not 2
    });

    it('should send JSON token refresh for Atlassian token endpoint', async () => {
        const creds: any = {
            type: 'oauth2',
            clientId: 'id',
            clientSecret: 'secret',
            tokenUrl: 'https://auth.atlassian.com/oauth/token',
            refreshToken: 'refresh',
        };

        (axios.post as any).mockResolvedValue({
            data: {
                access_token: 'new-access',
                expires_in: 0,
            },
        });

        await authService.getAuthHeaders(creds);

        const [, body, config] = (axios.post as any).mock.calls[0];
        expect(body).toMatchObject({
            grant_type: 'refresh_token',
            refresh_token: 'refresh',
            client_id: 'id',
            client_secret: 'secret',
        });
        expect(config.headers['Content-Type']).toBe('application/json');
    });

    it('should include tokenParams and cache rotating refresh tokens', async () => {
        const creds: any = {
            type: 'oauth2',
            clientId: 'id',
            clientSecret: 'secret',
            tokenUrl: 'https://auth.atlassian.com/oauth/token',
            refreshToken: 'r1',
            tokenRequestFormat: 'json',
            tokenParams: { audience: 'api.atlassian.com' },
        };

        (axios.post as any)
            .mockResolvedValueOnce({
                data: { access_token: 'a1', expires_in: 0, refresh_token: 'r2' },
            })
            .mockResolvedValueOnce({
                data: { access_token: 'a2', expires_in: 0 },
            });

        await authService.getAuthHeaders(creds);
        await authService.getAuthHeaders(creds);

        const firstBody = (axios.post as any).mock.calls[0][1];
        expect(firstBody).toMatchObject({ refresh_token: 'r1', audience: 'api.atlassian.com' });

        const secondBody = (axios.post as any).mock.calls[1][1];
        expect(secondBody).toMatchObject({ refresh_token: 'r2', audience: 'api.atlassian.com' });
    });
});
