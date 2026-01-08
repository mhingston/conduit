/**
 * End-to-End Test: Client -> Conduit -> Stdio Upstream
 *
 * This test verifies the full flow:
 * 1. Conduit starts with a stdio upstream configured
 * 2. A client connects to Conduit
 * 3. Client can discover tools from the upstream
 * 4. Client can call tools on the upstream
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '../src/core/config.service.js';
import { createLogger, loggerStorage } from '../src/core/logger.js';
import { SocketTransport } from '../src/transport/socket.transport.js';
import { OpsServer } from '../src/core/ops.server.js';
import { ConcurrencyService } from '../src/core/concurrency.service.js';
import { RequestController } from '../src/core/request.controller.js';
import { GatewayService } from '../src/gateway/gateway.service.js';
import { SecurityService } from '../src/core/security.service.js';
import { DenoExecutor } from '../src/executors/deno.executor.js';
import { PyodideExecutor } from '../src/executors/pyodide.executor.js';
import { IsolateExecutor } from '../src/executors/isolate.executor.js';
import { ExecutorRegistry } from '../src/core/registries/executor.registry.js';
import { ExecutionService } from '../src/core/execution.service.js';
import net from 'net';
import path from 'path';

describe('E2E: Stdio Upstream Integration', () => {
    let transport: SocketTransport;
    let opsServer: OpsServer;
    let requestController: RequestController;
    let serverAddress: string;
    let ipcToken: string;

    beforeAll(async () => {
        // Configure Conduit with our test stdio server
        const stioServerPath = path.resolve(__dirname, 'fixtures/stdio-server.ts');

        const configService = new ConfigService({
            port: 0, // Random port
            upstreams: [
                {
                    id: 'test-stdio',
                    type: 'stdio',
                    command: 'npx',
                    args: ['tsx', stioServerPath],
                } as any,
            ],
        });

        ipcToken = configService.get('ipcBearerToken');
        const logger = createLogger(configService);

        await loggerStorage.run({ correlationId: 'e2e-test' }, async () => {
            const securityService = new SecurityService(logger, ipcToken);
            const gatewayService = new GatewayService(logger, securityService);

            const upstreams = configService.get('upstreams') || [];
            for (const upstream of upstreams) {
                gatewayService.registerUpstream(upstream);
            }

            const executorRegistry = new ExecutorRegistry();
            executorRegistry.register('deno', new DenoExecutor());
            executorRegistry.register('python', new PyodideExecutor());
            const isolateExecutor = new IsolateExecutor(logger, gatewayService);
            executorRegistry.register('isolate', isolateExecutor);

            const executionService = new ExecutionService(
                logger,
                configService.get('resourceLimits'),
                gatewayService,
                securityService,
                executorRegistry
            );

            requestController = new RequestController(
                logger,
                executionService,
                gatewayService,
                securityService
            );

            opsServer = new OpsServer(logger, configService.all, gatewayService, requestController);
            await opsServer.listen();

            const concurrencyService = new ConcurrencyService(logger, {
                maxConcurrent: configService.get('maxConcurrent'),
            });

            transport = new SocketTransport(logger, requestController, concurrencyService);
            const address = await transport.listen({ port: 0 });
            executionService.ipcAddress = address;
            serverAddress = address;

            await requestController.warmup();
        });
    }, 30000);

    afterAll(async () => {
        await transport?.close();
        await opsServer?.close();
        await requestController?.shutdown();
    });

    function sendRequest(request: object): Promise<any> {
        return new Promise((resolve, reject) => {
            // Parse address - could be TCP or Unix socket
            let connectOptions: net.NetConnectOpts;
            if (serverAddress.startsWith('/') || serverAddress.startsWith('\\\\.\\pipe\\')) {
                connectOptions = { path: serverAddress };
            } else {
                const [host, portStr] = serverAddress.split(':');
                connectOptions = { host, port: parseInt(portStr, 10) };
            }

            const client = net.createConnection(connectOptions, () => {
                const payload = JSON.stringify(request) + '\n';
                client.write(payload);
            });

            let data = '';
            client.on('data', (chunk) => {
                data += chunk.toString();
                // Check for newline delimiter
                if (data.includes('\n')) {
                    const lines = data.split('\n').filter(Boolean);
                    if (lines.length > 0) {
                        try {
                            const response = JSON.parse(lines[0]);
                            client.end();
                            resolve(response);
                        } catch (e) {
                            // Keep waiting for more data
                        }
                    }
                }
            });

            client.on('error', reject);
            client.setTimeout(10000, () => {
                client.destroy();
                reject(new Error('Timeout waiting for response'));
            });
        });
    }

    it('should discover tools from the stdio upstream', async () => {
        const response = await sendRequest({
            jsonrpc: '2.0',
            id: '1',
            method: 'mcp.discoverTools',
            params: {},
            auth: { bearerToken: ipcToken },
        });

        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();
        expect(response.result.tools).toBeInstanceOf(Array);

        // Find our echo tool from the stdio upstream
        const echoTool = response.result.tools.find((t: any) => t.name.includes('echo'));
        expect(echoTool).toBeDefined();
        expect(echoTool.description).toBe('Echoes back the input');
    }, 15000);

    it('should call a tool on the stdio upstream', async () => {
        // First discover tools to get the namespaced name
        const discoverResponse = await sendRequest({
            jsonrpc: '2.0',
            id: '1',
            method: 'mcp.discoverTools',
            params: {},
            auth: { bearerToken: ipcToken },
        });

        const echoTool = discoverResponse.result.tools.find((t: any) => t.name.includes('echo'));
        expect(echoTool).toBeDefined();

        // Call the tool
        const callResponse = await sendRequest({
            jsonrpc: '2.0',
            id: '2',
            method: 'mcp.callTool',
            params: {
                name: echoTool.name,
                arguments: { message: 'Hello from E2E test!' },
            },
            auth: { bearerToken: ipcToken },
        });

        expect(callResponse.error).toBeUndefined();
        expect(callResponse.result).toBeDefined();
        expect(callResponse.result.content).toBeInstanceOf(Array);
        expect(callResponse.result.content[0].text).toBe('Echo: Hello from E2E test!');
    }, 15000);
});
