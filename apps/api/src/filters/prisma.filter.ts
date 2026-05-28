import { PrismaClientKnownRequestError } from '@arcaai/database';
import { ArgumentsHost, Catch, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Request, Response } from 'express';

/**
 * TASK-307 W7.A.14 (carryover from W5 review) — known shadow:
 *
 * `ExceptionInterceptor` (registered as a global `APP_INTERCEPTOR`) maps
 * every `PrismaClientKnownRequestError` to a generic
 * `400 { statusCode, error: 'Bad Request', correlationId }` BEFORE any
 * exception filter sees it (see `apps/api/src/interceptors/
 * exception.interceptor.ts` lines 46–73). The status-code-specific
 * branches below (`P2002` → 409 Conflict, `P2025` → 404 Not Found,
 * etc.) therefore NEVER run in production today — every Prisma known-
 * error returns a generic 400.
 *
 * The filter is kept registered as defense-in-depth: if a future
 * refactor unregisters the interceptor (or extracts a non-Prisma
 * branch from it), this filter still produces sanitised 4xx responses
 * without leaking `err.meta` or constraint names. Per TASK-307 §10
 * deferral, the long-term fix is to either:
 *   (a) extend `ExceptionInterceptor` to honor the same code → status
 *       mapping (preserving the better-classification UX the filter
 *       intends), OR
 *   (b) drop this filter entirely and treat the interceptor as the
 *       single source of truth.
 * Both are out of W7 scope (touches W5's hardening surface).
 */
@Catch(PrismaClientKnownRequestError)
export class PrismaClientExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(PrismaClientExceptionFilter.name);

  catch(exception: PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const message = exception.message.replace(/\n/g, '');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const correlationId = (request as any)?.requestId;

    // Build structured log context — server-side keeps the full Prisma
    // detail so SREs can debug. The public body below is sanitised per
    // TASK-307 W5.6 (AC-20, audit D-6).
    const logContext = {
      errorCode: exception.code,
      errorMessage: message,
      errorMeta: exception.meta,
      method: request?.method,
      path: request?.url,
      requestId: correlationId,
    };

    this.logger.error({
      message: 'Prisma database error',
      ...logContext,
      stack: exception.stack,
    });

    // TASK-307 W5.6 (AC-20): generic public body — never echo the raw
    // exception.message (it embeds column / constraint / row id names)
    // or exception.meta (same problem). The `error` label is the only
    // hint we surface to clients about what went wrong.
    switch (exception.code) {
      case 'P2002': {
        // Unique constraint violation
        const status = HttpStatus.CONFLICT;
        response.status(status).json({
          statusCode: status,
          error: 'Unique constraint violation',
          correlationId,
        });
        break;
      }
      case 'P2025': {
        // Record not found
        const status = HttpStatus.NOT_FOUND;
        response.status(status).json({
          statusCode: status,
          error: 'Not found',
          correlationId,
        });
        break;
      }
      case 'P2003': {
        // Foreign key constraint violation
        const status = HttpStatus.BAD_REQUEST;
        response.status(status).json({
          statusCode: status,
          error: 'Foreign key constraint violation',
          correlationId,
        });
        break;
      }
      case 'P2014': {
        // Required relation violation
        const status = HttpStatus.BAD_REQUEST;
        response.status(status).json({
          statusCode: status,
          error: 'Required relation violation',
          correlationId,
        });
        break;
      }
      default:
        // default 500 error code
        super.catch(exception, host);
        break;
    }
  }
}
