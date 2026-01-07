import { ConfigService } from './core/config.service.js';
import { createLogger, loggerStorage } from './core/logger.js';
import { SocketTransport } from './transport/socket.transport.js';
import { OpsServer } from './core/ops.server.js';
import { ConcurrencyService } from './core/concurrency.service.js';
import { RequestController } from './core/request.controller.js';
import { GatewayService } from './gateway/gateway.service.js';
import { SecurityService } from './core/security.service.js';
import { OtelService } from './core/otel.service.js';

async function main() {
    const configService = new ConfigService();
    const logger = createLogger(configService);

    const otelService = new OtelService(logger);
    await otelService.start();

    await loggerStorage.run({ correlationId: 'system' }, async () => {
        const securityService = new SecurityService(logger, configService.get('ipcBearerToken'));

        const gatewayService = new GatewayService(logger, securityService);
        // registerUpstream from configService...

        const requestController = new RequestController(
            logger,
            configService.get('resourceLimits'),
            gatewayService,
            securityService
        );

        const opsServer = new OpsServer(logger, configService, gatewayService, requestController);
        await opsServer.listen();

        const concurrencyService = new ConcurrencyService(logger, {
            maxConcurrent: configService.get('maxConcurrent')
        });

        const transport = new SocketTransport(logger, requestController, securityService, concurrencyService);
        const port = configService.get('port');
        const address = await transport.listen({ port });
        requestController.ipcAddress = address;

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

main().catch((err) => {
    console.error('Failed to start Conduit:', err);
    process.exit(1);
});
