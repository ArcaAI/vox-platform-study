import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RATE_LIMIT_RESOLUTION_KEY, type RequestRateLimitResolution } from './tiered-throttler.guard';

/**
 * Advertise the applied rate-limit policy on the response.
 *
 * Shape follows `draft-ietf-httpapi-ratelimit-headers`: ONE `RateLimit` field
 * plus a `RateLimit-Policy` field. The older three-header form
 * (`RateLimit-Limit` / `-Remaining` / `-Reset`) is the superseded draft, so new
 * surfaces should not emit it.
 *
 * DELIBERATELY OMITTED: which tenant, plan or rule supplied the number. That
 * would leak platform topology to any caller; it belongs in the super-admin-only
 * `GET /admin/rate-limit/explain`.
 *
 * `Retry-After` on a 429 is emitted by `@nestjs/throttler` itself; this
 * interceptor only adds the advisory fields on the success path.
 */
@Injectable()
export class RateLimitHeadersInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      tap(() => {
        const http = context.switchToHttp();
        const request = http.getRequest<Record<string, unknown>>();
        const resolution = request?.[RATE_LIMIT_RESOLUTION_KEY] as RequestRateLimitResolution | undefined;
        if (!resolution) return;

        const response = http.getResponse<{ setHeader?: (name: string, value: string) => void; headersSent?: boolean }>();
        if (!response?.setHeader || response.headersSent) return;

        const windowSeconds = Math.max(1, Math.round(resolution.windowMs / 1000));
        try {
          response.setHeader('RateLimit-Policy', `"default";q=${resolution.limitValue};w=${windowSeconds}`);
          response.setHeader('RateLimit', `"default";r=${resolution.limitValue};t=${windowSeconds}`);
        } catch {
          // A stream/upgrade response may reject late header writes. Advisory
          // metadata is never worth failing a request that already succeeded.
        }
      }),
    );
  }
}
