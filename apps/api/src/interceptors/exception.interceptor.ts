import { ApiErrorResponse, IClsContext } from '@arcaai/applications';
import { PrismaClientKnownRequestError, PrismaClientValidationError } from '@arcaai/database';
import {
  ArgumentInvalidException,
  BaseException,
  ConsentDeniedException,
  ConsentUnavailableException,
  DatabaseConnectionException,
  DataConflictException,
  DataNotFoundException,
  InvalidStateTransitionException,
  OptimisticConcurrencyException,
  ProviderCredentialVetoedException,
  QueryFailedException,
  QuotaExceededException,
  SpendLimitExceededException,
} from '@arcaai/exceptions';
import { BadRequestException, CallHandler, ExecutionContext, HttpException, HttpStatus, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { consentClientBody } from '../filters/consent.filter';
import {
  DOWNSTREAM_RETRY_AFTER_SECONDS,
  buildDownstreamErrorBody,
  capabilityForPath,
  classifyDownstreamFailure,
  describeCauseForOperator,
  downstreamStatusFor,
} from '../filters/downstream-error';
import { VALIDATION_ERROR_CODE, httpCodeForStatus, toUnifiedErrorBody } from '../filters/error-envelope';
import { attachFailureLogContext, readFailureLogContext, type FailureLogContext } from '../filters/failure-log';
import { optimisticLockConflictTotal, routeLabel } from '../observability/metrics';

/**
 * Maps every error a handler throws onto the gateway's HTTP contract.
 *
 * It MAPS; it does not log the failure. Each branch attaches what it knows
 * (the original error, the domain metadata, the Prisma code) to the exception
 * it rethrows, and the terminal filter that writes the response writes the
 * request's single failure line with it (`filters/failure-log.ts`). Logging
 * here as well is what used to produce two or three lines per failed request.
 */
@Injectable()
export class ExceptionInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ExceptionInterceptor.name);

  constructor(private readonly clsService: ClsService<IClsContext>) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    let requestId: string | undefined;
    try {
      requestId = this.clsService.getId();
    } catch {
      // CLS context unavailable (e.g. /metrics served outside CLS middleware)
    }

    return next.handle().pipe(
      catchError((err) => {
        const path = request?.url;
        const mapped = <T>(exception: T, ctx: FailureLogContext): Observable<never> => throwError(() => attachFailureLogContext(exception, ctx));

        if (err instanceof PrismaClientKnownRequestError) {
          // Map Prisma codes to RFC-correct HTTP statuses at the interceptor
          // — the single registered handler for Prisma errors (there is no
          // separate Prisma exception filter; the unwired, dead
          // `PrismaClientExceptionFilter` was removed in favor of this one
          // mechanism) — so clients can distinguish a duplicate (409) from a
          // missing row (404) from a generic validation failure (400).
          // Sanitisation is preserved: only the label changes per code;
          // `err.meta` and raw `err.message` never reach the client, and the
          // log carries the code, the model and the FIRST line of the message
          // with the query invocation block removed — never the query itself.
          const { status, label, code, known } = mapPrismaCodeToHttp(err.code);
          return mapped(prismaHttpException(status, code, label, requestId), {
            ...prismaLogFields(err),
            // An unmapped code is a server-side failure however it is answered.
            ...(known ? {} : { level: 'error' as const }),
          });
        }

        if (err instanceof PrismaClientValidationError) {
          // Same sanitisation: no Prisma message in the public body. The client
          // gets a 400, but a malformed query is OUR bug, so the line is `error`.
          return mapped(prismaHttpException(HttpStatus.BAD_REQUEST, PRISMA_QUERY_INVALID_CODE, 'Bad Request', requestId), {
            ...prismaLogFields(err),
            level: 'error',
          });
        }

        if (err.status >= 400 && err.status < 500) {
          const isClassValidatorError = Array.isArray(err?.response?.message) && typeof err?.response?.error === 'string' && err.status === 400;

          // Transforming class-validator errors to a different format
          if (isClassValidatorError) {
            const subErrors: string[] = err?.response?.message;
            const violations = readFailureLogContext(err);
            err = new BadRequestException({
              ...new ApiErrorResponse({
                statusCode: err.status,
                message: 'Validation error',
                error: err?.response?.error,
                subErrors,
                correlationId: err.correlationId || requestId,
              }),
              // H-2: the envelope's machine-readable `code`. `subErrors` is
              // KEPT under its own name (the validation spec asserts
              // it) and additionally surfaced as `details`, the envelope's
              // generic slot for per-field information.
              code: VALIDATION_ERROR_CODE,
              details: subErrors,
            });
            // The pipe's structured `violations` (property + constraint names)
            // ride on to the failure line; the messages above stay client-only.
            if (violations) attachFailureLogContext(err, violations);
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
          const metadata = err.metadata as { expectedVersion?: number; currentVersion?: number } | undefined;

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

          return mapped(new HttpException(unifiedDomainBody(err, HttpStatus.PRECONDITION_FAILED, requestId), HttpStatus.PRECONDITION_FAILED), {
            error: err,
            model: err.model,
            entityId: err.entityId,
            expectedVersion: metadata?.expectedVersion,
            currentVersion: metadata?.currentVersion,
          });
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
          return throwError(() => err);
        }

        // Persistence exceptions raised by non-repository code. Each keeps the
        // status and body its raw-Prisma equivalent gets above, so the class a
        // caller happened to wrap an error in never changes the HTTP contract.
        // MUST run before the generic `BaseException` branch, which would
        // otherwise answer all three with a 500.
        if (err instanceof DataConflictException) {
          const { status, label, code } = mapPrismaCodeToHttp('P2002');
          return mapped(prismaHttpException(status, code, label, requestId), persistenceLogFields(err));
        }

        if (err instanceof DatabaseConnectionException) {
          setRetryAfter(response);
          const status = HttpStatus.SERVICE_UNAVAILABLE;
          return mapped(
            new HttpException({ statusCode: status, code: err.code, message: 'Service temporarily unavailable', correlationId: requestId }, status),
            persistenceLogFields(err),
          );
        }

        if (err instanceof QueryFailedException) {
          const causeCode = (err.cause as { code?: unknown } | undefined)?.code;
          const { status, label, code, known } = mapPrismaCodeToHttp(typeof causeCode === 'string' ? causeCode : '');
          return mapped(prismaHttpException(status, code, label, requestId), {
            ...persistenceLogFields(err),
            ...(known ? {} : { level: 'error' as const }),
          });
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
          return mapped(new HttpException(unifiedDomainBody(err, status, requestId), status), { error: err, capability });
        }

        // The caller's OWN tenant forbids this provider: its
        // connection row for the (service, provider) is disabled, which is a
        // VETO of the platform-default credential rather than "unused". 409,
        // deliberately distinct from the 403 a missing entitlement produces
        // above — a tenant admin can clear a veto themselves, and from the
        // downstream 503 that means "nothing configured at all". Body is
        // `err.toJSON()` (`code: 'DOMAIN.PROVIDER_CREDENTIAL_VETOED'` +
        // `metadata: { service, provider, tenantId }`). MUST run before the
        // generic BaseException branch, like the others.
        if (err instanceof ProviderCredentialVetoedException) {
          return mapped(new HttpException(unifiedDomainBody(err, HttpStatus.CONFLICT, requestId), HttpStatus.CONFLICT), {
            error: err,
            metadata: err.metadata,
          });
        }

        // Consent & ABAC. `assertConsent` denied the call — no
        // active grant, expired, revoked, or scope-insufficient. 403: a
        // privilege boundary, deliberately distinct from the 404-over-403
        // cross-tenant posture (a cross-tenant externalPatientId is a 404
        // from the caller's own lookup path, never reaching this branch).
        // Wired live: `PatientConsentGuard` (apps/api/src/guards/) throws
        // this on every route carrying `@RequiresConsent(...)`. Body is the
        // same `consentClientBody` the consent filter writes — `toJSON()`
        // minus the patient identifier. The metadata (externalPatientId
        // included, hashed by the logger) rides the failure line.
        // MUST run before the generic BaseException branch, like the others.
        if (err instanceof ConsentDeniedException) {
          return mapped(new HttpException(consentClientBody(err, HttpStatus.FORBIDDEN, requestId), HttpStatus.FORBIDDEN), {
            error: err,
            ...((err.metadata ?? {}) as Record<string, unknown>),
          });
        }

        // Consent & ABAC, R4. `assertConsent` could NOT determine
        // a verdict — the grant-store lookup itself failed — as opposed to
        // resolving to a genuine denial. Mapped to 503, deliberately
        // DIFFERENT from `ConsentDeniedException`'s 403: a real denial is an
        // expected compliance event; this is an infrastructure incident that
        // happens to look like one, and conflating the two would make a
        // gateway hiccup read as a compliance event (or vice versa) in
        // alerting. MUST run before the generic BaseException branch.
        if (err instanceof ConsentUnavailableException) {
          return mapped(new HttpException(consentClientBody(err, HttpStatus.SERVICE_UNAVAILABLE, requestId), HttpStatus.SERVICE_UNAVAILABLE), {
            error: err,
            ...((err.metadata ?? {}) as Record<string, unknown>),
          });
        }

        // The tenant hit its optional monthly SPEND limit (D12).
        // RFC maps a payment/credit exhaustion to 402 Payment Required — a
        // distinct signal from the 429 throughput / 409 quantity quotas above.
        // Body is `err.toJSON()` (`code: 'DOMAIN.SPEND_LIMIT_EXCEEDED'` +
        // `metadata: { tenantId, period, spendLimitMicros, overageSpendMicros }`).
        // MUST run before the generic BaseException branch, like the others.
        if (err instanceof SpendLimitExceededException) {
          return mapped(new HttpException(unifiedDomainBody(err, HttpStatus.PAYMENT_REQUIRED, requestId), HttpStatus.PAYMENT_REQUIRED), {
            error: err,
          });
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
          return mapped(new HttpException(unifiedDomainBody(err, HttpStatus.BAD_REQUEST, requestId), HttpStatus.BAD_REQUEST), { error: err });
        }

        // TASK-992 — an aggregate's state machine refused a transition because
        // of the status the row is in. RFC-correct mapping is `409 Conflict`:
        // the request is well-formed and the caller authorised, but the
        // resource's current state conflicts with it.
        //
        // This exists because the STT worker, in another process, has to
        // decide between "retry this redelivery" and "ACK, it is finished".
        // As a plain `BusinessException` the refusal arrived as a generic 500
        // whose only distinguishing feature was English prose, so the worker
        // substring-matched it, read a recoverable PROCESSING as terminal, and
        // orphaned the job (`01a0b94c-…`, stuck at 75% with nothing able to
        // end it). The body is `err.toJSON()`, carrying
        // `code: 'DOMAIN.INVALID_STATE_TRANSITION'` and
        // `metadata: { entity, entityId, currentStatus, attempted, terminal }`
        // — `terminal` being the field the worker actually branches on.
        //
        // MUST run before the generic `BaseException` branch below, like the
        // OCC / quota / consent branches: it extends BaseException, so the
        // generic branch would otherwise claim it and answer 500 again.
        if (err instanceof InvalidStateTransitionException) {
          return mapped(new HttpException(unifiedDomainBody(err, HttpStatus.CONFLICT, requestId), HttpStatus.CONFLICT), {
            error: err,
            metadata: err.metadata,
          });
        }

        // Anything else from the domain is an unexpected server failure: 500,
        // logged at `error` with the original exception (its cause chain
        // intact) — while the client body carries neither `cause` nor `stack`.
        if (err instanceof BaseException) {
          return mapped(new HttpException(unifiedDomainBody(err, HttpStatus.INTERNAL_SERVER_ERROR, requestId), HttpStatus.INTERNAL_SERVER_ERROR), {
            error: err,
          });
        }

        // a failed call to a downstream Python service (text, stt,
        // guardrail, nlp, tts, harness).
        //
        // This branch is the SINGLE place a downstream failure becomes a
        // client-facing body. It exists because the alternative — each call
        // site composing its own message — is exactly how
        // `Failed to call TEXT service: connect ECONNREFUSED 127.0.0.1:8862`
        // reached callers as a 400.
        //
        // It deliberately runs LAST, on errors nothing else claimed, and skips
        // anything that is already an `HttpException` or a `BaseException`. That
        // ordering is what makes it a safety net rather than an override: a
        // service that has a considered mapping keeps it, while a raw
        // `AxiosError` that no call site caught at all — the
        // `HarnessGatewayService` case, which used to render as an opaque 500 —
        // still lands on the right status without that service having to know
        // this module exists.
        if (!(err instanceof HttpException) && !(err instanceof BaseException)) {
          const kind = classifyDownstreamFailure(err);
          if (kind) {
            const status = downstreamStatusFor(kind, err?.response?.status);
            const capability = capabilityForPath(path);

            if (status === HttpStatus.SERVICE_UNAVAILABLE) {
              setRetryAfter(response);
            }

            // The operator half of the contract: host, port, errno, upstream
            // status and the whole cause fan-out, keyed by the SAME
            // correlationId the client is handed. Never the upstream response
            // body — it can echo the assembled clinical prompt — and never the
            // client error object itself, whose request config carries headers.
            return mapped(new HttpException(buildDownstreamErrorBody({ status, capability, correlationId: requestId }), status), {
              errorName: err?.name ?? err?.constructor?.name,
              downstreamFailureKind: kind,
              capability,
              ...describeCauseForOperator(err),
            });
          }
        }

        // Every 503 leaving the gateway backs the caller off, including the ones
        // a controller or service raised directly (e.g. the seam-resolution
        // branch in `consultation.controller.ts`). Without this, whether a
        // client retried correctly depended on which layer noticed the outage.
        if (err instanceof HttpException && err.getStatus() === HttpStatus.SERVICE_UNAVAILABLE) {
          setRetryAfter(response);
        }

        // Ensure correlationId is set
        if (err && typeof err === 'object' && !err.correlationId) {
          err.correlationId = requestId;
        }

        // Only an OBJECT body can carry a correlationId. `new HttpException('msg',
        // status)` keeps the body as a raw STRING, and assigning a property to a
        // string primitive THROWS in strict mode ("Cannot create property
        // 'correlationId' on string ..."). That TypeError escaped this
        // `catchError`, so any downstream client raising a string-bodied
        // HttpException — `AiInferenceClient.toHttpError`, which deliberately
        // redacts PHI-bearing upstream bodies down to a plain string — had its
        // honest 503/4xx rewritten into an opaque 500.
        if (err?.response !== null && typeof err?.response === 'object') {
          err.response.correlationId = err.correlationId;
          // H-2: every body leaving the gateway carries a machine-readable
          // `code`. Plain `HttpException`s (a guard's 401, a service's
          // `NotFoundException('Resource not found')`, …) have no domain code
          // of their own, so they get the status-derived fallback. Purely
          // additive — an existing `code` is never overwritten.
          if (err.response.code === undefined) {
            err.response.code = httpCodeForStatus(typeof err.status === 'number' ? err.status : 500);
          }
        }

        // Unmapped HttpExceptions go on to the envelope filter; anything else
        // (a TypeError, a raw Error) to the catch-all filter. Either one writes
        // the failure line.
        return throwError(() => err);
      }),
    );
  }
}

