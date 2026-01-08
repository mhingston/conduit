/**
 * E2E Test: Native Stdio Mode
 * 
 * This test verifies that Conduit can be run in native Stdio mode (via --stdio flag),
 * communicating directly over stdin/stdout.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';

describe('E2E: Native Stdio Mode', () => {
    it('should start in stdio mode and discover tools', async () => {
        const indexPath = path.resolve(__dirname, '../src/index.ts');

        const child = spawn('npx', ['tsx', indexPath, '--stdio'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                PATH: process.env.PATH,
                PORT: '0', // Use random port for ops server to avoid conflicts
            }
        });

        const request = {
            jsonrpc: '2.0',
            id: '1',
            method: 'mcp.discoverTools',
            params: {},
            // Use a dummy token, security service might reject if auth is enabled but 
            // the default config generates a random token.
            // However, in this test we are spawning a fresh process, so we don't know the token.
            // Wait, security service checks 'ipcBearerToken'.
            // If we don't provide one, it generates random.
            // We should provide one via env var so we can auth.
            auth: { bearerToken: 'test-token' },
        };

        // We need to inject the token into the spawned process env
        child.kill();

        // Restart with known token
        const childWithAuth = spawn('npx', ['tsx', indexPath, '--stdio'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                PATH: process.env.PATH,
                PORT: '0',
                IPC_BEARER_TOKEN: 'test-token'
            }
        });

        // Write request to process stdin
        childWithAuth.stdin.write(JSON.stringify(request) + '\n');

        const response = await new Promise<any>((resolve, reject) => {
            let buffer = '';
            childWithAuth.stdout.on('data', (chunk) => {
                buffer += chunk.toString();
                if (buffer.includes('\n')) {
                    const lines = buffer.split('\n');
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const parsed = JSON.parse(line);
                            resolve(parsed);
                            return;
                        } catch (e) {
                            // ignore partial or non-json (though stdout should be pure json-rpc)
                        }
                    }
                }
            });

            childWithAuth.stderr.pipe(process.stderr);

            childWithAuth.on('error', reject);

            setTimeout(() => {
                childWithAuth.kill();
                reject(new Error('Timeout waiting for response'));
            }, 30000);
        });

        childWithAuth.kill();

        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();
        expect(response.result.tools).toBeInstanceOf(Array);
        expect(response.id).toBe('1');
    }, 35000);
});
