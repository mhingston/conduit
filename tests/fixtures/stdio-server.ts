#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({
    name: 'test-stdio-server',
    version: '1.0.0',
}, {
    capabilities: {
        tools: {},
    },
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
        name: 'echo',
        description: 'Echoes back the input',
        inputSchema: {
            type: 'object',
            properties: {
                message: { type: 'string' },
            },
            required: ['message'],
        },
    }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === 'echo') {
        return {
            content: [{
                type: 'text',
                text: `Echo: ${request.params.arguments?.message}`,
            }],
        };
    }
    throw new Error('Tool not found');
});

const transport = new StdioServerTransport();
await server.connect(transport);
