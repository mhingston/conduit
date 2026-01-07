import { describe, it, expect, vi } from 'vitest';
import { ConcurrencyService } from '../src/core/concurrency.service.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('ConcurrencyService', () => {
    it('should limit concurrent executions', async () => {
        const service = new ConcurrencyService(logger, { maxConcurrent: 2 });
        let activeCount = 0;
        let maxActive = 0;

        const tasks = Array.from({ length: 5 }, async (_, i) => {
            return service.run(async () => {
                activeCount++;
                maxActive = Math.max(maxActive, activeCount);
                await new Promise(resolve => setTimeout(resolve, 50));
                activeCount--;
            });
        });

        await Promise.all(tasks);

        expect(maxActive).toBe(2);
    });

    it('should handle errors without stucking', async () => {
        const service = new ConcurrencyService(logger, { maxConcurrent: 1 });

        await expect(service.run(async () => {
            throw new Error('fail');
        })).rejects.toThrow('fail');

        // Should still be able to run next task
        let ran = false;
        await service.run(async () => {
            ran = true;
        });
        expect(ran).toBe(true);
    });
});
