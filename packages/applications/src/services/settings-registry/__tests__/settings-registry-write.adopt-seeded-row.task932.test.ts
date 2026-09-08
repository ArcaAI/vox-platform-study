/**
 * TASK-932 — the registry write lane ADOPTS a pre-existing row instead of
 * creating a second one for the same key.
 *
 * ── THE DEFECT, REPRODUCED ON THE DEV STACK (2026-09-09) ───────────────────
 * `rate-limit.enabled` is seeded as a SYSTEM row under the `rate-limit`
 * namespace (`seed/12-rate-limit-settings.ts`). The lane looked its backing row
 * up by `(key, namespace: 'registry', tenantId)`, so that row was invisible to
 * it and three things followed, in order:
 *
 *   1. `GET …/registry/rate-limit.enabled?scope=system` answered
 *      `{"value":true,"sourceScope":"system","version":0}` — version 0 with a
 *      row plainly there, so no ETag was rendered for the client to echo;
 *   2. the PUT took the CREATE branch and inserted a SECOND SYSTEM row for the
 *      same key under `registry`. Nothing in the database stopped it: the only
 *      unique index is `(tenantId, name, key)`, and the lane names its rows
 *      after `descriptor.label` ("Rate limiting enabled") rather than after the
 *      seed's name ("Rate Limit Enabled");
 *   3. `AppSettingsService` keys the PLATFORM snapshot by `key` ALONE — one key,
 *      one platform row, deliberately — and refused to build the cache:
 *      *"duplicate platform key(s) detected — rate-limit.enabled (2 rows).
 *      Refuse to start."* Every 45s refresh failed from then on, and the PUT
 *      itself surfaced as a 500.
 *
 * So the invariant is uniqueness per `(tenantId, key)`, not per
 * `(tenantId, namespace, key)`. These tests pin the adoption: the existing row
 * is found whatever namespace it lives in, updated IN PLACE at its own id and
 * namespace, and preconditioned exactly as a `registry`-namespace row is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { ValueType } from '@arcaai/domains';
import { REGISTRY_SETTING_NAMESPACE, SettingsRegistryWriteService, pickBackingRow } from '../settings-registry-write.service';

const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';
const CUSTOMER_TENANT = '50000000-0000-0000-0000-000000000000';

/** `global-kv`, `globalOnly`, `maxScope: 'system'`, boolean — the key the defect was reproduced on. */
const SEEDED_KEY = 'rate-limit.enabled';
/** `global-kv`, tenant-editable, number — the tenant-scope half. */
const TENANT_KEY = 'rateLimit.maxRequests';
/** Registered, but nothing seeds a row for it — the "genuinely new key" case. */
const UNSEEDED_KEY = 'agentic.context.liveDelta.maxChars';

interface Row {
  id: string;
  key: string;
  tenantId: string;
  namespace: string | null;
  version: number;
  value?: string;
  createdAt?: Date;
}

/**
 * A repository stand-in that answers the two shapes `findBackingRow` issues:
 * `{ key, namespace, tenantId }` and `{ key, tenantId }` + `sort`. It THROWS
 * `DataNotFoundException` on a miss, which is the real `Repository.findFirst`
 * contract (it never returns null).
 */
function repositoryOver(rows: Row[]) {
  return {
    findFirst: vi.fn(async (props: { where: Record<string, unknown>; sort?: Array<Record<string, 'asc' | 'desc'>> }) => {
      const { where, sort } = props;
      const matches = rows.filter(
        (row) =>
          (where.key === undefined || row.key === where.key) &&
          (where.tenantId === undefined || row.tenantId === where.tenantId) &&
          (where.namespace === undefined || row.namespace === where.namespace),
      );
      if (matches.length === 0) throw new DataNotFoundException('globalSetting', JSON.stringify(where));
      if (sort?.[0]?.['createdAt'] === 'asc') {
        matches.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
      }
      return matches[0];
    }),
  };
}

const SUPER_ADMIN = { id: 'user-1', roles: ['SUPER_ADMIN'] };
const TENANT_ADMIN = { id: 'user-2', roles: [] };

