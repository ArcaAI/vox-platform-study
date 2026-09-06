/**
 * TASK-863 — AgentService unit tests. Mock the repositories, EventEmitter2, ClsService, the
 * database service (version-mint transaction) and the provider-connection port; assert factory
 * usage on create, `broadcastSysEvent` on every mutation, 404-over-403, and — the part unique
 * to this service — that publish FAILS CLOSED: an unavailable model, an unapproved template or a
 * task/model mismatch is refused with a coded finding, never published.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, SysEventType, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentService } from '../agent.service';

const TENANT = '50000000-0000-0000-0000-000000000000';
const OTHER = '50000000-0000-0000-0000-000000000009';

/**
 * A CLS stub that actually MODELS `run({ ifNested: 'inherit' })`: the store is copied, the step
 * may overwrite `tenantId`, and the parent's value is restored when it returns. A stub that
 * ignored `run` would make every `runInTenantContext` assertion vacuous — which is exactly the
 * shape of the H-6 defect this file now pins (the old portability fixture could not fail).
 */
const clsStore: Record<string, unknown> = {};
const mockClsService = {
  get: vi.fn((key: string) => clsStore[key]),
  set: vi.fn((key: string, value: unknown) => {
    clsStore[key] = value;
  }),
  run: vi.fn(async (_options: unknown, work: () => unknown) => {
    const snapshot = { ...clsStore };
    try {
      return await work();
    } finally {
      for (const key of Object.keys(clsStore)) delete clsStore[key];
      Object.assign(clsStore, snapshot);
    }
  }),
};
const mockEventEmitter = { emit: vi.fn() };
const mockAgentRepository = {
  findByIdVisible: vi.fn(),
  findAllForTenant: vi.fn(),
  findPublishedActiveVisible: vi.fn(),
  findPublishedActiveBySlug: vi.fn(),
  // TASK-890 L13 — the reference-library reads that replaced the shared-read widening.
  findSystemReferences: vi.fn(async () => []),
  findSystemReferenceBySlug: vi.fn(async () => null),
  findOwnActiveBySlug: vi.fn(),
  findAllVersionsBySlug: vi.fn(),
  findMaxVersionNumber: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
};
const mockFallbackRepository = { findByAgentId: vi.fn(async () => []), create: vi.fn(async (e: unknown) => e), deleteAllForAgent: vi.fn() };
const mockAiModelRepository = { findById: vi.fn(), findByIdOrNull: vi.fn(), findBySlug: vi.fn(), findByTaskTypeSharedRead: vi.fn(async () => []) };
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockAssignments = { resolve: vi.fn(async () => ({ agentSlug: null, source: 'platform-default' })) };
const KEYED = new Uint8Array([1, 2, 3]);
const mockProviderConnections = { resolveConnection: vi.fn(), findRow: vi.fn(), resolveTenantCloudOverrides: vi.fn() };
const mockContextSchemas = { resolveReference: vi.fn() };
const mockReadiness = { getSnapshot: vi.fn(async () => null) };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn() };

const LLM_MODEL = {
  id: 'model-llm',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'lms-gemma-4-e2b-it-qat',
  taskType: 'TEXT_GENERATION',
  provider: 'lm-studio',
  // TASK-890 §3.1 — routing sends `wireModelId`, so a `cloud-*` / `engine-served` row that
  // declares none is refused at publish (`MODEL_UNAVAILABLE`) instead of resolving no candidate
  // at run time. Every engine/cloud fixture in this file therefore carries one.
  wireModelId: 'gemma-4-e2b-it-qat',
  resourceStatus: ResourceStatusType.ENABLED,
  metaData: null,
};
const ASR_MODEL = {
  id: 'model-asr',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'nemotron-3.5-asr-streaming-0.6b',
  taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
  provider: 'built-in',
  // TASK-890 — the publish gate reads the MEASURED availability now that the
  // download bookkeeping columns are gone. UNKNOWN is what a freshly seeded
  // self-hosted row carries until the inventory job confirms its weights.
  availability: 'UNKNOWN',
  resourceStatus: ResourceStatusType.ENABLED,
  metaData: null,
};
const STAGED_ASR = { ...ASR_MODEL, id: 'model-asr-staged', slug: 'arcaai-whisper-large-ml-en-gguf', availability: 'AVAILABLE' };
const AZURE_LLM = { ...LLM_MODEL, id: 'model-azure', slug: 'azure-gpt-5.4-mini', provider: 'azure' };

