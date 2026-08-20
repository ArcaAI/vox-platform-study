import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';

import { toUnifiedErrorBody } from './error-envelope';

/**
 * Normalizes EVERY `HttpException` that reaches the filter chain into the one
 * unified error envelope (REST review H-2).
 *
 * Why a FILTER and not (only) `ExceptionInterceptor`: guards run strictly
 * BEFORE interceptors (Middleware → Guards → Interceptors → Pipes → Handler),
 * so an exception thrown in `UnifiedAuthGuard.canActivate()` — or
 * `TieredThrottlerGuard`, `RequiresIfMatchGuard`, `OriginTenantBindingGuard`,
 * or the `@ExpectedVersion()` param decorator — never reaches the
 * interceptor's `catchError` at all. That is the same reason
 * `ConsentExceptionFilter` exists. The consequence before this filter: the
 * gateway's HIGHEST-VOLUME error class (401/403 from auth) still shipped the
 * bare Nest body `{message, error, statusCode}` with no `code` and no
 * `correlationId`, so an SDK switching on `body.code` worked for validation
 * and OCC and broke on every 401.
 *
 * Purely additive, by construction: `toUnifiedErrorBody` only fills keys whose
 * value is `undefined`, so `statusCode`, `message` and `error` keep the exact
 * values the guard chose. Guard messages are NOT rewritten in either
 * direction — a 403 that names the required abilities keeps naming them
 * (existing behaviour), and nothing new is disclosed: `code` is derived from
 * the status alone and `correlationId` is the caller's handle into the
 * server-side log.
 *
 * It cannot shadow `DataNotFoundExceptionFilter` or `ConsentExceptionFilter`:
 * `@Catch(HttpException)` is narrower than `@Catch()` and those two filters
 * catch domain exceptions (`BaseException` subclasses), which are NOT
 * `HttpException`s — this filter is never even a candidate for them. Verified
 * empirically after wiring, not just reasoned about.
 */
@Catch(HttpException)
export class HttpExceptionEnvelopeFilter implements ExceptionFilter<HttpException> {
  private readonly logger = new Logger(HttpExceptionEnvelopeFilter.name);

  constructor(private readonly clsService: ClsService) {}

  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    // A non-HTTP context (ws / rpc / lifecycle hook) has no `response.status`;
    // rethrow so Nest's own handling for that transport still applies.
    if (typeof response?.status !== 'function') throw exception;

    const status = exception.getStatus();
    const original = exception.getResponse();
    const correlationId = this.correlationIdFor(request);

    // `new HttpException('msg', status)` keeps the body as a raw STRING. Lift
    // it into the envelope's `message` rather than shipping a bare string.
    const body =
      typeof original === 'object' && original !== null
        ? toUnifiedErrorBody(original as Record<string, unknown>, { status, correlationId })
        : toUnifiedErrorBody({ message: String(original) }, { status, correlationId });

    // Headers already written by an upstream layer (notably `Retry-After` on a
    // 503) survive — `.status().json()` does not clear them.
    response.status(status).json(body);
  }

  /**
   * The request's correlation id: the CLS id when the CLS guard already ran,
   * else the id the request carries. Never invented — an absent id simply
   * leaves the key off (a guard rejection before CLS setup is the one case).
   */
  private correlationIdFor(request: Request | undefined): string | undefined {
    try {
      const id = this.clsService?.getId();
      if (id) return id;
    } catch {
      // CLS context unavailable (guard rejected before the CLS guard ran).
      this.logger.debug({ message: 'CLS unavailable while enveloping an HttpException' });
    }
    return (request as unknown as { requestId?: string } | undefined)?.requestId;
  }
}
