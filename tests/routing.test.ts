import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RequestController } from '../src/core/request.controller';
import { ExecutionContext } from '../src/core/execution.context';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('RequestController Routing', () => {
    let controller: RequestController;
    let mockContext: ExecutionContext;
    let mockGatewayService: any;
    let mockDenoExecutor: any;
    let mockPyodideExecutor: any;
    let mockIsolateExecutor: any;
    let mockSecurityService: any;
    let mockSdkGenerator: any;

    beforeEach(() => {
        mockContext = new ExecutionContext({ logger });
        mockGatewayService = {
            callTool: vi.fn(),
            discoverTools: vi.fn().mockResolvedValue([]),
        };
        mockDenoExecutor = {
            execute: vi.fn().mockResolvedValue({ stdout: 'deno', stderr: '', exitCode: 0 }),
        };
        mockPyodideExecutor = {
            execute: vi.fn(),
        };
        mockIsolateExecutor = {
            execute: vi.fn().mockResolvedValue({ stdout: 'isolate', stderr: '', exitCode: 0 }),
        };
        mockSecurityService = {
            validateCode: vi.fn().mockReturnValue({ valid: true }),
            createSession: vi.fn().mockReturnValue('token'),
            invalidateSession: vi.fn(),
        };
        mockSdkGenerator = {
            generateTypeScript: vi.fn().mockReturnValue('sdk'),
            generateIsolateSDK: vi.fn().mockReturnValue('sdk'),
        };

        controller = new RequestController(
            logger,
            { timeoutMs: 1000, memoryLimitMb: 128, maxOutputBytes: 1024, maxLogEntries: 100 },
            mockGatewayService,
            mockSecurityService
        );
        // Inject mock executors
        (controller as any).denoExecutor = mockDenoExecutor;
        (controller as any).pyodideExecutor = mockPyodideExecutor;
        // Inject mock isolate executor
        (controller as any).isolateExecutor = mockIsolateExecutor;
        (controller as any).sdkGenerator = mockSdkGenerator;
    });

    it('should route simple scripts (no imports) to IsolateExecutor', async () => {
        const result = await controller.handleRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'mcp.executeTypeScript',
            params: {
                code: 'console.log("simple")',
                limits: {}
            }
        }, mockContext);

        expect(mockIsolateExecutor.execute).toHaveBeenCalled();
        expect(mockDenoExecutor.execute).not.toHaveBeenCalled();
        expect(result.result.stdout).toBe('isolate');
    });

    it('should route scripts with imports to DenoExecutor', async () => {
        const result = await controller.handleRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'mcp.executeTypeScript',
            params: {
                code: 'import { foo } from "bar"; console.log(foo)',
                limits: {}
            }
        }, mockContext);

        expect(mockDenoExecutor.execute).toHaveBeenCalled();
        expect(mockIsolateExecutor.execute).not.toHaveBeenCalled();
        expect(result.result.stdout).toBe('deno');
    });

    it('should route scripts with exports to DenoExecutor', async () => {
        const result = await controller.handleRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'mcp.executeTypeScript',
            params: {
                code: 'export const foo = "bar"',
                limits: {}
            }
        }, mockContext);

        expect(mockDenoExecutor.execute).toHaveBeenCalled();
        expect(mockIsolateExecutor.execute).not.toHaveBeenCalled();
    });

    it('should route scripts using Deno global to DenoExecutor', async () => {
        const result = await controller.handleRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'mcp.executeTypeScript',
            params: {
                code: 'console.log(Deno.version)',
                limits: {}
            }
        }, mockContext);

        expect(mockDenoExecutor.execute).toHaveBeenCalled();
        expect(mockIsolateExecutor.execute).not.toHaveBeenCalled();
    });
});
