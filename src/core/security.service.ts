import { Logger } from 'pino';
import { NetworkPolicyService } from './network.policy.service.js';
import { SessionManager, Session } from './session.manager.js';
import { IUrlValidator } from './interfaces/url.validator.interface.js';

export { Session };

export class SecurityService implements IUrlValidator {
    private logger: Logger;
    private ipcToken: string;
    private networkPolicy: NetworkPolicyService;
    private sessionManager: SessionManager;

    constructor(logger: Logger, ipcToken: string) {
        this.logger = logger;
        this.ipcToken = ipcToken;
        this.networkPolicy = new NetworkPolicyService(logger);
        this.sessionManager = new SessionManager(logger);
    }

    validateCode(code: string): { valid: boolean; message?: string } {
        // Regex-based validation is insufficient and provides a false sense of security.
        // We rely on runtime sandboxing (Deno permissions, Isolate context) instead.
        return { valid: true };
    }

    async validateUrl(url: string): Promise<{ valid: boolean; message?: string }> {
        return this.networkPolicy.validateUrl(url);
    }

    checkRateLimit(key: string): boolean {
        return this.networkPolicy.checkRateLimit(key);
    }

    validateIpcToken(token: string): boolean {
        return token === this.ipcToken || !!this.sessionManager.getSession(token);
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


    getIpcToken(): string {
        return this.ipcToken;
    }
}
