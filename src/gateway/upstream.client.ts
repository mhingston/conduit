import { Logger } from 'pino';
import axios from 'axios';
import { JSONRPCRequest, JSONRPCResponse } from '../core/types.js';
import { AuthService, UpstreamCredentials } from './auth.service.js';
import { ExecutionContext } from '../core/execution.context.js';
import { IUrlValidator } from '../core/interfaces/url.validator.interface.js';

export interface UpstreamInfo {
    id: string;
    url: string;
    credentials?: UpstreamCredentials;
}

export class UpstreamClient {
    private logger: Logger;
    private info: UpstreamInfo;
    private authService: AuthService;
    private urlValidator: IUrlValidator;

    constructor(logger: Logger, info: UpstreamInfo, authService: AuthService, urlValidator: IUrlValidator) {
        this.logger = logger.child({ upstreamId: info.id });
        this.info = info;
        this.authService = authService;
        this.urlValidator = urlValidator;
    }

    async call(request: JSONRPCRequest, context: ExecutionContext): Promise<JSONRPCResponse> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Correlation-Id': context.correlationId,
        };

        if (context.tenantId) {
            headers['X-Tenant-Id'] = context.tenantId;
        }

        if (this.info.credentials) {
            const authHeaders = await this.authService.getAuthHeaders(this.info.credentials);
            Object.assign(headers, authHeaders);
        }

        const securityResult = await this.urlValidator.validateUrl(this.info.url);
        if (!securityResult.valid) {
            this.logger.error({ url: this.info.url }, 'Blocked upstream URL (SSRF)');
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: -32003,
                    message: securityResult.message || 'Forbidden URL',
                },
            };
        }

        try {
            this.logger.debug({ method: request.method }, 'Calling upstream MCP');

            const response = await axios.post(this.info.url, request, {
                headers,
                timeout: 10000,
                maxRedirects: 0,
            });

            return response.data as JSONRPCResponse;
        } catch (err: any) {
            this.logger.error({ err: err.message }, 'Upstream MCP call failed');
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: -32008,
                    message: `Upstream error: ${err.message}`,
                },
            };
        }
    }
}
