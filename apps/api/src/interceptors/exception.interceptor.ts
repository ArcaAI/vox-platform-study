import { ApiErrorResponse, IClsContext } from '@arcaai/applications';
import { PrismaClientKnownRequestError, PrismaClientValidationError } from '@arcaai/database';
import { BaseException, DataNotFoundException, OptimisticConcurrencyException } from '@arcaai/exceptions';
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
          // TASK-307 W5.6 (AC-20, audit D-6): the full Prisma error
          // detail (code + meta + raw message) stays in the server-side
          // log so SREs can debug, but the public response body collapses
          // to {statusCode, error, correlationId} only — Prisma's meta
          // and raw message leak column names, constraint names, and row
          // ids.
          this.logger.error({
            message: 'Prisma database error',
            ...baseContext,
            errorCode: err.code,
            errorMeta: err.meta,
            errorMessage: err.message,
            stack: err.stack,
          });

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

        if (err instanceof PrismaClientValidationError) {
          this.logger.error({
            message: 'Prisma validation error',
            ...baseContext,
            validationMessage: err.message,
            stack: err.stack,
          });

          // TASK-307 W5.6 — same sanitisation: no Prisma message in the
          // public body. The pre-W5.6 body shape also already omitted
          // `meta`, so this only flips `status` → `statusCode` and drops
          // the raw validation message string.
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

        // TASK-302 Stream D Phase C (C.5) — Compare-And-Set conflicts map to
        // RFC 7232 `412 Precondition Failed`. This branch MUST run before the
        // generic `BaseException` branch below because OCC extends BaseException
        // and the generic branch would otherwise misclassify it as a 500.
        // The body shape is `err.toJSON()`, which carries `code:
        // 'PERSISTENCE.CONCURRENCY_CONFLICT'` and
        // `metadata: { expectedVersion, currentVersion }` — both consumed by
        // the SDK's conflict handler (Phase D.4) and the UI's conflict modal
        // (Phase D.5).
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

          // TASK-302 Stream D Phase E.6 — increment the OCC conflict counter
          // BEFORE rethrowing as 412. Model + route labels are bounded
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

        // TASK-306 P3.3 / AC-12 / audit M-8 — `DataNotFoundException`
        // (thrown by `Repository<T>.findById` and friends) MUST pass
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
