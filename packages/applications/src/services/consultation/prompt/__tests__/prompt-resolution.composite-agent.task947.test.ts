/**
 * TASK-947 §4.6 item 2 / OD-9 — the two tiers that read an agent's bound template as a POINTER
 * learn the third instruction form.
 *
 * Both tiers ask the same question of an agent: "which governed template does this agent point
 * at?" — and both answered it by hand, with `instruction.promptTemplateId`. A COMPOSITE agent
 * carries no such field, so both would have fallen straight through and served the SYSTEM default
 * under the agent's name: the exact wrong-prompt class TASK-946 OD-5 had just closed for
 * `core.agent` nodes.
 *
 * The pointer rule is `primaryTemplateId` (`@arcaai/workflow-contract`): form 1 ⇒ the bound id,
 * form 3 ⇒ the FIRST UNCONDITIONAL TEMPLATE fragment, anything else ⇒ `null` and the tier falls
 * through exactly as it does today for an agent that binds no template. An UNCONDITIONAL INLINE
 * fragment ahead of it does not count — what these tiers want is a template ROW to govern, not
 * text — and a CONDITIONAL template fragment does not count either, because a tier that cannot
 * see the consultation's context cannot know whether its branch was taken.
 *
 * OD-9 deliberately stops there: what these tiers SERVE is unchanged (a template, by pointer,
 * re-read under the ordinary approval + snapshot discipline). Only the pointer's reader moved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptResolutionService, SYSTEM_DEFAULTS } from '../prompt-resolution.service';

const TENANT = 'tenant-947';
const DEPT = 'dept-947';
const BASE_TEMPLATE = '71000000-0000-0000-0947-000000000001';
const BRANCH_TEMPLATE = '71000000-0000-0000-0947-000000000002';
const APPROVED_VERSION = 3;
/** The fragment's OWN pin — deliberately different from the template's approved version. */
const FRAGMENT_PIN = 7;

const mockDepartmentRepository = { findById: vi.fn() };
const provisionedClone = async (_tenantId: string, sourceTemplateId: string) => ({ id: sourceTemplateId });
const mockPromptTemplateRepository = { findById: vi.fn(), findAll: vi.fn(), findByTenantAndSourceTemplateId: vi.fn(provisionedClone) };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };
const mockWorkflowAssignments = { resolve: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn() };
const mockAgentAssignments = { resolve: vi.fn() };
const mockAgentRepository = { findPublishedActiveBySlug: vi.fn() };

type Fragment = { key: string; promptTemplateId?: string; systemPrompt?: string; promptVersionNumber?: number; when?: string };

/** A form-3 instruction, exactly as `create-agent.request.ts` accepts it. */
const compositeInstruction = (fragments: Fragment[]) => ({ fragments, variables: {} });

const REVISIT = "has(context.visit_type) && context.visit_type == 'revisit'";

function approvedTemplate(id: string, approvedVersionNumber: number | null = APPROVED_VERSION) {
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
    mockAgentAssignments as never,
    mockAgentRepository as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDepartmentRepository.findById.mockResolvedValue({
    id: DEPT,
    tenantId: TENANT,
    defaultSummaryTemplate: null,
    promptConfig: null,
    newPatientPromptId: null,
    revisitPromptId: null,
  });
  mockPromptTemplateRepository.findByTenantAndSourceTemplateId.mockImplementation(provisionedClone);
  mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => approvedTemplate(id));
  mockPromptVersionRepository.findByVersionNumber.mockImplementation(async (templateId: string, versionNumber: number) => ({
    versionNumber,
    content: `v${versionNumber} body of ${templateId}`,
  }));
  mockPromptVersionRepository.findLatestVersion.mockResolvedValue({ versionNumber: 9, content: 'latest body' });
  mockWorkflowAssignments.resolve.mockResolvedValue(null);
  mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);
  mockAgentAssignments.resolve.mockResolvedValue({ agentSlug: null, source: 'platform-default', selector: [] });
  mockAgentRepository.findPublishedActiveBySlug.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Tier: the TAG-SELECTED agent (TASK-884, `resolveTagSelectedPrompt`)
// ---------------------------------------------------------------------------

