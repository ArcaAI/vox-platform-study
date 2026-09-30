/**
 * TASK-1025 G1 (owner decision OD-1, 2026-09-30) — when the tenant's system
 * buckets cannot be provisioned, TENANT CREATION FAILS AND ROLLS BACK.
 *
 * `TenantBucketService.provisionSystemBuckets` already undoes its own rows and
 * buckets; this suite pins the TenantService half: the tenant row written a
 * moment earlier is hard-purged (so the same key can be retried), nothing after
 * the bucket step runs, and the caller gets the provisioning error — never a
 * tenant that looks created but has no storage behind it.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { SysEventType, TenantFactory, TenantPlan } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantService } from '../tenant.service';

const tenantRepository = {
  create: vi.fn(),
  findById: vi.fn(),
  findFirst: vi.fn(),
};
const tx = {
  documentTemplateVersion: { deleteMany: vi.fn() },
  documentTemplate: { deleteMany: vi.fn() },
  promptVersion: { deleteMany: vi.fn() },
  promptTemplate: { deleteMany: vi.fn() },
  consultationContextSchemaVersion: { deleteMany: vi.fn() },
  consultationContextSchema: { deleteMany: vi.fn() },
  agentAssignment: { deleteMany: vi.fn() },
  agent: { deleteMany: vi.fn() },
  workflowAssignment: { deleteMany: vi.fn() },
  workflowDefinition: { deleteMany: vi.fn() },
  department: { deleteMany: vi.fn() },
  tenantBucket: { deleteMany: vi.fn() },
  tenant: { delete: vi.fn() },
};
const databaseService = {
  baseClient: { $transaction: vi.fn(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx)) },
};
const tenantBucketService = {
  provisionSystemBuckets: vi.fn(),
  applyPlanStorageQuota: vi.fn(),
};
const referenceSet = { provision: vi.fn() };
const billing = { recordPlanChange: vi.fn() };
const cls = { get: vi.fn((key: string) => (key === 'user' ? { id: 'admin-1', roles: ['SUPER_ADMIN'] } : null)), set: vi.fn() };
const events = { emit: vi.fn() };
const stub = {} as never;

function build(): TenantService {
  return new TenantService(
    tenantRepository as never,
    stub, // globalSettingRepository
    stub, // departmentRepository
    stub, // promptTemplateRepository
    databaseService as never,
    tenantBucketService as never,
    events as never,
    cls as never,
    referenceSet as never,
    billing as never,
  );
}

describe('TenantService.create — TASK-1025 G1 bucket provisioning failure', () => {
  let service: TenantService;
  const tenant = TenantFactory.CreateTenant({ name: 'Acme Health', key: 'ACME', plan: TenantPlan.STARTER });

  beforeEach(() => {
    vi.clearAllMocks();
    tenantRepository.create.mockResolvedValue(tenant);
    tenantRepository.findById.mockResolvedValue(tenant);
    tenantBucketService.provisionSystemBuckets.mockRejectedValue(new ServiceUnavailableException('Could not provision hope-recordings-acme: AccessDenied'));
    service = build();
  });

  it('fails tenant creation with the provisioning error', async () => {
    await expect(service.create({ name: 'Acme Health', key: 'ACME' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('hard-purges the tenant row it just wrote (the key is released for a retry)', async () => {
    await expect(service.create({ name: 'Acme Health', key: 'ACME' })).rejects.toThrow();

    expect(tx.tenant.delete).toHaveBeenCalledWith({ where: { id: tenant.id } });
    expect(tx.tenantBucket.deleteMany).toHaveBeenCalledWith({ where: { tenantId: tenant.id } });
  });

  it('runs none of the provisioning steps that follow the bucket step', async () => {
    await expect(service.create({ name: 'Acme Health', key: 'ACME' })).rejects.toThrow();

    expect(tenantBucketService.applyPlanStorageQuota).not.toHaveBeenCalled();
    expect(billing.recordPlanChange).not.toHaveBeenCalled();
    expect(referenceSet.provision).not.toHaveBeenCalled();
  });

  it('records the compensating delete in the audit trail with the storage reason', async () => {
    await expect(service.create({ name: 'Acme Health', key: 'ACME' })).rejects.toThrow();

    expect(events.emit).toHaveBeenCalledWith(
      SysEventType.ResourceDeleted,
      expect.objectContaining({
        resourceId: tenant.id,
        data: expect.objectContaining({ purgeReason: expect.stringContaining('storage buckets') }),
      }),
    );
  });

  it('still raises the ORIGINAL provisioning error when the compensating purge itself fails', async () => {
    databaseService.baseClient.$transaction.mockRejectedValueOnce(new Error('db down'));

    await expect(service.create({ name: 'Acme Health', key: 'ACME' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
