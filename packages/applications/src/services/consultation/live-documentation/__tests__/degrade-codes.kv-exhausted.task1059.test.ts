/**
 * TASK-1059 RC-6 — `kv_exhausted` is not `context_overflow`.
 *
 * ## The defect
 *
 * LM Studio loaded gemma with `n_ctx 32768, kv_unified, n_slots 10`: the ten decode slots SHARE one
 * 32 k KV cache. Several concurrent generations exhausted it, and LM Studio answered every one of them
 * "Context size has been exceeded", which TEXT surfaces as `CONTEXT_WINDOW_EXCEEDED`. The live lane
 * reported `context_overflow` — "your prompt does not fit, send less" — for a 1 803-token pre-summary
 * prompt. The prompt was never the problem; the shared cache was. The remedy is the opposite one
 * (fewer slots / a bigger cache), so the two need two codes.
 *
 * ## The rule pinned here
 *
 *  - prompt tokens KNOWN and below the configured context → `kv_exhausted`;
 *  - only the prompt's CHARACTER count known (an upper bound on its tokens) → `kv_exhausted` when it is
 *    under 50 % of the configured context, `context_overflow` otherwise;
 *  - no configured context known → `context_overflow`, exactly as before (no hint = no behaviour change).
 */
import { describe, expect, it } from 'vitest';
import { LIVE_DEGRADE_CODES, LIVE_DEGRADE_FALLBACK, LIVE_DEGRADE_KV_EXHAUSTED, PRE_SUMMARY_DEGRADE_FALLBACK, degradeCode } from '../degrade-codes';

class HttpError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly response?: { status?: number; data?: unknown },
  ) {
    super(message);
    this.name = 'AxiosError';
  }
}

const contextExceeded = () =>
  new HttpError('Request failed with status code 422', 'ERR_BAD_REQUEST', {
    status: 422,
    data: { detail: { error: 'Context size has been exceeded.', code: 'CONTEXT_WINDOW_EXCEEDED' } },
  });

describe('TASK-1059 RC-6 — degradeCode separates KV exhaustion from a prompt overflow', () => {
  it('is part of the closed vocabulary', () => {
    expect(LIVE_DEGRADE_KV_EXHAUSTED).toBe('kv_exhausted');
    expect(LIVE_DEGRADE_CODES).toContain('kv_exhausted');
  });

  it('a KNOWN prompt size below the configured context is a shared-KV exhaustion', () => {
    expect(degradeCode(contextExceeded(), PRE_SUMMARY_DEGRADE_FALLBACK, { promptTokens: 1803, contextTokens: 32768 })).toBe('kv_exhausted');
  });

  it('a KNOWN prompt size at or above the context is still a real overflow', () => {
    expect(degradeCode(contextExceeded(), LIVE_DEGRADE_FALLBACK, { promptTokens: 40000, contextTokens: 32768 })).toBe('context_overflow');
  });

  it('with only the character count, under 50 % of the context is kv_exhausted, at or over is context_overflow', () => {
    expect(degradeCode(contextExceeded(), LIVE_DEGRADE_FALLBACK, { promptChars: 7000, contextTokens: 32768 })).toBe('kv_exhausted');
    expect(degradeCode(contextExceeded(), LIVE_DEGRADE_FALLBACK, { promptChars: 16384, contextTokens: 32768 })).toBe('context_overflow');
    expect(degradeCode(contextExceeded(), LIVE_DEGRADE_FALLBACK, { promptChars: 60000, contextTokens: 32768 })).toBe('context_overflow');
  });

  it('without a configured context the classification is unchanged', () => {
    expect(degradeCode(contextExceeded(), LIVE_DEGRADE_FALLBACK)).toBe('context_overflow');
    expect(degradeCode(contextExceeded(), LIVE_DEGRADE_FALLBACK, { promptChars: 100 })).toBe('context_overflow');
  });

  it('a hint never turns a non-context failure into kv_exhausted', () => {
    const outage = new HttpError('Request failed with status code 503', undefined, { status: 503 });
    expect(degradeCode(outage, LIVE_DEGRADE_FALLBACK, { promptTokens: 10, contextTokens: 32768 })).toBe('text_unavailable');
  });
});

/**
 * TASK-1059 C-0 — the context judge's fail-closed error degrades the way a guardrail outage already
 * did on this lane. TEXT's 503 `GUARDRAIL_UNAVAILABLE` classified as `text_unavailable` (it is a
 * 5xx); the gateway-side judge throws `ContextJudgeUnavailableError` (`code: GUARDRAIL_UNAVAILABLE`,
 * no HTTP status), which must land on the same code rather than the terminal fallback.
 */
describe('TASK-1059 C-0 — a judge outage degrades like the guardrail outage it replaces', () => {
  it('classifies the GUARDRAIL_UNAVAILABLE code as text_unavailable', () => {
    const error = Object.assign(new Error('context medical judge unavailable'), { code: 'GUARDRAIL_UNAVAILABLE' });
    expect(degradeCode(error, LIVE_DEGRADE_FALLBACK)).toBe('text_unavailable');
  });

  it('classifies the code when only the MESSAGE survives (the graph executor keeps nothing else)', () => {
    expect(degradeCode('GUARDRAIL_UNAVAILABLE: context medical judge unavailable', LIVE_DEGRADE_FALLBACK)).toBe('text_unavailable');
  });
});
