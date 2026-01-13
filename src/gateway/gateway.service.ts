import { Logger } from 'pino';
import { HostClient } from './host.client.js';
import { StdioTransport } from '../transport/stdio.transport.js';
import { UpstreamClient, UpstreamInfo } from './upstream.client.js';
import { AuthService } from './auth.service.js';
import { SchemaCache, ToolSchema } from './schema.cache.js';
import { JSONRPCRequest, JSONRPCResponse, ToolPackage, ToolStub } from '../core/types.js';
import { ExecutionContext } from '../core/execution.context.js';
import { IUrlValidator } from '../core/interfaces/url.validator.interface.js';
import { metrics } from '../core/metrics.service.js';
import { PolicyService, ToolIdentifier } from '../core/policy.service.js';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';

const BUILT_IN_TOOLS: ToolSchema[] = [
    {
        name: 'mcp_execute_typescript',
        description: 'Executes TypeScript code in a secure sandbox. Access MCP tools via the global `tools` object (e.g. `filesystem__list_directory` -> `await tools.filesystem.list_directory(...)`).',
        inputSchema: {
            type: 'object',
            properties: {
                code: {
                    type: 'string',
                    description: 'The TypeScript code to execute.'
                },
                allowedTools: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'List of tool names (e.g. "filesystem.list_directory" or "filesystem.*") that the script is allowed to call.'
                }
            },
            required: ['code']
        }
    },
    {
        name: 'mcp_execute_python',
        description: 'Executes Python code in a secure sandbox. Access MCP tools via the global `tools` object (e.g. `filesystem__list_directory` -> `await tools.filesystem.list_directory(...)`).',
        inputSchema: {
            type: 'object',
            properties: {
                code: {
                    type: 'string',
                    description: 'The Python code to execute.'
                },
                allowedTools: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'List of tool names (e.g. "filesystem.list_directory" or "filesystem.*") that the script is allowed to call.'
                }
            },
            required: ['code']
        }
    },
    {
        name: 'mcp_execute_isolate',
        description: 'Executes JavaScript code in a high-speed V8 isolate. Access MCP tools via the global `tools` object (e.g. `await tools.filesystem.list_directory(...)`). No Deno/Node APIs. Use `console.log` for output.',
        inputSchema: {
            type: 'object',
            properties: {
                code: {
                    type: 'string',
                    description: 'The JavaScript code to execute.'
                },
                allowedTools: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'List of tool names (e.g. "filesystem.list_directory" or "filesystem.*") that the script is allowed to call.'
                }
            },
            required: ['code']
        }
    }
];

export class GatewayService {
    private logger: Logger;
    private clients: Map<string, any> = new Map();
    private authService: AuthService;
    private schemaCache: SchemaCache;
    private urlValidator: IUrlValidator;
    public policyService: PolicyService;
    private ajv: Ajv;
    // Cache compiled validators to avoid recompilation on every call
    private validatorCache = new Map<string, any>();

    constructor(logger: Logger, urlValidator: IUrlValidator, policyService?: PolicyService) {
        this.logger = logger.child({ component: 'GatewayService' });
        this.logger.debug('GatewayService instance created');
        this.urlValidator = urlValidator;
        this.authService = new AuthService(logger);
        this.schemaCache = new SchemaCache(logger);
        this.policyService = policyService ?? new PolicyService();
        this.ajv = new Ajv({ strict: false });
        (addFormats as any).default(this.ajv);
    }

    registerUpstream(info: UpstreamInfo) {
        const client = new UpstreamClient(this.logger, info, this.authService, this.urlValidator);
        this.clients.set(info.id, client);
        this.logger.info({ upstreamId: info.id, totalRegistered: this.clients.size }, 'Registered upstream MCP');
    }

    registerHost(transport: StdioTransport) {
        // NOTE: The host (VS Code) cannot receive tools/call requests - it's the CLIENT.
        // We only register it for potential future use (e.g., sampling requests).
        // DO NOT use the host as a tool provider fallback.
        this.logger.debug('Host transport available but not registered as tool upstream (protocol limitation)');
    }

