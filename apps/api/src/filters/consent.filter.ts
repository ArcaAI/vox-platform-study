import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConsentDeniedException, ConsentUnavailableException } from '@arcaai/exceptions';

import { toUnifiedErrorBody } from './error-envelope';
import { attachFailureLogContext, logRequestFailure, writeErrorBody } from './failure-log';

/**
 * The client body for a consent verdict: the unified envelope over
 * `toJSON()`, WITHOUT the patient identifier (the caller already knows which
 * patient it asked about; echoing it puts a patient identifier in every
 * proxy, CDN and browser log on the way back) and without `stack`/`cause`.
 * Shared with `ExceptionInterceptor`'s consent branches so both paths agree.
 */
export function consentClientBody(
  exception: ConsentDeniedException | ConsentUnavailableException,
  status: number,
  correlationId?: string,
): Record<string, unknown> {
  const { stack: _stack, cause: _cause, ...json } = exception.toJSON() as unknown as Record<string, unknown>;
  const metadata = json['metadata'];
  if (metadata && typeof metadata === 'object') {
    const { externalPatientId: _externalPatientId, ...rest } = metadata as Record<string, unknown>;
    json['metadata'] = rest;
  }
  return toUnifiedErrorBody(json, { status, correlationId });
}

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

    // The single failure line. A genuine denial is an expected compliance
    // event (warn, by its 403); an unavailability verdict is an infrastructure
    // incident wearing a compliance-shaped mask (error, by its 503). The
    // metadata rides the log under its own keys — `externalPatientId`
    // included, which the logger hashes by key — and is stripped from the body.
    const metadata = (exception.metadata ?? {}) as Record<string, unknown>;
    attachFailureLogContext(exception, { ...metadata });
    const body = consentClientBody(exception, status);
    logRequestFailure(this.logger, { request, status, code: typeof body['code'] === 'string' ? body['code'] : undefined, exception });

    writeErrorBody(response, status, body);
  }
}
