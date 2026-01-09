import { z } from 'zod';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// Silence dotenv logging
const originalWrite = process.stdout.write;
// @ts-ignore
process.stdout.write = () => true;
dotenv.config();
process.stdout.write = originalWrite;

import { AppConfig } from './interfaces/app.config.js';


export const ResourceLimitsSchema = z.object({
    timeoutMs: z.number().default(30000),
    memoryLimitMb: z.number().default(256),
    maxOutputBytes: z.number().default(1024 * 1024), // 1MB
    maxLogEntries: z.number().default(10000),
});

export const UpstreamCredentialsSchema = z.object({
    type: z.enum(['oauth2', 'apiKey', 'bearer']), // Align with AuthType
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    tokenUrl: z.string().optional(),
    refreshToken: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    apiKey: z.string().optional(),
    bearerToken: z.string().optional(),
    headerName: z.string().optional(),
});

export const HttpUpstreamSchema = z.object({
    id: z.string(),
    type: z.literal('http').optional().default('http'),
    url: z.string(),
    credentials: UpstreamCredentialsSchema.optional(),
});

export const StdioUpstreamSchema = z.object({
    id: z.string(),
    type: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
});

export const UpstreamInfoSchema = z.union([HttpUpstreamSchema, StdioUpstreamSchema]);

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
    denoMaxPoolSize: z.number().default(10),
    pyodideMaxPoolSize: z.number().default(3),
    metricsUrl: z.string().default('http://127.0.0.1:9464/metrics'),
    opsPort: z.number().optional(),
    transport: z.enum(['socket', 'stdio']).default('socket'),
    upstreams: z.array(UpstreamInfoSchema).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigService {
    private config: AppConfig;

    constructor(overrides: Partial<AppConfig> = {}) {
        const fileConfig = this.loadConfigFile();

        const envConfig = {
            port: process.env.PORT,
            nodeEnv: process.env.NODE_ENV,
            logLevel: process.env.LOG_LEVEL,
            metricsUrl: process.env.METRICS_URL,
            ipcBearerToken: process.env.IPC_BEARER_TOKEN,
            transport: process.argv.includes('--stdio') ? 'stdio' : undefined,
            // upstreams: process.env.UPSTREAMS ? JSON.parse(process.env.UPSTREAMS) : undefined, // Removed per user request
        };

        // Remove undefined keys from envConfig
        Object.keys(envConfig).forEach(key => envConfig[key as keyof typeof envConfig] === undefined && delete envConfig[key as keyof typeof envConfig]);

        const mergedConfig = {
            ...fileConfig,
            ...envConfig,
            ...overrides,
        };

        const result = ConfigSchema.safeParse(mergedConfig);
        if (!result.success) {
            const error = result.error.format();
            throw new Error(`Invalid configuration: ${JSON.stringify(error, null, 2)}`);
        }

        this.config = result.data as AppConfig;

        // Default opsPort if not set
        if (this.config.opsPort === undefined) {
            if (this.config.transport === 'stdio') {
                this.config.opsPort = 0; // Random port for stdio to avoid conflicts
            } else {
                this.config.opsPort = this.config.port === 0 ? 0 : this.config.port + 1;
            }
        }
    }

    get<K extends keyof AppConfig>(key: K): AppConfig[K] {
        return this.config[key];
    }

    get all(): AppConfig {
        return { ...this.config };
    }

    private loadConfigFile(): Partial<AppConfig> {
        const configPath = process.env.CONFIG_FILE ||
            (fs.existsSync(path.resolve(process.cwd(), 'conduit.yaml')) ? 'conduit.yaml' :
                (fs.existsSync(path.resolve(process.cwd(), 'conduit.json')) ? 'conduit.json' : null));

        if (!configPath) return {};

        try {
            const fullPath = path.resolve(process.cwd(), configPath);
            let fileContent = fs.readFileSync(fullPath, 'utf-8');

            // Env var substitution: ${VAR} or ${VAR:-default}
            fileContent = fileContent.replace(/\$\{([a-zA-Z0-9_]+)(?::-([^}]+))?\}/g, (match, varName, defaultValue) => {
                const value = process.env[varName];
                if (value !== undefined) {
                    return value;
                }
                return defaultValue !== undefined ? defaultValue : '';
            });

            if (configPath.endsWith('.yaml') || configPath.endsWith('.yml')) {
                return yaml.load(fileContent) as Partial<AppConfig>;
            } else {
                return JSON.parse(fileContent);
            }
        } catch (error) {
            console.warn(`Failed to load config file ${configPath}:`, error);
            return {};
        }
    }
}
