import { ExecutionContext } from './execution.context.js';
import { Logger } from 'pino';

import { GatewayService } from '../gateway/gateway.service.js';
import { metrics } from './metrics.service.js';
import { ExecutionService } from './execution.service.js';

import { Middleware } from './interfaces/middleware.interface.js';

import { ConduitError } from './types.js';
import type { JSONRPCRequest, JSONRPCResponse } from './types.js';

export { ConduitError };
export type { JSONRPCRequest, JSONRPCResponse };

export class RequestController {
    private logger: Logger;
    private executionService: ExecutionService;
    private gatewayService: GatewayService;

    private middlewares: Middleware[] = [];

    constructor(
        logger: Logger,
        executionService: ExecutionService,
        gatewayService: GatewayService,
        middlewares: Middleware[] = []
    ) {
        this.logger = logger;
        this.executionService = executionService;
        this.gatewayService = gatewayService;
        this.middlewares = middlewares;
    }

    use(middleware: Middleware) {
        this.middlewares.push(middleware);
    }



    async handleRequest(request: JSONRPCRequest, context: ExecutionContext): Promise<JSONRPCResponse | null> {
        return this.executePipeline(request, context);
    }

    private async executePipeline(request: JSONRPCRequest, context: ExecutionContext): Promise<JSONRPCResponse | null> {
        let index = -1;

        const dispatch = async (i: number): Promise<JSONRPCResponse | null> => {
            if (i <= index) throw new Error('next() called multiple times');
            index = i;

            const middleware = this.middlewares[i];
            if (middleware) {
                return middleware.handle(request, context, () => dispatch(i + 1));
            }

            return this.finalHandler(request, context);
        };

        return dispatch(0);
    }

