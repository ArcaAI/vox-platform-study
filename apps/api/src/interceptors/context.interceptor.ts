import { BadRequestException, Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { uuidv7 } from 'uuidv7';
import { trace } from '@opentelemetry/api';

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
      request.requestId = request?.body?.requestId ?? uuidv7();
      this.tryClsSet('correlationId', request.requestId);
    }

    // Store the request IP (normalize IPv6 mapped IPv4)
    const clientIp = request.ip?.startsWith('::ffff:') ? request.ip.split(':').pop() : request.ip;
    this.tryClsSet('requestIp', clientIp);

    // SEC-J / TASK-295 C-2 + TASK-307 W5.3 (AC-17, audit D-1): the
    // `x-tenant-id` header MUST NOT override the JWT-derived CLS
    // `tenantId` (`JwtStrategy.validate` is the single source of truth).
    // Previously we warn-logged divergence and silently dropped the
    // header — that turned the audit's "tenant confusion" probe into
    // a noisy-but-passing request. We now reject it as 400 Bad Request
    // so the caller cannot pretend they're in a different tenant.
    const tenantIdHeader = request.headers['x-tenant-id'];
    if (tenantIdHeader) {
      const clsUser = this.tryClsGet('user') as { tenantId?: string | null } | undefined;
      const jwtTenantId = clsUser?.tenantId ?? undefined;
      if (jwtTenantId && tenantIdHeader !== jwtTenantId) {
        this.logger.warn({
          message: 'x-tenant-id header diverges from JWT-derived tenant; rejecting request',
          tenantIdHeader,
          jwtTenantId,
        });
        throw new BadRequestException('x-tenant-id header does not match the authenticated tenant');
      }
    }

    // Capture start time for performance logging
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
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
        },
        error: (err) => {
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
    );
  }
}
