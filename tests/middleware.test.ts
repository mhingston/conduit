import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthMiddleware } from '../src/core/middleware/auth.middleware.js';
import { RateLimitMiddleware } from '../src/core/middleware/ratelimit.middleware.js';
import { SecurityService } from '../src/core/security.service.js';
import { ExecutionContext } from '../src/core/execution.context.js';
import { ConduitError } from '../src/core/types.js';

describe('Middleware Tests', () => {
    let mockSecurityService: any;
    let mockLogger: any;
    let context: ExecutionContext;

    beforeEach(() => {
        mockSecurityService = {
            validateToken: vi.fn(),
            checkRateLimit: vi.fn(),
            getIpcToken: vi.fn(),
            validateIpcToken: vi.fn(),
            getSession: vi.fn(),
        };
        mockLogger = {
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            child: vi.fn(),
        };
        mockLogger.child.mockReturnValue(mockLogger);
        context = new ExecutionContext({ logger: mockLogger });
        mockNext.mockClear();
    });

    const mockNext = vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: 'ok' });

    describe('AuthMiddleware', () => {
        let authMiddleware: AuthMiddleware;

        beforeEach(() => {
            authMiddleware = new AuthMiddleware(mockSecurityService as SecurityService);
        });

        it('should validate bearer token', () => {
            mockSecurityService.validateToken.mockReturnValue(true);
            const request = {
                jsonrpc: '2.0',
                id: 1,
                method: 'test',
                auth: { bearerToken: 'valid-token' }
            };

            mockSecurityService.getIpcToken.mockReturnValue('master-token');
            mockSecurityService.validateIpcToken.mockReturnValue(false);
            // Mock validateToken behavior via logic or specific mock if used, but AuthMiddleware uses getIpcToken/validateIpcToken

            authMiddleware.handle(request as any, context, mockNext);
            expect(mockSecurityService.validateIpcToken).toHaveBeenCalledWith('valid-token');
            expect(mockNext).not.toHaveBeenCalled(); // Should fail because neither master nor session valid
            // Wait, logic says: isMaster = token === getIpcToken(). isSession = validateIpcToken() && !isMaster.
            // If valid-token is NOT master and NOT session, it returns 403.

            // Let's make it a master token to pass 'valid-token' test
            mockSecurityService.getIpcToken.mockReturnValue('valid-token');
            authMiddleware.handle(request as any, context, mockNext);
            expect(mockNext).toHaveBeenCalled();
        });

        it('should throw Forbidden if token is invalid', async () => {
            mockSecurityService.getIpcToken.mockReturnValue('master-token');
            mockSecurityService.validateIpcToken.mockReturnValue(false);

            const request = {
                jsonrpc: '2.0',
                id: 1,
                method: 'test',
                auth: { bearerToken: 'invalid-token' }
            };

            const result = await authMiddleware.handle(request as any, context, mockNext);
            expect(result.error?.code).toBe(ConduitError.Forbidden);
            expect(mockNext).not.toHaveBeenCalled();
        });
    });

    describe('RateLimitMiddleware', () => {
        let rateLimitMiddleware: RateLimitMiddleware;

        beforeEach(() => {
            rateLimitMiddleware = new RateLimitMiddleware(mockSecurityService as SecurityService);
        });

        it('should call checkRateLimit', () => {
            const request = {
                jsonrpc: '2.0',
                id: 1,
                method: 'test'
            };

            mockSecurityService.checkRateLimit.mockReturnValue(true);

            rateLimitMiddleware.handle(request as any, context, mockNext);
            // Default context has undefined remoteAddress and request has no token -> key is 'unknown'
            expect(mockSecurityService.checkRateLimit).toHaveBeenCalledWith('unknown');
            expect(mockNext).toHaveBeenCalled();
        });
    });
});
