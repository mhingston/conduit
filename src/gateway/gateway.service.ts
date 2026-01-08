import { Logger } from 'pino';
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

export class GatewayService {
    private logger: Logger;
    private clients: Map<string, UpstreamClient> = new Map();
    private authService: AuthService;
    private schemaCache: SchemaCache;
    private urlValidator: IUrlValidator;
    private policyService: PolicyService;
    private ajv: Ajv;
    // Cache compiled validators to avoid recompilation on every call
    private validatorCache = new Map<string, any>();

    constructor(logger: Logger, urlValidator: IUrlValidator, policyService?: PolicyService) {
        this.logger = logger;
        this.urlValidator = urlValidator;
        this.authService = new AuthService(logger);
        this.schemaCache = new SchemaCache(logger);
        this.policyService = policyService ?? new PolicyService();
        this.ajv = new Ajv({ strict: false }); // Strict mode off for now to be permissive with upstream schemas
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        (addFormats as any).default(this.ajv);
    }

    registerUpstream(info: UpstreamInfo) {
        const client = new UpstreamClient(this.logger, info, this.authService, this.urlValidator);
        this.clients.set(info.id, client);
        this.logger.info({ upstreamId: info.id }, 'Registered upstream MCP');
    }

    async listToolPackages(): Promise<ToolPackage[]> {
        return Array.from(this.clients.entries()).map(([id, client]) => ({
            id,
            description: `Upstream ${id}`, // NOTE: Upstream description fetching deferred to V2
            version: '1.0.0'
        }));
    }

    async listToolStubs(packageId: string, context: ExecutionContext): Promise<ToolStub[]> {
        const client = this.clients.get(packageId);
        if (!client) {
            throw new Error(`Upstream package not found: ${packageId}`);
        }

        let tools = this.schemaCache.get(packageId);

        // Try manifest first if tools not cached
        if (!tools) {
            try {
                // Try to fetch manifest first
                const manifest = await client.getManifest(context);
                if (manifest) {
                    const stubs: ToolStub[] = manifest.tools.map((t: any) => ({
                        id: `${packageId}__${t.name}`,
                        name: t.name,
                        description: t.description
                    }));

                    if (context.allowedTools) {
                        return stubs.filter(t => this.policyService.isToolAllowed(t.id, context.allowedTools!));
                    }
                    return stubs;
                }
            } catch (e) {
                // Manifest fetch failed, fall back
                this.logger.debug({ packageId, err: e }, 'Manifest fetch failed, falling back to RPC');
            }

            const response = await client.call({
                jsonrpc: '2.0',
                id: 'discovery',
                method: 'list_tools',
            }, context);

            if (response.result?.tools) {
                tools = response.result.tools as ToolSchema[];
                this.schemaCache.set(packageId, tools);
            } else {
                this.logger.warn({ upstreamId: packageId, error: response.error }, 'Failed to discover tools from upstream');
                tools = [];
            }
        }

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
        const upstreamId = parsed.namespace;
        const toolName = parsed.name;

        // Ensure we have schemas for this upstream
        if (!this.schemaCache.get(upstreamId)) {
            // Force refresh if missing
            await this.listToolStubs(upstreamId, context);
        }

        const tools = this.schemaCache.get(upstreamId) || [];
        const tool = tools.find(t => t.name === toolName);

        if (!tool) return null;

        // Return schema with namespaced name
        return {
            ...tool,
            name: toolId
        };
    }

    async discoverTools(context: ExecutionContext): Promise<ToolSchema[]> {
        const allTools: ToolSchema[] = [];

        for (const [id, client] of this.clients.entries()) {
            let tools = this.schemaCache.get(id);

            if (!tools) {
                const response = await client.call({
                    jsonrpc: '2.0',
                    id: 'discovery',
                    method: 'list_tools', // Standard MCP method
                }, context);

                if (response.result?.tools) {
                    tools = response.result.tools as ToolSchema[];
                    this.schemaCache.set(id, tools);
                } else {
                    this.logger.warn({ upstreamId: id, error: response.error }, 'Failed to discover tools from upstream');
                    tools = [];
                }
            }

            const prefixedTools = tools.map(t => ({ ...t, name: `${id}__${t.name}` }));

            if (context.allowedTools) {
                // Support wildcard patterns: "mock.*" matches "mock__hello"
                allTools.push(...prefixedTools.filter(t => this.policyService.isToolAllowed(t.name, context.allowedTools!)));
            } else {
                allTools.push(...prefixedTools);
            }
        }

        return allTools;
    }

    async callTool(name: string, params: any, context: ExecutionContext): Promise<JSONRPCResponse> {
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

        const client = this.clients.get(upstreamId);
        if (!client) {
            return {
                jsonrpc: '2.0',
                id: 0,
                error: {
                    code: -32003,
                    message: `Upstream not found: ${upstreamId}`,
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
                method: 'call_tool',
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
                        method: 'list_tools',
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
