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
                    // Optionally send ParseError (-32700)
                    continue;
                }

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
