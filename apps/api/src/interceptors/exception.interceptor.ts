import { ApiErrorResponse, IClsContext } from '@arcaai/applications';
import { PrismaClientKnownRequestError, PrismaClientValidationError } from '@arcaai/database';
import {
  ArgumentInvalidException,
  BaseException,
  DataNotFoundException,
  OptimisticConcurrencyException,
  QuotaExceededException,
} from '@arcaai/exceptions';
import { BadRequestException, CallHandler, ExecutionContext, HttpException, HttpStatus, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { optimisticLockConflictTotal, routeLabel } from '../observability/metrics';

@Injectable()
export class ExceptionInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ExceptionInterceptor.name);

  constructor(private readonly clsService: ClsService<IClsContext>) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    let requestId: string | undefined;
    let userId: string | undefined;
    let tenantId: string | undefined;
    try {
      requestId = this.clsService.getId();
      userId = this.clsService.get('user')?.id;
      tenantId = this.clsService.get('tenantId');
    } catch {
      // CLS context unavailable (e.g. /metrics served outside CLS middleware)
    }

    return next.handle().pipe(
      catchError((err) => {
        const errorType = err?.constructor?.name || typeof err;
        const method = request?.method;
        const path = request?.url;

        // Build base context for all error logs
        const baseContext = {
          requestId,
          userId,
          tenantId,
          method,
          path,
        };

        if (err instanceof PrismaClientKnownRequestError) {
          // The full Prisma error detail (code + meta + raw message) stays
          // in the server-side log so SREs can debug, but the public
          // response body collapses to {statusCode, error, correlationId}
          // only — Prisma's meta and raw message leak column names,
          // constraint names, and row ids.
          this.logger.error({
            message: 'Prisma database error',
            ...baseContext,
            errorCode: err.code,
            errorMeta: err.meta,
            errorMessage: err.message,
            stack: err.stack,
          });

          // Map Prisma codes to RFC-correct HTTP statuses at the interceptor
          // (the registered handler — the `PrismaClientExceptionFilter` is
          // dead code because it isn't wired as APP_FILTER), so clients can
          // distinguish a duplicate (409) from a missing row (404) from a
          // generic validation failure (400). The `error` labels mirror the
          // filter's labels so any future filter-revival doesn't introduce a
          // body-shape skew. Sanitisation is preserved: only the label
          // changes per code; `err.meta` and raw `err.message` never reach
          // the client.
          const { status, label } = mapPrismaCodeToHttp(err.code);
          return throwError(
            () =>
              new HttpException(
                {
                  statusCode: status,
                  error: label,
                  correlationId: requestId,
                },
                status,
              ),
          );
        }

        if (err instanceof PrismaClientValidationError) {
          this.logger.error({
            message: 'Prisma validation error',
            ...baseContext,
            validationMessage: err.message,
            stack: err.stack,
          });

          // Same sanitisation: no Prisma message in the public body.
          return throwError(
            () =>
              new HttpException(
                {
                  statusCode: HttpStatus.BAD_REQUEST,
                  error: 'Bad Request',
                  correlationId: requestId,
                },
                HttpStatus.BAD_REQUEST,
              ),
          );
        }

        if (err.status >= 400 && err.status < 500) {
          // Client errors - log at debug level
          this.logger.debug({
            message: 'Client error',
            ...baseContext,
            status: err.status,
            errorType,
          });

          const isClassValidatorError = Array.isArray(err?.response?.message) && typeof err?.response?.error === 'string' && err.status === 400;

          // Transforming class-validator errors to a different format
          if (isClassValidatorError) {
            err = new BadRequestException(
              new ApiErrorResponse({
                statusCode: err.status,
                message: 'Validation error',
                error: err?.response?.error,
                subErrors: err?.response?.message,
                correlationId: err.correlationId || requestId,
              }),
            );
          }
        }

        // Compare-And-Set conflicts map to RFC 7232 `412 Precondition Failed`.
        // This branch MUST run before the generic `BaseException` branch below
        // because OCC extends BaseException and the generic branch would
        // otherwise misclassify it as a 500. The body shape is `err.toJSON()`,
        // which carries `code: 'PERSISTENCE.CONCURRENCY_CONFLICT'` and
        // `metadata: { expectedVersion, currentVersion }` — both consumed by
        // the SDK's conflict handler and the UI's conflict modal.
        if (err instanceof OptimisticConcurrencyException) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const metadata = err.metadata as { expectedVersion?: number; currentVersion?: number } | undefined;
          this.logger.debug({
            message: 'Optimistic concurrency conflict',
            ...baseContext,
            correlationId: err.correlationId,
            model: err.model,
            entityId: err.entityId,
            expectedVersion: metadata?.expectedVersion,
            currentVersion: metadata?.currentVersion,
          });

          // Increment the OCC conflict counter BEFORE rethrowing as 412.
          // Model + route labels are bounded
          // (route comes from the templated Express path) so cardinality
          // stays cheap. Failure to record the metric MUST NOT swallow the
          // 412 — we wrap in try/catch and only debug-log a metric failure.
          try {
            optimisticLockConflictTotal.labels({ model: err.model, route: routeLabel(request ?? {}) }).inc();
          } catch (metricErr) {
            this.logger.debug({
              message: 'Failed to record optimistic_lock_conflict_total',
              error: metricErr instanceof Error ? metricErr.message : String(metricErr),
            });
          }

          return throwError(() => new HttpException(err.toJSON(), HttpStatus.PRECONDITION_FAILED));
        }

        // `DataNotFoundException` (thrown by `Repository<T>.findById` and
        // friends) MUST pass
        // through unwrapped so the global `DataNotFoundExceptionFilter`
        // (registered as `APP_FILTER` in `app.module.ts`) can map it to
        // a generic `404 { message: "Resource not found" }`. If we
        // wrap it here as the legacy `HttpException(err.toJSON(), 500)`
        // branch below does, the filter never sees the original
        // `DataNotFoundException` and the response leaks the model
        // name + row id in the body. This branch MUST run before the
        // generic `BaseException` branch (which OCC also pre-empts for
        // the same reason).
        if (err instanceof DataNotFoundException) {
          this.logger.debug({
            message: 'DataNotFoundException — passing through to global filter',
            ...baseContext,
            correlationId: err.correlationId,
            exceptionMessage: err.message,
          });
          return throwError(() => err);
        }

        // Entitlements quota blocks map to precise client statuses instead of
        // the generic 500 the `BaseException` branch below would produce
        // (QuotaExceededException extends BaseException, so this MUST run
        // first — same ordering rationale as the OCC branch). The
        // body is `err.toJSON()`, carrying `code: 'DOMAIN.QUOTA_EXCEEDED'` +
        // `metadata: { capability, limit, used, requested, tenantId }` so the SDK
        // / admin console can point at the exact capability that blocked.
        if (err instanceof QuotaExceededException) {
          const capability = (err.metadata as { capability?: string } | undefined)?.capability;
          const status = mapQuotaCapabilityToHttp(capability);
          this.logger.debug({
            message: 'Entitlements quota block',
            ...baseContext,
            correlationId: err.correlationId,
            capability,
            status,
          });
          return throwError(() => new HttpException(err.toJSON(), status));
        }

        // Services signal invalid input with
        // `ArgumentInvalidException` (the rule-04 house pattern: unwritable
        // tiers, type mismatches, no-op updates, bad slugs, …). It extends
        // BaseException, so without this branch it fell through to the generic
        // 500 below — turning every service-level validation refusal into an
        // "Internal server error". RFC-correct mapping is `400 Bad Request`;
        // body is `err.toJSON()` (`code: 'GENERIC.ARGUMENT_INVALID'`), matching
        // the OCC/quota branches' shape. MUST run before the generic
        // BaseException branch for the same ordering reason they do.
        if (err instanceof ArgumentInvalidException) {
          this.logger.debug({
            message: 'Invalid argument',
            ...baseContext,
            correlationId: err.correlationId,
            errorMessage: err.message,
          });
          return throwError(() => new HttpException(err.toJSON(), HttpStatus.BAD_REQUEST));
        }

        if (err instanceof BaseException) {
          this.logger.warn({
            message: 'Application exception',
            ...baseContext,
            correlationId: err.correlationId,
            exceptionType: err.constructor.name,
            errorMessage: err.message,
            stack: err.stack,
          });

          return throwError(() => new HttpException(err.toJSON(), HttpStatus.INTERNAL_SERVER_ERROR));
        }

        // Ensure correlationId is set
        if (!err.correlationId) {
          err.correlationId = requestId;
        }

        if (err.response) {
          err.response.correlationId = err.correlationId;
        }

        // Log unexpected errors
        if (!err.status || err.status >= 500) {
          this.logger.error({
            message: 'Unexpected server error',
            ...baseContext,
            status: err.status || 500,
            errorType,
            errorMessage: err.message,
            stack: err.stack,
          });
        }

        return throwError(err);
      }),
    );
  }
}

