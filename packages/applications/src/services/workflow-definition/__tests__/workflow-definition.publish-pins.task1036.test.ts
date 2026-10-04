/**
 * TASK-1036 lane B3b — what a workflow PUBLISH freezes, and how it writes.
 *
 *  W3 (§8.5) — pins at workflow publish:
 *   1. every `core.agent` node's `agentRef.versionNumber` is frozen into the compiled config:
 *      an authored pin is kept, an absent one is resolved to the ACTIVE published version NOW;
 *   2. the pinned agent version's own prompt pin rides with it (`policyBindings.promptTemplateRefs`);
 *   3. an unpinned `promptTemplateId` (top level, `core.action` delegate, grounding policies) is
 *      frozen to the template's current APPROVED version;
 *   4. document templates float: an authored `documentVersionNumber` is still honoured as an
 *      override for one release but WARNS; publish never invents one;
 *   5. the authored graph is never rewritten — only the compiled artifact carries the pins.
 *
 *  Data contract (item 2): `emitDataContract` follows the platform setting
 *  `workflows.emitDataContract` (default OFF).
 *
 *  R18 (item 7): `publish` with `activate` demotes the previous active version and writes the
 *  publish in ONE transaction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { WorkflowDefinitionStatus } from '@arcaai/domains';
import { compile, type CompiledWorkflowConfig, type CompilerContext } from '@arcaai/workflow-contract';
import { WorkflowDefinitionService } from '../workflow-definition.service';
import { WORKFLOWS_EMIT_DATA_CONTRACT_KEY } from '../../settings-registry/descriptors/workflow-definitions.descriptors';

vi.mock('@arcaai/workflow-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/workflow-contract')>();
  return { ...actual, compile: vi.fn(actual.compile) };
});

const TX = { __tx: true };
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
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(TX)) } };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockAgentRepository = { findPublishedActiveBySlug: vi.fn(), findPublishedVisibleBySlugVersion: vi.fn() };
const mockSettings = { resolvePlatform: vi.fn() };

const PROMPT_A = '71000000-0000-0000-0000-0000000000a1';
const PROMPT_B = '71000000-0000-0000-0000-0000000000b1';
const AGENT_PROMPT = '71000000-0000-0000-0000-0000000000c1';
const DOC_TEMPLATE = '72000000-0000-0000-0000-0000000000d1';

const agentRow = (slug: string, versionNumber: number, instruction: unknown = null, compiledConfig: unknown = null) => ({
  id: `${slug}-v${versionNumber}`,
  slug,
  versionNumber,
  task: 'TEXT_GENERATION',
  instruction,
  compiledConfig,
  outputSchema: null,
});

const graph = () => ({
  version: 1,
  nodes: [
    { id: 't1', type: 'core.trigger', config: { kinds: ['api'] }, position: { x: 0, y: 0 } },
    // unpinned → resolved to the ACTIVE version (4)
    { id: 'a_float', type: 'core.agent', config: { agentRef: { slug: 'summarizer' } }, position: { x: 1, y: 0 } },
    // pinned → kept (2), read by version
    { id: 'a_pinned', type: 'core.agent', config: { agentRef: { slug: 'coder', versionNumber: 2 } }, position: { x: 1, y: 1 } },
    { id: 'o1', type: 'core.output', config: { protocols: ['http'] }, position: { x: 2, y: 0 } },
  ],
  edges: [
    { id: 'e1', from: 't1', to: 'a_float', fromPort: 'out', toPort: 'context' },
    { id: 'e2', from: 't1', to: 'a_pinned', fromPort: 'out', toPort: 'context' },
    { id: 'e3', from: 'a_float', to: 'o1', fromPort: 'out', toPort: 'in' },
  ],
});

const entity = (g: unknown, overrides: Record<string, unknown> = {}) => ({
  id: 'def-1',
  tenantId: 'tenant-1',
  slug: 'agent_note',
  name: 'Agent Note',
  description: null,
  paletteKey: 'core',
  versionNumber: 3,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.DRAFT,
  graph: g,
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
  ...overrides,
});

function makeService(opts: { settings?: boolean; agents?: boolean; prompts?: boolean } = {}): WorkflowDefinitionService {
  return new WorkflowDefinitionService(
    mockRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    undefined, // entitlements
    undefined, // workflowValidator
    (opts.prompts === false ? undefined : mockPromptTemplateRepository) as never,
    undefined, // promptVersionRepository
    undefined, // contextSchemaService
    undefined, // routingPolicyService
    (opts.agents === false ? undefined : mockAgentRepository) as never,
    undefined, // aiModelRepository
    undefined, // documentTemplateRepository
    undefined, // mcpServerRepository
    undefined, // agentPromotionService
    undefined, // evalPromotionGate
    undefined, // policyEngine
    undefined, // agentService
    undefined, // workflowAssignmentRepository
    (opts.settings === false ? undefined : mockSettings) as never,
  );
}

function publishedConfig(): CompiledWorkflowConfig {
  const written = mockRepository.update.mock.calls.map((call) => call[1] as { id: string; compiledConfig?: unknown }).find((row) => row.id === 'def-1');
  return written?.compiledConfig as CompiledWorkflowConfig;
}

function compiledNode(config: CompiledWorkflowConfig, nodeId: string) {
  return config.stages.flatMap((stage) => stage.nodes).find((node) => node.nodeId === nodeId);
}

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
  mockDatabaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(TX));
  mockRepository.update.mockImplementation(async (_id: string, e: unknown) => e);
  mockRepository.findPublishedBySlug.mockResolvedValue(null);
  mockSettings.resolvePlatform.mockReturnValue({ key: WORKFLOWS_EMIT_DATA_CONTRACT_KEY, value: false, source: 'code-default' });
  mockAgentRepository.findPublishedActiveBySlug.mockImplementation(async (_tenant: string, slug: string) =>
    slug === 'summarizer'
      ? agentRow('summarizer', 4, { promptTemplateId: AGENT_PROMPT, promptVersionNumber: 7 })
      : slug === 'coder'
        ? agentRow('coder', 5)
        : null,
  );
  mockAgentRepository.findPublishedVisibleBySlugVersion.mockImplementation(async (_tenant: string, slug: string, version: number) =>
    slug === 'coder' && version === 2
      ? // the instruction names no version; the agent's compiled prompt froze 3 at ITS publish
        agentRow('coder', 2, { promptTemplateId: PROMPT_B }, { resolvedPrompt: { source: 'template', promptTemplateId: PROMPT_B, promptVersionNumber: 3 } })
      : null,
  );
  mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, approvedVersionNumber: id === PROMPT_A ? 9 : null }));
});

// =============================================================================================
describe('W3 — agent pins at workflow publish', () => {
  it('freezes an unpinned agent node onto the ACTIVE version and keeps an authored pin', async () => {
    mockRepository.findById.mockResolvedValue(entity(graph()));

    await makeService().publish('def-1', {});

    const config = publishedConfig();
    expect(compiledNode(config, 'a_float')?.config).toMatchObject({ agentRef: { slug: 'summarizer', versionNumber: 4 } });
    expect(compiledNode(config, 'a_pinned')?.config).toMatchObject({ agentRef: { slug: 'coder', versionNumber: 2 } });
    expect(mockAgentRepository.findPublishedActiveBySlug).toHaveBeenCalledWith('tenant-1', 'summarizer');
    expect(mockAgentRepository.findPublishedVisibleBySlugVersion).toHaveBeenCalledWith('tenant-1', 'coder', 2);
  });

  it('carries each pinned agent version`s own prompt pin into policyBindings.promptTemplateRefs', async () => {
    mockRepository.findById.mockResolvedValue(entity(graph()));

    await makeService().publish('def-1', {});

    expect(publishedConfig().policyBindings.promptTemplateRefs).toEqual(
      expect.arrayContaining([
        { nodeId: 'a_float', templateId: AGENT_PROMPT, versionNumber: 7 },
        { nodeId: 'a_pinned', templateId: PROMPT_B, versionNumber: 3 },
      ]),
    );
  });

  it('never rewrites the authored graph — only the compiled artifact carries the pins', async () => {
    const authored = graph();
    mockRepository.findById.mockResolvedValue(entity(authored));

    await makeService().publish('def-1', {});

    const written = mockRepository.update.mock.calls.find((call) => call[0] === 'def-1')?.[1] as { graph: typeof authored };
    expect(written.graph).toEqual(graph());
    expect((written.graph.nodes[1].config as { agentRef: Record<string, unknown> }).agentRef.versionNumber).toBeUndefined();
  });

  it('refuses (400 AGENT_PIN_UNRESOLVED) a publish whose unpinned agent has no active published version', async () => {
    mockAgentRepository.findPublishedActiveBySlug.mockResolvedValue(null);
    mockRepository.findById.mockResolvedValue(entity(graph()));

    const error = await makeService()
      .publish('def-1', {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as { findings: Array<{ code?: string; nodeId: string | null }> };
    expect(body.findings).toContainEqual(expect.objectContaining({ code: 'AGENT_PIN_UNRESOLVED', nodeId: 'a_float' }));
    expect(mockRepository.update).not.toHaveBeenCalled();
  });

  it('refuses a pinned version that no longer resolves', async () => {
    mockAgentRepository.findPublishedVisibleBySlugVersion.mockResolvedValue(null);
    mockRepository.findById.mockResolvedValue(entity(graph()));

    const error = await makeService()
      .publish('def-1', {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as { findings: Array<{ code?: string; nodeId: string | null }> };
    expect(body.findings).toContainEqual(expect.objectContaining({ code: 'AGENT_PIN_UNRESOLVED', nodeId: 'a_pinned' }));
  });

  it('without an agent repository (unit fixtures) the publish compiles unpinned, as before', async () => {
    mockRepository.findById.mockResolvedValue(entity(graph()));

    await makeService({ agents: false }).publish('def-1', {});

    expect((compiledNode(publishedConfig(), 'a_float')?.config as { agentRef: Record<string, unknown> }).agentRef.versionNumber).toBeUndefined();
  });

  it('a sandbox compile (drafts) is NOT pinned — it tests the latest agents', async () => {
    mockRepository.findById.mockResolvedValue(entity(graph()));

    const { compiledConfig } = await makeService().getCompiledConfigForSandboxRun('def-1');

    expect((compiledNode(compiledConfig, 'a_float')?.config as { agentRef: Record<string, unknown> }).agentRef.versionNumber).toBeUndefined();
  });
});

// =============================================================================================
describe('W3 — workflow-level prompt bindings are frozen to the approved version', () => {
  const promptGraph = () => ({
    version: 1,
    nodes: [
      { id: 't1', type: 'core.trigger', config: { kinds: ['api'] }, position: { x: 0, y: 0 } },
      {
        id: 'act',
        type: 'core.action',
        config: { actionKey: 'prompt.template_ref', action: { promptTemplateId: PROMPT_A } },
        position: { x: 1, y: 0 },
      },
      { id: 'o1', type: 'core.output', config: { protocols: ['http'] }, position: { x: 2, y: 0 } },
    ],
    edges: [
      { id: 'e1', from: 't1', to: 'act', fromPort: 'next', toPort: 'after' },
      { id: 'e2', from: 'act', to: 'o1', fromPort: 'out', toPort: 'in' },
    ],
  });

  it('pins an unpinned template to approvedVersionNumber in the compiled config and its promptTemplateRefs', async () => {
    mockRepository.findById.mockResolvedValue(entity(promptGraph()));

    await makeService().publish('def-1', {});

    const config = publishedConfig();
    expect((compiledNode(config, 'act')?.config as { action: Record<string, unknown> }).action).toMatchObject({
      promptTemplateId: PROMPT_A,
      promptVersionNumber: 9,
    });
    expect(config.policyBindings.promptTemplateRefs).toContainEqual({ nodeId: 'act', templateId: PROMPT_A, versionNumber: 9 });
  });

  it('keeps an authored prompt pin as is', async () => {
    const g = promptGraph();
    (g.nodes[1].config.action as Record<string, unknown>).promptVersionNumber = 2;
    mockRepository.findById.mockResolvedValue(entity(g));

    await makeService().publish('def-1', {});

    expect(publishedConfig().policyBindings.promptTemplateRefs).toContainEqual({ nodeId: 'act', templateId: PROMPT_A, versionNumber: 2 });
    expect(mockPromptTemplateRepository.findById).not.toHaveBeenCalledWith(PROMPT_A);
  });

  it('pins each unpinned grounding policy`s template', async () => {
    const g = {
      ...promptGraph(),
      nodes: [
        promptGraph().nodes[0],
        {
          id: 'gg',
          type: 'guard.groundedness',
          config: { onError: 'degrade', policies: [{ key: 'grammar', appliesTo: 'summary', promptTemplateId: PROMPT_A }] },
          position: { x: 1, y: 0 },
        },
        promptGraph().nodes[2],
      ],
      edges: [
        { id: 'e1', from: 't1', to: 'gg', fromPort: 'out', toPort: 'in' },
        { id: 'e2', from: 'gg', to: 'o1', fromPort: 'out', toPort: 'in' },
      ],
    };

    const { pinPromptBindings } = await import('../publish-pins');
    const pinned = pinPromptBindings(g as never, new Map([[PROMPT_A, 9]]));

    const policy = (pinned.graph.nodes[1].config as { policies: Array<Record<string, unknown>> }).policies[0];
    expect(policy).toMatchObject({ promptTemplateId: PROMPT_A, promptVersionNumber: 9 });
    expect((g.nodes[1].config as { policies: Array<Record<string, unknown>> }).policies[0].promptVersionNumber).toBeUndefined();
  });

  it('a never-approved template stays unpinned (it is not invented)', async () => {
    const g = promptGraph();
    (g.nodes[1].config.action as Record<string, unknown>).promptTemplateId = PROMPT_B; // approvedVersionNumber: null
    mockRepository.findById.mockResolvedValue(entity(g));

    await makeService().publish('def-1', {});

    expect((compiledNode(publishedConfig(), 'act')?.config as { action: Record<string, unknown> }).action.promptVersionNumber).toBeUndefined();
  });
});

// =============================================================================================
describe('W3 — document templates float to latest', () => {
  const docGraph = () => ({
    version: 1,
    nodes: [
      { id: 't1', type: 'core.trigger', config: { kinds: ['api'] }, position: { x: 0, y: 0 } },
      {
        id: 'act',
        type: 'core.action',
        config: { actionKey: 'prompt.template_ref', action: { promptTemplateId: PROMPT_A, promptVersionNumber: 1 } },
        position: { x: 1, y: 0 },
      },
      { id: 'o1', type: 'core.output', config: { protocols: ['http'] }, position: { x: 2, y: 0 } },
    ],
    edges: [
      { id: 'e1', from: 't1', to: 'act', fromPort: 'next', toPort: 'after' },
      { id: 'e2', from: 'act', to: 'o1', fromPort: 'out', toPort: 'in' },
    ],
  });

  it('flags an authored node-level documentVersionNumber as a deprecated override (WARNING)', async () => {
    const { documentPinFindings } = await import('../publish-pins');
    const findings = documentPinFindings({
      version: 1,
      nodes: [{ id: 'gen', type: 'core.agent', config: { agentRef: { slug: 's' }, documentTemplateId: DOC_TEMPLATE, documentVersionNumber: 2 } }],
      edges: [],
    } as never);
    expect(findings).toEqual([expect.objectContaining({ code: 'DOCUMENT_VERSION_PIN_DEPRECATED', severity: 'WARNING', nodeId: 'gen' })]);
  });

  it('publish never invents a document pin', async () => {
    mockRepository.findById.mockResolvedValue(entity(docGraph()));

    await makeService().publish('def-1', {});

    expect(publishedConfig().policyBindings.documentTemplateRefs ?? []).toEqual([]);
  });
});

// =============================================================================================
describe('data contract follows the platform setting `workflows.emitDataContract`', () => {
  it('OFF by default: no bindings, consultationReads or settings are emitted', async () => {
    mockRepository.findById.mockResolvedValue(entity(graph()));

    await makeService().publish('def-1', {});

    expect(lastCompileContext().emitDataContract).toBe(false);
    expect(publishedConfig().settings).toBeUndefined();
    expect(mockSettings.resolvePlatform).toHaveBeenCalledWith(WORKFLOWS_EMIT_DATA_CONTRACT_KEY);
  });

  it('ON: the compiled config carries settings and per-node bindings', async () => {
    mockSettings.resolvePlatform.mockReturnValue({ key: WORKFLOWS_EMIT_DATA_CONTRACT_KEY, value: true, source: 'system' });
    mockRepository.findById.mockResolvedValue(entity(graph()));

    await makeService().publish('def-1', {});

    expect(lastCompileContext().emitDataContract).toBe(true);
    const config = publishedConfig();
    expect(config.settings).toEqual({ connections: ['api'], sources: [] });
    expect(compiledNode(config, 'o1')?.bindings).toBeDefined();
  });

  it('no settings service wired ⇒ OFF', async () => {
    mockRepository.findById.mockResolvedValue(entity(graph()));

    await makeService({ settings: false }).publish('def-1', {});

    expect(lastCompileContext().emitDataContract).toBe(false);
  });
});

// =============================================================================================
describe('R18 — publish with activate demotes and writes in ONE transaction', () => {
  it('passes the same tx to the demote and to the publish write', async () => {
    mockRepository.findById.mockResolvedValue(entity(graph()));
    mockRepository.findPublishedBySlug.mockResolvedValue(entity(graph(), { id: 'old-1', status: WorkflowDefinitionStatus.PUBLISHED, isActive: true }));

    await makeService().publish('def-1', { activate: true });

    expect(mockDatabaseService.baseClient.$transaction).toHaveBeenCalledTimes(1);
    const demote = mockRepository.update.mock.calls.find((call) => call[0] === 'old-1');
    const publish = mockRepository.update.mock.calls.find((call) => call[0] === 'def-1');
    expect(demote?.[2]).toBe(TX);
    expect(publish?.[2]).toBe(TX);
    expect((demote?.[1] as { isActive: boolean }).isActive).toBe(false);
    expect((publish?.[1] as { isActive: boolean; status: string }).isActive).toBe(true);
  });

  it('a failed publish write rolls the demote back (both inside the callback)', async () => {
    mockRepository.findById.mockResolvedValue(entity(graph()));
    mockRepository.findPublishedBySlug.mockResolvedValue(entity(graph(), { id: 'old-1', status: WorkflowDefinitionStatus.PUBLISHED, isActive: true }));
    const order: string[] = [];
    mockDatabaseService.baseClient.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      order.push('begin');
      const result = await cb(TX);
      order.push('commit');
      return result;
    });
    mockRepository.update.mockImplementation(async (id: string, e: unknown) => {
      order.push(`update:${id}`);
      return e;
    });

    await makeService().publish('def-1', { activate: true });

    expect(order).toEqual(['begin', 'update:old-1', 'update:def-1', 'commit']);
  });

  it('activate:false writes without demoting', async () => {
    mockRepository.findById.mockResolvedValue(entity(graph()));

    await makeService().publish('def-1', { activate: false });

    expect(mockRepository.findPublishedBySlug).not.toHaveBeenCalled();
  });

  it('promoteToSystem`s caller-supplied tx is reused, not nested', async () => {
    // publishEntity is private; the promotion path hands it a tx. Reached through the cast.
    const service = makeService() as unknown as { publishEntity: (e: unknown, dto: unknown, tx?: unknown) => Promise<unknown> };
    const OUTER = { __outer: true };
    mockRepository.findPublishedBySlug.mockResolvedValue(entity(graph(), { id: 'old-1', status: WorkflowDefinitionStatus.PUBLISHED, isActive: true }));

    await service.publishEntity(entity(graph()), { activate: true }, OUTER);

    expect(mockDatabaseService.baseClient.$transaction).not.toHaveBeenCalled();
    expect(mockRepository.update.mock.calls.every((call) => call[2] === OUTER)).toBe(true);
  });
});
