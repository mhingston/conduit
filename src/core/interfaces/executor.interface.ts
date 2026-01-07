import { ResourceLimits } from '../config.service.js';
import { ExecutionContext } from '../execution.context.js';

export interface ExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    error?: {
        code: number;
        message: string;
    };
}

export interface ExecutorConfig {
    ipcAddress?: string;
    ipcToken?: string;
    sdkCode?: string;
}

export interface Executor {
    execute(
        code: string,
        limits: ResourceLimits,
        context: ExecutionContext,
        config?: ExecutorConfig
    ): Promise<ExecutionResult>;

    shutdown?(): Promise<void>;
}
