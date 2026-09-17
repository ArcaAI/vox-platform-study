import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/** Response surface this interceptor needs from the underlying Express response. */
interface ETagResponse {
  setHeader: (key: string, value: string) => void;
  /** Express's reader — absent on minimal test doubles, hence optional. */
  getHeader?: (key: string) => string | number | string[] | undefined;
  status: (code: number) => unknown;
  /** True once the response head has been flushed — always true mid-stream on `@Sse()` routes. */
  headersSent?: boolean;
}

/** Request surface this interceptor needs. All fields are optional — non-HTTP contexts have none. */
interface ETagRequest {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  /** Populated by the Passport JWT strategy / `JwtAuthGuard`. */
  user?: unknown;
  /** Populated by `UnifiedAuthGuard`'s API-key branch. */
  apiKey?: unknown;
  /** Populated by `UnifiedAuthGuard`'s service-account branch. */
  serviceAccount?: unknown;
}

/**
 * Sets a strong-comparison `ETag` header on responses whose body carries a
 * positive-integer `version` field at the top level, and serves the matching
 * conditional GET (`If-None-Match` -> `304 Not Modified`).
 *
 * Why a strong validator (`"<n>"`, not `W/"<n>"`)?
 * RFC 7232 §2.3.2 requires `If-Match` to use strong comparison. Weak
 * validators (`W/"<n>"`) only guarantee "semantically equivalent" — they're
 * intended for caching, not concurrency control. Using the monotonic
 * integer `_version` rendered as `"<n>"` is the simplest strong validator:
 * byte-for-byte equality iff the row hasn't moved.
 *
 * This is now the ONLY ETag the API emits. `main.ts` sets
 * `app.set('etag', false)` to disable Express's default auto-generated
 * content-hash validator, which used to put a WEAK `W/"<len>-<hash>"` on every
 * JSON GET — including the ~70% of GET routes whose body has no `version`.
 * Those weak tokens were unusable as preconditions: replayed as `If-Match`
 * they either failed the strong-validator check with 400, or — on a route
 * with no `@ExpectedVersion()` — were SILENTLY DISCARDED and the write
 * proceeded anyway. Advertising no validator is strictly safer than
 * advertising one the write path will never honour.
 *
 * Body shapes the interceptor INTENTIONALLY ignores:
 *   - Collection responses (`{ data: [...] }`) — a single ETag can't
 *     represent N rows; the SDK reads per-row `.version` from each item.
 *     Consequently collections never take the 304 path either.
 *   - Responses without `.version` — most non-mutable resources, error
 *     payloads, health checks.
 *   - Non-positive / non-integer / non-numeric `version` — a defensive
 *     guard against legacy mappers that might leak the field as a string;
 *     emitting `ETag: "0"` or `ETag: "abc"` would silently break OCC by
 *     letting a malformed conditional PATCH through.
 *
 * `Cache-Control: private, no-cache` is set on every AUTHENTICATED GET.
 * `no-cache` means "store, but revalidate before every reuse" — that is what
 * makes the 304 path usable at all, while staying correct for PHI. It is
 * deliberately not `no-store`, which would forbid the client from holding a
 * copy to revalidate. `private` keeps shared caches out of it entirely.
 *
 * `Cache-Control: no-transform` is appended to EVERY response that carries an
 * ETag (GET and mutation alike), merged with whatever Cache-Control is already
 * there. RFC 9110 §8.8.1 REQUIRES an intermediary that transforms the payload
 * to weaken the validator it forwards, and the deployed stack does exactly that
 * — Cloudflare/Traefik gzip the JSON and the browser receives `W/"7"` where an
 * uncompressed fetch of the same row gets `"7"`. A weak validator is useless as
 * a precondition here: `@ExpectedVersion()` rejects `If-Match: W/"7"` with 400.
 * §5.2.6 `no-transform` forbids the transformation, so the strong validator
 * survives the hop intact. (The admin console additionally unwraps a `W/` it
 * still receives, for proxies that ignore the directive.)
 *
 * STREAMING SAFETY: an interceptor's `map` runs once per EMISSION, and an
 * `@Sse()` route emits many times over one already-flushed response. Any
 * `setHeader` after that flush throws `ERR_HTTP_HEADERS_SENT` and turns the
 * stream into a 500. So `Cache-Control` is set eagerly BEFORE the handler is
 * subscribed (headers cannot have been sent yet), and everything inside `map`
 * bails out the moment `res.headersSent` is true.
 *
 * The interceptor runs once globally (registered in `main.ts`); it never
 * mutates the body, so non-versioned routes stay effectively zero-cost.
 *
 * @see https://www.rfc-editor.org/rfc/rfc7232.html#section-2.3.2
 * @see https://www.rfc-editor.org/rfc/rfc7232.html#section-3.1
 * @see https://www.rfc-editor.org/rfc/rfc7232.html#section-3.2
 */
