import { describe, it, expect, beforeEach } from 'vitest';
import { SchemaCache } from '../src/gateway/schema.cache.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('SchemaCache', () => {
    it('should cache and retrieve schemas', () => {
        const cache = new SchemaCache(logger);
        const tools = [{ name: 'test', inputSchema: {} }];

        cache.set('upstream1', tools);
        expect(cache.get('upstream1')).toEqual(tools);
    });

    it('should return undefined for missing entries', () => {
        const cache = new SchemaCache(logger);
        expect(cache.get('missing')).toBeUndefined();
    });

    it('should invalidate entries', () => {
        const cache = new SchemaCache(logger);
        cache.set('upstream1', []);
        cache.invalidate('upstream1');
        expect(cache.get('upstream1')).toBeUndefined();
    });
});