    async listToolPackages(): Promise<ToolPackage[]> {
        const upstreams = Array.from(this.clients.entries()).map(([id, client]) => ({
            id,
            description: `Upstream ${id}`,
            version: '1.0.0'
        }));

        return [
            { id: 'conduit', description: 'Conduit built-in execution tools', version: '1.0.0' },
            ...upstreams
        ];
    }

    getBuiltInTools(): ToolSchema[] {
        return BUILT_IN_TOOLS;
    }

    async listToolStubs(packageId: string, context: ExecutionContext): Promise<ToolStub[]> {
        if (packageId === 'conduit') {
            const stubs = BUILT_IN_TOOLS.map(t => ({
                id: `conduit__${t.name}`,
                name: t.name,
                description: t.description
            }));
            if (context.allowedTools) {
                return stubs.filter(t => this.policyService.isToolAllowed(t.id, context.allowedTools!));
            }
            return stubs;
        }

        const client = this.clients.get(packageId);
        if (!client) {
            throw new Error(`Upstream package not found: ${packageId}`);
        }

        let tools = this.schemaCache.get(packageId);

        // Try manifest first if tools not cached
        if (!tools) {
            try {
                // Try to get manifest FIRST
                const manifest = await client.getManifest(context);
                if (manifest && manifest.tools) {
                    tools = manifest.tools as ToolSchema[];
                } else {
                    // Fall back to RPC discovery
                    if (typeof (client as any).listTools === 'function') {
                        tools = await (client as any).listTools();
                    } else {
                        const response = await client.call({
                            jsonrpc: '2.0',
                            id: 'discovery',
                            method: 'tools/list',
                        }, context);

                        if (response.result?.tools) {
                            tools = response.result.tools as ToolSchema[];
                        } else {
                            this.logger.warn({ upstreamId: packageId, error: response.error }, 'Failed to discover tools via RPC');
                        }
                    }
                }

                if (tools && tools.length > 0) {
                    this.schemaCache.set(packageId, tools);
                    this.logger.info({ upstreamId: packageId, toolCount: tools.length }, 'Discovered tools from upstream');
                }
            } catch (e: any) {
                this.logger.error({ upstreamId: packageId, err: e.message }, 'Error during tool discovery');
            }
        }

        if (!tools) tools = [];

        const stubs: ToolStub[] = tools.map(t => ({
            id: `${packageId}__${t.name}`,
            name: t.name,
            description: t.description
        }));

        if (context.allowedTools) {
            return stubs.filter(t => this.policyService.isToolAllowed(t.id, context.allowedTools!));
        }

        return stubs;
    }

    async getToolSchema(toolId: string, context: ExecutionContext): Promise<ToolSchema | null> {
        if (context.allowedTools && !this.policyService.isToolAllowed(toolId, context.allowedTools)) {
            throw new Error(`Access to tool ${toolId} is forbidden by allowlist`);
        }

        const parsed = this.policyService.parseToolName(toolId);
        const namespace = parsed.namespace;
        const toolName = parsed.name;

        // Check for built-in tools (now namespaced as conduit__*)
        if (namespace === 'conduit' || namespace === '') {
            const builtIn = BUILT_IN_TOOLS.find(t => t.name === toolName);
            if (builtIn) {
                return { ...builtIn, name: `conduit__${builtIn.name}` };
            }
        }

        const upstreamId = namespace;
        if (!upstreamId) {
            // Un-namespaced tool lookup: try all upstreams
            for (const id of this.clients.keys()) {
                const schema = await this.getToolSchema(`${id}__${toolName}`, context);
                if (schema) return schema;
            }
            return null;
        }

        // Ensure we have schemas for this upstream
        if (!this.schemaCache.get(upstreamId)) {
            await this.listToolStubs(upstreamId, context);
        }

        const tools = this.schemaCache.get(upstreamId) || [];
        const tool = tools.find(t => t.name === toolName);

        if (!tool) return null;

        return {
            ...tool,
            name: toolId
        };
    }

