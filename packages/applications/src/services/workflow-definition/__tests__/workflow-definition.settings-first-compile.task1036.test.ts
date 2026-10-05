/**
 * TASK-1036 contract freeze — the compile and publish contexts read the SAME, settings-first,
 * context schema, and know the graph's agents.
 *
 *  1. `graph.settings.contextSchema` WINS over the trigger's own reference (D-4: settings first,
 *     trigger as the one-release fallback). The compiler already froze the settings' REFERENCE onto
 *     the trigger, but the service resolved the TRIGGER's reference — so a graph whose two
 *     disagreed compiled the settings' schema id beside the trigger's `resolved` payload. The
 *     resolution, the frozen payload, the stamped columns and the publish gate must all name the
 *     settings' schema.
 *  2. The compile context carries `agents` (task + output schema by slug, from the same agent views
 *     the publish gate loads), so the legacy edge translation keys an NER / TTS agent's input
 *     `text` rather than the default `message`.
 *  3. The publish gate receives the Input shape's `contextSchemaDefinition`, so WF-SET-003/004
 *     (stream audio needs socket; an upload needs api) actually run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionStatus } from '@arcaai/domains';
import { compile, compiledBindings, type CompilerContext } from '@arcaai/workflow-contract';
import { WorkflowDefinitionService } from '../workflow-definition.service';

vi.mock('@arcaai/workflow-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/workflow-contract')>();
  return { ...actual, compile: vi.fn(actual.compile) };
});

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
  findMaxVersionNumber: vi.fn(),
  findPublishedBySlug: vi.fn(),
  findAllVersionsBySlug: vi.fn(),
};
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockContextSchemaService = { getEffectiveBundle: vi.fn(), resolveReference: vi.fn(), listVersions: vi.fn() };
const mockAgentService = { publishAgentViews: vi.fn() };

/** `core.trigger`'s own config schema requires UUIDs. */
const TRIGGER_SCHEMA_ID = '79000000-0000-0000-0001-000000000010';
const SETTINGS_SCHEMA_ID = '79000000-0000-0000-0001-000000000020';

const payloadFor = (field: string) => ({ type: 'object', additionalProperties: false, properties: { [field]: { type: 'string' } } });
const DEFINITION_WITH_STREAM_AUDIO = {
  schemaVersion: '1.0',
  kinds: [{ key: 'mic', label: 'Mic', primitive: 'STREAM_AUDIO', phiClass: 'PHI', cardinality: 'ONE', lifecycle: 'DURING', producedBy: ['CLIENT'] }],
};

const settingsGraph = (connections: string[] = ['api']) => ({
  version: 1,
  settings: { connections, sources: [], contextSchema: { contextSchemaId: SETTINGS_SCHEMA_ID, versionNumber: 3 } },
  nodes: [
    {
      id: 't1',
      type: 'core.trigger',
      config: { kinds: ['api'], contextSchema: { contextSchemaId: TRIGGER_SCHEMA_ID, versionNumber: 2 } },
      position: { x: 0, y: 0 },
    },
    { id: 'a1', type: 'core.agent', config: { agentRef: { slug: 'summarizer' } }, position: { x: 1, y: 0 } },
    { id: 'o1', type: 'core.output', config: { protocols: ['http'] }, position: { x: 2, y: 0 } },
  ],
  edges: [
    { id: 'e1', from: 't1', to: 'a1', fromPort: 'out', toPort: 'context' },
    { id: 'e2', from: 'a1', to: 'o1', fromPort: 'out', toPort: 'in' },
  ],
});

/** Legacy data edges into an NER and a TTS agent: their `in` port is the agent's `text` input. */
const agentsGraph = () => ({
  version: 1,
  nodes: [
    { id: 't1', type: 'core.trigger', config: { kinds: ['api'] }, position: { x: 0, y: 0 } },
    { id: 'n_gen', type: 'core.agent', config: { agentRef: { slug: 'summarizer' } }, position: { x: 1, y: 0 } },
    { id: 'n_ner', type: 'core.agent', config: { agentRef: { slug: 'ner' } }, position: { x: 2, y: 0 } },
    { id: 'n_tts', type: 'core.agent', config: { agentRef: { slug: 'speaker' } }, position: { x: 2, y: 1 } },
    { id: 'o1', type: 'core.output', config: { protocols: ['http'] }, position: { x: 3, y: 0 } },
  ],
  edges: [
    { id: 'e1', from: 't1', to: 'n_gen', fromPort: 'out', toPort: 'context' },
    { id: 'e2', from: 'n_gen', to: 'n_ner', fromPort: 'out', toPort: 'in' },
    { id: 'e3', from: 'n_gen', to: 'n_tts', fromPort: 'out', toPort: 'in' },
    { id: 'e4', from: 'n_ner', to: 'o1', fromPort: 'out', toPort: 'in' },
  ],
});

