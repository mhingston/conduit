import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mcpClientMocks = {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools: [{ name: 'hello', description: 'hi', inputSchema: {} }] })),
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    request: vi.fn(async () => ({ ok: true })),
};

const transportMocks = {
    streamableHttpCtor: vi.fn(),
    sseCtor: vi.fn(),
};

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
    return {
        Client: class {
            connect = mcpClientMocks.connect;
            listTools = mcpClientMocks.listTools;
            callTool = mcpClientMocks.callTool;
            request = mcpClientMocks.request;
            constructor() {}
        },
    };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
    return {
        StreamableHTTPClientTransport: class {
            url: URL;
            opts: any;
            constructor(url: URL, opts: any) {
                this.url = url;
                this.opts = opts;
                transportMocks.streamableHttpCtor(url, opts);
            }
        },
    };
});

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => {
    return {
        SSEClientTransport: class {
            url: URL;
            opts: any;
            constructor(url: URL, opts: any) {
                this.url = url;
                this.opts = opts;
                transportMocks.sseCtor(url, opts);
            }
        },
    };
});

// Not used directly but imported by UpstreamClient
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
    return {
        StdioClientTransport: class {},
    };
});

describe('UpstreamClient (remote transports)', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.clearAllMocks();
        globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as any;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('uses Streamable HTTP client transport for type=streamableHttp', async () => {
        const { UpstreamClient } = await import('../src/gateway/upstream.client.js');

        const logger: any = { child: () => logger, debug: vi.fn(), info: vi.fn(), error: vi.fn() };
        const authService: any = { getAuthHeaders: vi.fn(async () => ({ Authorization: 'Bearer t' })) };
        const urlValidator: any = { validateUrl: vi.fn(async () => ({ valid: true })) };

        const client = new UpstreamClient(
            logger,
            { id: 'atl', type: 'streamableHttp', url: 'https://mcp.atlassian.com/v1/sse' } as any,
            authService,
            urlValidator
        );

        const res = await client.call({ jsonrpc: '2.0', id: '1', method: 'tools/list' } as any, { correlationId: 'c1' } as any);

        expect(transportMocks.streamableHttpCtor).toHaveBeenCalled();
        expect(urlValidator.validateUrl).toHaveBeenCalled();
        expect(mcpClientMocks.connect).toHaveBeenCalled();
        expect(mcpClientMocks.listTools).toHaveBeenCalled();
        expect(res.result).toBeDefined();
    });

    it('pins DNS resolution and blocks cross-origin fetches', async () => {
        const { UpstreamClient } = await import('../src/gateway/upstream.client.js');

        const logger: any = { child: () => logger, debug: vi.fn(), info: vi.fn(), error: vi.fn() };
        const authService: any = { getAuthHeaders: vi.fn(async () => ({ Authorization: 'Bearer t' })) };
        const urlValidator: any = { validateUrl: vi.fn(async () => ({ valid: true, resolvedIp: '93.184.216.34' })) };

        const client = new UpstreamClient(
            logger,
            { id: 'atl', type: 'streamableHttp', url: 'https://mcp.atlassian.com/v1/sse' } as any,
            authService,
            urlValidator
        );

        // Trigger initial URL validation + pinning
        await client.call({ jsonrpc: '2.0', id: '1', method: 'tools/list' } as any, { correlationId: 'c1' } as any);

        const [, opts] = transportMocks.streamableHttpCtor.mock.calls[0];
        const wrappedFetch = opts.fetch;

        // Same-origin request should pass a dispatcher and block redirects
        await wrappedFetch('https://mcp.atlassian.com/v1/sse', {});
        expect((globalThis.fetch as any).mock.calls.length).toBeGreaterThan(0);
        const [request, init] = (globalThis.fetch as any).mock.calls.at(-1);
        expect(request).toBeInstanceOf(Request);
        expect(request.redirect).toBe('manual');
        expect(init?.dispatcher).toBeDefined();

        // Cross-origin request should be blocked
        await expect(wrappedFetch('https://evil.example.com/', {})).rejects.toThrow(/Forbidden upstream redirect\/origin/);
    });

    it('lazily creates SSE transport for type=sse and attaches auth headers', async () => {
        const { UpstreamClient } = await import('../src/gateway/upstream.client.js');

        const logger: any = { child: () => logger, debug: vi.fn(), info: vi.fn(), error: vi.fn() };
        const authService: any = { getAuthHeaders: vi.fn(async () => ({ Authorization: 'Bearer t' })) };
        const urlValidator: any = { validateUrl: vi.fn(async () => ({ valid: true })) };

        const client = new UpstreamClient(
            logger,
            {
                id: 'atl',
                type: 'sse',
                url: 'https://mcp.atlassian.com/v1/sse',
                credentials: { type: 'bearer', bearerToken: 't' },
            } as any,
            authService,
            urlValidator
        );

        await client.call({ jsonrpc: '2.0', id: '1', method: 'tools/list' } as any, { correlationId: 'c1' } as any);

        expect(authService.getAuthHeaders).toHaveBeenCalled();
        expect(transportMocks.sseCtor).toHaveBeenCalled();
        const [, opts] = transportMocks.sseCtor.mock.calls[0];
        expect(opts.requestInit.headers).toMatchObject({ Authorization: 'Bearer t' });
        expect(mcpClientMocks.connect).toHaveBeenCalled();
    });
});
