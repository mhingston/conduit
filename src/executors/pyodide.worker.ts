import { parentPort, workerData } from 'node:worker_threads';
import { loadPyodide, type PyodideInterface } from 'pyodide';
import net from 'node:net';

let pyodide: PyodideInterface | null = null;
let currentStdout = '';
let currentStderr = '';
let totalOutputBytes = 0;
let totalLogEntries = 0;
let currentLimits: any = null;

async function init() {
    if (pyodide) return pyodide;

    pyodide = await loadPyodide({
        stdout: (text) => {
            if (currentLimits && (totalOutputBytes > (currentLimits.maxOutputBytes || 1024 * 1024) || totalLogEntries > (currentLimits.maxLogEntries || 10000))) {
                return; // Stop processing logs once limit breached
            }
            currentStdout += text + '\n';
            totalOutputBytes += text.length + 1;
            totalLogEntries++;
        },
        stderr: (text) => {
            if (currentLimits && (totalOutputBytes > (currentLimits.maxOutputBytes || 1024 * 1024) || totalLogEntries > (currentLimits.maxLogEntries || 10000))) {
                return; // Stop processing logs once limit breached
            }
            currentStderr += text + '\n';
            totalOutputBytes += text.length + 1;
            totalLogEntries++;
        },
    });

    return pyodide;
}

async function handleTask(data: any) {
    const { code, limits, ipcInfo, shim } = data;
    currentStdout = '';
    currentStderr = '';
    totalOutputBytes = 0;
    totalLogEntries = 0;
    currentLimits = limits;

    try {
        const p = await init();

        const sendIPCRequest = async (method: string, params: any) => {
            if (!ipcInfo?.ipcAddress) throw new Error('Conduit IPC address not configured');

            return new Promise((resolve, reject) => {
                let client: net.Socket;

                if (ipcInfo.ipcAddress.includes(':')) {
                    const lastColon = ipcInfo.ipcAddress.lastIndexOf(':');
                    const host = ipcInfo.ipcAddress.substring(0, lastColon);
                    const port = ipcInfo.ipcAddress.substring(lastColon + 1);

                    let targetHost = host.replace(/[\[\]]/g, '');
                    if (targetHost === '0.0.0.0' || targetHost === '::' || targetHost === '::1' || targetHost === '') {
                        targetHost = '127.0.0.1';
                    }

                    client = net.createConnection({
                        host: targetHost,
                        port: parseInt(port)
                    });
                } else {
                    client = net.createConnection({ path: ipcInfo.ipcAddress });
                }

                const id = Math.random().toString(36).substring(7);
                const request = {
                    jsonrpc: '2.0',
                    id,
                    method,
                    params: params || {},
                    auth: { bearerToken: ipcInfo.ipcToken }
                };

                client.on('error', (err) => {
                    reject(err);
                    client.destroy();
                });

                client.write(JSON.stringify(request) + '\n');

                let buffer = '';
                client.on('data', (data) => {
                    buffer += data.toString();
                    // Robust framing: read until we find a complete JSON object on a line
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // Keep the last partial line

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const response = JSON.parse(line);
                            if (response.id === id) {
                                if (response.error) {
                                    reject(new Error(response.error.message));
                                } else {
                                    resolve(response.result);
                                }
                                client.end();
                                return;
                            }
                        } catch (e) {
                            // If parse fails, it might be a partial line that we haven't seen the end of yet
                            // but since we split by \n, this shouldn't happen unless the \n was inside the JSON.
                            // However, Conduit ensures JSON-RPC is one line.
                        }
                    }
                });

                client.on('end', () => {
                    if (buffer.trim()) {
                        try {
                            const response = JSON.parse(buffer);
                            if (response.id === id) {
                                if (response.error) {
                                    reject(new Error(response.error.message));
                                } else {
                                    resolve(response.result);
                                }
                            }
                        } catch (e) { }
                    }
                });
            });
        };

        (p as any).globals.set('discover_mcp_tools_js', (options: any) => {
            return sendIPCRequest('mcp.discoverTools', options);
        });

        (p as any).globals.set('call_mcp_tool_js', (name: string, args: any) => {
            return sendIPCRequest('mcp.callTool', { name, arguments: args });
        });

        if (shim) {
            await p.runPythonAsync(shim);
        }

        const result = await p.runPythonAsync(code);

        if (totalOutputBytes > (limits.maxOutputBytes || 1024 * 1024)) {
            throw new Error('[LIMIT_OUTPUT]');
        }
        if (totalLogEntries > (limits.maxLogEntries || 10000)) {
            throw new Error('[LIMIT_LOG]');
        }

        parentPort?.postMessage({
            stdout: currentStdout,
            stderr: currentStderr,
            result: String(result),
            success: true,
        });
    } catch (err: any) {
        let isOutput = err.message.includes('[LIMIT_OUTPUT]');
        let isLog = err.message.includes('[LIMIT_LOG]');

        // Fallback: check counters if message doesn't match (e.g. wrapped in OSError)
        if (!isOutput && !isLog && currentLimits) {
            if (totalOutputBytes > (currentLimits.maxOutputBytes || 1024 * 1024)) {
                isOutput = true;
            }
            // Check specific log limit breach
            if (totalLogEntries > (currentLimits.maxLogEntries || 10000)) {
                isLog = true;
            }
        }

        parentPort?.postMessage({
            stdout: currentStdout,
            stderr: currentStderr,
            error: err.message,
            limitBreached: isOutput ? 'output' : (isLog ? 'log' : undefined),
            success: false,
        });
    }
}

parentPort?.on('message', async (msg) => {
    if (msg.type === 'execute') {
        await handleTask(msg.data);
    } else if (msg.type === 'ping') {
        parentPort?.postMessage({ type: 'pong' });
    }
});

// Signal ready
parentPort?.postMessage({ type: 'ready' });

