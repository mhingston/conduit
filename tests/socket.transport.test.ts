import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { SocketTransport } from '../src/transport/socket.transport.js';
import { RequestController } from '../src/core/request.controller.js';
import pino from 'pino';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { SecurityService } from '../src/core/security.service.js';
import { ExecutionService } from '../src/core/execution.service.js';
import { ExecutorRegistry } from '../src/core/registries/executor.registry.js';

import fs from 'node:fs';

const logger = pino({ level: 'silent' });
const defaultLimits = {
    timeoutMs: 5000,
    memoryLimitMb: 128,
    maxOutputBytes: 1024,
    maxLogEntries: 100,
};

describe('SocketTransport', () => {
    let transport: SocketTransport;
    let requestController: RequestController;
    let securityService: any;
    let concurrencyService: any;
    let gatewayService: any;
    const testToken = 'test-token';

    beforeEach(() => {
        gatewayService = {
            discoverTools: vi.fn().mockResolvedValue([]),  // Return empty array for SDK generation
            callTool: vi.fn(),
        } as any;
        securityService = new SecurityService(logger, testToken);
        concurrencyService = {
            run: vi.fn().mockImplementation((fn) => fn()),
        } as any;
        concurrencyService = {
            run: vi.fn().mockImplementation((fn) => fn()),
        } as any;

        const executorRegistry = new ExecutorRegistry();
        // Use real DenoExecutor for this E2E-like test
        // But DenoExecutor initialization might be heavy? Whatever, it creates temp dir.
        // Or we can mock it to return expected stdout.
        // Let's use real one to match previous behavior.

        // Since we are mocking Deno call in test via 'executeTypeScript', maybe we should mock DenoExecutor execution?
        // But the test sends 'console.log...'.
        // If we mock DenoExecutor, we can make it return 'hello E2E'.
        // That's faster and safer.
        const mockDenoExecutor = {
            execute: vi.fn().mockImplementation(async (code) => {
                // Simple mock that echoes input logic if needed, or just returns static because test sends specific string
                if (code.includes('hello E2E')) return { stdout: 'hello E2E', stderr: '', exitCode: 0 };
                if (code.includes('hello')) return { stdout: 'hello', stderr: '', exitCode: 0 }; // for server busy test
                return { stdout: '', stderr: '', exitCode: 0 };
            }),
            shutdown: vi.fn(),
            healthCheck: vi.fn(),
            warmup: vi.fn()
        };
        executorRegistry.register('deno', mockDenoExecutor as any);

        const executionService = new ExecutionService(
            logger,
            defaultLimits,
            gatewayService,
            securityService,
            executorRegistry
        );

        requestController = new RequestController(logger, executionService, gatewayService, securityService);
    });

    afterEach(async () => {
        if (transport) {
            await transport.close();
        }
    });

    it('should listen on a TCP port in development mode', async () => {
        transport = new SocketTransport(logger, requestController, concurrencyService);
        const address = await transport.listen({ port: 0 }); // Random port
        expect(address).toMatch(/127\.0\.0\.1:\d+|:::\d+|0\.0\.0\.0:\d+/);
    });

    if (os.platform() !== 'win32') {
        it('should listen on a Unix socket', async () => {
            const socketPath = path.join(os.tmpdir(), `conduit-test-${Date.now()}.sock`);
            transport = new SocketTransport(logger, requestController, concurrencyService);
            const address = await transport.listen({ path: socketPath });
            expect(address).toBe(socketPath);
            expect(fs.existsSync(socketPath)).toBe(true);

            // Cleanup
            if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
        });
    }

    it('should handle mcp.executeTypeScript request', async () => {
        transport = new SocketTransport(logger, requestController, concurrencyService);
        const address = await transport.listen({ port: 0 });
        const portMatch = address.match(/:(\d+)$/);
        const port = portMatch ? parseInt(portMatch[1]) : 0;
        const host = address.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

        return new Promise<void>((resolve, reject) => {
            const client = net.createConnection({ host: host === '::' ? '::1' : host, port }, () => {
                const request = {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'mcp.executeTypeScript',
                    params: { code: 'console.log("hello E2E")' },
                    auth: { bearerToken: testToken }
                };
                client.write(JSON.stringify(request) + '\n');
            });

            client.on('data', (data) => {
                const responseString = data.toString();
                try {
                    const response = JSON.parse(responseString);
                    expect(response.id).toBe(1);
                    expect(response.result.stdout).toContain('hello E2E');
                    resolve();
                } catch (err) {
                    reject(err);
                } finally {
                    client.end();
                }
            });

            client.on('error', reject);
        });
    });

    it('should return server busy error with correct ID when queue is full', async () => {
        const queueFullError = new Error('Queue full');
        queueFullError.name = 'QueueFullError';
        concurrencyService.run.mockRejectedValue(queueFullError);

        transport = new SocketTransport(logger, requestController, concurrencyService);
        const address = await transport.listen({ port: 0 });
        const portMatch = address.match(/:(\d+)$/);
        const port = portMatch ? parseInt(portMatch[1]) : 0;
        const host = address.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

        return new Promise<void>((resolve, reject) => {
            const client = net.createConnection({ host: host === '::' ? '::1' : host, port }, () => {
                const request = {
                    jsonrpc: '2.0',
                    id: 12345,
                    method: 'mcp.executeTypeScript',
                    params: { code: 'console.log("hello")' },
                    auth: { bearerToken: testToken }
                };
                client.write(JSON.stringify(request) + '\n');
            });

            client.on('data', (data) => {
                const responseString = data.toString();
                try {
                    const response = JSON.parse(responseString);
                    expect(response.id).toBe(12345);
                    expect(response.error).toBeDefined();
                    expect(response.error.code).toBe(-32000); // ConduitError.ServerBusy
                    expect(response.error.message).toBe('Server busy');
                    resolve();
                } catch (err) {
                    reject(err);
                } finally {
                    client.end();
                }
            });

            client.on('error', reject);
        });
    });
});
