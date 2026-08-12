/**
 * TASK-663 — AgentPromotionService.
 *
 * Covers the ticket's TDD list: manage-rights-on-BOTH-tenants (403, and
 * evaluated BEFORE any read so there is no existence oracle); the target
 * context-kind compatibility block; the eval re-running at the TARGET against
 * the TARGET's corpus; the guarantee that no GoldenCase — nor even the pointer
 * to one — crosses a tenant boundary; immutability of the promotion record; the
 * live-consultation alert wording; and that a promoted agent arrives with its
 * loop configuration intact, taken from the immutable VERSION rather than the
 * live source row.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AgentPromotionService, liveConsultationsWarning } from '../agentPromotion.service';

const FROM = 'tenant-source';
const TO = 'tenant-target';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockPromotionRepository = { create: vi.fn(), update: vi.fn(), findById: vi.fn(), findAll: vi.fn(), count: vi.fn() };
const mockAgentRepository = {
  findById: vi.fn(),
  findBySlug: vi.fn(),
  findPrimaryForDepartment: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
const mockAgentVersionRepository = { findLatestForAgent: vi.fn(), findByAgentAndVersionNumber: vi.fn(), create: vi.fn() };
const mockDepartmentRepository = { findById: vi.fn(), findByCode: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn(), create: vi.fn() };
const mockPromptVersionRepository = { create: vi.fn() };
const mockContextSchemaRepository = { findDefaultForScope: vi.fn() };
const mockContextSchemaVersionRepository = { findBySchemaAndVersionNumber: vi.fn() };
const mockConsultationRepository = { count: vi.fn() };
const mockPolicyEngine = { buildAbility: vi.fn() };
const mockEvalRunService = { runGoldenSet: vi.fn() };
// TASK-677 — the promotion write sequence runs inside one transaction. This
// fixture executes the work immediately, so every assertion below observes the
// same writes it did before; the atomicity properties themselves are asserted
// in `agentPromotion.transaction.task677.test.ts`.
const mockUnitOfWork = { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({})) };

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    DepartmentAgentFactory: {
      CreateDepartmentAgent: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'new-target-agent', createdAt: new Date(), version: 1 })),
    },
    DepartmentAgentVersionFactory: {
      CreateDepartmentAgentVersion: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'new-target-version' })),
    },
    PromptTemplateFactory: {
      CreatePromptTemplate: vi.fn((data: Record<string, unknown>) => ({ ...data, id: `copied-${String(data.name)}` })),
    },
    PromptVersionFactory: { CreatePromptVersion: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'copied-v1' })) },
    AgentPromotionFactory: {
      CreateAgentPromotion: vi.fn((data: Record<string, unknown>) => ({
        ...data,
        id: 'promotion-1',
        tenantId: data.toTenantId,
        createdAt: new Date(),
        version: 1,
        validate: vi.fn(),
      })),
    },
  };
});

/** The seven-field snapshot a real DepartmentAgentVersion carries. */
const loopSnapshot = (overrides: Record<string, unknown> = {}) => ({
  role: 'SPECIALIST',
  subscribedKinds: null,
  writeScope: null,
  goal: null,
  guardrailProfile: null,
  alwaysActions: null,
  neverActions: null,
  ...overrides,
});

const sourceAgent = (overrides: Record<string, unknown> = {}) => ({
  id: 'source-agent',
  tenantId: FROM,
  departmentId: 'src-dept',
  name: 'Cardiology SOAP',
  slug: 'cardiology-soap',
  description: 'desc',
  promptTemplateId: 'src-tpl',
  newPatientTemplateId: null,
  revisitTemplateId: null,
  preSummaryTemplateId: null,
  livePromptTemplateId: null,
  pinnedVersionNumber: 3,
  dnaStylePolicy: 'INHERIT',
  harnessOverrides: { maxRegen: 2 },
  toolConfig: { version: 1, tools: { ner: { enabled: true } } },
  llmOverrides: null,
  // The source's OWN corpus pointer. It must never reach the target.
  goldenSetId: 'source-golden-set',
  isDefault: true,
  templateLocked: true,
  sourceAgentTemplateSlug: 'golden-slug',
  tags: ['cardio'],
  // Live values that DIFFER from the promoted version, so a test can prove the
  // version is what travels.
  role: 'PRIMARY',
  subscribedKinds: { version: 1, kinds: [{ key: 'live_edit_after_versioning' }] },
  writeScope: null,
  goal: null,
  guardrailProfile: null,
  alwaysActions: null,
  neverActions: null,
  ...overrides,
});

