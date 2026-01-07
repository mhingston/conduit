import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);
import fs from 'node:fs';
import path from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ExecutionContext } from '../core/execution.context.js';
import { ResourceLimits } from '../core/config.service.js';
import { ConduitError } from '../core/request.controller.js';
import { resolveAssetPath } from '../core/asset.utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { Executor, ExecutorConfig, ExecutionResult } from '../core/interfaces/executor.interface.js';

export { ExecutionResult };

// Deprecated: use ExecutorConfig
export interface IPCInfo {
    ipcAddress: string;
    ipcToken: string;
    sdkCode?: string;
}

export class DenoExecutor implements Executor {
    private shimContent: string = '';
    // Track active processes for cleanup
    // Using 'any' for the Set because ChildProcess type import can be finicky across node versions/types
    // but at runtime it is a ChildProcess
    private activeProcesses = new Set<any>();
    private readonly MAX_CONCURRENT_PROCESSES = 10;

    private getShim(): string {
        if (this.shimContent) return this.shimContent;
        try {
            const assetPath = resolveAssetPath('deno-shim.ts');
            this.shimContent = fs.readFileSync(assetPath, 'utf-8');
            return this.shimContent;
        } catch (err: any) {
            throw new Error(`Failed to load Deno shim: ${err.message}`);
        }
    }

