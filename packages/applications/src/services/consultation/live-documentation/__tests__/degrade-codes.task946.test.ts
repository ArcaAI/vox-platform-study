/**
 * TASK-946 D6(a) — a degrade REASON is a code, never a transport string.
 *
 * ## The defect
 *
 * `degradeReason()` answered `error.name`, so the clinician's live feed and the admin snapshot
 * carried `AxiosError` — a fact about the HTTP client, not about the consultation — and the
 * section-patch envelope carried the whole message
 * (`degraded: Request failed with status code 502`). Neither tells a reader what went wrong, and
 * a message is the one field that can carry clinical text onto a surface that is meant to be
 * PHI-safe by construction.
 *
 * The vocabulary is CLOSED. Four codes are shared by every surface that classifies a failure;
 * the fifth is each surface's own terminal fallback, because a failed flush is not a failed
 * pre-summary and naming it one would be a lie.
 */
import { describe, expect, it } from 'vitest';
import { LIVE_DEGRADE_FALLBACK, PRE_SUMMARY_DEGRADE_FALLBACK, degradeCode } from '../degrade-codes';

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

describe('TASK-946 D6 — degradeCode', () => {
  it('never returns an error NAME or a transport message', () => {
    expect(degradeCode(new HttpError('Request failed with status code 502', undefined, { status: 502 }), LIVE_DEGRADE_FALLBACK)).toBe('text_unavailable');
    expect(degradeCode(new Error('some unrecognised failure'), LIVE_DEGRADE_FALLBACK)).toBe(LIVE_DEGRADE_FALLBACK);
    expect(degradeCode(new Error('some unrecognised failure'), PRE_SUMMARY_DEGRADE_FALLBACK)).toBe(PRE_SUMMARY_DEGRADE_FALLBACK);
  });

  it('classifies the ordinary pre-summary case separately from a fault', () => {
    expect(degradeCode(new Error('no case notes for this consultation'), PRE_SUMMARY_DEGRADE_FALLBACK)).toBe('no_case_notes');
  });

  it('classifies a context overflow from the upstream CODE or from the wording', () => {
    expect(degradeCode(new HttpError('Request failed with status code 422', undefined, { status: 422, data: { code: 'CONTEXT_WINDOW_EXCEEDED' } }), LIVE_DEGRADE_FALLBACK)).toBe(
      'context_overflow',
    );
    expect(degradeCode(new Error('the prompt exceeds the model context window'), LIVE_DEGRADE_FALLBACK)).toBe('context_overflow');
    expect(degradeCode(new Error('input is too long for this model: 12000 > 8192 tokens'), LIVE_DEGRADE_FALLBACK)).toBe('context_overflow');
  });

  it('classifies a timeout, including the executor`s own per-node budget reason', () => {
    expect(degradeCode(new Error('timeout of 60000ms exceeded'), LIVE_DEGRADE_FALLBACK)).toBe('timeout');
    expect(degradeCode(new HttpError('aborted', 'ECONNABORTED'), LIVE_DEGRADE_FALLBACK)).toBe('timeout');
    expect(degradeCode('budget_exceeded_20000ms', LIVE_DEGRADE_FALLBACK)).toBe('timeout');
  });

  it('classifies an unreachable or erroring TEXT service', () => {
    expect(degradeCode(new HttpError('connect ECONNREFUSED 10.43.207.213:8862', 'ECONNREFUSED'), LIVE_DEGRADE_FALLBACK)).toBe('text_unavailable');
    expect(degradeCode(new HttpError('Request failed with status code 503', undefined, { status: 503 }), LIVE_DEGRADE_FALLBACK)).toBe('text_unavailable');
  });

  it('passes an existing reason CODE through unchanged — the executor already speaks codes', () => {
    for (const code of ['unsupported_node_type', 'disabled_by_config', 'superseded_after_completion', 'empty_pre_summary', 'prompt_variable_unresolved']) {
      expect(degradeCode(code, LIVE_DEGRADE_FALLBACK)).toBe(code);
    }
  });

  it('never lets clinical text through as a reason', () => {
    // A message carrying free text is classified or replaced, never echoed.
    const reason = degradeCode(new Error('model refused: patient Ada Byron reports chest pain'), LIVE_DEGRADE_FALLBACK);
    expect(reason).toBe(LIVE_DEGRADE_FALLBACK);
    expect(reason).not.toContain('Ada');
  });
});
