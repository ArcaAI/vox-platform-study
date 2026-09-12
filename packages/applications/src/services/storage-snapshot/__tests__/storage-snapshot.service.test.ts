/**
 * StorageSnapshotService — the nightly per-(tenant, storage class) GB-day
 * snapshot (TASK-959 §5.2).
 *
 * What these tests pin is the EMITTED CONTRACT, not the mock plumbing: every
 * field of the ledger row is frozen in §10.2 and read downstream by the
 * rollups, the meters and the invoice engine, so a silent change to any one of
 * them (the idempotency key, the provider, the `occurredAt` that decides which
 * day the row rolls into) is a billing defect rather than a refactor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCapability, AiCostBasis, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';

import { StorageSnapshotService } from '../storage-snapshot.service';

/** Mid-morning on the day being snapshotted — the service truncates to UTC midnight. */
const DAY = new Date('2026-09-12T08:30:00.000Z');
/** The day's LAST MILLISECOND: `truncateToDay(occurredAt)` in the drainer must land on 2026-09-12, not the 13th. */
const DAY_END = new Date('2026-09-12T23:59:59.999Z');

const TEXT_TABLES = ['ContextItem', 'ContextItemVersion', 'DocumentSection', 'NamedEntity', 'Highlight', 'KnowledgeChunk', 'TranscriptionJob'];
const CLAIM_CHECK_TABLES = ['AgentTrajectoryStep', 'WorkflowRun'];

type RawRow = { tenantId: string; bytes: bigint | number | null };

interface Fixture {
  /** table name -> rows that table's aggregate returns */
  raw: Record<string, RawRow[]>;
  media: Array<{ tenantId: string; _sum: { size: number | null } }>;
  dedicated: Array<{ tenantId: string }>;
  tenants: Array<{ id: string }>;
}

function emptyFixture(): Fixture {
  return { raw: {}, media: [], dedicated: [], tenants: [{ id: 't1' }] };
}

function makeService(fixture: Fixture) {
  const queryRaw = vi.fn((sql: string) => {
    const table = [...TEXT_TABLES, ...CLAIM_CHECK_TABLES].find((name) => sql.includes(`"core"."${name}"`));
    return Promise.resolve(table ? (fixture.raw[table] ?? []) : []);
  });

  const baseClient = {
    $queryRawUnsafe: queryRaw,
    media: { groupBy: vi.fn().mockResolvedValue(fixture.media) },
    tenantStorageConfig: { findMany: vi.fn().mockResolvedValue(fixture.dedicated) },
    tenant: { findMany: vi.fn().mockResolvedValue(fixture.tenants) },
  };

  const recordUsage = vi.fn().mockResolvedValue({ outboxIds: ['o1'], events: 1 });
  const appSettings = { getValueWithDefault: vi.fn((_key: string, fallback: unknown) => fallback) } as never;
  const schedulerRegistry = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() } as never;

  const service = new StorageSnapshotService(appSettings, schedulerRegistry, { baseClient } as never, { recordUsage } as never);
  return { service, baseClient, queryRaw, recordUsage };
}

/** Every `UsageEventInput` handed to `recordUsage`, flattened across calls. */
function emitted(recordUsage: ReturnType<typeof vi.fn>) {
  return recordUsage.mock.calls.flatMap((call: [unknown]) => (Array.isArray(call[0]) ? call[0] : [call[0]]));
}

