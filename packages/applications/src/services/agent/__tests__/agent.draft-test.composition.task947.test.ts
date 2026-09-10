/**
 * TASK-947 (OD-11) — the draft bench SHOWS which branch ran.
 *
 * The bench's whole value is that it assembles a draft through the identical path publish and
 * the invocation route use; a composite agent makes that stronger, not weaker. An author who
 * writes a `when` needs two things from a dry run: the bytes the model would receive
 * (`assembledSystemPrompt`, COMPOSED — not the static projection), and WHY a fragment they
 * expected is missing (`composition.excluded[].reason`).
 *
 * Keys and reasons only. A fragment body and a condition string are authored clinical text; the
 * body is already in `assembledSystemPrompt` when it was selected, and a fragment that was NOT
 * selected has no business putting its text in a response.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentService } from '../agent.service';

const TENANT = '50000000-0000-0000-0000-000000000000';

const clsStore: Record<string, unknown> = { tenantId: TENANT, user: { id: 'user-1', roles: [] } };
const mockClsService = {
  get: vi.fn((key: string) => clsStore[key]),
  set: vi.fn(),
  run: vi.fn(async (_options: unknown, work: () => unknown) => work()),
};
const mockEventEmitter = { emit: vi.fn() };
const mockAgentRepository = { findByIdVisible: vi.fn(), findPublishedActiveBySlug: vi.fn(async () => null) };
const mockFallbackRepository = { findByAgentId: vi.fn(async () => []) };
const LLM_MODEL = {
  id: 'model-llm',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'lms-gemma-4-e2b-it-qat',
  taskType: 'TEXT_GENERATION',
  provider: 'lm-studio',
  sourceUri: 'gemma-4-e2b-it-qat',
  wireModelId: 'gemma-4-e2b-it-qat',
  resourceStatus: ResourceStatusType.ENABLED,
  metaData: null,
};
const mockAiModelRepository = { findById: vi.fn(async () => LLM_MODEL), findByTaskTypeSharedRead: vi.fn(async () => []) };
const mockPromptTemplateRepository = { findById: vi.fn(async () => null) };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(async () => null) };
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockProviderConnections = {
  resolveConnection: vi.fn(async () => ({ source: 'system', encryptedApiKey: new Uint8Array([1]) })),
  findRow: vi.fn(async () => null),
};

/** An all-inline composite — the bench path is about SELECTION, not template resolution. */
function compositeAgent(fragments: Array<{ key: string; systemPrompt: string; when?: string }>, variables?: Record<string, unknown>) {
  return {
    id: 'agent-1',
    tenantId: TENANT,
    slug: 'clinic-summarizer',
    name: 'Clinic summarizer',
    description: null,
    task: AgentTask.TEXT_GENERATION,
    versionNumber: 1,
    status: WorkflowDefinitionStatus.DRAFT,
    isActive: false,
    modelId: 'model-llm',
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    instruction: { fragments, ...(variables ? { variables } : {}) },
    parameters: null,
    inputSchema: null,
    outputSchema: null,
    tools: null,
    tags: [],
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    resourceStatus: ResourceStatusType.ENABLED,
    validate: vi.fn(),
  } as never;
}

function makeService() {
  return new AgentService(
    mockAgentRepository as never,
    mockFallbackRepository as never,
    mockAiModelRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    undefined as never,
    mockProviderConnections as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clsStore.tenantId = TENANT;
  clsStore.user = { id: 'user-1', roles: [] };
  mockClsService.get.mockImplementation((key: string) => clsStore[key]);
  mockAiModelRepository.findById.mockResolvedValue(LLM_MODEL);
  mockFallbackRepository.findByAgentId.mockResolvedValue([]);
});

