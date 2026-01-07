import { describe, it, expect, beforeEach } from 'vitest';
import { DenoExecutor } from '../src/executors/deno.executor.js';
import { ExecutionContext } from '../src/core/execution.context.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('DenoExecutor', () => {
    let executor: DenoExecutor;
    let context: ExecutionContext;

    beforeEach(() => {
        executor = new DenoExecutor();
        context = new ExecutionContext({ logger });
    });

    it('should execute simple typescript code', async () => {
        const result = await executor.execute('console.log("hello")', {
            timeoutMs: 5000,
            memoryLimitMb: 128,
            maxOutputBytes: 1024,
            maxLogEntries: 100,
        }, context);

        expect(result.stdout).toContain('hello');
        expect(result.exitCode).toBe(0);
    });

    it('should timeout on infinite loops', async () => {
        const startTime = Date.now();
        const result = await executor.execute('while(true){}', {
            timeoutMs: 500,
            memoryLimitMb: 128,
            maxOutputBytes: 1024,
            maxLogEntries: 100,
        }, context);

        const duration = Date.now() - startTime;
        expect(duration).toBeGreaterThanOrEqual(500);
        expect(result.exitCode).toBe(null);
    });

    it('should enforce output limits', async () => {
        const result = await executor.execute('console.log("A".repeat(2000))', {
            timeoutMs: 5000,
            memoryLimitMb: 128,
            maxOutputBytes: 100,
            maxLogEntries: 100,
        }, context);

        expect(result.stdout.length).toBeLessThanOrEqual(100);
        expect(result.error?.code).toBe(-32013);
    });

    it('should enforce memory limits', async () => {
        // Grow heap until it hits the limit
        const result = await executor.execute('const a = []; while(true) a.push(new Array(10000).fill(0));', {
            timeoutMs: 5000,
            memoryLimitMb: 64,
            maxOutputBytes: 1024,
            maxLogEntries: 100,
        }, context);

        expect(result.exitCode).not.toBe(0);
        // V8 might throw Out of Memory error on stderr
        expect(result.stderr).toMatch(/out of memory|exhausted/i);
    });
});