const VIEW = { declaredVariables: [], contextPayloadSchema: null };

const entity = (graph: unknown) => ({
  id: 'def-1',
  tenantId: 'tenant-1',
  slug: 'agent_note',
  name: 'Agent Note',
  description: null,
  paletteKey: 'core',
  versionNumber: 1,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.DRAFT,
  graph,
  graphChecksum: 'c1',
  compiledConfig: null,
  compiledConfigChecksum: null,
  registryChecksum: null,
  contextSchemaId: null,
  contextSchemaVersionNumber: null,
  contextSchemaFollowsLatest: false,
  validationReport: null,
  needsReview: false,
  validatedAt: null,
  publishedAt: null,
  deprecatedAt: null,
  isActive: false,
  resourceStatus: 'ENABLED',
  createdAt: new Date('2026-10-04T00:00:00Z'),
  updatedAt: new Date('2026-10-04T00:00:00Z'),
  version: 1,
  tags: [],
  hasChanges: true,
  changes: {},
});

function makeService(): WorkflowDefinitionService {
  return new WorkflowDefinitionService(
    mockRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    undefined, // entitlements
    undefined, // workflowValidator
    undefined, // promptTemplateRepository
    undefined, // promptVersionRepository
    mockContextSchemaService as never,
    undefined, // routingPolicyService
    undefined, // agentRepository
    undefined, // aiModelRepository
    undefined, // documentTemplateRepository
    undefined, // mcpServerRepository
    undefined, // agentPromotionService
    undefined, // evalPromotionGate
    undefined, // policyEngine
    mockAgentService as never,
  );
}

/** The context the LAST `compile()` call received. */
function lastCompileContext(): CompilerContext {
  const calls = vi.mocked(compile).mock.calls;
  return calls[calls.length - 1]?.[1] as CompilerContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClsService.get.mockImplementation((key: string) => {
    if (key === 'tenantId') return 'tenant-1';
    if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
    return undefined;
  });
  mockRepository.update.mockImplementation(async (_id: string, e: unknown) => e);
  mockRepository.updateWithVersion.mockImplementation(async (_id: string, e: unknown) => e);
  mockRepository.findPublishedBySlug.mockResolvedValue(null);
  mockContextSchemaService.getEffectiveBundle.mockResolvedValue({ contextSchemaVersionId: null });
  mockContextSchemaService.resolveReference.mockImplementation(async (schemaId: string, versionNumber?: number) => ({
    outcome: 'resolved',
    schemaId,
    versionNumber: versionNumber ?? 1,
    versionId: `${schemaId}-v${versionNumber ?? 1}`,
    payloadSchema: payloadFor(schemaId === SETTINGS_SCHEMA_ID ? 'fromSettings' : 'fromTrigger'),
  }));
  mockContextSchemaService.listVersions.mockResolvedValue([]);
  mockAgentService.publishAgentViews.mockResolvedValue({
    summarizer: { ...VIEW, task: 'TEXT_GENERATION' },
    ner: { ...VIEW, task: 'NAMED_ENTITY_RECOGNITION' },
    speaker: { ...VIEW, task: 'TEXT_TO_SPEECH' },
  });
});

