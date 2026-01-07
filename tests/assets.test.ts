import { describe, it, expect } from 'vitest';
import { SDKGenerator, toToolBinding } from '../src/sdk/index.js';
import { ToolSchema } from '../src/gateway/schema.cache.js';

describe('Asset Integrity (Golden Tests)', () => {
    const generator = new SDKGenerator();

    const sampleTools: ToolSchema[] = [
        {
            name: 'test__hello',
            description: 'Returns a greeting',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string' }
                },
                required: ['name']
            }
        },
        {
            name: 'github__create_issue',
            description: 'Creates a GitHub issue',
            inputSchema: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    body: { type: 'string' }
                },
                required: ['title']
            }
        }
    ];

    const bindings = sampleTools.map(t => toToolBinding(t.name, t.inputSchema, t.description));

    it('should match TypeScript SDK snapshot', () => {
        const sdk = generator.generateTypeScript(bindings, ['test__*', 'github__*']);
        expect(sdk).toMatchSnapshot();
    });

    it('should match Python SDK snapshot', () => {
        const sdk = generator.generatePython(bindings, ['test__*', 'github__*']);
        expect(sdk).toMatchSnapshot();
    });

    it('should match Isolate SDK snapshot', () => {
        const sdk = generator.generateIsolateSDK(bindings, ['test__*', 'github__*']);
        expect(sdk).toMatchSnapshot();
    });
});