// Prisma error code → HTTP status mapping.
//
// Mirrors the labels in `apps/api/src/filters/prisma.filter.ts` so the
// dead filter and the live interceptor produce identical body shapes —
// if/when the filter is wired up (or the interceptor's branch is
// removed), the response contract doesn't shift. Any code outside the
// table below falls back to 400 / 'Bad Request' to preserve the legacy
// generic-default behaviour.
// Entitlements capability → HTTP status.
//
//   - rolling-monthly METER caps (Q5)         → 429 Too Many Requests
//   - concurrency cap (simultaneous sessions) → 429 Too Many Requests
//   - the tenant storage quota (Q6)           → 413 Payload Too Large
//   - a feature-gate denial (F-series)        → 403 Forbidden
//   - every quantity cap (users/depts/…)      → 409 Conflict (default)
//
// Keyed off the `capability` in the exception metadata so meter over-limit and
// concurrency over-capacity (both retry-later semantics) are distinguishable
// from a hard quantity conflict.
const QUOTA_RATE_CAPABILITIES = new Set([
  'monthlyConsultations',
  'monthlyTranscriptionMinutes',
  'monthlySummaries',
  // A simultaneous-session cap is retry-later, not a permanent conflict; 429
  // lets the caller back off and retry once a session frees up.
  'maxConcurrentSessions',
]);

function mapQuotaCapabilityToHttp(capability: string | undefined): HttpStatus {
  if (capability && QUOTA_RATE_CAPABILITIES.has(capability)) return HttpStatus.TOO_MANY_REQUESTS;
  if (capability === 'storageQuotaBytes') return HttpStatus.PAYLOAD_TOO_LARGE;
  if (capability && capability.startsWith('feature')) return HttpStatus.FORBIDDEN;
  return HttpStatus.CONFLICT;
}

function mapPrismaCodeToHttp(code: string): { status: HttpStatus; label: string } {
  switch (code) {
    case 'P2002':
      return { status: HttpStatus.CONFLICT, label: 'Unique constraint violation' };
    case 'P2025':
      return { status: HttpStatus.NOT_FOUND, label: 'Not found' };
    case 'P2003':
      return { status: HttpStatus.BAD_REQUEST, label: 'Foreign key constraint violation' };
    case 'P2014':
      return { status: HttpStatus.BAD_REQUEST, label: 'Required relation violation' };
    default:
      return { status: HttpStatus.BAD_REQUEST, label: 'Bad Request' };
  }
}
