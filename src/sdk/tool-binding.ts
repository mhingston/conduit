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

// Inline parsing to avoid circular dependency with PolicyService
function parseToolName(qualifiedName: string): { namespace: string; name: string } {
    const separatorIndex = qualifiedName.indexOf('__');
    if (separatorIndex === -1) {
        return { namespace: '', name: qualifiedName };
    }
    return {
        namespace: qualifiedName.substring(0, separatorIndex),
        name: qualifiedName.substring(separatorIndex + 2)
    };
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
    const toolId = parseToolName(name);

    return {
        name,
        namespace: toolId.namespace || 'default',
        methodName: toolId.name || name,
        inputSchema,
        description,
    };
}

/**
 * Convert a ToolStub to a ToolBinding.
 * @param stub ToolStub from GatewayService
 */
export function fromToolStub(stub: { id: string; name: string; description?: string }): ToolBinding {
    const toolId = parseToolName(stub.id);
    return {
        name: stub.id,
        namespace: toolId.namespace || 'default',
        methodName: stub.name, // stub.name is already the method name (e.g. "create_issue")
        description: stub.description,
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