function agent(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    id: 'agent-1',
    tenantId: TENANT,
    slug: 'clinic-summarizer',
    name: 'Clinic summarizer',
    description: null,
    task: AgentTask.TEXT_GENERATION,
    versionNumber: 1,
    parentVersionId: null,
    status: WorkflowDefinitionStatus.DRAFT,
    isActive: false,
    modelId: 'model-llm',
    instruction: { systemPrompt: 'You are a clinical scribe.' },
    parameters: { generation: { temperature: 0.2 } },
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: null,
    compiledConfigChecksum: null,
    validationReport: null,
    validatedAt: null,
    publishedAt: null,
    deprecatedAt: null,
    resourceStatus: ResourceStatusType.ENABLED,
    tags: [],
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    updatedBy: null,
    hasChanges: true,
    validate: vi.fn(),
    ...overrides,
  };
  return base as never;
}

function makeService() {
  return new AgentService(
    mockAgentRepository as never,
    mockFallbackRepository as never,
    mockAiModelRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    mockAssignments as never,
    mockProviderConnections as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    undefined as never,
    undefined as never,
    mockContextSchemas as never,
    mockReadiness as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(clsStore)) delete clsStore[key];
  clsStore.tenantId = TENANT;
  clsStore.user = { id: 'user-1', roles: [] };
  mockClsService.get.mockImplementation((key: string) => clsStore[key]);
  mockClsService.set.mockImplementation((key: string, value: unknown) => {
    clsStore[key] = value;
  });
  mockClsService.run.mockImplementation(async (_options: unknown, work: () => unknown) => {
    const snapshot = { ...clsStore };
    try {
      return await work();
    } finally {
      for (const key of Object.keys(clsStore)) delete clsStore[key];
      Object.assign(clsStore, snapshot);
    }
  });
  // TASK-890 §3.7 — an engine-served row is usable when its SYSTEM connection is ENABLED, so the
  // publish gate now consults the connection plane for EVERY class except `platform-self-host`.
  // The happy default is a resolved, keyed connection; the cases that care override it.
  mockProviderConnections.resolveConnection.mockResolvedValue({ source: 'system', encryptedApiKey: KEYED });
  mockProviderConnections.findRow.mockResolvedValue(null);
  mockContextSchemas.resolveReference.mockResolvedValue({ outcome: 'failed', failure: 'CONTEXT_SCHEMA_NOT_FOUND' });
  mockReadiness.getSnapshot.mockResolvedValue(null);
  mockAiModelRepository.findById.mockImplementation(async (id: string) => {
    if (id === 'model-llm') return LLM_MODEL;
    if (id === 'model-asr') return ASR_MODEL;
    if (id === 'model-azure') return AZURE_LLM;
    if (id === 'model-asr-staged') return STAGED_ASR;
    throw new Error('not found');
  });
  mockAiModelRepository.findByIdOrNull.mockImplementation(async (id: string) => {
    if (id === 'model-llm') return LLM_MODEL;
    if (id === 'model-azure') return AZURE_LLM;
    return null;
  });
  mockAgentRepository.update.mockImplementation(async (_id: string, entity: unknown) => entity);
  mockAgentRepository.create.mockImplementation(async (entity: unknown) => entity);
});

