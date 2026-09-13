/**
 * 2026-09-13 — the per-turn agent tier honours the graph's VISIT-TYPE branch.
 *
 * ## The defect
 *
 * `resolveAgentNodePrompt` walked `realtimePerTurnAgentNodes` in authored order and served the
 * first agent that resolved. The seeded BREN graph authors `n_summary_new` before
 * `n_summary_revisit`, both per-turn, guarded by `n_visit`'s branches — so EVERY BREN consultation,
 * revisit included, was frozen on the New Referral prompt (trajectory `payloadRef.promptTemplateId`
 * = `…0022` on a revisit session), and the live parser could not fill a single section of the
 * revisit document template because none of its titles are in that prompt.
 *
 * ## What this pins
 *
 *  1. with `visitType: 'revisit'` the revisit node's agent (template `…0023`) is served;
 *  2. with `visitType: 'new-visit'` the new-visit node's agent (`…0022`) is served — in either
 *     authored order;
 *  3. without a visit type the authored order still wins (nothing an older caller sees changes);
 *  4. a graph without edges or branches is unconstrained: the first candidate still resolves.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PromptResolutionService } from '../prompt-resolution.service';

const TENANT = 'tenant-visit-branch';
const DEPT = 'dept-visit-branch';
const NEW_VISIT_TEMPLATE = '71000000-0000-0000-0001-000000000022';
const REVISIT_TEMPLATE = '71000000-0000-0000-0001-000000000023';

const mockDepartmentRepository = { findById: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn(), findAll: vi.fn(), findByTenantAndSourceTemplateId: vi.fn() };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };
const mockWorkflowAssignments = { resolve: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn() };
const mockAgentRepository = { findPublishedActiveBySlug: vi.fn() };

const REALTIME_PER_TURN = { lane: 'realtime', cadence: 'perTurn' };

const summaryNew = {
  id: 'n_summary_new',
  type: 'core.agent',
  config: { agentRef: { slug: 'arcaai-bren-summary-new-visit' }, execution: REALTIME_PER_TURN },
};
const summaryRevisit = {
  id: 'n_summary_revisit',
  type: 'core.agent',
  config: { agentRef: { slug: 'arcaai-bren-summary-revisit' }, execution: REALTIME_PER_TURN },
};
const visitCondition = {
  id: 'n_visit',
  type: 'core.condition',
  config: {
    branches: [
      { key: 'new_visit', when: "trigger.context.visit_type == 'new-visit'", label: 'New / referral visit' },
      { key: 'revisit', when: "trigger.context.visit_type == 'revisit'", label: 'Follow-up visit' },
    ],
  },
};

/** The seeded BREN consultation graph's branch wiring, verbatim (`e7`/`e8`/`e9`). */
const BRANCH_EDGES = [
  { id: 'e7', from: 'n_visit', fromPort: 'new_visit', to: 'n_summary_new', toPort: 'after' },
  { id: 'e8', from: 'n_visit', fromPort: 'revisit', to: 'n_summary_revisit', toPort: 'after' },
  { id: 'e9', from: 'n_visit', fromPort: 'else', to: 'n_summary_new', toPort: 'after' },
];

function graph(nodes: unknown[], edges: unknown[] = BRANCH_EDGES) {
  return {
    version: 1,
    nodes: [{ id: 'n_trigger', type: 'core.trigger', config: {} }, visitCondition, ...nodes],
    edges,
  };
}

function publishGraph(value: unknown) {
  mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'arcaai-bren-consultation', source: 'department' });
  mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({ id: 'wf-1', slug: 'arcaai-bren-consultation', paletteKey: 'core', graph: value });
}

function buildService(): PromptResolutionService {
  return new PromptResolutionService(
    mockDepartmentRepository as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    mockWorkflowAssignments as never,
    mockWorkflowDefinitionRepository as never,
    undefined,
    undefined,
    mockAgentRepository as never,
  );
}

