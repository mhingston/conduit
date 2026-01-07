import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { DenoExecutor } from '../src/executors/deno.executor.js';
import { PyodideExecutor } from '../src/executors/pyodide.executor.js';
import { ExecutionContext } from '../src/core/execution.context.js';
import { ConduitError } from '../src/core/request.controller.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('LogLimitExceeded Verification', () => {
    let context: ExecutionContext;

    beforeEach(() => {
        context = new ExecutionContext({ logger });
    });

    describe('DenoExecutor', () => {
        it('should return LogLimitExceeded when log entry limit breached', async () => {
            const executor = new DenoExecutor();
            const result = await executor.execute('for(let i=0; i<100; i++) console.log(i)', {
                timeoutMs: 5000,
                memoryLimitMb: 128,
                maxOutputBytes: 1024 * 1024,
                maxLogEntries: 10,
            }, context);

            expect(result.error?.code).toBe(ConduitError.LogLimitExceeded);
            expect(result.error?.message).toContain('Log entry limit exceeded');
        });
    });

    describe('PyodideExecutor', () => {
        let pyExecutor: PyodideExecutor;

        beforeAll(() => {
            pyExecutor = new PyodideExecutor();
        });

        afterAll(async () => {
            await pyExecutor.shutdown();
        });

        it('should return LogLimitExceeded when log entry limit breached', async () => {
            const result = await pyExecutor.execute('for i in range(100): print(i)', {
                timeoutMs: 10000,
                memoryLimitMb: 128,
                maxOutputBytes: 1024 * 1024,
                maxLogEntries: 10,
            }, context);

            expect(result.error?.code).toBe(ConduitError.LogLimitExceeded);
            expect(result.error?.message).toContain('Log entry limit exceeded');
        }, 20000);
    });
});
