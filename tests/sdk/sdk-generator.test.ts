import { describe, it, expect } from 'vitest';
import { SDKGenerator } from '../../src/sdk/sdk-generator.js';
import { ToolBinding, toToolBinding, groupByNamespace } from '../../src/sdk/tool-binding.js';

describe('SDKGenerator', () => {
    const generator = new SDKGenerator();

    describe('generateTypeScript', () => {
        it('should generate SDK with nested namespace structure', () => {
            const bindings: ToolBinding[] = [
                { name: 'github__createIssue', namespace: 'github', methodName: 'createIssue' },
                { name: 'github__listRepos', namespace: 'github', methodName: 'listRepos' },
                { name: 'slack__sendMessage', namespace: 'slack', methodName: 'sendMessage' },
            ];

            const code = generator.generateTypeScript(bindings);

            expect(code).toContain('const _tools = {');
            expect(code).toContain('github: {');
            expect(code).toContain('async createIssue(args)');
            expect(code).toContain('await __internalCallTool("github__createIssue", args)');
            expect(code).toContain('slack: {');
            expect(code).toContain('async sendMessage(args)');
            expect(code).toContain('const tools = new Proxy(_tools');
            expect(code).toContain('(globalThis as any).tools = tools');
        });

        it('should include $raw escape hatch by default', () => {
            const bindings: ToolBinding[] = [
                { name: 'test__method', namespace: 'test', methodName: 'method' },
            ];

            const code = generator.generateTypeScript(bindings);

            expect(code).toContain('async $raw(name, args)');
            expect(code).toContain('await __internalCallTool(normalized, args)');
        });

        it('should omit $raw when disabled', () => {
            const bindings: ToolBinding[] = [
                { name: 'test__method', namespace: 'test', methodName: 'method' },
            ];

            const code = generator.generateTypeScript(bindings, undefined, false);

            expect(code).not.toContain('async $raw(name, args)');
        });

        it('should include JSDoc comments from descriptions', () => {
            const bindings: ToolBinding[] = [
                { name: 'github__createIssue', namespace: 'github', methodName: 'createIssue', description: 'Create a new GitHub issue' },
            ];

            const code = generator.generateTypeScript(bindings);

            expect(code).toContain('/** Create a new GitHub issue */');
        });

        it('should handle empty bindings', () => {
            const code = generator.generateTypeScript([]);

            expect(code).toContain('const _tools = {');
            expect(code).toContain('async $raw(name, args)');
        });
    });

    describe('generatePython', () => {
        it('should generate SDK with nested namespace structure', () => {
            const bindings: ToolBinding[] = [
                { name: 'github__createIssue', namespace: 'github', methodName: 'createIssue' },
                { name: 'slack__sendMessage', namespace: 'slack', methodName: 'sendMessage' },
            ];

            const code = generator.generatePython(bindings);

            expect(code).toContain('class _Tools:');
            expect(code).toContain('self.github = _github_Namespace');
            expect(code).toContain('async def create_issue(self, args=None, **kwargs)');  // accepts dict or kwargs
            expect(code).toContain('self.slack = _slack_Namespace');
            expect(code).toContain('async def send_message(self, args=None, **kwargs)');  // accepts dict or kwargs
            expect(code).toContain('tools = _Tools()');
        });

        it('should include raw escape hatch', () => {
            const bindings: ToolBinding[] = [
                { name: 'test__method', namespace: 'test', methodName: 'method' },
            ];

            const code = generator.generatePython(bindings);

            expect(code).toContain('async def raw(self, name, args=None)');
            expect(code).toContain('await _internal_call_tool(normalized, args or {})');
        });

        it('should inject allowlist when provided', () => {
            const bindings: ToolBinding[] = [
                { name: 'test__method', namespace: 'test', methodName: 'method' },
            ];

            const code = generator.generatePython(bindings, ['test.method', 'other.*']);

            expect(code).toContain('_allowed_tools = ["test__method","other__*"]');
            expect(code).toContain('if _allowed_tools is not None');
        });
    });
});

describe('SDK Allowlist Enforcement', () => {
    const generator = new SDKGenerator();

    describe('TypeScript', () => {
        it('should inject allowlist when provided', () => {
            const bindings: ToolBinding[] = [
                { name: 'github__createIssue', namespace: 'github', methodName: 'createIssue' },
            ];

            const code = generator.generateTypeScript(bindings, ['github.createIssue', 'slack.*']);

            expect(code).toContain('const __allowedTools = ["github__createIssue","slack__*"]');
            expect(code).toContain('if (__allowedTools)');
        });

        it('should set __allowedTools to null when no allowlist', () => {
            const bindings: ToolBinding[] = [
                { name: 'test__method', namespace: 'test', methodName: 'method' },
            ];

            const code = generator.generateTypeScript(bindings);

            expect(code).toContain('const __allowedTools = null');
        });

        it('should include wildcard pattern matching', () => {
            const bindings: ToolBinding[] = [];
            const code = generator.generateTypeScript(bindings, ['github.*']);

            expect(code).toContain("if (p.endsWith('__*'))");
            expect(code).toContain('normalized.startsWith(p.slice(0, -1))');
        });
    });

    describe('Python', () => {
        it('should inject allowlist when provided', () => {
            const bindings: ToolBinding[] = [];
            const code = generator.generatePython(bindings, ['github.createIssue']);

            expect(code).toContain('_allowed_tools = ["github__createIssue"]');
            expect(code).toContain('if _allowed_tools is not None');
        });

        it('should set _allowed_tools to None when no allowlist', () => {
            const bindings: ToolBinding[] = [];
            const code = generator.generatePython(bindings);

            expect(code).toContain('_allowed_tools = None');
        });

        it('should include wildcard pattern matching', () => {
            const bindings: ToolBinding[] = [];
            const code = generator.generatePython(bindings, ['github.*']);

            expect(code).toContain('p.endswith("__*")');
            expect(code).toContain('raise PermissionError');
        });
    });
});

describe('toToolBinding', () => {
    it('should parse fully qualified tool name', () => {
        const binding = toToolBinding('github__createIssue');

        expect(binding.name).toBe('github__createIssue');
        expect(binding.namespace).toBe('github');
        expect(binding.methodName).toBe('createIssue');
    });

    it('should handle multi-part method names', () => {
        const binding = toToolBinding('mcp__filesystem__read_file');

        expect(binding.namespace).toBe('mcp');
        expect(binding.methodName).toBe('filesystem__read_file');
    });

    it('should include optional fields', () => {
        const schema = { type: 'object' };
        const binding = toToolBinding('test__method', schema, 'Test description');

        expect(binding.inputSchema).toEqual(schema);
        expect(binding.description).toBe('Test description');
    });
});

describe('groupByNamespace', () => {
    it('should group bindings by namespace', () => {
        const bindings: ToolBinding[] = [
            { name: 'a__one', namespace: 'a', methodName: 'one' },
            { name: 'a__two', namespace: 'a', methodName: 'two' },
            { name: 'b__one', namespace: 'b', methodName: 'one' },
        ];

        const groups = groupByNamespace(bindings);

        expect(groups.get('a')?.length).toBe(2);
        expect(groups.get('b')?.length).toBe(1);
    });
});
