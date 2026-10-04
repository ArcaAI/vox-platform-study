/**
 * TASK-1036 OD-10 — the draft test bench renders an absent OPTIONAL variable as `""`.
 *
 * The bench builds its scope through `testScope`; before this, it passed no declarations, so a
 * template with an optional variable failed `PROMPT_VARIABLE_UNRESOLVED` on the bench while the
 * invocation route (which reads the frozen declarations) rendered it empty. A REQUIRED variable
 * still fails by name.
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
const mockAgentRepository = { findByIdVisible: vi.fn(), findPublishedActiveBySlug: vi.fn(async () => null) };
const mockFallbackRepository = { findByAgentId: vi.fn(async () => []) };
const mockAiModelRepository = { findById: vi.fn(async () => LLM_MODEL), findByTaskTypeSharedRead: vi.fn(async () => []) };
const VARIABLES = [
  { name: 'note', required: false },
  { name: 'patient', required: true },
];
const mockPromptTemplateRepository = {
  findById: vi.fn(async () => ({
    id: 'tpl-1',
    name: 'T',
    status: 'APPROVED',
    content: 'Patient: {{patient}}. Note: {{note}}',
    approvedVersionNumber: 1,
    currentVersionNumber: 1,
    variables: VARIABLES,
    tenantId: TENANT,
  })),
};
const mockPromptVersionRepository = {
  findByVersionNumber: vi.fn(async () => ({ versionNumber: 1, content: 'Patient: {{patient}}. Note: {{note}}', variables: VARIABLES })),
};
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockProviderConnections = {
  resolveConnection: vi.fn(async () => ({ source: 'system', encryptedApiKey: new Uint8Array([1]) })),
  findRow: vi.fn(async () => null),
};

function templateAgent() {
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
    instruction: {
      promptTemplateId: 'tpl-1',
      promptVersionNumber: 1,
      variables: { patient: { path: 'input.patient' }, note: { path: 'input.note' } },
    },
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
    { emit: vi.fn() } as never,
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
  mockAgentRepository.findByIdVisible.mockResolvedValue(templateAgent());
});

describe('testDraft passes the template declarations (OD-10)', () => {
  it('renders an absent OPTIONAL variable empty', async () => {
    const ack = await makeService().testDraft('agent-1', { input: { patient: 'Asha' } });
    expect(ack.assembledSystemPrompt).toContain('Patient: Asha. Note: ');
  });

  it('still fails a missing REQUIRED variable by name', async () => {
    await expect(makeService().testDraft('agent-1', { input: {} })).rejects.toMatchObject({
      response: { code: 'PROMPT_VARIABLE_UNRESOLVED' },
    });
  });
});
