import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
    default: {
        lookup: vi.fn(async (hostname: string, options: any) => {
            if (options?.all) {
                if (hostname === 'api.example.com') {
                    return [{ address: '93.184.216.34', family: 4 }];
                }
                if (hostname === 'localhost' || hostname === '127.0.0.1') {
                    return [{ address: '127.0.0.1', family: 4 }];
                }
                throw new Error('ENOTFOUND');
            }
            // Legacy behavior for basic lookup (if needed)
            if (hostname === 'api.example.com') return { address: '93.184.216.34' };
            if (hostname === 'localhost' || hostname === '127.0.0.1') return { address: '127.0.0.1' };
            throw new Error('ENOTFOUND');
        })
    }
}));
import { RequestController } from '../src/core/request.controller.js';
import { GatewayService } from '../src/gateway/gateway.service.js';
import { SecurityService } from '../src/core/security.service.js';
import { SocketTransport } from '../src/transport/socket.transport.js';
import { ConcurrencyService } from '../src/core/concurrency.service.js';
import pino from 'pino';
import { ExecutionContext } from '../src/core/execution.context.js';

const logger = pino({ level: 'silent' });
const defaultLimits = {
    timeoutMs: 5000,
    memoryLimitMb: 128,
    maxOutputBytes: 1024 * 1024,
    maxLogEntries: 100,
};

describe('Security Validation', () => {
    let securityService: SecurityService;
    let gatewayService: GatewayService;
    let requestController: RequestController;
    const testToken = 'security-test-token';

    beforeAll(() => {
        securityService = new SecurityService(logger, testToken);
        gatewayService = new GatewayService(logger, securityService);
        requestController = new RequestController(logger, defaultLimits, gatewayService, securityService);
    });

    describe('Code Validation', () => {
        const forbiddenPatterns = [
            'process.exit()',
            'require("child_process")',
            'import("fs")',
            'fs.readFileSync("/etc/passwd")',
            'os.networkInterfaces()',
            'eval("2+2")',
            'new Function("return process")',
            'obj.__proto__',
            'obj.constructor'
        ];

        forbiddenPatterns.forEach(pattern => {
            it(`should block pattern: ${pattern}`, async () => {
                const context = new ExecutionContext({ logger });
                const response = await requestController.handleRequest({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'mcp.executeTypeScript',
                    params: { code: pattern },
                    auth: { bearerToken: testToken }
                }, context);

                expect(response.error).toBeDefined();
                expect(response.error?.code).toBe(-32003); // Forbidden
                expect(response.error?.message).toContain('Access denied');

                // Verify non-statefulness: calling it again should still block
                const response2 = await requestController.handleRequest({
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'mcp.executeTypeScript',
                    params: { code: pattern },
                    auth: { bearerToken: testToken }
                }, context);
                expect(response2.error).toBeDefined();
                expect(response2.error?.code).toBe(-32003);
            });
        });

        it('should allow benign code', async () => {
            const code = 'console.log("Hello World"); const x = 1 + 1;';
            const context = new ExecutionContext({ logger });
            const response = await requestController.handleRequest({
                jsonrpc: '2.0',
                id: 1,
                method: 'mcp.executeTypeScript',
                params: { code },
                auth: { bearerToken: testToken }
            }, context);

            expect(response.error).toBeUndefined();
        });
    });

    describe('SSRF Protection', () => {
        const forbiddenUrls = [
            'http://localhost:8080',
            'http://127.0.0.1:22',
            'http://192.168.1.1',
            'http://10.0.0.1',
            'http://172.16.0.1',
            'http://0.0.0.0',
        ];

        forbiddenUrls.forEach(url => {
            it(`should block private URL: ${url}`, async () => {
                gatewayService.registerUpstream({ id: 'bad', url });
                const context = new ExecutionContext({ logger });

                // Triggering a call that uses the upstream
                const response = await gatewayService.callTool('bad__anything', {}, context);

                expect(response.error).toBeDefined();
                expect(response.error?.message).toContain('Access denied: private network access forbidden');
            });
        });

        it('should allow public URLs', async () => {
            const url = 'https://api.example.com/mcp';
            const result = await securityService.validateUrl(url);
            expect(result.valid).toBe(true);
        });
    });

    describe('Rate Limiting', () => {
        it('should block requests after exceeding limit', () => {
            const key = 'test-client';
            for (let i = 0; i < 30; i++) {
                expect(securityService.checkRateLimit(key)).toBe(true);
            }
            expect(securityService.checkRateLimit(key)).toBe(false);
        });
    });

    describe('IPC Authentication', () => {
        it('should block requests with invalid bearer token', async () => {
            expect(securityService.validateIpcToken('wrong')).toBe(false);
            expect(securityService.validateIpcToken(testToken)).toBe(true);
        });
    });

    describe('Tool Allowlisting', () => {
        it('should block unauthorized tool calls', async () => {
            gatewayService.registerUpstream({ id: 'mock', url: 'https://api.example.com/mcp' });

            const context = new ExecutionContext({
                logger,
                allowedTools: ['mock__allowed_tool']
            });

            // Call to unauthorized tool should fail
            const response = await gatewayService.callTool('mock__secret_tool', {}, context);
            expect(response.error).toBeDefined();
            expect(response.error?.code).toBe(-32003);
            expect(response.error?.message).toContain('allowlist');
        });

        it('should enforce allowlist from execute request params', async () => {
            const context = new ExecutionContext({ logger });
            const params = {
                code: 'print("hello")',
                allowedTools: ['mock__allowed_tool']
            };

            await requestController.handleRequest({
                jsonrpc: '2.0',
                id: 'exec-1',
                method: 'mcp.executePython',
                params,
                auth: { bearerToken: testToken }
            }, context);

            expect(context.allowedTools).toEqual(['mock__allowed_tool']);
        });
    });
});