// Prisma error code → HTTP status mapping.
//
// This is the single Prisma-mapping mechanism ( deleted the
// unwired `PrismaClientExceptionFilter`). Any code outside the table below
// falls back to 400 / 'Bad Request' to preserve the legacy generic-default
// behaviour.
// Entitlements capability → HTTP status.
//
//   - rolling-monthly METER caps (Q5) → 429 Too Many Requests
//   - concurrency cap (simultaneous sessions) → 429 Too Many Requests
//   - the tenant storage quota (Q6) → 413 Payload Too Large
//   - a feature-gate denial (F-series) → 403 Forbidden
//   - every quantity cap (users/depts/…) → 409 Conflict (default)
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
  // D11 — the five ledger-derived unit-allowance meters
  // (MeterCapabilityKey in @arcaai/applications' entitlements/enforcement.ts).
  // Same rolling-monthly-meter semantics as the three above; no
  // 'monthlyGuardrailCalls' — guardrail has no allowance column (D6/D16, never
  // quota-blocked), so no capability string for it can ever reach this map.
  'monthlySttSessionSeconds',
  'monthlyLlmTokens',
  'monthlyTtsCharacters',
  'monthlyNlpTextUnits',
  'monthlyEmbeddingTokens',
  // TASK-998 OD-4 — the OUTBOUND cloud-ASR vendor-capacity dimensions
  // (`IProviderCapacityService`). Retry-later, exactly like the concurrency cap
  // above and unlike a quantity conflict: the vendor's per-minute window rolls
  // over, and a live stream ends. 409 would tell a caller to change something
  // that is already correct.
  'sttProviderRequestsPerMinute',
  'sttProviderMaxConcurrentStreams',
]);

