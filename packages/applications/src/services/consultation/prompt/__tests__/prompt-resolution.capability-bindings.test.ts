/**
 * Capability-keyed tier-1a bindings in `PromptResolutionService`.
 *
 * TASK-815 moved tier-1a's SOURCE from `DepartmentAgent`'s five capability
 * columns onto WORKFLOW NODE CONFIG: the governing definition's node whose
 * effective `taskKey` names the capability supplies `promptTemplateId` and its
 * own version pin. The C1/C2 invariants below are re-expressed against that
 * source; two of them changed shape and say so in place.
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
const mockWorkflowAssignments = { resolve: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn() };
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

/** Publish a governing `consultation` definition carrying `nodes`. */
function publishGraph(nodes: unknown[]) {
  mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'consultation-default', source: 'department' });
  mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({
    id: 'wfdef-1',
    slug: 'consultation-default',
    paletteKey: 'consultation',
    graph: { version: 1, nodes, edges: [] },
  });
}

/** The node successor of "a department default agent bound to `promptTemplateId`". */
function finalizeNode(promptTemplateId: string, extraConfig: Record<string, unknown> = {}) {
  return { id: 'note_writer', type: 'generate.text', config: { taskKey: 'text.finalize', promptTemplateId, ...extraConfig } };
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
    mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' });
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);
    mockPromptVersionRepository.findByVersionNumber.mockImplementation(async (templateId: string, versionNumber: number) => ({
      content: `content-of-${templateId}-v${versionNumber}`,
      versionNumber,
    }));
    mockDepartmentRepository.findById.mockResolvedValue(department());

    service = new PromptResolutionService(
      mockDepartmentRepository as never,
      mockPromptTemplateRepository as never,
      mockPromptVersionRepository as never,
      mockWorkflowAssignments as never,
      mockWorkflowDefinitionRepository as never,
    );
  });

  // =========================================================================
  // C2-T7 — the 36 existing seeded agents change by zero bytes
  // =========================================================================

  describe('C2-T7 — one finalize node serves BOTH visit types', () => {
    it.each(['new-patient', 'revisit'] as const)('%s resolves the finalize node’s promptTemplateId', async (promptType) => {
      publishGraph([finalizeNode('base-tpl')]);

      const result = await service.resolve({ departmentId: DEPT, promptType });

      // The node substrate has NO visit-type axis (DD-2: a generation node binds
      // its prompt statically), so one finalize node answers both visit types —
      // which is exactly what an agent with both visit bindings null used to do.
      expect(result.promptId).toBe('base-tpl');
      expect(result.resolvedFrom).toBe('agent');
      expect(result.content).toBe('content-of-base-tpl-v1');
    });
  });

  // =========================================================================
  // C2-T2 — visit-type-aware agent tier (F-01 closed)
  // =========================================================================

  describe('C2-T2 — where the VISIT-TYPE axis lives after TASK-815', () => {
    it('the node tier serves one finalize prompt for BOTH visit types — it has no visit-type axis', async () => {
      publishGraph([finalizeNode('one-finalize-tpl')]);

      const newPatient = await service.resolve({ departmentId: DEPT, promptType: 'new-patient' });
      const revisit = await service.resolve({ departmentId: DEPT, promptType: 'revisit' });

      expect(newPatient.promptId).toBe('one-finalize-tpl');
      expect(revisit.promptId).toBe('one-finalize-tpl');
      expect(newPatient.resolvedFrom).toBe('agent');
      expect(revisit.resolvedFrom).toBe('agent');
    });

    it('the DEPARTMENT tier still honours visit type — the axis did not disappear, it moved down one tier', async () => {
      // This is the one behavioural DELTA of the tier-1a repoint, and it is
      // deliberate: DD-2 ("no runtime shape switching") means a generation node
      // binds its prompt statically, so a per-visit-type prompt is expressed by
      // the department's own columns, which are untouched. A tenant that wants
      // visit-type differentiation configures it there and authors no finalize
      // node — the same lever a department with no agent always had.
      mockDepartmentRepository.findById.mockResolvedValue(department({ newPatientPromptId: 'new-referral-tpl', revisitPromptId: 'followup-tpl' }));

      const newPatient = await service.resolve({ departmentId: DEPT, promptType: 'new-patient' });
      const revisit = await service.resolve({ departmentId: DEPT, promptType: 'revisit' });

      expect(newPatient.promptId).toBe('new-referral-tpl');
      expect(revisit.promptId).toBe('followup-tpl');
      expect(newPatient.resolvedFrom).toBe('department');
      expect(revisit.resolvedFrom).toBe('department');
    });

    it('resolves the SAME promptId / versionNumber / content as the legacy-column path, flipping only resolvedFrom', async () => {
      // The RF-3 equality proof, re-expressed against the node source: a node
      // bound to the id the legacy column names produces byte-identical output.
      const columnsOnly = department({ newPatientPromptId: 'new-referral-tpl' });

      mockDepartmentRepository.findById.mockResolvedValue(columnsOnly);
      const viaColumns = await service.resolve({ departmentId: DEPT, promptType: 'new-patient' });

      publishGraph([finalizeNode('new-referral-tpl')]);
      const viaNode = await service.resolve({ departmentId: DEPT, promptType: 'new-patient' });

      expect(viaColumns.promptId).toBe('new-referral-tpl');
      expect(viaNode.promptId).toBe(viaColumns.promptId);
      expect(viaNode.resolvedVersionNumber).toBe(viaColumns.resolvedVersionNumber);
      expect(viaNode.content).toBe(viaColumns.content);

      // The ONE intended difference. Asserted rather than tolerated: the flip
      // is provenance-only. Its single behavioural consumer is the compat
      // shim's `resolvedFrom === 'default'` guard (text-compat-template.service.ts),
      // which neither value triggers — so compat output is unchanged.
      expect(viaColumns.resolvedFrom).toBe('department');
      expect(viaNode.resolvedFrom).toBe('agent');
      expect(viaNode.resolvedFrom).not.toBe('default');
    });

    it('falls through to the legacy column tier in ONE attempt when the node’s template is unapproved', async () => {
      // Deliberate single-attempt shape: no second try against another node
      // inside the tier, so resolution stays deterministic and cheap.
      mockDepartmentRepository.findById.mockResolvedValue(department({ revisitPromptId: 'legacy-revisit-tpl' }));
      publishGraph([finalizeNode('draft-tpl')]);
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
        id === 'draft-tpl' ? { id, status: 'DRAFT' } : { id, status: 'APPROVED', approvedVersionNumber: 1 },
      );

      const result = await service.resolve({ departmentId: DEPT, promptType: 'revisit' });

      expect(result.promptId).toBe('legacy-revisit-tpl');
      expect(result.resolvedFrom).toBe('department');
    });

    it('still lets the doctor-preferred tier outrank the node binding (tier-0 unchanged)', async () => {
      publishGraph([finalizeNode('node-tpl')]);
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
  // The pre-summary chain has NO node tier (TASK-815)
  // =========================================================================

  describe('pre-summary — tier-1a is the agent.presummarization NODE (TASK-806 lane A item 1)', () => {
    it('consults the governing graph, but a NOTE node can never answer a pre-summary request', async () => {
      // The tier's successor — a PRE-SUMMARISATION NODE (`agent.presummarization`, DD-6) — now
      // exists, so the slot is filled rather than empty. What has NOT changed is the property the
      // empty slot was protecting: selection is by node TYPE, so a graph carrying only a finalize
      // node yields no candidate and the chain falls through to the tenant template. Serving that
      // note node's prompt is the wrong-prompt failure the capability split exists to kill.
      publishGraph([finalizeNode('note-tpl')]);
      mockPromptTemplateRepository.findAll.mockResolvedValue([{ id: 'tenant-presum-tpl' }]);

      const result = await service.resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'pre-summary' });

      expect(result.promptId).toBe('tenant-presum-tpl');
      expect(result.resolvedFrom).toBe('tenant');
      // …and the missing node is SURFACED rather than silently absorbed (owner ruling).
      expect(result.resolutionTrace.configurationErrors?.join(' ')).toContain('agent.presummarization');
    });

    it('resolves the graph with NO department — pre-summary has no department axis', async () => {
      publishGraph([finalizeNode('note-tpl')]);
      mockPromptTemplateRepository.findAll.mockResolvedValue([{ id: 'tenant-presum-tpl' }]);

      await service.resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'pre-summary' });

      expect(mockWorkflowAssignments.resolve).toHaveBeenCalledWith(TENANT, 'consultation', null);
    });

    it('is unchanged for the compat signature — which never reached the tier anyway (RF-5)', async () => {
      // Compat calls resolve({ tenantId, promptType: 'pre-summary' }) with no
      // department, so it could never reach tier-1a before either. This is the
      // lock that TASK-815 changed nothing on the frozen compat route.
      mockPromptTemplateRepository.findAll.mockResolvedValue([{ id: 'tenant-presum-tpl' }]);

      const result = await service.resolve({ tenantId: TENANT, promptType: 'pre-summary' });

      expect(result.promptId).toBe('tenant-presum-tpl');
      expect(result.resolvedFrom).toBe('tenant');
    });

    it('falls to the SYSTEM pre-summary default — never CATCHALL_SOAP — when no tenant row exists', async () => {
      publishGraph([finalizeNode('note-tpl')]);
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
  // requiring `text-v1`, so hand-created tenant rows keep resolving. These
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

    it("still resolves a row tagged ['pre-summary', 'text-v1'] on the 'v1' surface — no regression", async () => {
      fakeFindAll([{ id: 'v1-tagged-row', tags: ['pre-summary', 'text-v1'] }]);

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
