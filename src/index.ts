#!/usr/bin/env node
import { Command } from 'commander';
import { ConfigService } from './core/config.service.js';
import { createLogger, loggerStorage } from './core/logger.js';
import { SocketTransport } from './transport/socket.transport.js';
import { StdioTransport } from './transport/stdio.transport.js';
import { OpsServer } from './core/ops.server.js';
import { ConcurrencyService } from './core/concurrency.service.js';
import { RequestController } from './core/request.controller.js';
import { GatewayService } from './gateway/gateway.service.js';
import { SecurityService } from './core/security.service.js';
import { OtelService } from './core/otel.service.js';
import { DenoExecutor } from './executors/deno.executor.js';
import { PyodideExecutor } from './executors/pyodide.executor.js';
import { IsolateExecutor } from './executors/isolate.executor.js';
import { ExecutorRegistry } from './core/registries/executor.registry.js';
import { ExecutionService } from './core/execution.service.js';
import { buildDefaultMiddleware } from './core/middleware/middleware.builder.js';
import { handleAuth } from './auth.cmd.js';

const program = new Command();

program
    .name('conduit')
    .description('A secure Code Mode execution substrate for MCP agents')
    .version('1.0.0');

program
    .command('serve', { isDefault: true })
    .description('Start the Conduit server')
    .option('--stdio', 'Use stdio transport')
    .action(async (options) => {
        try {
            await startServer();
        } catch (err) {
            console.error('Failed to start Conduit:', err);
            process.exit(1);
        }
    });

program
    .command('auth')
    .description('Help set up OAuth for an upstream MCP server')
    .requiredOption('--client-id <id>', 'OAuth Client ID')
    .requiredOption('--client-secret <secret>', 'OAuth Client Secret')
    .requiredOption('--auth-url <url>', 'OAuth Authorization URL')
    .requiredOption('--token-url <url>', 'OAuth Token URL')
    .option('--scopes <scopes>', 'OAuth Scopes (comma separated)')
    .option('--port <port>', 'Port for the local callback server', '3333')
    .action(async (options) => {
        try {
            await handleAuth({
                clientId: options.clientId,
                clientSecret: options.clientSecret,
                authUrl: options.authUrl,
                tokenUrl: options.tokenUrl,
                scopes: options.scopes,
                port: parseInt(options.port, 10),
            });
            console.log('\nSuccess! Configuration generated.');
        } catch (err: any) {
            console.error('Authentication helper failed:', err.message);
            process.exit(1);
        }
    });

async function startServer() {
    const configService = new ConfigService();
    const logger = createLogger(configService);

    const otelService = new OtelService(logger);
    await otelService.start();

    await loggerStorage.run({ correlationId: 'system' }, async () => {
        // Disable auth for Stdio transport (implicitly trusted as it is spawned by the user)
        const isStdio = configService.get('transport') === 'stdio';
        const ipcToken = isStdio ? undefined : configService.get('ipcBearerToken');

        const securityService = new SecurityService(logger, ipcToken!);

        const gatewayService = new GatewayService(logger, securityService);
        const upstreams = configService.get('upstreams') || [];
        for (const upstream of upstreams) {
            gatewayService.registerUpstream(upstream);
        }

        const executorRegistry = new ExecutorRegistry();
        executorRegistry.register('deno', new DenoExecutor(configService.get('denoMaxPoolSize')));
        executorRegistry.register('python', new PyodideExecutor(configService.get('pyodideMaxPoolSize')));

        // IsolateExecutor needs gatewayService
        const isolateExecutor = new IsolateExecutor(logger, gatewayService);
        executorRegistry.register('isolate', isolateExecutor);

        const executionService = new ExecutionService(
            logger,
            configService.get('resourceLimits'),
            gatewayService,
            securityService,
            executorRegistry
        );

        const requestController = new RequestController(
            logger,
            executionService,
            gatewayService,
            buildDefaultMiddleware(securityService)
        );

        const opsServer = new OpsServer(logger, configService.all, gatewayService, requestController);
        await opsServer.listen();

        const concurrencyService = new ConcurrencyService(logger, {
            maxConcurrent: configService.get('maxConcurrent')
        });

        let transport: SocketTransport | StdioTransport;
        let address: string;

        if (configService.get('transport') === 'stdio') {
            transport = new StdioTransport(logger, requestController, concurrencyService);
            await transport.start();
            address = 'stdio';
        } else {
            transport = new SocketTransport(logger, requestController, concurrencyService);
            const port = configService.get('port');
            address = await transport.listen({ port });
        }
        executionService.ipcAddress = address;

        // Pre-warm workers
        await requestController.warmup();

        logger.info('Conduit server started');

        // Handle graceful shutdown
        const shutdown = async () => {
            logger.info('Shutting down...');
            await Promise.all([
                transport.close(),
                opsServer.close(),
                requestController.shutdown(),
                otelService.shutdown(),
            ]);
            process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    });
}

program.parse(process.argv);