    async discoverTools(context: ExecutionContext): Promise<ToolSchema[]> {
        const allTools: ToolSchema[] = BUILT_IN_TOOLS.map(t => ({
            ...t,
            name: `conduit__${t.name}`
        }));

        this.logger.debug({ clientCount: this.clients.size, clientIds: Array.from(this.clients.keys()) }, 'Starting tool discovery');

        for (const [id, client] of this.clients.entries()) {
            // Skip host - it's not a tool provider
            if (id === 'host') {
                continue;
            }

            this.logger.debug({ upstreamId: id }, 'Discovering tools from upstream');

            // reuse unified discovery logic
            try {
                await this.listToolStubs(id, context);
            } catch (e: any) {
                this.logger.error({ upstreamId: id, err: e.message }, 'Failed to list tool stubs');
            }
            const tools = this.schemaCache.get(id) || [];

            this.logger.debug({ upstreamId: id, toolCount: tools.length }, 'Discovery result');

            if (tools && tools.length > 0) {
                const prefixedTools = tools.map(t => ({ ...t, name: `${id}__${t.name}` }));
                if (context.allowedTools) {
                    allTools.push(...prefixedTools.filter(t => this.policyService.isToolAllowed(t.name, context.allowedTools!)));
                } else {
                    allTools.push(...prefixedTools);
                }
            }
        }

        this.logger.info({ totalTools: allTools.length }, 'Tool discovery complete');
        return allTools;
    }

    async callTool(name: string, params: any, context: ExecutionContext): Promise<JSONRPCResponse> {
        this.logger.debug({ name, upstreamCount: this.clients.size }, 'GatewayService.callTool called');

        if (context.allowedTools && !this.policyService.isToolAllowed(name, context.allowedTools)) {
            this.logger.warn({ name, allowedTools: context.allowedTools }, 'Tool call blocked by allowlist');
            return {
                jsonrpc: '2.0',
                id: 0,
                error: {
                    code: -32003,
                    message: `Authorization failed: tool ${name} is not in the allowlist`,
                },
            };
        }

        const toolId = this.policyService.parseToolName(name);
        const upstreamId = toolId.namespace;
        const toolName = toolId.name;

        this.logger.debug({ name, upstreamId, toolName }, 'Parsed tool name');

        // Fallback for namespaceless calls: try to find the tool in any registered upstream
        if (!upstreamId) {
            this.logger.debug({ toolName }, 'Namespaceless call, attempting discovery across upstreams');
            const allStubs = await this.discoverTools(context);
            const found = allStubs.find(t => {
                const parts = t.name.split('__');
                return parts[parts.length - 1] === toolName;
            });

            if (found) {
                this.logger.debug({ original: name, resolved: found.name }, 'Resolved namespaceless tool');
                return this.callTool(found.name, params, context);
            }

            // No fallback to host - it doesn't support server-to-client tool calls
            const upstreamList = Array.from(this.clients.keys()).filter(k => k !== 'host');
            return {
                jsonrpc: '2.0',
                id: 0,
                error: {
                    code: -32601,
                    message: `Tool '${toolName}' not found. Discovered ${allStubs.length} tools from upstreams: [${upstreamList.join(', ') || 'none'}]. Available tools: ${allStubs.map(t => t.name).slice(0, 10).join(', ')}${allStubs.length > 10 ? '...' : ''}`,
                },
            };
        }

        const client = this.clients.get(upstreamId);
        if (!client) {
            this.logger.error({ upstreamId, availableUpstreams: Array.from(this.clients.keys()) }, 'Upstream not found');
            return {
                jsonrpc: '2.0',
                id: 0,
                error: {
                    code: -32003,
                    message: `Upstream not found: '${upstreamId}'. Available: ${Array.from(this.clients.keys()).join(', ') || 'none'}`,
                },
            };
        }

        // Lazy load schema if missing (Phase 1)
        if (!this.schemaCache.get(upstreamId)) {
            await this.listToolStubs(upstreamId, context);
        }

        const tools = this.schemaCache.get(upstreamId) || [];
        const toolSchema = tools.find(t => t.name === toolName);

        if (context.strictValidation) {
            if (!toolSchema) {
                return {
                    jsonrpc: '2.0',
                    id: 0,
                    error: {
                        code: -32601, // Method not found / Schema missing
                        message: `Strict mode: Tool schema for ${name} not found`,
                    },
                };
            }
            if (!toolSchema.inputSchema) {
                return {
                    jsonrpc: '2.0',
                    id: 0,
                    error: {
                        code: -32602, // Invalid params
                        message: `Strict mode: Tool ${name} has no input schema defined`,
                    },
                };
            }
        }

        if (toolSchema && toolSchema.inputSchema) {
            const cacheKey = `${upstreamId}__${toolName}`;
            let validate = this.validatorCache.get(cacheKey);
            if (!validate) {
                validate = this.ajv.compile(toolSchema.inputSchema);
                this.validatorCache.set(cacheKey, validate);
            }
            const valid = validate(params);
            if (!valid) {
                return {
                    jsonrpc: '2.0',
                    id: 0,
                    error: {
                        code: -32602, // Invalid params
                        message: `Invalid parameters for tool ${name}: ${this.ajv.errorsText(validate.errors)}`,
                    },
                };
            }
        }

        const startTime = performance.now();
        let success = false;
        let response: JSONRPCResponse;

        try {
            response = await client.call({
                jsonrpc: '2.0',
                id: context.correlationId,
                method: 'tools/call',
                params: {
                    name: toolName,
                    arguments: params,
                },
            }, context);
            success = !response.error;
        } catch (error: any) {
            success = false;
            throw error;
        } finally {
            const duration = performance.now() - startTime;
            metrics.recordToolExecution(duration, toolName, success);
        }

        if (response.error && response.error.code === -32008) {
            // Potentially refresh cache on certain types of errors
            this.schemaCache.invalidate(upstreamId);
        }

        return response;
    }