@Injectable()
export class ETagInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const res = http.getResponse<ETagResponse>();
    const req = http.getRequest<ETagRequest>() ?? {};
    const isGet = req.method === 'GET' || req.method === 'HEAD';

    // Set before subscribing to the handler: on a streaming route the head is
    // flushed on the first emission, and `map` would then be too late.
    //
    // `headersSent` is checked HERE too, not only inside `map`. Nest wraps the
    // interceptor chain in `defer()`, and for an `@Sse()` route the response
    // controller writes the SSE head BEFORE subscribing to that deferred chain
    // — so `intercept()` itself can run after the flush, and this `setHeader`
    // threw `ERR_HTTP_HEADERS_SENT`, turning the whole stream into a 500 on the
    // FIRST byte. It only bit JWT/api-key-authenticated streams: a ticket-
    // authenticated one leaves `req.user` unset, skips this branch, and
    // survived — which is why the trajectory stream passed while the loop
    // stream (Bearer) never delivered an event or a heartbeat.
    let eagerCacheControl: string | undefined;
    if (isGet && !res.headersSent && Boolean(req.user ?? req.apiKey ?? req.serviceAccount)) {
      eagerCacheControl = 'private, no-cache';
      res.setHeader('Cache-Control', eagerCacheControl);
    }

    return next.handle().pipe(
      map((body) => {
        // Mid-stream emission (`@Sse()`), or a handler that wrote the response
        // itself via `@Res()`. Touching headers here would throw.
        if (res.headersSent) return body;

        const version = this.extractVersion(body);
        if (version === undefined) return body;

        const etag = `"${version}"`;
        res.setHeader('ETag', etag);
        this.forbidTransformation(res, eagerCacheControl);

        // Conditional GET is strictly opt-in from the client side: a client
        // that never sends `If-None-Match` sees no change in behaviour.
        if (isGet && this.isNoneMatch(req.headers?.['if-none-match'], etag)) {
          res.status(304);
          // Empty body — a 304 must carry no representation, and must never
          // leak PHI on the not-modified path.
          return undefined;
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

  /**
   * RFC 7232 §3.2: `If-None-Match` is a comma-separated list compared with the
   * WEAK comparison function, so `W/"7"` matches `"7"`. This relaxation applies
   * ONLY to `If-None-Match`; `If-Match` preconditions stay strong-comparison
   * and are enforced separately by `@ExpectedVersion()`, which still rejects
   * weak and malformed validators with 400.
   */
  private isNoneMatch(header: string | string[] | undefined, etag: string): boolean {
    if (typeof header !== 'string' || header.length === 0) return false;
    const opaque = this.stripWeak(etag);
    return header.split(',').some((candidate) => this.stripWeak(candidate.trim()) === opaque);
  }

  /**
   * Appends `no-transform` to Cache-Control so an intermediary may not rewrite
   * the body — which is what obliges it to weaken this ETag (RFC 9110 §8.8.1),
   * and what cost the deployed console its If-Match preconditions.
   *
   * Merge, never clobber: `no-store` / `private` set by a route or another
   * layer must survive. `eager` is the value this interceptor set itself before
   * subscribing, used when the response surface has no `getHeader` (test
   * doubles, non-Express adapters).
   */
  private forbidTransformation(res: ETagResponse, eager: string | undefined): void {
    const current = res.getHeader?.('Cache-Control') ?? eager;
    const raw = Array.isArray(current) ? current.join(', ') : current == null ? '' : String(current);
    const directives = raw
      .split(',')
      .map((directive) => directive.trim())
      .filter(Boolean);
    if (directives.some((directive) => directive.toLowerCase() === 'no-transform')) return;
    directives.push('no-transform');
    res.setHeader('Cache-Control', directives.join(', '));
  }

  private stripWeak(validator: string): string {
    return validator.startsWith('W/') ? validator.slice(2) : validator;
  }
}
