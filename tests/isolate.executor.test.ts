import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IsolateExecutor } from '../src/executors/isolate.executor.js';
import { ExecutionContext } from '../src/core/execution.context.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('IsolateExecutor', () => {
    let executor: IsolateExecutor;
    let gatewayService: any;

    beforeEach(() => {
        gatewayService = {
            callTool: vi.fn().mockResolvedValue({ result: { content: 'test' } }),
            discoverTools: vi.fn().mockResolvedValue([]),
        };
        executor = new IsolateExecutor(logger, gatewayService);
    });

    it('should execute simple JavaScript code', async () => {
        const code = 'console.log("Hello from isolate")';
        const context = new ExecutionContext({ logger });
        const limits = { timeoutMs: 5000, memoryLimitMb: 128, maxOutputBytes: 1024, maxLogEntries: 100 };

        const result = await executor.execute(code, limits, context);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Hello from isolate');
    });

    it('should capture console.error output', async () => {
        const code = 'console.error("Error message")';
        const context = new ExecutionContext({ logger });
        const limits = { timeoutMs: 5000, memoryLimitMb: 128, maxOutputBytes: 1024, maxLogEntries: 100 };

        const result = await executor.execute(code, limits, context);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('Error message');
    });

    it('should timeout on long execution', async () => {
        const code = 'while(true) {}';  // Infinite loop
        const context = new ExecutionContext({ logger });
        const limits = { timeoutMs: 100, memoryLimitMb: 128, maxOutputBytes: 1024, maxLogEntries: 100 };

        const result = await executor.execute(code, limits, context);

        expect(result.error).toBeDefined();
        expect(result.error?.code).toBe(-32008);  // RequestTimeout
    }, 10000);

    it('should expose tools.$raw for calling tools', async () => {
        gatewayService.callTool.mockResolvedValue({
            result: { message: 'Tool called!' }
        });

        const code = `
            const result = await tools.$raw('test__hello', { arg: 1 });
            console.log(JSON.stringify(result));
        `;
        const context = new ExecutionContext({ logger });
        const limits = { timeoutMs: 5000, memoryLimitMb: 128, maxOutputBytes: 1024, maxLogEntries: 100 };

        const result = await executor.execute(code, limits, context);

        expect(result.exitCode).toBe(0);
        expect(gatewayService.callTool).toHaveBeenCalledWith('test__hello', { arg: 1 }, context);
    });

    it('should use injected SDK script for typed access', async () => {
        gatewayService.callTool.mockResolvedValue({
            result: { content: 'typed result' }
        });

        const sdkScript = `
            const tools = {
                mock: {
                    async hello(args) {
                        const res = await __callTool('mock__hello', JSON.stringify(args));
                        return JSON.parse(res);
                    }
                }
            };
        `;

        const code = `
            await tools.mock.hello({ name: 'Typed' });
            console.log('Typed call done');
        `;
        const context = new ExecutionContext({ logger });
        const limits = { timeoutMs: 5000, memoryLimitMb: 128, maxOutputBytes: 1024, maxLogEntries: 100 };

        const result = await executor.execute(code, limits, context, { sdkCode: sdkScript });

        expect(result.exitCode).toBe(0);
        expect(gatewayService.callTool).toHaveBeenCalledWith('mock__hello', { name: 'Typed' }, context);
        expect(result.stdout).toContain('Typed call done');
    });
});
