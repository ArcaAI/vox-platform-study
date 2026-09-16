/**
 * TASK-982 §3.4.5 — the warm-start pre-summary's bounded retry.
 *
 * `LivePreSummaryAdapter.run` used to call `generatePreSummary` exactly once and degrade on ANY
 * failure, including a transient `text_unavailable` (the TEXT service unreachable or answering
 * 5xx). These tests pin the new behaviour: ONE bounded retry, governed by the
 * `consultation.preSummary.retry.attempts` setting (default 1 extra attempt), applied ONLY to the
 * `text_unavailable` class — never to a schema/validation-shaped failure.
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

const TRANSIENT_ERROR = new HttpError('Request failed with status code 502', undefined, { status: 502 });
const VALIDATION_ERROR = new Error('no case notes found for consultation');

const INPUT = { consultationId: 'consultation-982', tenantId: 'tenant-982', userId: 'user-1', agentSlug: 'case-notes-pre-summary' };

function effectiveSettingsStub(value: number | undefined) {
  return {
    resolveEffective: vi.fn(async () =>
      value === undefined
        ? { key: 'consultation.preSummary.retry.attempts', tier: 'global-kv', value: 1, sourceScope: 'code-default' }
        : { key: 'consultation.preSummary.retry.attempts', tier: 'global-kv', value, sourceScope: 'global' },
    ),
  };
}

describe('TASK-982 — LivePreSummaryAdapter bounded retry', () => {
  it('retries a transient (text_unavailable) failure and succeeds on the second attempt', async () => {
    const generatePreSummary = vi
      .fn()
      .mockRejectedValueOnce(TRANSIENT_ERROR)
      .mockResolvedValueOnce({ content: 'a recovered pre-summary' });
    const adapter = new LivePreSummaryAdapter({ generatePreSummary } as never, undefined, effectiveSettingsStub(undefined) as never);

    await expect(adapter.run(INPUT)).resolves.toEqual({ status: 'ready', content: 'a recovered pre-summary' });
    expect(generatePreSummary).toHaveBeenCalledTimes(2);
  });

  it('exhausts the configured attempts and degrades with the same reason, default = 1 extra attempt', async () => {
    const generatePreSummary = vi.fn().mockRejectedValue(TRANSIENT_ERROR);
    const adapter = new LivePreSummaryAdapter({ generatePreSummary } as never, undefined, effectiveSettingsStub(undefined) as never);

    await expect(adapter.run(INPUT)).resolves.toEqual({ status: 'degraded', reason: 'text_unavailable' });
    // 1 (original) + 1 (default retry) = 2 total calls.
    expect(generatePreSummary).toHaveBeenCalledTimes(2);
  });

  it('a stored value of 2 extra attempts means 3 total calls', async () => {
    const generatePreSummary = vi.fn().mockRejectedValue(TRANSIENT_ERROR);
    const adapter = new LivePreSummaryAdapter({ generatePreSummary } as never, undefined, effectiveSettingsStub(2) as never);

    await expect(adapter.run(INPUT)).resolves.toEqual({ status: 'degraded', reason: 'text_unavailable' });
    expect(generatePreSummary).toHaveBeenCalledTimes(3);
  });

  it('a stored value of 0 means no retry at all — the pre-946 single-attempt behaviour', async () => {
    const generatePreSummary = vi.fn().mockRejectedValue(TRANSIENT_ERROR);
    const adapter = new LivePreSummaryAdapter({ generatePreSummary } as never, undefined, effectiveSettingsStub(0) as never);

    await expect(adapter.run(INPUT)).resolves.toEqual({ status: 'degraded', reason: 'text_unavailable' });
    expect(generatePreSummary).toHaveBeenCalledTimes(1);
  });

  it('never retries a non-transient (schema/validation-shaped) failure, even with attempts configured', async () => {
    const generatePreSummary = vi.fn().mockRejectedValue(VALIDATION_ERROR);
    const adapter = new LivePreSummaryAdapter({ generatePreSummary } as never, undefined, effectiveSettingsStub(2) as never);

    await expect(adapter.run(INPUT)).resolves.toEqual({ status: 'degraded', reason: 'no_case_notes' });
    expect(generatePreSummary).toHaveBeenCalledTimes(1);
  });

  it('falls back to the code default (1 extra attempt) when no EffectiveSettingsService is wired', async () => {
    const generatePreSummary = vi.fn().mockRejectedValue(TRANSIENT_ERROR);
    const adapter = new LivePreSummaryAdapter({ generatePreSummary } as never, undefined, undefined);

    await expect(adapter.run(INPUT)).resolves.toEqual({ status: 'degraded', reason: 'text_unavailable' });
    expect(generatePreSummary).toHaveBeenCalledTimes(2);
  });

  it('falls back to the code default when the settings read itself throws — never fails the pre-summary over it', async () => {
    const generatePreSummary = vi.fn().mockRejectedValue(TRANSIENT_ERROR);
    const effectiveSettings = { resolveEffective: vi.fn().mockRejectedValue(new Error('redis down')) };
    const adapter = new LivePreSummaryAdapter({ generatePreSummary } as never, undefined, effectiveSettings as never);

    await expect(adapter.run(INPUT)).resolves.toEqual({ status: 'degraded', reason: 'text_unavailable' });
    expect(generatePreSummary).toHaveBeenCalledTimes(2);
  });
});
