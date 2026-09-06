/**
 * TASK-890 J1 MINOR-6 / MINOR-7 — an inventory run must not leave stale answers.
 *
 * MINOR-6. The inventory REWRITES `AiModel.availability`, and that column is one
 * of the two inputs to a self-hosted row's readiness verdict. The readiness
 * snapshot is stored, with a TTL of three sweep intervals, so after an operator
 * clicked "Run inventory" the console kept serving `readinessDetail` derived
 * from the availability the run had just replaced — the value looked
 * authoritative and described a measurement that no longer existed. The
 * inventory now refreshes the snapshot itself.
 *
 * MINOR-7. The last report lived only in the browser tab that produced it, so
 * "In bucket, not registered" was disabled on a fresh load — the operator had to
 * re-run a full bucket sweep to see a list the platform already had. The report
 * is now stored where every process can read it.
 *
 * Both share one rule: a failure in the follow-on must never fail the inventory.
 * The measurement is the valuable part and it has already been written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelInventoryService } from '../model-inventory.service';
import { MODEL_INVENTORY_REPORT_KEY } from '../model-inventory.constants';

const BASE_CLIENT = { __lane: 'base' };

function build(over: { readiness?: unknown; redis?: unknown } = {}) {
  const s3 = { listFiles: vi.fn(async () => []), getFile: vi.fn() };
  const repo = { findAll: vi.fn(async () => []), update: vi.fn(async (_id: string, e: unknown) => e) };
  const db = { baseClient: BASE_CLIENT };
  const store = new Map<string, string>();
  const redis = over.redis ?? {
    isConnected: vi.fn(() => true),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => void store.set(key, value)),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };
  const readiness = over.readiness ?? { sweep: vi.fn(async () => ({})), getSnapshot: vi.fn(async () => null) };
  const service = new ModelInventoryService(repo as never, s3 as never, db as never, redis as never, readiness as never);
  return { service, s3, repo, redis: redis as { setex: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }, readiness, store };
}

beforeEach(() => vi.clearAllMocks());

describe('ModelInventoryService — the run refreshes what it invalidated (MINOR-6)', () => {
  it('re-sweeps readiness after writing availability', async () => {
    const { service, readiness } = build();

    await service.runInventory();

    expect((readiness as { sweep: ReturnType<typeof vi.fn> }).sweep).toHaveBeenCalledTimes(1);
  });

  it('still returns the report when the re-sweep fails — the measurement is already written', async () => {
    const { service } = build({ readiness: { sweep: vi.fn(async () => Promise.reject(new Error('text unreachable'))) } });

    const report = await service.runInventory();

    expect(report.checkedAt).toBeInstanceOf(Date);
  });

  it('runs without a readiness collaborator at all — it is optional, and its absence is not a failure', async () => {
    const s3 = { listFiles: vi.fn(async () => []), getFile: vi.fn() };
    const repo = { findAll: vi.fn(async () => []), update: vi.fn() };
    const service = new ModelInventoryService(repo as never, s3 as never, { baseClient: BASE_CLIENT } as never);

    await expect(service.runInventory()).resolves.toMatchObject({ counts: expect.anything() });
  });
});

describe('ModelInventoryService — the last report survives the tab (MINOR-7)', () => {
  it('stores the report so a fresh reader can have it', async () => {
    const { service, redis, store } = build();

    const report = await service.runInventory();

    expect(redis.setex).toHaveBeenCalledWith(MODEL_INVENTORY_REPORT_KEY, expect.any(Number), expect.any(String));
    expect(JSON.parse(store.get(MODEL_INVENTORY_REPORT_KEY)!).counts).toEqual(report.counts);
  });

  it('reads the stored report back', async () => {
    const { service } = build();
    const written = await service.runInventory();

    const read = await service.getLastReport();

    expect(read).not.toBeNull();
    expect(read!.counts).toEqual(written.counts);
    // A stored date round-trips through JSON as a string; the reader restores it
    // so `checkedAt` means the same thing on both paths.
    expect(read!.checkedAt).toBeInstanceOf(Date);
  });

  it('returns null when nothing has been stored — never a fabricated empty report', async () => {
    const { service } = build();

    expect(await service.getLastReport()).toBeNull();
  });

  it('survives an unavailable Redis on both the write and the read', async () => {
    const redis = { isConnected: vi.fn(() => false), setex: vi.fn(), get: vi.fn() };
    const { service } = build({ redis });

    await expect(service.runInventory()).resolves.toBeTruthy();
    expect(redis.setex).not.toHaveBeenCalled();
    // In-process fallback: the instance that ran it can still answer.
    expect(await service.getLastReport()).not.toBeNull();
  });
});
