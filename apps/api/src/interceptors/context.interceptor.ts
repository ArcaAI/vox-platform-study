import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { uuidv7 } from 'uuidv7';

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

    // Ensure requestId is assigned once, avoid overwriting if it's already set
    if (!request.requestId) {
      request.requestId = request?.body?.requestId ?? uuidv7();
      this.tryClsSet('correlationId', request.requestId);
    }

    // Store the request IP (normalize IPv6 mapped IPv4)
    const clientIp = request.ip?.startsWith('::ffff:') ? request.ip.split(':').pop() : request.ip;
    this.tryClsSet('requestIp', clientIp);

    // Only override tenant context from header when explicitly provided;
    // otherwise preserve the value already set by the auth guard from the JWT.
    const tenantIdHeader = request.headers['x-tenant-id'];
    if (tenantIdHeader) {
      this.tryClsSet('tenantId', tenantIdHeader);
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
            method: request.method,
            path: request.url,
            durationMs,
            clientIp,
            tenantId: tenantIdHeader ?? this.tryClsGet('tenantId'),
            statusCode: httpContext.getResponse()?.statusCode,
          });
        },
        error: (err) => {
          const durationMs = Date.now() - start;
          this.logger.error({
            message: 'Request failed',
            requestId: request.requestId,
            method: request.method,
            path: request.url,
            durationMs,
            clientIp,
            tenantId: tenantIdHeader ?? this.tryClsGet('tenantId'),
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
