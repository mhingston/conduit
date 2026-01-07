import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecutionContext } from '../core/execution.context.js';
import { ResourceLimits as ConduitResourceLimits } from '../core/config.service.js';
import { ConduitError } from '../core/request.controller.js';
import { resolveAssetPath } from '../core/asset.utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    error?: {
        code: number;
        message: string;
    };
}

export interface IPCInfo {
    ipcAddress: string;
    ipcToken: string;
    sdkCode?: string;
}

interface PooledWorker {
    worker: Worker;
    busy: boolean;
    runs: number;
    lastUsed: number;
}

export class PyodideExecutor {
    private shimContent: string = '';
    private pool: PooledWorker[] = [];
    private maxPoolSize = 3;
    private maxRunsPerWorker = 1;

    private getShim(): string {
        if (this.shimContent) return this.shimContent;
        try {
            const assetPath = resolveAssetPath('python-shim.py');
            this.shimContent = fs.readFileSync(assetPath, 'utf-8');
            return this.shimContent;
        } catch (err: any) {
            throw new Error(`Failed to load Python shim: ${err.message}`);
        }
    }

    private async getWorker(logger: any, limits?: ConduitResourceLimits): Promise<PooledWorker> {
        // Clean up old/idle workers if needed (stub for now)

        // Find available worker
        let pooled = this.pool.find(w => !w.busy);
        if (pooled) {
            pooled.busy = true;
            return pooled;
        }

        // Create new worker if pool not full
        if (this.pool.length < this.maxPoolSize) {
            logger.info('Creating new Pyodide worker for pool');
            const worker = this.createWorker(limits);
            pooled = { worker, busy: true, runs: 0, lastUsed: Date.now() };
            this.pool.push(pooled);

            // Wait for ready signal
            await new Promise<void>((resolve, reject) => {
                const onMessage = (msg: any) => {
                    if (msg.type === 'ready') {
                        worker.off('message', onMessage);
                        resolve();
                    }
                };
                worker.on('message', onMessage);
                worker.on('error', reject);
                setTimeout(() => reject(new Error('Worker init timeout')), 10000);
            });

            return pooled;
        }

        // Wait for a worker to become available
        return new Promise((resolve) => {
            const check = () => {
                const w = this.pool.find(pw => !pw.busy);
                if (w) {
                    w.busy = true;
                    resolve(w);
                } else {
                    setTimeout(check, 50);
                }
            };
            check();
        });
    }

    private createWorker(limits?: ConduitResourceLimits): Worker {
        let workerPath = path.resolve(__dirname, './pyodide.worker.js');
        if (!fs.existsSync(workerPath)) {
            workerPath = path.resolve(__dirname, './pyodide.worker.ts');
        }

        return new Worker(workerPath, {
            execArgv: process.execArgv.includes('--loader') ? process.execArgv : [],
            resourceLimits: limits ? {
                maxOldSpaceSizeMb: limits.memoryLimitMb,
                // Stack size and young generation are usually fine with defaults
            } as any : undefined
        });
    }

