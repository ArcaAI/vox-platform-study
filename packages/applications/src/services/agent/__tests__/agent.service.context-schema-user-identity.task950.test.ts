/**
 * TASK-950 L2 test 17 — publish FREEZES the user-identity binding beside the payload schema.
 *
 * Same invariant as everything else `compile()` stamps (TASK-859 invariant 4): the runtime
 * never re-reads the schema row, so anything an invocation needs about the pinned version has
 * to be in the compiled bytes. If WHICH field carries the staff identifier were resolved live,
 * a tenant editing its schema would silently change which user an in-flight agent resolves —
 * exactly the retroactivity the freeze exists to prevent.
 *
 * The second half is the additive posture, and it is not cosmetic: `compiledConfig` is
 * checksummed, so an agent whose schema declares no identity field must carry NO key rather
 * than `userIdentity: null`. A key that always appeared would move the checksum of every
 * artifact that never used it, including the committed seed agents.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentService } from '../agent.service';

const TENANT = '50000000-0000-0000-0000-000000000000';

const clsStore: Record<string, unknown> = {};
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
  findPublishedActiveBySlug: vi.fn(async () => null),
  findOwnActiveBySlug: vi.fn(async () => null),
  update: vi.fn(async (_id: string, entity: unknown) => entity),
};
const mockFallbackRepository = { findByAgentId: vi.fn(async () => []) };
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockProviderConnections = {
  resolveConnection: vi.fn(async () => ({ source: 'system', encryptedApiKey: new Uint8Array([1]) })),
  findRow: vi.fn(async () => null),
};
const mockContextSchemas = { resolveReference: vi.fn() };
const mockReadiness = { getSnapshot: vi.fn(async () => null) };

const LLM_MODEL = {
  id: 'model-llm',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'lms-gemma-4-e2b-it-qat',
  taskType: 'TEXT_GENERATION',
  provider: 'lm-studio',
  wireModelId: 'gemma-4-e2b-it-qat',
  resourceStatus: ResourceStatusType.ENABLED,
  metaData: null,
};
const mockAiModelRepository = { findById: vi.fn(async () => LLM_MODEL), findByIdOrNull: vi.fn(async () => LLM_MODEL), findByTaskTypeSharedRead: vi.fn(async () => []) };

/** The derived payload schema of a schema whose sole kind is `context` — the seeded shape. */
const PAYLOAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { context: { type: 'object', properties: { consultant_id: { type: 'string' } } } },
};

function agent(overrides: Record<string, unknown> = {}) {
  return {
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
    contextSchemaId: 'schema-1',
    contextSchemaVersionNumber: 2,
    instruction: { systemPrompt: 'You are a clinical scribe.' },
    parameters: null,
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
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    mockContextSchemas as never,
    mockReadiness as never,
  );
}

/** Publish and hand back the frozen `contextSchema` block. */
async function frozenContextSchema(resolution: Record<string, unknown>): Promise<Record<string, unknown>> {
  mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
  mockContextSchemas.resolveReference.mockResolvedValue(resolution);
  const published = await makeService().publish('agent-1', { activate: false });
  return (published.compiledConfig as unknown as { contextSchema: Record<string, unknown> }).contextSchema;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(clsStore)) delete clsStore[key];
  clsStore.tenantId = TENANT;
  clsStore.user = { id: 'user-1', roles: [] };
  mockClsService.get.mockImplementation((key: string) => clsStore[key]);
  mockClsService.run.mockImplementation(async (_options: unknown, work: () => unknown) => work());
  mockProviderConnections.resolveConnection.mockResolvedValue({ source: 'system', encryptedApiKey: new Uint8Array([1]) });
  mockProviderConnections.findRow.mockResolvedValue(null);
  mockReadiness.getSnapshot.mockResolvedValue(null);
  mockAiModelRepository.findById.mockResolvedValue(LLM_MODEL);
  mockAiModelRepository.findByIdOrNull.mockResolvedValue(LLM_MODEL);
  mockFallbackRepository.findByAgentId.mockResolvedValue([]);
  mockAgentRepository.update.mockImplementation(async (_id: string, entity: unknown) => entity);
  mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
});

describe('AgentService.publish — freezing the user-identity binding (test 17)', () => {
  it('FREEZES `userIdentity` beside `payloadSchema`, with its provenance intact', async () => {
    const contextSchema = await frozenContextSchema({
      outcome: 'resolved',
      schemaId: 'schema-1',
      versionNumber: 2,
      versionId: 'schema-1-v2',
      payloadSchema: PAYLOAD_SCHEMA,
      userIdentity: { kindKey: 'context', field: 'consultant_id' },
    });

    expect(contextSchema).toMatchObject({
      schemaId: 'schema-1',
      versionNumber: 2,
      versionId: 'schema-1-v2',
      payloadSchema: PAYLOAD_SCHEMA,
      userIdentity: { kindKey: 'context', field: 'consultant_id' },
    });
  });

  it('OMITS the key entirely when the pinned version declares no identity field — absent, never null', async () => {
    const contextSchema = await frozenContextSchema({
      outcome: 'resolved',
      schemaId: 'schema-1',
      versionNumber: 2,
      versionId: 'schema-1-v2',
      payloadSchema: PAYLOAD_SCHEMA,
      userIdentity: null,
    });

    expect(contextSchema).not.toHaveProperty('userIdentity');
    expect(contextSchema.payloadSchema).toEqual(PAYLOAD_SCHEMA);
  });

  it('OMITS the key for a resolver that predates the field — an old producer is not a null binding', async () => {
    const contextSchema = await frozenContextSchema({
      outcome: 'resolved',
      schemaId: 'schema-1',
      versionNumber: 2,
      versionId: 'schema-1-v2',
      payloadSchema: PAYLOAD_SCHEMA,
    });

    expect(contextSchema).not.toHaveProperty('userIdentity');
  });

  it('changes the compiled CHECKSUM only when a binding is actually frozen', async () => {
    const resolution = { outcome: 'resolved', schemaId: 'schema-1', versionNumber: 2, versionId: 'schema-1-v2', payloadSchema: PAYLOAD_SCHEMA };

    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
    mockContextSchemas.resolveReference.mockResolvedValue({ ...resolution, userIdentity: null });
    const bare = (await makeService().publish('agent-1', { activate: false })).compiledConfigChecksum;

    mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
    mockContextSchemas.resolveReference.mockResolvedValue({ ...resolution, userIdentity: { kindKey: 'context', field: 'consultant_id' } });
    const bound = (await makeService().publish('agent-1', { activate: false })).compiledConfigChecksum;

    expect(bound).not.toBe(bare);
  });
});
