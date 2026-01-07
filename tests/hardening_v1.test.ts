import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import dns from 'node:dns/promises';
import { UpstreamClient } from '../src/gateway/upstream.client.js';
import { SecurityService } from '../src/core/security.service.js';
import { AuthService } from '../src/gateway/auth.service.js';
import { ExecutionContext } from '../src/core/execution.context.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

vi.mock('axios');
vi.mock('node:dns/promises');

describe('V1 Hardening', () => {
    let securityService: SecurityService;
    let upstreamClient: UpstreamClient;
    let authService: AuthService;

    beforeEach(() => {
        securityService = new SecurityService(logger, 'ipctoken');
        authService = new AuthService(logger);
        upstreamClient = new UpstreamClient(
            logger,
            { id: 'test', url: 'http://example.com/mcp' },
            authService,
            securityService
        );
        vi.clearAllMocks();
    });

    describe('SSRF Protection', () => {
        it('should disable redirects in axios config', async () => {
            // Mock security check to pass
            vi.spyOn(securityService, 'validateUrl').mockResolvedValue({ valid: true });
            (axios.post as any).mockResolvedValue({ data: { jsonrpc: '2.0', id: 1, result: {} } });

            await upstreamClient.call(
                { jsonrpc: '2.0', id: 1, method: 'tools/list' },
                new ExecutionContext({ logger })
            );

            expect(axios.post).toHaveBeenCalledWith(
                'http://example.com/mcp',
                expect.any(Object),
                expect.objectContaining({ maxRedirects: 0 })
            );
        });

        it('should check all resolved addresses for private IPs', async () => {
            // Mock dns.lookup to return a private IP in the list
            (dns.lookup as any).mockResolvedValue([
                { address: '1.1.1.1', family: 4 },
                { address: '127.0.0.1', family: 4 } // Private!
            ]);

            const result = await securityService.validateUrl('http://example.com');
            expect(result.valid).toBe(false);
            expect(result.message).toContain('resolves to private network');
            expect(dns.lookup).toHaveBeenCalledWith('example.com', { all: true });
        });

        it('should allow benign public IPs', async () => {
            (dns.lookup as any).mockResolvedValue([
                { address: '93.184.216.34', family: 4 }
            ]);

            const result = await securityService.validateUrl('http://example.com');
            expect(result.valid).toBe(true);
        });
    });
});
