/**
 * TASK-993 lane F — the gateway stops throwing away the vendor's backoff.
 *
 * ─── The defect this file pins ──────────────────────────────────────────────
 *
 * Lane B taught `apps/text` to retry a vendor 429 and then surface it honestly:
 * HTTP 429, `error_code: "RATE_LIMITED"`, and a real `Retry-After`. The gateway
 * threw both halves away and the fix was only half-effective end to end:
 *
 *   · `buildUpstreamException` built `new HttpException({...}, status)` — and
 *     `HttpException` carries NO headers, so `Retry-After` never left the
 *     gateway.
 *   · `RELAYABLE_ERROR_PHRASES` did not list `RATE_LIMITED`, so the body was
 *     replaced by the generic fallback and the code was dropped.
 *
 * A caller therefore received a bare 429 with the phrase "TEXT service
 * unavailable" and no interval: it could not tell a throttle from an outage,
 * and could not pace itself. `PROVIDER_INVALID_REQUEST` and
 * `CONTEXT_WINDOW_EXCEEDED` (TASK-946's codes) had never reached a client
 * either, for the same missing-entry reason.
 *
 * ─── What must NOT change ───────────────────────────────────────────────────
 *
 * The PHI posture. That controller redacts upstream bodies deliberately — a
 * TEXT error body can quote the assembled clinical prompt. The allow-list
 * relays a CODE and substitutes the gateway's OWN phrase; it never forwards
 * `detail`/`message`. The `Retry-After` VALUE is re-rendered from a parsed
 * integer for the same reason, so no upstream string is echoed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { TextProxyController } from '../text-proxy.controller';

/** The clinical prompt a TEXT error body can quote back. It must never leave. */
const PHI_DETAIL = 'provider refused prompt: "Patient Jane Doe, DOB 1971-04-02, presents with..."';

function upstream(status: number, data: unknown, headers: Record<string, string> = {}): any {
  return Object.assign(new Error('upstream'), { isAxiosError: true, response: { status, data, headers } });
}

function build(rejection: any) {
  const http = { axiosRef: { post: vi.fn().mockRejectedValue(rejection), get: vi.fn() } };
  const cls = { get: vi.fn(() => 'tenant-abc'), getId: vi.fn(() => 'req-1') };
  const config = { getConfigValue: vi.fn(() => 'http://localhost:8862') };
  const selection = { resolveTextSelection: vi.fn(async () => ({ provider: 'vllm', model: 'medgemma-27b' })) };

  const ctrl = new TextProxyController(
    http as any,
    { fetchByCodeName: vi.fn() } as any,
    cls as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { getObject: vi.fn() } as any,
    config as any,
    undefined, // secretsService (@Optional)
    selection as any,
  );
  // Silence the deliberate redaction log — its own content is asserted below
  // only by what it does NOT contain.
  (ctrl as any).logger = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };

  const res = { setHeader: vi.fn(), headersSent: false } as any;
  return { ctrl, res, http };
}

/** Run `generate` and hand back the thrown exception plus the fake response. */
async function generateExpectingThrow(rejection: any) {
  const { ctrl, res, http } = build(rejection);
  let thrown: HttpException | undefined;
  try {
    await ctrl.generate({ prompt: 'p', stream: false, model: 'medgemma-27b' } as any, res);
  } catch (err) {
    thrown = err as HttpException;
  }
  expect(thrown, 'the handler must still fail the request').toBeInstanceOf(HttpException);
  return { thrown: thrown as HttpException, res, http };
}

const headerValue = (res: any, name: string): string | undefined => res.setHeader.mock.calls.find((c: unknown[]) => c[0] === name)?.[1];

beforeEach(() => vi.clearAllMocks());

