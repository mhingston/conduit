import pLimit from 'p-limit';
import { Logger } from 'pino';
import { trace } from '@opentelemetry/api';
import { metrics } from './metrics.service.js';

export interface ConcurrencyOptions {
    maxConcurrent: number;
    maxQueueSize?: number;
}

export class QueueFullError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'QueueFullError';
    }
}

export class ConcurrencyService {
    private limit: ReturnType<typeof pLimit>;
    private logger: Logger;
    private maxQueueSize: number;
    private queueDepthHistogram: any; // Using explicit type locally if needed, or rely on metrics service later. Using direct OTEL for now involves refactor.
    // Let's rely on internal state for rejection and let MetricsService handle reporting if possible, or add it here.
    // simpler: usage of metrics service is better pattern.

    constructor(logger: Logger, options: ConcurrencyOptions) {
        this.logger = logger;
        this.limit = pLimit(options.maxConcurrent);
        this.maxQueueSize = options.maxQueueSize || 100; // Default to 100

        metrics.registerQueueLengthProvider(() => this.limit.pendingCount);
    }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.limit.pendingCount >= this.maxQueueSize) {
            this.logger.warn({ pending: this.limit.pendingCount, max: this.maxQueueSize }, 'Request queue full, rejecting request');
            throw new QueueFullError('Server is too busy, please try again later');
        }

        const active = this.limit.activeCount;
        const pending = this.limit.pendingCount;

        this.logger.debug({ active, pending }, 'Concurrency status before task');

        // Add attributes to current OTEL span if exists
        const span = trace.getActiveSpan();
        if (span) {
            span.setAttributes({
                'concurrency.active': active,
                'concurrency.pending': pending,
            });
        }

        try {
            return await this.limit(fn);
        } finally {
            this.logger.debug({
                active: this.limit.activeCount,
                pending: this.limit.pendingCount
            }, 'Concurrency status after task');
        }
    }

    get stats() {
        return {
            activeCount: this.limit.activeCount,
            pendingCount: this.limit.pendingCount,
        };
    }
}
