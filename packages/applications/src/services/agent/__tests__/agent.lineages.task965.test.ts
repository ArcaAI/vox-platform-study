/**
 * TASK-965 WS-2 — the agent LINEAGE plane: `AgentService.listLineages` and `AgentService.activate`.
 *
 * Two owner decisions are pinned here:
 *
 * OD-965-3 — the console's list is one row per SLUG, and the projection carries everything that
 * row renders: which version is ACTIVE, whether an open draft exists, how many versions there
 * are, and what the slug SERVES (the assignment summary). Grouping client-side over the
 * per-version list is wrong at a page boundary, which is why this lives in the service.
 *
 * OD-965-1 — `activate` is its OWN verb. Before it, `publish()` was the only writer of
 * `isActive = true` and `assertMutable` refuses a PUBLISHED row, so a published-but-inactive
 * version could never be served again: rollback was impossible without minting yet another
 * version row (the reported symptom, literally).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AgentTask, PipelinePolicyScope, ResourceStatusType, SysEventType, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentService } from '../agent.service';

const TENANT = '50000000-0000-0000-0000-000000000000';
const SYSTEM = '00000000-0000-0000-0000-000000000000';

const clsStore: Record<string, unknown> = { tenantId: TENANT, user: { id: 'user-1', roles: [] } };
const mockClsService = {
  get: vi.fn((key: string) => clsStore[key]),
  set: vi.fn((key: string, value: unknown) => {
    clsStore[key] = value;
  }),
  run: vi.fn(async (_options: unknown, work: () => unknown) => work()),
};
const mockEventEmitter = { emit: vi.fn() };
const mockAgentRepository = {
  findLineagesForTenant: vi.fn(),
  findByIdVisible: vi.fn(),
  findOwnActiveBySlug: vi.fn(),
  update: vi.fn(async (_id: string, entity: unknown) => entity),
};
const mockFallbackRepository = { findByAgentId: vi.fn(async () => []) };
const mockAiModelRepository = { findById: vi.fn(), findByTaskTypeSharedRead: vi.fn(async () => []) };
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockAssignments = { resolve: vi.fn(async () => ({ agentSlug: null, source: 'unassigned', selector: [] })) };
const mockAssignmentRepository = { findAllVisible: vi.fn(async () => []) };

function lineage(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'realtime-transcription',
    name: 'Realtime transcription',
    task: AgentTask.SPEECH_TO_TEXT,
    versionCount: 3,
    latestVersionNumber: 3,
    deprecatedCount: 1,
    active: {
      id: 'a-v2',
      versionNumber: 2,
      status: WorkflowDefinitionStatus.PUBLISHED,
      publishedAt: new Date('2026-02-01T00:00:00Z'),
      publishedBy: 'user-publisher',
      updatedAt: new Date('2026-02-01T00:00:00Z'),
      modelId: 'model-asr',
      compiledConfigChecksum: 'sha256:abc',
    },
    draft: {
      id: 'a-v3',
      versionNumber: 3,
      status: WorkflowDefinitionStatus.DRAFT,
      publishedAt: null,
      publishedBy: null,
      updatedAt: new Date('2026-03-01T00:00:00Z'),
      modelId: 'model-asr',
      compiledConfigChecksum: null,
    },
    origin: { sourceTenantId: SYSTEM, sourceSlug: 'realtime-transcription' },
    tags: ['domain:clinical'],
    updatedAt: new Date('2026-03-01T00:00:00Z'),
    ...overrides,
  };
}

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'as-1',
    tenantId: TENANT,
    scope: PipelinePolicyScope.TENANT,
    scopeId: null,
    task: AgentTask.SPEECH_TO_TEXT,
    agentSlug: 'realtime-transcription',
    selectorKey: '',
    ...overrides,
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a-v1',
    tenantId: TENANT,
    slug: 'realtime-transcription',
    name: 'Realtime transcription',
    description: null,
    task: AgentTask.SPEECH_TO_TEXT,
    versionNumber: 1,
    status: WorkflowDefinitionStatus.PUBLISHED,
    isActive: false,
    modelId: 'model-asr',
    instruction: null,
    parameters: null,
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: null,
    compiledConfigChecksum: 'sha256:v1',
    validationReport: null,
    validatedAt: null,
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    deprecatedAt: null,
    resourceStatus: ResourceStatusType.ENABLED,
    tags: [],
    version: 4,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    updatedBy: null,
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
    mockAssignments as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    mockAssignmentRepository as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clsStore.tenantId = TENANT;
  clsStore.user = { id: 'user-1', roles: [] };
  mockClsService.get.mockImplementation((key: string) => clsStore[key]);
  mockAgentRepository.update.mockImplementation(async (_id: string, entity: unknown) => entity);
  mockAssignmentRepository.findAllVisible.mockResolvedValue([]);
  mockAiModelRepository.findByTaskTypeSharedRead.mockResolvedValue([{ id: 'model-asr', slug: 'whisper-large-ml-en' }]);
});

import { PLATFORM_HIDDEN_AGENTS } from '../platform-hidden-agents';
import { AgentDtoMapper } from '../agent.dto.mapper';

describe('AgentLineageResponse.hidden (TASK-983 follow-up for WS-4)', () => {
  const base = {
    slug: 'x', name: 'X', task: 'TEXT_GENERATION', versionCount: 1, latestVersionNumber: 1, deprecatedCount: 0,
    active: null, draft: null, origin: { sourceTenantId: null, sourceSlug: null }, tags: [], updatedAt: new Date(0),
  };
  const assignment = { tenantDefault: false, departmentCount: 0, selectorCount: 0 };
  it('flags the platform hidden agent and nothing else', () => {
    const hiddenSlug = Object.keys(PLATFORM_HIDDEN_AGENTS)[0] ?? 'dna-writing-style-analyst';
    expect(AgentDtoMapper.toLineageResponse({ ...base, slug: hiddenSlug } as never, assignment).hidden).toBe(true);
    expect(AgentDtoMapper.toLineageResponse({ ...base, slug: 'medical-ner' } as never, assignment).hidden).toBe(false);
  });
});

describe('listLineages', () => {
  it('answers ONE row per slug, with the active/draft pointers, the counts and the model slug', async () => {
    mockAgentRepository.findLineagesForTenant.mockResolvedValue({ data: [lineage()], count: 1 });

    const page = await makeService().listLineages({ page: 1, limit: 10 });

    expect(page.count).toBe(1);
    expect(page.page).toBe(1);
    expect(page.limit).toBe(10);
    expect(page.data).toHaveLength(1);
    const row = page.data[0];
    expect(row.slug).toBe('realtime-transcription');
    expect(row.versionCount).toBe(3);
    expect(row.latestVersionNumber).toBe(3);
    expect(row.deprecatedCount).toBe(1);
    expect(row.active).toEqual({
      id: 'a-v2',
      versionNumber: 2,
      publishedAt: '2026-02-01T00:00:00.000Z',
      publishedBy: 'user-publisher',
      modelSlug: 'whisper-large-ml-en',
      compiledConfigChecksum: 'sha256:abc',
    });
    expect(row.draft).toEqual({ id: 'a-v3', versionNumber: 3, status: 'DRAFT', updatedAt: '2026-03-01T00:00:00.000Z' });
    expect(row.origin).toEqual({ sourceTenantId: SYSTEM, sourceSlug: 'realtime-transcription' });
    expect(row.updatedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.anything());
  });

  it('joins the assignment summary: the unqualified TENANT row is the tenant default, department rows are counted by scopeId', async () => {
    mockAgentRepository.findLineagesForTenant.mockResolvedValue({ data: [lineage()], count: 1 });
    mockAssignmentRepository.findAllVisible.mockResolvedValue([
      assignment(),
      assignment({ id: 'as-2', scope: PipelinePolicyScope.DEPARTMENT, scopeId: 'dept-cardio' }),
      assignment({ id: 'as-3', scope: PipelinePolicyScope.DEPARTMENT, scopeId: 'dept-ent' }),
      assignment({ id: 'as-4', selectorKey: 'specialty:cardiology' }),
      // Another slug's rows, and a SYSTEM reference-set row, must not be counted.
      assignment({ id: 'as-5', agentSlug: 'other-slug', scope: PipelinePolicyScope.DEPARTMENT, scopeId: 'dept-cardio' }),
      assignment({ id: 'as-6', tenantId: SYSTEM }),
    ]);

    const page = await makeService().listLineages({ page: 1, limit: 10 });

    expect(page.data[0].assignment).toEqual({ tenantDefault: true, departmentCount: 2, selectorCount: 1 });
  });

  it('answers `active: null` and no tenant default for a lineage nothing serves', async () => {
    mockAgentRepository.findLineagesForTenant.mockResolvedValue({ data: [lineage({ active: null, deprecatedCount: 2 })], count: 1 });

    const page = await makeService().listLineages({ page: 1, limit: 10 });

    expect(page.data[0].active).toBeNull();
    expect(page.data[0].assignment).toEqual({ tenantDefault: false, departmentCount: 0, selectorCount: 0 });
  });
});

describe('activate', () => {
  it('elects a PUBLISHED inactive version, demotes the sibling and broadcasts ResourceUpdated', async () => {
    const target = agent({ id: 'a-v1', versionNumber: 1, isActive: false });
    const sibling = agent({ id: 'a-v2', versionNumber: 2, isActive: true });
    mockAgentRepository.findByIdVisible.mockResolvedValue(target);
    mockAgentRepository.findOwnActiveBySlug.mockResolvedValue(sibling);

    const response = await makeService().activate('a-v1');

    expect(response.isActive).toBe(true);
    expect(sibling.isActive).toBe(false);
    expect(mockAgentRepository.update).toHaveBeenCalledWith('a-v2', sibling);
    expect(mockAgentRepository.update).toHaveBeenCalledWith('a-v1', target);
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceUpdated,
      expect.objectContaining({ data: expect.objectContaining({ action: 'activate', demotedVersionNumber: 2 }) }),
    );
  });

  it('refuses a DRAFT version with 400 and writes nothing', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ status: WorkflowDefinitionStatus.DRAFT }));

    await expect(makeService().activate('a-v1')).rejects.toBeInstanceOf(BadRequestException);
    expect(mockAgentRepository.update).not.toHaveBeenCalled();
  });

  it('refuses a DEPRECATED version with 400 (it must be republished, not silently revived)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(agent({ status: WorkflowDefinitionStatus.DEPRECATED }));

    await expect(makeService().activate('a-v1')).rejects.toBeInstanceOf(BadRequestException);
    expect(mockAgentRepository.update).not.toHaveBeenCalled();
  });

  it('answers 404 for another tenant’s version (404-over-403)', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(null);

    await expect(makeService().activate('a-v1')).rejects.toBeInstanceOf(NotFoundException);
    expect(mockAgentRepository.update).not.toHaveBeenCalled();
  });
});
