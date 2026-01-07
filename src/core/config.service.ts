import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

import { AppConfig } from './interfaces/app.config.js';


export const ResourceLimitsSchema = z.object({
    timeoutMs: z.number().default(30000),
    memoryLimitMb: z.number().default(256),
    maxOutputBytes: z.number().default(1024 * 1024), // 1MB
    maxLogEntries: z.number().default(10000),
});

export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

export const ConfigSchema = z.object({
    port: z.union([z.string(), z.number()]).default('3000').transform((v) => Number(v)),
    nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    resourceLimits: ResourceLimitsSchema.default({
        timeoutMs: 30000,
        memoryLimitMb: 256,
        maxOutputBytes: 1024 * 1024,
        maxLogEntries: 10000,
    }),
    secretRedactionPatterns: z.array(z.string()).default([
        '[A-Za-z0-9-_]{20,}', // Default pattern from spec
    ]),
    ipcBearerToken: z.string().optional().default(() => Math.random().toString(36).substring(7)),
    maxConcurrent: z.number().default(10),
    metricsUrl: z.string().default('http://127.0.0.1:9464/metrics'),
    opsPort: z.number().optional(),
});

// We need to ensure Config matches AppConfig
// AppConfig requires opsPort? I made it optional in AppConfig.

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigService {
    private config: AppConfig;

    constructor(overrides: Partial<AppConfig> = {}) {
        const rawConfig = {
            port: process.env.PORT,
            nodeEnv: process.env.NODE_ENV,
            logLevel: process.env.LOG_LEVEL,
            metricsUrl: process.env.METRICS_URL,
            ...overrides,
        };

        const result = ConfigSchema.safeParse(rawConfig);
        if (!result.success) {
            const error = result.error.format();
            throw new Error(`Invalid configuration: ${JSON.stringify(error, null, 2)}`);
        }

        this.config = result.data as AppConfig;

        // Default opsPort if not set
        if (!this.config.opsPort) {
            this.config.opsPort = this.config.port + 1;
        }
    }

    get<K extends keyof AppConfig>(key: K): AppConfig[K] {
        return this.config[key];
    }

    get all(): AppConfig {
        return { ...this.config };
    }
}
