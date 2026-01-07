import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UpstreamClient } from '../src/gateway/upstream.client.js';
import { Logger } from 'pino';
import { mock } from 'vitest-mock-extended';
import { AuthService } from '../src/gateway/auth.service.js';
import { IUrlValidator } from '../src/core/interfaces/url.validator.interface.js';
import path from 'path';

describe('UpstreamClient (Stdio)', () => {
    const logger = mock<Logger>();
    const authService = mock<AuthService>();
    const urlValidator = mock<IUrlValidator>();
    logger.child.mockReturnThis();

    it('should connect to a local stdio server and call a tool', async () => {
        const serverPath = path.resolve(__dirname, 'fixtures/stdio-server.ts');

        // We use ts-node or just node with loader to run the ts file, 
        // or we compile it. For simplicity in this env, we assume we can run it via node loader 
        // OR we use a simple JS script if TS execution is complex in subprocess.
        // Let's rely on tsx or similar if available, or just compile it?
        // Actually, the project uses `vite-node` or `ts-node`.
        // Let's try running it with `npx tsx`.

        const client = new UpstreamClient(
            logger,
            {
                id: 'stdio-test',
                type: 'stdio',
                command: 'npx',
                args: ['tsx', serverPath],
            },
            authService,
            urlValidator
        );

        // We simulate a JSON-RPC request like Gateway would send
        const request = {
            jsonrpc: '2.0',
            id: '1',
            method: 'tools/call', // SDK uses 'tools/call'
            params: {
                name: 'echo',
                arguments: { message: 'Hello Stdio' },
            },
        };

        const response = await client.call(request as any, { correlationId: 'test-corr' } as any);

        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();
        expect((response.result as any).content[0].text).toBe('Echo: Hello Stdio');
    }, 10000);
});
