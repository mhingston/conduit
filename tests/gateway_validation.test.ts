import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewayService } from '../src/gateway/gateway.service.js';
import { ExecutionContext } from '../src/core/execution.context.js';
import { UpstreamInfo } from '../src/gateway/upstream.client.js';
import { createLogger } from '../src/core/logger.js';
import { ConfigService } from '../src/core/config.service.js';
import { IUrlValidator } from '../src/core/interfaces/url.validator.interface.js';
import { PolicyService } from '../src/core/policy.service.js';

class MockUrlValidator implements IUrlValidator {
    async validateUrl(url: string) { return { valid: true }; }
}

describe('GatewayService validation', () => {
    let gateway: GatewayService;
    let logger: any;
    let urlValidator: IUrlValidator;
    let policyService: PolicyService;

    const mockUpstream: UpstreamInfo = {
        id: 'mock-upstream',
        type: 'http',
        url: 'http://localhost:3000/mcp'
    };

    beforeEach(() => {
        logger = createLogger(new ConfigService());
        urlValidator = new MockUrlValidator();
        policyService = new PolicyService();
        gateway = new GatewayService(logger, urlValidator, policyService);
        gateway.registerUpstream(mockUpstream);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should validate params against schema', async () => {
        const client = (gateway as any).clients.get('mock-upstream');
        const callSpy = vi.spyOn(client, 'call').mockResolvedValue({
            jsonrpc: '2.0',
            id: 1,
            result: {
                tools: [{
                    name: 'test',
                    inputSchema: {
                        type: 'object',
                        properties: { count: { type: 'number' } },
                        required: ['count']
                    }
                }]
            }
        });

        const context = new ExecutionContext({ logger });

        // Fail validation
        const failParams = { count: 'not a number' };
        const failRes = await gateway.callTool('mock-upstream__test', failParams, context);
        expect(failRes.error).toBeDefined();
        expect(failRes.error?.code).toBe(-32602);

        // Pass validation
        callSpy.mockResolvedValueOnce({ jsonrpc: '2.0', id: 2, result: { success: true } });
        const passParams = { count: 123 };
        const passRes = await gateway.callTool('mock-upstream__test', passParams, context);
        expect(passRes.error).toBeUndefined();
    });

    it('should allow tool call if schema is missing (backward compatibility / permissive)', async () => {
        const client = (gateway as any).clients.get('mock-upstream');
        const callSpy = vi.spyOn(client, 'call').mockResolvedValue({
            jsonrpc: '2.0',
            id: 1,
            result: { tools: [{ name: 'noschema' }] } // no inputSchema
        });

        const context = new ExecutionContext({ logger });
        const params = { any: 'thing' };

        callSpy.mockResolvedValueOnce({ jsonrpc: '2.0', id: 2, result: { success: true } });
        const res = await gateway.callTool('mock-upstream__noschema', params, context);

        expect(res.error).toBeUndefined();
    });
});
