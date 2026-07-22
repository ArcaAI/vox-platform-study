/**
 * Settings-registry write lane — optimistic concurrency.
 *
 * This lane previously did compare-and-set INTERNALLY, against a version
 * read from `AppSettingsService`'s in-memory snapshot — a map rebuilt on a 45s
 * cron. Two consequences the console could not work around:
 *
 *   1. the client had no way to participate: no `If-Match`, and neither the read
 *      nor the write echoed a version, so a UI could not detect a conflict; and
 *   2. the CAS itself compared against a **stale** number, so two admins editing
 *      the same key inside one cron window both read the same version and the
 *      second silently clobbered the first.
 *
 * Additionally `getFromCache` + `create` was not atomic, so two concurrent FIRST
 * writes for a never-written key could both take the create branch.
 *
 * This slice makes the lane honest:
 *   - the CAS version comes from a FRESH row read, never the snapshot;
 *   - a caller-supplied `expectedVersion` drives the CAS (drift → 412);
 *   - omitting it while a row EXISTS is refused (→ 428), so a blind overwrite
 *     is impossible; a first write (no row) still succeeds without one;
 *   - a lost create race is recovered by re-reading and updating.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataNotFoundException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { SettingsRegistryWriteService } from '../settings-registry-write.service';

const KEY = 'agentic.context.liveDelta.maxChars';

const appSettings = { getFromCache: vi.fn(), refreshCache: vi.fn().mockResolvedValue(undefined) };
const globalSettings = { update: vi.fn(), create: vi.fn() };
const globalSettingRepository = { findFirst: vi.fn() };

const GLOBAL_ADMIN = { id: 'user-1', roles: ['GLOBAL_ADMIN'] };
const cls = {
  get: vi.fn((k: string) => (k === 'user' ? GLOBAL_ADMIN : k === 'tenantId' ? 'tenant-1' : undefined)),
  set: vi.fn(),
};

const existingRow = (version: number) => ({ id: 'row-1', key: KEY, version });

function buildService() {
  return new SettingsRegistryWriteService(
    appSettings as never,
    globalSettings as never,
    { emit: vi.fn() } as never,
    cls as never,
    globalSettingRepository as never,
  );
}

describe('SettingsRegistryWriteService — OCC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalSettingRepository.findFirst.mockResolvedValue(null);
    globalSettings.update.mockResolvedValue({ id: 'row-1', version: 4 });
    globalSettings.create.mockResolvedValue({ id: 'row-1', version: 1 });
  });

  it('reads the CAS version from a FRESH row, never the 45s AppSettings snapshot', async () => {
    globalSettingRepository.findFirst.mockResolvedValue(existingRow(7));
    // A stale snapshot that disagrees — it must not be what the CAS compares.
    appSettings.getFromCache.mockReturnValue(existingRow(3));

    await buildService().write(KEY, 500, { expectedVersion: 7 });

    expect(globalSettings.update).toHaveBeenCalledWith('row-1', expect.objectContaining({ expectedVersion: 7 }));
    expect(appSettings.getFromCache).not.toHaveBeenCalled();
  });

  it('rejects a write against an EXISTING row with no expectedVersion (428, never a blind overwrite)', async () => {
    globalSettingRepository.findFirst.mockResolvedValue(existingRow(7));

    await expect(buildService().write(KEY, 500)).rejects.toMatchObject({ status: 428 });
    expect(globalSettings.update).not.toHaveBeenCalled();
  });

  it('raises OptimisticConcurrencyException (→412) when the caller version has drifted', async () => {
    globalSettingRepository.findFirst.mockResolvedValue(existingRow(9));

    await expect(buildService().write(KEY, 500, { expectedVersion: 7 })).rejects.toBeInstanceOf(OptimisticConcurrencyException);
    expect(globalSettings.update).not.toHaveBeenCalled();
  });

  it('allows a FIRST write with no expectedVersion — there is nothing to match yet', async () => {
    globalSettingRepository.findFirst.mockResolvedValue(null);

    const result = await buildService().write(KEY, 500);

    expect(globalSettings.create).toHaveBeenCalled();
    expect(result.version).toBe(1);
  });

  it('echoes the NEW version so the client can round-trip the next If-Match', async () => {
    globalSettingRepository.findFirst.mockResolvedValue(existingRow(7));
    globalSettings.update.mockResolvedValue({ id: 'row-1', version: 8 });

    const result = await buildService().write(KEY, 500, { expectedVersion: 7 });

    expect(result.version).toBe(8);
  });

  it('recovers a lost create race by re-reading and updating instead of failing', async () => {
    // Both writers saw "no row"; the other one won. A unique-constraint failure
    // here must not surface as a 500 to the loser.
    globalSettingRepository.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(existingRow(1));
    globalSettings.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    globalSettings.update.mockResolvedValue({ id: 'row-1', version: 2 });

    const result = await buildService().write(KEY, 500);

    expect(globalSettings.update).toHaveBeenCalledWith('row-1', expect.objectContaining({ expectedVersion: 1 }));
    expect(result.version).toBe(2);
  });

  it('still refreshes the read cache after a successful write', async () => {
    globalSettingRepository.findFirst.mockResolvedValue(existingRow(7));

    await buildService().write(KEY, 500, { expectedVersion: 7 });

    expect(appSettings.refreshCache).toHaveBeenCalled();
  });

  it('keeps the descriptor guards ahead of any OCC work (unknown key still 400)', async () => {
    await expect(buildService().write('not.a.registered.key', 1, { expectedVersion: 1 })).rejects.toThrow();
    expect(globalSettingRepository.findFirst).not.toHaveBeenCalled();
  });

  // ── the REAL repository contract ────────────────────────
  // `Repository.findFirst` never returns null: on no match it THROWS
  // `DataNotFoundException` (packages/domains/src/common/repository.ts). The
  // earlier tests mocked the null-return that the real seam does not have,
  // which is exactly how the fresh-DB "every GET registry/:key is 404" bug
  // shipped. These pin the throw-path.

  it('getBackingRowVersion returns 0 (not a 404) when findFirst throws DataNotFoundException', async () => {
    globalSettingRepository.findFirst.mockRejectedValue(new DataNotFoundException('globalSetting', KEY));

    await expect(buildService().getBackingRowVersion(KEY)).resolves.toBe(0);
  });

  it('a FIRST write still takes the create branch when findFirst throws DataNotFoundException', async () => {
    globalSettingRepository.findFirst.mockRejectedValue(new DataNotFoundException('globalSetting', KEY));

    const result = await buildService().write(KEY, 500);

    expect(globalSettings.create).toHaveBeenCalled();
    expect(result.version).toBe(1);
  });

  it('a NON-not-found repository error still propagates', async () => {
    globalSettingRepository.findFirst.mockRejectedValue(new Error('connection refused'));

    await expect(buildService().getBackingRowVersion(KEY)).rejects.toThrow('connection refused');
  });
});
