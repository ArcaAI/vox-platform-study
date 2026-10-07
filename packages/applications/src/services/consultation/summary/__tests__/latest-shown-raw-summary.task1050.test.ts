/**
 * TASK-1050 W2e — a WITHHELD placeholder (an outbound-blocked generation, README §9.7.6) is never
 * "the latest note": not signed by approve, not answered as the consultation's summary.
 */
import { describe, expect, it, vi } from 'vitest';
import { latestShownRawSummary } from '../latest-shown-raw-summary';

const row = (id: string, minute: number, guardrailStatus?: string) => ({
  id,
  createdAt: new Date(Date.UTC(2026, 9, 7, 9, minute)),
  ...(guardrailStatus ? { guardrailStatus } : {}),
});

describe('latestShownRawSummary', () => {
  it('answers the latest raw summary when it is not withheld (one read)', async () => {
    const repo = { findLatestRawSummary: vi.fn(async () => row('note-2', 2, 'WARNED')), findByType: vi.fn() };
    expect((await latestShownRawSummary(repo as never, 'c-1'))?.id).toBe('note-2');
    expect(repo.findByType).not.toHaveBeenCalled();
  });

  it('skips a WITHHELD placeholder and answers the newest note that is not withheld', async () => {
    const repo = {
      findLatestRawSummary: vi.fn(async () => row('placeholder', 9, 'WITHHELD')),
      findByType: vi.fn(async () => [row('note-1', 1), row('placeholder', 9, 'WITHHELD'), row('note-2', 5, 'CLEAN')]),
    };
    expect((await latestShownRawSummary(repo as never, 'c-1'))?.id).toBe('note-2');
  });

  it('answers null when the only raw summary is withheld', async () => {
    const repo = { findLatestRawSummary: vi.fn(async () => row('placeholder', 9, 'WITHHELD')), findByType: vi.fn(async () => [row('placeholder', 9, 'WITHHELD')]) };
    expect(await latestShownRawSummary(repo as never, 'c-1')).toBeNull();
  });
});
