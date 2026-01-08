import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';

export class OtelService {
    private sdk: NodeSDK | null = null;

    constructor(private logger: any) { }

    async start() {
        this.sdk = new NodeSDK({
            resource: resourceFromAttributes({
                [SemanticResourceAttributes.SERVICE_NAME]: 'conduit',
            }),
            metricReader: new PrometheusExporter({
                port: 9464, // Default prometheus exporter port
            }),
            instrumentations: [
                getNodeAutoInstrumentations(),
                new PinoInstrumentation(),
            ],
        });

        try {
            await this.sdk.start();
            this.logger.info('OpenTelemetry SDK started');
        } catch (error) {
            this.logger.error({ error }, 'Error starting OpenTelemetry SDK');
        }
    }

    async shutdown() {
        if (this.sdk) {
            await this.sdk.shutdown();
            this.logger.info('OpenTelemetry SDK shut down');
        }
    }
}
