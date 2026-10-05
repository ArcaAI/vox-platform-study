/**
 * TASK-1038 E2 (fix 6) — the claim-check GB-day meter counts a delivered run result in BOTH shapes.
 *
 * The legacy deliver-node shape keeps its bytes at `resultRef.resultRef.size`; the D-I producer
 * shape (`{ kind: 'ref', bucket, key, sizeBytes, sha256 }`, protocol v2 `run.completed.result`)
 * keeps them at `resultRef.sizeBytes`. The WorkflowRun aggregate used to sum only the first, so
 * every claim-checked v2 result sat in the bucket unmetered. One aggregate still runs per table
 * (so a row can never be counted twice), and only a numeric `sizeBytes` of a `kind = 'ref'` row
 * is read (inline values and `expired` tombstones carry no bucket bytes).
 */
import { describe, expect, it, vi } from 'vitest';
import { StorageSnapshotService } from '../storage-snapshot.service';

function statements(): Promise<string[]> {
  const queryRaw = vi.fn(async (_sql: string) => [] as unknown[]);
  const baseClient = {
    $queryRawUnsafe: queryRaw,
    media: { groupBy: vi.fn().mockResolvedValue([]) },
    tenantStorageConfig: { findMany: vi.fn().mockResolvedValue([]) },
    tenant: { findMany: vi.fn().mockResolvedValue([{ id: 't1' }]) },
  };
  const appSettings = { getValueWithDefault: vi.fn((_key: string, fallback: unknown) => fallback) } as never;
  const schedulerRegistry = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() } as never;
  const service = new StorageSnapshotService(appSettings, schedulerRegistry, { baseClient } as never, { recordUsage: vi.fn() } as never);
  return service.snapshotTenant('t1', new Date('2026-10-05T08:00:00.000Z')).then(() => queryRaw.mock.calls.map((call) => call[0]));
}

describe('WorkflowRun claim-check bytes', () => {
  it('ONE aggregate over WorkflowRun reads both the legacy size and the v2 ref sizeBytes', async () => {
    const runs = (await statements()).filter((sql) => sql.includes('"core"."WorkflowRun"'));
    expect(runs).toHaveLength(1);
    const sql = runs[0];
    expect(sql).toContain(`"resultRef"->'resultRef'->>'size'`);
    expect(sql).toContain(`"resultRef"->>'sizeBytes'`);
    // Only a `{ kind: 'ref' }` row's sizeBytes is bucket bytes, and only when it is numeric.
    expect(sql).toContain(`"resultRef"->>'kind' = 'ref'`);
    expect(sql).toContain(`jsonb_typeof("resultRef"->'sizeBytes') = 'number'`);
  });
});
