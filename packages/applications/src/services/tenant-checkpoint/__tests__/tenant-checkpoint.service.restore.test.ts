import { describe, expect, it } from 'vitest';
import { SysEventType, TenantCheckpointStatus } from '@arcaai/domains';
import { buildService, checkpointEntity, SUPER_ADMIN, TENANT_ADMIN, TENANT_A } from './service-fixture';

const valid = {
  categories: ['CONFIG_CONTENT'] as ('CONFIG_CONTENT' | 'USERS_ACCESS' | 'CLINICAL')[],
  reason: 'rolling back a bad agent rewrite',
  password: 'right-password',
  confirmationName: 'Acme Clinic',
};

function ready(f: ReturnType<typeof buildService>, overrides = {}) {
  const row = checkpointEntity(overrides);
  f.checkpoints.findByIdOrNull.mockResolvedValue(row);
  return row;
}

describe('TenantCheckpointService.restore — the ordered checks', () => {
  it('missing password → 428, wrong password → 401, wrong name → 400', async () => {
    const f = buildService();
    ready(f);
    await expect(f.service.restore(TENANT_A, 'c', { ...valid, password: undefined })).rejects.toMatchObject({ status: 428 });
    await expect(f.service.restore(TENANT_A, 'c', { ...valid, password: 'nope' })).rejects.toMatchObject({ status: 401 });
    await expect(f.service.restore(TENANT_A, 'c', { ...valid, confirmationName: 'Other Clinic' })).rejects.toMatchObject({ status: 400 });
    expect(f.restores.create).not.toHaveBeenCalled();
    expect(f.restoreQueue.add).not.toHaveBeenCalled();
  });

  it('a rejected break-glass is force-audited without the password', async () => {
    const f = buildService();
    ready(f);
    await expect(f.service.restore(TENANT_A, 'c', { ...valid, password: 'nope' })).rejects.toMatchObject({ status: 401 });
    const [type, event] = f.eventEmitter.emit.mock.calls[0];
    expect(type).toBe(SysEventType.ResourceViewed);
    expect(event).toMatchObject({ forceAuditLog: true, tenantId: TENANT_A, data: { outcome: 'rejected-wrong-password' } });
    expect(JSON.stringify(event)).not.toContain('nope');
  });

  it("Review Focus 5: the expected name is the tenant's CURRENT name (renamed after the checkpoint)", async () => {
    const f = buildService();
    ready(f);
    f.tenant.name = 'Acme Clinic (renamed)';
    await expect(f.service.restore(TENANT_A, 'c', valid)).rejects.toMatchObject({ status: 400 }); // the old name no longer works
    await expect(f.service.restore(TENANT_A, 'c', { ...valid, confirmationName: 'Acme Clinic (renamed)' })).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('a tenant admin asking for CLINICAL → 403 CLINICAL_RESTORE_REQUIRES_PLATFORM_ADMIN', async () => {
    const f = buildService(TENANT_ADMIN);
    ready(f);
    await expect(f.service.restore(TENANT_A, 'c', { ...valid, categories: ['CONFIG_CONTENT', 'CLINICAL'] })).rejects.toMatchObject({
      status: 403,
      response: { code: 'CLINICAL_RESTORE_REQUIRES_PLATFORM_ADMIN' },
    });
    expect(f.restores.create).not.toHaveBeenCalled();
  });

  it('a super admin asking for CLINICAL passes', async () => {
    const f = buildService(SUPER_ADMIN);
    ready(f);
    const out = await f.service.restore(TENANT_A, 'c', { ...valid, categories: ['CLINICAL'] });
    expect(out.categories).toEqual(['CLINICAL']);
    expect(f.restoreQueue.add).toHaveBeenCalledTimes(1);
  });

  it('a checkpoint that is not READY → 409 CHECKPOINT_NOT_READY', async () => {
    const f = buildService();
    ready(f, { status: TenantCheckpointStatus.FAILED });
    await expect(f.service.restore(TENANT_A, 'c', valid)).rejects.toMatchObject({ response: { code: 'CHECKPOINT_NOT_READY' } });
  });

  it('a running export or an active restore → 409 TENANT_CHECKPOINT_BUSY', async () => {
    const f = buildService();
    ready(f);
    f.checkpoints.findRunningByTenant.mockResolvedValue([checkpointEntity({ status: TenantCheckpointStatus.RUNNING })]);
    await expect(f.service.restore(TENANT_A, 'c', valid)).rejects.toMatchObject({ response: { code: 'TENANT_CHECKPOINT_BUSY' } });

    f.checkpoints.findRunningByTenant.mockResolvedValue([]);
    f.restores.findActiveByTenant.mockResolvedValue({ id: 'r1' });
    await expect(f.service.restore(TENANT_A, 'c', valid)).rejects.toMatchObject({ response: { code: 'TENANT_CHECKPOINT_BUSY' } });
  });

  it('the partial-unique violation of a concurrent restore is also 409 TENANT_CHECKPOINT_BUSY', async () => {
    const f = buildService();
    ready(f);
    f.restores.create.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    await expect(f.service.restore(TENANT_A, 'c', valid)).rejects.toMatchObject({ status: 409, response: { code: 'TENANT_CHECKPOINT_BUSY' } });
    expect(f.restoreQueue.add).not.toHaveBeenCalled();
  });

  it('an incompatible schema → 409 SCHEMA_INCOMPATIBLE naming the columns', async () => {
    const f = buildService();
    ready(f);
    // live Department has a NOT NULL column without default that the checkpoint lacks
    f.queryRawUnsafe.mockResolvedValue([
      { table_name: 'Department', column_name: 'id', is_nullable: 'NO', column_default: null, is_identity: 'NO' },
      { table_name: 'Department', column_name: 'tenantId', is_nullable: 'NO', column_default: null, is_identity: 'NO' },
      { table_name: 'Department', column_name: 'name', is_nullable: 'NO', column_default: null, is_identity: 'NO' },
      { table_name: 'Department', column_name: 'timezone', is_nullable: 'NO', column_default: null, is_identity: 'NO' },
    ]);
    await expect(f.service.restore(TENANT_A, 'c', valid)).rejects.toMatchObject({
      status: 409,
      response: { code: 'SCHEMA_INCOMPATIBLE', problems: [{ model: 'Department', column: 'timezone', problem: 'NOT_NULL_WITHOUT_DEFAULT' }] },
    });
  });

  it('a reason under 10 characters → 400', async () => {
    const f = buildService();
    ready(f);
    await expect(f.service.restore(TENANT_A, 'c', { ...valid, reason: 'too short' })).rejects.toMatchObject({
      status: 400,
      response: { code: 'RESTORE_REASON_INVALID' },
    });
  });

  it('checks run in exactly the documented order', async () => {
    // wrong password AND clinical-by-tenant-admin AND not READY AND busy → 401 (break-glass first)
    const f = buildService(TENANT_ADMIN);
    ready(f, { status: TenantCheckpointStatus.FAILED });
    f.restores.findActiveByTenant.mockResolvedValue({ id: 'r1' });
    const bad = { ...valid, password: 'nope', categories: ['CLINICAL' as const] };
    await expect(f.service.restore(TENANT_A, 'c', bad)).rejects.toMatchObject({ status: 401 });
    // right password: clinical 403 outranks not-READY 409
    await expect(f.service.restore(TENANT_A, 'c', { ...bad, password: 'right-password' })).rejects.toMatchObject({ status: 403 });
    // config only: not-READY 409 outranks busy 409
    await expect(f.service.restore(TENANT_A, 'c', { ...valid })).rejects.toMatchObject({ response: { code: 'CHECKPOINT_NOT_READY' } });
  });

  it('success: a PENDING restore row, a job with ids only, and a force-audited sys-event', async () => {
    const f = buildService();
    const row = ready(f);
    const out = await f.service.restore(TENANT_A, row.id, valid);

    expect(out).toMatchObject({ status: 'PENDING', checkpointId: row.id, categories: ['CONFIG_CONTENT'], requestedBy: 'user-1', warnings: [] });
    const [, payload, opts] = f.restoreQueue.add.mock.calls[0];
    expect(payload).toEqual({ restoreId: out.id, tenantId: TENANT_A });
    expect(opts).toMatchObject({ jobId: out.id });
    expect(JSON.stringify(f.restoreQueue.add.mock.calls[0])).not.toContain('right-password');
    const event = f.eventEmitter.emit.mock.calls.find((c) => c[0] === SysEventType.ResourceCreated)?.[1];
    expect(event).toMatchObject({ forceAuditLog: true, resourceId: out.id, resourceType: 'TenantCheckpointRestore' });
    expect(JSON.stringify(event)).not.toContain('right-password');
  });
});
