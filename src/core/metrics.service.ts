import { metrics as otelMetrics, Counter, Histogram, ObservableGauge, ValueType } from '@opentelemetry/api';

export class MetricsService {
    private static instance: MetricsService;
    private meter = otelMetrics.getMeter('conduit');

    private executionCounter: Counter;
    private cacheHitsCounter: Counter;
    private cacheMissesCounter: Counter;
    private executionLatency: Histogram;
    private toolExecutionDuration: Histogram;
    private requestQueueLength: ObservableGauge;
    private activeExecutionsGauge: ObservableGauge;

    private activeExecutionsCount = 0;

    private queueLengthCallback: () => number = () => 0;

    private constructor() {
        this.executionCounter = this.meter.createCounter('conduit.executions.total', {
            description: 'Total number of executions',
        });

        this.cacheHitsCounter = this.meter.createCounter('conduit.cache.hits.total', {
            description: 'Total number of schema cache hits',
        });

        this.cacheMissesCounter = this.meter.createCounter('conduit.cache.misses.total', {
            description: 'Total number of schema cache misses',
        });

        this.executionLatency = this.meter.createHistogram('conduit.executions.latency', {
            description: 'Execution latency in milliseconds',
            unit: 'ms',
            valueType: ValueType.DOUBLE,
        });

        this.toolExecutionDuration = this.meter.createHistogram('conduit.tool.execution_duration_seconds', {
            description: 'Duration of tool executions',
            unit: 's',
            valueType: ValueType.DOUBLE,
        });

        this.requestQueueLength = this.meter.createObservableGauge('conduit.request_queue_length', {
            description: 'Current request queue depth',
            valueType: ValueType.INT,
        });

        this.activeExecutionsGauge = this.meter.createObservableGauge('conduit.executions.active', {
            description: 'Current number of active executions',
        });

        this.activeExecutionsGauge.addCallback((result) => {
            result.observe(this.activeExecutionsCount);
        });

        this.requestQueueLength.addCallback((result) => {
            result.observe(this.queueLengthCallback());
        });
    }

    static getInstance(): MetricsService {
        if (!MetricsService.instance) {
            MetricsService.instance = new MetricsService();
        }
        return MetricsService.instance;
    }

    recordExecutionStart() {
        this.activeExecutionsCount++;
        this.executionCounter.add(1);
    }

    recordExecutionEnd(durationMs: number, toolName?: string) {
        this.activeExecutionsCount = Math.max(0, this.activeExecutionsCount - 1);
        this.executionLatency.record(durationMs, { tool: toolName || 'unknown' });
    }

    recordToolExecution(durationMs: number, toolName: string, success: boolean) {
        // Convert ms to seconds for the histogram
        this.toolExecutionDuration.record(durationMs / 1000, {
            tool_name: toolName,
            success: String(success)
        });
    }

    recordCacheHit() {
        this.cacheHitsCounter.add(1);
    }

    recordCacheMiss() {
        this.cacheMissesCounter.add(1);
    }

    // This is now handled by OTEL Prometheus exporter, 
    // but we can provide a way to get the endpoint data if needed.


    getMetrics() {
        return {
            activeExecutions: this.activeExecutionsCount,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
        };
    }

    registerQueueLengthProvider(provider: () => number) {
        this.queueLengthCallback = provider;
    }
}

export const metrics = MetricsService.getInstance();
