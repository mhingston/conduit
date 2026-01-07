import { ExecutionContext } from './execution.context.js';
import { Logger } from 'pino';
import { DenoExecutor } from '../executors/deno.executor.js';
import { PyodideExecutor } from '../executors/pyodide.executor.js';
import { IsolateExecutor } from '../executors/isolate.executor.js';
import { ResourceLimits } from './config.service.js';
import { GatewayService } from '../gateway/gateway.service.js';
import { SecurityService } from './security.service.js';
import { metrics } from './metrics.service.js';
import { ExecutionService } from './execution.service.js';
import { ExecutorRegistry } from './registries/executor.registry.js';
import { Middleware } from './interfaces/middleware.interface.js';
import { LoggingMiddleware } from './middleware/logging.middleware.js';
import { ErrorHandlingMiddleware } from './middleware/error.middleware.js';
import { AuthMiddleware } from './middleware/auth.middleware.js';
import { RateLimitMiddleware } from './middleware/ratelimit.middleware.js';

import { ConduitError, JSONRPCRequest, JSONRPCResponse } from './types.js';

export { ConduitError, JSONRPCRequest, JSONRPCResponse };

export class RequestController {
    private logger: Logger;
    private denoExecutor = new DenoExecutor();
    private pyodideExecutor = new PyodideExecutor();
    private isolateExecutor: IsolateExecutor | null = null;
    private executionService: ExecutionService;
    private gatewayService: GatewayService;
    private executorRegistry = new ExecutorRegistry();
    private defaultLimits: ResourceLimits;
    private middlewares: Middleware[] = [];

    constructor(logger: Logger, defaultLimits: ResourceLimits, gatewayService: GatewayService, securityService: SecurityService) {
        this.logger = logger;
        this.defaultLimits = defaultLimits;
        this.gatewayService = gatewayService;

        // Initialize executors
        this.isolateExecutor = new IsolateExecutor(logger, gatewayService);

        // Register executors
        this.executorRegistry.register('deno', this.denoExecutor);
        this.executorRegistry.register('python', this.pyodideExecutor);
        if (this.isolateExecutor) {
            this.executorRegistry.register('isolate', this.isolateExecutor);
        }

        this.executionService = new ExecutionService(
            logger,
            defaultLimits,
            gatewayService,
            securityService,
            this.executorRegistry
        );

        // Setup middleware pipeline
        this.use(new ErrorHandlingMiddleware());
        this.use(new LoggingMiddleware());
        this.use(new AuthMiddleware(securityService));
        this.use(new RateLimitMiddleware(securityService));
    }

    use(middleware: Middleware) {
        this.middlewares.push(middleware);
    }

    set ipcAddress(addr: string) {
        this.executionService.ipcAddress = addr;
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

    private async finalHandler(request: JSONRPCRequest, context: ExecutionContext): Promise<JSONRPCResponse> {
        const { method, params, id } = request;
        // Logging and metrics handled by middlewares now

        // Try/catch handled by ErrorMiddleware, but we handle logic errors here if needed
        // Actually routing logic should just throw and let middleware catch?
        // Or specific logic.

        switch (method) {
            case 'mcp.discoverTools':
                return this.handleDiscoverTools(params, context, id);
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
        await this.executorRegistry.shutdownAll();
    }

    async healthCheck() {
        const pyodideHealth = await this.pyodideExecutor.healthCheck();
        return {
            status: pyodideHealth.status === 'ok' ? 'ok' : 'error',
            pyodide: pyodideHealth
        };
    }

    async warmup() {
        await this.pyodideExecutor.warmup(this.defaultLimits);
    }
}