    async execute(code: string, limits: ConduitResourceLimits, context: ExecutionContext, ipcInfo?: IPCInfo): Promise<ExecutionResult> {
        const { logger } = context;
        const pooledWorker = await this.getWorker(logger, limits);
        const worker = pooledWorker.worker;

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                logger.warn('Python execution timed out, terminating worker');
                worker.terminate();
                // Remove from pool
                this.pool = this.pool.filter(w => w !== pooledWorker);
                resolve({
                    stdout: '',
                    stderr: 'Execution timed out',
                    exitCode: null,
                    error: {
                        code: ConduitError.RequestTimeout,
                        message: 'Execution timed out',
                    },
                });
            }, limits.timeoutMs);

            const onMessage = (msg: any) => {
                if (msg.type === 'ready' || msg.type === 'pong') return;

                clearTimeout(timeout);
                worker.off('message', onMessage);
                worker.off('error', onError);

                pooledWorker.busy = false;
                pooledWorker.runs++;
                pooledWorker.lastUsed = Date.now();

                // Recycle if too many runs
                if (pooledWorker.runs >= this.maxRunsPerWorker) {
                    logger.info('Recycling Pyodide worker after max runs');
                    worker.terminate();
                    this.pool = this.pool.filter(w => w !== pooledWorker);
                }

                if (msg.success) {
                    resolve({
                        stdout: msg.stdout,
                        stderr: msg.stderr,
                        exitCode: 0,
                    });
                } else {
                    logger.warn({ error: msg.error }, 'Python execution failed or limit breached, terminating worker');
                    worker.terminate();
                    this.pool = this.pool.filter(w => w !== pooledWorker);

                    logger.debug({ error: msg.error }, 'Python execution error from worker');
                    const normalizedError = (msg.error || '').toLowerCase();
                    const limitBreached = msg.limitBreached || '';

                    const isLogLimit = limitBreached === 'log' || normalizedError.includes('[limit_log]');
                    const isOutputLimit = limitBreached === 'output' || normalizedError.includes('[limit_output]');
                    const isAmbiguousLimit = !isOutputLimit && !isLogLimit && (normalizedError.includes('i/o error') || normalizedError.includes('errno 29') || normalizedError.includes('limit exceeded'));

                    resolve({
                        stdout: msg.stdout,
                        stderr: msg.stderr,
                        exitCode: 1,
                        error: {
                            code: isLogLimit ? ConduitError.LogLimitExceeded : ((isOutputLimit || isAmbiguousLimit) ? ConduitError.OutputLimitExceeded : ConduitError.InternalError),
                            message: isLogLimit ? 'Log entry limit exceeded' : ((isOutputLimit || isAmbiguousLimit) ? 'Output limit exceeded' : msg.error),
                        },
                    });
                }
            };

            const onError = (err: any) => {
                clearTimeout(timeout);
                worker.off('message', onMessage);
                worker.off('error', onError);

                logger.error({ err }, 'Pyodide worker error');
                worker.terminate();
                this.pool = this.pool.filter(w => w !== pooledWorker);

                resolve({
                    stdout: '',
                    stderr: err.message,
                    exitCode: null,
                    error: {
                        code: ConduitError.InternalError,
                        message: err.message,
                    },
                });
            };

            worker.on('message', onMessage);
            worker.on('error', onError);

            // Prepare shim with SDK injection
            let shim = this.getShim();
            if (ipcInfo?.sdkCode) {
                shim = shim.replace('# __CONDUIT_SDK_INJECTION__', ipcInfo.sdkCode);
            }

            worker.postMessage({
                type: 'execute',
                data: { code, limits, ipcInfo, shim }
            });
        });
    }

    async shutdown() {
        for (const pooled of this.pool) {
            await pooled.worker.terminate();
        }
        this.pool = [];
    }

    async healthCheck(): Promise<{ status: string; workers: number; detail?: string }> {
        try {
            // Find an available worker or create a temporary one for health check
            const pooled = await this.getWorker(console, {
                timeoutMs: 5000,
                memoryLimitMb: 128,
                maxOutputBytes: 1024,
                maxLogEntries: 10
            });

            return new Promise((resolve) => {
                let timeout: NodeJS.Timeout;

                const onMessage = (msg: any) => {
                    if (msg.type === 'pong') {
                        cleanup();
                        pooled.busy = false;
                        resolve({ status: 'ok', workers: this.pool.length });
                    }
                };

                const cleanup = () => {
                    clearTimeout(timeout);
                    pooled.worker.off('message', onMessage);
                };

                timeout = setTimeout(() => {
                    cleanup();
                    pooled.busy = false;
                    resolve({ status: 'error', workers: this.pool.length, detail: 'Health check timeout' });
                }, 2000);

                pooled.worker.on('message', onMessage);
                pooled.worker.postMessage({ type: 'ping' });
            });
        } catch (err: any) {
            return { status: 'error', workers: this.pool.length, detail: err.message };
        }
    }
}

