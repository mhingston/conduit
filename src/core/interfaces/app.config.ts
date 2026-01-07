import { ResourceLimits } from '../config.service.js';
import { UpstreamInfo } from '../../gateway/upstream.client.js';

export interface AppConfig {
    port: number;
    nodeEnv: 'development' | 'production' | 'test';
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    resourceLimits: ResourceLimits;
    secretRedactionPatterns: string[];
    ipcBearerToken: string;
    maxConcurrent: number;
    metricsUrl: string;
    opsPort?: number;
    upstreams?: UpstreamInfo[];
}
