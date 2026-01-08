import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayService } from '../src/gateway/gateway.service.js';
import { ExecutionContext } from '../src/core/execution.context.js';
import { createLogger } from '../src/core/logger.js';
import { ConfigService } from '../src/core/config.service.js';
import { PolicyService } from '../src/core/policy.service.js';
import { ToolSchema } from '../src/gateway/schema.cache.js';

describe('GatewayService (Strict Verification)', () => {
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
        (gateway as any).clients.set('mock-tool', mockClient);
    });

    const mockSchema: ToolSchema = {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: {
            type: 'object',
            properties: {
                foo: { type: 'string' }
            }
        }
    };

    const mockStub: ToolSchema = {
        name: 'stub_tool',
        description: 'A stub tool',
        inputSchema: undefined,
    };

    it('should allow call with missing schema in non-strict mode', async () => {
        const context = new ExecutionContext({ logger, strictValidation: false });
        (gateway as any).schemaCache.set('mock-tool', [mockStub]);
        mockClient.call.mockResolvedValue({ result: 'ok' });

        const response = await gateway.callTool('mock-tool__stub_tool', {}, context);

        expect(response.error).toBeUndefined();
        expect(mockClient.call).toHaveBeenCalled();
    });

    it('should block call with missing schema in strict mode', async () => {
        const context = new ExecutionContext({ logger, strictValidation: true });
        (gateway as any).schemaCache.set('mock-tool', [mockStub]);

        const response = await gateway.callTool('mock-tool__stub_tool', {}, context);

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(-32602);
        expect(response.error?.message).toContain('Strict mode');
        expect(mockClient.call).not.toHaveBeenCalled();
    });

    it('should block unknown tool in strict mode', async () => {
        const context = new ExecutionContext({ logger, strictValidation: true });
        (gateway as any).schemaCache.set('mock-tool', [mockSchema]);

        const response = await gateway.callTool('mock-tool__unknown', {}, context);

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(-32601);
    });
});
