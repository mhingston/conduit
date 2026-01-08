import { ToolBinding, groupByNamespace } from './tool-binding.js';

/**
 * Generates in-memory SDK code from discovered tool bindings.
 * The generated code creates a nested object structure where
 * tools.namespace.method(args) => callTool("namespace__method", args)
 */
export class SDKGenerator {
    /**
     * Convert camelCase to snake_case for Python
     */
    private toSnakeCase(str: string): string {
        return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
    }

    /**
     * Escape a string for use in generated code
     */
    private escapeString(str: string): string {
        return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
    }

    /**
     * Generate TypeScript SDK code to be injected into Deno sandbox.
     * Creates: tools.namespace.method(args) => __internalCallTool("namespace__method", args)
     * @param bindings Tool bindings to generate SDK for
     * @param allowedTools Optional allowlist for $raw() enforcement
     * @param enableRawFallback Enable $raw() escape hatch (default: true)
     */
    generateTypeScript(bindings: ToolBinding[], allowedTools?: string[], enableRawFallback = true): string {
        const grouped = groupByNamespace(bindings);
        const lines: string[] = [];

        lines.push('// Generated SDK - Do not edit');

        // Inject allowlist for SDK-level enforcement
        if (allowedTools && allowedTools.length > 0) {
            const normalizedList = allowedTools.map(t => t.replace(/\./g, '__'));
            lines.push(`const __allowedTools = ${JSON.stringify(normalizedList)};`);
        } else {
            lines.push('const __allowedTools = null;');
        }

        lines.push('const tools = {');

        for (const [namespace, tools] of grouped.entries()) {
            // Validate namespace is a valid identifier
            const safeNamespace = this.isValidIdentifier(namespace) ? namespace : `["${this.escapeString(namespace)}"]`;

            if (this.isValidIdentifier(namespace)) {
                lines.push(`  ${namespace}: {`);
            } else {
                lines.push(`  "${this.escapeString(namespace)}": {`);
            }

            for (const tool of tools) {
                const methodName = this.isValidIdentifier(tool.methodName)
                    ? tool.methodName
                    : `["${this.escapeString(tool.methodName)}"]`;

                // Add JSDoc if description available
                if (tool.description) {
                    lines.push(`    /** ${this.escapeString(tool.description)} */`);
                }

                if (this.isValidIdentifier(tool.methodName)) {
                    lines.push(`    async ${tool.methodName}(args) {`);
                } else {
                    lines.push(`    "${this.escapeString(tool.methodName)}": async function(args) {`);
                }
                lines.push(`      return await __internalCallTool("${this.escapeString(tool.name)}", args);`);
                lines.push(`    },`);
            }

            lines.push(`  },`);
        }

        // Add $raw escape hatch with allowlist validation
        if (enableRawFallback) {
            lines.push(`  /** Call a tool by its full name (escape hatch for dynamic/unknown tools) */`);
            lines.push(`  async $raw(name, args) {`);
            lines.push(`    const normalized = name.replace(/\\./g, '__');`);
            lines.push(`    if (__allowedTools) {`);
            lines.push(`      const allowed = __allowedTools.some(p => {`);
            lines.push(`        if (p.endsWith('__*')) return normalized.startsWith(p.slice(0, -1));`);
            lines.push(`        return normalized === p;`);
            lines.push(`      });`);
            lines.push(`      if (!allowed) throw new Error(\`Tool \${name} is not in the allowlist\`);`);
            lines.push(`    }`);
            lines.push(`    return await __internalCallTool(normalized, args);`);
            lines.push(`  },`);
        }

        lines.push('};');
        lines.push('(globalThis as any).tools = tools;');

        return lines.join('\n');
    }