describe('OD-9 — the tag-selected agent tier reads a COMPOSITE instruction as a pointer', () => {
  const selectTagged = (instruction: unknown) => {
    mockAgentAssignments.resolve.mockResolvedValue({ agentSlug: 'rheum-notes', source: 'tenant', selector: ['specialty:rheumatology'] });
    mockAgentRepository.findPublishedActiveBySlug.mockResolvedValue({ id: 'agent-rheum', versionNumber: 4, instruction });
    return buildService().resolve({
      tenantId: TENANT,
      departmentId: DEPT,
      promptType: 'new-patient',
      agentSelectorTags: ['specialty:rheumatology'],
    });
  };

  it('serves the FIRST UNCONDITIONAL TEMPLATE fragment`s template', async () => {
    const result = await selectTagged(
      compositeInstruction([
        { key: 'base', promptTemplateId: BASE_TEMPLATE, promptVersionNumber: FRAGMENT_PIN },
        { key: 'revisit', promptTemplateId: BRANCH_TEMPLATE, when: REVISIT },
      ]),
    );

    expect(result.resolvedFrom, 'a composite agent fell through and the SYSTEM default was served under its name').toBe('agent');
    expect(result.promptId).toBe(BASE_TEMPLATE);
    expect(result.resolvedAgentId).toBe('agent-rheum');
  });

  it('skips an unconditional INLINE fragment — the tier wants a template ROW to govern, not text', async () => {
    const result = await selectTagged(
      compositeInstruction([
        { key: 'preamble', systemPrompt: 'You are a rheumatology scribe.' },
        { key: 'base', promptTemplateId: BASE_TEMPLATE },
      ]),
    );

    expect(result.promptId).toBe(BASE_TEMPLATE);
    expect(result.resolvedFrom).toBe('agent');
  });

  it('falls through when EVERY template fragment is conditional', async () => {
    const result = await selectTagged(
      compositeInstruction([
        { key: 'preamble', systemPrompt: 'Always.' },
        { key: 'revisit', promptTemplateId: BRANCH_TEMPLATE, when: REVISIT },
      ]),
    );

    expect(result.promptId).toBe(SYSTEM_DEFAULTS.promptId);
    expect(result.resolvedFrom).toBe('default');
  });

  it('falls through for an INLINE-ONLY composite, exactly as it does for a form-2 agent', async () => {
    const result = await selectTagged(compositeInstruction([{ key: 'base', systemPrompt: 'Inline only.' }]));

    expect(result.promptId).toBe(SYSTEM_DEFAULTS.promptId);
    expect(result.resolvedFrom).toBe('default');
  });

  it('a form-1 agent is untouched — the same template, the same tier', async () => {
    const result = await selectTagged({ promptTemplateId: BASE_TEMPLATE });

    expect(result.promptId).toBe(BASE_TEMPLATE);
    expect(result.resolvedFrom).toBe('agent');
  });
});

// ---------------------------------------------------------------------------
// Tier: the per-turn `core.agent` node (TASK-946 OD-5, `resolveAgentNodePrompt`)
// ---------------------------------------------------------------------------

const REALTIME_PER_TURN = { lane: 'realtime', cadence: 'perTurn' };

/** One per-turn `core.agent` node bound to `summary-agent`, in the seeded authored shape. */
function graphWithSummaryAgent(nodeConfig: Record<string, unknown> = {}) {
  return {
    version: 1,
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: {} },
      {
        id: 'n_summary',
        type: 'core.agent',
        config: { agentRef: { slug: 'summary-agent' }, execution: REALTIME_PER_TURN, ...nodeConfig },
      },
    ],
    edges: [],
  };
}

