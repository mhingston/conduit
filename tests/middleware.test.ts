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
            isMasterToken: vi.fn(),
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

        it('should validate bearer token', async () => {
            const request = {
                jsonrpc: '2.0',
                id: 1,
                method: 'test',
                auth: { bearerToken: 'valid-token' }
            };

            // Not master and not a valid session -> Forbidden
            mockSecurityService.isMasterToken.mockReturnValue(false);
            mockSecurityService.validateIpcToken.mockReturnValue(false);

            const result1 = await authMiddleware.handle(request as any, context, mockNext);
            expect(mockSecurityService.isMasterToken).toHaveBeenCalledWith('valid-token');
            expect(mockSecurityService.validateIpcToken).toHaveBeenCalledWith('valid-token');
            expect(result1?.error?.code).toBe(ConduitError.Forbidden);
            expect(mockNext).not.toHaveBeenCalled();

            // Master token -> allowed
            mockNext.mockClear();
            mockSecurityService.isMasterToken.mockReturnValue(true);

            const result2 = await authMiddleware.handle(request as any, context, mockNext);
            expect(result2?.error).toBeUndefined();
            expect(mockNext).toHaveBeenCalled();
        });

        it('should throw Forbidden if token is invalid', async () => {
            mockSecurityService.isMasterToken.mockReturnValue(false);
            mockSecurityService.validateIpcToken.mockReturnValue(false);

            const request = {
                jsonrpc: '2.0',
                id: 1,
                method: 'test',
                auth: { bearerToken: 'invalid-token' }
            };

            const result = await authMiddleware.handle(request as any, context, mockNext);
            expect(result?.error?.code).toBe(ConduitError.Forbidden);
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
