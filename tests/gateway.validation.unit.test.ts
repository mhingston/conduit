import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayService } from '../src/gateway/gateway.service.js';
import { ExecutionContext } from '../src/core/execution.context.js';
import { createLogger } from '../src/core/logger.js';
import { ConfigService } from '../src/core/config.service.js';
import { PolicyService } from '../src/core/policy.service.js';
import { ToolSchema } from '../src/gateway/schema.cache.js';

describe('GatewayService (ValidateTool)', () => {
    let gateway: GatewayService;
    let logger: any;
    let mockClient: any;

    beforeEach(() => {
        logger = createLogger(new ConfigService());
        gateway = new GatewayService(logger, { validateUrl: vi.fn().mockResolvedValue({ valid: true }) } as any, new PolicyService());

        mockClient = {
            call: vi.fn(),
            getManifest: vi.fn(),
        };
        (gateway as any).clients.set('mock-package', mockClient);
    });

    const mockSchema: ToolSchema = {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: {
            type: 'object',
            properties: {
                foo: { type: 'string' },
                bar: { type: 'number' }
            },
            required: ['foo']
        }
    };

    it('should return valid:true for valid parameters', async () => {
        const context = new ExecutionContext({ logger });

        // Mock listToolStubs behavior by pre-loading cache or mocking cache
        // Let's use internal method to seed cache
        (gateway as any).schemaCache.set('mock-package', [mockSchema]);

        const result = await gateway.validateTool('mock-package__test_tool', { foo: 'hello', bar: 123 }, context);

        expect(result.valid).toBe(true);
        expect(result.errors).toBeUndefined();
    });

    it('should return valid:false for invalid parameters', async () => {
        const context = new ExecutionContext({ logger });
        (gateway as any).schemaCache.set('mock-package', [mockSchema]);

        const result = await gateway.validateTool('mock-package__test_tool', { bar: 'wrong type' }, context);

        expect(result.valid).toBe(false);
        expect(result.errors).toBeDefined();
        // Check for specific error message if possible, but generic check is fine for now
        expect(JSON.stringify(result.errors)).toContain('must have required property');
    });

    it('should lazy load schema if missing', async () => {
        const context = new ExecutionContext({ logger });

        // Mock listToolStubs to populate cache
        // We can spy on listToolStubs but it's easier to verify behavior by effect

        // Actually, listToolStubs populates cache from RPC/Manifest
        mockClient.call.mockResolvedValue({
            result: { tools: [mockSchema] }
        });

        const result = await gateway.validateTool('mock-package__test_tool', { foo: 'lazy' }, context);

        expect(mockClient.call).toHaveBeenCalled(); // Should fetch since cache was empty
        expect(result.valid).toBe(true);
    });

    it('should return error if tool not found', async () => {
        const context = new ExecutionContext({ logger });
        mockClient.call.mockResolvedValue({ result: { tools: [] } });

        const result = await gateway.validateTool('mock-package__non_existent', {}, context);

        expect(result.valid).toBe(false);
        expect(result.errors?.[0]).toContain('not found');
    });
});
