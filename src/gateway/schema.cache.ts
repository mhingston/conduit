import { LRUCache } from 'lru-cache';
import { Logger } from 'pino';
import { metrics } from '../core/metrics.service.js';

export interface ToolSchema {
    name: string;
    description?: string;
    inputSchema: any;
}

export class SchemaCache {
    private cache: LRUCache<string, ToolSchema[]>;
    private logger: Logger;

    constructor(logger: Logger, max: number = 100, ttl: number = 1000 * 60 * 60) { // 1 hour TTL default
        this.logger = logger;
        this.cache = new LRUCache({
            max,
            ttl,
        });
    }

    get(upstreamId: string): ToolSchema[] | undefined {
        const result = this.cache.get(upstreamId);
        if (result) {
            metrics.recordCacheHit();
        } else {
            metrics.recordCacheMiss();
        }
        return result;
    }

    set(upstreamId: string, tools: ToolSchema[]) {
        this.logger.debug({ upstreamId, count: tools.length }, 'Caching tool schemas');
        this.cache.set(upstreamId, tools);
    }

    invalidate(upstreamId: string) {
        this.logger.debug({ upstreamId }, 'Invalidating schema cache');
        this.cache.delete(upstreamId);
    }

    clear() {
        this.cache.clear();
    }
}
