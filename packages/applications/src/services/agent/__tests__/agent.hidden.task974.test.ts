/**
 * TASK-974 §5.1 items 3 + 4 — what "hidden" MEANS on the agent plane.
 *
 * Three halves, each pinned where it is enforced:
 *
 *  · the BUSINESS plane never serves a hidden slug — omitted from `listPublished`, 404 from
 *    `getPublishedBySlug`, and 404 from `AgentResolverService.resolve`, which is the ONE
 *    chokepoint every by-slug runtime call goes through (invoke / speech / transcribe / a
 *    `core.agent` node). Global is the case that matters: it OWNS the authored row, so for
 *    every other tenant the row is simply absent and nothing needed refusing.
 *  · the ADMIN plane still serves it, flagged, so a console can label it rather than pretend
 *    the platform's own agent does not exist.
 *  · the PLATFORM SERVICE that owns the capability opts IN explicitly
 *    (`allowPlatformHidden`), so the one caller that may resolve it says so at the call site.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentService } from '../agent.service';
import { AgentResolverService } from '../agent-resolver.service';
import { AgentDtoMapper } from '../agent.dto.mapper';
import { DNA_WRITING_STYLE_ANALYST_SLUG } from '../platform-hidden-agents';

const TENANT = '50000000-0000-0000-0000-000000000000';

// ─── AgentService fixture (the shape of agent.service.test.ts, narrowed to the reads) ────────
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
  findAllForTenant: vi.fn(async () => []),
  findPublishedActiveVisible: vi.fn(async () => []),
  findPublishedActiveBySlug: vi.fn(async () => null),
  findSystemReferences: vi.fn(async () => []),
  findSystemReferenceBySlug: vi.fn(async () => null),
  findOwnActiveBySlug: vi.fn(),
  findAllVersionsBySlug: vi.fn(),
  findMaxVersionNumber: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
};
const mockFallbackRepository = { findByAgentId: vi.fn(async () => []) };
const mockAiModelRepository = { findById: vi.fn(), findByIdOrNull: vi.fn(async () => null), findBySlug: vi.fn(), findByTaskTypeSharedRead: vi.fn(async () => []) };
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockAssignments = { resolve: vi.fn(async () => ({ agentSlug: null, source: 'unassigned' })) };
const mockProviderConnections = { resolveConnection: vi.fn(), findRow: vi.fn(), findDefaultRow: vi.fn(), resolveTenantCloudOverrides: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn() };
const mockContextSchemas = { resolveReference: vi.fn() };
const mockReadiness = { getSnapshot: vi.fn(async () => null) };

function makeService(): AgentService {
  return new AgentService(
    mockAgentRepository as never,
    mockFallbackRepository as never,
    mockAiModelRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    mockAssignments as never,
    mockProviderConnections as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    undefined as never,
    undefined as never,
    mockContextSchemas as never,
    mockReadiness as never,
  );
}

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    tenantId: TENANT,
    slug: 'clinic-summarizer',
    name: 'Clinic summarizer',
    description: null,
    task: AgentTask.TEXT_GENERATION,
    versionNumber: 1,
    parentVersionId: null,
    sourceAgentId: null,
    sourceTenantId: null,
    sourceSlug: null,
    sourceVersionNumber: null,
    status: WorkflowDefinitionStatus.PUBLISHED,
    isActive: true,
    modelId: 'model-llm',
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    instruction: null,
    parameters: null,
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: null,
    compiledConfigChecksum: null,
    validationReport: null,
    validatedAt: null,
    publishedAt: new Date(),
    deprecatedAt: null,
    resourceStatus: ResourceStatusType.ENABLED,
    tags: [],
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    updatedBy: null,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(clsStore)) delete clsStore[key];
  clsStore.tenantId = TENANT;
  clsStore.user = { id: 'user-1', roles: [] };
  mockAssignments.resolve.mockResolvedValue({ agentSlug: null, source: 'unassigned' });
});

describe('AgentService — the business plane never serves a platform hidden agent', () => {
  it('listPublished omits the hidden slug even when the tenant OWNS a row for it (Global)', async () => {
    mockAgentRepository.findPublishedActiveVisible.mockResolvedValue([
      agentRow(),
      agentRow({ id: 'agent-hidden', slug: DNA_WRITING_STYLE_ANALYST_SLUG }),
    ] as never);

    const rows = await makeService().listPublished();

    expect(rows.map((row) => row.slug)).toEqual(['clinic-summarizer']);
  });

  it('getPublishedBySlug answers 404 for the hidden slug WITHOUT reading the row', async () => {
    await expect(makeService().getPublishedBySlug(DNA_WRITING_STYLE_ANALYST_SLUG)).rejects.toBeInstanceOf(NotFoundException);
    // Same 404 an unknown slug gets, and nothing is disclosed on the way — including by timing.
    expect(mockAgentRepository.findPublishedActiveBySlug).not.toHaveBeenCalled();
  });

  it('the ADMIN list still serves it — hiding it there would hide the platform agent from its own administrator', async () => {
    mockAgentRepository.findAllForTenant.mockResolvedValue([agentRow({ id: 'agent-hidden', slug: DNA_WRITING_STYLE_ANALYST_SLUG })] as never);

    const rows = await makeService().list();

    expect(rows.map((row) => row.slug)).toEqual([DNA_WRITING_STYLE_ANALYST_SLUG]);
    expect(rows[0].hidden).toBe(true);
  });
});

describe('AgentDtoMapper.toResponse — `hidden` is DERIVED from the registry, never stored', () => {
  it('flags a declared hidden slug and leaves every other agent false', () => {
    expect(AgentDtoMapper.toResponse(agentRow({ slug: DNA_WRITING_STYLE_ANALYST_SLUG })).hidden).toBe(true);
    expect(AgentDtoMapper.toResponse(agentRow()).hidden).toBe(false);
  });
});

// ─── AgentResolverService: the ONE by-slug runtime chokepoint ────────────────────────────────
const resolverAgentRepository = { findPublishedActiveBySlug: vi.fn() };
const resolverFallbackRepository = { findByAgentId: vi.fn(async () => []) };
const resolverModelRepository = { findById: vi.fn(), findBySlug: vi.fn() };
const resolverAssignments = { resolve: vi.fn() };

const compiled = {
  task: 'TEXT_GENERATION',
  service: 'llm',
  model: { id: 'm1', slug: 'lms-gemma-4-e2b-it-qat', provider: 'lm-studio', taskType: 'TEXT_GENERATION' },
  fallbacks: [],
  instruction: null,
  resolvedPrompt: null,
  parameters: {},
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  tools: [],
  protocols: ['http'],
};

function makeResolver(): AgentResolverService {
  return new AgentResolverService(
    resolverAgentRepository as never,
    resolverFallbackRepository as never,
    resolverModelRepository as never,
    resolverAssignments as never,
  );
}

describe('AgentResolverService — a hidden slug is 404 unless the caller opts in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolverModelRepository.findById.mockResolvedValue({ id: 'm1', tenantId: SYSTEM_TENANT_ID, slug: 'lms-gemma-4-e2b-it-qat', provider: 'lm-studio' });
    resolverAgentRepository.findPublishedActiveBySlug.mockResolvedValue({
      id: 'agent-hidden',
      tenantId: SYSTEM_TENANT_ID,
      slug: DNA_WRITING_STYLE_ANALYST_SLUG,
      versionNumber: 1,
      task: AgentTask.TEXT_GENERATION,
      compiledConfig: compiled,
    });
  });

  it('refuses an explicit hidden slug with the SAME 404 an unknown slug gets', async () => {
    await expect(makeResolver().resolve({ tenantId: TENANT, agentSlug: DNA_WRITING_STYLE_ANALYST_SLUG })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses it even for a tenant that owns the row (the Global playground authors it)', async () => {
    resolverAgentRepository.findPublishedActiveBySlug.mockResolvedValue({
      id: 'agent-hidden-global',
      tenantId: TENANT,
      slug: DNA_WRITING_STYLE_ANALYST_SLUG,
      versionNumber: 1,
      task: AgentTask.TEXT_GENERATION,
      compiledConfig: compiled,
    });
    await expect(makeResolver().resolve({ tenantId: TENANT, agentSlug: DNA_WRITING_STYLE_ANALYST_SLUG })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a hidden slug reached through the ASSIGNMENT cascade too — a stale row cannot re-open the plane', async () => {
    resolverAssignments.resolve.mockResolvedValue({ agentSlug: DNA_WRITING_STYLE_ANALYST_SLUG, source: 'tenant' });
    await expect(makeResolver().resolve({ tenantId: TENANT, task: AgentTask.TEXT_GENERATION })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('serves it to the platform service that opts in explicitly', async () => {
    const resolved = await makeResolver().resolve({
      tenantId: SYSTEM_TENANT_ID,
      agentSlug: DNA_WRITING_STYLE_ANALYST_SLUG,
      allowPlatformHidden: true,
    });
    expect(resolved).toMatchObject({ slug: DNA_WRITING_STYLE_ANALYST_SLUG, tenantId: SYSTEM_TENANT_ID, source: 'explicit' });
  });

  it('leaves every ordinary slug untouched', async () => {
    resolverAgentRepository.findPublishedActiveBySlug.mockResolvedValue({
      id: 'agent-1',
      tenantId: TENANT,
      slug: 'clinic-summarizer',
      versionNumber: 1,
      task: AgentTask.TEXT_GENERATION,
      compiledConfig: compiled,
    });
    await expect(makeResolver().resolve({ tenantId: TENANT, agentSlug: 'clinic-summarizer' })).resolves.toMatchObject({ slug: 'clinic-summarizer' });
  });
});
