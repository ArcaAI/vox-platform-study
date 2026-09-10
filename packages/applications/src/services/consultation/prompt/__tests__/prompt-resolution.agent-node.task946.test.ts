/**
 * TASK-946 D4 / OD-5 — tier 1a of the LIVE chain walks a `core.agent` node to its AGENT.
 *
 * ## The defect
 *
 * `promptBearingNodesForTask` requires `promptTemplateId` ON THE NODE. Since TASK-893 every
 * per-turn node of every published ArcaAI graph is a `core.agent` carrying `agentRef: { slug }`,
 * and the template lives on the AGENT (`Agent.instruction.promptTemplateId`). So tier 1a matched
 * nothing, tier 2 served the SYSTEM "Live SOAP Running Note", and the flush telemetry still
 * reported `selection_source: 'agent'` — the generic platform prompt running under the
 * department agent's name, which is exactly the wrong-prompt class this resolver exists to
 * prevent.
 *
 * ## What this pins
 *
 *  1. the BREN new-visit graph resolves the department agent's own template
 *     (`71000000-0000-0000-0001-000000000022`, approved v3) at tier `agent`;
 *  2. a NODE-level `promptTemplateId` still wins — the pre-946 binding is untouched;
 *  3. the ASR and NER per-turn nodes are never mistaken for the running-note node;
 *  4. an agent that binds no template, or binds an UNAPPROVED one, falls through to the ordinary
 *     chain rather than being served because an agent named it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PromptResolutionService, SYSTEM_DEFAULTS } from '../prompt-resolution.service';

const TENANT = 'tenant-946-live';
const DEPT = 'dept-946-live';
const BREN_TEMPLATE = '71000000-0000-0000-0001-000000000022';
const BREN_APPROVED_VERSION = 3;

const mockDepartmentRepository = { findById: vi.fn() };
const provisionedClone = async (_tenantId: string, sourceTemplateId: string) => ({ id: sourceTemplateId });
const mockPromptTemplateRepository = { findById: vi.fn(), findAll: vi.fn(), findByTenantAndSourceTemplateId: vi.fn(provisionedClone) };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };
const mockWorkflowAssignments = { resolve: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn() };
const mockAgentRepository = { findPublishedActiveBySlug: vi.fn() };

const REALTIME_PER_TURN = { lane: 'realtime', cadence: 'perTurn' };

/** The seeded BREN consultation graph, in its AUTHORED form (`seed/28-workflow-library.ts`). */
function brenGraph(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: {} },
      { id: 'n_presummary', type: 'core.agent', config: { agentRef: { slug: 'case-notes-pre-summary' }, execution: { lane: 'realtime', cadence: 'onStart' } } },
      { id: 'n_asr', type: 'core.agent', config: { agentRef: { slug: 'realtime-transcription' }, execution: REALTIME_PER_TURN } },
      { id: 'n_ner', type: 'core.agent', config: { agentRef: { slug: 'medical-ner' }, execution: REALTIME_PER_TURN } },
      { id: 'n_visit', type: 'core.condition', config: { branches: [] } },
      {
        id: 'n_summary_new',
        type: 'core.agent',
        config: { agentRef: { slug: 'arcaai-bren-summary-new-visit' }, execution: REALTIME_PER_TURN, ...extra },
      },
      {
        id: 'n_summary_revisit',
        type: 'core.agent',
        config: { agentRef: { slug: 'arcaai-bren-summary-revisit' }, execution: REALTIME_PER_TURN },
      },
      { id: 'n_finalize', type: 'core.agent', config: { agentRef: { slug: 'casenote-finalization' }, execution: { lane: 'durable', cadence: 'onEnd' } } },
    ],
    edges: [],
  };
}

function publishGraph(graph: unknown) {
  mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'arcaai-bren-consultation', source: 'department' });
  mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({ id: 'wf-1', slug: 'arcaai-bren-consultation', paletteKey: 'core', graph });
}

/** The seeded agents: only the two summary ones are `TEXT_GENERATION` and bind a template. */
function publishAgents(overrides: Record<string, unknown> = {}) {
  const agents: Record<string, unknown> = {
    'realtime-transcription': { id: 'agent-asr', slug: 'realtime-transcription', versionNumber: 1, task: 'SPEECH_TO_TEXT', instruction: null },
    'medical-ner': { id: 'agent-ner', slug: 'medical-ner', versionNumber: 1, task: 'NAMED_ENTITY_RECOGNITION', instruction: null },
    'arcaai-bren-summary-new-visit': {
      id: 'agent-bren-new',
      slug: 'arcaai-bren-summary-new-visit',
      versionNumber: 4,
      task: 'TEXT_GENERATION',
      instruction: { promptTemplateId: BREN_TEMPLATE, promptVersionNumber: BREN_APPROVED_VERSION },
    },
    'arcaai-bren-summary-revisit': {
      id: 'agent-bren-revisit',
      slug: 'arcaai-bren-summary-revisit',
      versionNumber: 4,
      task: 'TEXT_GENERATION',
      instruction: { promptTemplateId: '71000000-0000-0000-0001-000000000023', promptVersionNumber: BREN_APPROVED_VERSION },
    },
    ...overrides,
  };
  mockAgentRepository.findPublishedActiveBySlug.mockImplementation(async (_tenantId: string, slug: string) => agents[slug] ?? null);
}

