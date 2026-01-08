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
            this.sendResponse(errorResponse);
            return;
        }

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
