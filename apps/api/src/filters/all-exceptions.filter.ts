import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';

import { logRequestFailure, requestIdOf, writeErrorBody } from './failure-log';

/** `code` for an error nothing upstream mapped. */
export const UNEXPECTED_ERROR_CODE = 'INTERNAL.UNEXPECTED';

/** `code` for a request body over the parser limit. */
export const PAYLOAD_TOO_LARGE_CODE = 'REQUEST.PAYLOAD_TOO_LARGE';

function isPayloadTooLarge(exception: unknown): boolean {
  return typeof exception === 'object' && exception !== null && (exception as { type?: unknown }).type === 'entity.too.large';
}

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

    // body-parser rejects an oversize body with an error that is not an HttpException; answer it
    // with the 413 it is, so a client (and a retrying outbox) can tell "too big" from "broken".
    const tooLarge = isPayloadTooLarge(exception);
    const status = tooLarge ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.INTERNAL_SERVER_ERROR;
    const code = tooLarge ? PAYLOAD_TOO_LARGE_CODE : UNEXPECTED_ERROR_CODE;
    const correlationId = requestIdOf(request);

    logRequestFailure(this.logger, { request, status, code, exception });

    if (typeof response?.status !== 'function') return;
    writeErrorBody(response, status, {
      statusCode: status,
      code,
      message: tooLarge ? 'Request body too large' : 'Internal server error',
      ...(correlationId ? { correlationId } : {}),
    });
  }
}
