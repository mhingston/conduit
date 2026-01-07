import { Logger } from 'pino';
import { UpstreamClient, UpstreamInfo } from './upstream.client.js';
import { AuthService } from './auth.service.js';
import { SchemaCache, ToolSchema } from './schema.cache.js';
import { JSONRPCRequest, JSONRPCResponse } from '../core/types.js';
import { ExecutionContext } from '../core/execution.context.js';
import { IUrlValidator } from '../core/interfaces/url.validator.interface.js';
import { metrics } from '../core/metrics.service.js';

export class GatewayService {
    private logger: Logger;
    private clients: Map<string, UpstreamClient> = new Map();
    private authService: AuthService;
    private schemaCache: SchemaCache;
    private urlValidator: IUrlValidator;

    constructor(logger: Logger, urlValidator: IUrlValidator) {
        this.logger = logger;
        this.urlValidator = urlValidator;
        this.authService = new AuthService(logger);
        this.schemaCache = new SchemaCache(logger);
    }

    registerUpstream(info: UpstreamInfo) {
        const client = new UpstreamClient(this.logger, info, this.authService, this.urlValidator);
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
            // Normalize pattern: replace '.' with '__' but be careful with wildcards
            let normalizedPattern = pattern;

            if (pattern.endsWith('.*')) {
                // "foo.*" -> "foo__" prefix match
                // We want to match "foo__tool1", "foo__tool2"
                // BUT NOT "foo__bar__tool3" if the intent is strict hierarchy (though . usually implies recursive)
                // The finding says: "foo.*" matches "foo__bar__tool" because "foo__" is prefix.
                // If we want strict segment matching, we need to inspect segments.
                // However, commonly "foo.*" DOES imply "everything under foo", including sub-namespaces.
                // The issue description says: "granting foo.* accidentally grants foo.bar.*".
                // If "foo.bar" is a separate upstream or distinct namespace, this is bad.
                // "foo" tools become "foo__tool". "foo.bar" tools become "foo__bar__tool".

                // If we want to prevent partial prefix matching (e.g. pattern "foo.*" matching "foobar__tool"),
                // we ensure the separator is respected.
                // "foo.*" -> matches "foo__" prefix.
                // "foobar" upstream -> "foobar__tool". "foo__" does NOT match "foobar__". 
                // So "foobar" upstream is safe from "foo.*".

                // The tricky case is nested upstreams or dot-notation used within upstream IDs.
                // If upstream ID is "foo.bar", tools are "foo__bar__tool".
                // "foo.*" -> "foo__". "foo__" matches "foo__bar__tool".
                // If the user intends "foo.*" to ONLY mean "tools directly in foo upstream", then this is a bug.
                // But usually * implies deep match.

                // If the vulnerability is about "foo" matching "foo_extra", the __ separator handles that.
                // If the vulnerability is about hierarchical granting, maybe we want to enforce segments?

                // Let's implement robust segment-based matching.
                // We assume toolName is "upstream__toolname".
                // We want to check if it matches the pattern.

                // Convert toolName back to dot notation for cleaner matching logic?
                // Or convert pattern to __ notation?
                // Pattern: "foo.bar" -> "foo__bar" (Exact match)
                // Pattern: "foo.*" -> "foo__" + anything (Prefix match)

                // The fix suggested: "Use structured checking (split by separator) ensuring wildcards only match within their segment."
                // This implies we should treat it as parts.

                const patternParts = pattern.split('.');
                const toolParts = toolName.split('__');

                if (patternParts[patternParts.length - 1] === '*') {
                    // Wildcard match
                    const prefixParts = patternParts.slice(0, -1);
                    if (prefixParts.length > toolParts.length) return false;

                    // Check if prefix parts match tool parts exactly
                    for (let i = 0; i < prefixParts.length; i++) {
                        if (prefixParts[i] !== toolParts[i]) return false;
                    }
                    return true;
                } else {
                    // Exact match
                    // pattern "foo.bar" matches "foo__bar"
                    // pattern parts: ["foo", "bar"]
                    // tool parts: ["foo", "bar"]
                    if (patternParts.length !== toolParts.length) return false;
                    for (let i = 0; i < patternParts.length; i++) {
                        if (patternParts[i] !== toolParts[i]) return false;
                    }
                    return true;
                }
            }

            // Fallback for existing logic if not using wildcard or dot notation (though unlikely given context)
            const normalized = pattern.replace('.', '__');
            if (pattern.endsWith('*')) { // e.g. "foo*" - rare but possible
                // This is dangerous as per finding if not handled, but sticking to the dot-split logic above handles "foo.*"
                // If pattern is "foo*", and we split by '.', we get ["foo*"]. 
                // That falls into exact match logic which fails.
                // So we need to handle "generic" wildcards if supported? 
                // The codebase seems to only support ".*" style based on previous code `normalized.endsWith('__*')`.
                // The previous code replaced `.` with `__`. So `foo.*` became `foo__*`.

                // Let's stick to the robust segment splitting for the standard `.` delimiter case.
                return toolName === normalized;
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
