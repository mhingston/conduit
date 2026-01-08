import pino from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConfigService } from './config.service.js';

export const loggerStorage = new AsyncLocalStorage<{ correlationId: string }>();

export function createLogger(configService: ConfigService) {
    const logLevel = configService.get('logLevel');
    const redactionPatterns = configService.get('secretRedactionPatterns');
    const secretPatterns = redactionPatterns.map(p => new RegExp(p, 'g'));

    const redactString = (str: string) => {
        let result = str;
        for (const pattern of secretPatterns) {
            result = result.replace(pattern, '[REDACTED]');
        }
        return result;
    };

    return pino({
        level: logLevel,
        hooks: {
            logMethod(inputArgs, method) {
                const redactedArgs = inputArgs.map(arg => {
                    try {
                        if (typeof arg === 'string') {
                            return redactString(arg);
                        }
                        if (typeof arg === 'object' && arg !== null) {
                            // Shallow clone and redact keys if they are strings
                            const clone = { ...arg } as any;
                            for (const key in clone) {
                                if (typeof clone[key] === 'string') {
                                    clone[key] = redactString(clone[key]);
                                }
                            }
                            return clone;
                        }
                    } catch (err) {
                        return '[REDACTION_ERROR]';
                    }
                    return arg;
                });
                return method.apply(this, redactedArgs as any);
            }
        },
        redact: {
            paths: ['toolParams.*', 'headers.Authorization', 'headers.authorization', 'params.token'],
            censor: '[REDACTED]',
        },
        mixin() {
            const store = loggerStorage.getStore();
            return {
                correlationId: store?.correlationId,
            };
        },
        // In stdio mode, never use pino-pretty to avoid stdout pollution
        transport: configService.get('transport') !== 'stdio' && configService.get('nodeEnv') === 'development'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
    }, configService.get('transport') === 'stdio'
        ? pino.destination(2) // Always write to stderr in stdio mode
        : undefined
    );
}