describe('StorageSnapshotService.snapshotTenant — the emitted row contract', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = emptyFixture();
    fixture.media = [{ tenantId: 't1', _sum: { size: 2_500_000_000 } }];
    fixture.raw.ContextItem = [{ tenantId: 't1', bytes: 1_000_000_000n }];
    fixture.raw.AgentTrajectoryStep = [{ tenantId: 't1', bytes: 500_000n }];
  });

  it('emits one row per non-empty class with the frozen ledger contract', async () => {
    const { service, recordUsage } = makeService(fixture);

    const result = await service.snapshotTenant('t1', DAY);

    const rows = emitted(recordUsage);
    expect(rows).toHaveLength(3);
    expect(result.rows.map((r) => r.storageClass).sort()).toEqual(['claim-check', 'media', 'text']);

    for (const row of rows) {
      expect(row.tenantId).toBe('t1');
      expect(row.capability).toBe(AiCapability.STORAGE);
      expect(row.operation).toBe('storage.snapshot');
      expect(row.deployment).toBe(AiDeploymentKind.SELF_HOSTED);
      expect(row.costBasis).toBe(AiCostBasis.INTERNAL);
      expect(row.model).toBeNull();
      expect(row.unit).toBe(AiUsageUnit.STORAGE_GB_DAY);
      // The day's LAST millisecond — not the next midnight, which would roll
      // the snapshot into the following day (and, at a month boundary, the
      // following billing period).
      expect(new Date(row.occurredAt).toISOString()).toBe(DAY_END.toISOString());
    }
  });

  it('carries the storage class on attributesJson, the right provider, and the frozen idempotency key', async () => {
    const { service, recordUsage } = makeService(fixture);

    await service.snapshotTenant('t1', DAY);
    const byClass = Object.fromEntries(emitted(recordUsage).map((row) => [row.attributesJson.storageClass, row]));

    expect(byClass.media.provider).toBe('minio');
    expect(byClass.media.idempotencyKey).toBe('storage:t1:media:2026-09-12');
    expect(byClass.text.provider).toBe('postgres');
    expect(byClass.text.idempotencyKey).toBe('storage:t1:text:2026-09-12');
    expect(byClass['claim-check'].provider).toBe('minio');
    expect(byClass['claim-check'].idempotencyKey).toBe('storage:t1:claim-check:2026-09-12');
    // Nothing but the class rides the attribute bag — it is the PHI-controlled column.
    expect(Object.keys(byClass.media.attributesJson)).toEqual(['storageClass']);
  });

  it('records quantity as a fixed-point GB-day STRING, not a JS number', async () => {
    fixture.media = [{ tenantId: 't1', _sum: { size: 2_500_000_000 } }];
    fixture.raw.ContextItem = [{ tenantId: 't1', bytes: 1_234_567n }];
    const { service, recordUsage } = makeService(fixture);

    await service.snapshotTenant('t1', DAY);
    const byClass = Object.fromEntries(emitted(recordUsage).map((row) => [row.attributesJson.storageClass, row]));

    expect(byClass.media.quantity).toBe('2.500000');
    // 1 234 567 B / 1e9 = 0.001234567 GB, truncated to the column's 6 dp.
    expect(byClass.text.quantity).toBe('0.001235');
    expect(typeof byClass.media.quantity).toBe('string');
  });

  it('skips a class holding zero bytes rather than recording "nothing was stored"', async () => {
    fixture.media = [];
    fixture.raw.ContextItem = [{ tenantId: 't1', bytes: 0n }];
    fixture.raw.AgentTrajectoryStep = [{ tenantId: 't1', bytes: 700_000n }];
    const { service, recordUsage } = makeService(fixture);

    const result = await service.snapshotTenant('t1', DAY);

    expect(result.rows.map((r) => r.storageClass)).toEqual(['claim-check']);
    expect(emitted(recordUsage)).toHaveLength(1);
  });

  it('records nothing at all — and calls recordUsage zero times — when every class is empty', async () => {
    const { service, recordUsage } = makeService(emptyFixture());

    const result = await service.snapshotTenant('t1', DAY);

    expect(result.rows).toEqual([]);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('is idempotent across a re-run: a second pass for the same day emits the SAME keys', async () => {
    const { service, recordUsage } = makeService(fixture);

    await service.snapshotTenant('t1', DAY);
    const first = emitted(recordUsage).map((row) => row.idempotencyKey);
    recordUsage.mockClear();
    // A later instant on the same UTC day — the key must not move.
    await service.snapshotTenant('t1', new Date('2026-09-12T22:05:00.000Z'));
    const second = emitted(recordUsage).map((row) => row.idempotencyKey);

    expect(second).toEqual(first);
  });

  it('skips the media class for a DEDICATED-topology tenant, and only the media class', async () => {
    fixture.dedicated = [{ tenantId: 't1' }];
    const { service, recordUsage } = makeService(fixture);

    const result = await service.snapshotTenant('t1', DAY);

    expect(result.mediaSkippedDedicated).toBe(true);
    const classes = emitted(recordUsage).map((row) => row.attributesJson.storageClass);
    expect(classes).not.toContain('media');
    expect(classes.sort()).toEqual(['claim-check', 'text']);
  });
});

