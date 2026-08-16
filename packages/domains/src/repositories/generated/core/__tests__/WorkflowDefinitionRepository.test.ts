/**
 * WorkflowDefinitionRepository — repository shape.
 *
 * `findPublishedBySlug` is the exposure gateway's (TASK-722) resolution
 * primitive: it must filter by tenantId + slug + PUBLISHED + isActive +
 * ENABLED, and must return `null` — never throw — on a miss (foreign tenant,
 * unpublished/inactive slug, or a slug that never existed), so the caller can
 * map every one of those to a uniform 404 (never a 403).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowDefinitionRepository } from '../WorkflowDefinitionRepository';
import { ResourceStatusType, WorkflowDefinitionStatus } from '../../../../enums';

const row = {
  id: 'wfd-1',
  tenantId: 'tenant-1',
  slug: 'intake-summary',
  name: 'Intake Summary',
  description: null,
  paletteKey: 'summarization',
  versionNumber: 3,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.PUBLISHED,
  graph: { nodes: [] },
  graphChecksum: 'sha256:abc',
  compiledConfig: { nodes: [] },
  compiledConfigChecksum: 'sha256:def',
  registryChecksum: 'sha256:ghi',
  validationReport: null,
  needsReview: false,
  validatedAt: new Date(),
  publishedAt: new Date(),
  deprecatedAt: null,
  isActive: true,
  resourceStatus: ResourceStatusType.ENABLED,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: null,
  updatedBy: null,
  resourceStatusUpdatedAt: null,
  resourceStatusUpdatedBy: null,
  metaData: null,
  tags: [],
};

describe('WorkflowDefinitionRepository — findPublishedBySlug', () => {
  let findFirst: ReturnType<typeof vi.fn>;
  let repo: WorkflowDefinitionRepository;

  beforeEach(() => {
    findFirst = vi.fn();
    const delegate = { findFirst };
    const unitOfWork = { getDatabaseService: () => ({ workflowDefinition: delegate }) };
    repo = new WorkflowDefinitionRepository(unitOfWork as never);
  });

  it('filters by tenantId, slug, PUBLISHED, isActive, ENABLED', async () => {
    findFirst.mockResolvedValue(row);

    const entity = await repo.findPublishedBySlug('tenant-1', 'intake-summary');

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          slug: 'intake-summary',
          status: WorkflowDefinitionStatus.PUBLISHED,
          isActive: true,
          resourceStatus: ResourceStatusType.ENABLED,
        }),
      }),
    );
    expect(entity?.slug).toBe('intake-summary');
    expect(entity?.versionNumber).toBe(3);
  });

  it('returns null — never throws — on a miss (foreign tenant / unpublished / unknown slug)', async () => {
    findFirst.mockResolvedValue(null);

    const entity = await repo.findPublishedBySlug('tenant-1', 'nonexistent');

    expect(entity).toBeNull();
  });
});

describe('WorkflowDefinitionRepository — findAllVersionsBySlug', () => {
  let findMany: ReturnType<typeof vi.fn>;
  let repo: WorkflowDefinitionRepository;

  beforeEach(() => {
    findMany = vi.fn();
    const delegate = { findMany };
    const unitOfWork = { getDatabaseService: () => ({ workflowDefinition: delegate }) };
    repo = new WorkflowDefinitionRepository(unitOfWork as never);
  });

  it('filters by tenantId + slug + ENABLED, sorted newest version first', async () => {
    findMany.mockResolvedValue([row]);

    const rows = await repo.findAllVersionsBySlug('tenant-1', 'intake-summary');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          slug: 'intake-summary',
          resourceStatus: ResourceStatusType.ENABLED,
        }),
        orderBy: [{ versionNumber: 'desc' }],
      }),
    );
    expect(rows).toHaveLength(1);
  });
});
