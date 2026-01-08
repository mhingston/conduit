import { ExecutionContext } from './execution.context.js';
import { Logger } from 'pino';

import { GatewayService } from '../gateway/gateway.service.js';
import { metrics } from './metrics.service.js';
import { ExecutionService } from './execution.service.js';

import { Middleware } from './interfaces/middleware.interface.js';

import { ConduitError, JSONRPCRequest, JSONRPCResponse } from './types.js';

export { ConduitError, JSONRPCRequest, JSONRPCResponse };

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



    async handleRequest(request: JSONRPCRequest, context: ExecutionContext): Promise<JSONRPCResponse> {
        return this.executePipeline(request, context);
    }

    private async executePipeline(request: JSONRPCRequest, context: ExecutionContext): Promise<JSONRPCResponse> {
        let index = -1;

        const dispatch = async (i: number): Promise<JSONRPCResponse> => {
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

    private async finalHandler(request: JSONRPCRequest, context: ExecutionContext): Promise<JSONRPCResponse> {
        const { method, params, id } = request;
        // Logging and metrics handled by middlewares now

        // Try/catch handled by ErrorMiddleware, but we handle logic errors here if needed
        // Actually routing logic should just throw and let middleware catch?
        // Or specific logic.

        switch (method) {
            case 'mcp.discoverTools':
                return this.handleDiscoverTools(params, context, id);
            case 'mcp.listToolPackages':
                return this.handleListToolPackages(params, context, id);
            case 'mcp.listToolStubs':
                return this.handleListToolStubs(params, context, id);
            case 'mcp.readToolSchema':
                return this.handleReadToolSchema(params, context, id);
            case 'mcp.validateTool':
                return this.handleValidateTool(request, context);
            case 'mcp.callTool':
                return this.handleCallTool(params, context, id);
            case 'mcp.executeTypeScript':
                return this.handleExecuteTypeScript(params, context, id);
            case 'mcp.executePython':
                return this.handleExecutePython(params, context, id);
            case 'mcp.executeIsolate':
                return this.handleExecuteIsolate(params, context, id);
            default:
                // metrics.recordExecutionEnd is handled by LoggingMiddleware??
                // Wait, if 404, LoggingMiddleware records execution end?
                // Yes, handle() in LoggingMiddleware wraps next().
                return this.errorResponse(id, -32601, `Method not found: ${method}`);
        }
    }

    private async handleDiscoverTools(params: any, context: ExecutionContext, id: string | number): Promise<JSONRPCResponse> {
        const tools = await this.gatewayService.discoverTools(context);
        return {
            jsonrpc: '2.0',
            id,
            result: {
                tools,
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
        const { name, arguments: toolArgs } = params;
        const response = await this.gatewayService.callTool(name, toolArgs, context);
        return { ...response, id };
    }

    private async handleExecuteTypeScript(params: any, context: ExecutionContext, id: string | number): Promise<JSONRPCResponse> {
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

    private async handleExecuteIsolate(params: any, context: ExecutionContext, id: string | number): Promise<JSONRPCResponse> {
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
