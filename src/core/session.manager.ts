import { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { LRUCache } from 'lru-cache';

export interface Session {
    allowedTools?: string[];
    createdAt: number;
}

export class SessionManager {
    private logger: Logger;
    private sessions: LRUCache<string, Session>;
    private readonly SESSION_TTL_MS = 3600000; // 1 hour

    constructor(logger: Logger) {
        this.logger = logger;
        this.sessions = new LRUCache({
            max: 10000,
            ttl: this.SESSION_TTL_MS,
        });
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
        return this.sessions.get(token);
    }

    invalidateSession(token: string): void {
        this.sessions.delete(token);
    }

    cleanupSessions() {
        // LRUCache handles this automatically via TTL
        this.sessions.purgeStale();
    }
}