function buildService(rows: Row[], opts: { superAdmin?: boolean; tenantId?: string } = {}) {
  const store = [...rows];
  const appSettings = { getFromCache: vi.fn(), getValueFromCache: vi.fn(() => null), refreshCache: vi.fn().mockResolvedValue(undefined) };
  const globalSettings = {
    // Mirror the real service: the CAS bumps `_version` and leaves every other
    // column — namespace included — alone.
    update: vi.fn(async (id: string, patch: { value: string; dataType?: ValueType }) => {
      const row = store.find((r) => r.id === id)!;
      row.value = patch.value;
      row.version += 1;
      return { id: row.id, version: row.version, namespace: row.namespace };
    }),
    create: vi.fn(async (input: { key: string; namespace: string; tenantId: string; value: string }) => {
      const row: Row = { id: `created-${store.length + 1}`, version: 1, ...input, createdAt: new Date() };
      store.push(row);
      return row;
    }),
    deleteById: vi.fn(async (id: string) => ({ id })),
  };
  const cls = {
    get: vi.fn((k: string) =>
      k === 'user' ? (opts.superAdmin === false ? TENANT_ADMIN : SUPER_ADMIN) : k === 'tenantId' ? opts.tenantId : undefined,
    ),
    set: vi.fn(),
    run: vi.fn(async (fn: () => unknown) => fn()),
  };
  const emitter = { emit: vi.fn() };
  const repository = repositoryOver(store);
  const svc = new SettingsRegistryWriteService(appSettings as never, globalSettings as never, emitter as never, cls as never, repository as never);
  return { svc, store, globalSettings, appSettings, emitter, repository };
}

const seededPlatformRow = (): Row => ({
  id: '85000000-0000-0000-0000-000000000300',
  key: SEEDED_KEY,
  tenantId: SYSTEM_TENANT,
  namespace: 'rate-limit',
  version: 1,
  value: 'true',
  createdAt: new Date('2026-01-01T00:00:00Z'),
});

