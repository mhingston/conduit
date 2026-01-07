import { Logger } from 'pino';
import dns from 'node:dns/promises';
import net from 'node:net';

export class NetworkPolicyService {
    private logger: Logger;

    private readonly privateRanges = [
        /^127\./,
        /^10\./,
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
        /^192\.168\./,
        /^169\.254\./, // Link-local
        /^localhost$/i,
        /^0\.0\.0\.0$/,
        /^::1$/, // IPv6 localhost
        /^fc00:/i, // IPv6 private
        /^fe80:/i, // IPv6 link-local
    ];

    private requestCounts = new Map<string, { count: number; resetTime: number }>();
    private readonly RATE_LIMIT = 30;
    private readonly WINDOW_MS = 60000;

    constructor(logger: Logger) {
        this.logger = logger;
    }

    async validateUrl(url: string): Promise<{ valid: boolean; message?: string }> {
        try {
            const parsed = new URL(url);
            const hostname = parsed.hostname;

            // Check literal hostname against private ranges
            for (const range of this.privateRanges) {
                if (range.test(hostname)) {
                    this.logger.warn({ hostname }, 'SSRF attempt detected: private range access');
                    return { valid: false, message: 'Access denied: private network access forbidden' };
                }
            }

            // DNS resolution check to prevent DNS rebinding and handle tricky hostnames
            if (!net.isIP(hostname)) {
                try {
                    const lookup = await dns.lookup(hostname, { all: true });
                    for (const address of lookup) {
                        const ip = address.address;
                        for (const range of this.privateRanges) {
                            if (range.test(ip)) {
                                this.logger.warn({ hostname, ip }, 'SSRF attempt detected: DNS resolves to private IP');
                                return { valid: false, message: 'Access denied: hostname resolves to private network' };
                            }
                        }
                    }
                } catch (err: any) {
                    // Strict SSRF protection: block if DNS lookup fails
                    this.logger.warn({ hostname, err: err.message }, 'DNS lookup failed during URL validation, blocking request');
                    return { valid: false, message: 'Access denied: hostname resolution failed' };
                }
            }

            return { valid: true };
        } catch (err: any) {
            return { valid: false, message: `Invalid URL: ${err.message}` };
        }
    }

    checkRateLimit(key: string): boolean {
        const now = Date.now();
        const record = this.requestCounts.get(key);

        if (!record || now > record.resetTime) {
            this.requestCounts.set(key, { count: 1, resetTime: now + this.WINDOW_MS });
            return true;
        }

        if (record.count >= this.RATE_LIMIT) {
            this.logger.warn({ key }, 'Rate limit exceeded');
            return false;
        }

        record.count++;
        return true;
    }
}
