import { Logger } from 'pino';
import dns from 'node:dns/promises';
import net from 'node:net';
import { LRUCache } from 'lru-cache';

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

    private readonly RATE_LIMIT = 30;
    private readonly WINDOW_MS = 60000;
    // Use LRUCache to prevent unbounded memory growth
    private requestCounts: LRUCache<string, { count: number; resetTime: number }>;

    constructor(logger: Logger) {
        this.logger = logger;
        this.requestCounts = new LRUCache({
            max: 10000,
            ttl: this.WINDOW_MS,
        });
    }

    async validateUrl(url: string): Promise<{ valid: boolean; message?: string; resolvedIp?: string }> {
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
                    // Store resolved IPs to check against blocklist
                    const resolvedIps: string[] = [];

                    for (const address of lookup) {
                        let ip = address.address;

                        // Fix Sev0: Normalize IPv6-mapped IPv4 addresses
                        if (ip.startsWith('::ffff:')) {
                            ip = ip.substring(7);
                        }

                        for (const range of this.privateRanges) {
                            if (range.test(ip)) {
                                this.logger.warn({ hostname, ip }, 'SSRF attempt detected: DNS resolves to private IP');
                                return { valid: false, message: 'Access denied: hostname resolves to private network' };
                            }
                        }
                        resolvedIps.push(ip);
                    }

                    // Fix Sev1: Return the validated IP to prevent DNS rebinding
                    // Use the first resolved IP
                    return { valid: true, resolvedIp: resolvedIps[0] };
                } catch (err: any) {
                    // Strict SSRF protection: block if DNS lookup fails
                    this.logger.warn({ hostname, err: err.message }, 'DNS lookup failed during URL validation, blocking request');
                    return { valid: false, message: 'Access denied: hostname resolution failed' };
                }
            }

            // If it was already an IP, it's valid if it passed the range check above
            return { valid: true, resolvedIp: hostname };
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
