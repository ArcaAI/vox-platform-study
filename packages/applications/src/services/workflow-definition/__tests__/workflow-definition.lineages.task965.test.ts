/**
 * TASK-965 WS-2 — the workflow-definition lineage plane, at parity with the agent plane.
 *
 * Four backend gaps close here, all owner-approved:
 *   G1/WF-19 (OD-965-1) — no activate route, so rollback was impossible;
 *   G2       (OD-965-2) — workflow definitions had NO deprecate lifecycle at all (no route, no
 *                         writer: the enum member existed and nothing could ever write it);
 *   G9       (OD-965-2) — `deleteById` had no `isActive` guard (agents have a 409), so the LIVE
 *                         version could be soft-deleted and every assignment naming the slug
 *                         silently fell through at dispatch;
 *   G3       (OD-965-5) — `createdBy`/`updatedBy` were absent from the response and
 *                         `publishEntity` never stamped `updatedBy`, so "who published this"
 *                         was unanswerable for workflows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { SysEventType, WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';
import { WorkflowDefinitionDtoMapper } from '../workflow-definition.dto.mapper';

const TENANT = 'tenant-1';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  update: vi.fn(async (_id: string, entity: unknown) => entity),
  softDelete: vi.fn(async (id: string) => ({ id, slug: 'discharge-summary', versionNumber: 1 })),
  findPublishedBySlug: vi.fn(),
  findLineagesForTenant: vi.fn(),
};
const mockAssignmentRepository = { findAllForTenant: vi.fn(async () => []) };
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockEntitlements = { isEnforcementEnabled: vi.fn(() => false), assertQuantityQuota: vi.fn(), isFeatureEnabled: vi.fn(async () => true) };
const mockSttPipelineCompiler = { compileAndPublish: vi.fn() };

function entity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf-1',
    tenantId: TENANT,
    slug: 'discharge-summary',
    name: 'Discharge summary',
    description: null,
    paletteKey: 'core',
    versionNumber: 1,
    parentVersionId: null,
    status: WorkflowDefinitionStatus.PUBLISHED,
    graph: { version: 1, nodes: [], edges: [] },
    graphChecksum: 'checksum-1',
    compiledConfig: null,
    compiledConfigChecksum: null,
    registryChecksum: null,
    validationReport: null,
    needsReview: false,
    validatedAt: null,
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    deprecatedAt: null,
    isActive: false,
    sourceTemplateSlug: null,
    templateLocked: false,
    resourceStatus: 'ENABLED',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: 'author-1',
    updatedBy: 'publisher-1',
    version: 1,
    tags: [],
    hasChanges: false,
    changes: {},
    ...overrides,
  };
}

function lineage(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'discharge-summary',
    name: 'Discharge summary',
    paletteKey: 'core',
    versionCount: 2,
    latestVersionNumber: 2,
    deprecatedCount: 0,
    active: {
      id: 'wf-v1',
      versionNumber: 1,
      status: WorkflowDefinitionStatus.PUBLISHED,
      publishedAt: new Date('2026-01-01T00:00:00Z'),
      publishedBy: 'publisher-1',
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      registryChecksum: 'sha256:registry',
      compiledConfigChecksum: 'sha256:compiled',
    },
    draft: {
      id: 'wf-v2',
      versionNumber: 2,
      status: WorkflowDefinitionStatus.VALIDATED,
      publishedAt: null,
      publishedBy: null,
      updatedAt: new Date('2026-02-01T00:00:00Z'),
      registryChecksum: null,
      compiledConfigChecksum: null,
    },
    origin: { sourceTemplateSlug: 'platform-discharge-summary', templateLocked: true },
    tags: [],
    updatedAt: new Date('2026-02-01T00:00:00Z'),
    ...overrides,
  };
}

function assignment(overrides: Record<string, unknown> = {}) {
  return { id: 'wa-1', tenantId: TENANT, scope: 'TENANT', scopeId: null, paletteKey: 'core', workflowDefinitionSlug: 'discharge-summary', selectorKey: '', ...overrides };
}

function makeService() {
  return new WorkflowDefinitionService(
    mockRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    mockEntitlements as never,
    mockSttPipelineCompiler as never,
    // 13 optional dependencies sit between the compiler and the assignment repository
    // (workflowValidator, the prompt pair, context schemas, routing policy, the agent/model
    // repositories, document templates, MCP servers, promotion, the eval gate, the policy
    // engine, the agent service) — the register needs none of them.
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
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
  mockClsService.get.mockImplementation((key: string) => {
    if (key === 'tenantId') return TENANT;
    if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
    return undefined;
  });
  mockRepository.update.mockImplementation(async (_id: string, row: unknown) => row);
  mockAssignmentRepository.findAllForTenant.mockResolvedValue([]);
});

describe('listLineages', () => {
  it('answers ONE row per slug with the active pointer, the open draft, the origin and the counts', async () => {
    mockRepository.findLineagesForTenant.mockResolvedValue({ data: [lineage()], count: 1 });

    const page = await makeService().listLineages({ page: 1, limit: 10 });

    expect(page.count).toBe(1);
    const row = page.data[0];
    expect(row.slug).toBe('discharge-summary');
    expect(row.paletteKey).toBe('core');
    expect(row.active).toEqual({
      id: 'wf-v1',
      versionNumber: 1,
      publishedAt: '2026-01-01T00:00:00.000Z',
      publishedBy: 'publisher-1',
      registryChecksum: 'sha256:registry',
      compiledConfigChecksum: 'sha256:compiled',
    });
    expect(row.draft).toEqual({ id: 'wf-v2', versionNumber: 2, status: 'VALIDATED', updatedAt: '2026-02-01T00:00:00.000Z' });
    expect(row.origin).toEqual({ sourceTemplateSlug: 'platform-discharge-summary', templateLocked: true });
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.anything());
  });

  it('joins the assignment summary from the tenant’s own rows', async () => {
    mockRepository.findLineagesForTenant.mockResolvedValue({ data: [lineage()], count: 1 });
    mockAssignmentRepository.findAllForTenant.mockResolvedValue([
      assignment(),
      assignment({ id: 'wa-2', scope: 'DEPARTMENT', scopeId: 'dept-cardio' }),
      assignment({ id: 'wa-3', scope: 'DEPARTMENT', scopeId: 'dept-cardio', selectorKey: 'visit-type:revisit' }),
      assignment({ id: 'wa-4', workflowDefinitionSlug: 'other' }),
    ]);

    const page = await makeService().listLineages({ page: 1, limit: 10 });

    expect(page.data[0].assignment).toEqual({ tenantDefault: true, departmentCount: 1, selectorCount: 1 });
  });
});

describe('activate', () => {
  it('elects a PUBLISHED inactive version, demotes the sibling and broadcasts ResourceUpdated', async () => {
    const target = entity({ id: 'wf-v1', versionNumber: 1, isActive: false });
    const sibling = entity({ id: 'wf-v2', versionNumber: 2, isActive: true });
    mockRepository.findById.mockResolvedValue(target);
    mockRepository.findPublishedBySlug.mockResolvedValue(sibling);

    const response = await makeService().activate('wf-v1');

    expect(response.isActive).toBe(true);
    expect(sibling.isActive).toBe(false);
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceUpdated,
      expect.objectContaining({ data: expect.objectContaining({ action: 'activate', demotedVersionNumber: 2 }) }),
    );
  });

  it('refuses a DRAFT version with 400', async () => {
    mockRepository.findById.mockResolvedValue(entity({ status: WorkflowDefinitionStatus.DRAFT }));

    await expect(makeService().activate('wf-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(mockRepository.update).not.toHaveBeenCalled();
  });
});

describe('deprecate', () => {
  it('retires a PUBLISHED version: DEPRECATED, deprecatedAt stamped, isActive cleared', async () => {
    const target = entity({ isActive: true });
    mockRepository.findById.mockResolvedValue(target);

    const response = await makeService().deprecate('wf-1');

    expect(response.status).toBe('DEPRECATED');
    expect(response.isActive).toBe(false);
    expect(response.deprecatedAt).not.toBeNull();
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceUpdated,
      expect.objectContaining({ data: expect.objectContaining({ action: 'deprecate' }) }),
    );
  });

  it('refuses a DRAFT version with 400 (there is nothing published to retire)', async () => {
    mockRepository.findById.mockResolvedValue(entity({ status: WorkflowDefinitionStatus.DRAFT }));

    await expect(makeService().deprecate('wf-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(mockRepository.update).not.toHaveBeenCalled();
  });
});

describe('deleteById — the isActive guard (G9)', () => {
  it('refuses to soft-delete the ACTIVE version with 409, so an assignment can never point at nothing', async () => {
    mockRepository.findById.mockResolvedValue(entity({ isActive: true }));

    await expect(makeService().deleteById('wf-1')).rejects.toBeInstanceOf(ConflictException);
    expect(mockRepository.softDelete).not.toHaveBeenCalled();
  });

  it('still deletes an inactive version', async () => {
    mockRepository.findById.mockResolvedValue(entity({ isActive: false }));
    mockRepository.softDelete.mockResolvedValue(entity({ isActive: false, resourceStatus: 'DELETED' }));

    await makeService().deleteById('wf-1');

    expect(mockRepository.softDelete).toHaveBeenCalledWith('wf-1', 'admin-1');
  });
});

describe('WorkflowDefinitionResponse — who made this (G3, OD-965-5)', () => {
  it('carries createdBy and updatedBy', () => {
    const dto = WorkflowDefinitionDtoMapper.toResponse(entity() as never);

    expect(dto.createdBy).toBe('author-1');
    expect(dto.updatedBy).toBe('publisher-1');
  });
});
