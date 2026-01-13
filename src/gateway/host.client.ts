import { Logger } from 'pino';
import { JSONRPCRequest, JSONRPCResponse } from '../core/types.js';
import { ExecutionContext } from '../core/execution.context.js';
import { StdioTransport } from '../transport/stdio.transport.js';

/**
 * HostClient - Proxies tool calls back to the MCP client (e.g. VS Code)
 * that is hosting this Conduit process.
 */
export class HostClient {
    constructor(
        private logger: Logger,
        private transport: StdioTransport
    ) { }

    async call(request: JSONRPCRequest, context: ExecutionContext): Promise<JSONRPCResponse> {
        try {
            this.logger.debug({ method: request.method }, 'Forwarding request to host');

            let method = request.method;
            let params = request.params;

            // Bridge mcp_* calls to standard MCP calls for the host
            if (method === 'mcp_call_tool' || method === 'call_tool') {
                method = 'tools/call';
            } else if (method === 'mcp_discover_tools' || method === 'discover_tools') {
                method = 'tools/list';
                params = {};
            }

            const result = await this.transport.callHost(method, params);

            return {
                jsonrpc: '2.0',
                id: request.id,
                result
            };
        } catch (error: any) {
            this.logger.error({ err: error.message }, 'Host call failed');
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: -32008,
                    message: `Host error: ${error.message}`,
                },
            };
        }
    }

    async listTools(): Promise<any[]> {
        try {
            this.logger.debug('Fetching tool list from host');
            const result = await this.transport.callHost('tools/list', {});
            return result.tools || [];
        } catch (error: any) {
            this.logger.warn({ err: error.message }, 'Failed to fetch tools from host');
            return [];
        }
    }

    async getManifest() {
        return null;
    }
}
