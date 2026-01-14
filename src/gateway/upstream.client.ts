import { Logger } from 'pino';
import axios from 'axios';
import { JSONRPCRequest, JSONRPCResponse, ToolManifest } from '../core/types.js';
import { AuthService, UpstreamCredentials } from './auth.service.js';
import { ExecutionContext } from '../core/execution.context.js';
import { IUrlValidator } from '../core/interfaces/url.validator.interface.js';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { z } from 'zod';
import dns from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

export type UpstreamInfo = {
    id: string;
    credentials?: UpstreamCredentials;
} & (
        | { type?: 'http'; url: string }
        | { type: 'streamableHttp'; url: string }
        | { type: 'sse'; url: string }
        | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
    );

export class UpstreamClient {
    private logger: Logger;
    private info: UpstreamInfo;
    private authService: AuthService;
    private urlValidator: IUrlValidator;
    private mcpClient?: Client;
    private transport?: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
    private connected: boolean = false;

    // Pinned-IP dispatchers per upstream origin (defends against DNS rebinding)
    private dispatcherCache = new Map<string, { resolvedIp: string; agent: Agent }>();
    private pinned?: { origin: string; hostname: string; resolvedIp?: string };

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
            return;
        }

        if (this.info.type === 'streamableHttp') {
            const upstreamUrl = new URL(this.info.url);
            this.pinned = { origin: upstreamUrl.origin, hostname: upstreamUrl.hostname };

            this.transport = new StreamableHTTPClientTransport(upstreamUrl, {
                fetch: this.createAuthedFetch(),
            });
            this.mcpClient = new Client({
                name: 'conduit-gateway',
                version: '1.0.0',
            }, {
                capabilities: {},
            });
            return;
        }

        if (this.info.type === 'sse') {
            const upstreamUrl = new URL(this.info.url);
            this.pinned = { origin: upstreamUrl.origin, hostname: upstreamUrl.hostname };

            this.mcpClient = new Client({
                name: 'conduit-gateway',
                version: '1.0.0',
            }, {
                capabilities: {},
            });
        }
    }

    private getDispatcher(origin: string, hostname: string, resolvedIp: string): Agent {
        const existing = this.dispatcherCache.get(origin);
        if (existing && existing.resolvedIp === resolvedIp) {
            return existing.agent;
        }

        if (existing) {
            try {
                existing.agent.close();
            } catch {
                // ignore
            }
        }

        const agent = new Agent({
            connect: {
                lookup: (lookupHostname: string, options: any, callback: any) => {
                    if (lookupHostname === hostname) {
                        callback(null, resolvedIp, net.isIP(resolvedIp));
                        return;
                    }
                    dns.lookup(lookupHostname, options, callback);
                },
            },
        });

        this.dispatcherCache.set(origin, { resolvedIp, agent });
        return agent;
    }

    private createAuthedFetch() {
        const creds = this.info.credentials;
        const pinned = this.pinned;

        // Fall back to global fetch
        const baseFetch = fetch;

        return async (input: any, init: any = {}) => {
            const requestUrlStr = (() => {
                if (typeof input === 'string') return input;
                if (input instanceof URL) return input.toString();
                if (input instanceof Request) return input.url;
                return String(input);
            })();

            const requestUrl = pinned
                ? new URL(requestUrlStr, pinned.origin)
                : new URL(requestUrlStr);

            // Hard safety boundary: never allow fetch to escape upstream origin
            if (pinned && requestUrl.origin !== pinned.origin) {
                throw new Error(`Forbidden upstream redirect/origin: ${requestUrl.origin}`);
            }

            // Validate and (optionally) pin resolved IP for DNS-rebinding defense
            if (pinned && !pinned.resolvedIp) {
                const securityResult = await this.urlValidator.validateUrl(pinned.origin);
                if (!securityResult.valid) {
                    throw new Error(securityResult.message || 'Forbidden URL');
                }
                pinned.resolvedIp = securityResult.resolvedIp;
            }

            const headers = new Headers((input instanceof Request ? input.headers : undefined) || undefined);
            const initHeaders = new Headers(init.headers || {});
            for (const [k, v] of initHeaders.entries()) headers.set(k, v);

            if (creds) {
                const authHeaders = await this.authService.getAuthHeaders(creds);
                for (const [k, v] of Object.entries(authHeaders)) {
                    headers.set(k, v);
                }
            }

            const request = input instanceof Request
                ? new Request(input, { ...init, headers, redirect: init.redirect ?? 'manual' })
                : new Request(requestUrl.toString(), { ...init, headers, redirect: init.redirect ?? 'manual' });

            const dispatcher = (pinned && pinned.resolvedIp)
                ? this.getDispatcher(pinned.origin, pinned.hostname, pinned.resolvedIp)
                : undefined;

            return baseFetch(request, dispatcher ? { dispatcher } : undefined);
        };
    }

    private async ensureConnected() { 
        if (!this.mcpClient) return;

        if (!this.transport && this.info.type === 'sse') {
            const authHeaders = this.info.credentials
                ? await this.authService.getAuthHeaders(this.info.credentials)
                : {};

            this.transport = new SSEClientTransport(new URL(this.info.url), {
                fetch: this.createAuthedFetch(),
                eventSourceInit: { headers: authHeaders } as any,
                requestInit: { headers: authHeaders },
            });
        }

        if (!this.transport) return;
        if (this.connected) return;

        if (this.info.type === 'streamableHttp' || this.info.type === 'sse') {
            const securityResult = await this.urlValidator.validateUrl(this.info.url);
            if (!securityResult.valid) {
                this.logger.error({ url: this.info.url }, 'Blocked upstream URL (SSRF)');
                throw new Error(securityResult.message || 'Forbidden URL');
            }
            if (this.pinned) {
                this.pinned.resolvedIp = securityResult.resolvedIp;
            }
        }

        try {
            this.logger.debug('Connecting to upstream transport...');
            await this.mcpClient.connect(this.transport);
            this.connected = true;
            this.logger.info('Connected to upstream MCP');
        } catch (e: any) {
            this.logger.error({ err: e.message }, 'Failed to connect to upstream');
            throw e;
        }
    }

    async call(request: JSONRPCRequest, context: ExecutionContext): Promise<JSONRPCResponse> {
        const usesMcpClientTransport = (info: UpstreamInfo): info is (
            | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
            | { type: 'streamableHttp'; url: string }
            | { type: 'sse'; url: string }
        ) & { id: string; credentials?: UpstreamCredentials } =>
            info.type === 'stdio' || info.type === 'streamableHttp' || info.type === 'sse';

        if (usesMcpClientTransport(this.info)) {
            return this.callMcpClient(request);
        }

        return this.callHttp(request, context as ExecutionContext);
    }

    private async callMcpClient(request: JSONRPCRequest): Promise<JSONRPCResponse> {
        if (!this.mcpClient) {
            return { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'MCP client not initialized' } };
        }

        try {
            await this.ensureConnected();

            // Map GatewayService method names to SDK typed methods
            if (request.method === 'list_tools' || request.method === 'tools/list') {
                const result = await this.mcpClient.listTools();
                return {
                    jsonrpc: '2.0',
                    id: request.id,
                    result: result
                };
            } else if (request.method === 'call_tool' || request.method === 'tools/call') {
                const params = request.params as { name: string; arguments?: Record<string, unknown> };
                const result = await this.mcpClient.callTool({
                    name: params.name,
                    arguments: params.arguments,
                });
                const normalizedResult = (result && Array.isArray((result as any).content))
                    ? result
                    : {
                        content: [{
                            type: 'text',
                            text: typeof result === 'string' ? result : JSON.stringify(result ?? null),
                        }],
                    };
                return {
                    jsonrpc: '2.0',
                    id: request.id,
                    result: normalizedResult
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
            this.logger.error({ err: error }, 'MCP call failed');
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: error.code || -32603,
                    message: error.message || 'Internal error in MCP transport'
                }
            };
        }
    }

    private async callHttp(request: JSONRPCRequest, context: ExecutionContext): Promise<JSONRPCResponse> {
        // Narrowing for TS
        if (this.info.type === 'stdio' || this.info.type === 'streamableHttp' || this.info.type === 'sse') {
            throw new Error('Unreachable');
        }
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
        if (this.info.type && this.info.type !== 'http') return null;

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
