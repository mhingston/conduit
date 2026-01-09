import { Logger } from 'pino';
import { NetworkPolicyService } from './network.policy.service.js';
import { SessionManager } from './session.manager.js';
import type { Session } from './session.manager.js';
import { IUrlValidator } from './interfaces/url.validator.interface.js';
import crypto from 'node:crypto';

export type { Session };

export class SecurityService implements IUrlValidator {
    private logger: Logger;
    private ipcToken: string | undefined;
    private networkPolicy: NetworkPolicyService;
    private sessionManager: SessionManager;

    constructor(logger: Logger, ipcToken: string | undefined) {
        this.logger = logger;
        this.ipcToken = ipcToken;
        this.networkPolicy = new NetworkPolicyService(logger);
        this.sessionManager = new SessionManager(logger);
    }

    validateCode(code: string): { valid: boolean; message?: string } {
        // [IMPORTANT] This is a SANITY CHECK only.
        // We rely on RUNTIME isolation (Deno permissions, Isolate context) for actual security.
        // Static analysis of code is fundamentally unable to prevent all sandbox escapes.
        if (!code || code.length > 1024 * 1024) { // 1MB limit for sanity
            return { valid: false, message: 'Code size exceeds limit or is empty' };
        }
        return { valid: true };
    }

    async validateUrl(url: string): Promise<{ valid: boolean; message?: string; resolvedIp?: string }> {
        return this.networkPolicy.validateUrl(url);
    }

    checkRateLimit(key: string): boolean {
        return this.networkPolicy.checkRateLimit(key);
    }

    validateIpcToken(token: string): boolean {
        // Fix Sev1: Use timing-safe comparison for sensitive tokens
        if (!this.ipcToken) {
            return true;
        }

        const expected = Buffer.from(this.ipcToken);
        const actual = Buffer.from(token);

        if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
            return true;
        }

        return !!this.sessionManager.getSession(token);
    }

    createSession(allowedTools?: string[]): string {
        return this.sessionManager.createSession(allowedTools);
    }

    getSession(token: string): Session | undefined {
        return this.sessionManager.getSession(token);
    }

    invalidateSession(token: string): void {
        this.sessionManager.invalidateSession(token);
    }


    getIpcToken(): string | undefined {
        return this.ipcToken;
    }
}
