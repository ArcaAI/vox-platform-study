import { PrismaClientKnownRequestError } from '@arcaai/database';
import { ArgumentsHost, Catch, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Request, Response } from 'express';

/**
 * Prisma error code → HTTP status mapping now lives in `ExceptionInterceptor`
 * (the single registered handler). The interceptor maps each known code
 * (`P2002` → 409, `P2025` → 404, `P2003`/`P2014` → 400) to the same body
 * shape and `error` labels as this filter. The interceptor's branch is the
 * live code path; this filter is NOT currently wired as `APP_FILTER` and so
 * does not run in production.
 *
 * The file is retained as defense-in-depth and as a reference shape: if
 * a future refactor unregisters the interceptor's Prisma branch (or
 * wires this filter as `APP_FILTER`), the same sanitised response
 * contract (no `err.meta` / raw `err.message` leak) is preserved. The
 * long-term cleanup is to either:
 *   (a) wire this filter as `APP_FILTER` and remove the interceptor's
 *       Prisma branch (single source of truth in the filter), OR
 *   (b) delete this file (interceptor is the only handler).
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
    // detail so SREs can debug. The public body below is sanitised.
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

    // Generic public body — never echo the raw exception.message (it embeds
    // column / constraint / row id names) or exception.meta (same problem).
    // The `error` label is the only hint we surface to clients about what
    // went wrong.
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
