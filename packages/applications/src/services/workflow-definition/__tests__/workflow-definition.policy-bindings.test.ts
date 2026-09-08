/**
 * `compiledConfig.policyBindings` must describe THIS graph, for THIS tenant.
 *
 * `DEFAULT_POLICY_BINDINGS` hardcoded `contextSchemaVersionId: null`, `promptTemplateRefs: []`
 * and `entitlementKeys: []`, and every compile passed that same frozen object. So a published
 * clinical workflow pinned NOTHING:
 *
 * - **`contextSchemaVersionId: null`** — the compiled artifact never recorded WHICH version of
 *   the tenant's `ConsultationContextSchema` it was validated against. The schema could then be
 *   republished under the running workflow and nothing in the artifact would show that the
 *   contract had moved. That is the same class of defect DD-11's prompt pin exists to prevent,
 *   one layer down.
 * - **`promptTemplateRefs: []`** — DD-11 stores each node's pin on the node's own config, but
 *   the compiled artifact is what the interpreter reads. An empty list meant the pins were
 *   invisible to everything downstream of the compiler.
 * - **`entitlementKeys: []`** — every registry descriptor is `entitlementKey: null` TODAY (R-7:
 *   `PlanEntitlement` is column-per-key, so gating a palette needs a migration). Deriving the
 *   list rather than hardcoding it is therefore a no-op on today's values BY DESIGN — the point
 *   is that the day a descriptor gains a key, the published artifact carries it instead of
 *   silently continuing to claim the workflow needs no entitlement.
 *
 * `guardrailProfile` and `redactionRuleSetId` are deliberately NOT in scope here: neither is
 * derivable from the graph, and D-7 named exactly the three fields above.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

/**
* the two document templates the graph below binds. `DOC_LIVE` sorts BEFORE
 *  `DOC_SYNTH` by node id (`n_live` < `n_synth`) while being authored AFTER it, so a derivation
 *  that followed authoring order is distinguishable from one that sorts. 
 */
const DOC_SYNTH = 'b2c9a1d4-7e36-4f80-8a15-3c6d9e2f0b47';
const DOC_LIVE = 'a41b6d0c-2f38-4c77-9a51-6d2e7b0c4f93';

/**
 * Two nodes share ONE prompt template; only `n_gen` carries a prompt pin, and `n_out` carries no
 * binding at all. `n_synth`/`n_live` carry PINNED document-template bindings in an authoring
 * order that is not their sorted order, and `n_suggest` carries an UNPINNED one.
 */
const GRAPH = {
  version: 1,
  nodes: [
    { id: 't1', type: 'core.trigger', config: { kinds: ['api'] }, position: { x: 0, y: 0 } },
    // TASK-893 — `prompt.template_ref` is an ACTION now, so the prompt binding rides under
    // `config.action`; `core.action`'s schema is `additionalProperties: false`, which is why it
    // cannot ride at the top level any more (see `node-prompt-binding.ts`).
    {
      id: 'n_prompt',
      type: 'core.action',
      config: { actionKey: 'prompt.template_ref', action: { promptTemplateId: '3f1a7c2e-5b84-4d19-9e63-0a2c8d5f7b41' } },
      position: { x: 1, y: 0 },
    },
    {
      id: 'n_gen',
      type: 'core.action',
      config: { actionKey: 'prompt.template_ref', action: { promptTemplateId: '3f1a7c2e-5b84-4d19-9e63-0a2c8d5f7b41', promptVersionNumber: 4 } },
      position: { x: 2, y: 0 },
    },
    // The DOCUMENT binding is declared by `core.agent`'s own schema, at the top level.
    {
      id: 'n_synth',
      type: 'core.agent',
      config: { agentRef: { slug: 'synthesizer' }, onError: 'fail', documentTemplateId: DOC_SYNTH, documentVersionNumber: 2 },
      position: { x: 3, y: 0 },
    },
    {
      id: 'n_live',
      type: 'core.agent',
      config: { agentRef: { slug: 'live-note' }, onError: 'degrade', documentTemplateId: DOC_LIVE, documentVersionNumber: 7 },
      position: { x: 4, y: 0 },
    },
    {
      id: 'n_suggest',
      type: 'core.agent',
      config: { agentRef: { slug: 'suggester' }, onError: 'degrade', documentTemplateId: DOC_LIVE },
      position: { x: 5, y: 0 },
    },
    { id: 'n_out', type: 'core.output', config: { protocols: ['http'] }, position: { x: 6, y: 0 } },
  ],
  edges: [],
};

