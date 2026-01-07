import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

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
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigService {
    private config: Config;

    constructor(overrides: Partial<Config> = {}) {
        const rawConfig = {
            port: process.env.PORT,
            nodeEnv: process.env.NODE_ENV,
            logLevel: process.env.LOG_LEVEL,
            ...overrides,
        };

        const result = ConfigSchema.safeParse(rawConfig);
        if (!result.success) {
            const error = result.error.format();
            throw new Error(`Invalid configuration: ${JSON.stringify(error, null, 2)}`);
        }

        this.config = result.data;
    }

    get<K extends keyof Config>(key: K): Config[K] {
        return this.config[key];
    }

    get all(): Config {
        return { ...this.config };
    }
}