describe('create', () => {
  it('mints max+1 inside the transaction, writes fallbacks, broadcasts ResourceCreated', async () => {
    mockAgentRepository.findMaxVersionNumber.mockResolvedValue(2);
    const created = await makeService().create({
      slug: 'clinic-summarizer',
      name: 'Clinic summarizer',
      task: AgentTask.TEXT_GENERATION,
      modelId: 'model-llm',
      fallbackModelIds: ['model-azure'],
      instruction: { systemPrompt: 'x' },
    });
    expect(mockDatabaseService.baseClient.$transaction).toHaveBeenCalled();
    expect(created.versionNumber).toBe(3);
    expect(created.status).toBe('DRAFT');
    expect(mockFallbackRepository.create).toHaveBeenCalledTimes(1);
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
  });

  it('refuses a model of another task (TEXT_GENERATION agent on an ASR model) with MODEL_TASK_MISMATCH', async () => {
    await expect(
      makeService().create({ slug: 'bad', name: 'Bad', task: AgentTask.TEXT_GENERATION, modelId: 'model-asr', instruction: { systemPrompt: 'x' } }),
    ).rejects.toMatchObject({ response: { code: 'MODEL_TASK_MISMATCH' } });
    expect(mockAgentRepository.create).not.toHaveBeenCalled();
  });

  it('refuses an unknown model id', async () => {
    await expect(makeService().create({ slug: 'bad', name: 'Bad', task: AgentTask.TEXT_GENERATION, modelId: 'nope' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a forbidden key in parameters (reference-only rule)', async () => {
    await expect(
      makeService().create({
        slug: 'bad',
        name: 'Bad',
        task: AgentTask.TEXT_GENERATION,
        modelId: 'model-llm',
        instruction: { systemPrompt: 'x' },
        parameters: { generation: { endpoint: 'http://x' } },
      }),
    ).rejects.toMatchObject({ response: { code: 'CONFIG' } });
  });
});

describe('publish — fails closed', () => {
  it('publishes an engine-served LLM agent with an inline prompt: compiledConfig stamped, isActive elected, previous active demoted', async () => {
    const previous = agent({ id: 'agent-0', status: WorkflowDefinitionStatus.PUBLISHED, isActive: true, compiledConfig: { models: [] } });
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(previous);
    const published = await makeService().publish('agent-1', {});
    expect(published.status).toBe('PUBLISHED');
    expect(published.isActive).toBe(true);
    expect(published.compiledConfig).toMatchObject({
      task: 'TEXT_GENERATION',
      service: 'llm',
      model: { slug: 'lms-gemma-4-e2b-it-qat' },
      resolvedPrompt: { source: 'inline' },
    });
    expect(published.compiledConfigChecksum).toMatch(/^sha256:/);
    expect(previous.isActive).toBe(false);
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceUpdated,
      expect.objectContaining({ data: expect.objectContaining({ action: 'publish' }) }),
    );
  });

  it('refuses MODEL_UNAVAILABLE for bucket-staged weights that are not present (the nemotron proof)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({ task: AgentTask.SPEECH_TO_TEXT, modelId: 'model-asr', instruction: null, parameters: null }),
    );
    await expect(makeService().publish('agent-1', {})).rejects.toMatchObject({ response: { code: 'MODEL_UNAVAILABLE' } });
    // The report is persisted so the console can show WHY, but nothing is published.
    const persisted = mockAgentRepository.update.mock.calls[0][1] as { status: string; validationReport: { blocking: boolean } };
    expect(persisted.status).toBe('DRAFT');
    expect(persisted.validationReport.blocking).toBe(true);
  });

  it('publishes a built-in ASR model whose weights ARE staged (availability AVAILABLE)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({ task: AgentTask.SPEECH_TO_TEXT, modelId: 'model-asr-staged', instruction: null, parameters: { decoding: { languageMode: 'ml-en' } } }),
    );
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    const published = await makeService().publish('agent-1', {});
    expect(published.status).toBe('PUBLISHED');
    expect(published.compiledConfig).toMatchObject({ service: 'stt', protocols: ['http', 'socket'] });
  });

  it('refuses MODEL_UNAVAILABLE for a cloud model with no enabled provider connection at tenant or SYSTEM', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ modelId: 'model-azure' }));
    mockProviderConnections.resolveConnection.mockResolvedValue(null);
    await expect(makeService().publish('agent-1', {})).rejects.toMatchObject({ response: { code: 'MODEL_UNAVAILABLE' } });
    expect(mockProviderConnections.resolveConnection).toHaveBeenCalledWith('llm', 'azure', TENANT);
  });

  it('publishes a cloud model when a connection exists (tenant or SYSTEM)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ modelId: 'model-azure' }));
    mockProviderConnections.resolveConnection.mockResolvedValue({ source: 'system', encryptedApiKey: KEYED });
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    const published = await makeService().publish('agent-1', { activate: false });
    expect(published.status).toBe('PUBLISHED');
    expect(published.isActive).toBe(false);
  });

  it('refuses TEMPLATE_NOT_APPROVED for a template-bound instruction whose template is DRAFT', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ instruction: { promptTemplateId: 'tpl-1', promptVersionNumber: 1 } }));
    mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-1', name: 'SOAP', status: 'DRAFT', content: 'x' });
    await expect(makeService().publish('agent-1', {})).rejects.toMatchObject({ response: { code: 'TEMPLATE_NOT_APPROVED' } });
  });

  it('resolves an APPROVED template`s pinned version into compiledConfig.resolvedPrompt', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ instruction: { promptTemplateId: 'tpl-1', promptVersionNumber: 2 } }));
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    mockPromptTemplateRepository.findById.mockResolvedValue({
      id: 'tpl-1',
      name: 'SOAP',
      status: 'APPROVED',
      content: 'head',
      approvedVersionNumber: 2,
    });
    mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 2, content: 'Summarise as SOAP.' });
    const published = await makeService().publish('agent-1', {});
    expect(published.compiledConfig).toMatchObject({
      resolvedPrompt: { source: 'template', promptTemplateId: 'tpl-1', promptVersionNumber: 2, content: 'Summarise as SOAP.' },
    });
  });

  it('refuses to publish an already PUBLISHED row (immutable — branch a new version)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ status: WorkflowDefinitionStatus.PUBLISHED, compiledConfig: {} }));
    await expect(makeService().publish('agent-1', {})).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * TASK-890 §3.5 — the resolved prompt is a TEMPLATE, so publish checks it like one. Before this
 * ticket nothing looked at prompt CONTENT at all: an agent could publish with a prompt that no
 * renderer could parse, and the failure surfaced mid-consultation instead of at authoring time.
 *
 * The severity split is the point. A template that does not PARSE can never render, so it is an
 * ERROR. A reference to a variable nobody declared MIGHT still resolve at runtime (the caller can
 * pass it), so in release 1 it is a WARNING — the OD-C ramp, promoted by one contract constant.
 */
describe('publish — the resolved prompt is checked as a template', () => {
  const withPrompt = (content: string) => agent({ instruction: { systemPrompt: content } });

  it('refuses PROMPT_TEMPLATE_SYNTAX for a prompt that cannot parse', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(withPrompt('Summarise {{a | upper}}'));
    await expect(makeService().publish('agent-1', {})).rejects.toMatchObject({ response: { code: 'PROMPT_TEMPLATE_SYNTAX' } });
    const persisted = mockAgentRepository.update.mock.calls[0][1] as { status: string; validationReport: { blocking: boolean } };
    expect(persisted.status).toBe('DRAFT');
    expect(persisted.validationReport.blocking).toBe(true);
  });

  it('records PROMPT_VARIABLE_UNDECLARED as a WARNING and still publishes (release 1 ramp)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(withPrompt('Summarise for {{context.patientAge}}'));
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    const published = await makeService().publish('agent-1', {});
    expect(published.status).toBe('PUBLISHED');
    const report = published.validationReport as unknown as { blocking: boolean; findings: Array<{ code: string; severity: string }> };
    expect(report.blocking).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'PROMPT_VARIABLE_UNDECLARED', severity: 'WARNING' }));
  });

  it('says nothing about a reference the agent`s own `instruction.variables` declares', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({ instruction: { promptTemplateId: 'tpl-1', promptVersionNumber: 1, variables: { tone: { value: 'concise' } } } }),
    );
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    mockPromptTemplateRepository.findById.mockResolvedValue({
      id: 'tpl-1',
      name: 'SOAP',
      status: 'APPROVED',
      content: 'x',
      approvedVersionNumber: 1,
    });
    mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 1, content: 'Write in a {{tone}} voice.' });
    const published = await makeService().publish('agent-1', {});
    const report = published.validationReport as unknown as { findings: Array<{ code: string }> };
    expect(report.findings.filter((finding) => finding.code === 'PROMPT_VARIABLE_UNDECLARED')).toEqual([]);
  });

  it('resolves `input.*` against the agent`s own `inputSchema`', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({
        instruction: { systemPrompt: 'Note: {{input.note}}. Missing: {{input.nope}}' },
        inputSchema: { type: 'object', additionalProperties: false, properties: { note: { type: 'string' } } },
      }),
    );
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    const published = await makeService().publish('agent-1', {});
    const report = published.validationReport as unknown as { findings: Array<{ code: string; message: string }> };
    const undeclared = report.findings.filter((finding) => finding.code === 'PROMPT_VARIABLE_UNDECLARED');
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]?.message).toContain('input.nope');
  });

  it('REFUSES the retired flat-string `instruction.variables` form (OD-K)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({ instruction: { promptTemplateId: 'tpl-1', promptVersionNumber: 1, variables: { tone: 'concise' } } }),
    );
    mockPromptTemplateRepository.findById.mockResolvedValue({
      id: 'tpl-1',
      name: 'SOAP',
      status: 'APPROVED',
      content: 'x',
      approvedVersionNumber: 1,
    });
    mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 1, content: 'x' });
    await expect(makeService().publish('agent-1', {})).rejects.toMatchObject({ response: { code: expect.stringMatching(/CONFIG|SCHEMA/) } });
  });
});

