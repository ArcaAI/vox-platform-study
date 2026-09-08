/**
 * TASK-930 §6.1 — `POST /admin/agents/promote-to-system`.
 *
 * The AGENT half of owner decision #4: the platform admin builds in Global (`50000000-…`) and
 * promotes into SYSTEM (`00000000-…`). Every test here mirrors one of the boundaries the WORKFLOW
 * promotion already holds (`workflow-definition.sync-promotion.task885.test.ts`):
 *
 * | Boundary | Expected |
 * |---|---|
 * | not a platform admin, or a working tenant is pinned | **403** — a privilege boundary (`05-nestjs-api.md` §Imperative Privilege Checks), not the 404-over-403 posture |
 * | Global does not own the slug | **404** — indistinguishable from missing |
 * | the resolved Global version is not PUBLISHED | **409** `AGENT_NOT_PUBLISHED` |
 * | the promoted row | SYSTEM's `max(versionNumber)+1`, recompiled and PUBLISHED + ACTIVE |
 *
 * Written RED-first: every test in this file failed against `7793d09ca`, where
 * `AgentPromoteToSystemService` did not exist.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentPromoteToSystemService } from '../agent-promote-to-system.service';

const GLOBAL = '50000000-0000-0000-0000-000000000000';

const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
  // Every cross-tenant step NAMES its tenant (`runInTenantContext`). This fixture pins one tenant
  // through `get`, so `run` only has to invoke the step; that the step's tenant is the right one
  // is proven against the REAL tenant-scope extension in `membership-bounded-sync.task889.test.ts`.
  run: vi.fn((optionsOrCallback: unknown, maybeCallback?: unknown) =>
    (typeof optionsOrCallback === 'function' ? optionsOrCallback : (maybeCallback as () => unknown))(),
  ),
};
const mockEventEmitter = { emit: vi.fn() };

const mockAgentRepository = {
  findAllVersionsBySlug: vi.fn(),
  findOwnActiveBySlug: vi.fn(),
  findMaxVersionNumber: vi.fn(),
  create: vi.fn(),
};
const mockFallbackRepository = { findByAgentId: vi.fn(), create: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn(), findByName: vi.fn(), findByTenantAndSourceTemplateId: vi.fn(), create: vi.fn() };
const mockPromptVersionRepository = { findByTemplate: vi.fn(), findByVersionNumber: vi.fn(), create: vi.fn() };
const mockContextSchemaRepository = { findById: vi.fn(), findByTenantAndSlug: vi.fn() };
const mockContextSchemaVersionRepository = { findBySchemaAndVersionNumber: vi.fn(), findLatestForSchema: vi.fn() };
const mockAiModelRepository = { findByIdOrNull: vi.fn(), findBySlug: vi.fn() };
const mockPromotionRepository = { create: vi.fn() };
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };

const mockAgentService = { publish: vi.fn() };
const mockContextSchemaService = { create: vi.fn(), publish: vi.fn() };
const mockModuleRef = {
  get: vi.fn((token: unknown) => {
    const description = typeof token === 'symbol' ? token.description : String(token);
    if (description === 'IAgentService') return mockAgentService;
    if (description === 'IConsultationContextSchemaService') return mockContextSchemaService;
    throw new Error(`no provider for ${String(description)}`);
  }),
};

const agent = (overrides: Record<string, unknown> = {}) => ({
  id: 'agent-global-1',
  tenantId: GLOBAL,
  slug: 'general-medicine-summarization',
  name: 'General medicine summarization',
  description: null,
  task: 'TEXT_GENERATION',
  versionNumber: 3,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.PUBLISHED,
  modelId: 'model-sys-1',
  contextSchemaId: null,
  contextSchemaVersionNumber: null,
  instruction: null,
  parameters: null,
  inputSchema: null,
  outputSchema: null,
  tools: null,
  tags: [],
  isActive: true,
  compiledConfig: null,
  compiledConfigChecksum: null,
  validationReport: null,
  validatedAt: null,
  publishedAt: new Date('2026-09-01T00:00:00Z'),
  resourceStatus: 'ENABLED',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  version: 1,
  ...overrides,
});

/**
 * A saved row: the entity the service handed the repository, carrying the id the database
 * assigned. `Object.create(prototype)` keeps the accessors — a plain spread does not, and the
 * resulting `undefined` slug is indistinguishable from a service that forgot to set one.
 */
function withId<T extends object>(entity: T, id: string): T {
  const saved = Object.assign(Object.create(Object.getPrototypeOf(entity) as object), entity) as T;
  Object.defineProperty(saved, 'id', { value: id, configurable: true, enumerable: true });
  return saved;
}

