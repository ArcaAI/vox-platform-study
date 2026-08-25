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
import { ConsentGrantState } from '../dto';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockHarnessAuditService = { append: vi.fn() };

const mockConsentGrantRepository = {
  findById: vi.fn(),
  findByTenantAndPatient: vi.fn(),
  findByTenantPatientPurpose: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
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
    // Mirrors ConsentGrantEntity.isActive: not revoked as of `now`, and not
    // expired as of `now`.
    isActive: (now: Date = new Date()) => {
      const revokedAt = overrides.revokedAt ?? null;
      if (revokedAt && revokedAt.getTime() <= now.getTime()) return false;
      return true;
    },
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

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.objectContaining({ resourceId: saved.id }));
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

  // TASK-805 owner directive (2026-08-25) — a doctor opening a consultation IS
  // the consent event, so every purpose is granted at that moment.
  describe('ensureConsultationConsent', () => {
    beforeEach(() => {
      mockConsentGrantRepository.create.mockImplementation(async (entity: { purpose: ConsentPurpose }) =>
        createMockEntity({ purpose: entity.purpose }),
      );
    });

    it('grants EVERY purpose when the patient has none', async () => {
      mockConsentGrantRepository.findByTenantPatientPurpose.mockResolvedValue(null);

      const granted = await service.ensureConsultationConsent('EHR-A:12345');

      const allPurposes = Object.values(ConsentPurpose);
      expect(granted).toHaveLength(allPurposes.length);
      expect(mockConsentGrantRepository.create).toHaveBeenCalledTimes(allPurposes.length);
      // Enumerated from the enum, so a newly added purpose is covered too.
      const created = mockConsentGrantRepository.create.mock.calls.map((c) => c[0].purpose);
      expect(new Set(created)).toEqual(new Set(allPurposes));
    });

    it('attributes every grant to the requesting clinician, not to a machine', async () => {
      mockConsentGrantRepository.findByTenantPatientPurpose.mockResolvedValue(null);

      await service.ensureConsultationConsent('EHR-A:12345');

      // `create()` stamps grantedBy from the CLS request user — the whole
      // reason this does not violate owner decision D-3.
      for (const call of mockConsentGrantRepository.create.mock.calls) {
        expect(call[0].grantedBy).toBe('clinician-1');
      }
    });

    it('is idempotent — an already-ACTIVE purpose is skipped, never duplicated', async () => {
      const active = createMockEntity();
      // Active for AI_DOCUMENTATION only; every other purpose is absent.
      mockConsentGrantRepository.findByTenantPatientPurpose.mockImplementation(async (_t: string, _p: string, purpose: ConsentPurpose) =>
        purpose === ConsentPurpose.AI_DOCUMENTATION ? active : null,
      );

      const granted = await service.ensureConsultationConsent('EHR-A:12345');

      const created = mockConsentGrantRepository.create.mock.calls.map((c) => c[0].purpose);
      expect(created).not.toContain(ConsentPurpose.AI_DOCUMENTATION);
      expect(granted).toHaveLength(Object.values(ConsentPurpose).length - 1);
    });

    it('re-grants a purpose whose previous grant was REVOKED — a new consultation is a new consent event', async () => {
      const revoked = createMockEntity({ revokedAt: new Date('2026-08-02T00:00:00Z') });
      mockConsentGrantRepository.findByTenantPatientPurpose.mockImplementation(async (_t: string, _p: string, purpose: ConsentPurpose) =>
        purpose === ConsentPurpose.AI_DOCUMENTATION ? revoked : null,
      );

      await service.ensureConsultationConsent('EHR-A:12345');

      const created = mockConsentGrantRepository.create.mock.calls.map((c) => c[0].purpose);
      expect(created).toContain(ConsentPurpose.AI_DOCUMENTATION);
    });

    it('trim-normalizes the patient id before looking anything up', async () => {
      mockConsentGrantRepository.findByTenantPatientPurpose.mockResolvedValue(null);

      await service.ensureConsultationConsent('  EHR-A:12345  ');

      expect(mockConsentGrantRepository.findByTenantPatientPurpose.mock.calls[0][1]).toBe('EHR-A:12345');
    });

    it('rejects without a tenant context rather than writing across tenants', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? undefined : { id: 'user-1' }));

      await expect(service.ensureConsultationConsent('EHR-A:12345')).rejects.toThrow('Tenant context required');
      expect(mockConsentGrantRepository.create).not.toHaveBeenCalled();
    });
  });

  // TASK-805 — the consent register. `getByPatient` (patient id REQUIRED, bare
  // array) is gone; `list` is tenant-wide, paginated and filterable.
  describe('list', () => {
    /** The `where` clause the service handed to findAll (both calls share one). */
    const capturedWhere = (): Record<string, unknown> => mockConsentGrantRepository.findAll.mock.calls[0][0].where as Record<string, unknown>;

    beforeEach(() => {
      mockConsentGrantRepository.findAll.mockResolvedValue([createMockEntity()]);
      mockConsentGrantRepository.count.mockResolvedValue(1);
    });

    it('scopes every read to the caller tenant and returns a paginated envelope', async () => {
      const result = await service.list({ page: 0, limit: 10 });

      expect(capturedWhere()).toMatchObject({ tenantId: 'tenant-1', resourceStatus: ResourceStatusType.ENABLED });
      expect(result.count).toBe(1);
      expect(result.page).toBe(0);
      expect(result.limit).toBe(10);
      expect(result.data).toHaveLength(1);
    });

    it('rejects when there is no tenant context rather than reading across tenants', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? undefined : { id: 'user-1' }));

      await expect(service.list({ page: 0, limit: 10 })).rejects.toThrow('Tenant context required');
      expect(mockConsentGrantRepository.findAll).not.toHaveBeenCalled();
    });

    it('trim-normalizes the patient filter with the SAME function the write path uses', async () => {
      await service.list({ page: 0, limit: 10, externalPatientId: '  EHR-A:12345  ' });

      expect(capturedWhere()).toMatchObject({ externalPatientId: 'EHR-A:12345' });
    });

    it('filters by purpose when asked', async () => {
      await service.list({ page: 0, limit: 10, purpose: ConsentPurpose.AI_DOCUMENTATION });

      expect(capturedWhere()).toMatchObject({ purpose: ConsentPurpose.AI_DOCUMENTATION });
    });

    it('state=ACTIVE excludes revoked AND expired rows — the predicate assertConsent evaluates', async () => {
      await service.list({ page: 0, limit: 10, state: ConsentGrantState.ACTIVE });

      const and = capturedWhere().AND as Array<Record<string, unknown>>;
      expect(and).toHaveLength(2);
      // revoked-ness: null, or a revocation that has not taken effect yet
      expect(and[0].OR).toEqual([{ revokedAt: null }, { revokedAt: { gt: expect.any(Date) } }]);
      // expiry: none, or still in the future
      expect(and[1].OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
    });

    it('state=REVOKED returns only grants already revoked', async () => {
      await service.list({ page: 0, limit: 10, state: ConsentGrantState.REVOKED });

      expect(capturedWhere().revokedAt).toEqual({ not: null, lte: expect.any(Date) });
    });

    it('state=ALL (the default) applies no lifecycle predicate', async () => {
      await service.list({ page: 0, limit: 10 });

      expect(capturedWhere().AND).toBeUndefined();
      expect(capturedWhere().revokedAt).toBeUndefined();
    });

    it('counts with the SAME predicate it lists with, so a page and its total never disagree', async () => {
      await service.list({ page: 0, limit: 10, state: ConsentGrantState.ACTIVE });

      const listWhere = mockConsentGrantRepository.findAll.mock.calls[0][0].where;
      const countWhere = mockConsentGrantRepository.count.mock.calls[0][0].where;
      expect(countWhere).toEqual(listWhere);
    });

    // Offset pagination over a non-unique sort key is unsound without a
    // tiebreaker: `grantedAt` ties (the seed stamps every demo grant with the
    // same instant), and Postgres may then return page 2 rows that already
    // appeared on page 1.
    it('always appends `id` as a sort tiebreaker so pages cannot overlap', async () => {
      await service.list({ page: 0, limit: 10 });

      expect(mockConsentGrantRepository.findAll.mock.calls[0][0].sort).toEqual([{ grantedAt: 'desc' }, { id: 'desc' }]);
    });

    it('keeps a caller-supplied sort and still appends the tiebreaker', async () => {
      await service.list({ page: 0, limit: 10, sort: 'expiresAt:asc' });

      expect(mockConsentGrantRepository.findAll.mock.calls[0][0].sort).toEqual([{ expiresAt: 'asc' }, { id: 'desc' }]);
    });

    it('does not double-append when the caller already sorted by id', async () => {
      await service.list({ page: 0, limit: 10, sort: 'id:asc' });

      expect(mockConsentGrantRepository.findAll.mock.calls[0][0].sort).toEqual([{ id: 'asc' }]);
    });

    it('broadcasts ResourceViewed', async () => {
      await service.list({ page: 0, limit: 10 });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.anything());
    });
  });
});
