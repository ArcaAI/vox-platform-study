/**
 * TASK-946 D6(a) — the warm start reports a CODE, never `error.name`.
 *
 * `LivePreSummaryResult.reason` is published on the clinician's live feed (`PreSummaryEventDto`),
 * so `AxiosError` was both useless and the wrong KIND of value: a name is a fact about the HTTP
 * client, and the message it came from can carry a model's refusal text verbatim.
 */
import { describe, expect, it, vi } from 'vitest';
import { LivePreSummaryAdapter } from '../live-pre-summary.adapter';

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

const INPUT = { consultationId: 'consultation-946', tenantId: 'tenant-946', userId: 'user-1', agentSlug: 'case-notes-pre-summary' };

function adapterThatThrows(error: unknown) {
  const summaryService = { generatePreSummary: vi.fn(async () => Promise.reject(error)) };
  return new LivePreSummaryAdapter(summaryService as never, undefined);
}

describe('TASK-946 D6 — the warm start`s degrade reason is a code', () => {
  it.each([
    ['a first-ever visit', new Error('no case notes found for consultation'), 'no_case_notes'],
    ['an overflowing prompt', new HttpError('bad request', undefined, { status: 422, data: { code: 'CONTEXT_WINDOW_EXCEEDED' } }), 'context_overflow'],
    ['an unreachable TEXT', new HttpError('connect ECONNREFUSED 10.43.207.213:8862', 'ECONNREFUSED'), 'text_unavailable'],
    ['a 502 from TEXT', new HttpError('Request failed with status code 502', undefined, { status: 502 }), 'text_unavailable'],
    ['a timeout', new HttpError('timeout of 60000ms exceeded', 'ECONNABORTED'), 'timeout'],
    ['anything else', new HttpError('Request failed with status code 418'), 'pre_summary_failed'],
  ])('%s → %s', async (_label, error, expected) => {
    await expect(adapterThatThrows(error).run(INPUT)).resolves.toEqual({ status: 'degraded', reason: expected });
  });

  it('never reports the error NAME — the pre-946 behaviour', async () => {
    const result = await adapterThatThrows(new HttpError('Request failed with status code 502', undefined, { status: 502 })).run(INPUT);
    expect(result.reason).not.toBe('AxiosError');
  });

  it('an empty generation is still its own code, not a failure', async () => {
    const summaryService = { generatePreSummary: vi.fn(async () => ({ content: '   ' })) };
    const adapter = new LivePreSummaryAdapter(summaryService as never, undefined);

    await expect(adapter.run(INPUT)).resolves.toEqual({ status: 'degraded', reason: 'empty_pre_summary' });
  });
});
