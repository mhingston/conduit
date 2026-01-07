import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayService } from '../src/gateway/gateway.service.js';
import { ExecutionContext } from '../src/core/execution.context.js';
import pino from 'pino';
import axios from 'axios';

vi.mock('axios');
const logger = pino({ level: 'silent' });

describe('GatewayService', () => {
    let gateway: GatewayService;
    let context: ExecutionContext;

    beforeEach(() => {
        const securityService = {
            validateUrl: vi.fn().mockReturnValue({ valid: true }),
        } as any;
        gateway = new GatewayService(logger, securityService);
        context = new ExecutionContext({ logger });
        vi.clearAllMocks();
    });

    it('should discover tools from multiple upstreams', async () => {
        gateway.registerUpstream({ id: 'u1', url: 'http://u1' });
        gateway.registerUpstream({ id: 'u2', url: 'http://u2' });

        (axios.post as any).mockImplementation((url: string) => {
            if (url === 'http://u1') return { data: { result: { tools: [{ name: 't1', inputSchema: {} }] } } };
            if (url === 'http://u2') return { data: { result: { tools: [{ name: 't2', inputSchema: {} }] } } };
            return { data: { result: { tools: [] } } };
        });

        const tools = await gateway.discoverTools(context);
        expect(tools).toHaveLength(2);
        expect(tools.find(t => t.name === 'u1__t1')).toBeDefined();
        expect(tools.find(t => t.name === 'u2__t2')).toBeDefined();
    });

    it('should route tool calls to correct upstream', async () => {
        gateway.registerUpstream({ id: 'u1', url: 'http://u1' });

        (axios.post as any).mockResolvedValue({
            data: { result: { stdout: 'done' } }
        });

        const response = await gateway.callTool('u1__t1', { arg1: 'val' }, context);

        expect(axios.post).toHaveBeenCalledWith(
            'http://u1',
            expect.objectContaining({
                method: 'call_tool',
                params: expect.objectContaining({ name: 't1' })
            }),
            expect.anything()
        );
        expect(response.result.stdout).toBe('done');
    });
});