describe('TEXT proxy — a vendor 429 reaches the caller intact', () => {
  it('relays the status, the code, and the Retry-After interval', async () => {
    const { thrown, res } = await generateExpectingThrow(upstream(429, { detail: PHI_DETAIL, error_code: 'RATE_LIMITED' }, { 'retry-after': '7' }));

    expect(thrown.getStatus()).toBe(429);
    expect(thrown.getResponse()).toMatchObject({ error_code: 'RATE_LIMITED' });
    // Set on the response BEFORE the throw: `HttpExceptionEnvelopeFilter`
    // writes the body with `.status().json()`, which does not clear headers.
    expect(headerValue(res, 'Retry-After')).toBe('7');
  });

  it('substitutes the gateway’s own phrase and never the upstream body', async () => {
    const { thrown } = await generateExpectingThrow(upstream(429, { detail: PHI_DETAIL, error_code: 'RATE_LIMITED' }, { 'retry-after': '7' }));

    const body = JSON.stringify(thrown.getResponse());
    expect(body).not.toContain('Jane Doe');
    expect(body).not.toContain('1971-04-02');
    expect(body).toContain('rate limiting');
  });

  it('rounds a fractional interval UP — a client told to wait 1s for 1.2s retries too early', async () => {
    const { res } = await generateExpectingThrow(upstream(429, { error_code: 'RATE_LIMITED' }, { 'retry-after': '1.2' }));
    expect(headerValue(res, 'Retry-After')).toBe('2');
  });

  it('caps an absurd interval rather than parking the console for a day', async () => {
    const { res } = await generateExpectingThrow(upstream(429, { error_code: 'RATE_LIMITED' }, { 'retry-after': '86400' }));
    expect(headerValue(res, 'Retry-After')).toBe('3600');
  });

  it('drops a value it cannot render as seconds instead of echoing it', async () => {
    // An HTTP-date is legal RFC 9110 and useless here: every consumer in this
    // platform reads `retry-after` as a number, and forwarding an arbitrary
    // upstream string is an echo this controller does not do.
    const { res } = await generateExpectingThrow(upstream(429, { error_code: 'RATE_LIMITED' }, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }));
    expect(headerValue(res, 'Retry-After')).toBeUndefined();
  });

  it('sets no Retry-After on a status that is not a throttle', async () => {
    const { res } = await generateExpectingThrow(upstream(503, { error_code: 'POOL_UNHEALTHY' }, { 'retry-after': '30' }));
    expect(headerValue(res, 'Retry-After')).toBeUndefined();
  });

  it('survives a handler called with no response object', async () => {
    // Every other `buildUpstreamException` call site passes none, and the two
    // that do are `@Res({ passthrough: true })` params that a unit test may
    // omit. Losing the hint must never cost the error.
    const { ctrl } = build(upstream(429, { error_code: 'RATE_LIMITED' }, { 'retry-after': '7' }));
    await expect(ctrl.generate({ prompt: 'p', stream: false, model: 'medgemma-27b' } as any)).rejects.toBeInstanceOf(HttpException);
  });
});

describe('TEXT proxy — the two TASK-946 codes that had never reached a client', () => {
  it('relays PROVIDER_INVALID_REQUEST', async () => {
    const { thrown } = await generateExpectingThrow(upstream(422, { detail: PHI_DETAIL, error_code: 'PROVIDER_INVALID_REQUEST' }));
    expect(thrown.getStatus()).toBe(422);
    expect(thrown.getResponse()).toMatchObject({ error_code: 'PROVIDER_INVALID_REQUEST' });
    expect(JSON.stringify(thrown.getResponse())).not.toContain('Jane Doe');
  });

  it('relays CONTEXT_WINDOW_EXCEEDED', async () => {
    const { thrown } = await generateExpectingThrow(upstream(422, { detail: PHI_DETAIL, error_code: 'CONTEXT_WINDOW_EXCEEDED' }));
    expect(thrown.getStatus()).toBe(422);
    expect(thrown.getResponse()).toMatchObject({ error_code: 'CONTEXT_WINDOW_EXCEEDED' });
  });

  it('leaves the allow-list CLOSED — an unlisted code still gets the generic body', async () => {
    const { thrown } = await generateExpectingThrow(upstream(500, { detail: PHI_DETAIL, error_code: 'SOME_INTERNAL_TEXT_CODE' }));
    expect(thrown.getStatus()).toBe(500);
    expect(thrown.getResponse()).toEqual({ detail: 'TEXT service unavailable' });
  });
});

describe('TEXT proxy — the assembled-prompt sibling behaves identically', () => {
  it('relays a vendor 429 from generate/assembled too', async () => {
    const { ctrl, res } = build(upstream(429, { error_code: 'RATE_LIMITED' }, { 'retry-after': '4' }));
    // Prompt assembly has its own fixtures and its own suites; this test is
    // about what happens to the upstream failure AFTER the POST, so the
    // assembly step is stubbed rather than reconstructed.
    (ctrl as any).assemblePrompt = vi.fn(async () => ({ prompt: 'p', systemPrompt: 's', resolvedMeta: {} }));

    await expect(
      ctrl.generateAssembled({ type: 'summary', context_item_ids: ['ci-1'], model: 'medgemma-27b', stream: false } as any, res),
    ).rejects.toBeInstanceOf(HttpException);

    expect(headerValue(res, 'Retry-After')).toBe('4');
  });
});
