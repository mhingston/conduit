import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpsServer } from '../src/core/ops.server.js';
import { ConfigService } from '../src/core/config.service.js';
import { GatewayService } from '../src/gateway/gateway.service.js';
import { SecurityService } from '../src/core/security.service.js';
import { RequestController } from '../src/core/request.controller.js';
import { ExecutionService } from '../src/core/execution.service.js';
import { ExecutorRegistry } from '../src/core/registries/executor.registry.js';
import { buildDefaultMiddleware } from '../src/core/middleware/middleware.builder.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('OpsServer', () => {
    let opsServer: OpsServer;
    let configService: ConfigService;
    let gatewayService: GatewayService;

    beforeEach(() => {
        configService = new ConfigService({
            port: 0,
            opsPort: 0,
            metricsUrl: 'http://127.0.0.1:0/metrics' // Force fallback by using invalid URL
        } as any);
        const securityService = new SecurityService(logger, 'test-token');
        gatewayService = new GatewayService(logger, securityService);
        const executorRegistry = new ExecutorRegistry();
        executorRegistry.register('python', { healthCheck: vi.fn().mockResolvedValue({ status: 'ok' }) } as any);

        const executionService = new ExecutionService(
            logger,
            configService.get('resourceLimits'),
            gatewayService,
            securityService,
            executorRegistry
        );
        const requestController = new RequestController(logger, executionService, gatewayService, buildDefaultMiddleware(securityService));
        opsServer = new OpsServer(logger, configService.all, gatewayService, requestController);
    });

    afterEach(async () => {
        await opsServer.close();
    });

    it('should respond to /health', async () => {
        const address = await opsServer.listen();
        const url = new URL(address);
        const port = url.port;
        const response = await fetch(`http://localhost:${port}/health`);
        const data = await response.json() as any;
        expect(response.status).toBe(200);
        expect(data.status).toBe('ok');
        expect(data.request).toBeDefined();
        expect(data.request.pyodide).toBeDefined();
        expect(data.request.pyodide.status).toBe('ok');
    });

    it('should respond to /metrics in prometheus format', async () => {
        const address = await opsServer.listen();
        const url = new URL(address);
        const port = url.port;
        const response = await fetch(`http://localhost:${port}/metrics`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/plain');
        const text = await response.text();
        expect(text).toContain('conduit_uptime_seconds');
        expect(text).toContain('conduit_memory_rss_bytes');
    });
});