describe('404-over-403', () => {
  it('a foreign tenant`s agent is not found', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(null);
    await expect(makeService().getById('agent-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a SYSTEM template is readable but not writable by a tenant (404, not 403)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({ tenantId: SYSTEM_TENANT_ID, status: WorkflowDefinitionStatus.PUBLISHED, compiledConfig: {} }),
    );
    await expect(makeService().getById('agent-1')).resolves.toMatchObject({ tenantId: SYSTEM_TENANT_ID });
    await expect(makeService().update('agent-1', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(makeService().deprecate('agent-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a foreign row never leaks through the visible read', async () => {
    mockAgentRepository.findByIdVisible.mockImplementation(async (_id: string, tenantId: string) =>
      tenantId === OTHER ? agent({ tenantId: OTHER }) : null,
    );
    await expect(makeService().getById('agent-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('newVersion / deprecate', () => {
  it('branches a SYSTEM template into a NEW lineage in the caller tenant (DRAFT, parentVersionId = source)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({
        id: 'sys-1',
        tenantId: SYSTEM_TENANT_ID,
        slug: 'platform-summarization',
        status: WorkflowDefinitionStatus.PUBLISHED,
        compiledConfig: {},
      }),
    );
    mockAgentRepository.findMaxVersionNumber.mockResolvedValue(0);
    const branched = await makeService().newVersion('sys-1', { slug: 'my-summarizer' });
    expect(branched).toMatchObject({ tenantId: TENANT, slug: 'my-summarizer', versionNumber: 1, status: 'DRAFT', parentVersionId: 'sys-1' });
  });

  it('deprecates a PUBLISHED version: status DEPRECATED, isActive false, deprecatedAt stamped', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ status: WorkflowDefinitionStatus.PUBLISHED, isActive: true, compiledConfig: {} }));
    const deprecated = await makeService().deprecate('agent-1');
    expect(deprecated.status).toBe('DEPRECATED');
    expect(deprecated.isActive).toBe(false);
    expect(deprecated.deprecatedAt).not.toBeNull();
  });

  it('refuses to deprecate a DRAFT', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
    await expect(makeService().deprecate('agent-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('listPublished', () => {
  it('projects the business summary with isTenantDefault from the assignment cascade and default I/O schemas', async () => {
    mockAgentRepository.findPublishedActiveVisible.mockResolvedValue([
      agent({ status: WorkflowDefinitionStatus.PUBLISHED, isActive: true, compiledConfig: {} }),
    ]);
    mockAssignments.resolve.mockResolvedValue({ agentSlug: 'clinic-summarizer', source: 'tenant' });
    const [summary] = await makeService().listPublished();
    expect(summary).toMatchObject({ slug: 'clinic-summarizer', task: 'TEXT_GENERATION', isTenantDefault: true, protocols: ['http', 'http-sse'] });
    expect(summary.inputSchema).toMatchObject({ type: 'object' });
  });
});

/**
 * TASK-890 §3.7 / §3.12 (L8) — the publish gate reads the provider CLASS table, and readiness is
 * a SEPARATE, advisory axis.
 *
 * The two questions this pins apart: `usable` asks "could an agent bound to this row ever run?"
 * and blocks; `readiness` asks "would it have run at the last moment anyone looked?" and never
 * does. Before this lane an engine-served row passed unconditionally — a platform admin could
 * disable the engine's connection and every agent bound to it still published.
 */
describe('publish — availability via the provider class table (§3.7)', () => {
  it('refuses an engine-served model when the platform engine connection is not enabled', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
    mockProviderConnections.resolveConnection.mockResolvedValue(null);
    await expect(makeService().publish('agent-1', {})).rejects.toMatchObject({ response: { code: 'MODEL_UNAVAILABLE' } });
    expect(mockProviderConnections.resolveConnection).toHaveBeenCalledWith('llm', 'lm-studio', TENANT);
  });

  it('refuses a tenant BYO row whose own connection carries no credential', async () => {
    const byo = { ...LLM_MODEL, id: 'model-byo', tenantId: TENANT, slug: 'byo-openai-gpt', provider: 'openai' };
    mockAiModelRepository.findById.mockResolvedValue(byo);
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ modelId: 'model-byo' }));
    mockProviderConnections.findRow.mockResolvedValue({ id: 'conn-1', enabled: true, encryptedApiKey: null });
    await expect(makeService().publish('agent-1', {})).rejects.toMatchObject({ response: { code: 'MODEL_UNAVAILABLE' } });
    expect(mockProviderConnections.findRow).toHaveBeenCalledWith('llm', 'openai', TENANT);
  });

  // TASK-890 §3.1 (L10 → L8, wired at the wave-2b close) — routing was re-pointed off the
  // locator `sourceUri` onto `wireModelId`, and `toTextCandidate` DROPS a candidate that
  // declares none. Without this gate such a row publishes cleanly and then resolves no candidate
  // at run time, with an error that names neither the row nor the missing column.
  it('refuses a cloud row that declares no wireModelId — routing would have nothing to send', async () => {
    const byo = { ...LLM_MODEL, id: 'model-byo', tenantId: TENANT, slug: 'byo-openai-gpt', provider: 'openai', wireModelId: null };
    mockAiModelRepository.findById.mockResolvedValue(byo);
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ modelId: 'model-byo' }));
    mockProviderConnections.findRow.mockResolvedValue({ id: 'conn-1', enabled: true, encryptedApiKey: 'k' });
    await expect(makeService().publish('agent-1', {})).rejects.toMatchObject({
      response: {
        code: 'MODEL_UNAVAILABLE',
        findings: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('wire model id') })]),
      },
    });
  });

  // A self-hosted row is EXEMPT: `wireModelId` is conditionally NOT NULL for CLOUD only, and the
  // seeded self-hosted catalogue legitimately leaves it null for rows a HOPE service loads by
  // path. Refusing them here would refuse publishes that work.
  it('does NOT refuse a platform self-hosted row for a missing wireModelId', async () => {
    mockAiModelRepository.findById.mockResolvedValue({ ...STAGED_ASR, wireModelId: null });
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({ task: AgentTask.SPEECH_TO_TEXT, modelId: STAGED_ASR.id, instruction: null, parameters: { decoding: { languageMode: 'ml-en' } } }),
    );
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    const published = await makeService().publish('agent-1', {});
    expect(published.status).toBe('PUBLISHED');
  });

  it('publishes a tenant BYO row whose own connection is enabled AND keyed', async () => {
    const byo = { ...LLM_MODEL, id: 'model-byo', tenantId: TENANT, slug: 'byo-openai-gpt', provider: 'openai' };
    mockAiModelRepository.findById.mockResolvedValue(byo);
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ modelId: 'model-byo' }));
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    mockProviderConnections.findRow.mockResolvedValue({ id: 'conn-1', enabled: true, encryptedApiKey: KEYED });
    await expect(makeService().publish('agent-1', {})).resolves.toMatchObject({ status: 'PUBLISHED' });
  });

  it('records MODEL_NOT_READY as a WARNING and still publishes (readiness is advisory)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    mockReadiness.getSnapshot.mockResolvedValue({
      checkedAt: '2026-09-06T00:00:00.000Z',
      engines: {},
      models: { 'model-llm': { readiness: 'engine_down', detail: 'probe timed out' } },
    });
    const published = await makeService().publish('agent-1', {});
    expect(published.status).toBe('PUBLISHED');
    const report = published.validationReport as unknown as { blocking: boolean; findings: Array<{ code: string; severity: string }> };
    expect(report.blocking).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'MODEL_NOT_READY', severity: 'WARNING' }));
  });

  /**
   * J3-2 — the gate and the CATALOGUE must answer the same question the same way.
   *
   * `usabilityOf` (`aiModel.service.ts`) already accepts EITHER measurement for a
   * `platform-self-host` row: `bucketHasIt || readiness === 'ready'`. The bucket measurement
   * alone was wrong for most of the catalogue — a serving service resolves these weights out of
   * its HuggingFace cache and never touches `s3://hope-models`, so a NULL `bucketPrefix` is
   * stamped MISSING while `apps/stt` holds the file on disk (21 of 33 rows, every whisper row
   * among them). The gate kept reading `availability` alone, so the console offered a model it
   * called usable and then refused to publish an agent bound to it — measured on dev against
   * `arcaai-whisper-large-ml-en-gguf-q8_0`, which the readiness sweep reports `ready`.
   *
   * The two axes do NOT collapse: readiness still never REFUSES (that is `MODEL_NOT_READY`, a
   * WARNING), and `unknown` — nobody looked — is still not a licence to publish onto weights no
   * measurement has ever found.
   */
  it('publishes a self-hosted row the bucket calls MISSING when the readiness sweep says `ready`', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({ task: AgentTask.SPEECH_TO_TEXT, modelId: 'model-asr', instruction: null, parameters: { decoding: { languageMode: 'ml-en' } } }),
    );
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    mockReadiness.getSnapshot.mockResolvedValue({
      checkedAt: '2026-09-06T00:00:00.000Z',
      engines: {},
      models: { 'model-asr': { readiness: 'ready', detail: 'resolvable from the local cache' } },
    });
    const published = await makeService().publish('agent-1', {});
    expect(published.status).toBe('PUBLISHED');
  });

  it('still refuses a self-hosted row when readiness is `unknown` — nobody looked is not a verdict', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({ task: AgentTask.SPEECH_TO_TEXT, modelId: 'model-asr', instruction: null, parameters: null }),
    );
    mockReadiness.getSnapshot.mockResolvedValue({ checkedAt: '2026-09-06T00:00:00.000Z', engines: {}, models: {} });
    await expect(makeService().publish('agent-1', {})).rejects.toMatchObject({ response: { code: 'MODEL_UNAVAILABLE' } });
  });

  it('still refuses a self-hosted row the serving side says has no weights', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({ task: AgentTask.SPEECH_TO_TEXT, modelId: 'model-asr', instruction: null, parameters: null }),
    );
    mockReadiness.getSnapshot.mockResolvedValue({
      checkedAt: '2026-09-06T00:00:00.000Z',
      engines: {},
      models: { 'model-asr': { readiness: 'weights_missing', detail: 'not in the cache' } },
    });
    await expect(makeService().publish('agent-1', {})).rejects.toMatchObject({ response: { code: 'MODEL_UNAVAILABLE' } });
  });

  // The advisory axis survives the change: a STAGED row whose engine was down at the last sweep
  // still publishes, and still says so.
  it('keeps MODEL_NOT_READY advisory for a staged self-hosted row whose serving side is down', async () => {
    mockAiModelRepository.findById.mockResolvedValue(STAGED_ASR);
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({ task: AgentTask.SPEECH_TO_TEXT, modelId: STAGED_ASR.id, instruction: null, parameters: { decoding: { languageMode: 'ml-en' } } }),
    );
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    mockReadiness.getSnapshot.mockResolvedValue({
      checkedAt: '2026-09-06T00:00:00.000Z',
      engines: {},
      models: { [STAGED_ASR.id]: { readiness: 'engine_down', detail: 'stt did not answer' } },
    });
    const published = await makeService().publish('agent-1', {});
    expect(published.status).toBe('PUBLISHED');
    const report = published.validationReport as unknown as { findings: Array<{ code: string; severity: string }> };
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'MODEL_NOT_READY', severity: 'WARNING' }));
  });

  it('says nothing when readiness is `ready` (and nothing at all when no snapshot exists)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    mockReadiness.getSnapshot.mockResolvedValue({
      checkedAt: '2026-09-06T00:00:00.000Z',
      engines: {},
      models: { 'model-llm': { readiness: 'ready', detail: null } },
    });
    const published = await makeService().publish('agent-1', {});
    const report = published.validationReport as unknown as { findings: Array<{ code: string }> };
    expect(report.findings.filter((finding) => finding.code === 'MODEL_NOT_READY')).toEqual([]);
  });
});

