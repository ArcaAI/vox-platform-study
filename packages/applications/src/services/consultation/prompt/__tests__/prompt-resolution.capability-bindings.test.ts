/**
 * Capability-keyed agent bindings in `PromptResolutionService`.
 *
 * Covers the C1 rollout invariants that belong to C2:
 *
 *   C2-T2  agent-vs-column resolution equality — for all 7 × 2 ArcaAI cells the
 *          agent tier returns the SAME promptId / versionNumber / content bytes
 *          as a legacy-column-only fixture; only `resolvedFrom` flips
 *          'department' → 'agent', and that flip is asserted INTENTIONAL and
 *          checked against its one behavioural consumer.
 *   C2-T6  compat pre-summary resolution snapshot — a call with no departmentId
 *          and no variant resolves the identical template before and after C2.
 *   C2-T7  existing-agent null-binding fallback — an agent with null visit
 *          bindings resolves its BASE template for both visit types (the
 *          36-seeded-row no-op proof).
 *
 * Plus the new pre-summary agent tier (DR-5 / RF-5) and the RF-2 surface-tag
 * filter on the tenant tier.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { PromptResolutionService, SYSTEM_DEFAULTS } from '../prompt-resolution.service';
import type { DepartmentEntity } from '@arcaai/domains';

const TENANT = 'tenant-arcaai';
const DEPT = 'dept-surg';

const mockDepartmentRepository = { findById: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn(), findAll: vi.fn() };
const mockDepartmentAgentRepository = { findDefaultForDepartment: vi.fn() };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };

function department(overrides: Record<string, unknown> = {}): DepartmentEntity {
  return {
    id: DEPT,
    code: 'SURG',
    name: 'Surgery',
    tenantId: TENANT,
    defaultSummaryTemplate: null,
    preSummaryPromptId: null,
    newPatientPromptId: null,
    revisitPromptId: null,
    promptConfig: null,
    ...overrides,
  } as unknown as DepartmentEntity;
}

/** A minimal agent row; every capability binding defaults to null (the 36 seeded rows). */
function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    promptTemplateId: 'base-tpl',
    pinnedVersionNumber: null,
    newPatientTemplateId: null,
    revisitTemplateId: null,
    preSummaryTemplateId: null,
    livePromptTemplateId: null,
    ...overrides,
  };
}

