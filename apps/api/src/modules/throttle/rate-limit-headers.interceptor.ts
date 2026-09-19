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
 * `Retry-After` on a 429 is emitted by the guard (`TieredThrottlerGuard
 * .throwThrottlingException`, TASK-993 D-4); this interceptor only adds the
 * advisory fields on the success path.
 *
 * ## The two fields are NOT the same number (TASK-993 D-3)
 *
 * `RateLimit-Policy` states the POLICY — the quota and the window length —
 * and is therefore static. `RateLimit` states the current STATE: `r` is the
 * requests REMAINING and `t` the seconds until the window resets. This
 * interceptor used to render the policy's two numbers into both fields, so
 * `RateLimit: "default";r=30;t=60` sat next to `X-RateLimit-Remaining: 29` and
 * an integrator reading the modern header could never self-pace. The live
 * counters now arrive on the stash; when they are absent the `RateLimit` field
 * is OMITTED rather than filled with the quota — saying nothing is honest,
 * repeating the quota is the bug.
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
          if (resolution.remaining !== undefined && resolution.resetSeconds !== undefined) {
            response.setHeader('RateLimit', `"default";r=${Math.max(0, resolution.remaining)};t=${Math.max(0, resolution.resetSeconds)}`);
          }
        } catch {
          // A stream/upgrade response may reject late header writes. Advisory
          // metadata is never worth failing a request that already succeeded.
        }
      }),
    );
  }
}
