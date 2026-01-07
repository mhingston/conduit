/**
 * Language-agnostic interface for tool bindings.
 * Used to generate typed SDK code for sandbox injection.
 */
export interface ToolBinding {
    /** Full qualified name: "github__createIssue" */
    name: string;
    /** Upstream ID / namespace: "github" */
    namespace: string;
    /** Tool method name: "createIssue" */
    methodName: string;
    /** JSON Schema for input validation */
    inputSchema?: object;
    /** Human-readable description */
    description?: string;
}

export interface SDKGeneratorOptions {
    /** Tool bindings to include in SDK */
    tools: ToolBinding[];
    /** Allow $raw escape hatch for dynamic calls (default: true) */
    enableRawFallback?: boolean;
}

/**
 * Convert a prefixed tool name to a ToolBinding.
 * @param name Full tool name in format "namespace__methodName"
 * @param inputSchema Optional JSON Schema
 * @param description Optional description
 */
export function toToolBinding(
    name: string,
    inputSchema?: object,
    description?: string
): ToolBinding {
    const [namespace, ...methodParts] = name.split('__');
    const methodName = methodParts.join('__');

    return {
        name,
        namespace: namespace || 'default',
        methodName: methodName || name,
        inputSchema,
        description,
    };
}

/**
 * Group tool bindings by namespace for SDK generation.
 */
export function groupByNamespace(bindings: ToolBinding[]): Map<string, ToolBinding[]> {
    const groups = new Map<string, ToolBinding[]>();

    for (const binding of bindings) {
        const existing = groups.get(binding.namespace) || [];
        existing.push(binding);
        groups.set(binding.namespace, existing);
    }

    return groups;
}