describe('OD-9 — the per-turn `core.agent` tier reads a COMPOSITE instruction as a pointer', () => {
  const resolveLiveWith = (instruction: unknown, nodeConfig: Record<string, unknown> = {}) => {
    mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'arcaai-consultation', source: 'department' });
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({
      id: 'wf-1',
      slug: 'arcaai-consultation',
      paletteKey: 'core',
      graph: graphWithSummaryAgent(nodeConfig),
    });
    mockAgentRepository.findPublishedActiveBySlug.mockImplementation(async (_tenantId: string, slug: string) =>
      slug === 'summary-agent' ? { id: 'agent-summary', slug, versionNumber: 4, task: 'TEXT_GENERATION', instruction } : null,
    );
    return buildService().resolve({ promptType: 'live', tenantId: TENANT, departmentId: DEPT });
  };

  it('serves the FIRST UNCONDITIONAL TEMPLATE fragment`s template, at THAT fragment`s pin', async () => {
    const resolved = await resolveLiveWith(
      compositeInstruction([
        { key: 'base', promptTemplateId: BASE_TEMPLATE, promptVersionNumber: FRAGMENT_PIN },
        { key: 'revisit', promptTemplateId: BRANCH_TEMPLATE, promptVersionNumber: 2, when: REVISIT },
      ]),
    );

    expect(resolved.resolvedFrom).toBe('agent');
    expect(resolved.promptId).toBe(BASE_TEMPLATE);
    // The pin travels with the FRAGMENT — not the instruction root, which a composite has none of.
    expect(resolved.resolvedVersionNumber).toBe(FRAGMENT_PIN);
    expect(resolved.content).toBe(`v${FRAGMENT_PIN} body of ${BASE_TEMPLATE}`);
  });

  it('falls back to the template`s APPROVED version when the fragment carries no pin', async () => {
    const resolved = await resolveLiveWith(compositeInstruction([{ key: 'base', promptTemplateId: BASE_TEMPLATE }]));

    expect(resolved.promptId).toBe(BASE_TEMPLATE);
    expect(resolved.resolvedVersionNumber).toBe(APPROVED_VERSION);
  });

  it('a NODE-level pin still wins over the fragment`s own — the node is the more specific binding', async () => {
    const resolved = await resolveLiveWith(compositeInstruction([{ key: 'base', promptTemplateId: BASE_TEMPLATE, promptVersionNumber: FRAGMENT_PIN }]), {
      promptVersionNumber: 2,
    });

    expect(resolved.promptId).toBe(BASE_TEMPLATE);
    expect(resolved.resolvedVersionNumber).toBe(2);
  });

  it('skips an unconditional INLINE fragment and governs the first template one', async () => {
    const resolved = await resolveLiveWith(
      compositeInstruction([{ key: 'preamble', systemPrompt: 'Always.' }, { key: 'base', promptTemplateId: BASE_TEMPLATE }]),
    );

    expect(resolved.promptId).toBe(BASE_TEMPLATE);
    expect(resolved.resolvedFrom).toBe('agent');
  });

  it('falls through when EVERY template fragment is conditional', async () => {
    const resolved = await resolveLiveWith(
      compositeInstruction([
        { key: 'preamble', systemPrompt: 'Always.' },
        { key: 'revisit', promptTemplateId: BRANCH_TEMPLATE, when: REVISIT },
      ]),
    );

    expect(resolved.resolvedFrom).toBe('default');
    expect(resolved.promptId).toBe(SYSTEM_DEFAULTS.livePromptId);
  });

  it('falls through for an INLINE-ONLY composite, exactly as it does for a form-2 agent', async () => {
    const resolved = await resolveLiveWith(compositeInstruction([{ key: 'base', systemPrompt: 'Inline only.' }]));

    expect(resolved.resolvedFrom).toBe('default');
    expect(resolved.promptId).toBe(SYSTEM_DEFAULTS.livePromptId);
  });

  it('an UNAPPROVED fragment template is still skipped — governance is not waived by a fragment naming it', async () => {
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
      id === BASE_TEMPLATE ? { ...approvedTemplate(BASE_TEMPLATE), status: 'DRAFT' } : approvedTemplate(id),
    );

    const resolved = await resolveLiveWith(compositeInstruction([{ key: 'base', promptTemplateId: BASE_TEMPLATE }]));

    // Only this tier's template is DRAFT, so the ordinary live chain serves the approved SYSTEM
    // default — skipped, never served because a fragment named it.
    expect(resolved.resolvedFrom).toBe('default');
    expect(resolved.promptId).toBe(SYSTEM_DEFAULTS.livePromptId);
  });

  it('a form-1 agent is untouched — the same template, the same pin, the same tier', async () => {
    const resolved = await resolveLiveWith({ promptTemplateId: BASE_TEMPLATE, promptVersionNumber: FRAGMENT_PIN });

    expect(resolved.resolvedFrom).toBe('agent');
    expect(resolved.promptId).toBe(BASE_TEMPLATE);
    expect(resolved.resolvedVersionNumber).toBe(FRAGMENT_PIN);
  });
});
