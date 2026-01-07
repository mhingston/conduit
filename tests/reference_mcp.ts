import Fastify from 'fastify';

const server = Fastify();

server.post('/', async (request, reply) => {
    const { method, params, id } = request.body as any;

    if (method === 'list_tools') {
        return {
            jsonrpc: '2.0',
            id,
            result: {
                tools: [
                    {
                        name: 'echo',
                        description: 'Echo back params',
                        inputSchema: { type: 'object' },
                    }
                ]
            }
        };
    }

    if (method === 'call_tool') {
        return {
            jsonrpc: '2.0',
            id,
            result: {
                content: [{ type: 'text', text: `Echo: ${JSON.stringify(params.arguments)}` }]
            }
        };
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
});

export const startReferenceMCP = async (port: number) => {
    await server.listen({ port, host: '0.0.0.0' });
    return server;
};