describe('StorageSnapshotService — the SQL it issues', () => {
  it('runs exactly one aggregate per text table, naming all seven', async () => {
    const { service, queryRaw } = makeService(emptyFixture());

    await service.snapshotTenant('t1', DAY);

    const statements = queryRaw.mock.calls.map((call: [string]) => call[0]);
    for (const table of TEXT_TABLES) {
      expect(statements.filter((sql) => sql.includes(`"core"."${table}"`))).toHaveLength(1);
    }
  });

  it('runs one aggregate per claim-check table, over payloadRef.size and resultRef.resultRef.size', async () => {
    const { service, queryRaw } = makeService(emptyFixture());

    await service.snapshotTenant('t1', DAY);
    const statements = queryRaw.mock.calls.map((call: [string]) => call[0]);

    const steps = statements.find((sql) => sql.includes('"core"."AgentTrajectoryStep"'))!;
    expect(steps).toContain(`"payloadRef"->>'size'`);
    const runs = statements.find((sql) => sql.includes('"core"."WorkflowRun"'))!;
    // The column is `resultRef` and it stores the deliver node's output VERBATIM,
    // so the ClaimCheckRef is one level down — and its byte field is `size`.
    expect(runs).toContain(`"resultRef"->'resultRef'->>'size'`);
  });

  it('counts stored bytes with pg_column_size and never sums a NULL column', async () => {
    const { service, queryRaw } = makeService(emptyFixture());

    await service.snapshotTenant('t1', DAY);
    const contextItem = queryRaw.mock.calls.map((call: [string]) => call[0]).find((sql) => sql.includes('"core"."ContextItem"'))!;

    expect(contextItem).toContain('pg_column_size("encryptedContent")');
    expect(contextItem).toContain('IS NULL THEN 0');
    expect(contextItem).toContain('GROUP BY "tenantId"');
  });

  it('excludes soft-deleted media so the snapshot agrees with the live console figure', async () => {
    const { service, baseClient } = makeService(emptyFixture());

    await service.snapshotTenant('t1', DAY);

    const where = baseClient.media.groupBy.mock.calls[0][0].where;
    expect(where.resourceStatus).toEqual({ not: 'DELETED' });
    expect(where.tenantId).toBe('t1');
  });
});

describe('StorageSnapshotService.snapshotAll', () => {
  it('emits for every tenant and reports the row count', async () => {
    const fixture = emptyFixture();
    fixture.tenants = [{ id: 't1' }, { id: 't2' }];
    fixture.media = [
      { tenantId: 't1', _sum: { size: 1_000_000_000 } },
      { tenantId: 't2', _sum: { size: 3_000_000_000 } },
    ];
    fixture.raw.ContextItem = [{ tenantId: 't2', bytes: 2_000_000_000n }];
    const { service, recordUsage } = makeService(fixture);

    const result = await service.snapshotAll(DAY);

    expect(result).toEqual({ tenants: 2, rows: 3 });
    const keys = emitted(recordUsage)
      .map((row) => row.idempotencyKey)
      .sort();
    expect(keys).toEqual(['storage:t1:media:2026-09-12', 'storage:t2:media:2026-09-12', 'storage:t2:text:2026-09-12']);
  });

  it('issues its aggregates ONCE for the whole sweep, not once per tenant', async () => {
    const fixture = emptyFixture();
    fixture.tenants = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
    const { service, queryRaw, baseClient } = makeService(fixture);

    await service.snapshotAll(DAY);

    expect(queryRaw).toHaveBeenCalledTimes(TEXT_TABLES.length + CLAIM_CHECK_TABLES.length);
    expect(baseClient.media.groupBy).toHaveBeenCalledTimes(1);
    // Unscoped sweep: no tenant filter, because the job has no CLS tenant context.
    expect(baseClient.media.groupBy.mock.calls[0][0].where.tenantId).toBeUndefined();
  });

  it('keeps going when one tenant fails, and counts only the successes', async () => {
    const fixture = emptyFixture();
    fixture.tenants = [{ id: 't1' }, { id: 't2' }];
    fixture.media = [
      { tenantId: 't1', _sum: { size: 1_000_000_000 } },
      { tenantId: 't2', _sum: { size: 1_000_000_000 } },
    ];
    const { service, recordUsage } = makeService(fixture);
    recordUsage.mockImplementation((input: Array<{ tenantId: string }>) => {
      if (input[0].tenantId === 't1') return Promise.reject(new Error('outbox unavailable'));
      return Promise.resolve({ outboxIds: ['o1'], events: 1 });
    });

    const result = await service.snapshotAll(DAY);

    expect(result).toEqual({ tenants: 1, rows: 1 });
  });
});

describe('StorageSnapshotService — scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ships ENABLED at 02:15 UTC: a night the job misses can never be recomputed', () => {
    const { service } = makeService(emptyFixture());
    expect(service.getConfig()).toEqual({ enabled: true, cron: '15 2 * * *' });
  });

  it('snapshots the day that just CLOSED, never the day in progress', async () => {
    const fixture = emptyFixture();
    fixture.media = [{ tenantId: 't1', _sum: { size: 1_000_000_000 } }];
    const { service, recordUsage } = makeService(fixture);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T02:15:04.000Z'));

    await service.handleScheduledSnapshot();

    expect(emitted(recordUsage)[0].idempotencyKey).toBe('storage:t1:media:2026-09-12');
  });

  it('does nothing on a tick while disabled', async () => {
    const fixture = emptyFixture();
    fixture.media = [{ tenantId: 't1', _sum: { size: 1_000_000_000 } }];
    const { service, recordUsage, baseClient } = makeService(fixture);
    vi.spyOn(service, 'getConfig').mockReturnValue({ enabled: false, cron: '15 2 * * *' });

    await service.handleScheduledSnapshot();

    expect(recordUsage).not.toHaveBeenCalled();
    expect(baseClient.tenant.findMany).not.toHaveBeenCalled();
  });
});