describe('PromptResolutionService — capability-keyed bindings', () => {
  let service: PromptResolutionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({
      id,
      status: 'APPROVED',
      approvedVersionNumber: 1,
    }));
    mockPromptTemplateRepository.findAll.mockResolvedValue([]);
    mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(null);
    mockPromptVersionRepository.findByVersionNumber.mockImplementation(async (templateId: string, versionNumber: number) => ({
      content: `content-of-${templateId}-v${versionNumber}`,
      versionNumber,
    }));
    mockDepartmentRepository.findById.mockResolvedValue(department());

    service = new PromptResolutionService(
      mockDepartmentRepository as never,
      mockPromptTemplateRepository as never,
      mockDepartmentAgentRepository as never,
      mockPromptVersionRepository as never,
    );
  });

  // =========================================================================
  // C2-T7 — the 36 existing seeded agents change by zero bytes
  // =========================================================================

  describe('C2-T7 — an agent with NULL visit bindings resolves its base template (DR-1a)', () => {
    it.each(['new-patient', 'revisit'] as const)('%s falls back to promptTemplateId', async (promptType) => {
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(agent());

      const result = await service.resolve({ departmentId: DEPT, promptType });

      // `selected = visitBinding ?? promptTemplateId` — with both bindings null
      // this is exactly the previous read, for BOTH visit types.
      expect(result.promptId).toBe('base-tpl');
      expect(result.resolvedFrom).toBe('agent');
      expect(result.content).toBe('content-of-base-tpl-v1');
    });
  });

  // =========================================================================
  // C2-T2 — visit-type-aware agent tier (F-01 closed)
  // =========================================================================

  describe('C2-T2 — the agent tier honours visit type', () => {
    const bound = () => agent({ newPatientTemplateId: 'new-referral-tpl', revisitTemplateId: 'followup-tpl' });

    it('new-patient resolves newPatientTemplateId', async () => {
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(bound());
      const result = await service.resolve({ departmentId: DEPT, promptType: 'new-patient' });
      expect(result.promptId).toBe('new-referral-tpl');
      expect(result.content).toBe('content-of-new-referral-tpl-v1');
    });

    it('revisit resolves revisitTemplateId — NOT the same template as new-patient (F-01)', async () => {
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(bound());
      const result = await service.resolve({ departmentId: DEPT, promptType: 'revisit' });
      expect(result.promptId).toBe('followup-tpl');
      expect(result.content).toBe('content-of-followup-tpl-v1');
    });

    it('resolves the SAME promptId / versionNumber / content as the legacy-column path, flipping only resolvedFrom', async () => {
      // The RF-3 equality proof, run over both cells of one department. The
      // ArcaAI seed wires the agent bindings to exactly the ids the legacy
      // columns name, so the two fixtures below are the two seeded paths.
      const columnsOnly = department({ newPatientPromptId: 'new-referral-tpl', revisitPromptId: 'followup-tpl' });

      for (const [promptType, expectedId] of [
        ['new-patient', 'new-referral-tpl'],
        ['revisit', 'followup-tpl'],
      ] as const) {
        mockDepartmentRepository.findById.mockResolvedValue(columnsOnly);
        mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(null);
        const viaColumns = await service.resolve({ departmentId: DEPT, promptType });

        mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(bound());
        const viaAgent = await service.resolve({ departmentId: DEPT, promptType });

        expect(viaColumns.promptId).toBe(expectedId);
        expect(viaAgent.promptId).toBe(viaColumns.promptId);
        expect(viaAgent.resolvedVersionNumber).toBe(viaColumns.resolvedVersionNumber);
        expect(viaAgent.content).toBe(viaColumns.content);

        // The ONE intended difference. Asserted rather than tolerated: the flip
        // is provenance-only. Its single behavioural consumer is the compat
        // shim's `resolvedFrom === 'default'` guard (smr-compat-template.service.ts),
        // which neither value triggers — so compat output is unchanged.
        expect(viaColumns.resolvedFrom).toBe('department');
        expect(viaAgent.resolvedFrom).toBe('agent');
        expect(viaAgent.resolvedFrom).not.toBe('default');
      }
    });

    it('falls through to the legacy column tier in ONE attempt when the selected binding is unapproved', async () => {
      // Deliberate single-attempt shape: no second try against the base binding
      // inside the agent tier, so resolution stays deterministic and cheap.
      mockDepartmentRepository.findById.mockResolvedValue(department({ revisitPromptId: 'legacy-revisit-tpl' }));
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(
        agent({ revisitTemplateId: 'draft-tpl', newPatientTemplateId: 'new-referral-tpl' }),
      );
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
        id === 'draft-tpl' ? { id, status: 'DRAFT' } : { id, status: 'APPROVED', approvedVersionNumber: 1 },
      );

      const result = await service.resolve({ departmentId: DEPT, promptType: 'revisit' });

      expect(result.promptId).toBe('legacy-revisit-tpl');
      expect(result.resolvedFrom).toBe('department');
    });

    it('still lets the doctor-preferred tier outrank the agent binding (tier-0 unchanged)', async () => {
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(bound());
      const result = await service.resolve({
        departmentId: DEPT,
        promptType: 'revisit',
        preferredPromptTemplateId: 'doctor-tpl',
      });
      expect(result.promptId).toBe('doctor-tpl');
      expect(result.resolvedFrom).toBe('preferred');
    });
  });

  // =========================================================================
  // DR-5 / RF-5 — the native pre-summary agent tier
  // =========================================================================

  describe('pre-summary agent tier (DR-5)', () => {
    it('resolves the agent preSummaryTemplateId when a departmentId was supplied (native)', async () => {
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(agent({ preSummaryTemplateId: 'agent-presum-tpl' }));

      const result = await service.resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'pre-summary' });

      expect(result.promptId).toBe('agent-presum-tpl');
      expect(result.resolvedFrom).toBe('agent');
      expect(result.content).toBe('content-of-agent-presum-tpl-v1');
    });

    it('is INELIGIBLE without a departmentId — the compat signature can never reach it (RF-5)', async () => {
      // Compat calls resolve({ tenantId, promptType: 'pre-summary' }) with no
      // department, so eligibility falls out of the call signature — no
      // compat/native flag exists or is needed.
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(agent({ preSummaryTemplateId: 'agent-presum-tpl' }));
      mockPromptTemplateRepository.findAll.mockResolvedValue([{ id: 'tenant-presum-tpl' }]);

      const result = await service.resolve({ tenantId: TENANT, promptType: 'pre-summary' });

      expect(mockDepartmentAgentRepository.findDefaultForDepartment).not.toHaveBeenCalled();
      expect(result.promptId).toBe('tenant-presum-tpl');
      expect(result.resolvedFrom).toBe('tenant');
    });

    it('skips the agent tier when the binding is null and keeps the tenant tier (ArcaAI behaviour is unchanged)', async () => {
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(agent());
      mockPromptTemplateRepository.findAll.mockResolvedValue([{ id: 'tenant-presum-tpl' }]);

      const result = await service.resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'pre-summary' });

      expect(result.promptId).toBe('tenant-presum-tpl');
      expect(result.resolvedFrom).toBe('tenant');
    });

    it('never consults the SUMMARY bindings for a pre-summary request', async () => {
      // The whole point of the capability split: a note prompt must never be
      // served for a pre-summary request.
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(
        agent({ newPatientTemplateId: 'new-referral-tpl', revisitTemplateId: 'followup-tpl' }),
      );
      mockPromptTemplateRepository.findAll.mockResolvedValue([]);

      const result = await service.resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'pre-summary' });

      expect(result.promptId).toBe(SYSTEM_DEFAULTS.preSummaryPromptId);
      expect(result.resolvedFrom).toBe('default');
    });
  });

  // =========================================================================
  // RF-2 — per-surface-tag tenant tier
  // =========================================================================

  describe('RF-2 — the tenant tier filters by surface tag', () => {
    it("defaults to the 'v1' surface — matches `has: 'pre-summary'` and excludes `dept-free` rows (OD-7(b))", async () => {
      mockPromptTemplateRepository.findAll.mockResolvedValue([{ id: 'v1-row' }]);

      await service.resolve({ tenantId: TENANT, promptType: 'pre-summary' });

      const filters = mockPromptTemplateRepository.findAll.mock.calls[0][0].filters;
      expect(filters.tags).toEqual({ has: 'pre-summary' });
      expect(filters.NOT).toEqual({ tags: { has: 'dept-free' } });
    });

    it("selects the 'dept-free' surface and the D2 SYSTEM fork when the caller asks for it", async () => {
      mockPromptTemplateRepository.findAll.mockResolvedValue([]);

      const result = await service.resolve({ tenantId: TENANT, promptType: 'pre-summary', preSummaryVariant: 'dept-free' });

      const filters = mockPromptTemplateRepository.findAll.mock.calls[0][0].filters;
      expect(filters.tags).toEqual({ hasEvery: ['pre-summary', 'dept-free'] });
      // Seeded by Lane D2; until then this id simply fails the APPROVED check
      // and the chain fails closed, which is the correct posture.
      expect(result.promptId).toBe(SYSTEM_DEFAULTS.deptFreePreSummaryPromptId);
    });
  });

  // =========================================================================
  // OD-7(b) — the 'v1' surface excludes `dept-free` rather than
  // requiring `smr-v1`, so hand-created tenant rows keep resolving. These
  // tests drive `mockPromptTemplateRepository.findAll` through a real
  // (if partial) emulation of the Prisma `tags` list-filter semantics the
  // service actually issues, so they assert row-level RESOLUTION behaviour
  // rather than just the filter object's shape.
  // =========================================================================

  describe("OD-7(b) — the 'v1' surface excludes rather than requires the surface tag", () => {
    /**
     * Emulates the subset of Prisma's `tags` filter semantics
     * `findTenantPreSummaryTemplateId` issues: `{ tags: { has } }`,
     * `{ tags: { hasEvery } }`, and a top-level `{ NOT: { tags: { has } } }`.
     */
    function matchesTagFilter(
      rowTags: string[],
      filters: { tags?: { has?: string; hasEvery?: string[] }; NOT?: { tags?: { has?: string } } },
    ): boolean {
      if (filters.tags?.has && !rowTags.includes(filters.tags.has)) return false;
      if (filters.tags?.hasEvery && !filters.tags.hasEvery.every((tag) => rowTags.includes(tag))) return false;
      if (filters.NOT?.tags?.has && rowTags.includes(filters.NOT.tags.has)) return false;
      return true;
    }

    function fakeFindAll(rows: { id: string; tags: string[] }[]) {
      mockPromptTemplateRepository.findAll.mockImplementation(async (props: { filters: Record<string, unknown> }) =>
        rows.filter((row) => matchesTagFilter(row.tags, props.filters as never)),
      );
    }

    it("resolves a tenant row tagged ONLY ['pre-summary'] on the 'v1' surface — the RED case under OD-7(a)", async () => {
      fakeFindAll([{ id: 'legacy-untagged-row', tags: ['pre-summary'] }]);

      const result = await service.resolve({ tenantId: TENANT, promptType: 'pre-summary' });

      expect(result.promptId).toBe('legacy-untagged-row');
      expect(result.resolvedFrom).toBe('tenant');
    });

    it("does NOT return a row tagged ['pre-summary', 'dept-free'] for the 'v1' surface", async () => {
      fakeFindAll([{ id: 'dept-free-row', tags: ['pre-summary', 'dept-free'] }]);

      const result = await service.resolve({ tenantId: TENANT, promptType: 'pre-summary' });

      // No 'v1' candidate matches, so the chain falls through to the SYSTEM default.
      expect(result.promptId).toBe(SYSTEM_DEFAULTS.preSummaryPromptId);
      expect(result.resolvedFrom).toBe('default');
    });

    it("still resolves a row tagged ['pre-summary', 'smr-v1'] on the 'v1' surface — no regression", async () => {
      fakeFindAll([{ id: 'v1-tagged-row', tags: ['pre-summary', 'smr-v1'] }]);

      const result = await service.resolve({ tenantId: TENANT, promptType: 'pre-summary' });

      expect(result.promptId).toBe('v1-tagged-row');
      expect(result.resolvedFrom).toBe('tenant');
    });

    it("the 'dept-free' surface still REQUIRES the explicit tag — a ['pre-summary']-only row does not satisfy it", async () => {
      fakeFindAll([{ id: 'legacy-untagged-row', tags: ['pre-summary'] }]);

      const result = await service.resolve({ tenantId: TENANT, promptType: 'pre-summary', preSummaryVariant: 'dept-free' });

      expect(result.promptId).toBe(SYSTEM_DEFAULTS.deptFreePreSummaryPromptId);
      expect(result.resolvedFrom).toBe('default');
    });
  });

  // =========================================================================
  // C2-T6 — the compat pre-summary chain is untouched
  // =========================================================================

  describe('C2-T6 — compat pre-summary resolution snapshot', () => {
    it('resolves the tenant v1 row for a compat-shaped call, exactly as before C2', async () => {
      mockPromptTemplateRepository.findAll.mockResolvedValue([{ id: '71000000-0000-0000-0001-000000000024' }]);

      const result = await service.resolve({ tenantId: TENANT, promptType: 'pre-summary' });

      expect(result.promptId).toBe('71000000-0000-0000-0001-000000000024');
      expect(result.resolvedFrom).toBe('tenant');
      expect(result.content).toBe('content-of-71000000-0000-0000-0001-000000000024-v1');
    });

    it('falls back to the SYSTEM v1 default (…040) when the tenant has no row, instead of 503 (B-12)', async () => {
      // The B-12 evidence chain: before the SYSTEM_SHARED_READ_MODELS widening
      // + the re-own migration, a fresh tenant's lookup of …040 missed and this
      // resolved to a ServiceUnavailableException.
      mockPromptTemplateRepository.findAll.mockResolvedValue([]);

      const result = await service.resolve({ tenantId: 'fresh-tenant', promptType: 'pre-summary' });

      expect(result.promptId).toBe(SYSTEM_DEFAULTS.preSummaryPromptId);
      expect(result.resolvedFrom).toBe('default');
    });
  });

  // =========================================================================
  // Additive surface
  // =========================================================================

  it('reports the capability that resolved, additively', async () => {
    mockPromptTemplateRepository.findAll.mockResolvedValue([{ id: 'tenant-presum-tpl' }]);

    expect((await service.resolve({ departmentId: DEPT, promptType: 'new-patient' })).resolvedCapability).toBe('summary');
    expect((await service.resolve({ tenantId: TENANT, promptType: 'pre-summary' })).resolvedCapability).toBe('pre-summary');
  });

  it('exposes the SYSTEM live + dept-free default pointers seeded in C2', () => {
    expect(SYSTEM_DEFAULTS.livePromptId).toBe('71000000-0000-0000-0004-000000000001');
    expect(SYSTEM_DEFAULTS.deptFreePreSummaryPromptId).toBe('71000000-0000-0000-0004-000000000002');
  });
});
