import { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';

export interface Session {
    allowedTools?: string[];
    createdAt: number;
}

export class SessionManager {
    private logger: Logger;
    private sessions = new Map<string, Session>();
    private readonly SESSION_TTL_MS = 3600000; // 1 hour

    constructor(logger: Logger) {
        this.logger = logger;

        // Cleanup expired sessions periodically
        const cleanupInterval = setInterval(() => this.cleanupSessions(), 300000); // Every 5 minutes
        cleanupInterval.unref();
    }

    createSession(allowedTools?: string[]): string {
        const token = uuidv4();
        this.sessions.set(token, {
            allowedTools,
            createdAt: Date.now()
        });
        return token;
    }

    getSession(token: string): Session | undefined {
        const session = this.sessions.get(token);
        if (session && Date.now() - session.createdAt > this.SESSION_TTL_MS) {
            this.sessions.delete(token);
            return undefined;
        }
        return session;
    }

    invalidateSession(token: string): void {
        this.sessions.delete(token);
    }

    private cleanupSessions() {
        const now = Date.now();
        for (const [token, session] of this.sessions.entries()) {
            if (now - session.createdAt > this.SESSION_TTL_MS) {
                this.sessions.delete(token);
            }
        }
    }
}
