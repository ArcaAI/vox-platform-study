import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';

import { logRequestFailure, requestIdOf, writeErrorBody } from './failure-log';

/** `code` for an error nothing upstream mapped. */
export const UNEXPECTED_ERROR_CODE = 'INTERNAL.UNEXPECTED';

/**
 * The terminal filter for anything the specific filters do not claim — a
 * `TypeError` in a handler, a non-HTTP error thrown from a guard, a domain
 * exception that bypassed `ExceptionInterceptor`.
 *
 * Before it existed those fell through to Nest's default handler: a bare
 * `{statusCode:500, message}` with no `code` and no `correlationId`, so the one
 * error class a client most needs to quote to support had no handle into the
 * logs. The body is deliberately generic — the error's own message can carry
 * anything (a query, a path, a patient identifier) — and the detail goes to the
 * single failure line instead.
 *
 * Registered FIRST among the `APP_FILTER`s: Nest consults the last-registered
 * matching filter first, and `@Catch()` matches everything, so it must sit
 * behind every narrower filter.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    // ws / rpc / lifecycle contexts keep their own transport's handling.
    if (host.getType() !== 'http') throw exception;

    const ctx = host.switchToHttp();
    const request = ctx.getRequest();
    const response = ctx.getResponse();

    const status = HttpStatus.INTERNAL_SERVER_ERROR;
    const correlationId = requestIdOf(request);

    logRequestFailure(this.logger, { request, status, code: UNEXPECTED_ERROR_CODE, exception });

    if (typeof response?.status !== 'function') return;
    writeErrorBody(response, status, {
      statusCode: status,
      code: UNEXPECTED_ERROR_CODE,
      message: 'Internal server error',
      ...(correlationId ? { correlationId } : {}),
    });
  }
}
