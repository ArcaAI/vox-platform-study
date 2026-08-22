/**
 * TASK-790 W3(b) — `WorkflowInvariantRule` gets an HTTP-reachable service (TASK-789 finding H-1).
 *
 * Zero controllers referenced the model, so a tenant admin could not write a row, and
 * `WorkflowValidatorService` — which resolves those rows — was imported nowhere. W3(a) wired the
 * validator; without this service the rows it resolves can still only come from a seed.
 *
 * The ownership semantics under test are `workflow-invariant-rule.prisma`'s own header, which
 * states them and says they are "enforced imperatively in the service": SYSTEM-tenant rows are
 * the platform's invariant register; a tenant row may only ADD strictness for its own tenant, and
 * may never disable, loosen, or delete a SYSTEM-owned row.
 *
 * Two distinct failure modes, deliberately different status codes (rule 05):
 *  - another TENANT's row  -> 404 (cross-tenant, existence hidden)
 *  - the SYSTEM row        -> 403 (privilege; the row's existence is public to every tenant,
 *                                  because they all READ the platform register)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SysEventType, WorkflowRulePredicateType, WorkflowRuleSeverity } from '@arcaai/domains';
import { WorkflowInvariantRuleService } from '../workflow-invariant-rule.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
  findApplicable: vi.fn(),
};

const rule = (overrides: Record<string, unknown> = {}) =>
  ({
    id: overrides.id ?? 'rule-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    ruleId: overrides.ruleId ?? 'WF-I-900',
    registerRefs: [],
    title: overrides.title ?? 'No PHI hop skipped',
    rationale: null,
    predicateType: overrides.predicateType ?? WorkflowRulePredicateType.REQUIRED_NODE_TYPE,
    predicateConfig: overrides.predicateConfig ?? { nodeType: 'consultation.phiHop' },
    paletteKey: overrides.paletteKey ?? 'consultation',
    severity: overrides.severity ?? WorkflowRuleSeverity.ERROR,
    ruleVersion: overrides.ruleVersion ?? 1,
    effectiveFrom: new Date('2026-08-22T00:00:00Z'),
    resourceStatus: overrides.resourceStatus ?? 'ENABLED',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date('2026-08-22T00:00:00Z'),
    updatedAt: new Date('2026-08-22T00:00:00Z'),
    version: overrides.version ?? 1,
    hasChanges: overrides.hasChanges ?? true,
    changes: overrides.changes ?? { title: 'x' },
    ...overrides,
  }) as any;

function build(roles: string[] = ['TENANT_ADMIN'], tenantId = 'tenant-1') {
  mockClsService.get.mockImplementation((key: string) => {
    if (key === 'tenantId') return tenantId;
    if (key === 'user') return { id: 'admin-1', roles };
    return undefined;
  });
  return new WorkflowInvariantRuleService(mockRepository as any, mockEventEmitter as any, mockClsService as any);
}

describe('TASK-790 W3(b) — WorkflowInvariantRuleService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepository.create.mockImplementation(async (entity: any) => entity);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: any) => entity);
    mockRepository.softDelete.mockResolvedValue(rule());
  });

  describe('create', () => {
    it('stamps the CALLER tenant from CLS and never a body-supplied tenantId', async () => {
      const service = build();

      await service.create({
        ruleId: 'WF-I-900',
        title: 'No PHI hop skipped',
        predicateType: WorkflowRulePredicateType.REQUIRED_NODE_TYPE,
        predicateConfig: { nodeType: 'consultation.phiHop' },
        paletteKey: 'consultation',
        // A hostile body: the service must ignore this entirely.
        tenantId: SYSTEM_TENANT_ID,
      } as any);

      expect(mockRepository.create).toHaveBeenCalledTimes(1);
      expect(mockRepository.create.mock.calls[0][0].tenantId).toBe('tenant-1');
    });

    it('broadcasts ResourceCreated', async () => {
      const service = build();

      await service.create({
        ruleId: 'WF-I-900',
        title: 'No PHI hop skipped',
        predicateType: WorkflowRulePredicateType.REQUIRED_NODE_TYPE,
        predicateConfig: { nodeType: 'consultation.phiHop' },
      } as any);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
    });

    it('rejects an unknown paletteKey — a rule for a palette that does not exist can never fire', async () => {
      const service = build();

      await expect(
        service.create({
          ruleId: 'WF-I-900',
          title: 't',
          predicateType: WorkflowRulePredicateType.REQUIRED_NODE_TYPE,
          predicateConfig: {},
          paletteKey: 'summarisation',
        } as any),
      ).rejects.toThrow();

      expect(mockRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('the one-way-strictness ownership boundary', () => {
    it('a tenant admin cannot UPDATE a SYSTEM-owned rule — 403, not 404 (the register is readable by all)', async () => {
      mockRepository.findById.mockResolvedValue(rule({ tenantId: SYSTEM_TENANT_ID }));
      const service = build(['TENANT_ADMIN']);

      await expect(service.update('rule-1', { title: 'weaker', expectedVersion: 1 } as any)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('a tenant admin cannot DELETE a SYSTEM-owned rule', async () => {
      mockRepository.findById.mockResolvedValue(rule({ tenantId: SYSTEM_TENANT_ID }));
      const service = build(['TENANT_ADMIN']);

      await expect(service.deleteById('rule-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockRepository.softDelete).not.toHaveBeenCalled();
    });

    it('a SUPER_ADMIN may update a SYSTEM-owned rule', async () => {
      mockRepository.findById.mockResolvedValue(rule({ tenantId: SYSTEM_TENANT_ID }));
      const service = build(['SUPER_ADMIN']);

      await expect(service.update('rule-1', { title: 'tightened', expectedVersion: 1 } as any)).resolves.toBeDefined();
      expect(mockRepository.updateWithVersion).toHaveBeenCalledTimes(1);
    });

    it("another tenant's row is 404, never 403 — existence stays hidden", async () => {
      mockRepository.findById.mockResolvedValue(rule({ tenantId: 'tenant-2' }));
      const service = build(['TENANT_ADMIN']);

      await expect(service.update('rule-1', { title: 'x', expectedVersion: 1 } as any)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.getById('rule-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a tenant admin CAN update its own row', async () => {
      mockRepository.findById.mockResolvedValue(rule({ tenantId: 'tenant-1' }));
      const service = build(['TENANT_ADMIN']);

      await expect(service.update('rule-1', { title: 'tightened', expectedVersion: 1 } as any)).resolves.toBeDefined();
      expect(mockRepository.updateWithVersion).toHaveBeenCalledWith('rule-1', expect.anything(), 1);
    });
  });

  describe('read widening', () => {
    it('getById resolves a SYSTEM row for a tenant caller — the platform register is readable', async () => {
      mockRepository.findById.mockResolvedValue(rule({ tenantId: SYSTEM_TENANT_ID }));
      const service = build(['TENANT_ADMIN']);

      await expect(service.getById('rule-1')).resolves.toMatchObject({ tenantId: SYSTEM_TENANT_ID });
    });
  });
});
