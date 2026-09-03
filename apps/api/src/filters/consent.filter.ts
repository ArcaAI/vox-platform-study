import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConsentDeniedException, ConsentUnavailableException } from '@arcaai/exceptions';

import { toUnifiedErrorBody } from './error-envelope';

/**
 * Maps `ConsentDeniedException` → 403 and `ConsentUnavailableException` →
 * 503 (consent-abac).
 *
 * Why a FILTER, not (only) `ExceptionInterceptor`'s branches: `assertConsent`
 * is called from `PatientConsentGuard.canActivate()` — a `CanActivate`
 * GUARD, not a controller handler. NestJS's request lifecycle runs Guards
 * strictly BEFORE Interceptors are invoked at all
 * (Middleware → Guards → Interceptors → Pipes → Handler); an exception
 * thrown inside a guard never reaches `ExceptionInterceptor`'s `catchError`
 * — it propagates straight to the exception-FILTER chain instead. Without
 * this filter, `ConsentDeniedException` (not a NestJS `HttpException`)
 * silently fell through to Nest's default handling and produced a bare
 * `500`, not the `403`/`503` the interceptor's branches (correctly, but
 * uselessly for this call site) describe — caught by this ticket's own e2e
 * suite. The interceptor's branches are KEPT for any future caller that
 * throws from inside the normal interceptor-wrapped pipeline (e.g. Task 12's
 * gateway-internal endpoint, a plain controller/service call site); this
 * filter is what makes the CURRENT, guard-only call site work at all.
 *
 * Body shape matches `ExceptionInterceptor`'s branches exactly — `err.toJSON()`
 * lifted into the unified H-2 envelope (`toUnifiedErrorBody` adds the
 * `statusCode` that `BaseException.toJSON()` cannot know) — so callers see one
 * consistent contract regardless of which mechanism handled a given request.
 */
@Catch(ConsentDeniedException, ConsentUnavailableException)
export class ConsentExceptionFilter implements ExceptionFilter<ConsentDeniedException | ConsentUnavailableException> {
  private readonly logger = new Logger(ConsentExceptionFilter.name);

  catch(exception: ConsentDeniedException | ConsentUnavailableException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const isUnavailable = exception instanceof ConsentUnavailableException;
    const status = isUnavailable ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.FORBIDDEN;

    // R4: a genuine denial is an expected, un-alarming compliance event
    // (debug); an unavailability verdict is an infrastructure incident
    // wearing a compliance-shaped mask (error) — never the same log level.
    const logPayload = {
      message: isUnavailable ? 'Consent could not be determined — grant lookup failed' : 'Consent denied',
      correlationId: exception.correlationId,
      metadata: exception.metadata,
      method: request?.method,
      path: request?.url,
    };
    if (isUnavailable) {
      this.logger.error(logPayload);
    } else {
      this.logger.debug(logPayload);
    }

    response.status(status).json(toUnifiedErrorBody(exception.toJSON() as unknown as Record<string, unknown>, { status }));
  }
}
