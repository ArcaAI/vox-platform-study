/**
 * TASK-890 §3.8 / §3.13 (L8) — the draft-agent test bench.
 *
 * What these tests are actually pinning:
 *
 *  1. **A dry run costs nothing.** It is the DEFAULT, it generates nothing and it meters nothing
 *     — that is the whole reason an author would use it to find out what their prompt renders to.
 *  2. **A non-dry run is ordinary tenant spend.** The quota precheck happens BEFORE the upstream
 *     call (a run refused for quota must never have reached TEXT), and finalize records
 *     `generate.stream` with `trigger: 'AGENT_TEST'` so the spend is attributable to the bench
 *     rather than to a consultation.
 *  3. **The bench compiles the draft through the SAME path publish uses**, so a blocking finding
 *     refuses the test with the identical shape the console already renders.
 *  4. **The frozen context schema is ENFORCING** (orchestrator decision, TASK-859 invariant 3): a
 *     call omitting a required context kind is refused, and the refusal NAMES what is missing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentService } from '../agent.service';
import { AgentDraftTestService } from '../agent-draft-test.service';

const TENANT = '50000000-0000-0000-0000-000000000000';

const clsStore: Record<string, unknown> = { tenantId: TENANT, user: { id: 'user-1', roles: [] } };
const mockClsService = {
  get: vi.fn((key: string) => clsStore[key]),
  set: vi.fn((key: string, value: unknown) => {
    clsStore[key] = value;
  }),
  run: vi.fn(async (_options: unknown, work: () => unknown) => work()),
};
const mockEventEmitter = { emit: vi.fn() };
const mockAgentRepository = { findByIdVisible: vi.fn(), findPublishedActiveBySlug: vi.fn() };
const mockFallbackRepository = { findByAgentId: vi.fn(async () => []) };
const LLM_MODEL = {
  id: 'model-llm',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'lms-gemma-4-e2b-it-qat',
  taskType: 'TEXT_GENERATION',
  provider: 'lm-studio',
  sourceUri: 'gemma-4-e2b-it-qat',
  resourceStatus: ResourceStatusType.ENABLED,
  metaData: null,
};
const mockAiModelRepository = { findById: vi.fn(async () => LLM_MODEL), findByTaskTypeSharedRead: vi.fn(async () => []) };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn() };
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockProviderConnections = {
  resolveConnection: vi.fn(async () => ({ source: 'system', encryptedApiKey: new Uint8Array([1]) })),
  findRow: vi.fn(async () => null),
};
const mockContextSchemas = { resolveReference: vi.fn() };
const mockDraftTest = { submit: vi.fn(), finalize: vi.fn() };

function agent(overrides: Record<string, unknown> = {}) {
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
    instruction: { systemPrompt: 'You are a scribe for {{context.clinic}}.' },
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
    ...overrides,
  } as never;
}

/** An APPROVED, version-pinned template — the only instruction shape `variables` may ride on. */
function bindTemplate(content: string): void {
  mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-1', name: 'SOAP', status: 'APPROVED', content, approvedVersionNumber: 1 });
  mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 1, content });
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
    undefined as never,
    undefined as never,
    mockContextSchemas as never,
    undefined as never,
    mockDraftTest as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clsStore.tenantId = TENANT;
  clsStore.user = { id: 'user-1', roles: [] };
  mockClsService.get.mockImplementation((key: string) => clsStore[key]);
  mockClsService.run.mockImplementation(async (_options: unknown, work: () => unknown) => work());
  mockAiModelRepository.findById.mockResolvedValue(LLM_MODEL);
  mockFallbackRepository.findByAgentId.mockResolvedValue([]);
  mockProviderConnections.resolveConnection.mockResolvedValue({ source: 'system', encryptedApiKey: new Uint8Array([1]) });
  mockDraftTest.submit.mockResolvedValue({ taskId: 'task-1', streamUrl: 'text/tasks/task-1/stream' });
});

