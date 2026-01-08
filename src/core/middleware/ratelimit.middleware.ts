import { Middleware, NextFunction } from '../interfaces/middleware.interface.js';
import { JSONRPCRequest, JSONRPCResponse, ConduitError } from '../types.js';
import { ExecutionContext } from '../execution.context.js';
import { SecurityService } from '../security.service.js';

export class RateLimitMiddleware implements Middleware {
    constructor(private securityService: SecurityService) { }

    async handle(
        request: JSONRPCRequest,
        context: ExecutionContext,
        next: NextFunction
    ): Promise<JSONRPCResponse | null> {
        const providedToken = request.auth?.bearerToken;
        // Use token if available, otherwise fallback to remote address from context
        const rateLimitKey = providedToken || context.remoteAddress || 'unknown';

        if (!this.securityService.checkRateLimit(rateLimitKey)) {
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: -32005, // Rate limit exceeded code
                    message: 'Rate limit exceeded'
                }
            };
        }

        return next();
    }
}
