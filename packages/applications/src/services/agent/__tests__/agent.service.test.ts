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

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockAgentRepository = {
  findByIdVisible: vi.fn(),
  findAllForTenant: vi.fn(),
  findPublishedActiveVisible: vi.fn(),
  findPublishedActiveBySlug: vi.fn(),
  findOwnActiveBySlug: vi.fn(),
  findAllVersionsBySlug: vi.fn(),
  findMaxVersionNumber: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
};
const mockFallbackRepository = { findByAgentId: vi.fn(async () => []), create: vi.fn(async (e: unknown) => e), deleteAllForAgent: vi.fn() };
const mockAiModelRepository = { findById: vi.fn(), findBySlug: vi.fn(), findByTaskTypeSharedRead: vi.fn(async () => []) };
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockAssignments = { resolve: vi.fn(async () => ({ agentSlug: null, source: 'platform-default' })) };
const mockProviderConnections = { resolveConnection: vi.fn(), resolveTenantCloudOverrides: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn() };

const LLM_MODEL = { id: 'model-llm', tenantId: SYSTEM_TENANT_ID, slug: 'lms-gemma-4-e2b-it-qat', taskType: 'TEXT_GENERATION', provider: 'lm-studio', localPath: null, resourceStatus: ResourceStatusType.ENABLED, metaData: null };
const ASR_MODEL = { id: 'model-asr', tenantId: SYSTEM_TENANT_ID, slug: 'nemotron-3.5-asr-streaming-0.6b', taskType: 'AUTOMATIC_SPEECH_RECOGNITION', provider: 'built-in', localPath: null, downloadStatus: 'NOT_DOWNLOADED', resourceStatus: ResourceStatusType.ENABLED, metaData: null };
const STAGED_ASR = { ...ASR_MODEL, id: 'model-asr-staged', slug: 'arcaai-whisper-large-ml-en-gguf', localPath: '/mnt/models/whisper' };
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
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1', roles: [] } : undefined));
  mockAiModelRepository.findById.mockImplementation(async (id: string) => {
    if (id === 'model-llm') return LLM_MODEL;
    if (id === 'model-asr') return ASR_MODEL;
    if (id === 'model-azure') return AZURE_LLM;
    if (id === 'model-asr-staged') return STAGED_ASR;
    throw new Error('not found');
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
    await expect(makeService().create({ slug: 'bad', name: 'Bad', task: AgentTask.TEXT_GENERATION, modelId: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a forbidden key in parameters (reference-only rule)', async () => {
    await expect(
      makeService().create({ slug: 'bad', name: 'Bad', task: AgentTask.TEXT_GENERATION, modelId: 'model-llm', instruction: { systemPrompt: 'x' }, parameters: { generation: { endpoint: 'http://x' } } }),
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
    expect(published.compiledConfig).toMatchObject({ task: 'TEXT_GENERATION', service: 'llm', model: { slug: 'lms-gemma-4-e2b-it-qat' }, resolvedPrompt: { source: 'inline' } });
    expect(published.compiledConfigChecksum).toMatch(/^sha256:/);
    expect(previous.isActive).toBe(false);
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ data: expect.objectContaining({ action: 'publish' }) }));
  });

  it('refuses MODEL_UNAVAILABLE for bucket-staged weights that are not present (the nemotron proof)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ task: AgentTask.SPEECH_TO_TEXT, modelId: 'model-asr', instruction: null, parameters: null }));
    await expect(makeService().publish('agent-1', {})).rejects.toMatchObject({ response: { code: 'MODEL_UNAVAILABLE' } });
    // The report is persisted so the console can show WHY, but nothing is published.
    const persisted = mockAgentRepository.update.mock.calls[0][1] as { status: string; validationReport: { blocking: boolean } };
    expect(persisted.status).toBe('DRAFT');
    expect(persisted.validationReport.blocking).toBe(true);
  });

  it('publishes a built-in ASR model whose weights ARE staged (localPath set)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ task: AgentTask.SPEECH_TO_TEXT, modelId: 'model-asr-staged', instruction: null, parameters: { decoding: { languageMode: 'ml-en' } } }));
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
    mockProviderConnections.resolveConnection.mockResolvedValue({ source: 'system' });
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
    mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-1', name: 'SOAP', status: 'APPROVED', content: 'head', approvedVersionNumber: 2 });
    mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 2, content: 'Summarise as SOAP.' });
    const published = await makeService().publish('agent-1', {});
    expect(published.compiledConfig).toMatchObject({ resolvedPrompt: { source: 'template', promptTemplateId: 'tpl-1', promptVersionNumber: 2, content: 'Summarise as SOAP.' } });
  });

  it('refuses to publish an already PUBLISHED row (immutable — branch a new version)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ status: WorkflowDefinitionStatus.PUBLISHED, compiledConfig: {} }));
    await expect(makeService().publish('agent-1', {})).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('404-over-403', () => {
  it('a foreign tenant`s agent is not found', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(null);
    await expect(makeService().getById('agent-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a SYSTEM template is readable but not writable by a tenant (404, not 403)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ tenantId: SYSTEM_TENANT_ID, status: WorkflowDefinitionStatus.PUBLISHED, compiledConfig: {} }));
    await expect(makeService().getById('agent-1')).resolves.toMatchObject({ tenantId: SYSTEM_TENANT_ID });
    await expect(makeService().update('agent-1', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(makeService().deprecate('agent-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a foreign row never leaks through the visible read', async () => {
    mockAgentRepository.findByIdVisible.mockImplementation(async (_id: string, tenantId: string) => (tenantId === OTHER ? agent({ tenantId: OTHER }) : null));
    await expect(makeService().getById('agent-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('newVersion / deprecate', () => {
  it('branches a SYSTEM template into a NEW lineage in the caller tenant (DRAFT, parentVersionId = source)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ id: 'sys-1', tenantId: SYSTEM_TENANT_ID, slug: 'platform-summarization', status: WorkflowDefinitionStatus.PUBLISHED, compiledConfig: {} }));
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
    mockAgentRepository.findPublishedActiveVisible.mockResolvedValue([agent({ status: WorkflowDefinitionStatus.PUBLISHED, isActive: true, compiledConfig: {} })]);
    mockAssignments.resolve.mockResolvedValue({ agentSlug: 'clinic-summarizer', source: 'tenant' });
    const [summary] = await makeService().listPublished();
    expect(summary).toMatchObject({ slug: 'clinic-summarizer', task: 'TEXT_GENERATION', isTenantDefault: true, protocols: ['http', 'http-sse'] });
    expect(summary.inputSchema).toMatchObject({ type: 'object' });
  });
});
