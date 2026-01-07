import { Executor } from '../interfaces/executor.interface.js';

export class ExecutorRegistry {
    private executors = new Map<string, Executor>();

    register(name: string, executor: Executor): void {
        this.executors.set(name, executor);
    }

    get(name: string): Executor | undefined {
        return this.executors.get(name);
    }

    has(name: string): boolean {
        return this.executors.has(name);
    }

    async shutdownAll(): Promise<void> {
        for (const executor of this.executors.values()) {
            if (executor.shutdown) {
                await executor.shutdown();
            }
        }
        this.executors.clear();
    }
}
