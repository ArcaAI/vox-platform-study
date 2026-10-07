/**
 * TASK-1050 W2h — the cross-tenant monitoring reads on `GuardrailEvaluationRepository` (README §11.3 E, §9.8.2).
 *
 * Raw SQL (`$queryRaw`) because the aggregates group across tenants and unnest the `checks` JSON array, which
 * neither the generated finders nor the tenant-scoped extension can express. Every dimension is a BOUND
 * parameter. These tests assert the bound values, the tenant narrowing, and the bigint → number mapping; the
 * SQL itself is exercised against a live DB by the orchestrator's integration gate.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

async function repoWith(rows: unknown[] | ((sql: { strings: string[]; values: unknown[] }) => unknown[])) {
  const { GuardrailEvaluationRepository } = await import('../GuardrailEvaluationRepository');
  const queryRaw = vi.fn(async (sql: { strings: string[]; values: unknown[] }) => (typeof rows === 'function' ? rows(sql) : rows));
  const repo = new GuardrailEvaluationRepository({ getDatabaseService: () => ({ $queryRaw: queryRaw, guardrailEvaluation: {} }) } as never);
  return { repo, queryRaw };
}

const sqlText = (call: unknown[]) => ((call[0] as { strings: string[] }).strings ?? []).join('?');
const sqlValues = (call: unknown[]) => (call[0] as { values: unknown[] }).values;

const WINDOW = { from: new Date('2026-10-06T00:00:00Z'), to: new Date('2026-10-07T00:00:00Z') };

describe('decision series', () => {
  it('buckets by date_bin and maps the enum spellings to the wire vocabulary', async () => {
    const { repo, queryRaw } = await repoWith([{ bucketStart: new Date('2026-10-06T01:00:00Z'), direction: 'INBOUND', decision: 'WARN', count: 3n }]);
    const rows = await repo.aggregateDecisionSeries({ ...WINDOW, bucketSeconds: 3600 });
    expect(rows).toEqual([{ bucketStart: new Date('2026-10-06T01:00:00Z'), direction: 'inbound', decision: 'warn', count: 3 }]);
    expect(sqlText(queryRaw.mock.calls[0])).toContain('date_bin');
    expect(sqlValues(queryRaw.mock.calls[0])).toEqual(expect.arrayContaining(['3600 seconds', WINDOW.from, WINDOW.to]));
  });

  it('narrows to one tenant only when asked', async () => {
    const { repo, queryRaw } = await repoWith([]);
    await repo.aggregateDecisionSeries({ ...WINDOW, bucketSeconds: 300 });
    expect(sqlValues(queryRaw.mock.calls[0])).not.toContain('t-1');
    await repo.aggregateDecisionSeries({ ...WINDOW, bucketSeconds: 300, tenantId: 't-1' });
    expect(sqlValues(queryRaw.mock.calls[1])).toContain('t-1');
  });
});

describe('per-check, per-category, per-tenant, per-model aggregates (unnesting checks, no content)', () => {
  it('per-check counts', async () => {
    const { repo, queryRaw } = await repoWith([{ checkId: 'injection_judge', direction: 'INBOUND', verdict: 'flag', actionTaken: 'warn', count: 2n }]);
    expect(await repo.aggregateChecks(WINDOW)).toEqual([{ checkId: 'injection_judge', direction: 'inbound', verdict: 'flag', actionTaken: 'warn', count: 2 }]);
    expect(sqlText(queryRaw.mock.calls[0])).toContain('jsonb_array_elements');
  });

  it('top categories, bounded by a bound limit', async () => {
    const { repo, queryRaw } = await repoWith([{ checkId: 'unsafe_content_judge', category: 'violence', count: 5n }]);
    expect(await repo.topCategories(WINDOW, 10)).toEqual([{ checkId: 'unsafe_content_judge', category: 'violence', count: 5 }]);
    expect(sqlValues(queryRaw.mock.calls[0])).toContain(10);
  });

  it('per tenant', async () => {
    const { repo } = await repoWith([{ tenantId: 't-1', evaluations: 10n, warn: 2n, block: 1n, unverified: 0n }]);
    expect(await repo.aggregateByTenant(WINDOW, 50)).toEqual([{ tenantId: 't-1', evaluations: 10, warn: 2, block: 1, unverified: 0 }]);
  });

  it('per model, with a null average when no check ran', async () => {
    const { repo } = await repoWith([
      { model: 'granite', checkId: 'medical_validation', calls: 4n, flags: 1n, undetermined: 0n, avgLatencyMs: '812.5' },
      { model: 'qwen', checkId: 'injection_judge', calls: 0n, flags: 0n, undetermined: 0n, avgLatencyMs: null },
    ]);
    expect(await repo.aggregateByModel(WINDOW)).toEqual([
      { model: 'granite', checkId: 'medical_validation', calls: 4, flags: 1, undetermined: 0, avgLatencyMs: 812.5 },
      { model: 'qwen', checkId: 'injection_judge', calls: 0, flags: 0, undetermined: 0, avgLatencyMs: null },
    ]);
  });

  it('overrides = notices resolved `acknowledged` in the window', async () => {
    const { repo, queryRaw } = await repoWith([{ count: 7n }]);
    expect(await repo.countOverrides(WINDOW)).toBe(7);
    expect(sqlText(queryRaw.mock.calls[0])).toContain('GuardrailNotice');
    expect(sqlValues(queryRaw.mock.calls[0])).toContain('acknowledged');
  });
});

describe('health reads', () => {
  it('latest evaluation time, or null on an empty table', async () => {
    expect(await (await repoWith([{ at: new Date('2026-10-07T00:00:00Z') }])).repo.latestEvaluationAt()).toEqual(new Date('2026-10-07T00:00:00Z'));
    expect(await (await repoWith([{ at: null }])).repo.latestEvaluationAt()).toBeNull();
  });

  it('undetermined share of checks since a moment, null with no checks', async () => {
    expect(await (await repoWith([{ total: 8n, undetermined: 2n }])).repo.undeterminedShare(WINDOW.from)).toBe(0.25);
    expect(await (await repoWith([{ total: 0n, undetermined: 0n }])).repo.undeterminedShare(WINDOW.from)).toBeNull();
  });
});

describe('drill-down list (keyset, no content)', () => {
  const row = (id: string, at: string) => ({
    id,
    tenantId: 't-1',
    at: new Date(at),
    direction: 'OUTBOUND',
    decision: 'BLOCK',
    caller: 'text.generate',
    consultationId: 'c-1',
    runId: null,
    nodeId: null,
    agentSlug: null,
    exempt: null,
    policyVersion: 'pv',
    noticeIds: ['n-1'],
    checks: [{ checkId: 'leakage_judge', verdict: 'flag' }],
    hasWithheldContent: true,
  });

  it('never selects the withheld ciphertext, only whether there is one', async () => {
    const { repo, queryRaw } = await repoWith([]);
    await repo.listForDrilldown({ ...WINDOW, limit: 10 });
    const text = sqlText(queryRaw.mock.calls[0]);
    expect(text).toContain('IS NOT NULL');
    expect(text).not.toMatch(/"encryptedWithheldContent"\s*(,|AS)/);
  });

  it('asks for limit + 1 and reports hasMore with the last row as the cursor', async () => {
    const { repo, queryRaw } = await repoWith([row('e-3', '2026-10-06T03:00:00Z'), row('e-2', '2026-10-06T02:00:00Z'), row('e-1', '2026-10-06T01:00:00Z')]);
    const page = await repo.listForDrilldown({ ...WINDOW, limit: 2 });
    expect(sqlValues(queryRaw.mock.calls[0])).toContain(3);
    expect(page.items.map((i) => i.id)).toEqual(['e-3', 'e-2']);
    expect(page.items[0]).toMatchObject({ direction: 'outbound', decision: 'block', hasWithheldContent: true });
    expect(page.hasMore).toBe(true);
    expect(page.last).toEqual({ at: new Date('2026-10-06T02:00:00Z'), id: 'e-2' });
  });

  it('binds every filter, including the keyset position', async () => {
    const { repo, queryRaw } = await repoWith([]);
    await repo.listForDrilldown({ ...WINDOW, limit: 5, tenantId: 't-1', decision: 'warn', direction: 'inbound', checkId: 'pii_leak', consultationId: 'c-9', after: { at: WINDOW.to, id: 'e-9' } });
    const values = sqlValues(queryRaw.mock.calls[0]);
    expect(values).toEqual(expect.arrayContaining(['t-1', 'WARN', 'INBOUND', 'c-9', 'e-9']));
    expect(values.some((v) => typeof v === 'string' && v.includes('pii_leak'))).toBe(true);
  });
});

describe('the evaluation-gap reconciler read', () => {
  it('counts reported ids older than the grace with no evaluation row, across trajectory steps and activity runs', async () => {
    const { repo, queryRaw } = await repoWith([{ missing: 4n }]);
    const olderThan = new Date('2026-10-06T23:50:00Z');
    expect(await repo.countMissingReportedEvaluations(olderThan, WINDOW.from)).toBe(4);
    const text = sqlText(queryRaw.mock.calls[0]);
    expect(text).toContain('AgentTrajectoryStep');
    expect(text).toContain('AiActivityRun');
    expect(text).toContain('guardrailEvaluationIds');
    expect(sqlValues(queryRaw.mock.calls[0])).toEqual(expect.arrayContaining([olderThan, WINDOW.from]));
  });
});