/**
 * TASK-890 §3.4 (L8) — the agent's context-schema PIN resolves in the CALLER's tenant only, and
 * what it resolves to is FROZEN into the compiled config. A schema is CONTENT: it is cloned into
 * a tenant and never shared from SYSTEM, so an unresolvable pin is a publish refusal that names
 * WHICH half failed — the schema or the version.
 */
describe('publish — the bound context schema (§3.4)', () => {
  // `additionalProperties: false` is what makes the root KNOWN-shaped: an open schema admits any
  // sub-path by design (§3.3), so a closed one is the only fixture that can prove the frozen
  // declaration is actually being consulted.
  const PAYLOAD = {
    type: 'object',
    additionalProperties: false,
    required: ['visit'],
    properties: { visit: { type: 'object', properties: { age: { type: 'string' } } } },
  };

  it('refuses CONTEXT_SCHEMA_NOT_FOUND for a pin this tenant cannot see (a SYSTEM id included)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ contextSchemaId: 'schema-sys' }));
    mockContextSchemas.resolveReference.mockResolvedValue({ outcome: 'failed', failure: 'CONTEXT_SCHEMA_NOT_FOUND' });
    await expect(makeService().publish('agent-1', {})).rejects.toMatchObject({ response: { code: 'CONTEXT_SCHEMA_NOT_FOUND' } });
    expect(mockContextSchemas.resolveReference).toHaveBeenCalledWith('schema-sys', null);
  });

  it('refuses CONTEXT_SCHEMA_VERSION_NOT_FOUND when the pinned version does not exist', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ contextSchemaId: 'schema-1', contextSchemaVersionNumber: 9 }));
    mockContextSchemas.resolveReference.mockResolvedValue({ outcome: 'failed', failure: 'CONTEXT_SCHEMA_VERSION_NOT_FOUND' });
    await expect(makeService().publish('agent-1', {})).rejects.toMatchObject({ response: { code: 'CONTEXT_SCHEMA_VERSION_NOT_FOUND' } });
    expect(mockContextSchemas.resolveReference).toHaveBeenCalledWith('schema-1', 9);
  });

  it('FREEZES the derived payload schema into compiledConfig.contextSchema, with its provenance', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ contextSchemaId: 'schema-1', contextSchemaVersionNumber: 2 }));
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    mockContextSchemas.resolveReference.mockResolvedValue({
      outcome: 'resolved',
      schemaId: 'schema-1',
      versionNumber: 2,
      versionId: 'schema-1-v2',
      payloadSchema: PAYLOAD,
    });
    const published = await makeService().publish('agent-1', {});
    expect(published.compiledConfig).toMatchObject({
      contextSchema: { schemaId: 'schema-1', versionNumber: 2, versionId: 'schema-1-v2', payloadSchema: PAYLOAD },
    });
  });

  it('lets the frozen schema DECLARE `context.*`, so a reference into it is no longer undeclared', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(
      agent({ contextSchemaId: 'schema-1', instruction: { systemPrompt: 'Visit: {{context.visit}} / {{context.absent}}' } }),
    );
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    mockContextSchemas.resolveReference.mockResolvedValue({
      outcome: 'resolved',
      schemaId: 'schema-1',
      versionNumber: 1,
      versionId: 'schema-1-v1',
      payloadSchema: PAYLOAD,
    });
    const published = await makeService().publish('agent-1', {});
    const report = published.validationReport as unknown as { findings: Array<{ code: string; message: string }> };
    const undeclared = report.findings.filter((finding) => finding.code === 'PROMPT_VARIABLE_UNDECLARED');
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]?.message).toContain('context.absent');
  });
});

