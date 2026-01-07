import { describe, it, expect } from 'vitest';
import { ConcurrencyService } from '../src/core/concurrency.service.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('ConcurrencyService', () => {
    it('should limit concurrent tasks', async () => {
        const service = new ConcurrencyService(logger, { maxConcurrent: 2 });
        let active = 0;
        let maxSeen = 0;

        const task = async () => {
            active++;
            maxSeen = Math.max(maxSeen, active);
            await new Promise(resolve => setTimeout(resolve, 10));
            active--;
        };

        await Promise.all([
            service.run(task),
            service.run(task),
            service.run(task),
            service.run(task),
        ]);

        expect(maxSeen).toBe(2);
    });

    it('should track stats correctly', async () => {
        const service = new ConcurrencyService(logger, { maxConcurrent: 1 });

        const task1 = service.run(async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
        });

        const task2 = service.run(async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
        });

        // At this point, task1 is active, task2 is pending
        expect(service.stats.activeCount).toBe(1);
        expect(service.stats.pendingCount).toBe(1);

        await Promise.all([task1, task2]);

        expect(service.stats.activeCount).toBe(0);
        expect(service.stats.pendingCount).toBe(0);
    });
});
