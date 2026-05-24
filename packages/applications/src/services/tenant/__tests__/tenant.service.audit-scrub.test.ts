/**
 * Phase 0 Item 4 (TASK-302 Stream A) — audit-log secret scrubbing pin.
 *
 * Asserts that TenantService.updateTenantConfigs emits a
 * SysEventType.ResourceUpdated whose `data` payload carries
 * '[REDACTED]' in `value` / `defaultValue` for any row whose
 * underlying GlobalSettingEntity has `locked === true`. Unlocked
 * rows MUST NOT be scrubbed (audit fidelity matters for the
 * non-secret 99% case).
 *
 * RED — current code calls config.toObject() directly, which
 *       returns plaintext value/defaultValue. D.4 wires in
 *       scrubLockedForAudit which honours the @Secret metadata
 *       applied in D.3.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TenantService } from '../tenant.service';
import { GlobalSettingFactory, SysEventType, ValueType } from '@arcaai/domains';

const cls = { get: vi.fn(), set: vi.fn() };
const events = { emit: vi.fn() };
const tenantRepo = {
  findById: vi.fn(),
  findFirst: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
};
const gsRepo = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  // TASK-302 Stream D Phase C — TenantService.updateTenantConfigs now routes
  // through Compare-And-Set via `updateWithVersion`. Audit-scrub still happens
  // post-write, so these fixtures wire the new repo method.
  updateWithVersion: vi.fn(),
};
const deps = { findAll: vi.fn(), count: vi.fn() };
const ptemps = { findAll: vi.fn(), count: vi.fn() };
const pipes = { findAll: vi.fn(), count: vi.fn() };
const db = {
  getClient: vi.fn(),
  client: { userRoleAssignment: { findMany: vi.fn() } },
};
const buckets = { provisionSystemBuckets: vi.fn() };

describe('TenantService — audit-log secret scrubbing (Phase 0 Item 4)', () => {
  let service: TenantService;
  beforeEach(() => {
    vi.clearAllMocks();
    cls.get.mockImplementation((k: string) =>
      k === 'user'
        ? { id: 'sa-id', roles: ['SUPER_ADMIN'] }
        : k === 'tenantId'
          ? 'tenant-1'
          : k === 'tenantCode'
            ? 'TENANT_1'
            : null,
    );
    service = new TenantService(
      tenantRepo as never,
      gsRepo as never,
      deps as never,
      ptemps as never,
      pipes as never,
      db as never,
      buckets as never,
      events as never,
      cls as never,
    );
  });

  it('redacts value and defaultValue in SysEvent payload for locked rows', async () => {
    const tenant = { id: 'tenant-1', key: 'TENANT_1', name: 'T1' };
    tenantRepo.findById.mockResolvedValue(tenant);
    tenantRepo.findFirst.mockResolvedValue(tenant);

    const locked = GlobalSettingFactory.CreateGlobalSetting({
      tenantId: 'tenant-1',
      key: 'JWT_SECRET_KEY',
      value: 'old-secret',
      dataType: ValueType.String,
      defaultValue: 'old-default',
      name: 'JWT',
      namespace: 'com.flw.auth',
      description: '',
      locked: true,
    });
    gsRepo.findById.mockResolvedValue(locked);
    gsRepo.updateWithVersion.mockImplementation(async (_id, entity) => entity);

    await service.updateTenantConfigs('tenant-1', [
      { id: locked.id, value: 'new-secret', expectedVersion: 1 } as never,
    ]);

    const emit = events.emit.mock.calls.find((c) => c[0] === SysEventType.ResourceUpdated);
    expect(emit, 'ResourceUpdated SysEvent must have been emitted').toBeDefined();
    const data = (emit![1] as { data: Array<Record<string, unknown>> }).data;

    expect(data[0].value, 'locked value must be redacted').toBe('[REDACTED]');
    expect(data[0].defaultValue, 'locked defaultValue must be redacted').toBe('[REDACTED]');
    expect(data[0].key, 'non-secret key may be present').toBe('JWT_SECRET_KEY');
    expect(data[0].locked, 'locked flag may be present').toBe(true);
  });

  it('does NOT redact value or defaultValue for unlocked rows', async () => {
    const tenant = { id: 'tenant-1', key: 'TENANT_1', name: 'T1' };
    tenantRepo.findById.mockResolvedValue(tenant);
    tenantRepo.findFirst.mockResolvedValue(tenant);

    const unlocked = GlobalSettingFactory.CreateGlobalSetting({
      tenantId: 'tenant-1',
      key: 'enable-x',
      value: 'false',
      dataType: ValueType.Boolean,
      defaultValue: 'false',
      name: 'enable-x',
      namespace: 'com.flw.feature',
      description: '',
      locked: false,
    });
    gsRepo.findById.mockResolvedValue(unlocked);
    gsRepo.updateWithVersion.mockImplementation(async (_id, entity) => entity);

    await service.updateTenantConfigs('tenant-1', [
      { id: unlocked.id, value: 'true', expectedVersion: 1 } as never,
    ]);

    const emit = events.emit.mock.calls.find((c) => c[0] === SysEventType.ResourceUpdated);
    const data = (emit![1] as { data: Array<Record<string, unknown>> }).data;
    expect(data[0].value, 'unlocked rows must NOT be redacted').toBe('true');
    expect(data[0].defaultValue).toBe('false');
  });
});