    async execute(code: string, limits: ResourceLimits, context: ExecutionContext, config?: ExecutorConfig): Promise<ExecutionResult> {
        const { logger } = context;

        // Check concurrent process limit
        if (this.activeProcesses.size >= this.MAX_CONCURRENT_PROCESSES) {
            return {
                stdout: '',
                stderr: '',
                exitCode: null,
                error: {
                    code: ConduitError.ServerBusy,
                    message: 'Too many concurrent Deno processes'
                }
            };
        }

        let stdout = '';
        let stderr = '';
        let totalOutputBytes = 0;
        let totalLogEntries = 0;
        let isTerminated = false;

        let shim = this.getShim()
            .replace('__CONDUIT_IPC_ADDRESS__', config?.ipcAddress || '')
            .replace('__CONDUIT_IPC_TOKEN__', config?.ipcToken || '');

        if (shim.includes('__CONDUIT_IPC_ADDRESS__')) {
            throw new Error('Failed to inject IPC address into Deno shim');
        }
        if (shim.includes('__CONDUIT_IPC_TOKEN__')) {
            throw new Error('Failed to inject IPC token into Deno shim');
        }

        // Inject SDK if provided
        if (config?.sdkCode) {
            shim = shim.replace('// __CONDUIT_SDK_INJECTION__', config.sdkCode);
            if (shim.includes('// __CONDUIT_SDK_INJECTION__')) {
                // Should have been replaced
                throw new Error('Failed to inject SDK code into Deno shim');
            }
        }

        const fullCode = shim + '\n' + code;

        // Use --v8-flags for memory limit if possible, or monitor RSS
        // Deno 2.x supports --v8-flags
        const args = [
            'run',
            `--v8-flags=--max-heap-size=${limits.memoryLimitMb}`,
        ];

        // Security: Restrict permissions. 
        // We only allow network access to the IPC host if it's a TCP address.
        // Unix sockets don't need --allow-net.
        if (config?.ipcAddress && !config.ipcAddress.includes('/') && !config.ipcAddress.includes('\\')) {
            try {
                // Use URL parser to safely extract hostname (handles IPv6 brackets and ports correctly)
                // Prepend http:// to ensure it parses as a valid URL structure
                const url = new URL(`http://${config.ipcAddress}`);
                let normalizedHost = url.hostname;

                // Remove brackets from IPv6 addresses if present (e.g., [::1] -> ::1)
                normalizedHost = normalizedHost.replace(/[\[\]]/g, '');

                if (normalizedHost === '0.0.0.0' || normalizedHost === '::' || normalizedHost === '::1' || normalizedHost === '') {
                    normalizedHost = '127.0.0.1';
                }
                args.push(`--allow-net=${normalizedHost}`);
            } catch (err) {
                // If address is malformed, we simply don't add the permission
                logger.warn({ address: config.ipcAddress, err }, 'Failed to parse IPC address for Deno permissions');
            }
        } else {
            // No network by default
        }

        args.push('-'); // Read from stdin

        // logger.info({ args }, 'Spawning Deno');
        const child = spawn('deno', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                TMPDIR: process.env.TMPDIR,
            }
        });

        this.activeProcesses.add(child);

        child.on('spawn', () => {
            // logger.info('Deno process spawned');
        });

        const cleanupProcess = () => {
            this.activeProcesses.delete(child);
        };

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                if (!isTerminated) {
                    isTerminated = true;
                    if (typeof (monitorInterval as any) !== 'undefined') clearInterval(monitorInterval);
                    child.kill('SIGKILL');
                    logger.warn('Execution timed out, SIGKILL sent');
                    cleanupProcess();
                    resolve({
                        stdout,
                        stderr,
                        exitCode: null,
                        error: {
                            code: ConduitError.RequestTimeout,
                            message: 'Execution timed out',
                        },
                    });
                }
            }, limits.timeoutMs);

            // RSS Monitoring loop
            // Optimization: increased interval to 2s and added platform check
            const isWindows = platform() === 'win32';
            const monitorInterval = setInterval(async () => {
                if (isTerminated || !child.pid) {
                    clearInterval(monitorInterval);
                    return;
                }
                try {
                    let rssMb = 0;
                    if (isWindows) {
                        try {
                            // Windows: tasklist /FI "PID eq <pid>" /FO CSV /NH
                            // Output: "deno.exe","1234","Console","1","12,345 K"
                            const { stdout: tasklistOut } = await execAsync(`tasklist /FI "PID eq ${child.pid}" /FO CSV /NH`);
                            const match = tasklistOut.match(/"([^"]+ K)"$/m); // Matches the last column with K
                            if (match) {
                                // Remove ' K' and ',' then parse
                                const memStr = match[1].replace(/[ K,]/g, '');
                                const memKb = parseInt(memStr, 10);
                                if (!isNaN(memKb)) {
                                    rssMb = memKb / 1024;
                                }
                            }
                        } catch (e) {
                            // tasklist might fail if process gone
                        }
                    } else {
                        // On Mac/Linux, ps -o rss= -p [pid] returns RSS in KB
                        const { stdout: rssStdout } = await execAsync(`ps -o rss= -p ${child.pid}`);
                        const rssKb = parseInt(rssStdout.trim());
                        if (!isNaN(rssKb)) {
                            rssMb = rssKb / 1024;
                        }
                    }

                    if (rssMb > limits.memoryLimitMb) {
                        isTerminated = true;
                        if (typeof (monitorInterval as any) !== 'undefined') clearInterval(monitorInterval);
                        child.kill('SIGKILL');
                        logger.warn({ rssMb, limitMb: limits.memoryLimitMb }, 'Deno RSS limit exceeded, SIGKILL sent');
                        cleanupProcess();
                        resolve({
                            stdout,
                            stderr,
                            exitCode: null,
                            error: {
                                code: ConduitError.MemoryLimitExceeded,
                                message: `Memory limit exceeded: ${rssMb.toFixed(2)}MB > ${limits.memoryLimitMb}MB`,
                            },
                        });
                    }
                } catch (err) {
                    // Process might have exited already or ps failed
                    clearInterval(monitorInterval);
                }
            }, 2000); // Check every 2000ms

            child.stdout.on('data', (chunk: Buffer) => {
                if (isTerminated) return;

                totalOutputBytes += chunk.length;
                const newLines = (chunk.toString().match(/\n/g) || []).length;
                totalLogEntries += newLines;

                if (totalOutputBytes > limits.maxOutputBytes || totalLogEntries > limits.maxLogEntries) {
                    isTerminated = true;
                    if (typeof (monitorInterval as any) !== 'undefined') clearInterval(monitorInterval);
                    child.kill('SIGKILL');
                    logger.warn({ bytes: totalOutputBytes, lines: totalLogEntries }, 'Limits exceeded, SIGKILL sent');
                    cleanupProcess();
                    resolve({
                        stdout: stdout + chunk.toString().slice(0, limits.maxOutputBytes - (totalOutputBytes - chunk.length)),
                        stderr,
                        exitCode: null,
                        error: {
                            code: totalOutputBytes > limits.maxOutputBytes ? ConduitError.OutputLimitExceeded : ConduitError.LogLimitExceeded,
                            message: totalOutputBytes > limits.maxOutputBytes ? 'Output limit exceeded' : 'Log entry limit exceeded',
                        },
                    });
                    return;
                }
                stdout += chunk.toString();
            });

            child.stderr.on('data', (chunk: Buffer) => {
                if (isTerminated) return;

                totalOutputBytes += chunk.length;
                const newLines = (chunk.toString().match(/\n/g) || []).length;
                totalLogEntries += newLines;

                if (totalOutputBytes > limits.maxOutputBytes || totalLogEntries > limits.maxLogEntries) {
                    isTerminated = true;
                    if (typeof (monitorInterval as any) !== 'undefined') clearInterval(monitorInterval);
                    child.kill('SIGKILL');
                    logger.warn({ bytes: totalOutputBytes, lines: totalLogEntries }, 'Limits exceeded, SIGKILL sent');
                    cleanupProcess();
                    resolve({
                        stdout,
                        stderr: stderr + chunk.toString().slice(0, limits.maxOutputBytes - (totalOutputBytes - chunk.length)),
                        exitCode: null,
                        error: {
                            code: totalOutputBytes > limits.maxOutputBytes ? ConduitError.OutputLimitExceeded : ConduitError.LogLimitExceeded,
                            message: totalOutputBytes > limits.maxOutputBytes ? 'Output limit exceeded' : 'Log entry limit exceeded',
                        },
                    });
                    return;
                }
                stderr += chunk.toString();
            });

            child.on('close', (code) => {
                clearTimeout(timeout);
                if (typeof (monitorInterval as any) !== 'undefined') clearInterval(monitorInterval);
                cleanupProcess();
                if (isTerminated) return; // Already resolved via timeout or limit

                resolve({
                    stdout,
                    stderr,
                    exitCode: code,
                });
            });

            child.on('error', (err) => {
                clearTimeout(timeout);
                logger.error({ err }, 'Child process error');
                cleanupProcess();
                resolve({
                    stdout,
                    stderr,
                    exitCode: null,
                    error: {
                        code: ConduitError.InternalError,
                        message: err.message,
                    },
                });
            });

            // Write code to stdin
            child.stdin.write(fullCode);
            child.stdin.end();
        });
    }

    async shutdown() {
        for (const child of this.activeProcesses) {
            try {
                child.kill('SIGKILL');
            } catch (err) {
                // Ignore, process might be dead already
            }
        }
        this.activeProcesses.clear();
    }
}