const construct = () =>
  new AgentPromoteToSystemService(
    mockAgentRepository as never,
    mockFallbackRepository as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    mockContextSchemaRepository as never,
    mockContextSchemaVersionRepository as never,
    mockAiModelRepository as never,
    mockPromotionRepository as never,
    mockDatabaseService as never,
    mockModuleRef as never,
    mockEventEmitter as never,
    mockClsService as never,
  );

/** A tenant-less SUPER_ADMIN — the elevated context this verb requires. */
function elevated() {
  mockClsService.get.mockImplementation((key: string) => {
    if (key === 'tenantId') return undefined;
    if (key === 'user') return { id: 'root-1', roles: ['SUPER_ADMIN'] };
    return undefined;
  });
}

describe('AgentPromoteToSystemService — Global -> SYSTEM agent promotion (TASK-930 §6.1)', () => {
  let service: AgentPromoteToSystemService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDatabaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(agent());
    mockAgentRepository.findAllVersionsBySlug.mockResolvedValue([agent()]);
    mockAgentRepository.findMaxVersionNumber.mockResolvedValue(4);
    // The repository returns the ENTITY it wrote, with the database's id. Spreading it would drop
  // every prototype getter (`slug`, `versionNumber`, …) and the service would then write a WORM
  // record with no `targetAgentId` — so the saved row keeps its prototype and only shadows `id`.
  mockAgentRepository.create.mockImplementation((created: object) => Promise.resolve(withId(created, 'agent-sys-5')));
    mockFallbackRepository.findByAgentId.mockResolvedValue([]);
    mockFallbackRepository.create.mockImplementation((row: unknown) => Promise.resolve(row));
    mockAiModelRepository.findByIdOrNull.mockResolvedValue({ id: 'model-sys-1', slug: 'gemma', tenantId: SYSTEM_TENANT_ID });
    mockPromotionRepository.create.mockImplementation((row: object) => Promise.resolve(withId(row, 'promo-agent-1')));
    mockAgentService.publish.mockResolvedValue({ id: 'agent-sys-5', slug: 'general-medicine-summarization', versionNumber: 5 });
    elevated();
    service = construct();
  });

  it('copies the Global agent into SYSTEM at max(versionNumber)+1 and PUBLISHES + ACTIVATES it there', async () => {
    const result = await service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'day-1 default' });

    const written = mockAgentRepository.create.mock.calls[0][0];
    expect(written.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(written.slug).toBe('general-medicine-summarization');
    // SYSTEM's own lineage continues; the source's number never travels.
    expect(written.versionNumber).toBe(5);
    expect(written.status).toBe(WorkflowDefinitionStatus.DRAFT);
    expect(written.isActive).toBe(false);
    // Provenance, so a SYSTEM row always says which Global row it came from.
    expect(written.sourceTenantId).toBe(GLOBAL);
    expect(written.sourceAgentId).toBe('agent-global-1');
    expect(written.sourceVersionNumber).toBe(3);

    // The recompile + publish + activate is the AGENT service's own path, not a second one.
    expect(mockAgentService.publish).toHaveBeenCalledWith('agent-sys-5', { activate: true });

    expect(result.agentId).toBe('agent-sys-5');
    expect(result.slug).toBe('general-medicine-summarization');
    expect(result.versionNumber).toBe(5);
    expect(result.copied).toEqual({ promptTemplates: 0, contextSchemas: 0 });
  });

  it('writes the WORM AgentPromotion record naming both tenants and the exact source row', async () => {
    const result = await service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'day-1 default' });

    const record = mockPromotionRepository.create.mock.calls[0][0];
    expect(record.fromTenantId).toBe(GLOBAL);
    expect(record.toTenantId).toBe(SYSTEM_TENANT_ID);
    // The four WORM columns keep their older names; see `AgentPromotionService`'s header.
    expect(record.agentVersionId).toBe('agent-global-1');
    expect(record.sourceAgentId).toBe('general-medicine-summarization');
    expect(record.targetAgentId).toBe('general-medicine-summarization');
    expect(record.targetAgentVersionId).toBe('agent-sys-5');
    expect(record.checksum).toEqual(expect.any(String));
    expect(result.promotionId).toBe('promo-agent-1');
  });

  it('is a 403 for a non-super-admin — only the platform admin manages SYSTEM', async () => {
    mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? undefined : { id: 'admin-1', roles: ['TENANT_ADMIN'] }));
    service = construct();

    await expect(service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'r' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(mockAgentRepository.create).not.toHaveBeenCalled();
  });

  it('is a 403 when a working tenant is pinned — the cross-tenant read needs a tenant-less context', async () => {
    mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-a' : { id: 'root-1', roles: ['SUPER_ADMIN'] }));
    service = construct();

    await expect(service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'r' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(mockAgentRepository.create).not.toHaveBeenCalled();
  });

  it('is a 404 when Global does not own the slug', async () => {
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(null);
    mockAgentRepository.findAllVersionsBySlug.mockResolvedValue([]);

    await expect(service.promoteToSystem({ sourceSlug: 'nope', changeReason: 'r' })).rejects.toBeInstanceOf(NotFoundException);
    expect(mockAgentRepository.create).not.toHaveBeenCalled();
  });

  it('is a 409 AGENT_NOT_PUBLISHED when the named Global version is a DRAFT', async () => {
    mockAgentRepository.findAllVersionsBySlug.mockResolvedValue([agent({ versionNumber: 4, status: WorkflowDefinitionStatus.DRAFT })]);

    const error = await service
      .promoteToSystem({ sourceSlug: 'general-medicine-summarization', versionNumber: 4, changeReason: 'r' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect(((error as ConflictException).getResponse() as { code: string }).code).toBe('AGENT_NOT_PUBLISHED');
    expect(mockAgentRepository.create).not.toHaveBeenCalled();
  });

  it('is a 404 when the named Global version does not exist in that lineage', async () => {
    mockAgentRepository.findAllVersionsBySlug.mockResolvedValue([agent({ versionNumber: 3 })]);

    await expect(
      service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', versionNumber: 9, changeReason: 'r' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deep-copies a GLOBAL-owned prompt template into SYSTEM and re-binds the promoted instruction', async () => {
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(
      agent({ instruction: { promptTemplateId: 'tpl-global-1', promptVersionNumber: 7, variables: { a: 'trigger.context.a' } } }),
    );
    mockPromptTemplateRepository.findById.mockResolvedValue({
      id: 'tpl-global-1',
      tenantId: GLOBAL,
      name: 'General medicine consultation summary',
      description: null,
      content: 'draft content',
      category: 'consultation',
      status: 'APPROVED',
      approvedVersionNumber: 2,
      variables: { a: 'string' },
      tags: ['clinical'],
    });
    mockPromptTemplateRepository.findByTenantAndSourceTemplateId.mockResolvedValue(null);
    mockPromptTemplateRepository.findByName.mockResolvedValue(null);
    mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ id: 'v2', versionNumber: 2, content: 'approved content', variables: { a: 'string' } });
    mockPromptTemplateRepository.create.mockImplementation((row: object) => Promise.resolve(withId(row, 'tpl-sys-1')));
    mockPromptVersionRepository.create.mockImplementation((row: unknown) => Promise.resolve(row));

    const result = await service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'r' });

    const copiedTemplate = mockPromptTemplateRepository.create.mock.calls[0][0];
    expect(copiedTemplate.tenantId).toBe(SYSTEM_TENANT_ID);
    // APPROVED where the source was, and the provenance edge stamped.
    expect(copiedTemplate.status).toBe('APPROVED');
    expect(copiedTemplate.sourceTemplateId).toBe('tpl-global-1');
    // The APPROVED snapshot travels, not the mutable draft column.
    expect(copiedTemplate.content).toBe('approved content');

    const written = mockAgentRepository.create.mock.calls[0][0];
    expect((written.instruction as Record<string, unknown>).promptTemplateId).toBe('tpl-sys-1');
    // The clone's lineage restarts at 1, so the source's pin numbers a version that is not here.
    expect((written.instruction as Record<string, unknown>).promptVersionNumber).toBe(1);
    expect((written.instruction as Record<string, unknown>).variables).toEqual({ a: 'trigger.context.a' });
    expect(result.copied.promptTemplates).toBe(1);
  });

  it('keeps a SYSTEM-owned prompt binding as it is — copying it would fork the platform library', async () => {
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(agent({ instruction: { promptTemplateId: 'tpl-sys-9' } }));
    mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-sys-9', tenantId: SYSTEM_TENANT_ID, name: 'platform', status: 'APPROVED' });

    const result = await service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'r' });

    expect(mockPromptTemplateRepository.create).not.toHaveBeenCalled();
    const written = mockAgentRepository.create.mock.calls[0][0];
    expect((written.instruction as Record<string, unknown>).promptTemplateId).toBe('tpl-sys-9');
    expect(result.copied.promptTemplates).toBe(0);
  });

  it('re-binds contextSchemaId to the SYSTEM schema of the SAME slug when one already exists', async () => {
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(agent({ contextSchemaId: 'schema-global-1', contextSchemaVersionNumber: 4 }));
    mockContextSchemaRepository.findById.mockResolvedValue({ id: 'schema-global-1', tenantId: GLOBAL, slug: 'consultation_note_context' });
    mockContextSchemaRepository.findByTenantAndSlug.mockResolvedValue({ id: 'schema-sys-1', tenantId: SYSTEM_TENANT_ID, slug: 'consultation_note_context' });

    const result = await service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'r' });

    const written = mockAgentRepository.create.mock.calls[0][0];
    expect(written.contextSchemaId).toBe('schema-sys-1');
    // The source's pin numbers a version inside GLOBAL's lineage; SYSTEM's own pin governs.
    expect(written.contextSchemaVersionNumber).toBeNull();
    expect(mockContextSchemaService.create).not.toHaveBeenCalled();
    expect(result.copied.contextSchemas).toBe(0);
  });

  it('copies the context schema into SYSTEM when SYSTEM carries no schema of that slug', async () => {
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(agent({ contextSchemaId: 'schema-global-1', contextSchemaVersionNumber: 4 }));
    mockContextSchemaRepository.findById.mockResolvedValue({
      id: 'schema-global-1',
      tenantId: GLOBAL,
      slug: 'consultation_note_context',
      name: 'Consultation note context',
      description: null,
      pinnedVersionNumber: 4,
    });
    mockContextSchemaRepository.findByTenantAndSlug.mockResolvedValue(null);
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({ id: 'sv-4', versionNumber: 4, definition: { kinds: [] } });
    mockContextSchemaService.create.mockResolvedValue({ id: 'schema-sys-new' });
    mockContextSchemaService.publish.mockResolvedValue({ id: 'schema-sys-new' });

    const result = await service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'r' });

    expect(mockContextSchemaService.create).toHaveBeenCalledWith(expect.objectContaining({ slug: 'consultation_note_context' }));
    expect(mockContextSchemaService.publish).toHaveBeenCalledWith('schema-sys-new', expect.objectContaining({ definition: { kinds: [] } }));
    const written = mockAgentRepository.create.mock.calls[0][0];
    expect(written.contextSchemaId).toBe('schema-sys-new');
    expect(result.copied.contextSchemas).toBe(1);
  });

  it('copies the AgentModelFallback chain in priority order, re-resolving each model in SYSTEM', async () => {
    mockFallbackRepository.findByAgentId.mockResolvedValue([
      { id: 'fb-1', agentId: 'agent-global-1', priority: 0, modelId: 'model-global-a' },
      { id: 'fb-2', agentId: 'agent-global-1', priority: 1, modelId: 'model-sys-b' },
    ]);
    mockAiModelRepository.findByIdOrNull.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'model-global-a'
          ? { id: 'model-global-a', slug: 'gemma-a', tenantId: GLOBAL }
          : { id, slug: id === 'model-sys-b' ? 'gemma-b' : 'gemma', tenantId: SYSTEM_TENANT_ID },
      ),
    );
    mockAiModelRepository.findBySlug.mockResolvedValue({ id: 'model-sys-a', slug: 'gemma-a', tenantId: SYSTEM_TENANT_ID });

    await service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'r' });

    const links = mockFallbackRepository.create.mock.calls.map((call) => call[0]);
    expect(links.map((link) => link.priority)).toEqual([0, 1]);
    // A GLOBAL-owned model row is re-resolved BY SLUG in SYSTEM; a SYSTEM row keeps its id.
    expect(links[0].modelId).toBe('model-sys-a');
    expect(links[1].modelId).toBe('model-sys-b');
    expect(links.every((link) => link.tenantId === SYSTEM_TENANT_ID)).toBe(true);
  });

  it('refuses with a 409 MODEL_NOT_RESOLVABLE rather than writing a dangling model reference', async () => {
    mockAiModelRepository.findByIdOrNull.mockResolvedValue({ id: 'model-global-1', slug: 'byo-gpt', tenantId: GLOBAL });
    mockAiModelRepository.findBySlug.mockResolvedValue(null);

    const error = await service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'r' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(((error as ConflictException).getResponse() as { code: string }).code).toBe('MODEL_NOT_RESOLVABLE');
  });

  it('broadcasts ResourceCreated only after the copy commits', async () => {
    await service.promoteToSystem({ sourceSlug: 'general-medicine-summarization', changeReason: 'day-1 default' });

    const emitted = mockEventEmitter.emit.mock.calls.map((call) => call[1] as Record<string, unknown>);
    const created = emitted.find((event) => (event.data as Record<string, unknown>)?.action === 'promote-agent-to-system');
    expect(created).toBeDefined();
    expect((created!.data as Record<string, unknown>).fromTenantId).toBe(GLOBAL);
    expect((created!.data as Record<string, unknown>).toTenantId).toBe(SYSTEM_TENANT_ID);
    expect((created!.data as Record<string, unknown>).changeReason).toBe('day-1 default');
  });
});
