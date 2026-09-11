/**
 * TASK-951 item 2 — publish FREEZES the open-time bindings beside the payload schema and the
 * identity binding.
 *
 * Same invariant TASK-950 pinned for `userIdentity`, and it matters more here rather than less:
 * `openBindings` is what tells the `open` path WHERE a client's department, visit type and
 * external reference live. Resolved live, a tenant editing its schema mid-consultation would
 * silently change which department an in-flight agent routes to — the retroactivity the freeze
 * exists to prevent.
 *
 * The absence half is the additive posture, and it is not cosmetic: `compiledConfig` is
 * checksummed, so an agent whose schema declares no mappings must carry NO key. A key that
 * always appeared — even as `{}` — would move the checksum of every artifact that never used
 * it, the committed seed agents included.
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
const mockAiModelRepository = {
  findById: vi.fn(async () => LLM_MODEL),
  findByIdOrNull: vi.fn(async () => LLM_MODEL),
  findByTaskTypeSharedRead: vi.fn(async () => []),
};

/** The derived payload schema of the scribe schema, reduced to what the freeze site touches. */
const PAYLOAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    encounter: {
      type: 'object',
      properties: {
        doctor_id: { type: 'string' },
        department_code: { type: 'string' },
        visit_type: { type: 'string' },
        event_id: { type: 'string' },
      },
    },
  },
};

/** What `openBindingsFromDefinition` derives from the ArcaAI scribe schema. */
const OPEN_BINDINGS = {
  userIdentity: { kindKey: 'encounter', field: 'doctor_id' },
  department: { kindKey: 'encounter', field: 'department_code', by: 'code' },
  visitType: { kindKey: 'encounter', field: 'visit_type' },
  externalRef: { kindKey: 'encounter', field: 'event_id' },
  materialize: [{ kindKey: 'previous_case_notes', as: 'CASE_NOTE' }],
};

const RESOLUTION = { outcome: 'resolved', schemaId: 'schema-1', versionNumber: 2, versionId: 'schema-1-v2', payloadSchema: PAYLOAD_SCHEMA };

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

async function checksumFor(resolution: Record<string, unknown>): Promise<string> {
  mockAgentRepository.findByIdVisible.mockResolvedValue(agent());
  mockContextSchemas.resolveReference.mockResolvedValue(resolution);
  const published = await makeService().publish('agent-1', { activate: false });
  return published.compiledConfigChecksum as unknown as string;
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

describe('AgentService.publish — freezing the open-time bindings', () => {
  it('FREEZES `openBindings` beside `payloadSchema`, whole and verbatim', async () => {
    const contextSchema = await frozenContextSchema({ ...RESOLUTION, userIdentity: OPEN_BINDINGS.userIdentity, openBindings: OPEN_BINDINGS });

    expect(contextSchema).toMatchObject({
      schemaId: 'schema-1',
      versionNumber: 2,
      versionId: 'schema-1-v2',
      payloadSchema: PAYLOAD_SCHEMA,
      userIdentity: OPEN_BINDINGS.userIdentity,
      openBindings: OPEN_BINDINGS,
    });
  });

  it('freezes `openBindings` even when the schema declares no IDENTITY — the roles are independent', async () => {
    const routingOnly = { department: { kindKey: 'encounter', field: 'department_code', by: 'name' } };
    const contextSchema = await frozenContextSchema({ ...RESOLUTION, userIdentity: null, openBindings: routingOnly });

    expect(contextSchema).not.toHaveProperty('userIdentity');
    expect(contextSchema.openBindings).toEqual(routingOnly);
  });

  it('OMITS the key entirely when the pinned version declares no mappings — absent, never `{}`', async () => {
    const contextSchema = await frozenContextSchema({ ...RESOLUTION, userIdentity: null });

    expect(contextSchema).not.toHaveProperty('openBindings');
    expect(contextSchema.payloadSchema).toEqual(PAYLOAD_SCHEMA);
  });

  it('OMITS the key for a resolver that predates the field — an old producer is not an empty binding set', async () => {
    const contextSchema = await frozenContextSchema(RESOLUTION);

    expect(contextSchema).not.toHaveProperty('openBindings');
    expect(contextSchema).not.toHaveProperty('userIdentity');
  });

  it('changes the compiled CHECKSUM only when bindings are actually frozen', async () => {
    const bare = await checksumFor(RESOLUTION);
    const bareAgain = await checksumFor({ ...RESOLUTION, userIdentity: null });
    const bound = await checksumFor({ ...RESOLUTION, userIdentity: OPEN_BINDINGS.userIdentity, openBindings: OPEN_BINDINGS });

    // A resolver that predates the field and one that resolved nothing produce the SAME
    // artifact — that is what makes the additive posture real rather than merely intended.
    expect(bareAgain).toBe(bare);
    expect(bound).not.toBe(bare);
  });

  it('never re-reads the schema row — the resolver is consulted once, at publish', async () => {
    await frozenContextSchema({ ...RESOLUTION, openBindings: OPEN_BINDINGS });

    expect(mockContextSchemas.resolveReference).toHaveBeenCalledTimes(1);
    expect(mockContextSchemas.resolveReference).toHaveBeenCalledWith('schema-1', 2);
  });
});
