import ivm from 'isolated-vm';
import { Logger } from 'pino';
import { ExecutionContext } from '../core/execution.context.js';
import { ResourceLimits } from '../core/config.service.js';
import { GatewayService } from '../gateway/gateway.service.js';
import { ConduitError } from '../core/types.js';

import type { Executor, ExecutorConfig, ExecutionResult } from '../core/interfaces/executor.interface.js';

export { ExecutionResult as IsolateExecutionResult };

/**
 * IsolateExecutor - In-process V8 isolate execution using isolated-vm.
 * 
 * Security model: Capability-based (not OS sandbox)
 * - Only approved functions exposed to isolate
 * - Hard time/memory limits
 * - No process/fs/net access
 */
export class IsolateExecutor implements Executor {
    private logger: Logger;
    private gatewayService: GatewayService;

    constructor(logger: Logger, gatewayService: GatewayService) {
        this.logger = logger;
        this.gatewayService = gatewayService;
    }

    async execute(
        code: string,
        limits: ResourceLimits,
        context: ExecutionContext,
        config?: ExecutorConfig
    ): Promise<ExecutionResult> {
        const logs: string[] = [];
        const errors: string[] = [];
        let isolate: ivm.Isolate | null = null;

        try {
            // Create isolate with memory limit
            isolate = new ivm.Isolate({ memoryLimit: limits.memoryLimitMb });
            const ctx = await isolate.createContext();
            const jail = ctx.global;

            let currentLogBytes = 0;
            let currentErrorBytes = 0;
            let totalLogEntries = 0;

            // Inject console.log/error for output capture
            await jail.set('__log', new ivm.Callback((msg: string) => {
                if (totalLogEntries + 1 > limits.maxLogEntries) {
                    throw new Error('[LIMIT_LOG_ENTRIES]');
                }
                if (currentLogBytes + msg.length + 1 > limits.maxOutputBytes) {
                    throw new Error('[LIMIT_LOG]');
                }

                totalLogEntries++;
                logs.push(msg);
                currentLogBytes += msg.length + 1; // +1 for newline approximation
            }));
            await jail.set('__error', new ivm.Callback((msg: string) => {
                if (totalLogEntries + 1 > limits.maxLogEntries) {
                    throw new Error('[LIMIT_LOG_ENTRIES]');
                }
                if (currentErrorBytes + msg.length + 1 > limits.maxOutputBytes) {
                    throw new Error('[LIMIT_OUTPUT]');
                }

                totalLogEntries++;
                errors.push(msg);
                currentErrorBytes += msg.length + 1;
            }));

            // Async tool bridge (ID-based to avoid Promise transfer issues)
            let requestIdCounter = 0;

            await jail.set('__dispatchToolCall', new ivm.Callback((nameStr: string, argsStr: string) => {
                const requestId = ++requestIdCounter;
                const name = nameStr;
                let args = {};
                try {
                    args = JSON.parse(argsStr);
                } catch (e) {
                    // ignore
                }

                // Process async
                this.gatewayService.callTool(name, args, context)
                    .then(res => {
                        // callback to isolate
                        return ctx.evalClosure(`resolveRequest($0, $1, null)`, [requestId, JSON.stringify(res)], { arguments: { copy: true } });
                    })
                    .catch(err => {
                        return ctx.evalClosure(`resolveRequest($0, null, $1)`, [requestId, err.message || 'Unknown error'], { arguments: { copy: true } });
                    })
                    .catch(e => {
                        // Ignore errors calling back into isolate (e.g. if disposed)
                    });

                return requestId;
            }));

            // Bootstrap code: create console and async handling
            const bootstrap = `
                const requests = new Map();
                
                // Host calls this to resolve requests
                globalThis.resolveRequest = (id, resultJson, error) => {
                    const req = requests.get(id);
                    if (req) {
                        requests.delete(id);
                        if (error) req.reject(new Error(error));
                        else req.resolve(resultJson);
                    }
                };

                // Internal tool call wrapper
                globalThis.__callTool = (name, argsJson) => {
                    return new Promise((resolve, reject) => {
                        const id = __dispatchToolCall(name, argsJson);
                        requests.set(id, { resolve, reject });
                    });
                };

                const format = (arg) => {
                    if (typeof arg === 'string') return arg;
                    if (arg instanceof Error) return arg.stack || arg.message;
                    if (typeof arg === 'object' && arg !== null && arg.message && arg.stack) return arg.stack; // Duck typing
                    return JSON.stringify(arg);
                };
                const console = {
                    log: (...args) => __log(args.map(format).join(' ')),
                    error: (...args) => __error(args.map(format).join(' ')),
                };
            `;
            const bootstrapScript = await isolate.compileScript(bootstrap);
            await bootstrapScript.run(ctx, { timeout: 1000 });

            // Inject SDK (typed tools or fallback)
            const sdkScript = config?.sdkCode || `
                const tools = {
                    $raw: async (name, args) => {
                        const resStr = await __callTool(name, JSON.stringify(args || {}));
                        return JSON.parse(resStr);
                    }
                };
            `;
            const compiledSdk = await isolate.compileScript(sdkScript);
            await compiledSdk.run(ctx, { timeout: 1000 });

            // Compile and run user code
            // Async completion tracking
            let executionPromiseResolve: () => void;
            const executionPromise = new Promise<void>((resolve) => {
                executionPromiseResolve = resolve;
            });
            await jail.set('__done', new ivm.Callback(() => {
                if (executionPromiseResolve) executionPromiseResolve();
            }));

            let scriptFailed = false;
            await jail.set('__setFailed', new ivm.Callback(() => {
                scriptFailed = true;
            }));

            // Compile and run user code
            // Wrap in async IIFE to support top-level await and track completion
            // Use 'void' to ensure the script returns undefined (transferrable) instead of a Promise
            const wrappedCode = `void (async () => {
                try {
                    ${code}
                } catch (err) {
                    console.error(err);
                    __setFailed();
                } finally {
                    __done();
                }
            })()`;

            const script = await isolate.compileScript(wrappedCode);

            // NOTE: Two timeouts exist intentionally:
            // 1. script.run timeout (below) - catches infinite synchronous loops
            // 2. Promise.race timeout (after) - catches stuck async operations (tool calls)
            // Tool calls may continue briefly after timeout; isolate.dispose() cleans up.

            // Start execution with synchronous timeout protection
            await script.run(ctx, { timeout: limits.timeoutMs });

            // Wait for completion or timeout
            let timedOut = false;
            const timeoutPromise = new Promise<void>((_, reject) => {
                setTimeout(() => {
                    timedOut = true;
                    reject(new Error('Script execution timed out'));
                }, limits.timeoutMs);
            });

            try {
                await Promise.race([executionPromise, timeoutPromise]);
            } catch (err: any) {
                if (err.message === 'Script execution timed out') {
                    return {
                        stdout: logs.join('\n'),
                        stderr: errors.join('\n'),
                        exitCode: null,
                        error: {
                            code: ConduitError.RequestTimeout,
                            message: 'Execution timed out',
                        },
                    };
                }
                throw err;
            }

            return {
                stdout: logs.join('\n'),
                stderr: errors.join('\n'),
                exitCode: scriptFailed ? 1 : 0,
            };
        } catch (err: any) {
            const message = err.message || 'Unknown error';

            // Handle specific error types
            if (message.includes('Script execution timed out')) {
                return {
                    stdout: logs.join('\n'),
                    stderr: errors.join('\n'),
                    exitCode: null,
                    error: {
                        code: ConduitError.RequestTimeout,
                        message: 'Execution timed out',
                    },
                };
            }

            if (message.includes('memory limit') || message.includes('disposed')) {
                return {
                    stdout: logs.join('\n'),
                    stderr: errors.join('\n'),
                    exitCode: null,
                    error: {
                        code: ConduitError.MemoryLimitExceeded,
                        message: 'Memory limit exceeded',
                    },
                };
            }

            if (message.includes('[LIMIT_LOG_ENTRIES]')) {
                return {
                    stdout: logs.join('\n'),
                    stderr: errors.join('\n'),
                    exitCode: null,
                    error: {
                        code: ConduitError.LogLimitExceeded,
                        message: 'Log entry limit exceeded',
                    },
                };
            }

            if (message.includes('[LIMIT_LOG]') || message.includes('[LIMIT_OUTPUT]')) {
                return {
                    stdout: logs.join('\n'),
                    stderr: errors.join('\n'),
                    exitCode: null,
                    error: {
                        code: ConduitError.OutputLimitExceeded,
                        message: 'Output limit exceeded',
                    },
                };
            }

            this.logger.error({ err }, 'Isolate execution failed');
            return {
                stdout: logs.join('\n'),
                stderr: message,
                exitCode: 1,
                error: {
                    code: ConduitError.InternalError,
                    message,
                },
            };
        } finally {
            if (isolate) {
                isolate.dispose();
            }
        }
    }

    async shutdown(): Promise<void> {
        // No-op
    }

    async healthCheck(): Promise<{ status: string; detail?: string }> {
        try {
            const isolate = new ivm.Isolate({ memoryLimit: 8 });
            isolate.dispose();
            return { status: 'ok' };
        } catch (err: any) {
            return { status: 'error', detail: err.message };
        }
    }

    async warmup(): Promise<void> {
        // No-op
    }
}
