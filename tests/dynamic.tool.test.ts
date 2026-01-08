import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { SocketTransport } from '../src/transport/socket.transport.js';
import { RequestController } from '../src/core/request.controller.js';
import { GatewayService } from '../src/gateway/gateway.service.js';
import { SecurityService } from '../src/core/security.service.js';
import { ConcurrencyService } from '../src/core/concurrency.service.js';
import pino from 'pino';
import { ExecutionContext } from '../src/core/execution.context.js';
import { ExecutionService } from '../src/core/execution.service.js';
import { ExecutorRegistry } from '../src/core/registries/executor.registry.js';
import { DenoExecutor } from '../src/executors/deno.executor.js';
import { PyodideExecutor } from '../src/executors/pyodide.executor.js';
import { IsolateExecutor } from '../src/executors/isolate.executor.js';
import { buildDefaultMiddleware } from '../src/core/middleware/middleware.builder.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const logger = pino({ level: 'silent' });
const defaultLimits = {
    timeoutMs: 10000,
    memoryLimitMb: 128,
    maxOutputBytes: 1024 * 1024,
    maxLogEntries: 100,
};

const LOG_FILE = path.join(os.tmpdir(), `conduit-test-debug-${process.pid}.log`);

describe('Dynamic Tool Calling (E2E)', () => {
    let transport: SocketTransport;
    let requestController: RequestController;
    let gatewayService: GatewayService;
    let securityService: SecurityService;
    let concurrencyService: ConcurrencyService;
    const testToken = 'dynamic-test-token';
    let ipcAddress: string;

    beforeAll(async () => {
        if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);

        securityService = new SecurityService(logger, testToken);
        gatewayService = new GatewayService(logger, securityService);

        // Register a mock upstream tool
        (gatewayService as any).clients.set('mock', {
            call: vi.fn().mockImplementation((req) => {
                if (req.method === 'call_tool' && req.params.name === 'hello') {
                    return { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: `Hello ${req.params.arguments.name}` }] } };
                }
                if (req.method === 'list_tools') {
                    return { jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'hello', inputSchema: {} }] } };
                }
                return { jsonrpc: '2.0', id: req.id, result: {} };
            })
        });

        concurrencyService = new ConcurrencyService(logger, { maxConcurrent: 10 });

        const executorRegistry = new ExecutorRegistry();
        executorRegistry.register('deno', new DenoExecutor());
        executorRegistry.register('python', new PyodideExecutor());
        // For isolate test, we need IsolateExecutor. 
        // It requires GatewayService.
        executorRegistry.register('isolate', new IsolateExecutor(logger, gatewayService));

        const executionService = new ExecutionService(
            logger,
            defaultLimits,
            gatewayService,
            securityService,
            executorRegistry
        );

        requestController = new RequestController(logger, executionService, gatewayService, buildDefaultMiddleware(securityService));
        transport = new SocketTransport(logger, requestController, concurrencyService);

        ipcAddress = await transport.listen({ port: 0, host: '127.0.0.1' });
        fs.appendFileSync(LOG_FILE, `IPC_ADDRESS: ${ipcAddress}\n`);
        executionService.ipcAddress = ipcAddress;
    });

    afterAll(async () => {
        await transport.close();
    });

    it('should allow Deno to discover and call tools via SDK', async () => {
        const code = `
            const toolList = await discoverMCPTools();
            console.log('TOOLS:' + JSON.stringify(toolList));
            // Use SDK to call tools - tools.mock.hello() or tools.$raw()
            const result = await tools.$raw('mock__hello', { name: 'Deno' });
            console.log('RESULT:' + JSON.stringify(result));
        `;

        const context = new ExecutionContext({ logger });
        const response = await requestController.handleRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'mcp.executeTypeScript',
            params: { code },
            auth: { bearerToken: testToken }
        }, context);

        fs.appendFileSync(LOG_FILE, `Deno Stdout: ${response!.result?.stdout}\n`);
        fs.appendFileSync(LOG_FILE, `Deno Stderr: ${response!.result?.stderr}\n`);

        expect(response!.error).toBeUndefined();
        expect(response!.result.stdout).toContain('mock__hello');
        expect(response!.result.stdout).toContain('Hello Deno');
    }, 15000);

    it('should allow Python to discover and call tools via SDK', async () => {
        const code = `
tool_list = await discover_mcp_tools()
print(f"TOOLS:{tool_list}")
# Use SDK to call tools - must await async methods
result = await tools.raw('mock__hello', {'name': 'Python'})
print(f"RESULT:{result}")
        `;

        const context = new ExecutionContext({ logger });
        const response = await requestController.handleRequest({
            jsonrpc: '2.0',
            id: 2,
            method: 'mcp.executePython',
            params: { code },
            auth: { bearerToken: testToken }
        }, context);

        fs.appendFileSync(LOG_FILE, `Python Stdout: ${response!.result?.stdout}\n`);
        fs.appendFileSync(LOG_FILE, `Python Stderr: ${response!.result?.stderr}\n`);
        if (response!.error) fs.appendFileSync(LOG_FILE, `Python Error: ${JSON.stringify(response!.error)}\n`);

        expect(response!.error).toBeUndefined();
        expect(response!.result.stdout).toContain('mock__hello');
        expect(response!.result.stdout).toContain('Hello Python');
    }, 25000);

    it('should reject tools not in allowlist via $raw()', async () => {
        const code = `
            try {
                // Attempt to call a tool not in the allowlist
                const result = await tools.$raw('other__forbidden', { arg: 'test' });
                console.log('ERROR: Should have thrown');
            } catch (e) {
                console.log('REJECTED:' + e.message);
            }
        `;

        const context = new ExecutionContext({ logger });
        const response = await requestController.handleRequest({
            jsonrpc: '2.0',
            id: 3,
            method: 'mcp.executeTypeScript',
            params: {
                code,
                allowedTools: ['mock.hello']  // Only mock.hello allowed
            },
            auth: { bearerToken: testToken }
        }, context);

        fs.appendFileSync(LOG_FILE, `Allowlist Stdout: ${response!.result?.stdout}\n`);
        if (response!.error) fs.appendFileSync(LOG_FILE, `Allowlist Error: ${JSON.stringify(response!.error)}\n`);

        expect(response!.error).toBeUndefined();
        expect(response!.result.stdout).toContain('REJECTED');
        expect(response!.result.stdout).toContain('not in the allowlist');
    }, 15000);

    it('should allow tools matching wildcard pattern', async () => {
        const code = `
            // This should work because mock.* matches mock__hello
            const result = await tools.$raw('mock.hello', { name: 'Wildcard' });
            console.log('RESULT:' + JSON.stringify(result));
        `;

        const context = new ExecutionContext({ logger });
        const response = await requestController.handleRequest({
            jsonrpc: '2.0',
            id: 4,
            method: 'mcp.executeTypeScript',
            params: {
                code,
                allowedTools: ['mock.*']  // Wildcard allows all mock tools
            },
            auth: { bearerToken: testToken }
        }, context);

        fs.appendFileSync(LOG_FILE, `Wildcard Stdout: ${response!.result?.stdout}\n`);
        if (response!.error) fs.appendFileSync(LOG_FILE, `Wildcard Error: ${JSON.stringify(response!.error)}\n`);

        expect(response!.error).toBeUndefined();
        expect(response!.result.stdout).toContain('Hello Wildcard');
    }, 15000);

    it('should allow isolated-vm to discover and call tools via typed SDK', async () => {
        const mockClient = (gatewayService as any).clients.get('mock');
        mockClient.call.mockClear();

        const code = `
            await tools.mock.hello({ name: 'Isolate' });
            console.log('Isolate call done');
        `;

        const context = new ExecutionContext({ logger });
        const response = await requestController.handleRequest({
            jsonrpc: '2.0',
            id: 5,
            method: 'mcp.executeIsolate',
            params: {
                code,
                allowedTools: ['mock.*'],
                limits: { timeoutMs: 5000, memoryLimitMb: 128, maxOutputBytes: 1024, maxLogEntries: 100 }
            },
            auth: { bearerToken: testToken }
        }, context);

        fs.appendFileSync(LOG_FILE, `Isolate Stdout: ${response!.result?.stdout}\n`);
        if (response!.error) fs.appendFileSync(LOG_FILE, `Isolate Error: ${JSON.stringify(response!.error)}\n`);

        expect(response!.error).toBeUndefined();
        expect(response!.result.stdout).toContain('Isolate call done');

        // Verify tool was called
        expect(mockClient.call).toHaveBeenCalled();
        const callArgs = mockClient.call.mock.calls[0];
        const request = callArgs[0];

        expect(request).toMatchObject({
            method: 'call_tool',
            params: {
                name: 'hello',
                arguments: { name: 'Isolate' }
            }
        });
    }, 15000);
});
