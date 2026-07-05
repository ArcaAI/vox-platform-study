/**
 * TASK-302 Phase 4 Task 4.8 (Stream B) — Vault ciphertext also scrubbed.
 *
 * Phase 0 Item 4 (Stream A) wired scrubLockedForAudit which honours
 * @Secret metadata to redact `value` and `defaultValue` for locked rows.
 *
 * Phase 4 Task 4.3 added the new `encryptedValue` field with @Secret().
 * This test pins the integration: the SysEvent for a locked row whose
 * encryptedValue is non-null MUST surface `[REDACTED]` for that field
 * too, never the raw ciphertext bytes.
 *
 * Defense in depth: ciphertext alone is not directly readable, but
 * leaking it alongside a known keyVersion materially helps an attacker
 * correlate audit rows, and may help them identify long-lived secrets
 * across rotation events. So we strip it from the audit channel.
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
// TASK-302 Stream D Phase C (C.4) — `updateTenantConfigs` wraps writes in
// `databaseService.baseClient.$transaction(callback)`. The stub invokes the
// callback with a sentinel tx client so the loop executes.
const mockTxClient = { __tx: true } as const;
const db = {
  getClient: vi.fn(),
  client: { userRoleAssignment: { findMany: vi.fn() } },
  baseClient: {
    $transaction: vi.fn().mockImplementation(async (callback: (tx: typeof mockTxClient) => Promise<unknown>) => callback(mockTxClient)),
  },
};
const buckets = { provisionSystemBuckets: vi.fn() };

describe('TenantService — audit-scrub for Vault-encrypted rows (Phase 4 Task 4.8)', () => {
  let service: TenantService;
  beforeEach(() => {
    vi.clearAllMocks();
    cls.get.mockImplementation((k: string) =>
      k === 'user'
        ? { id: 'sa-id', roles: ['GLOBAL_ADMIN'] }
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
      // TASK-356 Phase 1 — model-catalog clone repo (unused by this suite).
      { findAll: async () => [] } as never,
      // TASK-356 Phase 2 — pipeline-version clone repo (unused by this suite).
      { create: async () => ({}) } as never,
    );
  });

  it('redacts encryptedValue in the SysEvent for a locked row', async () => {
    const tenant = { id: 'tenant-1', key: 'TENANT_1', name: 'T1' };
    tenantRepo.findById.mockResolvedValue(tenant);
    tenantRepo.findFirst.mockResolvedValue(tenant);

    const cipherBytes = Buffer.from(
      'vault:v1:DEADBEEF-CIPHERTEXT-SHOULD-NEVER-APPEAR-IN-AUDIT',
      'utf8',
    );
    const locked = GlobalSettingFactory.CreateGlobalSetting({
      tenantId: 'tenant-1',
      key: 'JWT_SECRET_KEY',
      value: 'legacy-plaintext-should-also-be-scrubbed',
      dataType: ValueType.String,
      defaultValue: 'old-default',
      name: 'JWT',
      namespace: 'com.flw.auth',
      description: '',
      locked: true,
      encryptedValue: cipherBytes,
      keyVersion: 1,
    });
    gsRepo.findById.mockResolvedValue(locked);
    gsRepo.updateWithVersion.mockImplementation(async (_id, entity) => entity);

    await service.updateTenantConfigs('tenant-1', [
      { id: locked.id, value: 'new-plain', expectedVersion: 1 } as never,
    ]);

    const emit = events.emit.mock.calls.find((c) => c[0] === SysEventType.ResourceUpdated);
    expect(emit, 'ResourceUpdated SysEvent must have been emitted').toBeDefined();
    const data = (emit![1] as { data: Array<Record<string, unknown>> }).data;
    const row = data[0];

    expect(row.encryptedValue, 'ciphertext must be redacted').toBe('[REDACTED]');
    expect(row.value, 'legacy plaintext must be redacted').toBe('[REDACTED]');
    expect(row.defaultValue, 'default plaintext must be redacted').toBe('[REDACTED]');

    // keyVersion is forward-compat metadata, not a secret — surface it
    // so audit can correlate which Transit key produced the ciphertext.
    expect(row.keyVersion, 'keyVersion is public-safe metadata').toBe(1);

    // Belt-and-braces: serialize the entire payload and assert the raw
    // ciphertext bytes are NOT present anywhere in the SysEvent body.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('DEADBEEF-CIPHERTEXT');
    expect(serialized).not.toContain('legacy-plaintext-should-also-be-scrubbed');
  });

  it('does NOT scrub encryptedValue when the row is unlocked', async () => {
    const tenant = { id: 'tenant-1', key: 'TENANT_1', name: 'T1' };
    tenantRepo.findById.mockResolvedValue(tenant);
    tenantRepo.findFirst.mockResolvedValue(tenant);

    // Unlocked rows that happen to carry encryptedValue (unusual but
    // structurally allowed) should pass through. We never expect this
    // in practice — only locked rows are encrypted — but the scrubber
    // contract is per-entity.
    const unlocked = GlobalSettingFactory.CreateGlobalSetting({
      tenantId: 'tenant-1',
      key: 'feature-flag',
      value: 'true',
      dataType: ValueType.Boolean,
      defaultValue: 'false',
      name: 'flag',
      namespace: 'com.flw.feature',
      description: '',
      locked: false,
      encryptedValue: null,
      keyVersion: null,
    });
    gsRepo.findById.mockResolvedValue(unlocked);
    gsRepo.updateWithVersion.mockImplementation(async (_id, entity) => entity);

    await service.updateTenantConfigs('tenant-1', [
      { id: unlocked.id, value: 'false', expectedVersion: 1 } as never,
    ]);

    const emit = events.emit.mock.calls.find((c) => c[0] === SysEventType.ResourceUpdated);
    const data = (emit![1] as { data: Array<Record<string, unknown>> }).data;
    expect(data[0].value, 'unlocked rows must NOT be redacted').toBe('false');
  });
});
