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
            oauth2: {
                clientId: 'id',
                clientSecret: 'secret',
                tokenUrl: 'http://token',
                refreshToken: 'refresh',
                expiresAt: Date.now() - 1000, // Expired
            },
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
        const creds: any = {
            type: 'oauth2',
            oauth2: {
                clientId: 'id',
                clientSecret: 'secret',
                tokenUrl: 'http://token',
                refreshToken: 'refresh',
                accessToken: 'cached-access',
                expiresAt: Date.now() + 100000, // Valid
            },
        };

        const headers = await authService.getAuthHeaders(creds);
        expect(headers['Authorization']).toBe('Bearer cached-access');
        expect(axios.post).not.toHaveBeenCalled();
    });
});
