/** TASK-1057 — `harnessPolicy.update` consults the platform reason policy and records its stamp. */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, Logger } from '@nestjs/common';
import { HarnessPolicyFactory } from '@arcaai/domains';
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
  const confirmations = new ActionConfirmationService({ resolve: vi.fn(() => ({ value: mode })) } as never);
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
  );
  return { service, policyRepository, policyChangeRepository };
}

describe('HarnessPolicyService — action confirmation (TASK-1057)', () => {
  it('passes without a reason by default and records the "not required" stamp', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, policyRepository } = build('not-required');
    await service.updatePolicy({ gateSlaSeconds: 300 } as never);
    expect(policyRepository.updateWithVersion).toHaveBeenCalled();
    const payload = JSON.stringify(log.mock.calls);
    expect(payload).toContain('reason not required');
    expect(payload).toContain('harnessPolicy.update');
    log.mockRestore();
  });

  it('refuses 400 CONFIRMATION_REQUIRED before any write when required and missing', async () => {
    const { service, policyRepository, policyChangeRepository } = build('required');
    await expect(service.updatePolicy({ gateSlaSeconds: 300 } as never)).rejects.toMatchObject({
      response: { code: 'CONFIRMATION_REQUIRED', actionId: 'harnessPolicy.update' },
    });
    await expect(service.updateGlobalDefault({ gateSlaSeconds: 300 } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(policyRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(policyRepository.create).not.toHaveBeenCalled();
    expect(policyChangeRepository.create).not.toHaveBeenCalled();
  });
});
