/** TASK-1057 — `consent.record` (evidence) and `consent.revoke` (reason) policies and their stamps. */
import { ConsentGrantMethod, ConsentPurpose } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import { ActionConfirmationService } from '../../settings-registry/action-confirmation.service';
import { ConsentGrantService } from '../consent-grant.service';

function build(mode: 'required' | 'not-required') {
  const row = {
    grantedAt: new Date('2026-08-01T00:00:00Z'),
    grantedBy: 'c1',
    scope: null,
    evidenceRef: null,
    expiresAt: null,
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    resourceStatus: 'ENABLED',
  };
  const entity = {
    ...row,
    id: 'g1',
    tenantId: 'tenant-1',
    externalPatientId: 'EHR:1',
    purpose: ConsentPurpose.AI_DOCUMENTATION,
    grantMethod: ConsentGrantMethod.VERBAL_ATTESTED,
    version: 1,
    hasChanges: true,
    changes: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    revoke: vi.fn(),
  };
  const repository = {
    findById: vi.fn(async () => entity),
    create: vi.fn(async (e: unknown) => ({ ...row, ...(e as object), id: 'g2', createdAt: new Date(), updatedAt: new Date(), version: 1, tenantId: 'tenant-1', externalPatientId: 'EHR:1', purpose: ConsentPurpose.AI_DOCUMENTATION, grantMethod: ConsentGrantMethod.VERBAL_ATTESTED })),
    updateWithVersion: vi.fn(async () => entity),
  };
  const emit = vi.fn();
  const cls = { get: vi.fn((k: string) => (k === 'tenantId' ? 'tenant-1' : k === 'user' ? { id: 'u1', roles: ['TENANT_ADMIN'] } : undefined)) };
  const confirmations = new ActionConfirmationService({ resolve: vi.fn(() => ({ value: mode })) } as never, {} as never, {} as never, {} as never);
  const service = new ConsentGrantService(repository as never, { emit } as never, cls as never, undefined, confirmations);
  return { service, repository, emit, entity };
}

const CREATE = { externalPatientId: 'EHR:1', purpose: ConsentPurpose.AI_DOCUMENTATION, grantMethod: ConsentGrantMethod.VERBAL_ATTESTED };

describe('ConsentGrantService — action confirmation (TASK-1057)', () => {
  it('create passes without evidence by default and stamps the sys-event', async () => {
    const { service, repository, emit } = build('not-required');
    await service.create(CREATE);
    expect(repository.create).toHaveBeenCalled();
    const payload = JSON.stringify(emit.mock.calls);
    expect(payload).toContain('consent.record');
    expect(payload).toContain('evidence reference not required');
  });

  it('create refuses CONFIRMATION_REQUIRED before any write when evidence is required and missing', async () => {
    const { service, repository } = build('required');
    await expect(service.create(CREATE)).rejects.toMatchObject({ response: { code: 'CONFIRMATION_REQUIRED', actionId: 'consent.record' } });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('the consultation-open implicit grant is never subject to the evidence policy', async () => {
    const { service, repository } = build('required');
    repository.findById.mockResolvedValue(undefined as never);
    (repository as Record<string, unknown>).findByTenantPatientPurpose = vi.fn(async () => null);
    await expect(service.ensureConsultationConsent('EHR:1')).resolves.toBeDefined();
    expect(repository.create).toHaveBeenCalled();
  });

  it('revoke passes without a reason by default and stamps the sys-event', async () => {
    const { service, repository, emit } = build('not-required');
    await service.revoke('g1', { expectedVersion: 1 });
    expect(repository.updateWithVersion).toHaveBeenCalled();
    expect(JSON.stringify(emit.mock.calls)).toContain('consent.revoke');
  });

  it('revoke refuses CONFIRMATION_REQUIRED before mutating when a reason is required and missing', async () => {
    const { service, repository, entity } = build('required');
    await expect(service.revoke('g1', { expectedVersion: 1 })).rejects.toMatchObject({ response: { code: 'CONFIRMATION_REQUIRED', actionId: 'consent.revoke' } });
    expect(entity.revoke).not.toHaveBeenCalled();
    expect(repository.updateWithVersion).not.toHaveBeenCalled();
  });
});