describe('settings-first context schema at compile and publish', () => {
  it('resolves the SETTINGS reference, never the trigger`s, and freezes ITS ref beside ITS payload', async () => {
    mockRepository.findById.mockResolvedValue(entity(settingsGraph()));

    const { compiledConfig } = await makeService().getCompiledConfigForSandboxRun('def-1');

    expect(mockContextSchemaService.resolveReference).toHaveBeenCalledWith(SETTINGS_SCHEMA_ID, 3);
    expect(mockContextSchemaService.resolveReference).not.toHaveBeenCalledWith(TRIGGER_SCHEMA_ID, expect.anything());
    const trigger = compiledConfig.stages.flatMap((stage) => stage.nodes).find((node) => node.nodeId === 't1');
    expect((trigger?.config as { contextSchema: unknown }).contextSchema).toEqual({
      contextSchemaId: SETTINGS_SCHEMA_ID,
      versionNumber: 3,
      resolved: payloadFor('fromSettings'),
    });
    expect(compiledConfig.policyBindings.contextSchemaRefs).toEqual([
      { nodeId: 't1', schemaId: SETTINGS_SCHEMA_ID, versionNumber: 3, versionId: `${SETTINGS_SCHEMA_ID}-v3` },
    ]);
  });

  it('publish stamps the SETTINGS schema on the columns; follow-latest is read off the settings', async () => {
    const graph = settingsGraph();
    (graph.settings.contextSchema as { versionNumber: number | null }).versionNumber = null;
    mockRepository.findById.mockResolvedValue(entity(graph));

    await makeService().publish('def-1', {});

    expect(mockContextSchemaService.resolveReference).toHaveBeenCalledWith(SETTINGS_SCHEMA_ID, undefined);
    expect(mockRepository.update.mock.calls[0]?.[1]).toMatchObject({
      contextSchemaId: SETTINGS_SCHEMA_ID,
      contextSchemaFollowsLatest: true,
    });
  });

  it('a graph without settings keeps resolving the trigger`s reference (the one-release fallback)', async () => {
    const legacy = settingsGraph() as Record<string, unknown>;
    delete legacy.settings;
    mockRepository.findById.mockResolvedValue(entity(legacy));

    await makeService().getCompiledConfigForSandboxRun('def-1');

    expect(mockContextSchemaService.resolveReference).toHaveBeenCalledWith(TRIGGER_SCHEMA_ID, 2);
  });

  it('the publish gate receives the Input shape`s definition: a STREAM audio kind needs the socket (WF-SET-003)', async () => {
    mockContextSchemaService.listVersions.mockResolvedValue([
      { versionNumber: 2, definition: { schemaVersion: '1.0', kinds: [] } },
      { versionNumber: 3, definition: DEFINITION_WITH_STREAM_AUDIO },
    ]);
    mockRepository.findById.mockResolvedValue(entity(settingsGraph(['api'])));

    const validated = await makeService().validate('def-1');

    expect(mockContextSchemaService.listVersions).toHaveBeenCalledWith(SETTINGS_SCHEMA_ID);
    const findings = (validated.validationReport as unknown as { findings: Array<{ code?: string; severity: string }> }).findings;
    expect(findings).toContainEqual(expect.objectContaining({ code: 'SETTINGS_LIVE_AUDIO_REQUIRES_SOCKET', severity: 'ERROR' }));
  });
});

describe('the compile context knows the graph`s agents', () => {
  it('passes task + output schema by slug, so an NER / TTS input is keyed `text`, not `message`', async () => {
    mockRepository.findById.mockResolvedValue(entity(agentsGraph()));

    await makeService().getCompiledConfigForSandboxRun('def-1');

    const ctx = lastCompileContext();
    expect(ctx.agents).toEqual({
      summarizer: { task: 'TEXT_GENERATION', outputSchema: undefined },
      ner: { task: 'NAMED_ENTITY_RECOGNITION', outputSchema: undefined },
      speaker: { task: 'TEXT_TO_SPEECH', outputSchema: undefined },
    });
    const bindings = compiledBindings(agentsGraph() as never, ctx.agents);
    expect(bindings.n_ner).toEqual({ text: { from: 'nodes.n_gen.outputs.text' } });
    expect(bindings.n_tts).toEqual({ text: { from: 'nodes.n_gen.outputs.text' } });
  });

  it('validate and publish compile with the same agents the gate checked against', async () => {
    mockRepository.findById.mockResolvedValue(entity(agentsGraph()));

    await makeService().validate('def-1');

    expect(lastCompileContext().agents?.ner?.task).toBe('NAMED_ENTITY_RECOGNITION');
    expect(mockAgentService.publishAgentViews).toHaveBeenCalledTimes(1);
  });
});
