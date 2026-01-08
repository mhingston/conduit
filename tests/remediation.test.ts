import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NetworkPolicyService } from '../src/core/network.policy.service.js';
import { SecurityService } from '../src/core/security.service.js';
import { ExecutionService } from '../src/core/execution.service.js';
import { ExecutorRegistry } from '../src/core/registries/executor.registry.js';
import { pino } from 'pino';
import dns from 'node:dns/promises';
import net from 'node:net';

const logger = pino({ level: 'silent' });

describe('Remediation Tests', () => {
    describe('NetworkPolicyService (SSRF & IPv6-mapped IPv4)', () => {
        let policy: NetworkPolicyService;

        beforeEach(() => {
            policy = new NetworkPolicyService(logger);
        });

        it('should block IPv6-mapped IPv4 private addresses (::ffff:127.0.0.1)', async () => {
            // Mock dns.lookup to return an IPv6-mapped IPv4 address
            vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }] as any);

            const result = await policy.validateUrl('http://malicious.com');

            expect(result.valid).toBe(false);
            expect(result.message).toContain('resolves to private network');
            vi.restoreAllMocks();
        });

        it('should return resolvedIp for DNS rebinding protection', async () => {
            vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);

            const result = await policy.validateUrl('http://example.com');

            expect(result.valid).toBe(true);
            expect(result.resolvedIp).toBe('93.184.216.34');
            vi.restoreAllMocks();
        });
    });

    describe('SecurityService (Timing Attacks)', () => {
        let security: SecurityService;
        const secretToken = 'very-secret-token-123';

        beforeEach(() => {
            security = new SecurityService(logger, secretToken);
        });

        it('should validate valid token', () => {
            expect(security.validateIpcToken(secretToken)).toBe(true);
        });

        it('should reject invalid token', () => {
            expect(security.validateIpcToken('wrong-token')).toBe(false);
        });

        it('should reject token with correct prefix but different length', () => {
            expect(security.validateIpcToken(secretToken + 'extra')).toBe(false);
        });
    });

    describe('ExecutionService (Routing & Guards)', () => {
        let executionService: ExecutionService;
        let mockDeno: any;
        let mockIsolate: any;

        beforeEach(() => {
            const registry = new ExecutorRegistry();
            mockDeno = { execute: vi.fn().mockResolvedValue({ stdout: 'deno' }) };
            mockIsolate = { execute: vi.fn().mockResolvedValue({ stdout: 'isolate' }) };
            registry.register('deno', mockDeno);
            registry.register('isolate', mockIsolate);

            executionService = new ExecutionService(
                logger,
                {} as any,
                {
                    discoverTools: vi.fn().mockResolvedValue([]),
                    listToolPackages: vi.fn().mockResolvedValue([]),
                    listToolStubs: vi.fn().mockResolvedValue([]),
                } as any,
                new SecurityService(logger, 'test'),
                registry
            );
        });

        it('should fail if ipcAddress is not set and Deno is needed', async () => {
            const result = await executionService.executeTypeScript('import "os"', {} as any, {} as any);
            expect(result.error).toBeDefined();
            expect(result.error?.message).toContain('IPC address not initialized');
        });

        it('should route simple code to Isolate even if ipcAddress is missing', async () => {
            const result = await executionService.executeTypeScript('console.log(1)', {} as any, {} as any);
            expect(mockIsolate.execute).toHaveBeenCalled();
            expect(result.stdout).toBe('isolate');
        });

        it('should route code with "import" to Deno', async () => {
            executionService.ipcAddress = '127.0.0.1:1234';
            await executionService.executeTypeScript('import { x } from "y"', {} as any, {} as any);
            expect(mockDeno.execute).toHaveBeenCalled();
        });

        it('should route code with "Deno" to Deno', async () => {
            executionService.ipcAddress = '127.0.0.1:1234';
            await executionService.executeTypeScript('console.log(Deno.version)', {} as any, {} as any);
            expect(mockDeno.execute).toHaveBeenCalled();
        });

        it('should NOT be fooled by "import" in string literals', async () => {
            executionService.ipcAddress = '127.0.0.1:1234';
            await executionService.executeTypeScript('const x = "import this"', {} as any, {} as any);
            expect(mockDeno.execute).toHaveBeenCalled();
        });
    });
});
