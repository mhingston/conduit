import { ExecutionContext } from './execution.context.js';
import { Logger } from 'pino';
import { DenoExecutor } from '../executors/deno.executor.js';
import { PyodideExecutor } from '../executors/pyodide.executor.js';
import { IsolateExecutor } from '../executors/isolate.executor.js';
import { ResourceLimits } from './config.service.js';
import { GatewayService } from '../gateway/gateway.service.js';
import { SecurityService } from './security.service.js';
import { metrics } from './metrics.service.js';
import { SDKGenerator, toToolBinding } from '../sdk/index.js';

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
    private sdkGenerator = new SDKGenerator();
    private defaultLimits: ResourceLimits;
    private gatewayService: GatewayService;
    private securityService: SecurityService;
    private _ipcAddress: string = '';

    constructor(logger: Logger, defaultLimits: ResourceLimits, gatewayService: GatewayService, securityService: SecurityService) {
        this.logger = logger;
        this.defaultLimits = defaultLimits;
        this.gatewayService = gatewayService;
        this.securityService = securityService;
        this.isolateExecutor = new IsolateExecutor(logger, gatewayService);
    }

    set ipcAddress(addr: string) {
        this._ipcAddress = addr;
    }

    get ipcAddress(): string {
        return this._ipcAddress;
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

        const bashedCode = code.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, ''); // Simple comment strip to avoid false positives
        const hasImports = /^\s*import\s/m.test(bashedCode) ||
            /^\s*export\s/m.test(bashedCode) ||
            /\bDeno\./.test(bashedCode) ||
            /\bDeno\b/.test(bashedCode); // Match 'Deno' global usage

        if (!hasImports && this.isolateExecutor) {
            // Use IsolateExecutor for simple scripts (Phase 3c)
            return this.handleExecuteIsolate(params, context, id);
        }

        // Fallback to DenoExecutor for complex scripts / modules
        const effectiveLimits = { ...this.defaultLimits, ...limits };

        if (Array.isArray(allowedTools)) {
            context.allowedTools = allowedTools;
        }

        const securityResult = this.securityService.validateCode(code);
        if (!securityResult.valid) {
            return this.errorResponse(id, ConduitError.Forbidden, securityResult.message || 'Access denied');
        }

        // Generate SDK from discovered tools
        const tools = await this.gatewayService.discoverTools(context);
        const bindings = tools.map(t => toToolBinding(t.name, t.inputSchema, t.description));
        const sdkCode = this.sdkGenerator.generateTypeScript(bindings, allowedTools as string[] | undefined);

        const sessionToken = this.securityService.createSession(allowedTools as string[] | undefined);
        try {
            const result = await this.denoExecutor.execute(code, effectiveLimits, context, {
                ipcAddress: this._ipcAddress,
                ipcToken: sessionToken,
                sdkCode
            });

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
        } finally {
            this.securityService.invalidateSession(sessionToken);
        }
    }

    private async handleExecutePython(params: any, context: ExecutionContext, id: string | number): Promise<JSONRPCResponse> {
        const { code, limits, allowedTools } = params;
        const effectiveLimits = { ...this.defaultLimits, ...limits };

        if (Array.isArray(allowedTools)) {
            context.allowedTools = allowedTools;
        }

        const securityResult = this.securityService.validateCode(code);
        if (!securityResult.valid) {
            return this.errorResponse(id, ConduitError.Forbidden, securityResult.message || 'Access denied');
        }

        // Generate SDK from discovered tools
        const tools = await this.gatewayService.discoverTools(context);
        const bindings = tools.map(t => toToolBinding(t.name, t.inputSchema, t.description));
        const sdkCode = this.sdkGenerator.generatePython(bindings, allowedTools as string[] | undefined);

        const sessionToken = this.securityService.createSession(allowedTools as string[] | undefined);
        try {
            const result = await this.pyodideExecutor.execute(code, effectiveLimits, context, {
                ipcAddress: this._ipcAddress,
                ipcToken: sessionToken,
                sdkCode
            });

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
        } finally {
            this.securityService.invalidateSession(sessionToken);
        }
    }

    private async handleExecuteIsolate(params: any, context: ExecutionContext, id: string | number): Promise<JSONRPCResponse> {
        const { code, limits, allowedTools } = params;
        const effectiveLimits = { ...this.defaultLimits, ...limits };

        if (Array.isArray(allowedTools)) {
            context.allowedTools = allowedTools;
        }

        const securityResult = this.securityService.validateCode(code);
        if (!securityResult.valid) {
            return this.errorResponse(id, ConduitError.Forbidden, securityResult.message || 'Access denied');
        }

        if (!this.isolateExecutor) {
            return this.errorResponse(id, ConduitError.InternalError, 'IsolateExecutor not available');
        }

        try {
            // New: Generate SDK for IsolateExecutor
            const tools = await this.gatewayService.discoverTools(context);
            const bindings = tools.map(t => toToolBinding(t.name, t.inputSchema, t.description));
            const sdkCode = this.sdkGenerator.generateIsolateSDK(bindings, allowedTools as string[] | undefined);

            const result = await this.isolateExecutor.execute(code, effectiveLimits, context, sdkCode);

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
        } catch (err: any) {
            return this.errorResponse(id, ConduitError.InternalError, err.message);
        }
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
            // Deno uses child processes that are killed after each run, 
            // but if we ever add a Deno pool, we'd shut it down here.
        ]);
    }

    async healthCheck() {
        const pyodideHealth = await this.pyodideExecutor.healthCheck();
        return {
            status: pyodideHealth.status === 'ok' ? 'ok' : 'error',
            pyodide: pyodideHealth
        };
    }
}