    private async handleValidateTool(request: JSONRPCRequest, context: ExecutionContext): Promise<JSONRPCResponse> {
        const params = request.params as { toolName: string; args: any };
        if (!params || !params.toolName || !params.args) {
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: -32602,
                    message: 'Missing toolName or args params',
                },
            };
        }

        try {
            const result = await this.gatewayService.validateTool(params.toolName, params.args, context);
            return {
                jsonrpc: '2.0',
                id: request.id,
                result,
            };
        } catch (error: any) {
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: -32603,
                    message: error.message || 'Validation failed',
                },
            };
        }
    }

    private async finalHandler(request: JSONRPCRequest, context: ExecutionContext): Promise<JSONRPCResponse | null> {
        const { method, params, id } = request;
        // Logging and metrics handled by middlewares now

        // Try/catch handled by ErrorMiddleware, but we handle logic errors here if needed
        // Actually routing logic should just throw and let middleware catch?
        // Or specific logic.

        switch (method) {
            case 'tools/list': // Standard MCP method name
            case 'mcp_discover_tools':
                return this.handleDiscoverTools(params, context, id);
            case 'resources/list':
            case 'prompts/list':
                return { jsonrpc: '2.0', id, result: { items: [] } };
            case 'mcp_list_tool_packages':
                return this.handleListToolPackages(params, context, id);
            case 'mcp_list_tool_stubs':
                return this.handleListToolStubs(params, context, id);
            case 'mcp_read_tool_schema':
                return this.handleReadToolSchema(params, context, id);
            case 'mcp_validate_tool':
                return this.handleValidateTool(request, context);
            case 'mcp_call_tool':
            case 'tools/call':
                return this.handleCallTool(params, context, id);
            case 'mcp_execute_typescript':
                return this.handleExecuteTypeScript(params, context, id);
            case 'mcp_execute_python':
                return this.handleExecutePython(params, context, id);
            case 'mcp_execute_isolate':
                return this.handleExecuteIsolate(params, context, id);
            case 'initialize':
                return this.handleInitialize(params, context, id);
            case 'notifications/initialized':
                return null; // Notifications don't get responses per MCP spec
            case 'ping':
                return { jsonrpc: '2.0', id, result: {} };
            default:
                // metrics.recordExecutionEnd is handled by LoggingMiddleware??
                // Wait, if 404, LoggingMiddleware records execution end?
                // Yes, handle() in LoggingMiddleware wraps next().
                return this.errorResponse(id, -32601, `Method not found: ${method}`);
        }
    }

    private async handleDiscoverTools(params: any, context: ExecutionContext, id: string | number): Promise<JSONRPCResponse> {
        const tools = await this.gatewayService.discoverTools(context);

        // Filter to only MCP-standard fields for compatibility with strict clients
        const standardizedTools = tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        }));

        return {
            jsonrpc: '2.0',
            id,
            result: {
                tools: standardizedTools,
            },
        };
    }

    private async handleListToolPackages(params: any, context: ExecutionContext, id: string | number): Promise<JSONRPCResponse> {
        const packages = await this.gatewayService.listToolPackages();
        return {
            jsonrpc: '2.0',
            id,
            result: {
                packages
            }
        };
    }

    private async handleListToolStubs(params: any, context: ExecutionContext, id: string | number): Promise<JSONRPCResponse> {
        const { packageId } = params;
        if (!packageId) {
            return this.errorResponse(id, -32602, 'Missing packageId parameter');
        }

        try {
            const stubs = await this.gatewayService.listToolStubs(packageId, context);
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    stubs
                }
            };
        } catch (error: any) {
            return this.errorResponse(id, -32001, error.message);
        }
    }

    private async handleReadToolSchema(params: any, context: ExecutionContext, id: string | number): Promise<JSONRPCResponse> {
        const { toolId } = params;
        if (!toolId) {
            return this.errorResponse(id, -32602, 'Missing toolId parameter');
        }

        try {
            const schema = await this.gatewayService.getToolSchema(toolId, context);
            if (!schema) {
                return this.errorResponse(id, -32001, `Tool not found: ${toolId}`);
            }
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    schema
                }
            };
        } catch (error: any) {
            return this.errorResponse(id, -32003, error.message);
        }
    }

    private async handleCallTool(params: any, context: ExecutionContext, id: string | number): Promise<JSONRPCResponse> {
        if (!params) return this.errorResponse(id, -32602, 'Missing parameters');
        const { name, arguments: toolArgs } = params;

        // Route built-in tools to their specific handlers
        switch (name) {
            case 'mcp_execute_typescript':
                return this.handleExecuteToolCall('typescript', toolArgs, context, id);
            case 'mcp_execute_python':
                return this.handleExecuteToolCall('python', toolArgs, context, id);
            case 'mcp_execute_isolate':
                return this.handleExecuteToolCall('isolate', toolArgs, context, id);
        }

        const response = await this.gatewayService.callTool(name, toolArgs, context);
        return { ...response, id };
    }

    private formatExecutionResult(result: { stdout: string; stderr: string; exitCode: number | null }) {
        const structured = {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
        };
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(structured),
            }],
            structuredContent: structured,
        };
    }

    private async handleExecuteToolCall(
        mode: 'typescript' | 'python' | 'isolate',
        params: any,
        context: ExecutionContext,
        id: string | number
    ): Promise<JSONRPCResponse> {
        if (!params) return this.errorResponse(id, -32602, 'Missing parameters');
        const { code, limits, allowedTools } = params;

        if (Array.isArray(allowedTools)) {
            context.allowedTools = allowedTools;
        }

        const result = mode === 'typescript'
            ? await this.executionService.executeTypeScript(code, limits, context, allowedTools)
            : mode === 'python'
                ? await this.executionService.executePython(code, limits, context, allowedTools)
                : await this.executionService.executeIsolate(code, limits, context, allowedTools);

        if (result.error) {
            return this.errorResponse(id, result.error.code, result.error.message);
        }

        return {
            jsonrpc: '2.0',
            id,
            result: this.formatExecutionResult(result),
        };
    }

    private async handleExecuteTypeScript(params: any, context: ExecutionContext, id: string | number): Promise<JSONRPCResponse> {
        if (!params) return this.errorResponse(id, -32602, 'Missing parameters');
        const { code, limits, allowedTools } = params;

        if (Array.isArray(allowedTools)) {
            context.allowedTools = allowedTools;
        }

        const result = await this.executionService.executeTypeScript(code, limits, context, allowedTools);

        if (result.error) {
            return this.errorResponse(id, result.error.code, result.error.message);
        }

        return {
            jsonrpc: '2.0',
            id,
            result: {
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
            },
        };
    }

    private async handleExecutePython(params: any, context: ExecutionContext, id: string | number): Promise<JSONRPCResponse> {
        if (!params) return this.errorResponse(id, -32602, 'Missing parameters');
        const { code, limits, allowedTools } = params;

        if (Array.isArray(allowedTools)) {
            context.allowedTools = allowedTools;
        }

        const result = await this.executionService.executePython(code, limits, context, allowedTools);

        if (result.error) {
            return this.errorResponse(id, result.error.code, result.error.message);
        }

        return {
            jsonrpc: '2.0',
            id,
            result: {
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
            },
        };
    }

    private async handleInitialize(params: any, context: ExecutionContext, id: string | number): Promise<JSONRPCResponse> {
        // Echo back the client's protocol version for compatibility, or use latest if not provided
        const clientVersion = params?.protocolVersion || '2025-06-18';
        return {
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: clientVersion,
                capabilities: {
                    tools: {
                        listChanged: true
                    },
                    resources: {
                        listChanged: true,
                        subscribe: true
                    }
                },
                serverInfo: {
                    name: 'conduit',
                    version: process.env.npm_package_version || '1.1.0'
                }
            }
        };
    }

    private async handleExecuteIsolate(params: any, context: ExecutionContext, id: string | number): Promise<JSONRPCResponse> {
        if (!params) return this.errorResponse(id, -32602, 'Missing parameters');
        const { code, limits, allowedTools } = params;

        if (Array.isArray(allowedTools)) {
            context.allowedTools = allowedTools;
        }

        const result = await this.executionService.executeIsolate(code, limits, context, allowedTools);

        if (result.error) {
            return this.errorResponse(id, result.error.code, result.error.message);
        }

        return {
            jsonrpc: '2.0',
            id,
            result: {
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
            },
        };
    }

    private errorResponse(id: string | number, code: number, message: string): JSONRPCResponse {
        return {
            jsonrpc: '2.0',
            id,
            error: {
                code,
                message,
            },
        };
    }

    async shutdown() {
        await this.executionService.shutdown();
    }

    async healthCheck() {
        const pyodideHealth = await this.executionService.healthCheck();
        return {
            status: pyodideHealth.status === 'ok' ? 'ok' : 'error',
            pyodide: pyodideHealth
        };
    }

    async warmup() {
        await this.executionService.warmup();
    }
}