const resolveLive = (visitType?: string | null) =>
  buildService().resolve({ promptType: 'live', tenantId: TENANT, departmentId: DEPT, ...(visitType === undefined ? {} : { visitType }) });

describe('the live per-turn agent tier follows the visit-type branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDepartmentRepository.findById.mockResolvedValue({ id: DEPT, tenantId: TENANT, defaultSummaryTemplate: null, promptConfig: null });
    mockPromptTemplateRepository.findByTenantAndSourceTemplateId.mockImplementation(async (_tenantId: string, id: string) => ({ id }));
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({
      id,
      status: 'APPROVED',
      approvedVersionNumber: 4,
      currentVersionNumber: 4,
      content: `mutable-content-of-${id}`,
    }));
    mockPromptVersionRepository.findByVersionNumber.mockImplementation(async (templateId: string, versionNumber: number) => ({
      versionNumber,
      content: `v${versionNumber} body of ${templateId}`,
    }));
    mockPromptVersionRepository.findLatestVersion.mockResolvedValue({ versionNumber: 9, content: 'latest body' });
    const agents: Record<string, unknown> = {
      'arcaai-bren-summary-new-visit': {
        id: 'agent-bren-new',
        slug: 'arcaai-bren-summary-new-visit',
        versionNumber: 1,
        task: 'TEXT_GENERATION',
        instruction: { promptTemplateId: NEW_VISIT_TEMPLATE, promptVersionNumber: 4 },
      },
      'arcaai-bren-summary-revisit': {
        id: 'agent-bren-revisit',
        slug: 'arcaai-bren-summary-revisit',
        versionNumber: 1,
        task: 'TEXT_GENERATION',
        instruction: { promptTemplateId: REVISIT_TEMPLATE, promptVersionNumber: 4 },
      },
    };
    mockAgentRepository.findPublishedActiveBySlug.mockImplementation(async (_tenantId: string, slug: string) => agents[slug] ?? null);
    publishGraph(graph([summaryNew, summaryRevisit]));
  });

  it("a REVISIT consultation is served the revisit node's agent, not the first node in authored order", async () => {
    const resolved = await resolveLive('revisit');
    expect(resolved.resolvedFrom).toBe('agent');
    expect(resolved.promptId).toBe(REVISIT_TEMPLATE);
    expect(resolved.content).toBe(`v4 body of ${REVISIT_TEMPLATE}`);
    expect(resolved.resolvedAgentId).toBe('agent-bren-revisit');
    expect(resolved.resolvedVersionNumber).toBe(4);
  });

  it("a NEW visit is served the new-visit node's agent, whichever node is authored first", async () => {
    expect((await resolveLive('new-visit')).promptId).toBe(NEW_VISIT_TEMPLATE);

    publishGraph(graph([summaryRevisit, summaryNew]));
    expect((await resolveLive('new-visit')).promptId).toBe(NEW_VISIT_TEMPLATE);
    expect((await resolveLive('revisit')).promptId).toBe(REVISIT_TEMPLATE);
  });

  it('without a visit type the authored order is untouched (older callers see no change)', async () => {
    expect((await resolveLive()).promptId).toBe(NEW_VISIT_TEMPLATE);
    expect((await resolveLive(null)).promptId).toBe(NEW_VISIT_TEMPLATE);
  });

  it("a visit type no branch names falls back to the node an `else` port (or no branch) reaches", async () => {
    // `n_summary_new` is reachable through `else`; `n_summary_revisit` only through `revisit`.
    expect((await resolveLive('procedure')).promptId).toBe(NEW_VISIT_TEMPLATE);
  });

  it('a graph authored without edges or branches is unconstrained: the first candidate resolves', async () => {
    publishGraph(graph([summaryNew, summaryRevisit], []));
    expect((await resolveLive('revisit')).promptId).toBe(NEW_VISIT_TEMPLATE);
  });
});
