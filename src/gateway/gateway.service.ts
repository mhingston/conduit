import { Logger } from 'pino';
import { UpstreamClient, UpstreamInfo } from './upstream.client.js';
import { AuthService } from './auth.service.js';
import { SchemaCache, ToolSchema } from './schema.cache.js';
import { JSONRPCRequest, JSONRPCResponse } from '../core/request.controller.js';
import { ExecutionContext } from '../core/execution.context.js';
import { SecurityService } from '../core/security.service.js';
import { metrics } from '../core/metrics.service.js';

export class GatewayService {
    private logger: Logger;
    private clients: Map<string, UpstreamClient> = new Map();
    private authService: AuthService;
    private schemaCache: SchemaCache;
    private securityService: SecurityService;

    constructor(logger: Logger, securityService: SecurityService) {
        this.logger = logger;
        this.securityService = securityService;
        this.authService = new AuthService(logger);
        this.schemaCache = new SchemaCache(logger);
    }

    registerUpstream(info: UpstreamInfo) {
        const client = new UpstreamClient(this.logger, info, this.authService, this.securityService);
        this.clients.set(info.id, client);
        this.logger.info({ upstreamId: info.id }, 'Registered upstream MCP');
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
                allTools.push(...prefixedTools.filter(t => this.isToolAllowed(t.name, context.allowedTools!)));
            } else {
                allTools.push(...prefixedTools);
            }
        }

        return allTools;
    }

    /**
     * Check if a tool name matches any pattern in the allowlist.
     * Supports wildcard patterns: "github.*" matches "github__createIssue"
     */
    private isToolAllowed(toolName: string, allowedTools: string[]): boolean {
        return allowedTools.some(pattern => {
            const normalized = pattern.replace('.', '__');
            if (normalized.endsWith('__*')) {
                return toolName.startsWith(normalized.slice(0, -1));
            }
            return toolName === normalized;
        });
    }

    async callTool(name: string, params: any, context: ExecutionContext): Promise<JSONRPCResponse> {
        if (context.allowedTools && !this.isToolAllowed(name, context.allowedTools)) {
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

        const [upstreamId, ...toolNameParts] = name.split('__');
        const toolName = toolNameParts.join('__');

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
        } catch (error) {
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
}
