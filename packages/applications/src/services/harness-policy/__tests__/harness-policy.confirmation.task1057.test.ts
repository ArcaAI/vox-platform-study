/** TASK-1057 — `harnessPolicy.update` consults the platform reason policy and records its stamp. */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, Logger } from '@nestjs/common';
import { HarnessPolicyFactory, ResourceType, SysEventType } from '@arcaai/domains';
import { ActionConfirmationService } from '../../settings-registry/action-confirmation.service';
import { HarnessPolicyService } from '../harness-policy.service';

const TENANT = 'tenant-1';

function build(mode: 'required' | 'not-required') {
  const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT });
  const policyRepository = {
    findForExactTenant: vi.fn(async () => own),
    findSystemDefault: vi.fn(),
    create: vi.fn(async (e: unknown) => e),
    updateWithVersion: vi.fn(async (_i: string, e: unknown) => e),
  };
  const policyChangeRepository = { create: vi.fn(async (e: unknown) => e) };
  const databaseService = { baseClient: { $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})) } };
  const cls = { get: vi.fn((k: string) => (k === 'tenantId' ? TENANT : k === 'user' ? { id: 'u1' } : undefined)) };
  const eventEmitter = { emit: vi.fn() };
  const confirmations = new ActionConfirmationService({ resolve: vi.fn(() => ({ value: mode })) } as never, {} as never, {} as never, {} as never);
  const service = new HarnessPolicyService(
    policyRepository as never,
    policyChangeRepository as never,
    databaseService as never,
    cls as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    confirmations,
    eventEmitter as never,
  );
  return { service, policyRepository, policyChangeRepository, eventEmitter };
}

describe('HarnessPolicyService — action confirmation (TASK-1057)', () => {
  it('passes without a reason by default and records the "not required" stamp', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, policyRepository, eventEmitter } = build('not-required');
    await service.updatePolicy({ gateSlaSeconds: 300 } as never);
    expect(policyRepository.updateWithVersion).toHaveBeenCalled();
    // the audit log itself carries the stamp, not only the logger line
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceUpdated,
      expect.objectContaining({
        resourceType: ResourceType.HarnessPolicy,
        tenantId: TENANT,
        forceAuditLog: true,
        data: expect.objectContaining({
          confirmation: expect.objectContaining({ actionId: 'harnessPolicy.update', note: 'reason not required' }),
        }),
      }),
    );
    const payload = JSON.stringify(log.mock.calls);
    expect(payload).toContain('reason not required');
    expect(payload).toContain('harnessPolicy.update');
    log.mockRestore();
  });

  it('refuses 400 CONFIRMATION_REQUIRED before any write when required and missing', async () => {
    const { service, policyRepository, policyChangeRepository, eventEmitter } = build('required');
    await expect(service.updatePolicy({ gateSlaSeconds: 300 } as never)).rejects.toMatchObject({
      response: { code: 'CONFIRMATION_REQUIRED', actionId: 'harnessPolicy.update' },
    });
    await expect(service.updateGlobalDefault({ gateSlaSeconds: 300 } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(policyRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(policyRepository.create).not.toHaveBeenCalled();
    expect(policyChangeRepository.create).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});
