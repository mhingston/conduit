// @ts-nocheck
// Deno Shim for Conduit - Code Mode SDK
const IPC_ADDRESS = '__CONDUIT_IPC_ADDRESS__';
const IPC_TOKEN = '__CONDUIT_IPC_TOKEN__';

async function sendIPCRequest(method: string, params: any) {
    if (!IPC_ADDRESS) throw new Error('Conduit IPC address not configured');

    let conn: any;
    try {
        if (IPC_ADDRESS.includes(':')) {
            const lastColon = IPC_ADDRESS.lastIndexOf(':');
            const hostname = IPC_ADDRESS.substring(0, lastColon);
            const port = IPC_ADDRESS.substring(lastColon + 1);

            // Normalize hostname for Deno connect
            let targetHost = hostname.replace(/[\[\]]/g, '');
            if (targetHost === '0.0.0.0' || targetHost === '::' || targetHost === '::1' || targetHost === '') {
                targetHost = '127.0.0.1';
            }

            conn = await (Deno as any).connect({
                hostname: targetHost,
                port: Number(port)
            });
        } else {
            conn = await (Deno as any).connect({ transport: 'unix', path: IPC_ADDRESS });
        }
    } catch (err: any) {
        throw new Error(`Failed to connect to Conduit IPC (${IPC_ADDRESS}): ${err.message}`);
    }

    try {
        const id = Math.random().toString(36).substring(7);
        const request = {
            jsonrpc: '2.0',
            id,
            method,
            params: params || {},
            auth: { bearerToken: IPC_TOKEN }
        };

        const encoder = new TextEncoder();
        await conn.write(encoder.encode(JSON.stringify(request) + '\n'));

        const decoder = new TextDecoder();
        let buffer = '';
        const chunk = new Uint8Array(2 * 1024 * 1024); // 2MB buffer for large tool returns

        while (true) {
            const n = await conn.read(chunk);
            if (n === null) throw new Error('IPC connection closed by host before receiving response');

            buffer += decoder.decode(chunk.subarray(0, n));
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep partial line

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const response = JSON.parse(line);
                    if (response.id === id) {
                        if (response.error) {
                            const error = new Error(response.error.message);
                            (error as any).code = response.error.code;
                            (error as any).data = response.error.data;
                            throw error;
                        }
                        return response.result;
                    }
                } catch (e: any) {
                    if (e.message.includes('JSON')) continue;
                    throw e;
                }
            }
        }
    } finally {
        conn.close();
    }
}

// Internal tool call function - used by generated SDK
const __internalCallTool = async (name: string, params: any) => {
    return await sendIPCRequest('mcp.callTool', { name, arguments: params });
};

// Tool discovery - still available for dynamic scenarios
(globalThis as any).discoverMCPTools = async (options: any) => {
    const result = await sendIPCRequest('mcp.discoverTools', options);
    return result.tools || [];
};

// __CONDUIT_SDK_INJECTION__