/**
 * TASK-890 §3.14 (OD-R) — the agent-level guardrail opt-out. ABSENT MEANS ON at every level, and
 * an opt-out is RECORDED (a publish WARNING) rather than merely permitted.
 */
describe('publish — the guardrail compile stamp (§3.14)', () => {
  it('stamps guardrail.enabled = true when the agent says nothing', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    const published = await makeService().publish('agent-1', {});
    expect(published.compiledConfig).toMatchObject({ guardrail: { enabled: true } });
    const report = published.validationReport as unknown as { findings: Array<{ code: string }> };
    expect(report.findings.filter((finding) => finding.code === 'GUARDRAIL_OPTED_OUT')).toEqual([]);
  });

  it('stamps guardrail.enabled = false and WARNS, without blocking, when the agent opts out', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ parameters: { guards: { enabled: false } } }));
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    const published = await makeService().publish('agent-1', {});
    expect(published.compiledConfig).toMatchObject({ guardrail: { enabled: false } });
    const report = published.validationReport as unknown as { blocking: boolean; findings: Array<{ code: string; severity: string }> };
    expect(report.blocking).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'GUARDRAIL_OPTED_OUT', severity: 'WARNING' }));
  });
});

/**
 * TASK-890 H-6 (the CLONE / BRANCH half) — `AgentModelFallback` is a plain tenant-scoped model, so
 * a read of the SOURCE's chain under the CALLER's working tenant answers `[]`. Every copy of a
 * SYSTEM template silently lost its whole fallback chain.
 *
 * The assertion is on the CLS tenant OBSERVED at read time, not on the returned rows: a fixture
 * that simply returns a chain would pass whether or not the fix exists, which is precisely why
 * the pre-existing portability fixture could not fail.
 */
