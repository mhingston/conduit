import { describe, it, expect, beforeEach } from 'vitest';
import { PolicyService, ToolIdentifier } from '../src/core/policy.service.js';

describe('PolicyService', () => {
    let policyService: PolicyService;

    beforeEach(() => {
        policyService = new PolicyService();
    });

    describe('parseToolName', () => {
        it('should parse namespace and name from qualified string', () => {
            const result = policyService.parseToolName('github__createIssue');
            expect(result).toEqual({ namespace: 'github', name: 'createIssue' });
        });

        it('should handle nested tool names', () => {
            const result = policyService.parseToolName('github__api__v2__listRepos');
            expect(result).toEqual({ namespace: 'github', name: 'api__v2__listRepos' });
        });

        it('should handle name without namespace', () => {
            const result = policyService.parseToolName('soloTool');
            expect(result).toEqual({ namespace: '', name: 'soloTool' });
        });
    });

    describe('formatToolName', () => {
        it('should format ToolIdentifier to qualified string', () => {
            const result = policyService.formatToolName({ namespace: 'github', name: 'createIssue' });
            expect(result).toBe('github__createIssue');
        });

        it('should handle empty namespace', () => {
            const result = policyService.formatToolName({ namespace: '', name: 'soloTool' });
            expect(result).toBe('soloTool');
        });
    });

    describe('isToolAllowed', () => {
        describe('exact matching', () => {
            it('should match exact tool name', () => {
                expect(policyService.isToolAllowed('github__createIssue', ['github.createIssue'])).toBe(true);
            });

            it('should reject non-matching tool', () => {
                expect(policyService.isToolAllowed('github__createIssue', ['github.deleteIssue'])).toBe(false);
            });

            it('should accept ToolIdentifier', () => {
                const tool: ToolIdentifier = { namespace: 'github', name: 'createIssue' };
                expect(policyService.isToolAllowed(tool, ['github.createIssue'])).toBe(true);
            });
        });

        describe('wildcard matching', () => {
            it('should match any tool in namespace with wildcard', () => {
                expect(policyService.isToolAllowed('github__createIssue', ['github.*'])).toBe(true);
                expect(policyService.isToolAllowed('github__deleteIssue', ['github.*'])).toBe(true);
            });

            it('should not match different namespace with wildcard', () => {
                expect(policyService.isToolAllowed('gitlab__createIssue', ['github.*'])).toBe(false);
            });

            it('should not allow partial namespace match (security)', () => {
                // "github.*" should NOT match "githubenterprise__tool"
                expect(policyService.isToolAllowed('githubenterprise__tool', ['github.*'])).toBe(false);
            });

            it('should match nested wildcards', () => {
                expect(policyService.isToolAllowed('github__api__listRepos', ['github.api.*'])).toBe(true);
            });

            it('should not match shallow when deep wildcard specified', () => {
                // "github.api.*" should NOT match "github__createIssue" (no api segment)
                expect(policyService.isToolAllowed('github__createIssue', ['github.api.*'])).toBe(false);
            });
        });

        describe('multiple patterns', () => {
            it('should match if any pattern matches', () => {
                const allowed = ['github.createIssue', 'gitlab.*'];
                expect(policyService.isToolAllowed('github__createIssue', allowed)).toBe(true);
                expect(policyService.isToolAllowed('gitlab__anything', allowed)).toBe(true);
                expect(policyService.isToolAllowed('bitbucket__tool', allowed)).toBe(false);
            });
        });
    });
});
