import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GatewayService } from '../src/gateway/gateway.service.js';
import { ExecutionContext } from '../src/core/execution.context.js';
import { startReferenceMCP } from './reference_mcp.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('Contract Test: Conduit vs Reference MCP', () => {
    let gateway: GatewayService;
    let context: ExecutionContext;
    let refServer: any;
    const REF_PORT = 4567;

    beforeAll(async () => {
        refServer = await startReferenceMCP(REF_PORT);
        const securityService = {
            validateUrl: vi.fn().mockReturnValue({ valid: true }),
        } as any;
        gateway = new GatewayService(logger, securityService);
        context = new ExecutionContext({ logger });

        gateway.registerUpstream({
            id: 'ref',
            url: `http://localhost:${REF_PORT}`,
        });
    });

    afterAll(async () => {
        await refServer.close();
    });

    it('should successfully discover tools from reference MCP', async () => {
        const tools = await gateway.discoverTools(context);
        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe('ref__echo');
    });

    it('should successfully call tool on reference MCP', async () => {
        const response = await gateway.callTool('ref__echo', { msg: 'hello' }, context);
        expect(response.result.content[0].text).toContain('{"msg":"hello"}');
    });
});
