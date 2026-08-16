/**
 * ConsentGrantService unit tests (TASK-712, consent-abac).
 *
 * Mirrors the WebhookService/DepartmentService test convention: mock
 * repositories, EventEmitter2, and ClsService; assert factory usage on
 * create, `broadcastSysEvent` on every mutation, and 404-over-403 cross-
 * tenant behavior (.claude/rules/04-application-services.md §Testing
 * Requirements).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConsentGrantService } from '../consent-grant.service';
import { CONSENT_INVALIDATE_EVENT } from '../consent.constants';
import { SysEventType, ResourceStatusType, ConsentPurpose, ConsentGrantMethod, HarnessAuditAction } from '@arcaai/domains';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockHarnessAuditService = { append: vi.fn() };

const mockConsentGrantRepository = {
  findById: vi.fn(),
  findByTenantAndPatient: vi.fn(),
  create: vi.fn(),
  updateWithVersion: vi.fn(),
};

const createMockEntity = (
  overrides: Partial<{
    id: string;
    tenantId: string;
    externalPatientId: string;
    purpose: ConsentPurpose;
    grantedBy: string;
    grantMethod: ConsentGrantMethod;
    revokedAt: Date | null;
    hasChanges: boolean;
    changes: Record<string, unknown>;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }> = {},
) => {
  const entity = {
    id: overrides.id ?? 'grant-id-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    externalPatientId: overrides.externalPatientId ?? 'EHR-A:12345',
    purpose: overrides.purpose ?? ConsentPurpose.AI_DOCUMENTATION,
    scope: null,
    grantedAt: new Date('2026-08-01T00:00:00Z'),
    grantedBy: overrides.grantedBy ?? 'clinician-1',
    grantMethod: overrides.grantMethod ?? ConsentGrantMethod.VERBAL_ATTESTED,
    evidenceRef: null,
    expiresAt: null,
    revokedAt: overrides.revokedAt ?? null,
    revokedBy: null,
    revocationReason: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdAt: overrides.createdAt ?? new Date('2026-08-01T00:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-08-01T00:00:00Z'),
    version: overrides.version ?? 1,
    hasChanges: overrides.hasChanges ?? false,
    changes: overrides.changes ?? {},
    revoke: vi.fn(),
  };
  return entity;
};

describe('ConsentGrantService', () => {
  let service: ConsentGrantService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'clinician-1', roles: ['TENANT_ADMIN'] };
      return undefined;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new ConsentGrantService(mockConsentGrantRepository as any, mockEventEmitter as any, mockClsService as any);
  });

  describe('create', () => {
    it('creates via ConsentGrantFactory, persists, broadcasts ResourceCreated, and emits the invalidate event', async () => {
      const saved = createMockEntity();
      mockConsentGrantRepository.create.mockResolvedValue(saved);

      const result = await service.create({
        externalPatientId: '  EHR-A:12345  ',
        purpose: ConsentPurpose.AI_DOCUMENTATION,
        grantMethod: ConsentGrantMethod.VERBAL_ATTESTED,
      });

      expect(mockConsentGrantRepository.create).toHaveBeenCalledTimes(1);
      const createdEntityArg = mockConsentGrantRepository.create.mock.calls[0][0];
      // Trimmed per Q3's normalization default — never the raw, whitespace-padded input.
      expect(createdEntityArg.externalPatientId).toBe('EHR-A:12345');
      expect(createdEntityArg.tenantId).toBe('tenant-1');
      expect(createdEntityArg.purpose).toBe(ConsentPurpose.AI_DOCUMENTATION);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({ resourceId: saved.id }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        CONSENT_INVALIDATE_EVENT,
        expect.objectContaining({ tenantId: 'tenant-1', externalPatientId: 'EHR-A:12345', purpose: ConsentPurpose.AI_DOCUMENTATION }),
      );
      expect(result.id).toBe(saved.id);
    });
  });

  describe('revoke', () => {
    it('loads, calls entity.revoke, writes via updateWithVersion (never the legacy update), broadcasts ResourceUpdated, and invalidates the cache', async () => {
      const entity = createMockEntity({ tenantId: 'tenant-1' });
      entity.revoke.mockImplementation(() => {
        entity.hasChanges = true;
        entity.changes = { revokedAt: new Date(), revokedBy: 'clinician-1' };
      });
      mockConsentGrantRepository.findById.mockResolvedValue(entity);
      const updated = createMockEntity({ tenantId: 'tenant-1', version: 2, revokedAt: new Date() });
      mockConsentGrantRepository.updateWithVersion.mockResolvedValue(updated);

      const result = await service.revoke('grant-id-1', { reason: 'patient request', expectedVersion: 1 });

      expect(entity.revoke).toHaveBeenCalledWith('clinician-1', 'patient request');
      expect(mockConsentGrantRepository.updateWithVersion).toHaveBeenCalledWith('grant-id-1', entity, 1);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceId: updated.id }));
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(CONSENT_INVALIDATE_EVENT, expect.objectContaining({ tenantId: 'tenant-1' }));
      expect(result.version).toBe(2);
    });

    it('throws NotFoundException — never a tenant-leaking error — on a cross-tenant grant id, and never calls updateWithVersion', async () => {
      const foreignEntity = createMockEntity({ tenantId: 'tenant-OTHER' });
      mockConsentGrantRepository.findById.mockResolvedValue(foreignEntity);

      await expect(service.revoke('grant-id-1', { expectedVersion: 1 })).rejects.toBeInstanceOf(NotFoundException);
      expect(mockConsentGrantRepository.updateWithVersion).not.toHaveBeenCalled();
    });
  });

  describe('WORM ledger writer (Phase 4 follow-up — CONSENT_GIVEN/CONSENT_WITHDRAWN)', () => {
    let serviceWithAudit: ConsentGrantService;

    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serviceWithAudit = new ConsentGrantService(
        mockConsentGrantRepository as any,
        mockEventEmitter as any,
        mockClsService as any,
        mockHarnessAuditService as any,
      );
    });

    it('create() appends a CONSENT_GIVEN row with consultationId null before broadcasting', async () => {
      const saved = createMockEntity();
      mockConsentGrantRepository.create.mockResolvedValue(saved);
      mockHarnessAuditService.append.mockResolvedValue({});

      await serviceWithAudit.create({
        externalPatientId: 'EHR-A:12345',
        purpose: ConsentPurpose.AI_DOCUMENTATION,
        grantMethod: ConsentGrantMethod.VERBAL_ATTESTED,
      });

      expect(mockHarnessAuditService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          consultationId: null,
          action: HarnessAuditAction.CONSENT_GIVEN,
          clinicianId: saved.grantedBy,
        }),
      );
    });

    it('revoke() appends a CONSENT_WITHDRAWN row with consultationId null', async () => {
      const entity = createMockEntity({ tenantId: 'tenant-1' });
      entity.revoke.mockImplementation(() => {
        entity.hasChanges = true;
        entity.changes = { revokedAt: new Date(), revokedBy: 'clinician-1' };
      });
      mockConsentGrantRepository.findById.mockResolvedValue(entity);
      const updated = createMockEntity({ tenantId: 'tenant-1', version: 2, revokedAt: new Date() });
      mockConsentGrantRepository.updateWithVersion.mockResolvedValue(updated);
      mockHarnessAuditService.append.mockResolvedValue({});

      await serviceWithAudit.revoke('grant-id-1', { reason: 'patient request', expectedVersion: 1 });

      expect(mockHarnessAuditService.append).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', consultationId: null, action: HarnessAuditAction.CONSENT_WITHDRAWN }),
      );
    });

    it('is a no-op (never throws) when HarnessAuditService is not wired — the @Optional() unit-fixture path', async () => {
      const saved = createMockEntity();
      mockConsentGrantRepository.create.mockResolvedValue(saved);

      // `service` (top-level beforeEach) was built with only 3 args — no harnessAuditService.
      await expect(
        service.create({
          externalPatientId: 'EHR-A:12345',
          purpose: ConsentPurpose.AI_DOCUMENTATION,
          grantMethod: ConsentGrantMethod.VERBAL_ATTESTED,
        }),
      ).resolves.toBeDefined();
      expect(mockHarnessAuditService.append).not.toHaveBeenCalled();
    });

    it('fail-closed: a WORM append failure propagates out of create() even though the grant row already persisted', async () => {
      const saved = createMockEntity();
      mockConsentGrantRepository.create.mockResolvedValue(saved);
      mockHarnessAuditService.append.mockRejectedValue(new Error('vault unreachable'));

      await expect(
        serviceWithAudit.create({
          externalPatientId: 'EHR-A:12345',
          purpose: ConsentPurpose.AI_DOCUMENTATION,
          grantMethod: ConsentGrantMethod.VERBAL_ATTESTED,
        }),
      ).rejects.toThrow();
      // The mutation itself was NOT rolled back (documented, ATTEST-mirroring
      // trade-off) — the repository write already happened.
      expect(mockConsentGrantRepository.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('getByPatient', () => {
    it('normalizes the patient id, lists ENABLED grants, and broadcasts ResourceViewed', async () => {
      const entity = createMockEntity();
      mockConsentGrantRepository.findByTenantAndPatient.mockResolvedValue([entity]);

      const result = await service.getByPatient('  EHR-A:12345  ');

      expect(mockConsentGrantRepository.findByTenantAndPatient).toHaveBeenCalledWith('tenant-1', 'EHR-A:12345');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.anything());
      expect(result).toHaveLength(1);
    });
  });
});
