import Fastify from 'fastify';
import { Logger } from 'pino';
import { AppConfig } from './interfaces/app.config.js';
import { GatewayService } from '../gateway/gateway.service.js';
import { metrics } from './metrics.service.js';
import { RequestController } from './request.controller.js';
import axios from 'axios';

export class OpsServer {
    private fastify = Fastify();
    private logger: Logger;
    private config: AppConfig;
    private gatewayService: GatewayService;
    private requestController: RequestController;

    constructor(logger: Logger, config: AppConfig, gatewayService: GatewayService, requestController: RequestController) {
        this.logger = logger;
        this.config = config;
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
                // Use ConfigService for metrics URL, default to standard localhost:9464
                const metricsUrl = this.config.metricsUrl || 'http://127.0.0.1:9464/metrics';
                const response = await axios.get(metricsUrl);
                return reply.type('text/plain').send(response.data);
            } catch (err) {
                this.logger.error({ err }, 'Failed to fetch OTEL metrics');
                // Fallback to minimal metrics if OTEL exporter is down
                const fallback = '# Metrics consolidated into OpenTelemetry. Check port 9464.\n' +
                    `conduit_uptime_seconds ${process.uptime()}\n` +
                    `conduit_memory_rss_bytes ${process.memoryUsage().rss}\n`;
                return reply.type('text/plain').send(fallback);
            }
        });
    }

    async listen(): Promise<string> {
        // Use explicit opsPort from config
        const port = this.config.opsPort || 3001;
        try {
            const address = await this.fastify.listen({ port, host: '0.0.0.0' });
            this.logger.info({ address }, 'Ops server listening');
            return address;
        } catch (err) {
            this.logger.error({ err }, 'Failed to start Ops server');
            throw err;
        }
    }

    async close() {
        await this.fastify.close();
    }
}
