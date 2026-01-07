import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Logger } from 'pino';
import { RequestController, JSONRPCRequest, ConduitError } from '../core/request.controller.js';
import { ExecutionContext } from '../core/execution.context.js';
import { SecurityService } from '../core/security.service.js';
import { ConcurrencyService } from '../core/concurrency.service.js';
import { loggerStorage } from '../core/logger.js';

export interface TransportOptions {
    path?: string; // For Unix Socket or Named Pipe
    port?: number; // For TCP (development)
    host?: string;
}

export class SocketTransport {
    private server: net.Server;
    private logger: Logger;
    private requestController: RequestController;
    private securityService: SecurityService;
    private concurrencyService: ConcurrencyService;

    constructor(
        logger: Logger,
        requestController: RequestController,
        securityService: SecurityService,
        concurrencyService: ConcurrencyService
    ) {
        this.logger = logger;
        this.requestController = requestController;
        this.securityService = securityService;
        this.concurrencyService = concurrencyService;
        this.server = net.createServer((socket) => {
            this.handleConnection(socket);
        });

        this.server.on('error', (err) => {
            this.logger.error({ err }, 'Server error');
        });
    }

    async listen(options: TransportOptions): Promise<string> {
        return new Promise((resolve, reject) => {
            if (options.path) {
                // Strict IPC mode
                const socketPath = this.formatSocketPath(options.path);
                this.logger.info({ socketPath }, 'Binding to IPC socket');

                // Cleanup existing socket if needed (unlikely on Windows, but good for Unix)
                if (os.platform() !== 'win32' && path.isAbsolute(socketPath)) {
                    // We rely on caller or deployment to clean up, or error out. 
                    // Trying to unlink here might be dangerous if we don't own it.
                    // But strictly, we should just listen.
                }

                this.server.listen(socketPath, () => {
                    this.resolveAddress(resolve);
                });
            } else if (options.port !== undefined) {
                // Strict TCP mode
                this.logger.info({ port: options.port, host: options.host }, 'Binding to TCP port');
                this.server.listen(options.port, options.host || '127.0.0.1', () => {
                    this.resolveAddress(resolve);
                });
            } else {
                reject(new Error('Invalid transport configuration: neither path nor port provided'));
                return;
            }

            this.server.on('error', reject);
        });
    }

    private resolveAddress(resolve: (value: string) => void) {
        const address = this.server.address();
        const addressStr = typeof address === 'string' ? address : `${address?.address}:${address?.port}`;
        this.logger.info({ address: addressStr }, 'Transport server listening');
        resolve(addressStr);
    }

    private formatSocketPath(inputPath: string): string {
        if (os.platform() === 'win32') {
            // Windows Named Pipe format: \\.\pipe\conduit-[id]
            if (!inputPath.startsWith('\\\\.\\pipe\\')) {
                return `\\\\.\\pipe\\${inputPath}`;
            }
            return inputPath;
        } else {
            // Unix Socket path
            return path.isAbsolute(inputPath) ? inputPath : path.join(os.tmpdir(), inputPath);
        }
    }

