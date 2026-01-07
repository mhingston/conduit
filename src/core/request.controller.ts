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

export enum ConduitError {
    InternalError = -32603,
    RequestTimeout = -32008,
    Forbidden = -32003,
    OutputLimitExceeded = -32013,
    MemoryLimitExceeded = -32009,
    LogLimitExceeded = -32014,
    ServerBusy = -32000,
}

export interface JSONRPCRequest {
    jsonrpc: '2.0';
    id: string | number;
    method: string;
    params?: any;
    auth?: {
        bearerToken: string;
    };
}

export interface JSONRPCResponse {
    jsonrpc: '2.0';
    id: string | number;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}

export class RequestController {
    private logger: Logger;
    private denoExecutor = new DenoExecutor();
    private pyodideExecutor = new PyodideExecutor();
    private isolateExecutor: IsolateExecutor | null = null;
    private executionService: ExecutionService;
    private gatewayService: GatewayService;

    constructor(logger: Logger, defaultLimits: ResourceLimits, gatewayService: GatewayService, securityService: SecurityService) {
        this.logger = logger;
        this.gatewayService = gatewayService;
        this.isolateExecutor = new IsolateExecutor(logger, gatewayService);
        this.executionService = new ExecutionService(
            logger,
            defaultLimits,
            gatewayService,
            securityService,
            this.denoExecutor,
            this.pyodideExecutor,
            this.isolateExecutor
        );
    }

    set ipcAddress(addr: string) {
        this.executionService.ipcAddress = addr;
    }

    async handleRequest(request: JSONRPCRequest, context: ExecutionContext): Promise<JSONRPCResponse> {
        const { method, params, id } = request;
        const childLogger = context.logger.child({ method, id });

        metrics.recordExecutionStart();
        const startTime = Date.now();

        try {
            let response: JSONRPCResponse;
            switch (method) {
                case 'mcp.discoverTools':
                    response = await this.handleDiscoverTools(params, context, id);
                    break;
                case 'mcp.callTool':
                    response = await this.handleCallTool(params, context, id);
                    break;
                case 'mcp.executeTypeScript':
                    response = await this.handleExecuteTypeScript(params, context, id);
                    break;
                case 'mcp.executePython':
                    response = await this.handleExecutePython(params, context, id);
                    break;
                case 'mcp.executeIsolate':
                    response = await this.handleExecuteIsolate(params, context, id);
                    break;
                default:
                    response = this.errorResponse(id, -32601, `Method not found: ${method}`);
            }
            metrics.recordExecutionEnd(Date.now() - startTime, method);
            return response;
        } catch (err: any) {
            childLogger.error({ err }, 'Error handling request');
            metrics.recordExecutionEnd(Date.now() - startTime, method);
            return this.errorResponse(id, ConduitError.InternalError, err.message);
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
        await Promise.all([
            this.pyodideExecutor.shutdown(),
            this.denoExecutor.shutdown(),
        ]);
    }

    async healthCheck() {
        const pyodideHealth = await this.pyodideExecutor.healthCheck();
        return {
            status: pyodideHealth.status === 'ok' ? 'ok' : 'error',
            pyodide: pyodideHealth
        };
    }

    async warmup() {
        await this.pyodideExecutor.warmup(this.executionService['defaultLimits']);
    }
}