describe('TASK-932 — a seeded row in another namespace is ADOPTED, never duplicated', () => {
  beforeEach(() => vi.clearAllMocks());

  it('(a) reports the SEEDED row version, not 0, so the GET can render an ETag', async () => {
    const { svc } = buildService([seededPlatformRow()]);

    // The live reproduction answered 0 here, which is why no `If-Match` existed
    // to send and why the PUT then created a parallel row.
    await expect(svc.getBackingRowVersion(SEEDED_KEY, 'system')).resolves.toBe(1);
  });

  it('(b) updates THAT row in place — same id, namespace unchanged, version +1, no second row', async () => {
    const { svc, store, globalSettings } = buildService([seededPlatformRow()]);

    const result = await svc.write(SEEDED_KEY, false, { scope: 'system', expectedVersion: 1 });

    expect(globalSettings.create).not.toHaveBeenCalled();
    expect(globalSettings.update).toHaveBeenCalledWith(
      '85000000-0000-0000-0000-000000000300',
      expect.objectContaining({ value: 'false', expectedVersion: 1 }),
    );
    expect(result.version).toBe(2);

    // The platform-key invariant `AppSettingsService` enforces at boot.
    expect(store.filter((r) => r.key === SEEDED_KEY && r.tenantId === SYSTEM_TENANT)).toHaveLength(1);
    expect(store[0]!.namespace).toBe('rate-limit');
    expect(store[0]!.value).toBe('false');
  });

  it('(b2) carries the ADOPTED namespace on the sys-event, not this lane`s reserved one', async () => {
    const { svc, emitter } = buildService([seededPlatformRow()]);

    await svc.write(SEEDED_KEY, false, { scope: 'system', expectedVersion: 1 });

    const [, event] = emitter.emit.mock.calls[0] as [string, { data: { namespace: string } }];
    expect(event.data.namespace).toBe('rate-limit');
  });

  it('(b3) aligns the row dataType with the descriptor it is now written from', async () => {
    // The seed declared the type; this lane serialized the value. A boolean
    // written onto a row still declared `String` reads back as the truthy
    // string "false".
    const { svc, globalSettings } = buildService([seededPlatformRow()]);

    await svc.write(SEEDED_KEY, false, { scope: 'system', expectedVersion: 1 });

    expect(globalSettings.update.mock.calls[0]![1]).toMatchObject({ dataType: ValueType.Boolean });
  });

  it('(c) refuses a write with no If-Match against an adopted row (428), exactly as for its own row', async () => {
    const { svc, globalSettings } = buildService([seededPlatformRow()]);

    await expect(svc.write(SEEDED_KEY, false, { scope: 'system' })).rejects.toMatchObject({ status: 428 });
    expect(globalSettings.update).not.toHaveBeenCalled();
    expect(globalSettings.create).not.toHaveBeenCalled();
  });

  it('(c2) 412s on a stale If-Match against an adopted row', async () => {
    const { svc } = buildService([{ ...seededPlatformRow(), version: 5 }]);

    await expect(svc.write(SEEDED_KEY, false, { scope: 'system', expectedVersion: 1 })).rejects.toMatchObject({
      name: 'OptimisticConcurrencyException',
    });
  });

  it('(d) resets the TENANT row that actually exists, in whatever namespace, not a phantom', async () => {
    const tenantRow: Row = {
      id: 'tenant-row-1',
      key: TENANT_KEY,
      tenantId: CUSTOMER_TENANT,
      namespace: 'general',
      version: 3,
      value: '50',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    };
    const { svc, globalSettings } = buildService([tenantRow], { superAdmin: false, tenantId: CUSTOMER_TENANT });

    const result = await svc.reset(TENANT_KEY);

    // Before this fix the lookup missed and reset answered `removed: false` —
    // an idempotent no-op that left the override in place while telling the
    // admin the tenant was inheriting again.
    expect(result.removed).toBe(true);
    expect(globalSettings.deleteById).toHaveBeenCalledWith('tenant-row-1');
  });

  it('(e) a genuinely new key still lands in the reserved `registry` namespace', async () => {
    const { svc, store, globalSettings } = buildService([], { tenantId: SYSTEM_TENANT });

    const result = await svc.write(UNSEEDED_KEY, 500, { scope: 'system' });

    expect(globalSettings.create).toHaveBeenCalledTimes(1);
    expect(globalSettings.create.mock.calls[0]![0]).toMatchObject({
      key: UNSEEDED_KEY,
      namespace: REGISTRY_SETTING_NAMESPACE,
      tenantId: SYSTEM_TENANT,
    });
    expect(result.version).toBe(1);
    expect(store).toHaveLength(1);
  });

  it('(f) re-checks across namespaces before creating, so a row that appeared in between is adopted rather than duplicated', async () => {
    const { svc, store, globalSettings, repository } = buildService([]);

    // The row lands after `write()`'s own lookup missed — the window the old
    // create branch walked straight into.
    repository.findFirst.mockImplementationOnce(async () => {
      throw new DataNotFoundException('globalSetting', SEEDED_KEY);
    });
    repository.findFirst.mockImplementationOnce(async () => {
      store.push(seededPlatformRow());
      throw new DataNotFoundException('globalSetting', SEEDED_KEY);
    });

    await svc.write(SEEDED_KEY, false, { scope: 'system' });

    expect(globalSettings.create).not.toHaveBeenCalled();
    expect(store).toHaveLength(1);
  });

  it('still prefers this lane`s OWN row when a database already carries both', async () => {
    const ownRow: Row = {
      ...seededPlatformRow(),
      id: 'registry-row',
      namespace: REGISTRY_SETTING_NAMESPACE,
      version: 9,
      createdAt: new Date('2026-03-01T00:00:00Z'),
    };
    const { svc } = buildService([seededPlatformRow(), ownRow]);

    // Deterministic in the direction that matches what `AppSettingsService`'s
    // tenant lane reads — a database in this state is already broken, and the
    // lane must at least be predictable about which row it converges on.
    await expect(svc.getBackingRowVersion(SEEDED_KEY, 'system')).resolves.toBe(9);
  });
});

describe('pickBackingRow — the preference, stated once and shared with the feature matrix', () => {
  it('prefers the registry row over an older one', () => {
    const rows = [
      { namespace: 'rate-limit', createdAt: new Date('2026-01-01') },
      { namespace: REGISTRY_SETTING_NAMESPACE, createdAt: new Date('2026-06-01') },
    ];
    expect(pickBackingRow(rows)).toBe(rows[1]);
  });

  it('falls back to the OLDEST row when none is this lane`s own', () => {
    const rows = [
      { namespace: 'pipeline', createdAt: new Date('2026-06-01') },
      { namespace: 'general', createdAt: new Date('2026-01-01') },
    ];
    expect(pickBackingRow(rows)).toBe(rows[1]);
  });

  it('sorts a row with no createdAt LAST rather than ahead of a real one', () => {
    const rows = [{ namespace: 'pipeline' }, { namespace: 'general', createdAt: new Date('2026-01-01') }];
    expect(pickBackingRow(rows)).toBe(rows[1]);
  });

  it('returns undefined for no rows and the single row for one', () => {
    expect(pickBackingRow([])).toBeUndefined();
    const only = { namespace: 'general' };
    expect(pickBackingRow([only])).toBe(only);
  });
});
