import { Middleware, NextFunction } from '../interfaces/middleware.interface.js';
import { JSONRPCRequest, JSONRPCResponse, ConduitError } from '../types.js';
import { ExecutionContext } from '../execution.context.js';

export class ErrorHandlingMiddleware implements Middleware {
    async handle(request: JSONRPCRequest, context: ExecutionContext, next: NextFunction): Promise<JSONRPCResponse | null> {
        try {
            return await next();
        } catch (err: any) {
            context.logger.error({ err }, 'Error handling request');
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: ConduitError.InternalError,
                    message: err.message || 'Internal Server Error',
                },
            };
        }
    }
}
