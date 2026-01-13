import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayService } from '../src/gateway/gateway.service.js';
import { ExecutionContext } from '../src/core/execution.context.js';
import { createLogger } from '../src/core/logger.js';
import { ConfigService } from '../src/core/config.service.js';
import { PolicyService } from '../src/core/policy.service.js';

describe('GatewayService (Manifests)', () => {
    let gateway: GatewayService;
    let logger: any;
    let mockClient: any;

    beforeEach(() => {
        logger = createLogger(new ConfigService());
        gateway = new GatewayService(logger, { validateUrl: vi.fn().mockResolvedValue({ valid: true }) } as any, new PolicyService());

        // Mock the clients map directly since it's private but we need to inject a specific client
        mockClient = {
            call: vi.fn(),
            getManifest: vi.fn(),
        };
        (gateway as any).clients.set('test-upstream', mockClient);
    });

    it('should use manifest if available', async () => {
        const context = new ExecutionContext({ logger });

        mockClient.getManifest.mockResolvedValue({
            version: '1.0.0',
            tools: [
                { name: 'tool1', description: 'desc1' },
                { name: 'tool2', description: 'desc2' }
            ]
        });

        const stubs = await gateway.listToolStubs('test-upstream', context);

        expect(mockClient.getManifest).toHaveBeenCalled();
        expect(mockClient.call).not.toHaveBeenCalled(); // Should NOT call RPC
        expect(stubs).toHaveLength(2);
        expect(stubs[0].id).toBe('test-upstream__tool1');
    });

    it('should fall back to RPC if manifest is null', async () => {
        const context = new ExecutionContext({ logger });

        mockClient.getManifest.mockResolvedValue(null);
        mockClient.call.mockResolvedValue({
            result: {
                tools: [
                    { name: 'tool_rpc', description: 'from rpc' }
                ]
            }
        });

        const stubs = await gateway.listToolStubs('test-upstream', context);

        expect(mockClient.getManifest).toHaveBeenCalled();
        expect(mockClient.call).toHaveBeenCalledWith(expect.objectContaining({ method: 'tools/list' }), context);
        expect(stubs).toHaveLength(1);
        expect(stubs[0].id).toBe('test-upstream__tool_rpc');
    });

    it('should fall back to RPC if manifest fetch throws', async () => {
        const context = new ExecutionContext({ logger });

        mockClient.getManifest.mockRejectedValue(new Error('Network error'));
        mockClient.call.mockResolvedValue({
            result: {
                tools: [
                    { name: 'tool_rpc', description: 'from rpc' }
                ]
            }
        });

        const stubs = await gateway.listToolStubs('test-upstream', context);

        expect(mockClient.getManifest).toHaveBeenCalled();
        expect(mockClient.call).toHaveBeenCalled();
        expect(stubs).toHaveLength(1);
    });
});
