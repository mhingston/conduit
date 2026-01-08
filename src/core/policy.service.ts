/**
 * PolicyService - Authorization and tool access control
 * Extracted from GatewayService per architecture-findings.md
 */

/**
 * Structured identifier for a tool, replacing fragile `upstream__toolname` strings.
 */
export interface ToolIdentifier {
    namespace: string;  // upstream ID (e.g., "github")
    name: string;       // tool name (e.g., "createIssue")
}

export class PolicyService {
    /**
     * Parse a qualified tool name string into a structured ToolIdentifier.
     * @param qualifiedName - e.g., "github__createIssue" or "github__api__listRepos"
     */
    parseToolName(qualifiedName: string): ToolIdentifier {
        const separatorIndex = qualifiedName.indexOf('__');
        if (separatorIndex === -1) {
            // No namespace - treat entire string as name with empty namespace
            return { namespace: '', name: qualifiedName };
        }
        return {
            namespace: qualifiedName.substring(0, separatorIndex),
            name: qualifiedName.substring(separatorIndex + 2)
        };
    }

    /**
     * Format a ToolIdentifier back to a qualified string.
     */
    formatToolName(tool: ToolIdentifier): string {
        if (!tool.namespace) {
            return tool.name;
        }
        return `${tool.namespace}__${tool.name}`;
    }

    /**
     * Check if a tool matches any pattern in the allowlist.
     * Supports:
     *   - Exact match: "github.createIssue" matches "github__createIssue"
     *   - Wildcard: "github.*" matches any tool in the github namespace
     * 
     * @param tool - ToolIdentifier or qualified string
     * @param allowedTools - Array of patterns (dot-notation, e.g., "github.*" or "github.createIssue")
     */
    isToolAllowed(tool: ToolIdentifier | string, allowedTools: string[]): boolean {
        const toolId = typeof tool === 'string' ? this.parseToolName(tool) : tool;
        const toolParts = [toolId.namespace, ...toolId.name.split('__')].filter(p => p);

        return allowedTools.some(pattern => {
            const patternParts = pattern.split('.');

            // Wildcard pattern: "foo.*" or "foo.bar.*"
            if (patternParts[patternParts.length - 1] === '*') {
                const prefixParts = patternParts.slice(0, -1);
                if (prefixParts.length > toolParts.length) return false;

                // Check if prefix parts match tool parts exactly
                for (let i = 0; i < prefixParts.length; i++) {
                    if (prefixParts[i] !== toolParts[i]) return false;
                }
                return true;
            }

            // Exact match: pattern parts must equal tool parts
            if (patternParts.length !== toolParts.length) return false;
            for (let i = 0; i < patternParts.length; i++) {
                if (patternParts[i] !== toolParts[i]) return false;
            }
            return true;
        });
    }
}
