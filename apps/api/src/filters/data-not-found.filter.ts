import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { DataNotFoundException } from '@arcaai/exceptions';

import { httpCodeForStatus } from './error-envelope';

/**
 * Maps `DataNotFoundException` (thrown by `Repository<T>.findById` /
 * `findByIdInContext` and similar fetch paths) to a generic HTTP 404
 * `{ statusCode: 404, message: "Resource not found" }` response.
 *
 * Why this exists:
 *
 * The native `DataNotFoundException.message` is
 *   `[DB] User with ID user-123 could not be found.`
 *
 * Without this filter the message would be echoed verbatim to the HTTP
 * response (the `ExceptionInterceptor.BaseException` branch wraps it
 * as a 500 with `err.toJSON()`, which serializes the message + the
 * cause + the model name + the entity id). That leaks two pieces of
 * tenant-catalogue / existence-leak signal to ANY authenticated
 * caller:
 *
 *   1. The model name (e.g. `User`, `ApiKey`, `Webhook`) — confirms
 *      the API surfaces that backing entity, useful for an enumeration
 *      attacker.
 *   2. The row id passed by the caller — confirms whether a specific id
 *      exists at all (returning 500 with the literal id is functionally
 *      a 200 disguised as an error).
 *
 * Scope: this filter is scoped ONLY to `DataNotFoundException`. The
 * cross-tenant `assertEqualTenants` guards already throw
 * `NotFoundException("Resource not found")` directly with the
 * generic body — those do NOT need filter wrapping.
 *
 * Production mode (`NODE_ENV=production`) ALWAYS emits the generic
 * body — the dev-mode echo was intentionally skipped; generic-always
 * is the safer default.
 *
 * H-2 (REST review): the body now also carries the unified envelope's
 * `code` + `correlationId` so a client can key off `body.code` on EVERY
 * error, not just domain ones. Both additions are metadata about the
 * RESPONSE, not about the missing row: `HTTP.NOT_FOUND` is derived from
 * the status alone and the correlationId is the caller's handle into the
 * server-side log. The `message` stays the generic `'Resource not found'`
 * — the model name and the row id are still withheld.
 */
@Catch(DataNotFoundException)
export class DataNotFoundExceptionFilter implements ExceptionFilter<DataNotFoundException> {
  private readonly logger = new Logger(DataNotFoundExceptionFilter.name);

  catch(exception: DataNotFoundException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    // Observability — log the rich exception detail server-side so SOC
    // can still distinguish enumeration-pattern requests, while the
    // client gets only the generic body.
    this.logger.debug({
      message: 'DataNotFoundException mapped to 404',
      // The native message carries the model + id; safe to log server-side.
      exceptionMessage: exception.message,
      exceptionCode: exception.code,
      correlationId: exception.correlationId,
      method: request?.method,
      path: request?.url,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requestId: (request as any)?.requestId,
    });

    response.status(HttpStatus.NOT_FOUND).json({
      statusCode: HttpStatus.NOT_FOUND,
      code: httpCodeForStatus(HttpStatus.NOT_FOUND),
      message: 'Resource not found',
      correlationId: exception.correlationId ?? (request as unknown as { requestId?: string })?.requestId,
    });
  }
}