describe('the source tenant`s fallback chain is read under the SOURCE`s tenant (H-6)', () => {
  const SYSTEM_SOURCE = agent({
    id: 'sys-1',
    tenantId: SYSTEM_TENANT_ID,
    slug: 'platform-summarization',
    status: WorkflowDefinitionStatus.PUBLISHED,
    compiledConfig: {},
  });

  function chainVisibleOnlyToSystem(): string[] {
    const observed: string[] = [];
    mockFallbackRepository.findByAgentId.mockImplementation(async (agentId: string) => {
      const tenantId = clsStore.tenantId as string;
      observed.push(tenantId);
      return agentId === 'sys-1' && tenantId === SYSTEM_TENANT_ID ? [{ id: 'fb-1', priority: 0, modelId: 'model-azure', enabled: true }] : [];
    });
    return observed;
  }

  it('clone() copies the SYSTEM template`s chain', async () => {
    const observed = chainVisibleOnlyToSystem();
    mockAgentRepository.findAllVersionsBySlug.mockResolvedValue([]);
    // TASK-890 L13 — the SYSTEM source arrives through the explicit reference read.
    mockAgentRepository.findSystemReferenceBySlug.mockResolvedValue(SYSTEM_SOURCE);
    mockAgentRepository.findMaxVersionNumber.mockResolvedValue(0);

    const cloned = await makeService().clone('platform-summarization', { newSlug: 'my-summarizer' });

    expect(observed).toContain(SYSTEM_TENANT_ID);
    expect(cloned.fallbacks).toHaveLength(1);
    // The parent context is restored: the clone itself is written in the CALLER's tenant.
    expect(clsStore.tenantId).toBe(TENANT);
  });

  it('newVersion() off a SYSTEM template inherits its chain', async () => {
    chainVisibleOnlyToSystem();
    mockAgentRepository.findByIdVisible.mockResolvedValue(SYSTEM_SOURCE);
    mockAgentRepository.findMaxVersionNumber.mockResolvedValue(0);

    await makeService().newVersion('sys-1', { slug: 'my-summarizer' });

    expect(mockFallbackRepository.create).toHaveBeenCalledTimes(1);
  });
});
