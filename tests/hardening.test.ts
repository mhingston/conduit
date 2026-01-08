
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SocketTransport } from '../src/transport/socket.transport.js';
import { RequestController } from '../src/core/request.controller.js';
import { SecurityService } from '../src/core/security.service.js';
import { ConcurrencyService } from '../src/core/concurrency.service.js';
import { ExecutionService } from '../src/core/execution.service.js';
import { ExecutorRegistry } from '../src/core/registries/executor.registry.js';
import { buildDefaultMiddleware } from '../src/core/middleware/middleware.builder.js';
import { pino } from 'pino';
import net from 'net';
import os from 'os';
import path from 'path';

const logger = pino({ level: 'silent' });

describe('V1 Hardening Tests', () => {
    let transport: SocketTransport;
    let securityService: SecurityService;
    let requestController: RequestController;
    let socketPath: string;
    let mockDenoExecutor: any;

    beforeEach(async () => {
        const ipcToken = 'master-token';
        securityService = new SecurityService(logger, ipcToken);
        const concurrencyService = new ConcurrencyService(logger, { maxConcurrent: 10 });

        const gatewayService = {
            callTool: vi.fn(),
            discoverTools: vi.fn().mockResolvedValue([]), // Return empty array for SDK generation
            listToolPackages: vi.fn().mockResolvedValue([]),
            listToolStubs: vi.fn().mockResolvedValue([])
        } as any;

        const defaultLimits = { timeoutMs: 1000, memoryLimitMb: 128, maxOutputBytes: 1024, maxLogEntries: 5 }; // Low log limit

        const executorRegistry = new ExecutorRegistry();

        // Mock DenoExecutor
        mockDenoExecutor = {
            execute: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
        };
        executorRegistry.register('deno', mockDenoExecutor as any);

        const executionService = new ExecutionService(
            logger,
            defaultLimits,
            gatewayService,
            securityService,
            executorRegistry
        );
        executionService.ipcAddress = '127.0.0.1:0'; // Dummy address for tests
        // Ensure executionService has required methods for RequestController healthCheck/warmup delegation
        vi.spyOn(executionService, 'shutdown').mockResolvedValue();
        vi.spyOn(executionService, 'warmup').mockResolvedValue();
        vi.spyOn(executionService, 'healthCheck').mockResolvedValue({ status: 'ok' });

        requestController = new RequestController(logger, executionService, gatewayService, buildDefaultMiddleware(securityService));

        transport = new SocketTransport(logger, requestController, concurrencyService);

        socketPath = path.join(os.tmpdir(), `conduit-test-${Math.random().toString(36).substring(7)}.sock`);
        if (os.platform() === 'win32') {
            socketPath = '\\\\.\\pipe\\conduit-test-' + Math.random().toString(36).substring(7);
        }
        await transport.listen({ path: socketPath });
    });

    afterEach(async () => {
        await transport.close();
    });

    async function sendRequest(request: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const client = net.createConnection({ path: socketPath }, () => {
                client.write(JSON.stringify(request) + '\n');
            });

            client.once('data', (data) => {
                resolve(JSON.parse(data.toString()));
                client.end();
            });

            client.on('error', reject);
        });
    }

    it('should deny executeTypeScript with session token', async () => {
        const sessionToken = securityService.createSession();

        const response = await sendRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'mcp.executeTypeScript',
            params: { code: 'console.log("hi")' },
            auth: { bearerToken: sessionToken }
        });

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32003); // Forbidden
        expect(response.error.message).toContain('Session tokens are restricted');
    });

    it('should allow discoverTools with session token', async () => {
        const sessionToken = securityService.createSession();

        // Mock handleDiscoverTools response logic via requestController
        // We mocked gatewayService but requestController calls it.
        // We need to ensure requestController.handleDiscoverTools works.
        // It calls gatewayService.discoverTools.
        (requestController as any).gatewayService.discoverTools.mockResolvedValue([]);

        const response = await sendRequest({
            jsonrpc: '2.0',
            id: 2,
            method: 'mcp.discoverTools',
            params: {},
            auth: { bearerToken: sessionToken }
        });

        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();
    });

    it('should allow executeTypeScript with master token', async () => {
        const response = await sendRequest({
            jsonrpc: '2.0',
            id: 3,
            method: 'mcp.executeTypeScript',
            params: { code: 'import * as os from "os"; console.log("hi")' },
            auth: { bearerToken: 'master-token' }
        });

        // It should call the executor (which we mocked above to success)
        expect(response.error).toBeUndefined();
        expect(mockDenoExecutor.execute).toHaveBeenCalled();
    });
});
