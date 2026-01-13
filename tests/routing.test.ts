import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RequestController } from '../src/core/request.controller';
import { ExecutionContext } from '../src/core/execution.context';
import { buildDefaultMiddleware } from '../src/core/middleware/middleware.builder.js';
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
            policyService: {
                parseToolName: (name: string) => {
                    const idx = name.indexOf('__');
                    if (idx === -1) return { namespace: '', name };
                    return { namespace: name.substring(0, idx), name: name.substring(idx + 2) };
                }
            }
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
            getIpcToken: vi.fn().mockReturnValue('master-token'),
            validateIpcToken: vi.fn().mockReturnValue(true),
            getSession: vi.fn(),
            checkRateLimit: vi.fn().mockReturnValue(true),
        };
        mockSdkGenerator = {
            generateTypeScript: vi.fn().mockReturnValue('sdk'),
            generateIsolateSDK: vi.fn().mockReturnValue('sdk'),
        };

        // Create controller with mock execution service
        const mockExecutionService = {
            executeTypeScript: vi.fn().mockImplementation(async (code) => {
                const cleanCode = code.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, '$1');
                const hasImports = /^\s*import\s/m.test(cleanCode) ||
                    /^\s*export\s/m.test(cleanCode) ||
                    /\bDeno\./.test(cleanCode) ||
                    /\bDeno\b/.test(cleanCode);

                if (!hasImports) {
                    await mockIsolateExecutor.execute();
                    return { stdout: 'isolate', stderr: '', exitCode: 0 };
                } else {
                    await mockDenoExecutor.execute();
                    return { stdout: 'deno', stderr: '', exitCode: 0 };
                }
            }),
            ipcAddress: '',
            shutdown: vi.fn(),
            healthCheck: vi.fn().mockResolvedValue({ status: 'ok' }),
            warmup: vi.fn(),
        };

        controller = new RequestController(
            logger,
            mockExecutionService as any,
            mockGatewayService,
            buildDefaultMiddleware(mockSecurityService)
        );
        (controller as any).denoExecutor = mockDenoExecutor;
        (controller as any).pyodideExecutor = mockPyodideExecutor;
        (controller as any).isolateExecutor = mockIsolateExecutor;
        (controller as any).sdkGenerator = mockSdkGenerator;
    });

    it('should route simple scripts (no imports) to IsolateExecutor', async () => {
        const result = await controller.handleRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'mcp_execute_typescript',
            params: {
                code: 'console.log("simple")',
                limits: {}
            },
            auth: { bearerToken: 'master-token' }
        }, mockContext);

        expect(mockIsolateExecutor.execute).toHaveBeenCalled();
        expect(mockDenoExecutor.execute).not.toHaveBeenCalled();
        expect(result!.result.stdout).toBe('isolate');
    });

    it('should route scripts with imports to DenoExecutor', async () => {
        const result = await controller.handleRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'mcp_execute_typescript',
            params: {
                code: 'import { foo } from "bar"; console.log(foo)',
                limits: {}
            },
            auth: { bearerToken: 'master-token' }
        }, mockContext);

        expect(mockDenoExecutor.execute).toHaveBeenCalled();
        expect(mockIsolateExecutor.execute).not.toHaveBeenCalled();
        expect(result!.result.stdout).toBe('deno');
    });

    it('should route scripts with exports to DenoExecutor', async () => {
        const result = await controller.handleRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'mcp_execute_typescript',
            params: {
                code: 'export const foo = "bar"',
                limits: {}
            },
            auth: { bearerToken: 'master-token' }
        }, mockContext);

        expect(mockDenoExecutor.execute).toHaveBeenCalled();
        expect(mockIsolateExecutor.execute).not.toHaveBeenCalled();
    });

    it('should route scripts using Deno global to DenoExecutor', async () => {
        const result = await controller.handleRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'mcp_execute_typescript',
            params: {
                code: 'console.log(Deno.version)',
                limits: {}
            },
            auth: { bearerToken: 'master-token' }
        }, mockContext);

        expect(mockDenoExecutor.execute).toHaveBeenCalled();
        expect(mockIsolateExecutor.execute).not.toHaveBeenCalled();
    });

    it('should route tools/call for built-in tools', async () => {
        const result = await controller.handleRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name: 'mcp_execute_typescript',
                arguments: {
                    code: 'console.log("via tools/call")',
                    limits: {}
                }
            },
            auth: { bearerToken: 'master-token' }
        }, mockContext);

        expect(mockIsolateExecutor.execute).toHaveBeenCalled();
        expect(result!.result.structuredContent.stdout).toBe('isolate');
    });

});
