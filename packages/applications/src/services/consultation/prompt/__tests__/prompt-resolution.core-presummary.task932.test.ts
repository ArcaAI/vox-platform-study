/**
 * TASK-932 — pre-summary under a CORE-palette consultation graph.
 *
 * TASK-930 moved every consultation graph onto the `core` palette, where pre-summary is a
 * `core.agent` node with `execution.cadence: 'onStart'` (the warm start) that REFERENCES an agent
 * (`case-notes-pre-summary`) — there is no `agent.presummarization` node and no
 * `promptTemplateId` on the node. The tier-1a rule that fails a GOVERNED tenant closed when its
 * graph has "no ACTIVE agent.presummarization node with a bound prompt template" was written for
 * the previous vocabulary; once the resolvers found CORE graphs again it 503'd the warm-start
 * pre-summary of every ArcaAI department journey within 30 ms of `recording/start`
 * (`Warm-start pre-summary degraded … reason: ServiceUnavailableException`).
 *
 * A graph that declares pre-summary in the CORE vocabulary is a tenant that HAS configured it
 * — the agent's instruction runs in the realtime lane's `onStart` node. This legacy prompt chain
 * (still what `SummaryService.generatePreSummary` reads) therefore falls through to the tenant /
 * SYSTEM default exactly as it did before, and says so in the trace instead of throwing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptResolutionService, SYSTEM_DEFAULTS } from '../prompt-resolution.service';

const mockDepartmentRepository = { findById: vi.fn() };
const provisionedClone = async (_tenantId: string, sourceTemplateId: string) => ({ id: sourceTemplateId });
const mockPromptTemplateRepository = { findById: vi.fn(), findAll: vi.fn(), findByTenantAndSourceTemplateId: vi.fn(provisionedClone) };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };
const mockWorkflowAssignments = { resolve: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn() };

const TENANT = 'tenant-core-presum-001';

function buildService(): PromptResolutionService {
  return new PromptResolutionService(
    mockDepartmentRepository as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    mockWorkflowAssignments as never,
    mockWorkflowDefinitionRepository as never,
  );
}

function approvedTemplate(id: string) {
  return { id, status: 'APPROVED', approvedVersionNumber: 1, currentVersionNumber: 1, content: `mutable-${id}` };
}

function assignCoreGraph(nodes: unknown[]): void {
  mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'arcaai-gen-consultation', source: 'department' });
  mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({
    id: 'wfdef-core-1',
    slug: 'arcaai-gen-consultation',
    paletteKey: 'core',
    graph: { version: 1, nodes, edges: [] },
  });
}

// The seeded shape (`28-workflow-library.ts`): a `core.agent` warm-start node, agent-referenced.
const CORE_PRESUMMARY_NODE = {
  id: 'n_presummary',
  type: 'core.agent',
  config: { agentRef: { slug: 'case-notes-pre-summary' }, execution: { lane: 'realtime', cadence: 'onStart' }, onError: 'skip' },
};
const CORE_FINALIZE_NODE = {
  id: 'n_finalize',
  type: 'core.agent',
  config: { agentRef: { slug: 'casenote-finalization' }, execution: { lane: 'durable', cadence: 'onEnd' }, onError: 'fail' },
};

describe('pre-summary tier-1a — a CORE-palette graph that declares pre-summary as a core.agent onStart node (TASK-932)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDepartmentRepository.findById.mockResolvedValue(null);
    mockPromptTemplateRepository.findAll.mockResolvedValue([]);
    mockPromptVersionRepository.findByVersionNumber.mockResolvedValue(null);
    mockPromptVersionRepository.findLatestVersion.mockResolvedValue(null);
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
      id === SYSTEM_DEFAULTS.preSummaryPromptId ? approvedTemplate(id) : null,
    );
  });

  it('falls through to the tenant default instead of failing closed — the tenant DID configure pre-summary, in the current vocabulary', async () => {
    assignCoreGraph([CORE_PRESUMMARY_NODE, CORE_FINALIZE_NODE]);

    const result = await buildService().resolve({ tenantId: TENANT, promptType: 'pre-summary' });

    expect(result.promptId).toBe(SYSTEM_DEFAULTS.preSummaryPromptId);
    expect(result.resolvedFrom).toBe('default');
    expect(result.resolutionTrace.configurationErrors?.join(' ')).toContain('core.agent');
  });

  it('still fails a governed tenant closed when its CORE graph declares NO pre-summary node at all', async () => {
    assignCoreGraph([CORE_FINALIZE_NODE]);

    await expect(buildService().resolve({ tenantId: TENANT, promptType: 'pre-summary' })).rejects.toThrow(/agent\.presummarization/);
  });

  it('a DISABLED core.agent onStart node is not a declaration — governed, incomplete, fails closed', async () => {
    assignCoreGraph([{ ...CORE_PRESUMMARY_NODE, config: { ...CORE_PRESUMMARY_NODE.config, enabled: false } }, CORE_FINALIZE_NODE]);

    await expect(buildService().resolve({ tenantId: TENANT, promptType: 'pre-summary' })).rejects.toThrow(/agent\.presummarization/);
  });
});
