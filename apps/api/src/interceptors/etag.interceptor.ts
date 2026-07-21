import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Sets a strong-comparison `ETag` header on responses whose body carries a
 * positive-integer `version` field at the top level.
 *
 * Why a strong validator (`"<n>"`, not `W/"<n>"`)?
 * RFC 7232 §2.3.2 requires `If-Match` to use strong comparison. Weak
 * validators (`W/"<n>"`) only guarantee "semantically equivalent" — they're
 * intended for caching, not concurrency control. Using the monotonic
 * integer `_version` rendered as `"<n>"` is the simplest strong validator:
 * byte-for-byte equality iff the row hasn't moved.
 *
 * Body shapes the interceptor INTENTIONALLY ignores:
 *   - Collection responses (`{ data: [...] }`) — a single ETag can't
 *     represent N rows; the SDK reads per-row `.version` from each item.
 *   - Responses without `.version` — most non-mutable resources, error
 *     payloads, health checks.
 *   - Non-positive / non-integer / non-numeric `version` — a defensive
 *     guard against legacy mappers that might leak the field as a string;
 *     emitting `ETag: "0"` or `ETag: "abc"` would silently break OCC by
 *     letting a malformed conditional PATCH through.
 *
 * The interceptor runs once globally (registered in `main.ts`); it never
 * mutates the body, so non-versioned routes are zero-cost.
 *
 * @see https://www.rfc-editor.org/rfc/rfc7232.html#section-2.3.2
 * @see https://www.rfc-editor.org/rfc/rfc7232.html#section-3.1
 */
@Injectable()
export class ETagInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = context.switchToHttp().getResponse<{ setHeader: (k: string, v: string) => void }>();
    return next.handle().pipe(
      map((body) => {
        const version = this.extractVersion(body);
        if (version !== undefined) {
          res.setHeader('ETag', `"${version}"`);
        }
        return body;
      }),
    );
  }

  private extractVersion(body: unknown): number | undefined {
    if (!body || typeof body !== 'object') return undefined;
    // Collection wrappers (FetchResponse) intentionally skipped — see
    // class docstring.
    if (Array.isArray((body as { data?: unknown }).data)) return undefined;
    const v = (body as { version?: unknown }).version;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return undefined;
    return v;
  }
}
