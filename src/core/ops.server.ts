import Fastify from 'fastify';
import { Logger } from 'pino';
import { ConfigService } from './config.service.js';
import { GatewayService } from '../gateway/gateway.service.js';
import { metrics } from './metrics.service.js';
import { RequestController } from './request.controller.js';
import axios from 'axios';

export class OpsServer {
    private fastify = Fastify();
    private logger: Logger;
    private configService: ConfigService;
    private gatewayService: GatewayService;
    private requestController: RequestController;

    constructor(logger: Logger, configService: ConfigService, gatewayService: GatewayService, requestController: RequestController) {
        this.logger = logger;
        this.configService = configService;
        this.gatewayService = gatewayService;
        this.requestController = requestController;

        this.setupRoutes();
    }

    private setupRoutes() {
        this.fastify.get('/health', async (request, reply) => {
            const gatewayHealth = await this.gatewayService.healthCheck();
            const requestHealth = await this.requestController.healthCheck();

            const overallStatus = gatewayHealth.status === 'ok' && requestHealth.status === 'ok' ? 'ok' : 'error';

            return reply.status(overallStatus === 'ok' ? 200 : 503).send({
                status: overallStatus,
                version: '1.0.0',
                gateway: gatewayHealth,
                request: requestHealth,
            });
        });

        this.fastify.get('/metrics', async (request, reply) => {
            try {
                // Proxy from OTEL Prometheus exporter
                const response = await axios.get('http://127.0.0.1:9464/metrics');
                return reply.type('text/plain').send(response.data);
            } catch (err) {
                this.logger.error({ err }, 'Failed to fetch OTEL metrics');
                // Fallback to minimal metrics if OTEL exporter is down
                const fallback = metrics.toPrometheus() +
                    `conduit_uptime_seconds ${process.uptime()}\n` +
                    `conduit_memory_rss_bytes ${process.memoryUsage().rss}\n`;
                return reply.type('text/plain').send(fallback);
            }
        });
    }

    async listen() {
        // Ops server runs on a different port than the main transport
        // Actually, we can make it configurable or use a offset
        const port = this.configService.get('port') + 1;
        try {
            const address = await this.fastify.listen({ port, host: '0.0.0.0' });
            this.logger.info({ address }, 'Ops server listening');
        } catch (err) {
            this.logger.error({ err }, 'Failed to start Ops server');
            throw err;
        }
    }

    async close() {
        await this.fastify.close();
    }
}
