import { Middleware, NextFunction } from '../interfaces/middleware.interface.js';
import { JSONRPCRequest, JSONRPCResponse, ConduitError } from '../types.js';
import { ExecutionContext } from '../execution.context.js';
import { SecurityService } from '../security.service.js';

export class AuthMiddleware implements Middleware {
    constructor(private securityService: SecurityService) { }

    async handle(
        request: JSONRPCRequest,
        context: ExecutionContext,
        next: NextFunction
    ): Promise<JSONRPCResponse> {
        const providedToken = request.auth?.bearerToken || '';

        const isMaster = providedToken === this.securityService.getIpcToken();
        const isSession = this.securityService.validateIpcToken(providedToken) && !isMaster;

        if (!isMaster && !isSession) {
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: ConduitError.Forbidden,
                    message: 'Invalid bearer token'
                }
            };
        }

        // Strict scoping for session tokens
        if (isSession) {
            const allowedMethods = ['mcp.discoverTools', 'mcp.callTool'];
            if (!allowedMethods.includes(request.method)) {
                return {
                    jsonrpc: '2.0',
                    id: request.id,
                    error: {
                        code: ConduitError.Forbidden,
                        message: 'Session tokens are restricted to tool discovery and calling only'
                    }
                };
            }

            // Enrich context with session details if needed
            const session = this.securityService.getSession(providedToken);
            if (session?.allowedTools && !context.allowedTools) {
                // If context didn't already have specific tools (e.g. from request params override which shouldn't happen for sessions generally, 
                // but usually session allowedTools wins or merges. 
                // In generic logic, let's respect session.
                context.allowedTools = session.allowedTools;
            }
        }

        return next();
    }
}
