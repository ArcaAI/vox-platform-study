/**
 * lane A, item 1 — PRE-SUMMARY resolves from the tenant's
 * `agent.presummarization` NODE, and its absence is SURFACED.
 *
 * ## What left behind, and what the owner ruled
 *
 * Retiring `DepartmentAgent` removed the pre-summary chain's tier-1a outright:
 * the tier used to read the department default agent's `preSummaryTemplateId`,
 * and its successor — a pre-summarization NODE — did not exist. The service says
 * so in its own words at the tier's grave marker: *"that node type does not exist
 * yet — it is in TARGET catalogue, not in `WORKFLOW_NODE_REGISTRY`"*.
 *
 * It exists now. The owner's ruling on the delta was explicit: the loss is
 * **"not accepted as a silent fallback"**, pre-summary **must be tenant tier**,
 * and a tenant **must configure an active pre-summarization agent node**.
 *
 * So two properties are asserted here:
 *
 * 1. A configured, ACTIVE `agent.presummarization` node SUPPLIES the pre-summary
 *    prompt, under the same approval + pin discipline every other node tier uses.
 * 2. Its absence is a CONFIGURATION ERROR that reaches the caller — named on the
 *    trace — rather than an invisible slide onto the platform default.
 *
 * ## The one place this stops short of the strictest reading, deliberately
 *
 * The strictest reading of "not a silent drop to a platform default" is that an
 * absent node should FAIL the request. That is not what is implemented, because
 * the SYSTEM-default tier behind it is reached by the FROZEN v1-compat route
 * (`TextCompatController` → `resolve({ tenantId, promptType: 'pre-summary' })`,
 * which passes no department and has never had an agent tier), and no tenant has
 * such a node on day one — so failing closed there would take out every
 * pre-summary on the platform, including the compat plane the fence protects.
 * The absence is therefore LOUD (an error-level log plus `trace.configurationErrors`)
 * rather than fatal. Flagged for the owner rather than decided silently.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptResolutionService, SYSTEM_DEFAULTS } from '../prompt-resolution.service';

const mockDepartmentRepository = { findById: vi.fn() };
// TASK-890 §3.4 (OD-M) — a `SYSTEM_DEFAULTS.*` pointer resolves the TENANT's clone of that
// platform template, matched on `sourceTemplateId`. These fixtures model a PROVISIONED tenant,
// where the clone stands in for the pointer, so the chain assertions below are unchanged; the
// unprovisioned case (`PROMPT_DEFAULT_NOT_PROVISIONED`) is pinned in
// `prompt-resolution.reference-set.task890.test.ts`.
const provisionedClone = async (_tenantId: string, sourceTemplateId: string) => ({ id: sourceTemplateId });
const mockPromptTemplateRepository = { findById: vi.fn(), findAll: vi.fn(), findByTenantAndSourceTemplateId: vi.fn(provisionedClone) };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };
const mockWorkflowAssignments = { resolve: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn() };

const TENANT = 'tenant-presum-001';
const PRESUM_TEMPLATE = '71000000-0000-0000-0806-000000000001';

function buildService(): PromptResolutionService {
  return new PromptResolutionService(
    mockDepartmentRepository as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    mockWorkflowAssignments as never,
    mockWorkflowDefinitionRepository as never,
  );
}

function approvedTemplate(id: string, approvedVersionNumber: number | null = 1) {
  return { id, status: 'APPROVED', approvedVersionNumber, currentVersionNumber: approvedVersionNumber, content: `mutable-${id}` };
}

function definitionWithNodes(nodes: unknown[]) {
  return { id: 'wfdef-1', slug: 'consultation-default', paletteKey: 'core', graph: { version: 1, nodes, edges: [] } };
}

function assignConsultationGraph(nodes: unknown[]): void {
  mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'consultation-default', source: 'tenant' });
  mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definitionWithNodes(nodes));
}

describe('pre-summary tier-1a — the agent.presummarization node', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDepartmentRepository.findById.mockResolvedValue(null);
    mockPromptTemplateRepository.findById.mockResolvedValue(null);
    mockPromptTemplateRepository.findAll.mockResolvedValue([]);
    mockPromptVersionRepository.findByVersionNumber.mockResolvedValue(null);
    mockPromptVersionRepository.findLatestVersion.mockResolvedValue(null);
    mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' });
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);
  });

  it('serves the pinned PromptVersion bound to the tenant`s active pre-summarization node', async () => {
    assignConsultationGraph([
      { id: 'note_writer', type: 'consultation.synthesize', config: { taskKey: 'text.finalize', promptTemplateId: 'other' } },
      { id: 'pre_sum', type: 'agent.presummarization', config: { promptTemplateId: PRESUM_TEMPLATE, promptVersionNumber: 5 } },
    ]);
    mockPromptTemplateRepository.findById.mockResolvedValue(approvedTemplate(PRESUM_TEMPLATE, 9));
    mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 5, content: 'PRE-SUMMARY PROMPT v5' });

    const result = await buildService().resolve({ tenantId: TENANT, promptType: 'pre-summary' });

    expect(result.promptId).toBe(PRESUM_TEMPLATE);
    expect(result.content).toBe('PRE-SUMMARY PROMPT v5');
    // The NODE's own pin (5) wins over the template's approvedVersionNumber (9) — DD-11.
    expect(result.resolvedVersionNumber).toBe(5);
    expect(result.resolvedAgentId).toBe('pre_sum');
    expect(result.resolvedCapability).toBe('pre-summary');
    expect(result.resolutionTrace.configurationErrors ?? []).toEqual([]);
  });

  it('IGNORES a pre-summarization node the tenant has switched OFF, and says so', async () => {
    // `config.enabled === false` is the platform-wide "authored, but off" convention
    // (`realtime-lane.ts` reads exactly this key). An inactive node is not a configured one.
    //
    // Lane R (R2) changed the CONSEQUENCE, not this property: the tenant here governs
    // consultations, so an inactive node is now an incomplete opinion and fails closed rather
    // than sliding onto the platform default. What has not changed — and is the half that
    // matters — is that the switched-off node's template is never served.
    assignConsultationGraph([{ id: 'pre_sum', type: 'agent.presummarization', config: { promptTemplateId: PRESUM_TEMPLATE, enabled: false } }]);
    mockPromptTemplateRepository.findById.mockResolvedValue(approvedTemplate(PRESUM_TEMPLATE, 1));

    await expect(buildService().resolve({ tenantId: TENANT, promptType: 'pre-summary' })).rejects.toThrow(/agent\.presummarization/);
    // The disabled node's template never became the answer by another route.
    expect(mockPromptVersionRepository.findLatestVersion).not.toHaveBeenCalled();
  });

  it('SURFACES the absence of a configured node rather than sliding onto the platform default', async () => {
    // The SYSTEM default is approved, so the chain still RESOLVES — which is the point: the
    // absence has to be visible even on the path that succeeds.
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
      id === SYSTEM_DEFAULTS.preSummaryPromptId ? approvedTemplate(id, 1) : null,
    );

    const result = await buildService().resolve({ tenantId: TENANT, promptType: 'pre-summary' });

    expect(result.promptId).toBe(SYSTEM_DEFAULTS.preSummaryPromptId);
    expect(result.resolvedFrom).toBe('default');
    expect(result.resolutionTrace.configurationErrors?.join(' ')).toContain('agent.presummarization');
  });

  it('does not consult the department — pre-summary has no department axis', async () => {
    assignConsultationGraph([{ id: 'pre_sum', type: 'agent.presummarization', config: { promptTemplateId: PRESUM_TEMPLATE } }]);
    mockPromptTemplateRepository.findById.mockResolvedValue(approvedTemplate(PRESUM_TEMPLATE, 1));
    mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 1, content: 'PRE-SUMMARY PROMPT v1' });

    await buildService().resolve({ tenantId: TENANT, departmentId: 'dept-should-be-ignored', promptType: 'pre-summary' });

    expect(mockWorkflowAssignments.resolve).toHaveBeenCalledWith(TENANT, 'core', null);
  });
});

/**
 * Lane R (R2) — the owner's ruling made ENFORCEABLE, on the only population where enforcing it
 * cannot break anyone.
 *
 * says an absent/inactive pre-summarization node is "a configuration error to surface, not a
 * silent drop to a platform default". Making that FATAL for every tenant is still not safe, and
 * seeding the node did not make it safe: `WorkflowDefinition` is deliberately excluded from
 * `SYSTEM_SHARED_READ_MODELS` and the assignment cascade is department -> tenant -> null, so a
 * tenant reads only its OWN definitions. There is no platform-default consultation graph that
 * every tenant inherits, which means a blanket fail-closed would take out pre-summary for every
 * tenant that has not authored a consultation workflow — the compat plane included.
 *
 * The distinction that IS safe, and is what the ruling actually describes:
 *
 *  - a tenant with NO governing consultation graph has not adopted the substrate. It expressed no
 *    opinion, so the platform default applies. That is tenant -> SYSTEM working correctly.
 *  - a tenant WITH a governing consultation graph that omits or disables the node has expressed
 *    an INCOMPLETE opinion. That is a misconfiguration its own admin created, and serving the
 * platform default there is exactly the silent drop refuses.
 */