const mockWorkflowDefinitionRepository = {
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

const mockDatabaseService = {
  baseClient: { $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({ tx: true })) },
};

const mockContextSchemaService = { getEffectiveBundle: vi.fn() };

const bundle = (contextSchemaVersionId: string | null) => ({
  schemaId: contextSchemaVersionId ? 'schema-1' : null,
  slug: null,
  name: null,
  versionNumber: contextSchemaVersionId ? 3 : null,
  contextSchemaVersionId,
  checksum: null,
  definition: null,
  etag: 'etag-1',
});

const definitionEntity = (overrides: Record<string, unknown> = {}) => ({
  id: 'def-1',
  tenantId: 'tenant-1',
  slug: 'discharge_summary',
  name: 'Discharge Summary',
  paletteKey: 'core',
  versionNumber: 1,
  status: WorkflowDefinitionStatus.DRAFT,
  graph: GRAPH,
  graphChecksum: 'c1',
  compiledConfig: null,
  compiledConfigChecksum: null,
  registryChecksum: null,
  validationReport: null,
  needsReview: false,
  validatedAt: null,
  publishedAt: null,
  deprecatedAt: null,
  isActive: false,
  resourceStatus: 'ENABLED',
  createdAt: new Date('2026-08-28T00:00:00Z'),
  updatedAt: new Date('2026-08-28T00:00:00Z'),
  version: 1,
  tags: [],
  description: null,
  parentVersionId: null,
  hasChanges: false,
  changes: {},
  ...overrides,
});

/** The `policyBindings` block the publish above actually stamped onto the row. */
function publishedBindings(entity: { compiledConfig: unknown }) {
  return (entity.compiledConfig as { policyBindings: Record<string, unknown> }).policyBindings;
}