function mapQuotaCapabilityToHttp(capability: string | undefined): HttpStatus {
  if (capability && QUOTA_RATE_CAPABILITIES.has(capability)) return HttpStatus.TOO_MANY_REQUESTS;
  if (capability === 'storageQuotaBytes') return HttpStatus.PAYLOAD_TOO_LARGE;
  if (capability && capability.startsWith('feature')) return HttpStatus.FORBIDDEN;
  return HttpStatus.CONFLICT;
}

export const PRISMA_QUERY_INVALID_CODE = 'PERSISTENCE.QUERY_INVALID';

/**
 * Wrap a domain exception's `toJSON()` in the unified envelope.
 *
 * `BaseException.toJSON()` deliberately knows nothing about HTTP, so its body
 * carried `{code, message, metadata, correlationId}` and no `statusCode` — the
 * H-2 asymmetry. The status is added HERE (the only layer that knows it);
 * every field `toJSON()` already produced is preserved verbatim.
 */
function unifiedDomainBody(err: BaseException, status: HttpStatus, correlationId?: string): Record<string, unknown> {
  // `stack` and `cause` are server-side detail: they go to the failure line,
  // never into a client body, in any environment.
  const { stack: _stack, cause: _cause, ...json } = err.toJSON() as unknown as Record<string, unknown>;
  return toUnifiedErrorBody(json, { status, correlationId });
}

