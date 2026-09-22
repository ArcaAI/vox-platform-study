import { BadRequestException, Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Observable } from 'rxjs';
import { tap, finalize } from 'rxjs/operators';
import { uuidv7 } from 'uuidv7';
import { trace } from '@opentelemetry/api';
import { resolveActiveTenant } from './resolve-active-tenant';

@Injectable()
export class ContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ContextInterceptor.name);

  constructor(private readonly clsService: ClsService) {}

  private tryClsSet(key: string, value: unknown): boolean {
    try {
      this.clsService.set(key, value);
      return true;
    } catch {
      return false;
    }
  }

  private tryClsGet(key: string): unknown {
    try {
      return this.clsService.get(key);
    } catch {
      return undefined;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest();

    const activeSpan = trace.getActiveSpan();
    const spanContext = activeSpan?.spanContext();
    const traceId = spanContext?.traceId;
    const spanId = spanContext?.spanId;

    if (traceId) {
      this.tryClsSet('traceId', traceId);
      this.tryClsSet('spanId', spanId);
    }

    if (!request.requestId) {
      // Source the correlation id from the standard `x-request-id` header
      // (set by an upstream LB / CDN / gateway), NOT from
      // `request.body.requestId` — reading a body field would let any
      // client pin its own correlation id with a POST payload, polluting
      // CLS / logs and letting two unrelated requests share an id.
      // Fallback stays uuidv7() so the logs always get a
      // strictly-increasing identifier.
      const headerRequestId = request.headers?.['x-request-id'];
      const normalisedHeader = Array.isArray(headerRequestId) ? headerRequestId[0] : headerRequestId;
      request.requestId = (typeof normalisedHeader === 'string' && normalisedHeader.length > 0 ? normalisedHeader : undefined) ?? uuidv7();
      this.tryClsSet('correlationId', request.requestId);
    }

    // Store the request IP (normalize IPv6 mapped IPv4)
    const clientIp = request.ip?.startsWith('::ffff:') ? request.ip.split(':').pop() : request.ip;
    this.tryClsSet('requestIp', clientIp);

    // The `x-tenant-id` header MUST NOT override the JWT-derived CLS
    // `tenantId` (`JwtStrategy.validate` is the single source of truth).
    // A divergent header is rejected as 400 Bad Request so the caller
    // cannot pretend they're in a different tenant.
    const tenantIdHeader = request.headers['x-tenant-id'];
    if (tenantIdHeader) {
      const clsUser = this.tryClsGet('user') as { id?: string; tenantId?: string | null; roles?: string[] | null } | undefined;
      const jwtTenantId = clsUser?.tenantId ?? undefined;
      if (jwtTenantId && tenantIdHeader !== jwtTenantId) {
        this.logger.warn({
          message: 'x-tenant-id header diverges from JWT-derived tenant; rejecting request',
          tenantIdHeader,
          jwtTenantId,
        });
        throw new BadRequestException('x-tenant-id header does not match the authenticated tenant');
      }

      // A super-admin authenticates with an EMPTY tenant, so the
      // divergence guard above never fires for them. The
      // console's "manage as tenant" selection arrives as `x-tenant-id`; for a
      // super-admin with no tenant binding we elevate the CLS `tenantId` to it
      // so downstream CLS-scoped services (Departments, Prompts, Storage, …)
      // operate inside the chosen tenant. Gated to super-admins only and
      // audited — anyone else falls through with their tenant unchanged.
      const decision = resolveActiveTenant(clsUser, tenantIdHeader);
      if (decision.type === 'invalid') {
        throw new BadRequestException('Invalid x-tenant-id format');
      }
      if (decision.type === 'elevate') {
        this.tryClsSet('tenantId', decision.tenantId);
        this.logger.log({
          message: 'super-admin elevated active tenant from x-tenant-id header',
          superAdminId: clsUser?.id,
          elevatedTenantId: decision.tenantId,
          correlationId: request.requestId,
        });
      }
    }

    // Capture start time for performance logging
    const start = Date.now();

    // TASK-1001 S-8 — `next.handle()` is NOT always a single-emission
    // Observable. For an ordinary JSON route it emits exactly one value then
    // completes, but for an `@Sse()` route (e.g. the live-summary stream) it
    // emits ONE value per frame — every section patch, presummary event and
    // heartbeat — over the entire life of a long-lived connection. `tap`'s
    // `next` callback runs once PER EMITTED VALUE, so logging "Request
    // completed" there fired once per SSE frame instead of once per
    // connection: a single 152s stream produced dozens of log lines with a
    // growing `durationMs` (observed: 2ms, 10804ms, 15003ms, … 166737ms for
    // ONE connection), which multiplied 4 real connections into an apparent
    // 58 in Loki's request-count aggregations.
    //
    // `finalize()` instead runs EXACTLY ONCE when the observable terminates,
    // for any reason — natural completion (the ordinary-response case, and
    // the SSE case once its own `closed: true` frame ends the stream), an
    // error, or the subscription simply being torn down (an SSE client
    // disconnecting before the stream's own terminal event ever arrives).
    // That makes it the correct place for a once-per-request completion log
    // regardless of response shape. The `hasErrored` guard stops it from
    // double-logging a request that failed: that outcome already gets its
    // own "Request failed" line from the `tap.error` callback below, and
    // `finalize` always runs after (or instead of) that callback since it
    // fires on every termination path, error included.
    let hasErrored = false;

    const logRequestCompleted = () => {
      if (hasErrored) return;
      const durationMs = Date.now() - start;
      this.logger.log({
        message: 'Request completed',
        requestId: request.requestId,
        traceId,
        spanId,
        method: request.method,
        path: request.url,
        durationMs,
        clientIp,
        tenantId: this.tryClsGet('tenantId'),
        statusCode: httpContext.getResponse()?.statusCode,
      });
    };

    return next.handle().pipe(
      tap({
        error: (err) => {
          hasErrored = true;
          const durationMs = Date.now() - start;
          this.logger.error({
            message: 'Request failed',
            requestId: request.requestId,
            traceId,
            spanId,
            method: request.method,
            path: request.url,
            durationMs,
            clientIp,
            tenantId: this.tryClsGet('tenantId'),
            errorMessage: err?.message || String(err),
            errorType: err?.constructor?.name,
            statusCode: err?.status || err?.statusCode || 500,
          });
          throw err; // rethrow the error to ensure it is propagated
        },
      }),
      finalize(logRequestCompleted),
    );
  }
}
