import { Middleware, NextFunction } from '../interfaces/middleware.interface.js';
import { JSONRPCRequest, JSONRPCResponse } from '../request.controller.js';
import { ExecutionContext } from '../execution.context.js';
import { metrics } from '../metrics.service.js';

export class LoggingMiddleware implements Middleware {
    async handle(request: JSONRPCRequest, context: ExecutionContext, next: NextFunction): Promise<JSONRPCResponse> {
        const { method, id } = request;
        const childLogger = context.logger.child({ method, id });
        context.logger = childLogger; // Update context logger for downstream

        metrics.recordExecutionStart();
        const startTime = Date.now();

        try {
            const response = await next();
            metrics.recordExecutionEnd(Date.now() - startTime, method);
            return response;
        } catch (err) {
            // Should be caught by ErrorMiddleware, but just in case
            metrics.recordExecutionEnd(Date.now() - startTime, method);
            throw err;
        }
    }
}