    private handleConnection(socket: net.Socket) {
        const remoteAddress = socket.remoteAddress || 'pipe';
        this.logger.debug({ remoteAddress }, 'New connection established');

        socket.setEncoding('utf8');
        let buffer = '';
        const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB limit

        socket.on('data', async (chunk) => {
            buffer += chunk;

            if (buffer.length > MAX_BUFFER_SIZE) {
                this.logger.error({ remoteAddress }, 'Connection exceeded max buffer size, closing');
                socket.destroy();
                return;
            }

            // Robust NDJSON framing
            let pos: number;
            while ((pos = buffer.indexOf('\n')) >= 0) {
                const line = buffer.substring(0, pos).trim();
                buffer = buffer.substring(pos + 1);

                if (!line) continue;

                let request: JSONRPCRequest;
                try {
                    request = JSON.parse(line) as JSONRPCRequest;
                } catch (err) {
                    this.logger.error({ err, line }, 'Failed to parse JSON-RPC request');
                    const errorResponse = {
                        jsonrpc: '2.0',
                        id: null,
                        error: {
                            code: -32700,
                            message: 'Parse error',
                        },
                    };
                    socket.write(JSON.stringify(errorResponse) + '\n');
                    continue;
                }

                // Pause the socket to apply backpressure if needed during heavy processing
                // Though nodejs single thread makes true parallel processing moot here, 
                // it signals intent and can help if we offload to workers more aggressively later.
                // For now, simple queue management in ConcurrencyService handles the load.
                // But we should pause if the buffer gets too large (already handled by MAX_BUFFER_SIZE check above)
                // or if the processing queue is saturated (ConcurrencyService handles rejection).
                
                // Better backpressure:
                // If ConcurrencyService queue is full, we reject.
                // If we want to slow down the sender, we should pause() here and resume() after processing.
                // However, doing that for *every* request makes us serial. 
                // We want concurrent processing up to a limit.
                // So we don't pause by default unless we are truly overwhelmed or implementing flow control.
                
                // Let's implement the backpressure fix requested: 
                // "Use socket.pause() when buffer/queue is full and socket.resume() when processed."
                // Since we process lines sequentially here anyway (the while loop), 
                // pausing effectively serializes the *ingestion* of commands from the buffer.
                // If handleRequest is async and we await it (we do inside concurrencyService.run),
                // then we are already exerting backpressure because we don't read the next line until this one finishes?
                // NO: The `socket.on('data')` fires whenever data arrives. The `while` loop processes sync.
                // BUT `concurrencyService.run` is async. We are NOT awaiting it in the loop properly if we fire and forget or if we want parallelism.
                // Wait, line 191: `const response = await this.concurrencyService.run(...)`.
                // We ARE awaiting the response before processing the next line in the buffer (synchronous while loop).
                // AND we are inside an async `on('data')` handler.
                // So if `data` events come in faster than we process, they pile up in `buffer`.
                
                // To exert TCP backpressure, we should pause the socket if the buffer gets large, 
                // OR simply pause it while we are processing this chunk if we want to be safe.
                
                // Correct logic for backpressure based on findings:
                // We are inside an async callback for 'data'. If we await inside it, the stream is NOT automatically paused.
                // New 'data' events can fire while we are awaiting.
                // So `buffer` grows.
                
                socket.pause(); // Pause reading new data while we process this batch
                try {
                    const providedToken = request.auth?.bearerToken;
                    const session = providedToken ? this.securityService.getSession(providedToken) : undefined;

                    const allowedTools = session ? session.allowedTools : request.params?.allowedTools;

                    const context = new ExecutionContext({
                        logger: this.logger,
                        allowedTools: Array.isArray(allowedTools) ? allowedTools : undefined
                    });

                    await loggerStorage.run({ correlationId: context.correlationId }, async () => {
                        // Validate bearer token & Permissions
                        const token = providedToken || '';
                        const isMaster = token === this.securityService.getIpcToken();
                        const isSession = this.securityService.validateIpcToken(token) && !isMaster;

                        if (!isMaster && !isSession) {
                            const errorResponse = {
                                jsonrpc: '2.0',
                                id: request.id,
                                error: {
                                    code: -32003,
                                    message: 'Invalid bearer token'
                                }
                            };
                            socket.write(JSON.stringify(errorResponse) + '\n');
                            return;
                        }

                        // Strict scoping for session tokens
                        if (isSession) {
                            const allowedMethods = ['mcp.discoverTools', 'mcp.callTool'];
                            if (!allowedMethods.includes(request.method)) {
                                const errorResponse = {
                                    jsonrpc: '2.0',
                                    id: request.id,
                                    error: {
                                        code: ConduitError.Forbidden,
                                        message: 'Session tokens are restricted to tool discovery and calling only'
                                    }
                                };
                                socket.write(JSON.stringify(errorResponse) + '\n');
                                return;
                            }
                        }

                        // Rate limiting
                        const rateLimitKey = providedToken || socket.remoteAddress || 'unknown';
                        if (!this.securityService.checkRateLimit(rateLimitKey)) {
                            const errorResponse = {
                                jsonrpc: '2.0',
                                id: request.id,
                                error: {
                                    code: -32005,
                                    message: 'Rate limit exceeded'
                                }
                            };
                            socket.write(JSON.stringify(errorResponse) + '\n');
                            return;
                        }

                        const response = await this.concurrencyService.run(() =>
                            this.requestController.handleRequest(request, context)
                        );
                        socket.write(JSON.stringify(response) + '\n');
                    });
                } catch (err: any) {
                    if (err.name === 'QueueFullError') {
                        socket.write(JSON.stringify({
                            jsonrpc: '2.0',
                            id: request.id, // Now safely accessible
                            error: {
                                code: ConduitError.ServerBusy,
                                message: 'Server busy'
                            }
                        }) + '\n');
                    } else {
                        this.logger.error({ err, requestId: request.id }, 'Request handling failed');
                        // Consider sending internal error to client if not already handled
                    }
                } finally {
                    socket.resume(); // Resume reading after processing the command (or batch of commands)
                }
            }
        });

        socket.on('close', () => {
            this.logger.debug({ remoteAddress }, 'Connection closed');
        });

        socket.on('error', (err) => {
            this.logger.error({ err, remoteAddress }, 'Socket error');
        });
    }

    async close(): Promise<void> {
        return new Promise((resolve) => {
            this.server.close(() => {
                this.logger.info('Transport server closed');
                resolve();
            });
        });
    }
}