describe('D-7 — publish populates policyBindings from what the graph and tenant actually reference', () => {
  let service: WorkflowDefinitionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
      return undefined;
    });
    mockWorkflowDefinitionRepository.findById.mockResolvedValue(definitionEntity());
    mockWorkflowDefinitionRepository.update.mockImplementation(async (_id, entity) => entity);
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);
    mockContextSchemaService.getEffectiveBundle.mockResolvedValue(bundle('ctxver-1'));

    service = new WorkflowDefinitionService(
      mockWorkflowDefinitionRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockDatabaseService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mockContextSchemaService as never,
    );
  });

  it('pins the tenant’s REAL context schema version id, never null', async () => {
    await service.publish('def-1', {});

    const [, entity] = mockWorkflowDefinitionRepository.update.mock.calls[0];
    expect(publishedBindings(entity).contextSchemaVersionId).toBe('ctxver-1');
  });

  it('re-pins when the schema is republished and the workflow is published again', async () => {
    await service.publish('def-1', {});
    const [, first] = mockWorkflowDefinitionRepository.update.mock.calls[0];
    expect(publishedBindings(first).contextSchemaVersionId).toBe('ctxver-1');

    // The tenant publishes a new ConsultationContextSchema version; the pin must FOLLOW on the
    // next publish. A workflow republished against a moved schema that still cited the old
    // version id would be the D-7 defect wearing a different mask.
    mockContextSchemaService.getEffectiveBundle.mockResolvedValue(bundle('ctxver-2'));
    mockWorkflowDefinitionRepository.findById.mockResolvedValue(definitionEntity({ id: 'def-2', versionNumber: 2 }));

    await service.publish('def-2', {});
    const [, second] = mockWorkflowDefinitionRepository.update.mock.calls[1];
    expect(publishedBindings(second).contextSchemaVersionId).toBe('ctxver-2');
  });

  it('carries every PINNED prompt binding in the graph into promptTemplateRefs', async () => {
    await service.publish('def-1', {});

    const [, entity] = mockWorkflowDefinitionRepository.update.mock.calls[0];
    // Only `n_gen` is pinned. `n_prompt` references the same template but carries no pin, and
    // the compiled shape requires `versionNumber: integer >= 1` — so an unpinned node must be
    // OMITTED rather than smuggled in as version 0, which the interpreter would read as a real
    // pin onto a version that does not exist.
    expect(publishedBindings(entity).promptTemplateRefs).toEqual([
      { nodeId: 'n_gen', templateId: '3f1a7c2e-5b84-4d19-9e63-0a2c8d5f7b41', versionNumber: 4 },
    ]);
  });

  it('carries every PINNED document binding in the graph into documentTemplateRefs', async () => {
    await service.publish('def-1', {});

    const [, entity] = mockWorkflowDefinitionRepository.update.mock.calls[0];
    // SORTED by nodeId, not authored order. `compiledConfig` is checksummed over its canonical
    // JSON (array order preserved), and `fuzz.test.ts` asserts "shuffling node/edge arrays never
    // changes the checksum" — so a derivation that followed `graph.nodes` order would let a
    // purely cosmetic reorder in the authoring UI mint a different compiled checksum for a
    // semantically identical workflow.
    expect(publishedBindings(entity).documentTemplateRefs).toEqual([
      { nodeId: 'n_live', templateId: DOC_LIVE, versionNumber: 7 },
      { nodeId: 'n_synth', templateId: DOC_SYNTH, versionNumber: 2 },
    ]);
  });

  it('omits an UNPINNED document binding rather than defaulting it to version 0', async () => {
    await service.publish('def-1', {});

    const [, entity] = mockWorkflowDefinitionRepository.update.mock.calls[0];
    // Same posture as `promptTemplateRefs`: the compiled shape requires
    // `versionNumber: integer >= 1` on the normative schema AND both pydantic models, so `0`
    // would name a version that cannot exist. `n_suggest` names a template but pins nothing.
    const refs = publishedBindings(entity).documentTemplateRefs as Array<{ nodeId: string }>;
    expect(refs.map((ref) => ref.nodeId)).not.toContain('n_suggest');
  });

  it('derives entitlementKeys from the registry rather than hardcoding an empty list', async () => {
    await service.publish('def-1', {});

    const [, entity] = mockWorkflowDefinitionRepository.update.mock.calls[0];
    // Every descriptor is `entitlementKey: null` today (R-7), so the DERIVED answer for this
    // graph is `[]` — the same VALUE the hardcode produced, reached by a mechanism that will
    // track the registry when that changes.
    expect(publishedBindings(entity).entitlementKeys).toEqual([]);
  });

  it('leaves the two non-derivable bindings at their declared defaults', async () => {
    await service.publish('def-1', {});

    const [, entity] = mockWorkflowDefinitionRepository.update.mock.calls[0];
    expect(publishedBindings(entity).guardrailProfile).toBe('STANDARD');
    expect(publishedBindings(entity).redactionRuleSetId).toBeNull();
  });

  it('publishes with a null pin — never throws — when the tenant has configured no schema', async () => {
    // `getEffectiveBundle` returns nulls rather than throwing for an unconfigured tenant, and a
    // workflow publish must not become the thing that fails because of it. `null` here is an
    // HONEST "this tenant pinned nothing", which is different from the D-7 defect: a hardcoded
    // null that could never have been anything else.
    mockContextSchemaService.getEffectiveBundle.mockResolvedValue(bundle(null));

    await service.publish('def-1', {});

    const [, entity] = mockWorkflowDefinitionRepository.update.mock.calls[0];
    expect(publishedBindings(entity).contextSchemaVersionId).toBeNull();
  });

  it('still publishes when the context-schema service is not wired at all', async () => {
    const bare = new WorkflowDefinitionService(
      mockWorkflowDefinitionRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockDatabaseService as never,
    );

    await expect(bare.publish('def-1', {})).resolves.toBeDefined();
    const [, entity] = mockWorkflowDefinitionRepository.update.mock.calls[0];
    expect(publishedBindings(entity).contextSchemaVersionId).toBeNull();
    // The graph-derived halves need no collaborator, so they must still be populated.
    expect(publishedBindings(entity).promptTemplateRefs).toHaveLength(1);
  });
});
