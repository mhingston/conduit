/**
 * MiddlewareBuilder - Factory for building middleware pipelines
 * Extracted from RequestController per architecture-findings.md
 */

import { Middleware } from '../interfaces/middleware.interface.js';
import { ErrorHandlingMiddleware } from './error.middleware.js';
import { LoggingMiddleware } from './logging.middleware.js';
import { AuthMiddleware } from './auth.middleware.js';
import { RateLimitMiddleware } from './ratelimit.middleware.js';
import { SecurityService } from '../security.service.js';

/**
 * Build the default middleware pipeline used by RequestController.
 * This centralizes middleware configuration outside the controller.
 */
export function buildDefaultMiddleware(securityService: SecurityService): Middleware[] {
    return [
        new ErrorHandlingMiddleware(),
        new LoggingMiddleware(),
        new AuthMiddleware(securityService),
        new RateLimitMiddleware(securityService),
    ];
}
