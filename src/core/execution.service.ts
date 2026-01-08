import { Logger } from 'pino';
import { ExecutorRegistry } from './registries/executor.registry.js';
import { ResourceLimits } from './config.service.js';
import { GatewayService } from '../gateway/gateway.service.js';
import { SecurityService } from './security.service.js';
import { SDKGenerator, toToolBinding } from '../sdk/index.js';
import { ExecutionContext } from './execution.context.js';
import { ConduitError } from './types.js';
import { ExecutionResult } from './interfaces/executor.interface.js';

export { ExecutionResult };

export class ExecutionService {
    private logger: Logger;
    private executorRegistry: ExecutorRegistry;
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
        executorRegistry: ExecutorRegistry
    ) {
        this.logger = logger;
        this.defaultLimits = defaultLimits;
        this.gatewayService = gatewayService;
        this.securityService = securityService;
        this.executorRegistry = executorRegistry;
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
            return this.createErrorResult(ConduitError.Forbidden, securityResult.message || 'Access denied');
        }

        // 2. Routing Logic (Isolate vs Deno)
        const hasImports = /\bimport\b/.test(code) ||
            /\bexport\b/.test(code) ||
            /\bDeno\b/.test(code);

        // Try to use IsolateExecutor if available and code is simple
        if (!hasImports && this.executorRegistry.has('isolate')) {
            return await this.executeIsolate(code, effectiveLimits, context, allowedTools);
        }

        // Fix Sev2: Ensure IPC address is set before execution if Deno is needed
        if (!this._ipcAddress) {
            return this.createErrorResult(ConduitError.InternalError, 'IPC address not initialized');
        }

        // 3. Fallback to Deno
        if (!this.executorRegistry.has('deno')) {
            return this.createErrorResult(ConduitError.InternalError, 'Deno execution not available');
        }

        const executor = this.executorRegistry.get('deno')!;

        // 4. SDK Generation
        const bindings = await this.getToolBindings(context);
        const sdkCode = this.sdkGenerator.generateTypeScript(bindings, allowedTools);

        // 5. Session & Execution
        const sessionToken = this.securityService.createSession(allowedTools);
        try {
            return await executor.execute(code, effectiveLimits, context, {
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

        if (!this.executorRegistry.has('python')) {
            return this.createErrorResult(ConduitError.InternalError, 'Python execution not available');
        }

        // Fix Sev2: Ensure IPC address is set before execution for Python
        if (!this._ipcAddress) {
            return this.createErrorResult(ConduitError.InternalError, 'IPC address not initialized');
        }

        const executor = this.executorRegistry.get('python')!;

        const securityResult = this.securityService.validateCode(code);
        if (!securityResult.valid) {
            return this.createErrorResult(ConduitError.Forbidden, securityResult.message || 'Access denied');
        }

        const bindings = await this.getToolBindings(context);
        const sdkCode = this.sdkGenerator.generatePython(bindings, allowedTools);

        const sessionToken = this.securityService.createSession(allowedTools);
        try {
            return await executor.execute(code, effectiveLimits, context, {
                ipcAddress: this._ipcAddress,
                ipcToken: sessionToken,
                sdkCode
            });
        } finally {
            this.securityService.invalidateSession(sessionToken);
        }
    }

    private async getToolBindings(context: ExecutionContext) {
        // Phase 1: Lazy loading - fetch stubs instead of full schemas
        const packages = await this.gatewayService.listToolPackages();
        const allBindings = [];

        for (const pkg of packages) {
            try {
                // Determine if we need to fetch tools for this package
                // Optimization: if allowedTools is strict, we could filter packages here

                const stubs = await this.gatewayService.listToolStubs(pkg.id, context);
                allBindings.push(...stubs.map(s => toToolBinding(s.id, undefined, s.description)));
            } catch (err: any) {
                this.logger.warn({ packageId: pkg.id, err: err.message }, 'Failed to list stubs for package');
            }
        }
        return allBindings;
    }

    async executeIsolate(
        code: string,
        limits: ResourceLimits,
        context: ExecutionContext,
        allowedTools?: string[]
    ): Promise<ExecutionResult> {
        if (!this.executorRegistry.has('isolate')) {
            return this.createErrorResult(ConduitError.InternalError, 'IsolateExecutor not available');
        }
        const executor = this.executorRegistry.get('isolate')!;

        const effectiveLimits = { ...this.defaultLimits, ...limits };
        const securityResult = this.securityService.validateCode(code);
        if (!securityResult.valid) {
            return this.createErrorResult(ConduitError.Forbidden, securityResult.message || 'Access denied');
        }

        const bindings = await this.getToolBindings(context);
        const sdkCode = this.sdkGenerator.generateIsolateSDK(bindings, allowedTools);

        try {
            return await executor.execute(code, effectiveLimits, context, { sdkCode });
        } catch (err: any) {
            return this.createErrorResult(ConduitError.InternalError, err.message);
        }
    }

    private createErrorResult(code: number, message: string): ExecutionResult {
        return {
            stdout: '',
            stderr: '',
            exitCode: null,
            error: { code, message }
        };
    }

    async shutdown(): Promise<void> {
        await this.executorRegistry.shutdownAll();
    }

    async warmup(): Promise<void> {
        const pythonExecutor = this.executorRegistry.get('python');
        if (pythonExecutor && 'warmup' in pythonExecutor) {
            // Cast to any because warmup is not in general Executor interface yet
            await (pythonExecutor as any).warmup(this.defaultLimits);
        }
    }

    async healthCheck(): Promise<any> {
        const pythonExecutor = this.executorRegistry.get('python');
        if (pythonExecutor && 'healthCheck' in pythonExecutor) {
            return (pythonExecutor as any).healthCheck();
        }
        return { status: 'ok' };
    }
}