describe('Lane R (R2) — an incomplete GOVERNING graph fails closed; an absent one does not', () => {
  beforeEach(() => {
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
      id === SYSTEM_DEFAULTS.preSummaryPromptId ? approvedTemplate(id, 1) : null,
    );
    mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 1, content: 'system default body' });
  });

  it('THROWS when the tenant governs consultations but its graph has no pre-summarization node', async () => {
    assignConsultationGraph([{ id: 'n_synth', type: 'consultation.synthesize', config: {} }]);

    await expect(buildService().resolve({ tenantId: TENANT, promptType: 'pre-summary' })).rejects.toThrow(/agent\.presummarization/);
  });

  it('THROWS when the node is present but switched OFF — a disabled node is an expressed opinion', async () => {
    assignConsultationGraph([{ id: 'pre_sum', type: 'agent.presummarization', config: { promptTemplateId: PRESUM_TEMPLATE, enabled: false } }]);

    await expect(buildService().resolve({ tenantId: TENANT, promptType: 'pre-summary' })).rejects.toThrow(/agent\.presummarization/);
  });

  it('THROWS when the node is present but binds no prompt template', async () => {
    assignConsultationGraph([{ id: 'pre_sum', type: 'agent.presummarization', config: {} }]);

    await expect(buildService().resolve({ tenantId: TENANT, promptType: 'pre-summary' })).rejects.toThrow(/agent\.presummarization/);
  });

  it('does NOT throw for a tenant with no governing consultation graph — no opinion is not a defect', async () => {
    // The compat plane's population, and every tenant that has not adopted the substrate. Still
    // surfaced on the trace; still not lethal.
    mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' });

    const result = await buildService().resolve({ tenantId: TENANT, promptType: 'pre-summary' });

    expect(result.promptId).toBe(SYSTEM_DEFAULTS.preSummaryPromptId);
    expect(result.resolvedFrom).toBe('default');
    expect(result.resolutionTrace.configurationErrors?.join(' ')).toContain('agent.presummarization');
  });

  it('does NOT throw when the assignment names a slug with no PUBLISHED definition', async () => {
    // A rotted reference is an operational problem, not a tenant declaring an incomplete graph —
    // and `WorkflowAssignmentService` already logs and degrades on exactly this.
    mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'gone', source: 'tenant' });
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);

    await expect(buildService().resolve({ tenantId: TENANT, promptType: 'pre-summary' })).resolves.toMatchObject({
      promptId: SYSTEM_DEFAULTS.preSummaryPromptId,
    });
  });
});
