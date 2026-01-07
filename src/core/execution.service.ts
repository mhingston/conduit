import { Logger } from 'pino';
import { DenoExecutor } from '../executors/deno.executor.js';
import { PyodideExecutor } from '../executors/pyodide.executor.js';
import { IsolateExecutor } from '../executors/isolate.executor.js';
import { ResourceLimits } from './config.service.js';
import { GatewayService } from '../gateway/gateway.service.js';
import { SecurityService } from './security.service.js';
import { SDKGenerator, toToolBinding } from '../sdk/index.js';
import { ExecutionContext } from './execution.context.js';
import { ConduitError } from './request.controller.js';

export interface ExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    error?: {
        code: number;
        message: string;
    };
}

export class ExecutionService {
    private logger: Logger;
    private denoExecutor: DenoExecutor;
    private pyodideExecutor: PyodideExecutor;
    private isolateExecutor: IsolateExecutor | null = null;
    private sdkGenerator = new SDKGenerator();
    private defaultLimits: ResourceLimits;
    private gatewayService: GatewayService;
    private securityService: SecurityService;
    private _ipcAddress: string = '';

    constructor(
        logger: Logger,
        defaultLimits: ResourceLimits,
        gatewayService: GatewayService,
        securityService: SecurityService,
        denoExecutor: DenoExecutor,
        pyodideExecutor: PyodideExecutor,
        isolateExecutor: IsolateExecutor | null = null
    ) {
        this.logger = logger;
        this.defaultLimits = defaultLimits;
        this.gatewayService = gatewayService;
        this.securityService = securityService;
        this.denoExecutor = denoExecutor;
        this.pyodideExecutor = pyodideExecutor;
        this.isolateExecutor = isolateExecutor;
    }

    set ipcAddress(addr: string) {
        this._ipcAddress = addr;
    }

    async executeTypeScript(
        code: string,
        limits: ResourceLimits,
        context: ExecutionContext,
        allowedTools?: string[]
    ): Promise<ExecutionResult> {
        const effectiveLimits = { ...this.defaultLimits, ...limits };

        // 1. Validation
        const securityResult = this.securityService.validateCode(code);
        if (!securityResult.valid) {
            return {
                stdout: '',
                stderr: '',
                exitCode: null,
                error: {
                    code: ConduitError.Forbidden,
                    message: securityResult.message || 'Access denied'
                }
            };
        }

        // 2. Routing Logic (Isolate vs Deno)
        const bashedCode = code.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, '');
        const hasImports = /^\s*import\s/m.test(bashedCode) ||
            /^\s*export\s/m.test(bashedCode) ||
            /\bDeno\./.test(bashedCode) ||
            /\bDeno\b/.test(bashedCode);

        if (!hasImports && this.isolateExecutor) {
            return this.executeIsolate(code, effectiveLimits, context, allowedTools);
        }

        // 3. SDK Generation
        const tools = await this.gatewayService.discoverTools(context);
        const bindings = tools.map(t => toToolBinding(t.name, t.inputSchema, t.description));
        const sdkCode = this.sdkGenerator.generateTypeScript(bindings, allowedTools);

        // 4. Session & Execution
        const sessionToken = this.securityService.createSession(allowedTools);
        try {
            return await this.denoExecutor.execute(code, effectiveLimits, context, {
                ipcAddress: this._ipcAddress,
                ipcToken: sessionToken,
                sdkCode
            });
        } finally {
            this.securityService.invalidateSession(sessionToken);
        }
    }

    async executePython(
        code: string,
        limits: ResourceLimits,
        context: ExecutionContext,
        allowedTools?: string[]
    ): Promise<ExecutionResult> {
        const effectiveLimits = { ...this.defaultLimits, ...limits };

        const securityResult = this.securityService.validateCode(code);
        if (!securityResult.valid) {
            return {
                stdout: '',
                stderr: '',
                exitCode: null,
                error: {
                    code: ConduitError.Forbidden,
                    message: securityResult.message || 'Access denied'
                }
            };
        }

        const tools = await this.gatewayService.discoverTools(context);
        const bindings = tools.map(t => toToolBinding(t.name, t.inputSchema, t.description));
        const sdkCode = this.sdkGenerator.generatePython(bindings, allowedTools);

        const sessionToken = this.securityService.createSession(allowedTools);
        try {
            return await this.pyodideExecutor.execute(code, effectiveLimits, context, {
                ipcAddress: this._ipcAddress,
                ipcToken: sessionToken,
                sdkCode
            });
        } finally {
            this.securityService.invalidateSession(sessionToken);
        }
    }

    async executeIsolate(
        code: string,
        limits: ResourceLimits,
        context: ExecutionContext,
        allowedTools?: string[]
    ): Promise<ExecutionResult> {
        if (!this.isolateExecutor) {
            return {
                stdout: '',
                stderr: '',
                exitCode: null,
                error: {
                    code: ConduitError.InternalError,
                    message: 'IsolateExecutor not available'
                }
            };
        }

        const effectiveLimits = { ...this.defaultLimits, ...limits };
        const securityResult = this.securityService.validateCode(code);
        if (!securityResult.valid) {
            return {
                stdout: '',
                stderr: '',
                exitCode: null,
                error: {
                    code: ConduitError.Forbidden,
                    message: securityResult.message || 'Access denied'
                }
            };
        }

        const tools = await this.gatewayService.discoverTools(context);
        const bindings = tools.map(t => toToolBinding(t.name, t.inputSchema, t.description));
        const sdkCode = this.sdkGenerator.generateIsolateSDK(bindings, allowedTools);

        try {
            return await this.isolateExecutor.execute(code, effectiveLimits, context, sdkCode);
        } catch (err: any) {
            return {
                stdout: '',
                stderr: '',
                exitCode: null,
                error: {
                    code: ConduitError.InternalError,
                    message: err.message
                }
            };
        }
    }
}
