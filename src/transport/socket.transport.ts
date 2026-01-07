import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Logger } from 'pino';
import { RequestController } from '../core/request.controller.js';
import { JSONRPCRequest, ConduitError } from '../core/types.js';
import { ExecutionContext } from '../core/execution.context.js';
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
    private concurrencyService: ConcurrencyService;

    constructor(
        logger: Logger,
        requestController: RequestController,
        concurrencyService: ConcurrencyService
    ) {
        this.logger = logger;
        this.requestController = requestController;
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

            // Backpressure: pause processing new chunks until this buffer is handled
            socket.pause();

            try {
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

                    const context = new ExecutionContext({
                        logger: this.logger,
                        remoteAddress: remoteAddress,
                    });

                    await loggerStorage.run({ correlationId: context.correlationId }, async () => {
                        try {
                            const response = await this.concurrencyService.run(() =>
                                this.requestController.handleRequest(request, context)
                            );
                            socket.write(JSON.stringify(response) + '\n');
                        } catch (err: any) {
                            if (err.name === 'QueueFullError') {
                                socket.write(JSON.stringify({
                                    jsonrpc: '2.0',
                                    id: request.id,
                                    error: {
                                        code: ConduitError.ServerBusy,
                                        message: 'Server busy'
                                    }
                                }) + '\n');
                            } else {
                                this.logger.error({ err, requestId: request.id }, 'Request handling failed');
                                // Internal error handling usually done by Middleware/RequestController return
                                // But if something crashed outside standard flow:
                                socket.write(JSON.stringify({
                                    jsonrpc: '2.0',
                                    id: request.id,
                                    error: {
                                        code: ConduitError.InternalError,
                                        message: 'Internal server error'
                                    }
                                }) + '\n');
                            }
                        }
                    });
                }
            } catch (err) {
                this.logger.error({ err }, 'Unexpected error in socket data handler');
                socket.destroy();
            } finally {
                socket.resume();
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
            if (this.server.listening) {
                this.server.close(() => {
                    this.logger.info('Transport server closed');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}
