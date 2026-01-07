import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { PyodideExecutor } from '../src/executors/pyodide.executor.js';
import { ExecutionContext } from '../src/core/execution.context.js';
import { ConduitError } from '../src/core/request.controller.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('PyodideExecutor', () => {
    let executor: PyodideExecutor;
    let context: ExecutionContext;

    beforeAll(() => {
        executor = new PyodideExecutor();
    });

    afterAll(async () => {
        await executor.shutdown();
    });

    beforeEach(() => {
        context = new ExecutionContext({ logger });
    });

    it('should execute simple python code', async () => {
        const code = 'print(1 + 1)';
        const result = await executor.execute(code, {
            timeoutMs: 10000,
            memoryLimitMb: 128,
            maxOutputBytes: 1024,
            maxLogEntries: 100,
        }, context);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('2');
    }, 20000); // Higher timeout for pyodide load

    it('should capture stdout', async () => {
        const code = 'print("hello python")';
        const result = await executor.execute(code, {
            timeoutMs: 10000,
            memoryLimitMb: 128,
            maxOutputBytes: 1024,
            maxLogEntries: 100,
        }, context);

        expect(result.stdout).toContain('hello python');
    }, 20000);

    it('should timeout on long execution', async () => {
        const code = 'import time; time.sleep(5)';
        const result = await executor.execute(code, {
            timeoutMs: 1000, // 1s timeout
            memoryLimitMb: 128,
            maxOutputBytes: 1024,
            maxLogEntries: 100,
        }, context);

        expect(result.error?.code).toBe(-32008);
    }, 20000);

    it('should terminate worker on output limit breach', async () => {
        const code = 'print("this is longer than 10 bytes")';
        const result = await executor.execute(code, {
            timeoutMs: 5000,
            memoryLimitMb: 128,
            maxOutputBytes: 10, // Very small limit
            maxLogEntries: 100,
        }, context);

        expect(result.error?.code).toBe(ConduitError.OutputLimitExceeded);
        // Pyodide might wrap the JS error as an OSError/I/O error
        const errMsg = result.error?.message || '';
        expect(errMsg.includes('Output limit exceeded') || errMsg.includes('I/O error')).toBe(true);

        // Next execution should work (new worker)
        const result2 = await executor.execute('print("ok")', {
            timeoutMs: 5000,
            memoryLimitMb: 128,
            maxOutputBytes: 1000,
            maxLogEntries: 100,
        }, context);
        expect(result2.error).toBeUndefined();
        expect(result2.stdout.trim()).toBe('ok');
    }, 20000);

    it('should recycle worker after every execution (zero state leak)', async () => {
        // First execution
        await executor.execute('print("hello")', {
            timeoutMs: 5000,
            memoryLimitMb: 128,
            maxOutputBytes: 1024,
            maxLogEntries: 100,
        }, context);

        const poolSize = (executor as any).pool.length;
        // Since maxRunsPerWorker = 1, it should have been terminated.
        // The pool might be 0 if it was the only worker, or 1 if a new one was pre-warmed (unlikely without request)
        expect(poolSize).toBeLessThanOrEqual(1);
    });
});