describe('testDraft — dry run (the default)', () => {
  it('renders both prompts over the §3.3 scope, resolves the target, and generates NOTHING', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
    const ack = await makeService().testDraft('agent-1', {
      context: { clinic: 'Ward B' },
      input: { text: 'Summarise {{input.note}}', note: 'the visit' },
    });

    expect(ack.mode).toBe('dry-run');
    expect(ack.assembledSystemPrompt).toBe('You are a scribe for Ward B.');
    expect(ack.assembledUserPrompt).toBe('Summarise the visit');
    expect(ack.taskId).toBeUndefined();
    expect(mockDraftTest.submit).not.toHaveBeenCalled();
  });

  it('resolves the target off the agent`s own row, with a DERIVED funding tier', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
    const ack = await makeService().testDraft('agent-1', { context: { clinic: 'Ward B' } });
    // `platform` because the credential that would serve the call resolved from the SYSTEM tier.
    expect(ack.resolved).toEqual({ provider: 'lm-studio', model: 'gemma-4-e2b-it-qat', fundingTier: 'platform', source: 'row' });
  });

  it('takes a caller `{provider, model}` pair verbatim and marks the target `override`', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
    const ack = await makeService().testDraft('agent-1', { context: { clinic: 'Ward B' }, provider: 'azure-openai', model: 'gpt-5.4-mini' });
    expect(ack.resolved).toMatchObject({ provider: 'azure-openai', model: 'gpt-5.4-mini', source: 'override' });
  });

  it('refuses a PARTIAL provider/model override', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
    await expect(makeService().testDraft('agent-1', { provider: 'azure-openai' })).rejects.toMatchObject({
      response: { code: 'PROVIDER_MODEL_PAIR' },
    });
  });

  it('answers 400 NAMING the path when a prompt variable does not resolve', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
    await expect(makeService().testDraft('agent-1', {})).rejects.toMatchObject({
      response: { code: 'PROMPT_VARIABLE_UNRESOLVED', path: 'context.clinic' },
    });
  });

  it('resolves an `instruction.variables` `{ path }` binding before the bare-name overlay', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({ instruction: { promptTemplateId: 'tpl-1', promptVersionNumber: 1, variables: { tone: { path: 'context.style' } } } }),
    );
    bindTemplate('Tone: {{tone}} / {{context.style}}');
    const ack = await makeService().testDraft('agent-1', { context: { style: 'concise' } });
    expect(ack.assembledSystemPrompt).toBe('Tone: concise / concise');
  });

  it('lets the caller`s `variables` win over the agent`s own binding', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({ instruction: { promptTemplateId: 'tpl-1', promptVersionNumber: 1, variables: { tone: { value: 'formal' } } } }),
    );
    bindTemplate('Tone: {{tone}}');
    const ack = await makeService().testDraft('agent-1', { variables: { tone: 'blunt' } });
    expect(ack.assembledSystemPrompt).toBe('Tone: blunt');
  });
});

describe('testDraft — the gates', () => {
  it('refuses a PUBLISHED row with 409 and points at the invocation route', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ status: WorkflowDefinitionStatus.PUBLISHED }));
    await expect(makeService().testDraft('agent-1', {})).rejects.toBeInstanceOf(ConflictException);
  });

  it('a foreign (or SYSTEM) row is 404, never 403', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ tenantId: SYSTEM_TENANT_ID }));
    await expect(makeService().testDraft('agent-1', {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses with the findings when compiling the draft blocks (the same shape publish answers)', async () => {
    mockAiModelRepository.findById.mockResolvedValue({ ...LLM_MODEL, resourceStatus: ResourceStatusType.DISABLED });
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
    await expect(makeService().testDraft('agent-1', { context: { clinic: 'x' } })).rejects.toMatchObject({
      response: { code: 'MODEL_DISABLED', findings: expect.any(Array) },
    });
  });

  it('refuses a context payload that omits a REQUIRED kind of the frozen schema, naming it', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ contextSchemaId: 'schema-1', instruction: { systemPrompt: 'hi' } }));
    mockContextSchemas.resolveReference.mockResolvedValue({
      outcome: 'resolved',
      schemaId: 'schema-1',
      versionNumber: 1,
      versionId: 'schema-1-v1',
      payloadSchema: { type: 'object', required: ['visit'], properties: { visit: { type: 'object' } } },
    });
    await expect(makeService().testDraft('agent-1', { context: {} })).rejects.toMatchObject({
      response: { code: 'CONTEXT_SCHEMA_VIOLATION', findings: expect.arrayContaining([expect.stringContaining('visit')]) },
    });
  });

  it('a non-TEXT_GENERATION draft answers dry-run only', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ task: AgentTask.TEXT_TO_SPEECH, instruction: null, parameters: null }));
    mockAiModelRepository.findById.mockResolvedValue({ ...LLM_MODEL, taskType: 'TEXT_TO_SPEECH', provider: 'built-in', availability: 'AVAILABLE' });
    await expect(makeService().testDraft('agent-1', { dryRun: false })).rejects.toMatchObject({ response: { code: 'DRY_RUN_ONLY' } });
  });
});

