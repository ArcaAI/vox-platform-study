/**
 * ETagInterceptor unit tests.
 *
 * The interceptor scans every response body that flows through and, when it
 * spots a top-level `version: <positive integer>`, emits an RFC 7232
 * strong-comparison `ETag` header (`"<n>"`, no `W/` prefix). Collections
 * (`{ data: [...] }`), responses without `.version`, and primitives are
 * passed through unchanged.
 *
 * Strong validators are required because the `If-Match` precondition on
 * PATCH must use strong comparison (RFC 7232 §2.3.2 / §3.1).
 *
 * @see apps/api/src/interceptors/etag.interceptor.ts
 * @see https://www.rfc-editor.org/rfc/rfc7232.html#section-2.3.2
 */
import { describe, it, expect, vi } from 'vitest';
import { of, lastValueFrom } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { ETagInterceptor } from '../etag.interceptor';

type FakeResponse = {
  setHeader: ReturnType<typeof vi.fn>;
  status?: ReturnType<typeof vi.fn>;
  headersSent?: boolean;
};
type FakeRequest = { method?: string; headers?: Record<string, string | undefined>; user?: unknown };

const makeContext = (response: FakeResponse, request: FakeRequest = {}): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  }) as unknown as ExecutionContext;

/** An authenticated GET — the only shape that can produce a 304 / Cache-Control. */
const authedGet = (ifNoneMatch?: string): FakeRequest => ({
  method: 'GET',
  headers: ifNoneMatch === undefined ? {} : { 'if-none-match': ifNoneMatch },
  user: { id: 'u1' },
});

const makeRes = (): FakeResponse & { status: ReturnType<typeof vi.fn> } => {
  const res = { setHeader: vi.fn(), status: vi.fn(), headersSent: false };
  res.status.mockReturnValue(res);
  return res;
};

