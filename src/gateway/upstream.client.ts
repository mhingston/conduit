import { Logger } from 'pino';
import axios from 'axios';
import { JSONRPCRequest, JSONRPCResponse } from '../core/types.js';
import { AuthService, UpstreamCredentials } from './auth.service.js';
import { ExecutionContext } from '../core/execution.context.js';
import { IUrlValidator } from '../core/interfaces/url.validator.interface.js';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

export type UpstreamInfo = {
    id: string;
    credentials?: UpstreamCredentials;
} & (
        | { type?: 'http'; url: string }
        | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
    );

export class UpstreamClient {
    private logger: Logger;
    private info: UpstreamInfo;
    private authService: AuthService;
    private urlValidator: IUrlValidator;
    private mcpClient?: Client;
    private transport?: StdioClientTransport;

    constructor(logger: Logger, info: UpstreamInfo, authService: AuthService, urlValidator: IUrlValidator) {
        this.logger = logger.child({ upstreamId: info.id });
        this.info = info;
        this.authService = authService;
        this.urlValidator = urlValidator;

        if (this.info.type === 'stdio') {
            const env = { ...process.env, ...this.info.env };
            // Filter undefined values
            const cleanEnv = Object.entries(env).reduce((acc, [k, v]) => {
                if (v !== undefined) acc[k] = v;
                return acc;
            }, {} as Record<string, string>);

            this.transport = new StdioClientTransport({
                command: this.info.command,
                args: this.info.args,
                env: cleanEnv,
            });
            this.mcpClient = new Client({
                name: 'conduit-gateway',
                version: '1.0.0',
            }, {
                capabilities: {},
            });
        }
    }

    private async ensureConnected() {
        if (!this.mcpClient || !this.transport) return;
        // There isn't a public isConnected property easily accessible, 
        // usually we just connect once.
        // We can track connected state or just try/catch connect.
        // For simplicity, we connect once and existing sdk handles reconnection or errors usually kill it.
        // Actually SDK Client.connect() is for the transport.
        try {
            // @ts-ignore - Check internal state or just attempt connect if we haven't
            if (!this.transport.connection) {
                await this.mcpClient.connect(this.transport);
            }
        } catch (e) {
            // connection might already be active
        }
    }

    async call(request: JSONRPCRequest, context: ExecutionContext): Promise<JSONRPCResponse> {
        // Helper to determine type safely
        const isStdio = (info: UpstreamInfo): info is { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; id: string; credentials?: UpstreamCredentials } => info.type === 'stdio';

        if (isStdio(this.info)) {
            return this.callStdio(request);
        } else {
            return this.callHttp(request, context as ExecutionContext);
        }
    }

    private async callStdio(request: JSONRPCRequest): Promise<JSONRPCResponse> {
        if (!this.mcpClient) {
            return { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Stdio client not initialized' } };
        }

        try {
            await this.ensureConnected(); // simple connect check

            // The SDK's client.request returns the RESULT, not the full response object.
            // And it throws on error.
            const result = await this.mcpClient.request(
                { method: request.method, params: request.params },
                // Schema validator is optional, we skip it for generic proxying by using z.any()
                z.any()
            );

            return {
                jsonrpc: '2.0',
                id: request.id,
                result: result
            };
        } catch (error: any) {
            this.logger.error({ err: error }, 'Stdio call failed');
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: error.code || -32603,
                    message: error.message || 'Internal error in stdio transport'
                }
            };
        }
    }

    private async callHttp(request: JSONRPCRequest, context: ExecutionContext): Promise<JSONRPCResponse> {
        // Narrowing for TS
        if (this.info.type === 'stdio') throw new Error('Unreachable');
        const url = this.info.url;

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

        const securityResult = await this.urlValidator.validateUrl(url);
        if (!securityResult.valid) {
            this.logger.error({ url }, 'Blocked upstream URL (SSRF)');
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

            const response = await axios.post(url, request, {
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
