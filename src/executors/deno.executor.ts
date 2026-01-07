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

export class DenoExecutor {
    private shimContent: string = '';

    private getShim(): string {
        if (this.shimContent) return this.shimContent;
        try {
            // Shims are in dist/assets, and we are in dist/executors (or src/executors)
            const assetPath = path.resolve(__dirname, '../assets/deno-shim.ts');
            this.shimContent = fs.readFileSync(assetPath, 'utf-8');
            return this.shimContent;
        } catch (err) {
            console.warn('Failed to load Deno shim, using empty fallback');
            return '';
        }
    }

    async execute(code: string, limits: ResourceLimits, context: ExecutionContext, ipcInfo?: IPCInfo): Promise<ExecutionResult> {
        const { logger } = context;
        let stdout = '';
        let stderr = '';
        let totalOutputBytes = 0;
        let totalLogEntries = 0;
        let isTerminated = false;

        let shim = this.getShim()
            .replace('__CONDUIT_IPC_ADDRESS__', ipcInfo?.ipcAddress || '')
            .replace('__CONDUIT_IPC_TOKEN__', ipcInfo?.ipcToken || '');

        // Inject SDK if provided
        if (ipcInfo?.sdkCode) {
            shim = shim.replace('// __CONDUIT_SDK_INJECTION__', ipcInfo.sdkCode);
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
        if (ipcInfo?.ipcAddress && !ipcInfo.ipcAddress.includes('/') && !ipcInfo.ipcAddress.includes('\\')) {
            const host = ipcInfo.ipcAddress.split(':')[0];
            let normalizedHost = host.replace(/[\[\]]/g, '');
            if (normalizedHost === '0.0.0.0' || normalizedHost === '::' || normalizedHost === '::1' || normalizedHost === '') {
                normalizedHost = '127.0.0.1';
            }
            args.push(`--allow-net=${normalizedHost}`);
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

        child.on('spawn', () => {
            // logger.info('Deno process spawned');
        });

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                if (!isTerminated) {
                    isTerminated = true;
                    if (typeof (monitorInterval as any) !== 'undefined') clearInterval(monitorInterval);
                    child.kill('SIGKILL');
                    logger.warn('Execution timed out, SIGKILL sent');
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
}
