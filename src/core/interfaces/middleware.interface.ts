import { ExecutionContext } from '../execution.context.js';
import { JSONRPCRequest, JSONRPCResponse } from '../request.controller.js';

export type NextFunction = () => Promise<JSONRPCResponse>;

export interface Middleware {
    handle(
        request: JSONRPCRequest,
        context: ExecutionContext,
        next: NextFunction
    ): Promise<JSONRPCResponse>;
}
