import { v4 as uuidv4 } from 'uuid';
import { Logger } from 'pino';

export interface ExecutionContextOptions {
    tenantId?: string;
    logger: Logger;
    allowedTools?: string[];
    remoteAddress?: string;
    strictValidation?: boolean;
}

export class ExecutionContext {
    public readonly correlationId: string;
    public readonly startTime: number;
    public readonly tenantId?: string;
    public logger: Logger;
    public allowedTools?: string[];
    public readonly remoteAddress?: string;
    public readonly strictValidation: boolean;

    constructor(options: ExecutionContextOptions) {
        this.correlationId = uuidv4();
        this.startTime = Date.now();
        this.tenantId = options.tenantId;
        this.allowedTools = options.allowedTools;
        this.remoteAddress = options.remoteAddress;
        this.strictValidation = options.strictValidation ?? false;
        this.logger = options.logger.child({
            correlationId: this.correlationId,
            tenantId: this.tenantId,
        });
    }

    getDuration(): number {
        return Date.now() - this.startTime;
    }
}
