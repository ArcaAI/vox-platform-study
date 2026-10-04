/**
 * TASK-1036 W3 — prompt pins, end to end on the AGENT.
 *
 * > Agents and prompt templates are pinned in every published agent and workflow. (W3)
 *
 *  1. The publish gate (and `validate`, which reports what publish would decide) runs the
 *     contract with `{ phase: 'publish' }`, so a library prompt bound WITHOUT
 *     `promptVersionNumber` is a blocking `PROMPT_VERSION_UNPINNED` — top-level and per fragment.
 *  2. Authors never meet that error in the normal flow: binding a library prompt on create or
 *     update STAMPS the template's current APPROVED version when no pin was given. A pin the
 *     author did give is kept; a template that is not APPROVED is left unpinned (D-7 — nothing is
 *     auto-approved; publish then names the real reason, `TEMPLATE_NOT_APPROVED`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentService } from '../agent.service';

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
const mockAgentRepository = {
  findByIdVisible: vi.fn(),
  findMaxVersionNumber: vi.fn(async () => 0),
  create: vi.fn(async (entity: unknown) => entity),
  updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
  findPublishedActiveBySlug: vi.fn(async () => null),
  findOwnActiveBySlug: vi.fn(async () => null),
  update: vi.fn(async (_id: string, entity: unknown) => entity),
};
const mockFallbackRepository = { findByAgentId: vi.fn(async () => []), create: vi.fn(async (e: unknown) => e), deleteAllForAgent: vi.fn() };
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

/** Template rows by id, so a composite can bind several and each resolve on its own. */
const templates = new Map<string, Record<string, unknown>>();
const versions = new Map<string, Record<string, unknown>>();
const mockPromptTemplateRepository = { findById: vi.fn(async (id: string) => templates.get(id) ?? null) };
const mockPromptVersionRepository = {
  findByVersionNumber: vi.fn(async (templateId: string, versionNumber: number) => versions.get(`${templateId}#${versionNumber}`) ?? null),
};
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockProviderConnections = {
  resolveConnection: vi.fn(async () => ({ source: 'system', encryptedApiKey: new Uint8Array([1]) })),
  findRow: vi.fn(async () => null),
};

function putTemplate(
  id: string,
  content: string,
  over: { status?: string; approvedVersionNumber?: number | null; currentVersionNumber?: number | null; variables?: unknown } = {},
): void {
  const approved = over.approvedVersionNumber === undefined ? 1 : over.approvedVersionNumber;
  templates.set(id, {
    id,
    name: `Template ${id}`,
    status: over.status ?? 'APPROVED',
    content,
    approvedVersionNumber: approved,
    currentVersionNumber: over.currentVersionNumber ?? approved,
    variables: over.variables ?? null,
    tenantId: TENANT,
  });
  if (approved !== null) versions.set(`${id}#${approved}`, { versionNumber: approved, content, variables: over.variables ?? null });
}

function putVersion(templateId: string, versionNumber: number, content: string, variables: unknown = null): void {
  versions.set(`${templateId}#${versionNumber}`, { versionNumber, content, variables });
}

function agent(instruction: unknown, over: Record<string, unknown> = {}) {
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
    instruction,
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
    ...over,
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
  templates.clear();
  versions.clear();
  clsStore.tenantId = TENANT;
  clsStore.user = { id: 'user-1', roles: ['TENANT_ADMIN'] };
  mockAgentRepository.update.mockImplementation(async (_id: string, entity: unknown) => entity);
  mockAgentRepository.updateWithVersion.mockImplementation(async (_id: string, entity: unknown) => entity);
  mockAgentRepository.create.mockImplementation(async (entity: unknown) => entity);
  mockAgentRepository.findMaxVersionNumber.mockImplementation(async () => 0);
  mockAiModelRepository.findById.mockImplementation(async () => LLM_MODEL);
  mockFallbackRepository.findByAgentId.mockImplementation(async () => []);
  mockDatabaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
  mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => templates.get(id) ?? null);
  mockPromptVersionRepository.findByVersionNumber.mockImplementation(
    async (templateId: string, versionNumber: number) => versions.get(`${templateId}#${versionNumber}`) ?? null,
  );
});