function buildService() {
  return new AgentPromotionService(
    mockPromotionRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockAgentRepository as never,
    mockAgentVersionRepository as never,
    mockDepartmentRepository as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    mockContextSchemaRepository as never,
    mockContextSchemaVersionRepository as never,
    mockConsultationRepository as never,
    mockPolicyEngine as never,
    mockUnitOfWork as never,
    mockEvalRunService as never,
  );
}

/** An elevated, tenant-less CLS context — what `promote` requires. */
function elevatedTenantlessContext() {
  mockClsService.get.mockImplementation((key: string) => {
    switch (key) {
      case 'user':
        return { id: 'admin-1', roles: ['GLOBAL_ADMIN'] };
      case 'tenantId':
        return '';
      default:
        return null;
    }
  });
}

const baseDto = { sourceAgentId: 'source-agent', fromTenantId: FROM, toTenantId: TO };

describe('AgentPromotionService', () => {
  let service: AgentPromotionService;

  beforeEach(() => {
    vi.clearAllMocks();
    elevatedTenantlessContext();

    mockUnitOfWork.runInTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({}));
    mockPolicyEngine.buildAbility.mockResolvedValue({ can: () => true });
    mockAgentRepository.findById.mockResolvedValue(sourceAgent());
    mockAgentRepository.findBySlug.mockResolvedValue(null);
    mockAgentRepository.findPrimaryForDepartment.mockResolvedValue(null);
    mockAgentRepository.create.mockImplementation(async (e: unknown) => e);
    mockAgentRepository.update.mockImplementation(async (_id: string, e: unknown) => e);
    mockAgentVersionRepository.findLatestForAgent.mockImplementation(async (agentId: string) =>
      agentId === 'source-agent' ? { id: 'src-version', tenantId: FROM, agentId, versionNumber: 4, configSnapshot: loopSnapshot() } : null,
    );
    mockAgentVersionRepository.create.mockImplementation(async (e: unknown) => e);
    mockDepartmentRepository.findById.mockResolvedValue({ id: 'src-dept', tenantId: FROM, code: 'CARD' });
    mockDepartmentRepository.findByCode.mockResolvedValue({ id: 'tgt-dept', tenantId: TO, code: 'CARD' });
    mockPromptTemplateRepository.findById.mockResolvedValue({
      id: 'src-tpl',
      tenantId: FROM,
      name: 'Src Template',
      content: 'body',
      status: 'APPROVED',
      variables: null,
      tags: [],
    });
    mockPromptTemplateRepository.create.mockImplementation(async (e: unknown) => e);
    mockPromptVersionRepository.create.mockImplementation(async (e: unknown) => e);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValue(null);
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(null);
    mockConsultationRepository.count.mockResolvedValue(0);
    mockPromotionRepository.create.mockImplementation(async (e: unknown) => e);
    mockPromotionRepository.update.mockImplementation(async (_id: string, e: unknown) => e);
    mockEvalRunService.runGoldenSet.mockResolvedValue({ run: { id: 'target-eval-run' }, passed: true, failures: [], aggregates: {} });

    service = buildService();
  });

  // =======================================================================
  // T1/T2 — authorization
  // =======================================================================

  describe('manage rights on BOTH tenants (the entire control — D10)', () => {
    it('rejects with 403 when the actor lacks manage on the SOURCE tenant', async () => {
      mockPolicyEngine.buildAbility.mockImplementation(async ({ tenantId }: { tenantId: string }) => ({
        can: () => tenantId !== FROM,
      }));

      await expect(service.promote(baseDto)).rejects.toThrow(ForbiddenException);
      await expect(service.promote(baseDto)).rejects.toThrow(/source tenant/);
    });

    it('rejects with 403 when the actor lacks manage on the TARGET tenant', async () => {
      mockPolicyEngine.buildAbility.mockImplementation(async ({ tenantId }: { tenantId: string }) => ({
        can: () => tenantId !== TO,
      }));

      await expect(service.promote(baseDto)).rejects.toThrow(ForbiddenException);
      await expect(service.promote(baseDto)).rejects.toThrow(/target tenant/);
    });

    it('checks BOTH tenants, not just one', async () => {
      await service.promote(baseDto);

      const tenantsChecked = mockPolicyEngine.buildAbility.mock.calls.map((call) => (call[0] as { tenantId: string }).tenantId);
      expect(tenantsChecked).toEqual([FROM, TO]);
      expect(mockPolicyEngine.buildAbility).toHaveBeenCalledWith({ userId: 'admin-1', tenantId: FROM });
      expect(mockPolicyEngine.buildAbility).toHaveBeenCalledWith({ userId: 'admin-1', tenantId: TO });
    });

    it('evaluates authorization BEFORE any read — an unauthorized caller gets no existence oracle', async () => {
      // A source id that does not exist. An authorized caller would get 404;
      // an unauthorized one must get 403 and must not have caused a read, or
      // the 403/404 difference itself leaks whether the agent exists.
      mockAgentRepository.findById.mockResolvedValue(null);
      mockPolicyEngine.buildAbility.mockResolvedValue({ can: () => false });

      await expect(service.promote({ ...baseDto, sourceAgentId: 'does-not-exist' })).rejects.toThrow(ForbiddenException);
      expect(mockAgentRepository.findById).not.toHaveBeenCalled();
    });

    it('requires an elevated tenant-less context (a pinned working tenant is refused with a clear reason)', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? TO : { id: 'admin-1', roles: ['GLOBAL_ADMIN'] }));

      await expect(service.promote(baseDto)).rejects.toThrow(/elevated tenant-less context/);
      expect(mockPolicyEngine.buildAbility).not.toHaveBeenCalled();
    });

    it('refuses a same-tenant "promotion" — that is what clone is for', async () => {
      await expect(service.promote({ ...baseDto, toTenantId: FROM })).rejects.toThrow(BadRequestException);
    });

    it('surfaces a cross-tenant source agent as 404, never 403 (C5 posture)', async () => {
      // Authorized on both tenants, but the named agent belongs to neither.
      mockAgentRepository.findById.mockResolvedValue({ ...sourceAgent(), tenantId: 'some-third-tenant' });

      await expect(service.promote(baseDto)).rejects.toThrow(NotFoundException);
    });
  });

  // =======================================================================
  // T4/T5 — the blocking compatibility gate
  // =======================================================================

  describe('target context-kind compatibility (blocked, with a named reason)', () => {
    const withSubscribedKind = () =>
      mockAgentVersionRepository.findLatestForAgent.mockResolvedValue({
        id: 'src-version',
        tenantId: FROM,
        agentId: 'source-agent',
        versionNumber: 4,
        configSnapshot: loopSnapshot({ subscribedKinds: { version: 1, kinds: [{ key: 'referral_letter' }] } }),
      });

    const targetDeclares = (kinds: string[], outputs: string[] = []) => {
      mockContextSchemaRepository.findDefaultForScope.mockImplementation(async (_tenantId: string, scope: string) =>
        scope === 'DEPARTMENT' ? { id: 'schema-1', pinnedVersionNumber: 2, status: 'PUBLISHED' } : null,
      );
      mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
        id: 'schema-v2',
        definition: { kinds: kinds.map((key) => ({ key })), outputs: outputs.map((key) => ({ key })) },
      });
    };

    it('blocks when the target department does not declare a subscribed kind, naming it', async () => {
      withSubscribedKind();
      targetDeclares(['some_other_kind']);

      await expect(service.promote(baseDto)).rejects.toThrow(/does not declare kind\(s\) referral_letter/);
      expect(mockAgentRepository.create).not.toHaveBeenCalled();
    });

    it('blocks when the target department has no published context schema at all', async () => {
      withSubscribedKind();
      mockContextSchemaRepository.findDefaultForScope.mockResolvedValue(null);

      await expect(service.promote(baseDto)).rejects.toThrow(/no published context schema/);
      expect(mockAgentRepository.create).not.toHaveBeenCalled();
    });

    it('blocks when the target does not declare a writeScope output, naming it', async () => {
      mockAgentVersionRepository.findLatestForAgent.mockResolvedValue({
        id: 'src-version',
        tenantId: FROM,
        agentId: 'source-agent',
        versionNumber: 4,
        configSnapshot: loopSnapshot({ writeScope: { version: 1, outputs: ['discharge_letter'] } }),
      });
      targetDeclares([], ['soap_note']);

      await expect(service.promote(baseDto)).rejects.toThrow(/does not declare output\(s\) discharge_letter/);
    });

    it('proceeds when the target declares every referenced kind', async () => {
      withSubscribedKind();
      targetDeclares(['referral_letter']);

      const res = await service.promote(baseDto);
      expect(res.id).toBe('promotion-1');
      expect(mockAgentRepository.create).toHaveBeenCalled();
    });

    it('blocks a PRIMARY promotion when the target department already has a PRIMARY, naming it', async () => {
      mockAgentVersionRepository.findLatestForAgent.mockResolvedValue({
        id: 'src-version',
        tenantId: FROM,
        agentId: 'source-agent',
        versionNumber: 4,
        configSnapshot: loopSnapshot({ role: 'PRIMARY' }),
      });
      mockAgentRepository.findPrimaryForDepartment.mockResolvedValue({ id: 'other', slug: 'incumbent-primary' });

      await expect(service.promote(baseDto)).rejects.toThrow(/already has a PRIMARY agent \('incumbent-primary'\)/);
    });

    it('blocks when the target tenant runs no department with the source department’s code', async () => {
      mockDepartmentRepository.findByCode.mockResolvedValue(null);

      await expect(service.promote(baseDto)).rejects.toThrow(/no department with code 'CARD'/);
    });

    it('refuses an agent that has no immutable configuration version to promote', async () => {
      mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);

      await expect(service.promote(baseDto)).rejects.toThrow(/no immutable configuration version/);
    });
  });

  // =======================================================================
  // T10/T11 — what actually travels
  // =======================================================================

  describe('what promotion carries', () => {
    it('a promoted agent arrives with its loop configuration INTACT (the TASK-659 gap)', async () => {
      const promoted = loopSnapshot({
        role: 'PRIMARY',
        goal: { version: 1, objective: 'Draft an accurate SOAP note' },
        guardrailProfile: 'STRICT',
        alwaysActions: ['harness.finalize'],
        neverActions: ['client.emit'],
      });
      mockAgentVersionRepository.findLatestForAgent.mockImplementation(async (agentId: string) =>
        agentId === 'source-agent' ? { id: 'src-version', tenantId: FROM, agentId, versionNumber: 4, configSnapshot: promoted } : null,
      );

      await service.promote(baseDto);

      const created = mockAgentRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(created.role).toBe('PRIMARY');
      expect(created.goal).toEqual({ version: 1, objective: 'Draft an accurate SOAP note' });
      expect(created.guardrailProfile).toBe('STRICT');
      expect(created.alwaysActions).toEqual(['harness.finalize']);
      expect(created.neverActions).toEqual(['client.emit']);
      expect(created.subscribedKinds).toBeNull();
      expect(created.writeScope).toBeNull();
    });

    it('copies the IMMUTABLE VERSION, not the live source row', async () => {
      // The source row's live `subscribedKinds` names a kind the version does
      // not. A mid-promotion edit at the source must not leak into the target.
      await service.promote(baseDto);

      const created = mockAgentRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(created.subscribedKinds).toBeNull();
      expect(created.role).toBe('SPECIALIST'); // version says SPECIALIST; live row says PRIMARY
    });

    it('promotes an explicitly named version number when given one', async () => {
      mockAgentVersionRepository.findByAgentAndVersionNumber.mockResolvedValue({
        id: 'src-version-2',
        tenantId: FROM,
        agentId: 'source-agent',
        versionNumber: 2,
        configSnapshot: loopSnapshot({ guardrailProfile: 'RELAXED' }),
      });

      await service.promote({ ...baseDto, agentVersionNumber: 2 });

      expect(mockAgentVersionRepository.findByAgentAndVersionNumber).toHaveBeenCalledWith('source-agent', 2);
      const created = mockAgentRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(created.guardrailProfile).toBe('RELAXED');
    });

    it('deep-copies a tenant-owned bound template into the target rather than referencing it', async () => {
      await service.promote(baseDto);

      expect(mockPromptTemplateRepository.create).toHaveBeenCalledTimes(1);
      const copied = mockPromptTemplateRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(copied.tenantId).toBe(TO);
      expect(copied.departmentId).toBe('tgt-dept');
      // APPROVED, not DRAFT: promotion moves an already-governed configuration.
      expect(copied.status).toBe('APPROVED');

      const created = mockAgentRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(created.promptTemplateId).not.toBe('src-tpl');
    });

    it('keeps a SYSTEM-owned binding by reference (SYSTEM templates are readable cross-tenant)', async () => {
      mockPromptTemplateRepository.findById.mockResolvedValue({
        id: 'sys-tpl',
        tenantId: '00000000-0000-0000-0000-000000000000',
        name: 'System Template',
        content: 'body',
        tags: [],
      });

      await service.promote(baseDto);

      expect(mockPromptTemplateRepository.create).not.toHaveBeenCalled();
      const created = mockAgentRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(created.promptTemplateId).toBe('src-tpl');
    });

    it('does NOT carry isDefault, templateLocked, pinnedVersionNumber or golden-library lineage', async () => {
      await service.promote(baseDto);

      const created = mockAgentRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(created.isDefault).toBeUndefined();
      expect(created.templateLocked).toBeUndefined();
      expect(created.pinnedVersionNumber).toBeNull();
      expect(created.sourceAgentTemplateSlug).toBeUndefined();
    });

    it('carries the plain configuration values that have no cross-tenant meaning', async () => {
      await service.promote(baseDto);

      const created = mockAgentRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(created.harnessOverrides).toEqual({ maxRegen: 2 });
      expect(created.toolConfig).toEqual({ version: 1, tools: { ner: { enabled: true } } });
      expect(created.dnaStylePolicy).toBe('INHERIT');
      expect(created.tags).toEqual(['cardio']);
    });

    it('writes an immutable configuration version in the TARGET tenant', async () => {
      await service.promote(baseDto);

      const version = mockAgentVersionRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(version.tenantId).toBe(TO);
      expect(version.agentId).toBe('new-target-agent');
      expect(version.versionNumber).toBe(1);
    });
  });

  // =======================================================================
  // T7 — no PHI, and not even the pointer to it, crosses
  // =======================================================================

  describe('no GoldenCase crosses a tenant boundary', () => {
    it('never copies the source goldenSetId onto the target agent', async () => {
      await service.promote(baseDto);

      const created = mockAgentRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(created.goldenSetId).toBeUndefined();
      expect(JSON.stringify(created)).not.toContain('source-golden-set');
    });

    it('never writes the source goldenSetId onto the promotion record', async () => {
      await service.promote(baseDto);

      const promotion = mockPromotionRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(JSON.stringify(promotion)).not.toContain('source-golden-set');
    });

    it('never evaluates against the source golden set', async () => {
      mockAgentRepository.findBySlug.mockResolvedValue({
        ...sourceAgent(),
        id: 'existing-target-agent',
        tenantId: TO,
        departmentId: 'tgt-dept',
        goldenSetId: 'target-golden-set',
      });

      await service.promote(baseDto);

      expect(mockEvalRunService.runGoldenSet).toHaveBeenCalledWith(
        expect.objectContaining({ goldenSetId: 'target-golden-set', tenantId: TO }),
      );
      expect(mockEvalRunService.runGoldenSet).not.toHaveBeenCalledWith(expect.objectContaining({ goldenSetId: 'source-golden-set' }));
    });
  });

  // =======================================================================
  // T6 — the eval re-runs at the target
  // =======================================================================

  describe('eval re-runs at the TARGET tenant', () => {
    it('runs against the target tenant and records the run id on the promotion', async () => {
      mockAgentRepository.findBySlug.mockResolvedValue({
        ...sourceAgent(),
        id: 'existing-target-agent',
        tenantId: TO,
        departmentId: 'tgt-dept',
        goldenSetId: 'target-golden-set',
      });

      const res = await service.promote(baseDto);

      expect(mockEvalRunService.runGoldenSet).toHaveBeenCalledWith({
        goldenSetId: 'target-golden-set',
        tenantId: TO,
        triggerType: 'PROMOTION',
        promptTemplateId: expect.any(String),
      });
      expect(res.evalRunId).toBe('target-eval-run');
    });

    it('accepts an explicitly named target golden set', async () => {
      await service.promote({ ...baseDto, targetGoldenSetId: 'chosen-target-set' });

      expect(mockEvalRunService.runGoldenSet).toHaveBeenCalledWith(expect.objectContaining({ goldenSetId: 'chosen-target-set', tenantId: TO }));
    });

    it('records the source EvalRun as an attestation only — never as the target result', async () => {
      const res = await service.promote({ ...baseDto, sourceEvalRunId: 'source-attestation' });

      expect(res.sourceEvalRunId).toBe('source-attestation');
      expect(res.evalRunId).not.toBe('source-attestation');
    });

    it('warns rather than fails when the target agent has no golden set', async () => {
      const res = await service.promote(baseDto);

      expect(mockEvalRunService.runGoldenSet).not.toHaveBeenCalled();
      expect(res.warnings.join(' ')).toMatch(/no golden set/);
      expect(res.id).toBe('promotion-1');
    });

    it('never loses a promotion to an eval failure', async () => {
      mockAgentRepository.findBySlug.mockResolvedValue({
        ...sourceAgent(),
        id: 'existing-target-agent',
        tenantId: TO,
        departmentId: 'tgt-dept',
        goldenSetId: 'target-golden-set',
      });
      mockEvalRunService.runGoldenSet.mockRejectedValue(new Error('harness unreachable'));

      const res = await service.promote(baseDto);

      expect(res.id).toBe('promotion-1');
      expect(res.warnings.join(' ')).toMatch(/could not be completed: harness unreachable/);
    });
  });

  // =======================================================================
  // T9 — the live-consultation alert
  // =======================================================================

  describe('live consultations — alert, never block', () => {
    beforeEach(() => {
      mockAgentRepository.findBySlug.mockResolvedValue({
        ...sourceAgent(),
        id: 'existing-target-agent',
        tenantId: TO,
        departmentId: 'tgt-dept',
        goldenSetId: null,
      });
    });

    it('names the count and completes the promotion anyway', async () => {
      mockConsultationRepository.count.mockResolvedValue(3);

      const res = await service.promote(baseDto);

      expect(res.warnings).toContain('3 consultations are currently running on the previous version and will complete on it.');
      expect(res.id).toBe('promotion-1');
    });

    it('counts only RECORDING consultations in the TARGET tenant', async () => {
      mockConsultationRepository.count.mockResolvedValue(1);

      await service.promote(baseDto);

      expect(mockConsultationRepository.count).toHaveBeenCalledWith({ filters: { tenantId: TO, status: 'RECORDING' } });
    });

    it('uses singular wording for exactly one', async () => {
      expect(liveConsultationsWarning(1)).toBe('1 consultation is currently running on the previous version and will complete on it.');
    });

    it('issues no alert for a brand-new target agent — there is no previous version to complete on', async () => {
      mockAgentRepository.findBySlug.mockResolvedValue(null);
      mockConsultationRepository.count.mockResolvedValue(7);

      const res = await service.promote(baseDto);

      expect(res.warnings.join(' ')).not.toMatch(/currently running/);
      expect(mockConsultationRepository.count).not.toHaveBeenCalled();
    });

    it('leaves the live consultations themselves untouched', async () => {
      mockConsultationRepository.count.mockResolvedValue(2);

      await service.promote(baseDto);

      // The consultation repository is READ from and never written to — the
      // promotion cannot disturb a session already in flight.
      expect(Object.keys(mockConsultationRepository)).toEqual(['count']);
    });
  });

  // =======================================================================
  // T8 — immutability
  // =======================================================================

  describe('the promotion record is immutable', () => {
    it('is created, never updated, when no eval attestation has to be attached', async () => {
      await service.promote(baseDto);

      expect(mockPromotionRepository.create).toHaveBeenCalledTimes(1);
      expect(mockPromotionRepository.update).not.toHaveBeenCalled();
    });

    it('records a SECOND row rather than mutating the first when the same agent is promoted again', async () => {
      await service.promote(baseDto);
      await service.promote(baseDto);

      expect(mockPromotionRepository.create).toHaveBeenCalledTimes(2);
      const [first, second] = mockPromotionRepository.create.mock.calls.map((c) => c[0] as Record<string, unknown>);
      expect(first).not.toBe(second);
    });

    it('records both tenants, the promoted version and the actor', async () => {
      await service.promote(baseDto);

      const promotion = mockPromotionRepository.create.mock.calls[0][0] as Record<string, unknown>;
      expect(promotion.fromTenantId).toBe(FROM);
      expect(promotion.toTenantId).toBe(TO);
      expect(promotion.tenantId).toBe(TO); // owned by the target
      expect(promotion.agentVersionId).toBe('src-version');
      expect(promotion.sourceAgentId).toBe('source-agent');
      expect(promotion.promotedBy).toBe('admin-1');
      expect(promotion.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it('broadcasts a ResourceCreated sys-event carrying BOTH tenants (CLS has neither on this path)', async () => {
      await service.promote(baseDto);

      expect(mockEventEmitter.emit).toHaveBeenCalled();
      const payloads = mockEventEmitter.emit.mock.calls.map((c) => JSON.stringify(c[1]));
      expect(payloads.some((p) => p.includes(FROM) && p.includes(TO))).toBe(true);
    });
  });

  // =======================================================================
  // T16 — drift, and the tenant-scoped reads
  // =======================================================================

  describe('reads (ordinary tenant scope) and drift detection', () => {
    beforeEach(() => {
      mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? TO : { id: 'admin-1', roles: ['GLOBAL_ADMIN'] }));
    });

    const promotionRow = (checksum: string) => ({
      id: 'promotion-1',
      tenantId: TO,
      fromTenantId: FROM,
      toTenantId: TO,
      agentVersionId: 'src-version',
      sourceAgentId: 'source-agent',
      targetAgentId: 'target-agent',
      targetAgentVersionId: 'tgt-version',
      configSnapshot: loopSnapshot(),
      checksum,
      evalRunId: null,
      sourceEvalRunId: null,
      warnings: [],
      promotedBy: 'admin-1',
      createdAt: new Date(),
      version: 1,
    });

    it('reports drifted=false when the target agent still matches what was promoted', async () => {
      // Promote first so the checksum is the real one for this snapshot.
      elevatedTenantlessContext();
      await service.promote(baseDto);
      const realChecksum = (mockPromotionRepository.create.mock.calls[0][0] as Record<string, unknown>).checksum as string;

      mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? TO : { id: 'admin-1', roles: ['GLOBAL_ADMIN'] }));
      mockPromotionRepository.findById.mockResolvedValue(promotionRow(realChecksum));
      mockAgentRepository.findById.mockResolvedValue({ ...loopSnapshot(), id: 'target-agent', tenantId: TO });

      const res = await service.getById('promotion-1');
      expect(res.drifted).toBe(false);
    });

    it('reports drifted=true once the target agent has been edited', async () => {
      mockPromotionRepository.findById.mockResolvedValue(promotionRow('0'.repeat(64)));
      mockAgentRepository.findById.mockResolvedValue({ ...loopSnapshot({ guardrailProfile: 'STRICT' }), id: 'target-agent', tenantId: TO });

      const res = await service.getById('promotion-1');
      expect(res.drifted).toBe(true);
    });

    it('returns 404 for a promotion belonging to another tenant (404-over-403)', async () => {
      mockPromotionRepository.findById.mockResolvedValue({ ...promotionRow('x'), tenantId: 'someone-else' });

      await expect(service.getById('promotion-1')).rejects.toThrow(NotFoundException);
    });

    it('scopes the list to the reading tenant', async () => {
      mockPromotionRepository.findAll.mockResolvedValue([]);
      mockPromotionRepository.count.mockResolvedValue(0);

      await service.list({ page: 1, limit: 10 } as never);

      expect(mockPromotionRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: TO } }));
    });
  });
});
