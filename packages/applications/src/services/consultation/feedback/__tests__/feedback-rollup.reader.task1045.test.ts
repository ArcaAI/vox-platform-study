/** Admin read side of the daily feedback rollup: tenant-scoped, grouped, capped, PHI-free. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackRollupReadService, FEEDBACK_ROLLUP_MAX_ROWS } from '../feedback-rollup.reader';

const NOW = new Date('2026-10-05T10:00:00Z');

function row(day: string, over: Record<string, unknown> = {}) {
  return {
    day: new Date(`${day}T00:00:00Z`),
    targetKind: 'NOTE',
    agentSlug: 'soap',
    agentVersion: 3,
    modelName: 'm1',
    promptVersion: 'p1',
    sectionKey: '',
    entityLabel: '',
    reasonCode: '',
    upCount: 1,
    downCount: 0,
    clearedCount: 0,
    commentCount: 0,
    correctionCount: 0,
    reasonedCount: 0,
    ...over,
  };
}

describe('FeedbackRollupReadService', () => {
  const repo = { findForReport: vi.fn() };
  const cls = { get: vi.fn((k: string) => (k === 'tenantId' ? 'tenant-1' : undefined)) };
  const make = () => new FeedbackRollupReadService(repo as never, cls as never);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    repo.findForReport.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('groups by two dimensions and sums counters', async () => {
    repo.findForReport.mockResolvedValue([
      row('2026-10-01', { upCount: 2, downCount: 1, commentCount: 1 }),
      row('2026-10-01', { targetKind: 'SECTION', upCount: 3, reasonedCount: 2 }),
      row('2026-10-02', { upCount: 5, clearedCount: 1, correctionCount: 1 }),
    ]);
    const res = await make().query({ groupBy: ['day', 'model'] });
    expect(res.truncated).toBe(false);
    expect(res.rows).toEqual([
      { dimensions: { day: '2026-10-01', model: 'm1' }, up: 5, down: 1, cleared: 0, comments: 1, corrections: 0, reasoned: 2 },
      { dimensions: { day: '2026-10-02', model: 'm1' }, up: 5, down: 0, cleared: 1, comments: 0, corrections: 1, reasoned: 0 },
    ]);
  });

  it('maps unset dimension values to null and collapses with no groupBy', async () => {
    repo.findForReport.mockResolvedValue([row('2026-10-01'), row('2026-10-02', { upCount: 4 })]);
    const res = await make().query({ groupBy: ['section'] });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].dimensions).toEqual({ section: null });
    expect(res.rows[0].up).toBe(5);
    const all = await make().query({ groupBy: [] });
    expect(all.rows).toHaveLength(1);
    expect(all.rows[0].dimensions).toEqual({});
  });

  it('scopes to the CLS tenant and passes the filters', async () => {
    repo.findForReport.mockResolvedValue([]);
    await make().query({ from: '2026-09-01', to: '2026-09-30', groupBy: [], agentSlug: 'soap', modelName: 'm1' });
    expect(repo.findForReport).toHaveBeenCalledWith(
      'tenant-1',
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-30T00:00:00Z'),
      { agentSlug: 'soap', modelName: 'm1' },
      expect.any(Number),
    );
  });

  it('defaults the range to the last 30 days (UTC dates)', async () => {
    repo.findForReport.mockResolvedValue([]);
    await make().query({ groupBy: [] });
    const [, from, to] = repo.findForReport.mock.calls[0];
    expect(to).toEqual(new Date('2026-10-05T00:00:00Z'));
    expect(from).toEqual(new Date('2026-09-05T00:00:00Z'));
  });

  it('refuses a request with no tenant context', async () => {
    cls.get.mockReturnValueOnce(undefined);
    await expect(make().query({ groupBy: [] })).rejects.toThrow();
    expect(repo.findForReport).not.toHaveBeenCalled();
  });

  it('caps the output and flags truncation', async () => {
    const rows = Array.from({ length: FEEDBACK_ROLLUP_MAX_ROWS + 5 }, (_, i) => row('2026-10-01', { promptVersion: `p${i}` }));
    repo.findForReport.mockResolvedValue(rows);
    const res = await make().query({ groupBy: ['promptVersion'] });
    expect(res.rows).toHaveLength(FEEDBACK_ROLLUP_MAX_ROWS);
    expect(res.truncated).toBe(true);
  });
});
