import { Logger } from 'pino';
import axios from 'axios';
import { JSONRPCRequest, JSONRPCResponse, ToolManifest } from '../core/types.js';
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
            await this.ensureConnected();

            // Map GatewayService method names to SDK typed methods
            if (request.method === 'list_tools') {
                const result = await this.mcpClient.listTools();
                return {
                    jsonrpc: '2.0',
                    id: request.id,
                    result: result
                };
            } else if (request.method === 'call_tool') {
                const params = request.params as { name: string; arguments?: Record<string, unknown> };
                const result = await this.mcpClient.callTool({
                    name: params.name,
                    arguments: params.arguments,
                });
                return {
                    jsonrpc: '2.0',
                    id: request.id,
                    result: result
                };
            } else {
                // Fallback to generic request for other methods
                const result = await this.mcpClient.request(
                    { method: request.method, params: request.params },
                    z.any()
                );
                return {
                    jsonrpc: '2.0',
                    id: request.id,
                    result: result
                };
            }
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

            // Fix Sev1: Use the resolved safe IP to prevent DNS rebinding
            const originalUrl = new URL(url);
            const requestUrl = securityResult.resolvedIp ?
                `${originalUrl.protocol}//${securityResult.resolvedIp}${originalUrl.port ? ':' + originalUrl.port : ''}${originalUrl.pathname}${originalUrl.search}${originalUrl.hash}` :
                url;

            // Ensure Host header is set to the original hostname for virtual hosting/SNI
            headers['Host'] = originalUrl.hostname;

            const response = await axios.post(requestUrl, request, {
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
    async getManifest(context: ExecutionContext): Promise<ToolManifest | null> {
        if (this.info.type !== 'http') return null;

        try {
            const baseUrl = this.info.url.replace(/\/$/, ''); // Remove trailing slash
            const manifestUrl = `${baseUrl}/conduit.manifest.json`;

            const headers: Record<string, string> = {
                'X-Correlation-Id': context.correlationId,
            };

            if (this.info.credentials) {
                const authHeaders = await this.authService.getAuthHeaders(this.info.credentials);
                Object.assign(headers, authHeaders);
            }

            const securityResult = await this.urlValidator.validateUrl(manifestUrl);
            if (!securityResult.valid) {
                this.logger.warn({ url: manifestUrl }, 'Blocked manifest URL (SSRF)');
                return null;
            }

            // Fix Sev1 approach: Use resolved IP
            const originalUrl = new URL(manifestUrl);
            const requestUrl = securityResult.resolvedIp ?
                `${originalUrl.protocol}//${securityResult.resolvedIp}${originalUrl.port ? ':' + originalUrl.port : ''}${originalUrl.pathname}${originalUrl.search}${originalUrl.hash}` :
                manifestUrl;

            headers['Host'] = originalUrl.hostname;

            const response = await axios.get(requestUrl, {
                headers,
                timeout: 5000,
                maxRedirects: 0,
            });

            if (response.status === 200 && response.data && Array.isArray(response.data.tools)) {
                return response.data;
            }
        } catch (error) {
            // Ignore manifest errors and fallback to RPC
            this.logger.debug({ err: error }, 'Failed to fetch manifest (will fallback)');
        }
        return null;
    }
}
