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

describe('GatewayService (Code Mode Lite)', () => {
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

    describe('listToolPackages', () => {
        it('should return registered tool packages including built-ins', async () => {
            const packages = await gateway.listToolPackages();
            expect(packages).toHaveLength(2); // conduit + mock-upstream
            expect(packages.find(p => p.id === 'conduit')).toBeDefined();
            expect(packages.find(p => p.id === 'mock-upstream')).toBeDefined();
        });
    });

    describe('listToolStubs', () => {
        it('should list tool stubs from upstream', async () => {
            // Mock the upstream client call
            const client = (gateway as any).clients.get('mock-upstream');
            vi.spyOn(client, 'call').mockResolvedValue({
                jsonrpc: '2.0',
                id: 1,
                result: {
                    tools: [
                        { name: 'op1', description: 'Operation 1', inputSchema: {} },
                        { name: 'op2', description: 'Operation 2', inputSchema: {} }
                    ]
                }
            });

            const context = new ExecutionContext({ logger });
            const stubs = await gateway.listToolStubs('mock-upstream', context);

            expect(stubs).toHaveLength(2);
            expect(stubs[0]).toMatchObject({
                id: 'mock-upstream__op1',
                name: 'op1',
                description: 'Operation 1'
            });
            expect(stubs[1]).toMatchObject({
                id: 'mock-upstream__op2',
                name: 'op2',
                description: 'Operation 2'
            });
        });

        it('should filter stubs based on allowlist', async () => {
            const client = (gateway as any).clients.get('mock-upstream');
            vi.spyOn(client, 'call').mockResolvedValue({
                jsonrpc: '2.0',
                id: 1,
                result: {
                    tools: [
                        { name: 'allowed', description: 'Allowed Tool', inputSchema: {} },
                        { name: 'blocked', description: 'Blocked Tool', inputSchema: {} }
                    ]
                }
            });

            const context = new ExecutionContext({ logger });
            // PolicyService expects dot notation for allowlist patterns
            context.allowedTools = ['mock-upstream.allowed'];

            const stubs = await gateway.listToolStubs('mock-upstream', context);
            expect(stubs).toHaveLength(1);
            expect(stubs[0].name).toBe('allowed');
        });
    });

    describe('getToolSchema', () => {
        it('should return schema for specific tool', async () => {
            const client = (gateway as any).clients.get('mock-upstream');
            vi.spyOn(client, 'call').mockResolvedValue({
                jsonrpc: '2.0',
                id: 1,
                result: {
                    tools: [
                        { name: 'target', description: 'Target Tool', inputSchema: { type: 'object' } }
                    ]
                }
            });

            const context = new ExecutionContext({ logger });
            // First call triggers discovery (lazy load simulation)
            const schema = await gateway.getToolSchema('mock-upstream__target', context);

            expect(schema).not.toBeNull();
            expect(schema?.name).toBe('mock-upstream__target'); // Namespaced
            expect(schema?.description).toBe('Target Tool');
        });

        it('should block access if not in allowlist', async () => {
            const context = new ExecutionContext({ logger });
            context.allowedTools = ['other-tool'];

            try {
                await gateway.getToolSchema('mock-upstream__target', context);
                expect.fail('Should have thrown error');
            } catch (err: any) {
                expect(err.message).toContain('forbidden by allowlist');
            }
        });

        it('should return null if tool does not exist', async () => {
            const client = (gateway as any).clients.get('mock-upstream');
            vi.spyOn(client, 'call').mockResolvedValue({
                jsonrpc: '2.0',
                id: 1,
                result: {
                    tools: []
                }
            });

            const context = new ExecutionContext({ logger });
            const schema = await gateway.getToolSchema('mock-upstream__nonexistent', context);
            expect(schema).toBeNull();
        });
    });
});
