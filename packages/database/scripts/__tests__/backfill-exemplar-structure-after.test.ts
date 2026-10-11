// Unit tests for scripts/backfill-exemplar-structure-after.ts (TASK-1062 D-3).
// The live Postgres round-trip is the orchestrator's run; here the plan/apply logic runs against an
// in-memory fake client — NO live DB.
import { beforeEach, describe, expect, it } from 'vitest';

import { toStructureOnlyExemplar } from '../../../applications/src/services/gate-edit-mining/exemplar-structure';
import { applyBackfill, type BackfillClient, parseArgs, planBackfill } from '../backfill-exemplar-structure-after';

interface Row {
  id: string;
  tenantId: string;
  redactedAfter: string | null;
  structureAfter: string | null;
  updatedBy?: string | null;
}

const NOTE_A = 'Plan:\n- Increase metformin 500 mg to 1000 mg twice daily.';
const NOTE_B = 'Assessment:\nStable angina, BP 150/90.';

/** A fake `gateEditExemplar` delegate honouring exactly the predicates the script uses. */
function fakeClient(rows: Row[]) {
  const calls = { findMany: [] as unknown[], updateMany: [] as unknown[] };
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, cond]) => {
      const value = row[key as keyof Row];
      if (cond === null) return value === null;
      if (cond && typeof cond === 'object' && 'not' in cond) return value !== (cond as { not: unknown }).not;
      return value === cond;
    });
  const client: BackfillClient = {
    gateEditExemplar: {
      async findMany(args) {
        calls.findMany.push(args);
        const { where } = args as { where: Record<string, unknown> };
        return rows.filter((row) => matches(row, where)).map(({ id, tenantId, redactedAfter }) => ({ id, tenantId, redactedAfter }));
      },
      async updateMany(args) {
        calls.updateMany.push(args);
        const { where, data } = args as { where: Record<string, unknown>; data: Partial<Row> };
        const hit = rows.filter((row) => matches(row, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
  };
  return { client, calls };
}

describe('parseArgs', () => {
  it('defaults to a dry run over every tenant', () => {
    expect(parseArgs([])).toEqual({ apply: false, tenantId: null });
  });

  it('--dry-run is explicit and wins over nothing; --apply turns writes on; --tenant scopes', () => {
    expect(parseArgs(['--dry-run'])).toEqual({ apply: false, tenantId: null });
    expect(parseArgs(['--apply', '--tenant', 't-1'])).toEqual({ apply: true, tenantId: 't-1' });
  });
});

describe('planBackfill', () => {
  let rows: Row[];

  beforeEach(() => {
    rows = [
      { id: 'a', tenantId: 't-1', redactedAfter: NOTE_A, structureAfter: null },
      { id: 'b', tenantId: 't-2', redactedAfter: NOTE_B, structureAfter: null },
      { id: 'c', tenantId: 't-1', redactedAfter: null, structureAfter: null },
      { id: 'd', tenantId: 't-1', redactedAfter: NOTE_A, structureAfter: 'already' },
    ];
  });

  it('selects rows with a redactedAfter and no structureAfter, and computes the skeleton', async () => {
    const { client, calls } = fakeClient(rows);

    const plan = await planBackfill(client, { apply: false, tenantId: null });

    expect(calls.findMany[0]).toEqual(expect.objectContaining({ where: { structureAfter: null, redactedAfter: { not: null } } }));
    expect(plan).toEqual([
      { id: 'a', tenantId: 't-1', structureAfter: toStructureOnlyExemplar(NOTE_A) },
      { id: 'b', tenantId: 't-2', structureAfter: toStructureOnlyExemplar(NOTE_B) },
    ]);
    expect(JSON.stringify(plan)).not.toMatch(/metformin|500|1000|angina|150/);
  });

  it('scopes to one tenant when asked', async () => {
    const { client } = fakeClient(rows);

    const plan = await planBackfill(client, { apply: false, tenantId: 't-2' });

    expect(plan.map((row) => row.id)).toEqual(['b']);
  });

  it('a dry run (plan only) writes nothing', async () => {
    const { client, calls } = fakeClient(rows);

    await planBackfill(client, { apply: false, tenantId: null });

    expect(calls.updateMany).toHaveLength(0);
    expect(rows.find((row) => row.id === 'a')?.structureAfter).toBeNull();
  });
});

describe('applyBackfill', () => {
  it('writes structureAfter, never touches redactedAfter, and is idempotent', async () => {
    const rows: Row[] = [
      { id: 'a', tenantId: 't-1', redactedAfter: NOTE_A, structureAfter: null },
      { id: 'b', tenantId: 't-2', redactedAfter: NOTE_B, structureAfter: null },
    ];
    const { client, calls } = fakeClient(rows);

    const first = await applyBackfill(client, await planBackfill(client, { apply: true, tenantId: null }));

    expect(first).toBe(2);
    expect(rows[0]).toEqual(expect.objectContaining({ redactedAfter: NOTE_A, structureAfter: toStructureOnlyExemplar(NOTE_A) }));
    expect(rows[1]).toEqual(expect.objectContaining({ redactedAfter: NOTE_B, structureAfter: toStructureOnlyExemplar(NOTE_B) }));
    // Compare-and-set on the NULL column: a row saved with its own structure in the meantime is left alone.
    expect(calls.updateMany[0]).toEqual(expect.objectContaining({ where: { id: 'a', structureAfter: null } }));

    const secondPlan = await planBackfill(client, { apply: true, tenantId: null });
    expect(secondPlan).toEqual([]);
    expect(await applyBackfill(client, secondPlan)).toBe(0);
  });

  it('does not overwrite a structureAfter written between plan and apply', async () => {
    const rows: Row[] = [{ id: 'a', tenantId: 't-1', redactedAfter: NOTE_A, structureAfter: null }];
    const { client } = fakeClient(rows);
    const plan = await planBackfill(client, { apply: true, tenantId: null });
    rows[0]!.structureAfter = 'written by a concurrent save';

    expect(await applyBackfill(client, plan)).toBe(0);
    expect(rows[0]!.structureAfter).toBe('written by a concurrent save');
  });
});