    async healthCheck(): Promise<{ status: string; upstreams: Record<string, string> }> {
        const upstreamStatus: Record<string, string> = {};
        const context = new ExecutionContext({ logger: this.logger });

        await Promise.all(
            Array.from(this.clients.entries()).map(async ([id, client]) => {
                try {
                    const response = await client.call({
                        jsonrpc: '2.0',
                        id: 'health',
                        method: 'tools/list',
                    }, context);
                    upstreamStatus[id] = response.error ? 'degraded' : 'active';
                } catch (err) {
                    upstreamStatus[id] = 'error';
                }
            })
        );

        const allOk = Object.values(upstreamStatus).every(s => s === 'active');
        return {
            status: allOk ? 'ok' : 'degraded',
            upstreams: upstreamStatus,
        };
    }
    async validateTool(name: string, params: any, context: ExecutionContext): Promise<{ valid: boolean; errors?: string[] }> {
        const toolId = this.policyService.parseToolName(name);
        const upstreamId = toolId.namespace;
        const toolName = toolId.name;

        // Ensure we have schemas
        if (!this.schemaCache.get(upstreamId)) {
            await this.listToolStubs(upstreamId, context);
        }

        const tools = this.schemaCache.get(upstreamId) || [];
        const toolSchema = tools.find(t => t.name === toolName);

        if (!toolSchema) {
            return { valid: false, errors: [`Tool ${name} not found`] };
        }

        if (context.strictValidation) {
            if (!toolSchema.inputSchema) {
                return { valid: false, errors: [`Strict mode: Tool ${name} has no input schema defined`] };
            }
        }

        if (!toolSchema.inputSchema) {
            // No schema means any params are valid (unless strict mode, which we handled above)
            return { valid: true };
        }

        const validate = this.ajv.compile(toolSchema.inputSchema);
        const valid = validate(params);

        if (!valid) {
            return {
                valid: false,
                errors: validate.errors?.map(e => this.ajv.errorsText([e])) || ['Unknown validation error']
            };
        }

        return { valid: true };
    }
}
