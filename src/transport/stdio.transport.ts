import { Logger } from 'pino';
import { RequestController } from '../core/request.controller.js';
import { JSONRPCRequest, ConduitError } from '../core/types.js';
import { ExecutionContext } from '../core/execution.context.js';
import { ConcurrencyService } from '../core/concurrency.service.js';
import { loggerStorage } from '../core/logger.js';

export class StdioTransport {
    private logger: Logger;
    private requestController: RequestController;
    private concurrencyService: ConcurrencyService;
    private buffer: string = '';
    private pendingRequests = new Map<string | number, (response: any) => void>();

    constructor(
        logger: Logger,
        requestController: RequestController,
        concurrencyService: ConcurrencyService
    ) {
        this.logger = logger;
        this.requestController = requestController;
        this.concurrencyService = concurrencyService;
    }

    async start(): Promise<void> {
        this.logger.info('Starting Stdio transport');

        process.stdin.setEncoding('utf8');
        process.stdin.on('data', this.handleData.bind(this));

        // Handle stream end if necessary, though usually main process exit handles this
        process.stdin.on('end', () => {
            this.logger.info('Stdin closed');
        });
    }

    async callHost(method: string, params: any): Promise<any> {
        const id = Math.random().toString(36).substring(7);
        const request = {
            jsonrpc: '2.0',
            id,
            method,
            params
        };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Timeout waiting for host response to ${method}`));
            }, 30000);

            this.pendingRequests.set(id, (response) => {
                clearTimeout(timeout);
                if (response.error) {
                    reject(new Error(response.error.message));
                } else {
                    resolve(response.result);
                }
            });

            this.sendResponse(request);
        });
    }

    private handleData(chunk: string) {
        this.buffer += chunk;

        let pos: number;
        while ((pos = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.substring(0, pos).trim();
            this.buffer = this.buffer.substring(pos + 1);

            if (!line) continue;

            this.processLine(line);
        }
    }

    private async processLine(line: string) {
        let message: any;
        try {
            message = JSON.parse(line);
        } catch (err) {
            this.logger.error({ err, line }, 'Failed to parse JSON-RPC message');
            const errorResponse = {
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: -32700,
                    message: 'Parse error',
                },
            };
            this.sendResponse(errorResponse);
            return;
        }

        // Handle Response
        if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                this.pendingRequests.delete(message.id);
                pending(message);
                return;
            }
        }

        // Handle Request
        const request = message as JSONRPCRequest;
        const context = new ExecutionContext({
            logger: this.logger,
            remoteAddress: 'stdio',
        });

        await loggerStorage.run({ correlationId: context.correlationId }, async () => {
            try {
                const response = await this.concurrencyService.run(() =>
                    this.requestController.handleRequest(request, context)
                );
                // Don't send response for notifications (they return null)
                if (response !== null) {
                    this.sendResponse(response);
                }
            } catch (err: any) {
                if (err.name === 'QueueFullError') {
                    this.sendResponse({
                        jsonrpc: '2.0',
                        id: request.id,
                        error: {
                            code: ConduitError.ServerBusy,
                            message: 'Server busy'
                        }
                    });
                } else {
                    this.logger.error({ err, requestId: request.id }, 'Request handling failed');
                    this.sendResponse({
                        jsonrpc: '2.0',
                        id: request.id,
                        error: {
                            code: ConduitError.InternalError,
                            message: 'Internal server error'
                        }
                    });
                }
            }
        });
    }

    private sendResponse(response: any) {
        process.stdout.write(JSON.stringify(response) + '\n');
    }

    async close(): Promise<void> {
        process.stdin.removeAllListeners();
        // We don't close stdout/stdin as they are process-level
        return Promise.resolve();
    }
}