describe('publish gate — phase: publish (W3)', () => {
  it('REFUSES a top-level library prompt with no pin: PROMPT_VERSION_UNPINNED', async () => {
    putTemplate('tpl-1', 'Summarise.');
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ promptTemplateId: 'tpl-1' }));
    await expect(makeService().publish('agent-1', { activate: false })).rejects.toMatchObject({
      response: { code: 'PROMPT_VERSION_UNPINNED' },
    });
  });

  it('REFUSES an unpinned FRAGMENT, naming its path', async () => {
    putTemplate('tpl-1', 'Summarise.');
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ fragments: [{ key: 'base', promptTemplateId: 'tpl-1' }] }));
    const failure = await makeService()
      .publish('agent-1', { activate: false })
      .catch((error: { response: { findings: Array<{ code: string; path: string }> } }) => error.response);
    expect(failure.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROMPT_VERSION_UNPINNED', path: 'instruction.fragments[0].promptVersionNumber' })]),
    );
  });

  it('validate reports the same blocking finding publish would', async () => {
    putTemplate('tpl-1', 'Summarise.');
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ promptTemplateId: 'tpl-1' }));
    const validated = await makeService().validate('agent-1');
    expect(validated.validationReport?.blocking).toBe(true);
    expect(validated.validationReport?.findings.map((finding) => finding.code)).toContain('PROMPT_VERSION_UNPINNED');
  });

  it('PUBLISHES a pinned binding', async () => {
    putTemplate('tpl-1', 'Summarise.', { approvedVersionNumber: 2 });
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ promptTemplateId: 'tpl-1', promptVersionNumber: 2 }));
    const published = await makeService().publish('agent-1', { activate: false });
    expect(published.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
  });
});

const CREATE = { slug: 'clinic-summarizer', name: 'Clinic summarizer', task: AgentTask.TEXT_GENERATION, modelId: 'model-llm' };

function createdInstruction(): Record<string, unknown> {
  const call = mockAgentRepository.create.mock.calls[0] as unknown as [{ instruction: Record<string, unknown> }];
  return call[0].instruction;
}
function updatedInstruction(): Record<string, unknown> {
  const call = mockAgentRepository.updateWithVersion.mock.calls[0] as unknown as [string, { instruction: Record<string, unknown> }];
  return call[1].instruction;
}

describe('binding a library prompt stamps the approved version (W3)', () => {
  it('create: stamps `promptVersionNumber` from the template’s approved version', async () => {
    putTemplate('tpl-1', 'Summarise.', { approvedVersionNumber: 4, currentVersionNumber: 5 });
    await makeService().create({ ...CREATE, instruction: { promptTemplateId: 'tpl-1' } } as never);
    expect(createdInstruction()).toEqual({ promptTemplateId: 'tpl-1', promptVersionNumber: 4 });
  });

  it('create: keeps a pin the author chose', async () => {
    putTemplate('tpl-1', 'Summarise.', { approvedVersionNumber: 4 });
    putVersion('tpl-1', 2, 'Older.');
    await makeService().create({ ...CREATE, instruction: { promptTemplateId: 'tpl-1', promptVersionNumber: 2 } } as never);
    expect(createdInstruction()).toEqual({ promptTemplateId: 'tpl-1', promptVersionNumber: 2 });
  });

  it('create: stamps every template FRAGMENT and leaves inline fragments alone', async () => {
    putTemplate('tpl-1', 'Base.', { approvedVersionNumber: 3 });
    putTemplate('tpl-2', 'Revisit.', { approvedVersionNumber: 7 });
    await makeService().create({
      ...CREATE,
      instruction: {
        fragments: [
          { key: 'base', promptTemplateId: 'tpl-1' },
          { key: 'revisit', promptTemplateId: 'tpl-2', when: 'true' },
          { key: 'tail', systemPrompt: 'Be brief.' },
        ],
      },
    } as never);
    expect(createdInstruction()).toEqual({
      fragments: [
        { key: 'base', promptTemplateId: 'tpl-1', promptVersionNumber: 3 },
        { key: 'revisit', promptTemplateId: 'tpl-2', when: 'true', promptVersionNumber: 7 },
        { key: 'tail', systemPrompt: 'Be brief.' },
      ],
    });
  });

  it('create: a template that is NOT approved is left unpinned — nothing is auto-approved (D-7)', async () => {
    putTemplate('tpl-1', 'Draft.', { status: 'DRAFT', approvedVersionNumber: null, currentVersionNumber: 1 });
    await makeService().create({ ...CREATE, instruction: { promptTemplateId: 'tpl-1' } } as never);
    expect(createdInstruction()).toEqual({ promptTemplateId: 'tpl-1' });
  });

  it('update: re-binding without a pin stamps it — the pin can be changed, never cleared', async () => {
    putTemplate('tpl-9', 'New.', { approvedVersionNumber: 6 });
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ systemPrompt: 'Inline.' }, { hasChanges: true }));
    await makeService().update('agent-1', { instruction: { promptTemplateId: 'tpl-9' } } as never);
    expect(updatedInstruction()).toEqual({ promptTemplateId: 'tpl-9', promptVersionNumber: 6 });
  });

  it('the stamped agent then publishes without PROMPT_VERSION_UNPINNED', async () => {
    putTemplate('tpl-1', 'Summarise.', { approvedVersionNumber: 4 });
    await makeService().create({ ...CREATE, instruction: { promptTemplateId: 'tpl-1' } } as never);
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent(createdInstruction()));
    const published = await makeService().publish('agent-1', { activate: false });
    expect(published.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
  });
});
