import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExecutionService } from '../src/core/execution.service.js';
import { ExecutionContext } from '../src/core/execution.context.js';
import { GatewayService } from '../src/gateway/gateway.service.js';
import { PolicyService } from '../src/core/policy.service.js';
import { SDKGenerator } from '../src/sdk/sdk-generator.js';
import { createLogger } from '../src/core/logger.js';
import { ConfigService } from '../src/core/config.service.js';

describe('ExecutionService (Code Mode Lite)', () => {
    let executionService: ExecutionService;
    let gatewayService: any;
    let logger: any;
    let executorRegistry: any;

    beforeEach(() => {
        logger = createLogger(new ConfigService());

        gatewayService = {
            listToolPackages: vi.fn(),
            listToolStubs: vi.fn(),
            discoverTools: vi.fn(), // Should NOT be called
        } as any;

        const policyService = new PolicyService();

        const securityService = {
            validateCode: vi.fn().mockReturnValue({ valid: true }),
            createSession: vi.fn().mockReturnValue('token'),
            invalidateSession: vi.fn(),
        } as any;

        executorRegistry = {
            has: vi.fn().mockReturnValue(true),
            get: vi.fn().mockReturnValue({
                execute: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 })
            }),
            shutdownAll: vi.fn(),
        };

        executionService = new ExecutionService(
            logger,
            { maxMemoryMb: 128, timeoutMs: 1000 } as any,
            gatewayService,
            securityService,
            executorRegistry
        );
        executionService.ipcAddress = 'test-sock';
    });

    it('should use listToolPackages and listToolStubs instead of discoverTools for TypeScript execution', async () => {
        const context = new ExecutionContext({ logger });

        gatewayService.listToolPackages.mockResolvedValue([
            { id: 'pkg1' }
        ]);
        gatewayService.listToolStubs.mockResolvedValue([
            { id: 'pkg1__tool1', name: 'tool1', description: 'desc' }
        ]);

        await executionService.executeTypeScript('console.log("hi")', {}, context);

        expect(gatewayService.discoverTools).not.toHaveBeenCalled();
        expect(gatewayService.listToolPackages).toHaveBeenCalled();
        expect(gatewayService.listToolStubs).toHaveBeenCalledWith('pkg1', context);
    });

    it('should use listToolPackages and listToolStubs for Python execution', async () => {
        const context = new ExecutionContext({ logger });

        gatewayService.listToolPackages.mockResolvedValue([
            { id: 'pkg1' }
        ]);
        gatewayService.listToolStubs.mockResolvedValue([
            { id: 'pkg1__tool1', name: 'tool1' }
        ]);

        await executionService.executePython('print("hi")', {}, context);

        expect(gatewayService.discoverTools).not.toHaveBeenCalled();
        expect(gatewayService.listToolPackages).toHaveBeenCalled();
        expect(gatewayService.listToolStubs).toHaveBeenCalledWith('pkg1', context);
    });
});