function approvedTemplate(id: string, approvedVersionNumber: number | null = 1) {
  return { id, status: 'APPROVED', approvedVersionNumber, currentVersionNumber: approvedVersionNumber, content: `mutable-content-of-${id}` };
}

function buildService(): PromptResolutionService {
  return new PromptResolutionService(
    mockDepartmentRepository as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    mockWorkflowAssignments as never,
    mockWorkflowDefinitionRepository as never,
    undefined, // visitTypes
    undefined, // agentAssignments
    mockAgentRepository as never,
  );
}

const resolveLive = () => buildService().resolve({ promptType: 'live', tenantId: TENANT, departmentId: DEPT });

describe('TASK-946 OD-5 — the live prompt resolves through the per-turn agent node', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDepartmentRepository.findById.mockResolvedValue({ id: DEPT, tenantId: TENANT, defaultSummaryTemplate: null, promptConfig: null });
    mockPromptTemplateRepository.findByTenantAndSourceTemplateId.mockImplementation(provisionedClone);
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
      id === BREN_TEMPLATE ? approvedTemplate(BREN_TEMPLATE, BREN_APPROVED_VERSION) : approvedTemplate(id),
    );
    mockPromptVersionRepository.findByVersionNumber.mockImplementation(async (templateId: string, versionNumber: number) => ({
      versionNumber,
      content: `v${versionNumber} body of ${templateId}`,
    }));
    mockPromptVersionRepository.findLatestVersion.mockResolvedValue({ versionNumber: 9, content: 'latest body' });
    publishGraph(brenGraph());
    publishAgents();
  });

  it('serves the BREN department agent`s own template at its approved version, at tier `agent`', async () => {
    const resolved = await resolveLive();

    expect(resolved.resolvedFrom, 'tier 1a never matched — the SYSTEM live default was served under the agent`s name').toBe('agent');
    expect(resolved.promptId).toBe(BREN_TEMPLATE);
    expect(resolved.resolvedVersionNumber).toBe(BREN_APPROVED_VERSION);
    expect(resolved.content).toBe(`v${BREN_APPROVED_VERSION} body of ${BREN_TEMPLATE}`);
  });

  it('never mistakes the ASR or NER per-turn node for the running-note node', async () => {
    const resolved = await resolveLive();

    expect(resolved.promptId).toBe(BREN_TEMPLATE);
    // Both were considered — and rejected on their agent's TASK, not on a node-id convention.
    expect(mockAgentRepository.findPublishedActiveBySlug).toHaveBeenCalledWith(TENANT, 'realtime-transcription');
  });

  it('a NODE-level promptTemplateId still wins over the agent binding', async () => {
    publishGraph(brenGraph({ taskKey: 'text.live', promptTemplateId: 'node-pinned-template', promptVersionNumber: 2 }));

    const resolved = await resolveLive();

    expect(resolved.resolvedFrom).toBe('agent');
    expect(resolved.promptId).toBe('node-pinned-template');
    expect(resolved.resolvedVersionNumber).toBe(2);
  });

  it('an agent that binds NO template falls through to the ordinary chain', async () => {
    publishAgents({
      'arcaai-bren-summary-new-visit': { id: 'agent-bren-new', slug: 'arcaai-bren-summary-new-visit', versionNumber: 4, task: 'TEXT_GENERATION', instruction: {} },
      'arcaai-bren-summary-revisit': {
        id: 'agent-bren-revisit',
        slug: 'arcaai-bren-summary-revisit',
        versionNumber: 4,
        task: 'TEXT_GENERATION',
        instruction: null,
      },
    });

    const resolved = await resolveLive();

    expect(resolved.resolvedFrom).toBe('default');
    expect(resolved.promptId).toBe(SYSTEM_DEFAULTS.livePromptId);
  });

  it('an agent binding an UNAPPROVED template is SKIPPED — governance is not waived by an agent naming it', async () => {
    // Only the first candidate is unapproved: the walk must move on to the next per-turn agent
    // node rather than stopping, which is the same "skip, do not serve" rule every other tier
    // applies to an unapproved template.
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
      id === BREN_TEMPLATE ? { ...approvedTemplate(BREN_TEMPLATE, BREN_APPROVED_VERSION), status: 'DRAFT' } : approvedTemplate(id, BREN_APPROVED_VERSION),
    );

    const resolved = await resolveLive();

    expect(resolved.resolvedFrom).toBe('agent');
    expect(resolved.promptId, 'the DRAFT template was served because an agent named it').toBe('71000000-0000-0000-0001-000000000023');
  });

  it('falls to the ordinary chain when EVERY per-turn agent`s template is unapproved', async () => {
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ ...approvedTemplate(id), status: 'DRAFT' }));

    const resolved = await resolveLive();

    expect(resolved.resolvedFrom).toBe('code-default');
  });

  it('an unwired agent repository leaves the chain exactly as it was before OD-5', async () => {
    const service = new PromptResolutionService(
      mockDepartmentRepository as never,
      mockPromptTemplateRepository as never,
      mockPromptVersionRepository as never,
      mockWorkflowAssignments as never,
      mockWorkflowDefinitionRepository as never,
    );

    const resolved = await service.resolve({ promptType: 'live', tenantId: TENANT, departmentId: DEPT });

    expect(resolved.resolvedFrom).toBe('default');
  });
});