describe('ETagInterceptor', () => {
  it('sets ETag from body.version', async () => {
    const res = { setHeader: vi.fn() };
    const next: CallHandler = { handle: () => of({ id: 'x', version: 7 }) };
    const interceptor = new ETagInterceptor();
    const result = await lastValueFrom(interceptor.intercept(makeContext(res), next));
    expect(res.setHeader).toHaveBeenCalledWith('ETag', '"7"');
    expect(result).toEqual({ id: 'x', version: 7 });
  });

  it('does not set ETag when body has no version', async () => {
    const res = { setHeader: vi.fn() };
    const next: CallHandler = { handle: () => of({ id: 'x' }) };
    const interceptor = new ETagInterceptor();
    await lastValueFrom(interceptor.intercept(makeContext(res), next));
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('does NOT set ETag for collection responses (FetchResponse wrapper)', async () => {
    const res = { setHeader: vi.fn() };
    const next: CallHandler = { handle: () => of({ data: [{ id: 'x', version: 4 }] }) };
    const interceptor = new ETagInterceptor();
    await lastValueFrom(interceptor.intercept(makeContext(res), next));
    // Collections don't carry a single ETag — interceptor must not set one.
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('does NOT set ETag for non-positive version (0)', async () => {
    // Defensive: `version: 0` would render as `ETag: "0"` and break the
    // OCC contract (the row's _version starts at 1 per the schema default).
    const res = { setHeader: vi.fn() };
    const next: CallHandler = { handle: () => of({ id: 'x', version: 0 }) };
    const interceptor = new ETagInterceptor();
    await lastValueFrom(interceptor.intercept(makeContext(res), next));
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('does NOT set ETag for non-integer version (string)', async () => {
    // If a service ever returns version as a string (legacy mapper bug),
    // we must not render it as an ETag — that would mask the real
    // problem with a syntactically-valid-but-semantically-broken token.
    const res = { setHeader: vi.fn() };
    const next: CallHandler = { handle: () => of({ id: 'x', version: '7' as unknown as number }) };
    const interceptor = new ETagInterceptor();
    await lastValueFrom(interceptor.intercept(makeContext(res), next));
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Conditional GET (`If-None-Match` -> 304) + Cache-Control
  //
  // Express's own auto-ETag is disabled (`app.set('etag', false)` in main.ts),
  // so the strong `"<version>"` validator emitted above is the ONLY ETag the
  // API ever advertises. These tests pin the matching conditional-GET path.
  // ==========================================================================

  describe('conditional GET', () => {
    it('returns 304 with the ETag and an empty body when If-None-Match matches', async () => {
      const res = makeRes();
      const next: CallHandler = { handle: () => of({ id: 'x', version: 7, secret: 'phi' }) };
      const result = await lastValueFrom(new ETagInterceptor().intercept(makeContext(res, authedGet('"7"')), next));
      expect(res.setHeader).toHaveBeenCalledWith('ETag', '"7"');
      expect(res.status).toHaveBeenCalledWith(304);
      // 304 must carry no body — never leak PHI on the not-modified path.
      expect(result).toBeUndefined();
    });

    it('returns 200 with the body when If-None-Match is stale', async () => {
      const res = makeRes();
      const body = { id: 'x', version: 8 };
      const next: CallHandler = { handle: () => of(body) };
      const result = await lastValueFrom(new ETagInterceptor().intercept(makeContext(res, authedGet('"7"')), next));
      expect(res.setHeader).toHaveBeenCalledWith('ETag', '"8"');
      expect(res.status).not.toHaveBeenCalled();
      expect(result).toBe(body);
    });

    it('returns 200 with the body when the client sends no If-None-Match', async () => {
      const res = makeRes();
      const body = { id: 'x', version: 7 };
      const next: CallHandler = { handle: () => of(body) };
      const result = await lastValueFrom(new ETagInterceptor().intercept(makeContext(res, authedGet()), next));
      expect(res.status).not.toHaveBeenCalled();
      expect(result).toBe(body);
    });

    it('never returns 304 for a collection body, even when If-None-Match is sent', async () => {
      // A single ETag cannot represent N rows, so collections carry no ETag
      // and must never take the not-modified path.
      const res = makeRes();
      const body = { data: [{ id: 'x', version: 7 }] };
      const next: CallHandler = { handle: () => of(body) };
      const result = await lastValueFrom(new ETagInterceptor().intercept(makeContext(res, authedGet('"7"')), next));
      expect(res.setHeader).not.toHaveBeenCalledWith('ETag', expect.anything());
      expect(res.status).not.toHaveBeenCalled();
      expect(result).toBe(body);
    });

    it('matches one entry out of an If-None-Match list', async () => {
      const res = makeRes();
      const next: CallHandler = { handle: () => of({ id: 'x', version: 7 }) };
      await lastValueFrom(new ETagInterceptor().intercept(makeContext(res, authedGet('"3", "7", "9"')), next));
      expect(res.status).toHaveBeenCalledWith(304);
    });

    it('uses weak comparison for If-None-Match (RFC 7232 §3.2)', async () => {
      // If-None-Match is defined to use WEAK comparison, so an intermediary
      // that weakened our strong validator must still get a 304. This does
      // NOT relax `If-Match`, which is enforced separately by
      // `@ExpectedVersion()` and still rejects weak validators with 400.
      const res = makeRes();
      const next: CallHandler = { handle: () => of({ id: 'x', version: 7 }) };
      await lastValueFrom(new ETagInterceptor().intercept(makeContext(res, authedGet('W/"7"')), next));
      expect(res.status).toHaveBeenCalledWith(304);
    });

    it('does not 304 a non-GET request that happens to carry If-None-Match', async () => {
      const res = makeRes();
      const body = { id: 'x', version: 7 };
      const next: CallHandler = { handle: () => of(body) };
      const result = await lastValueFrom(
        new ETagInterceptor().intercept(makeContext(res, { method: 'PATCH', headers: { 'if-none-match': '"7"' }, user: { id: 'u1' } }), next),
      );
      expect(res.status).not.toHaveBeenCalled();
      expect(result).toBe(body);
    });

    it('tolerates a request object with no method/headers (non-HTTP contexts)', async () => {
      const res = makeRes();
      const next: CallHandler = { handle: () => of({ id: 'x', version: 7 }) };
      await lastValueFrom(new ETagInterceptor().intercept(makeContext(res, {}), next));
      expect(res.setHeader).toHaveBeenCalledWith('ETag', '"7"');
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Streaming safety
  //
  // `map` runs once per EMISSION. An `@Sse()` route emits many times over one
  // already-flushed response, and `setHeader` after that flush throws
  // ERR_HTTP_HEADERS_SENT — which turned every SSE stream into a 500.
  // ==========================================================================

  describe('streaming responses (@Sse)', () => {
    it('never touches headers once the response head has been flushed', async () => {
      const res = makeRes();
      res.headersSent = true;
      const body = { id: 'x', version: 7 };
      const next: CallHandler = { handle: () => of(body) };
      const result = await lastValueFrom(new ETagInterceptor().intercept(makeContext(res, authedGet('"7"')), next));
      expect(res.setHeader).not.toHaveBeenCalledWith('ETag', expect.anything());
      expect(res.status).not.toHaveBeenCalled();
      expect(result).toBe(body);
    });

    it('sets Cache-Control BEFORE subscribing, so a stream that flushes on its first emission is still labelled', async () => {
      const res = makeRes();
      const next: CallHandler = {
        handle: () => {
          // The head is flushed the moment the handler starts producing.
          res.headersSent = true;
          return of({ data: 'event-1' }, { data: 'event-2' });
        },
      };
      await lastValueFrom(new ETagInterceptor().intercept(makeContext(res, authedGet()), next));
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-cache');
      expect(res.setHeader).toHaveBeenCalledTimes(1);
    });

    it('survives a multi-emission versioned stream without a second setHeader', async () => {
      const res = makeRes();
      const next: CallHandler = {
        handle: () => {
          res.headersSent = true;
          return of({ id: 'a', version: 1 }, { id: 'b', version: 2 }, { id: 'c', version: 3 });
        },
      };
      await expect(
        lastValueFrom(new ETagInterceptor().intercept(makeContext(res, authedGet()), next)),
      ).resolves.toEqual({ id: 'c', version: 3 });
      expect(res.setHeader).not.toHaveBeenCalledWith('ETag', expect.anything());
    });
  });

  describe('Cache-Control', () => {
    it('sets `private, no-cache` on an authenticated GET', async () => {
      // `no-cache` (revalidate), NOT `no-store`: storing-but-revalidating is
      // what makes the 304 path usable while staying correct for PHI.
      const res = makeRes();
      const next: CallHandler = { handle: () => of({ id: 'x', version: 7 }) };
      await lastValueFrom(new ETagInterceptor().intercept(makeContext(res, authedGet()), next));
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-cache');
    });

    it('sets `private, no-cache` on an API-key authenticated GET with no ETag', async () => {
      const res = makeRes();
      const next: CallHandler = { handle: () => of({ id: 'x' }) };
      await lastValueFrom(
        new ETagInterceptor().intercept(makeContext(res, { method: 'GET', headers: {}, apiKey: { id: 'k' } } as never), next),
      );
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-cache');
      expect(res.setHeader).not.toHaveBeenCalledWith('ETag', expect.anything());
    });

    it('does NOT set Cache-Control on an unauthenticated GET', async () => {
      const res = makeRes();
      const next: CallHandler = { handle: () => of({ status: 'ok' }) };
      await lastValueFrom(new ETagInterceptor().intercept(makeContext(res, { method: 'GET', headers: {} }), next));
      expect(res.setHeader).not.toHaveBeenCalledWith('Cache-Control', expect.anything());
    });

    it('does NOT set Cache-Control on a mutation', async () => {
      const res = makeRes();
      const next: CallHandler = { handle: () => of({ id: 'x', version: 2 }) };
      await lastValueFrom(
        new ETagInterceptor().intercept(makeContext(res, { method: 'PATCH', headers: {}, user: { id: 'u1' } }), next),
      );
      expect(res.setHeader).not.toHaveBeenCalledWith('Cache-Control', expect.anything());
      expect(res.setHeader).toHaveBeenCalledWith('ETag', '"2"');
    });
  });

  it('passes the body through unchanged regardless of header decision', async () => {
    const res = { setHeader: vi.fn() };
    const body = { id: 'x', version: 12, name: 'tenant' };
    const next: CallHandler = { handle: () => of(body) };
    const interceptor = new ETagInterceptor();
    const result = await lastValueFrom(interceptor.intercept(makeContext(res), next));
    expect(result).toBe(body);
  });
});
