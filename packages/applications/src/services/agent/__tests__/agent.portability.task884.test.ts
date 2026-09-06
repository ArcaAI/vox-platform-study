/**
 * TASK-884 — AgentService portability: clone (owner #2), export/import (owner #4), sync among
 * the caller's own tenants (owner #4), and the `key:value` tag grammar (owner #6).
 *
 * These are the DEPTH cases the route-authz matrix cannot express, proven at the service where
 * the decision is actually made: 404-over-403 on a foreign source, a privilege 403 on a
 * cross-tenant clone, 404 for a sync target the caller does not manage, and the named 409s that
 * stop a copy landing a dangling reference.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, SysEventType, WorkflowDefinitionStatus } from '@arcaai/domains';
import { PORTABLE_BUNDLE_SCHEMA_VERSION } from '@arcaai/workflow-contract';
import { AgentService } from '../agent.service';

const TENANT = '50000000-0000-0000-0000-000000000000';
const PARTNER = '50000000-0000-0000-0000-000000000077';
const STRANGER = '50000000-0000-0000-0000-000000000099';

const cls = {
  get: vi.fn(),
  set: vi.fn(),
  // TASK-889 — a sync runs each cross-tenant step under its OWN CLS store
  // (`runInTenantContext`). This fixture pins one tenant through `get`, so `run` only has to
  // invoke the step; that the step's tenant is the right one is proven against the REAL
  // tenant-scope extension in `agentPromotion/__tests__/membership-bounded-sync.task889.test.ts`.
  run: vi.fn((optionsOrCallback: unknown, maybeCallback?: unknown) =>
    (typeof optionsOrCallback === 'function' ? optionsOrCallback : (maybeCallback as () => unknown))(),
  ),
};
const events = { emit: vi.fn() };
const agentRepository = {
  findByIdVisible: vi.fn(),
  findAllForTenant: vi.fn(),
  findPublishedActiveVisible: vi.fn(),
  findPublishedActiveBySlug: vi.fn(async () => null),
  findPublishedVisibleBySlugVersion: vi.fn(async () => null),
  // TASK-890 L13 — the reference-library read that replaced the shared-read widening.
  findSystemReferences: vi.fn(async () => []),
  findSystemReferenceBySlug: vi.fn(async () => null),
  findOwnActiveBySlug: vi.fn(),
  findAllVersionsBySlug: vi.fn(async () => []),
  findMaxVersionNumber: vi.fn(async () => 0),
  create: vi.fn(async (entity: unknown) => entity),
  update: vi.fn(async (_id: string, entity: unknown) => entity),
};
const fallbackRepository = { findByAgentId: vi.fn(async () => []), create: vi.fn(async (entity: unknown) => entity), deleteAllForAgent: vi.fn() };
const aiModelRepository = {
  findById: vi.fn(),
  findByIdOrNull: vi.fn(),
  findBySlug: vi.fn(async () => null),
  findByTaskTypeSharedRead: vi.fn(async () => []),
};
const databaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const assignments = { resolve: vi.fn(async () => ({ agentSlug: null, source: 'unassigned', selector: [] })) };
const providerConnections = { resolveConnection: vi.fn(), resolveTenantCloudOverrides: vi.fn() };
const promptTemplateRepository = {
  findById: vi.fn(async () => null),
  findByName: vi.fn(async () => null),
  findSystemReferenceById: vi.fn(async () => null),
  findByTenantAndSourceTemplateId: vi.fn(async () => null),
};
const promptVersionRepository = { findByVersionNumber: vi.fn() };
const policyEngine = { buildAbility: vi.fn() };
const mcpServerRepository = { findEnabledById: vi.fn(async () => null) };

const LLM_MODEL = {
  id: 'model-llm',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'lms-gemma-4-e2b-it-qat',
  taskType: 'TEXT_GENERATION',
  provider: 'lm-studio',
  localPath: null,
  resourceStatus: ResourceStatusType.ENABLED,
  metaData: null,
};

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    tenantId: TENANT,
    slug: 'clinic-summarizer',
    name: 'Clinic summarizer',
    description: 'Notes',
    task: AgentTask.TEXT_GENERATION,
    versionNumber: 3,
    parentVersionId: null,
    status: WorkflowDefinitionStatus.PUBLISHED,
    isActive: true,
    modelId: 'model-llm',
    instruction: { systemPrompt: 'You are a clinical scribe.' },
    parameters: { generation: { temperature: 0.2 } },
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: { anything: true },
    compiledConfigChecksum: 'sha256:abc',
    validationReport: null,
    validatedAt: null,
    publishedAt: new Date(),
    deprecatedAt: null,
    resourceStatus: ResourceStatusType.ENABLED,
    tags: ['tier:tenant'],
    version: 4,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    updatedBy: null,
    ...overrides,
  } as never;
}

function makeService() {
  return new AgentService(
    agentRepository as never,
    fallbackRepository as never,
    aiModelRepository as never,
    events as never,
    cls as never,
    databaseService as never,
    assignments as never,
    providerConnections as never,
    promptTemplateRepository as never,
    promptVersionRepository as never,
    policyEngine as never,
    mcpServerRepository as never,
  );
}

function asCaller(roles: string[] = []) {
  cls.get.mockImplementation((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1', roles } : undefined));
}

beforeEach(() => {
  vi.clearAllMocks();
  asCaller();
  agentRepository.findAllVersionsBySlug.mockResolvedValue([]);
  agentRepository.findPublishedActiveBySlug.mockResolvedValue(null);
  agentRepository.findPublishedVisibleBySlugVersion.mockResolvedValue(null);
  agentRepository.findSystemReferenceBySlug.mockResolvedValue(null);
  agentRepository.findSystemReferences.mockResolvedValue([]);
  agentRepository.findMaxVersionNumber.mockResolvedValue(0);
  agentRepository.create.mockImplementation(async (entity: unknown) => entity);
  fallbackRepository.findByAgentId.mockResolvedValue([]);
  fallbackRepository.create.mockImplementation(async (entity: unknown) => entity);
  aiModelRepository.findById.mockImplementation(async (id: string) => (id === 'model-llm' ? LLM_MODEL : null));
  aiModelRepository.findByIdOrNull.mockImplementation(async (id: string) => (id === 'model-llm' ? LLM_MODEL : null));
  aiModelRepository.findBySlug.mockResolvedValue(null);
  aiModelRepository.findByTaskTypeSharedRead.mockResolvedValue([LLM_MODEL]);
  promptTemplateRepository.findById.mockResolvedValue(null);
  promptTemplateRepository.findByName.mockResolvedValue(null);
  mcpServerRepository.findEnabledById.mockResolvedValue(null);
});

// ===========================================================================================
// Clone — owner decision #2
// ===========================================================================================

describe('clone', () => {
  // TASK-890 L13 — the platform-library branch is now an EXPLICIT reference read on the
  // unscoped client (`findSystemReferenceBySlug`) rather than the shared-read widening
  // `findPublishedActiveBySlug` used to provide. Same set, said out loud.
  it('clones a SYSTEM template into the caller tenant as a DRAFT, recording the full provenance', async () => {
    agentRepository.findSystemReferenceBySlug.mockResolvedValue(
      agent({ id: 'sys-1', tenantId: SYSTEM_TENANT_ID, slug: 'platform-summarization', versionNumber: 2 }),
    );

    const cloned = await makeService().clone('platform-summarization', { newSlug: 'clinic-notes' });

    expect(cloned.tenantId).toBe(TENANT);
    expect(cloned.slug).toBe('clinic-notes');
    expect(cloned.status).toBe(WorkflowDefinitionStatus.DRAFT);
    expect(cloned.isActive).toBe(false);
    // Server-owned output never rides along: a clone is re-validated and re-published here.
    expect(cloned.compiledConfig).toBeNull();
    expect(cloned.compiledConfigChecksum).toBeNull();
    // `parentVersionId` means "the previous version of THIS lineage"; a clone starts a new one.
    expect(cloned.parentVersionId).toBeNull();
    expect({
      sourceAgentId: cloned.sourceAgentId,
      sourceTenantId: cloned.sourceTenantId,
      sourceSlug: cloned.sourceSlug,
      sourceVersionNumber: cloned.sourceVersionNumber,
    }).toEqual({ sourceAgentId: 'sys-1', sourceTenantId: SYSTEM_TENANT_ID, sourceSlug: 'platform-summarization', sourceVersionNumber: 2 });
    expect(events.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
  });

  it('clones the caller’s own agent, keeps its tags by default and mints max+1 on the NEW slug', async () => {
    agentRepository.findAllVersionsBySlug.mockResolvedValue([agent()]);
    agentRepository.findMaxVersionNumber.mockResolvedValue(4);

    const cloned = await makeService().clone('clinic-summarizer', { newSlug: 'clinic-summarizer-rheum' });

    expect(agentRepository.findMaxVersionNumber).toHaveBeenCalledWith(TENANT, 'clinic-summarizer-rheum', expect.anything());
    expect(cloned.versionNumber).toBe(5);
    expect(cloned.tags).toEqual(['tier:tenant']);
  });

  it('replaces the tags when asked, and REFUSES a bare key', async () => {
    agentRepository.findAllVersionsBySlug.mockResolvedValue([agent()]);
    const cloned = await makeService().clone('clinic-summarizer', { newSlug: 'rheum', tags: ['specialty:rheumatology'] });
    expect(cloned.tags).toEqual(['specialty:rheumatology']);

    await expect(makeService().clone('clinic-summarizer', { newSlug: 'rheum2', tags: ['rheumatology'] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to reuse the source slug in the same tenant — that would be a new VERSION, not a clone', async () => {
    agentRepository.findAllVersionsBySlug.mockResolvedValue([agent()]);
    await expect(makeService().clone('clinic-summarizer', { newSlug: 'clinic-summarizer' })).rejects.toBeInstanceOf(BadRequestException);
  });

  // 404-over-403: another tenant's slug is indistinguishable from a slug that does not exist.
  it('404s on a source the tenant cannot see', async () => {
    await expect(makeService().clone('someone-elses-agent', { newSlug: 'mine' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s on an explicit version the lineage does not have', async () => {
    agentRepository.findAllVersionsBySlug.mockResolvedValue([agent()]);
    await expect(makeService().clone('clinic-summarizer', { newSlug: 'copy', sourceVersionNumber: 99 })).rejects.toBeInstanceOf(NotFoundException);
  });

  // A PRIVILEGE 403, not the cross-tenant posture: the caller named a tenant and is told the
  // naming itself is above their level, which reveals nothing about that tenant.
  it('403s when a tenant admin tries to clone into another tenant', async () => {
    agentRepository.findAllVersionsBySlug.mockResolvedValue([agent()]);
    await expect(makeService().clone('clinic-summarizer', { newSlug: 'copy', tenantId: PARTNER })).rejects.toBeInstanceOf(ForbiddenException);
    expect(agentRepository.create).not.toHaveBeenCalled();
  });

  it('lets a SUPER_ADMIN clone into another tenant, re-resolving the model by SLUG there', async () => {
    asCaller(['SUPER_ADMIN']);
    agentRepository.findAllVersionsBySlug.mockResolvedValue([agent({ modelId: 'model-tenant-llm' })]);
    aiModelRepository.findByIdOrNull.mockImplementation(async (id: string) =>
      id === 'model-tenant-llm' ? { ...LLM_MODEL, id, tenantId: TENANT, slug: 'clinic-llm' } : null,
    );
    aiModelRepository.findBySlug.mockImplementation(async (tenantId: string, slug: string) =>
      tenantId === PARTNER && slug === 'clinic-llm' ? { ...LLM_MODEL, id: 'partner-llm', tenantId: PARTNER, slug } : null,
    );

    const cloned = await makeService().clone('clinic-summarizer', { newSlug: 'copy', tenantId: PARTNER });

    expect(cloned.tenantId).toBe(PARTNER);
    expect(cloned.modelId).toBe('partner-llm');
  });

  it('refuses with MODEL_NOT_RESOLVABLE rather than writing a dangling model reference', async () => {
    asCaller(['SUPER_ADMIN']);
    agentRepository.findAllVersionsBySlug.mockResolvedValue([agent({ modelId: 'model-tenant-llm' })]);
    aiModelRepository.findByIdOrNull.mockImplementation(async (id: string) =>
      id === 'model-tenant-llm' ? { ...LLM_MODEL, id, tenantId: TENANT, slug: 'clinic-llm' } : null,
    );
    aiModelRepository.findBySlug.mockResolvedValue(null);

    await expect(makeService().clone('clinic-summarizer', { newSlug: 'copy', tenantId: PARTNER })).rejects.toMatchObject({
      response: { code: 'MODEL_NOT_RESOLVABLE' },
    });
  });

  it('keeps the eval gate on a SAME-TENANT clone (the golden set is still that tenant’s)', async () => {
    agentRepository.findAllVersionsBySlug.mockResolvedValue([agent({ instruction: { systemPrompt: 'x', evalGate: { goldenSetId: 'gs-1' } } })]);
    const cloned = await makeService().clone('clinic-summarizer', { newSlug: 'copy' });
    expect(cloned.instruction).toMatchObject({ evalGate: { goldenSetId: 'gs-1' } });
  });
});

// ===========================================================================================
// Export — owner decision #4
// ===========================================================================================

describe('exportBySlug', () => {
  it('emits a values-only bundle: the model by SLUG, no ids, no tenant id, no credential', async () => {
    agentRepository.findAllVersionsBySlug.mockResolvedValue([agent()]);

    const bundle = await makeService().exportBySlug('clinic-summarizer');

    expect(bundle.kind).toBe('agent');
    expect(bundle.schemaVersion).toBe(PORTABLE_BUNDLE_SCHEMA_VERSION);
    expect(bundle.source).toEqual({ tenantKind: 'tenant', slug: 'clinic-summarizer', version: 3 });
    expect(bundle.payload).toMatchObject({ slug: 'clinic-summarizer', modelSlug: 'lms-gemma-4-e2b-it-qat', task: AgentTask.TEXT_GENERATION });
    expect(bundle.payload).not.toHaveProperty('modelId');
    expect(bundle.payload).not.toHaveProperty('tenantId');
    expect(bundle.payload).not.toHaveProperty('compiledConfig');
    expect(JSON.stringify(bundle)).not.toContain('model-llm');
  });

  it('labels a SYSTEM source as the platform TIER, never as a tenant', async () => {
    agentRepository.findSystemReferenceBySlug.mockResolvedValue(
      agent({ tenantId: SYSTEM_TENANT_ID, slug: 'platform-summarization', versionNumber: 1 }),
    );
    const bundle = await makeService().exportBySlug('platform-summarization');
    expect(bundle.source.tenantKind).toBe('system');
  });

  it('STRIPS the eval gate and says so, and carries a SYSTEM template by id but a tenant one by NAME', async () => {
    agentRepository.findAllVersionsBySlug.mockResolvedValue([
      agent({ instruction: { promptTemplateId: 'tpl-1', promptVersionNumber: 2, evalGate: { goldenSetId: 'gs-1' } } }),
    ]);
    promptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-1', tenantId: TENANT, name: 'Clinic SOAP' } as never);

    const bundle = await makeService().exportBySlug('clinic-summarizer');
    const payload = bundle.payload as { instruction: Record<string, unknown>; notes: string[] };

    expect(payload.instruction).not.toHaveProperty('evalGate');
    expect(payload.instruction).not.toHaveProperty('promptTemplateId');
    expect(payload.instruction.promptTemplateRef).toEqual({ kind: 'tenant', name: 'Clinic SOAP' });
    expect(payload.notes.join(' ')).toContain('eval gate was not exported');

    promptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-sys', tenantId: SYSTEM_TENANT_ID, name: 'Platform SOAP' } as never);
    agentRepository.findAllVersionsBySlug.mockResolvedValue([agent({ instruction: { promptTemplateId: 'tpl-sys', promptVersionNumber: 2 } })]);
    const systemBundle = await makeService().exportBySlug('clinic-summarizer');
    expect((systemBundle.payload as { instruction: Record<string, unknown> }).instruction.promptTemplateRef).toEqual({
      kind: 'system',
      id: 'tpl-sys',
      name: 'Platform SOAP',
    });
  });

  it('404s on a slug the tenant cannot see', async () => {
    await expect(makeService().exportBySlug('someone-elses-agent')).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ===========================================================================================
// Import — owner decision #4
// ===========================================================================================

function bundle(payload: Record<string, unknown>, envelope: Record<string, unknown> = {}) {
  return {
    kind: 'agent',
    schemaVersion: PORTABLE_BUNDLE_SCHEMA_VERSION,
    exportedAt: '2026-09-06T00:00:00.000Z',
    source: { tenantKind: 'tenant', slug: 'clinic-summarizer', version: 3 },
    payload: {
      slug: 'clinic-summarizer',
      name: 'Clinic summarizer',
      description: null,
      task: AgentTask.TEXT_GENERATION,
      modelSlug: 'lms-gemma-4-e2b-it-qat',
      fallbackModelSlugs: [],
      instruction: { systemPrompt: 'You are a clinical scribe.' },
      parameters: null,
      inputSchema: null,
      outputSchema: null,
      tools: null,
      tags: [],
      notes: [],
      ...payload,
    },
    ...envelope,
  } as Record<string, unknown>;
}

describe('importBundle', () => {
  beforeEach(() => {
    aiModelRepository.findBySlug.mockImplementation(async (tenantId: string, slug: string) =>
      tenantId === SYSTEM_TENANT_ID && slug === 'lms-gemma-4-e2b-it-qat' ? LLM_MODEL : null,
    );
  });

  it('creates a DRAFT in the caller tenant and records the LINEAGE half of the provenance', async () => {
    const imported = await makeService().importBundle({ bundle: bundle({}) });

    expect(imported.tenantId).toBe(TENANT);
    expect(imported.status).toBe(WorkflowDefinitionStatus.DRAFT);
    expect(imported.modelId).toBe('model-llm');
    // A bundle carries no row id and no tenant id, so an import records only what it truly saw.
    expect({ sourceSlug: imported.sourceSlug, sourceVersionNumber: imported.sourceVersionNumber }).toEqual({
      sourceSlug: 'clinic-summarizer',
      sourceVersionNumber: 3,
    });
    expect(imported.sourceAgentId).toBeNull();
    expect(imported.sourceTenantId).toBeNull();
  });

  it('honours an explicit slug/name override', async () => {
    const imported = await makeService().importBundle({ bundle: bundle({}), slug: 'imported-notes', name: 'Imported notes' });
    expect(imported.slug).toBe('imported-notes');
    expect(imported.name).toBe('Imported notes');
  });

  it('refuses a bundle of the wrong kind, and one from a newer platform, before reading the payload', async () => {
    await expect(makeService().importBundle({ bundle: bundle({}, { kind: 'workflow' }) })).rejects.toMatchObject({
      response: { code: 'BUNDLE_INVALID' },
    });
    await expect(makeService().importBundle({ bundle: bundle({}, { schemaVersion: PORTABLE_BUNDLE_SCHEMA_VERSION + 1 }) })).rejects.toMatchObject({
      response: { code: 'BUNDLE_INVALID' },
    });
    expect(agentRepository.create).not.toHaveBeenCalled();
  });

  it('refuses a hand-edited payload that carries a server-owned column', async () => {
    await expect(makeService().importBundle({ bundle: bundle({ status: 'PUBLISHED', isActive: true }) })).rejects.toMatchObject({
      response: { code: 'BUNDLE_PAYLOAD_INVALID' },
    });
  });

  it('names the model slugs this tenant cannot see instead of importing a dangling reference', async () => {
    aiModelRepository.findBySlug.mockResolvedValue(null);
    await expect(makeService().importBundle({ bundle: bundle({}) })).rejects.toBeInstanceOf(ConflictException);
    await expect(makeService().importBundle({ bundle: bundle({}) })).rejects.toMatchObject({ response: { code: 'MODEL_NOT_RESOLVABLE' } });
  });

  it('re-resolves a tenant template BY NAME and drops the source’s version pin (lineages are per-tenant)', async () => {
    promptTemplateRepository.findByName.mockResolvedValue({ id: 'tpl-mine', tenantId: TENANT, name: 'Clinic SOAP' } as never);
    const imported = await makeService().importBundle({
      bundle: bundle({ instruction: { promptTemplateRef: { kind: 'tenant', name: 'Clinic SOAP' }, promptVersionNumber: 7 } }),
    });
    expect(imported.instruction).toEqual({ promptTemplateId: 'tpl-mine' });
  });

  it('keeps a SYSTEM template id AND its version pin — the same row still has that version', async () => {
    promptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-sys', tenantId: SYSTEM_TENANT_ID, name: 'Platform SOAP' } as never);
    const imported = await makeService().importBundle({
      bundle: bundle({ instruction: { promptTemplateRef: { kind: 'system', id: 'tpl-sys', name: 'Platform SOAP' }, promptVersionNumber: 2 } }),
    });
    expect(imported.instruction).toEqual({ promptTemplateId: 'tpl-sys', promptVersionNumber: 2 });
  });

  it('409s when the bound template does not exist here, naming it', async () => {
    await expect(
      makeService().importBundle({ bundle: bundle({ instruction: { promptTemplateRef: { kind: 'tenant', name: 'Clinic SOAP' } } }) }),
    ).rejects.toMatchObject({ response: { code: 'PROMPT_TEMPLATE_NOT_RESOLVABLE' } });
  });

  it('409s when a tool binding names an MCP server this tenant cannot reach', async () => {
    await expect(makeService().importBundle({ bundle: bundle({ tools: [{ mcpServerId: 'mcp-1', toolName: 'search' }] }) })).rejects.toMatchObject({
      response: { code: 'MCP_SERVER_NOT_RESOLVABLE' },
    });
  });

  it('refuses a bundle whose tags are not `key:value`', async () => {
    await expect(makeService().importBundle({ bundle: bundle({ tags: ['rheumatology'] }) })).rejects.toMatchObject({
      response: { code: 'BUNDLE_PAYLOAD_INVALID' },
    });
  });
});

// ===========================================================================================
// Sync — owner decision #4
// ===========================================================================================

describe('syncToTenants', () => {
  function manages(...tenantIds: string[]) {
    policyEngine.buildAbility.mockImplementation(async ({ tenantId }: { tenantId: string }) => ({
      can: (action: string, subject: string) => action === 'manage' && subject === 'Agent' && tenantIds.includes(tenantId),
    }));
  }

  beforeEach(() => {
    agentRepository.findAllVersionsBySlug.mockResolvedValue([agent()]);
    manages(PARTNER);
  });

  it('lands one DRAFT per target, each carrying the full provenance', async () => {
    manages(PARTNER, STRANGER);
    const result = await makeService().syncToTenants('clinic-summarizer', { targetTenantIds: [PARTNER, STRANGER] });

    expect(result).toMatchObject({ sourceSlug: 'clinic-summarizer', sourceVersionNumber: 3 });
    expect(result.targets.map((t) => t.tenantId)).toEqual([PARTNER, STRANGER]);
    const written = agentRepository.create.mock.calls.map((call) => call[0] as unknown as Record<string, unknown>);
    expect(written).toHaveLength(2);
    for (const row of written) {
      expect(row.status).toBe(WorkflowDefinitionStatus.DRAFT);
      expect(row.isActive).toBe(false);
      expect(row.sourceAgentId).toBe('agent-1');
      expect(row.sourceTenantId).toBe(TENANT);
    }
    expect(events.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
  });

  // The tenant id space is not the caller's to probe, so "you may not" and "no such tenant" are
  // one answer. (Contrast the Global → SYSTEM promotion, which is a 403: that caller is already
  // entitled to know SYSTEM exists.)
  it('404s — never 403 — for a target the caller does not manage, and writes NOTHING', async () => {
    manages(PARTNER);
    await expect(makeService().syncToTenants('clinic-summarizer', { targetTenantIds: [PARTNER, STRANGER] })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(agentRepository.create).not.toHaveBeenCalled();
  });

  // SYSTEM's existence is not a secret — every tenant reads its templates — so hiding the refusal
  // behind a 404 would conceal nothing and mislead the caller about WHY the push failed.
  it('403s — not 404s — when the target is SYSTEM and the caller is not a platform administrator', async () => {
    manages(PARTNER);
    await expect(makeService().syncToTenants('clinic-summarizer', { targetTenantIds: [SYSTEM_TENANT_ID] })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(makeService().syncToTenants('clinic-summarizer', { targetTenantIds: [SYSTEM_TENANT_ID] })).rejects.toThrow(/platform administrator/);
  });

  it('lets a caller who DOES manage SYSTEM push into it — the promotion path a platform admin uses', async () => {
    manages(SYSTEM_TENANT_ID);
    const result = await makeService().syncToTenants('clinic-summarizer', { targetTenantIds: [SYSTEM_TENANT_ID] });
    expect(result.targets.map((t) => t.tenantId)).toEqual([SYSTEM_TENANT_ID]);
  });

  it('fails CLOSED when the authorization engine is unwired rather than writing cross-tenant', async () => {
    const service = new AgentService(
      agentRepository as never,
      fallbackRepository as never,
      aiModelRepository as never,
      events as never,
      cls as never,
      databaseService as never,
      assignments as never,
      providerConnections as never,
      promptTemplateRepository as never,
      promptVersionRepository as never,
      undefined,
      mcpServerRepository as never,
    );
    await expect(service.syncToTenants('clinic-summarizer', { targetTenantIds: [PARTNER] })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a sync back into the source tenant', async () => {
    await expect(makeService().syncToTenants('clinic-summarizer', { targetTenantIds: [TENANT] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s when the source is not the caller’s own agent (a SYSTEM template is already everywhere)', async () => {
    agentRepository.findAllVersionsBySlug.mockResolvedValue([]);
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(agent({ tenantId: SYSTEM_TENANT_ID }));
    await expect(makeService().syncToTenants('platform-summarization', { targetTenantIds: [PARTNER] })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a tenant-owned prompt template with a NAMED 409 instead of copying a reference the target cannot read', async () => {
    agentRepository.findAllVersionsBySlug.mockResolvedValue([agent({ instruction: { promptTemplateId: 'tpl-1' } })]);
    promptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-1', tenantId: TENANT, name: 'Clinic SOAP' } as never);
    await expect(makeService().syncToTenants('clinic-summarizer', { targetTenantIds: [PARTNER] })).rejects.toMatchObject({
      response: { code: 'PROMPT_TEMPLATE_NOT_PORTABLE' },
    });
    expect(agentRepository.create).not.toHaveBeenCalled();
  });

  it('allows a SYSTEM-owned template binding across the boundary', async () => {
    agentRepository.findAllVersionsBySlug.mockResolvedValue([agent({ instruction: { promptTemplateId: 'tpl-sys', promptVersionNumber: 2 } })]);
    promptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-sys', tenantId: SYSTEM_TENANT_ID, name: 'Platform SOAP' } as never);
    const result = await makeService().syncToTenants('clinic-summarizer', { targetTenantIds: [PARTNER] });
    expect(result.targets).toHaveLength(1);
  });

  it('strips the eval gate on the way across and warns about it', async () => {
    agentRepository.findAllVersionsBySlug.mockResolvedValue([agent({ instruction: { systemPrompt: 'x', evalGate: { goldenSetId: 'gs-1' } } })]);
    const result = await makeService().syncToTenants('clinic-summarizer', { targetTenantIds: [PARTNER] });
    expect(result.targets[0].warnings.join(' ')).toContain('eval gate was not copied');
    const written = agentRepository.create.mock.calls[0][0] as unknown as { instruction: Record<string, unknown> };
    expect(written.instruction).not.toHaveProperty('evalGate');
  });

  it('refuses a non-SYSTEM MCP tool binding with a NAMED 409', async () => {
    agentRepository.findAllVersionsBySlug.mockResolvedValue([agent({ tools: [{ mcpServerId: 'mcp-1', toolName: 'search' }] })]);
    mcpServerRepository.findEnabledById.mockResolvedValue({ id: 'mcp-1', tenantId: TENANT } as never);
    await expect(makeService().syncToTenants('clinic-summarizer', { targetTenantIds: [PARTNER] })).rejects.toMatchObject({
      response: { code: 'MCP_SERVER_NOT_PORTABLE' },
    });
  });
});

// ===========================================================================================
// TASK-890 §3.4 — the REFERENCE-SET copy (`cloneFromSystem`)
// ===========================================================================================

describe('cloneFromSystem', () => {
  const systemSource = () =>
    agent({
      id: 'sys-1',
      tenantId: SYSTEM_TENANT_ID,
      slug: 'platform-transcription',
      task: AgentTask.SPEECH_TO_TEXT,
      versionNumber: 2,
      status: WorkflowDefinitionStatus.PUBLISHED,
      isActive: true,
      compiledConfig: { frozen: 'artifact' },
      compiledConfigChecksum: 'sha256:frozen',
      instruction: { promptTemplateId: 'sys-template', promptVersionNumber: 4 },
    });

  it('lands the copy ALREADY PUBLISHED with the source`s compiled artifact — it never re-runs the publish gate', async () => {
    agentRepository.findSystemReferenceBySlug.mockResolvedValue(systemSource());
    // The bound template is SYSTEM-owned, which is what makes the agent portable at all — read
    // through the explicit reference read now that `PromptTemplate` is not shared-read.
    promptTemplateRepository.findSystemReferenceById.mockResolvedValue({ id: 'sys-template', tenantId: SYSTEM_TENANT_ID } as never);

    const result = await makeService().cloneFromSystem('platform-transcription', PARTNER);

    expect(result.created).toBe(true);
    // The gate asks "is this runnable HERE?", and answers MODEL_UNAVAILABLE in any environment
    // whose ASR weights are not staged — an environment fact that would leave the tenant with no
    // ASR assignment at all. The artifact is frozen, so the copy is servable wherever the
    // original was.
    const persisted = agentRepository.update.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(persisted['status']).toBe(WorkflowDefinitionStatus.PUBLISHED);
    expect(persisted['isActive']).toBe(true);
    expect(persisted['compiledConfig']).toEqual({ frozen: 'artifact' });
    expect(persisted['compiledConfigChecksum']).toBe('sha256:frozen');
    expect(persisted['tenantId']).toBe(PARTNER);
    expect(persisted['sourceTenantId']).toBe(SYSTEM_TENANT_ID);
  });

  it('re-points the prompt binding at the TARGET tenant`s clone, at THAT clone`s approved version', async () => {
    agentRepository.findSystemReferenceBySlug.mockResolvedValue(systemSource());
    promptTemplateRepository.findSystemReferenceById.mockResolvedValue({ id: 'sys-template', tenantId: SYSTEM_TENANT_ID } as never);
    promptTemplateRepository.findByTenantAndSourceTemplateId.mockResolvedValue({ id: 'tenant-template', approvedVersionNumber: 1 } as never);

    await makeService().cloneFromSystem('platform-transcription', PARTNER);

    const written = agentRepository.create.mock.calls.at(-1)![0] as Record<string, unknown>;
    // The SYSTEM id would dangle after the flip, and the SOURCE's pin numbers a version the
    // clone's restarted lineage does not have.
    expect(written['instruction']).toEqual({ promptTemplateId: 'tenant-template', promptVersionNumber: 1 });
  });

  it('is MISSING-ONLY: a tenant that already has a SERVING copy of the slug keeps exactly what it has', async () => {
    agentRepository.findSystemReferenceBySlug.mockResolvedValue(systemSource());
    agentRepository.findAllVersionsBySlug.mockResolvedValue([
      agent({ id: 'own-1', tenantId: PARTNER, slug: 'platform-transcription', status: WorkflowDefinitionStatus.PUBLISHED, isActive: true }),
    ] as never);

    const result = await makeService().cloneFromSystem('platform-transcription', PARTNER);

    expect(result).toEqual({ agentId: 'own-1', created: false, warnings: [] });
    expect(agentRepository.create).not.toHaveBeenCalled();
  });

  it('REPAIRS a pristine copy that is not serving — a residue leaves the tenant`s assignment pointing at nothing', async () => {
    agentRepository.findSystemReferenceBySlug.mockResolvedValue(systemSource());
    agentRepository.findAllVersionsBySlug.mockResolvedValue([
      agent({
        id: 'residue-1',
        tenantId: PARTNER,
        slug: 'platform-transcription',
        versionNumber: 1,
        status: WorkflowDefinitionStatus.DRAFT,
        isActive: false,
        sourceTenantId: SYSTEM_TENANT_ID,
        sourceAgentId: 'sys-1',
        compiledConfig: null,
      }),
    ] as never);

    const result = await makeService().cloneFromSystem('platform-transcription', PARTNER);

    expect(result.created).toBe(false);
    expect(result.warnings.join(' ')).toContain('re-aligned with the platform source');
    const persisted = agentRepository.update.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(persisted['status']).toBe(WorkflowDefinitionStatus.PUBLISHED);
    expect(persisted['compiledConfig']).toEqual({ frozen: 'artifact' });
  });

  it('leaves a copy the TENANT has re-versioned alone — only an untouched v1 residue is repaired', async () => {
    agentRepository.findSystemReferenceBySlug.mockResolvedValue(systemSource());
    agentRepository.findAllVersionsBySlug.mockResolvedValue([
      agent({
        id: 'tenant-authored',
        tenantId: PARTNER,
        slug: 'platform-transcription',
        versionNumber: 2,
        status: WorkflowDefinitionStatus.DRAFT,
        isActive: false,
        sourceTenantId: SYSTEM_TENANT_ID,
        sourceAgentId: 'sys-1',
      }),
    ] as never);

    const result = await makeService().cloneFromSystem('platform-transcription', PARTNER);

    expect(result).toEqual({ agentId: 'tenant-authored', created: false, warnings: [] });
    expect(agentRepository.update).not.toHaveBeenCalled();
  });

  it('404s when the slug names no PUBLISHED SYSTEM agent', async () => {
    agentRepository.findSystemReferenceBySlug.mockResolvedValue(null);
    await expect(makeService().cloneFromSystem('nope', PARTNER)).rejects.toBeInstanceOf(NotFoundException);
  });
});