    /**
     * Generate Python SDK code to be injected into Pyodide sandbox.
     * Creates: tools.namespace.method(args) => _internal_call_tool("namespace__method", args)
     * @param bindings Tool bindings to generate SDK for
     * @param allowedTools Optional allowlist for raw() enforcement
     * @param enableRawFallback Enable raw() escape hatch (default: true)
     */
    generatePython(bindings: ToolBinding[], allowedTools?: string[], enableRawFallback = true): string {
        const grouped = groupByNamespace(bindings);
        const lines: string[] = [];

        lines.push('# Generated SDK - Do not edit');

        // Inject allowlist for SDK-level enforcement
        if (allowedTools && allowedTools.length > 0) {
            const normalizedList = allowedTools.map(t => t.replace(/\./g, '__'));
            lines.push(`_allowed_tools = ${JSON.stringify(normalizedList)}`);
        } else {
            lines.push('_allowed_tools = None');
        }

        lines.push('');
        lines.push('class _ToolNamespace:');
        lines.push('    def __init__(self, methods):');
        lines.push('        for name, fn in methods.items():');
        lines.push('            setattr(self, name, fn)');
        lines.push('');
        lines.push('class _Tools:');
        lines.push('    def __init__(self):');

        for (const [namespace, tools] of grouped.entries()) {
            const safeNamespace = this.toSnakeCase(namespace);
            const methodsDict: string[] = [];

            for (const tool of tools) {
                const methodName = this.toSnakeCase(tool.methodName);
                const fullName = tool.name;
                // Use async lambda - Python doesn't have async lambdas natively,
                // so we define methods that return awaitable coroutines
                methodsDict.push(`            "${methodName}": lambda args, n="${this.escapeString(fullName)}": _internal_call_tool(n, args)`);
            }

            lines.push(`        self.${safeNamespace} = _ToolNamespace({`);
            lines.push(methodsDict.join(',\n'));
            lines.push(`        })`);
        }

        // Add raw escape hatch with allowlist validation
        if (enableRawFallback) {
            lines.push('');
            lines.push('    async def raw(self, name, args):');
            lines.push('        """Call a tool by its full name (escape hatch for dynamic/unknown tools)"""');
            lines.push('        normalized = name.replace(".", "__")');
            lines.push('        if _allowed_tools is not None:');
            lines.push('            allowed = any(');
            lines.push('                normalized.startswith(p[:-1]) if p.endswith("__*") else normalized == p');
            lines.push('                for p in _allowed_tools');
            lines.push('            )');
            lines.push('            if not allowed:');
            lines.push('                raise PermissionError(f"Tool {name} is not in the allowlist")');
            lines.push('        return await _internal_call_tool(normalized, args)');
        }

        lines.push('');
        lines.push('tools = _Tools()');

        return lines.join('\n');
    }

    /**
     * Generate JavaScript SDK code for isolated-vm (V8 Isolate).
     * Creates: tools.namespace.method(args) => __callToolSync("namespace__method", JSON.stringify(args))
     * @param bindings Tool bindings to generate SDK for
     * @param allowedTools Optional allowlist for $raw() enforcement
     * @param enableRawFallback Enable $raw() escape hatch (default: true)
     */
    generateIsolateSDK(bindings: ToolBinding[], allowedTools?: string[], enableRawFallback = true): string {
        const grouped = groupByNamespace(bindings);
        const lines: string[] = [];

        lines.push('// Generated SDK for isolated-vm');

        // Inject allowlist for SDK-level enforcement (optional, as Gateway also enforces)
        if (allowedTools && allowedTools.length > 0) {
            const normalizedList = allowedTools.map(t => t.replace(/\./g, '__'));
            lines.push(`const __allowedTools = ${JSON.stringify(normalizedList)};`);
        } else {
            lines.push('const __allowedTools = null;');
        }

        lines.push('const tools = {');

        for (const [namespace, tools] of grouped.entries()) {
            const safeNamespace = this.isValidIdentifier(namespace) ? namespace : `["${this.escapeString(namespace)}"]`;

            if (this.isValidIdentifier(namespace)) {
                lines.push(`  ${namespace}: {`);
            } else {
                lines.push(`  "${this.escapeString(namespace)}": {`);
            }

            for (const tool of tools) {
                const methodName = this.isValidIdentifier(tool.methodName) ? tool.methodName : `["${this.escapeString(tool.methodName)}"]`;

                if (this.isValidIdentifier(tool.methodName)) {
                    lines.push(`    async ${methodName}(args) {`);
                } else {
                    lines.push(`    "${this.escapeString(tool.methodName)}": async function(args) {`);
                }

                lines.push(`      const resStr = await __callTool("${this.escapeString(tool.name)}", JSON.stringify(args || {}));`);
                lines.push(`      return JSON.parse(resStr);`);
                lines.push(`    },`);
            }

            lines.push(`  },`);
        }

        // Add $raw escape hatch
        if (enableRawFallback) {
            lines.push(`  async $raw(name, args) {`);
            lines.push(`    const normalized = name.replace(/\\./g, '__');`);
            lines.push(`    if (__allowedTools) {`);
            lines.push(`      const allowed = __allowedTools.some(p => {`);
            lines.push(`        if (p.endsWith('__*')) return normalized.startsWith(p.slice(0, -1));`);
            lines.push(`        return normalized === p;`);
            lines.push(`      });`);
            lines.push(`      if (!allowed) throw new Error(\`Tool \${name} is not in the allowlist\`);`);
            lines.push(`    }`);
            lines.push(`    const resStr = await __callTool(normalized, JSON.stringify(args || {}));`);
            lines.push(`    return JSON.parse(resStr);`);
            lines.push(`  },`);
        }

        lines.push('};');

        return lines.join('\n');
    }

    /**
     * Check if a string is a valid JavaScript/Python identifier
     */
    private isValidIdentifier(str: string): boolean {
        return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(str);
    }
}