/** The sanitised client body every Prisma-derived failure gets: a fixed label, never `err.message` / `err.meta`. */
function prismaHttpException(status: HttpStatus, code: string, label: string, correlationId: string | undefined): HttpException {
  return new HttpException(
    {
      statusCode: status,
      code,
      // The label is the ONLY text that reaches the client. It is a fixed
      // string from the table below — never `err.message` and never
      // `err.meta`, both of which leak column names, constraint names and
      // row ids.
      message: label,
      error: label,
      correlationId,
    },
    status,
  );
}

const PRISMA_MESSAGE_MAX = 200;

/**
 * The first meaningful line of a Prisma error message, capped at 200 chars,
 * with the "Invalid `prisma.x.y()` invocation" block removed. That block
 * reprints the query — `where` values, `data` payloads — and a query is where
 * patient identifiers live. What survives is the trailing summary line
 * ("Unique constraint failed on the fields: (`email`)").
 */
export function sanitizePrismaMessage(message: unknown): string {
  let text = typeof message === 'string' ? message : '';
  const invocation = text.search(/Invalid `prisma\./);
  if (invocation >= 0) {
    const paragraphs = text.slice(invocation).split(/\n\s*\n/);
    text = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1] : '';
  }
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (first ?? '').slice(0, PRISMA_MESSAGE_MAX);
}

/**
 * Log fields for a Prisma error. The error OBJECT is deliberately withheld
 * (named, not passed): its message and stack embed the invocation block.
 */
function prismaLogFields(err: unknown): FailureLogContext {
  const e = err as { name?: string; code?: unknown; meta?: { modelName?: unknown; target?: unknown }; message?: unknown } | undefined;
  return {
    errorName: e?.name ?? 'PrismaError',
    prismaCode: typeof e?.code === 'string' ? e.code : undefined,
    modelName: e?.meta?.modelName,
    target: e?.meta?.target,
    prismaMessage: sanitizePrismaMessage(e?.message),
  };
}

/** Log fields for a persistence exception: its own name/message, and its Prisma cause the sanitised way. */
function persistenceLogFields(err: BaseException): FailureLogContext {
  const cause = prismaLogFields(err.cause);
  return {
    errorName: err.name,
    errorMessage: err.message,
    causeName: err.cause ? cause.errorName : undefined,
    prismaCode: cause.prismaCode,
    modelName: cause.modelName,
    target: cause.target,
    prismaMessage: err.cause ? cause.prismaMessage : undefined,
  };
}

function mapPrismaCodeToHttp(code: string): { status: HttpStatus; label: string; code: string; known: boolean } {
  switch (code) {
    case 'P2002':
      return { status: HttpStatus.CONFLICT, label: 'Unique constraint violation', code: 'PERSISTENCE.UNIQUE_CONSTRAINT_VIOLATION', known: true };
    // NOT structurally dead. `Repository.updateWithVersion`
    // (the OCC path most PATCH routes use) issues `updateMany`, which never
    // throws P2025 on zero matched rows — and most services `findById` first,
    // surfacing a `DataNotFoundException` (→404) before Prisma is ever
    // touched, so this branch is unreachable on THAT path specifically.
    // But `Repository.update`, `delete`, `softDelete`, and `restore`
    // (`packages/domains/src/common/repository.ts`) all issue a single-row
    // Prisma `update`/`delete`, which DOES throw P2025 when 0 rows match —
    // reachable via an ordinary TOCTOU race: a caller's pre-read
    // (`findById`) succeeds, then a concurrent delete/soft-delete removes
    // the row before this write lands. Kept as defense-in-depth for that
    // race window, not deleted.
    case 'P2025':
      return { status: HttpStatus.NOT_FOUND, label: 'Not found', code: 'PERSISTENCE.RECORD_NOT_FOUND', known: true };
    case 'P2003':
      return { status: HttpStatus.BAD_REQUEST, label: 'Foreign key constraint violation', code: 'PERSISTENCE.FOREIGN_KEY_VIOLATION', known: true };
    case 'P2014':
      return { status: HttpStatus.BAD_REQUEST, label: 'Required relation violation', code: 'PERSISTENCE.REQUIRED_RELATION_VIOLATION', known: true };
    default:
      return { status: HttpStatus.BAD_REQUEST, label: 'Bad Request', code: PRISMA_QUERY_INVALID_CODE, known: false };
  }
}

/**
 * Set `Retry-After` on a 503, unless something upstream already chose a value.
 *
 * Written straight onto the response rather than into the body because
 * `Retry-After` is a header by definition (RFC 9110 §10.2.3) and because the
 * interceptor rethrows — Nest's default filter writes the status and body but
 * leaves headers already set on the response intact.
 */
function setRetryAfter(response: { setHeader?: (name: string, value: string) => void; getHeader?: (name: string) => unknown } | undefined): void {
  if (typeof response?.setHeader !== 'function') return;
  if (typeof response.getHeader === 'function' && response.getHeader('Retry-After') !== undefined) return;
  response.setHeader('Retry-After', String(DOWNSTREAM_RETRY_AFTER_SECONDS));
}