describe('testDraft — a non-dry run', () => {
  it('submits through the transport, carrying the agent`s guardrail decision', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ parameters: { guards: { enabled: false } } }));
    const ack = await makeService().testDraft('agent-1', { dryRun: false, context: { clinic: 'Ward B' } });

    expect(ack).toMatchObject({ mode: 'stream', taskId: 'task-1', streamUrl: 'text/tasks/task-1/stream' });
    expect(mockDraftTest.submit).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, provider: 'lm-studio', model: 'gemma-4-e2b-it-qat', guardrailEnabled: false }),
    );
  });

  it('finalize re-checks the agent (a taskId alone is not authorisation) and delegates the read-back', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
    mockDraftTest.finalize.mockResolvedValue({ output: 'done', provider: 'lm-studio', model: 'gemma', usage: null });
    const result = await makeService().finalizeDraftTest('agent-1', { taskId: 'task-1' });
    expect(result.output).toBe('done');
    expect(mockDraftTest.finalize).toHaveBeenCalledWith(TENANT, 'task-1');
  });
});

/**
 * The transport half. `AgentDraftTestService` is what actually spends money, so the two things
 * worth pinning are the ORDER of the precheck and the CONTENT of the ledger row.
 */
describe('AgentDraftTestService — metering (§3.13, OD-E)', () => {
  const post = vi.fn();
  const get = vi.fn();
  const httpService = { axiosRef: { post, get } };
  const configService = { get: vi.fn(() => 'http://text.test') };
  const entitlements = { assertMeterQuota: vi.fn() };
  const usageLedger = { recordUsage: vi.fn() };
  const cls = { get: vi.fn(() => TENANT) };

  function makeTransport() {
    return new AgentDraftTestService(
      cls as never,
      httpService as never,
      configService as never,
      undefined as never,
      undefined as never,
      entitlements as never,
      usageLedger as never,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    configService.get.mockReturnValue('http://text.test');
    cls.get.mockReturnValue(TENANT);
  });

  it('prechecks `monthlyLlmTokens` BEFORE it posts to TEXT', async () => {
    entitlements.assertMeterQuota.mockRejectedValue(new Error('quota exceeded'));
    await expect(
      makeTransport().submit({ tenantId: TENANT, prompt: 'p', systemPrompt: null, provider: 'lm-studio', model: 'gemma', guardrailEnabled: true }),
    ).rejects.toThrow('quota exceeded');
    expect(post).not.toHaveBeenCalled();
  });

  it('records `generate.stream` with `trigger: AGENT_TEST` from TEXT`s own usage block', async () => {
    get.mockResolvedValue({
      data: {
        status: 'completed',
        content: 'the summary',
        provider: 'lm-studio',
        model: 'gemma',
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        usage_detail: {
          endpoint_kind: 'lmstudio.chat',
          task_id: 'task-1',
          provider: 'lm-studio',
          model: 'gemma',
          prompt_tokens: 11,
          completion_tokens: 7,
          occurred_at: '2026-09-06T00:00:00.000Z',
        },
      },
    });
    const outcome = await makeTransport().finalize(TENANT, 'task-1');
    expect(outcome.output).toBe('the summary');
    expect(usageLedger.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        common: expect.objectContaining({ operation: 'generate.stream', attributesJson: expect.objectContaining({ trigger: 'AGENT_TEST' }) }),
      }),
    );
  });

  it('refuses to finalize a task that has not completed, naming the state', async () => {
    get.mockResolvedValue({ data: { status: 'running' } });
    await expect(makeTransport().finalize(TENANT, 'task-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(usageLedger.recordUsage).not.toHaveBeenCalled();
  });

  it('records NOTHING when TEXT reported no usage block (never a row saying nothing happened)', async () => {
    get.mockResolvedValue({ data: { status: 'completed', content: 'x', provider: 'lm-studio', model: 'gemma' } });
    await makeTransport().finalize(TENANT, 'task-1');
    expect(usageLedger.recordUsage).not.toHaveBeenCalled();
  });
});
