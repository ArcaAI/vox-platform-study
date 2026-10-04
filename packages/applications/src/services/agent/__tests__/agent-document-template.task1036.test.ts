/**
 * TASK-1036 OD-7 / OD-22 / W3 — the document template and the DNA switch live on the AGENT.
 *
 *  - `instruction.documentTemplate { slug }` and `parameters.dna { enabled }` are accepted and
 *    validated on create (the contract owns the shape; a `versionNumber` on the document template
 *    is refused, because a document template is never pinned).
 *  - The runtime resolution (`AgentResolverService.resolve`, which both `GET /internal/agents/resolve`
 *    and the pinned-version route serve) resolves the slug to the LATEST approved / published
 *    version in the REQUEST tenant on every call and returns it as `documentTemplate` — never a
 *    frozen copy, so republishing the template changes the next run without republishing the agent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AgentResolverService } from '../agent-resolver.service';
import { AgentService } from '../agent.service';

const TENANT = '50000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------------------------

const clsStore: Record<string, unknown> = {};
const mockClsService = { get: vi.fn((key: string) => clsStore[key]), set: vi.fn(), run: vi.fn(async (_o: unknown, w: () => unknown) => w()) };
const agentRepository = {
  findMaxVersionNumber: vi.fn(async () => 0),
  create: vi.fn(async (entity: unknown) => entity),
  findPublishedActiveBySlug: vi.fn(),
};
const fallbackRepository = { findByAgentId: vi.fn(async () => []), create: vi.fn() };
const TEXT_MODEL = {
  id: 'model-text',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'gpt-x',
  taskType: 'TEXT_GENERATION',
  provider: 'lm-studio',
  resourceStatus: ResourceStatusType.ENABLED,
  metaData: null,
};
const aiModelRepository = {
  findById: vi.fn(async () => TEXT_MODEL),
  findBySlug: vi.fn(async () => null),
  findByTaskTypeSharedRead: vi.fn(async () => []),
};
const databaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };

function makeService() {
  return new AgentService(
    agentRepository as never,
    fallbackRepository as never,
    aiModelRepository as never,
    { emit: vi.fn() } as never,
    mockClsService as never,
    databaseService as never,
  );
}

const CREATE = { slug: 'clinic-note', name: 'Clinic note', task: AgentTask.TEXT_GENERATION, modelId: 'model-text' };

beforeEach(() => {
  vi.clearAllMocks();
  clsStore.tenantId = TENANT;
  clsStore.user = { id: 'user-1', roles: ['TENANT_ADMIN'] };
  agentRepository.create.mockImplementation(async (entity: unknown) => entity);
  agentRepository.findMaxVersionNumber.mockImplementation(async () => 0);
  aiModelRepository.findById.mockImplementation(async () => TEXT_MODEL);
  databaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
});

describe('create accepts the document template and the DNA switch on the agent (OD-7)', () => {
  it('stores `instruction.documentTemplate { slug }` and `parameters.dna { enabled }`', async () => {
    const created = await makeService().create({
      ...CREATE,
      instruction: { systemPrompt: 'Write the note.', documentTemplate: { slug: 'soap-note' } },
      parameters: { dna: { enabled: true } },
    } as never);
    expect(created.instruction).toEqual({ systemPrompt: 'Write the note.', documentTemplate: { slug: 'soap-note' } });
    expect(created.parameters).toEqual({ dna: { enabled: true } });
  });

  it('refuses a version pin on the document template — it always floats to latest (W3, OD-22)', async () => {
    await expect(
      makeService().create({ ...CREATE, instruction: { systemPrompt: 'x', documentTemplate: { slug: 'soap-note', versionNumber: 2 } } } as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(agentRepository.create).not.toHaveBeenCalled();
  });

  it('refuses a DNA block that is not `{ enabled: boolean }`', async () => {
    await expect(
      makeService().create({ ...CREATE, instruction: { systemPrompt: 'x' }, parameters: { dna: { enabled: 'yes' } } } as never),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Runtime resolution
// ---------------------------------------------------------------------------------------------

const resolverAgents = { findPublishedActiveBySlug: vi.fn() };
const resolverModels = { findById: vi.fn(async () => ({ ...TEXT_MODEL, sourceUri: null, localPath: null, format: null })), findBySlug: vi.fn() };
const documentTemplates = { resolveForGeneration: vi.fn() };

function published(instruction: Record<string, unknown> | null) {
  return {
    id: 'agent-1',
    tenantId: TENANT,
    slug: 'clinic-note',
    versionNumber: 3,
    task: AgentTask.TEXT_GENERATION,
    compiledConfig: {
      task: 'TEXT_GENERATION',
      service: 'llm',
      model: { id: 'model-text', slug: 'gpt-x', provider: 'lm-studio', taskType: 'TEXT_GENERATION' },
      fallbacks: [],
      instruction,
      resolvedPrompt: { source: 'inline', content: 'Write the note.' },
      parameters: { dna: { enabled: true } },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tools: [],
    },
  };
}

function makeResolver() {
  return new AgentResolverService(
    resolverAgents as never,
    { findByAgentId: vi.fn(async () => []) } as never,
    resolverModels as never,
    { resolve: vi.fn() } as never,
    { resolveTenantCloudOverrides: vi.fn(async () => ({ overrides: {} })) } as never,
    undefined,
    undefined,
    documentTemplates as never,
  );
}

const COMPILED_DOC = { responseFormat: { type: 'json_schema' }, sectionKeys: ['subjective', 'plan'] };

describe('runtime: the agent’s document template resolves to LATEST on every call (OD-22)', () => {
  it('returns the servable version the request tenant has NOW', async () => {
    resolverAgents.findPublishedActiveBySlug.mockResolvedValue(published({ systemPrompt: 'x', documentTemplate: { slug: 'soap-note' } }));
    documentTemplates.resolveForGeneration.mockResolvedValueOnce({
      templateId: 'dt-1',
      slug: 'soap-note',
      versionNumber: 4,
      documentTemplateVersionId: 'dtv-4',
      compiled: COMPILED_DOC,
    });
    const resolved = await makeResolver().resolve({ tenantId: TENANT, agentSlug: 'clinic-note' });
    expect(documentTemplates.resolveForGeneration).toHaveBeenCalledWith(TENANT, 'soap-note');
    expect(resolved).toMatchObject({
      documentTemplate: { slug: 'soap-note', templateId: 'dt-1', versionNumber: 4, documentTemplateVersionId: 'dtv-4', compiled: COMPILED_DOC },
    });
  });

  it('re-resolves per call — a republished template is served without republishing the agent', async () => {
    resolverAgents.findPublishedActiveBySlug.mockResolvedValue(published({ systemPrompt: 'x', documentTemplate: { slug: 'soap-note' } }));
    documentTemplates.resolveForGeneration
      .mockResolvedValueOnce({ templateId: 'dt-1', slug: 'soap-note', versionNumber: 4, documentTemplateVersionId: 'dtv-4', compiled: COMPILED_DOC })
      .mockResolvedValueOnce({ templateId: 'dt-1', slug: 'soap-note', versionNumber: 5, documentTemplateVersionId: 'dtv-5', compiled: COMPILED_DOC });
    const resolver = makeResolver();
    const first = await resolver.resolve({ tenantId: TENANT, agentSlug: 'clinic-note' });
    const second = await resolver.resolve({ tenantId: TENANT, agentSlug: 'clinic-note' });
    expect((first as { documentTemplate?: { versionNumber: number } }).documentTemplate?.versionNumber).toBe(4);
    expect((second as { documentTemplate?: { versionNumber: number } }).documentTemplate?.versionNumber).toBe(5);
  });

  it('carries no `documentTemplate` when the agent names none', async () => {
    resolverAgents.findPublishedActiveBySlug.mockResolvedValue(published({ systemPrompt: 'x' }));
    const resolved = await makeResolver().resolve({ tenantId: TENANT, agentSlug: 'clinic-note' });
    expect(resolved).not.toHaveProperty('documentTemplate');
    expect(documentTemplates.resolveForGeneration).not.toHaveBeenCalled();
  });
});