describe('testDraft composes, and reports the composition (OD-11)', () => {
  it('assembles the SELECTED fragments — not the static projection — and lists what ran', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      compositeAgent([
        { key: 'base', systemPrompt: 'You are a scribe for {{context.clinic}}.' },
        { key: 'revisit', systemPrompt: 'This is a follow-up.', when: "context.visit_type == 'revisit'" },
      ]),
    );

    const ack = await makeService().testDraft('agent-1', { context: { clinic: 'Ward B', visit_type: 'revisit' } });

    expect(ack.assembledSystemPrompt).toBe('You are a scribe for Ward B.\n\nThis is a follow-up.');
    expect(ack.composition).toEqual({ selected: ['base', 'revisit'], excluded: [] });
  });

  it('names an excluded fragment and WHY — a false condition', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      compositeAgent([
        { key: 'base', systemPrompt: 'BASE' },
        { key: 'revisit', systemPrompt: 'REVISIT', when: "context.visit_type == 'revisit'" },
      ]),
    );

    const ack = await makeService().testDraft('agent-1', { context: { visit_type: 'new' } });

    expect(ack.assembledSystemPrompt).toBe('BASE');
    expect(ack.composition).toEqual({ selected: ['base'], excluded: [{ key: 'revisit', reason: 'condition_false' }] });
  });

  it('names an excluded fragment whose condition could not be EVALUATED, with the detail (OD-5)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      compositeAgent([
        { key: 'base', systemPrompt: 'BASE' },
        { key: 'peds', systemPrompt: 'PEDS', when: 'context.patient_age < 18' },
      ]),
    );

    const ack = await makeService().testDraft('agent-1', { context: {} });

    expect(ack.assembledSystemPrompt).toBe('BASE');
    expect(ack.composition?.selected).toEqual(['base']);
    expect(ack.composition?.excluded[0]).toMatchObject({ key: 'peds', reason: 'condition_error' });
    expect(ack.composition?.excluded[0].detail).toBeTruthy();
  });

  it('evaluates a `when` against the bare BOUND names, exactly as the templates render them', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      compositeAgent(
        [
          { key: 'base', systemPrompt: 'BASE' },
          { key: 'ward3', systemPrompt: 'WARD3', when: "ward == '3'" },
        ],
        { ward: { path: 'context.ward' } },
      ),
    );

    const ack = await makeService().testDraft('agent-1', { context: { ward: '3' } });
    expect(ack.composition?.selected).toEqual(['base', 'ward3']);
  });

  it('refuses with a named 400 when nothing is selected (OD-6 defensive half)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      compositeAgent([{ key: 'revisit', systemPrompt: 'REVISIT', when: "context.visit_type == 'revisit'" }]),
    );

    // The composition itself is refused BEFORE the empty-selection check could bite: publish's
    // `PROMPT_COMPOSITION_NO_BASE` is blocking, and the bench runs the same gate.
    await expect(makeService().testDraft('agent-1', { context: { visit_type: 'new' } })).rejects.toMatchObject({
      response: { code: 'PROMPT_COMPOSITION_NO_BASE' },
    });
  });

  it('carries NO `composition` for the two pre-947 forms', async () => {
    const inlineAgent = compositeAgent([]);
    (inlineAgent as unknown as { instruction: unknown }).instruction = { systemPrompt: 'Scribe for {{context.clinic}}.' };
    mockAgentRepository.findByIdVisible.mockResolvedValue(inlineAgent);

    const ack = await makeService().testDraft('agent-1', { context: { clinic: 'Ward B' } });

    expect(ack.assembledSystemPrompt).toBe('Scribe for Ward B.');
    expect(ack.composition).toBeUndefined();
  });

  it('R2 L-5 — the exclusion `detail` never echoes a SCOPE VALUE, only the evaluator`s shape of the problem', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      compositeAgent([
        { key: 'base', systemPrompt: 'BASE' },
        { key: 'parsed', systemPrompt: 'P', when: 'int(context.patient_name) > 5' },
        { key: 'keyed', systemPrompt: 'K', when: 'context[context.mrn] == 1' },
      ]),
    );

    const ack = await makeService().testDraft('agent-1', { context: { patient_name: 'Jane Doe', mrn: 'MRN-4471' } });

    const details = (ack.composition?.excluded ?? []).map((exclusion) => exclusion.detail ?? '');
    expect(details).toHaveLength(2);
    for (const detail of details) expect(detail).toBeTruthy();
    expect(JSON.stringify(ack)).not.toContain('Jane Doe');
    expect(JSON.stringify(ack)).not.toContain('MRN-4471');
  });
});
