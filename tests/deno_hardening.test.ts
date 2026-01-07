
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DenoExecutor } from '../src/executors/deno.executor.js'; // Adjust path if needed
import { ConduitError } from '../src/core/request.controller.js';
import { pino } from 'pino';

// Need to match the imports in deno.executor; it uses relative paths. 
// Assuming tests are in `tests/` and src in `src/`.
// Imports in `deno.executor.ts` are `../core/...`

describe('DenoExecutor Hardening', () => {
    let executor: DenoExecutor;

    beforeEach(() => {
        executor = new DenoExecutor();
    });

    it.skip('should return LogLimitExceeded code when log limit is reached', async () => {
        // Skipping because this requires `deno` to be installed and available in environment
        // and we might not want to spawn processes in unit tests if avoidable.
        // But for verification, we can run it once.

        const context = {
            logger: pino({ level: 'silent' }),
            correlationId: 'test'
        } as any;

        const result = await executor.execute(
            'for (let i = 0; i < 20; i++) console.log("line " + i);',
            {
                timeoutMs: 2000,
                memoryLimitMb: 128,
                maxOutputBytes: 1024,
                maxLogEntries: 5 // Low limit
            },
            context
        );

        expect(result.error).toBeDefined();
        if (result.error) {
            expect(result.error.code).toBe(ConduitError.LogLimitExceeded); // -32014
            expect(result.error.message).toBe('Log entry limit exceeded');
        }
    });
});
