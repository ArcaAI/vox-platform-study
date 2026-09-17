/**
 * TASK-965 WS-2 — the workflow half of the lineage reads, at PARITY with the agent half.
 *
 * `findPublishedBySlugVersion` closes gap G7: `findPublishedBySlug` answers the ACTIVE version,
 * so a caller holding an explicit version PIN had no read that honours it and would silently be
 * served a different version. `findLineagesForTenant` is OD-965-3's register read — the
 * definitions list pages per VERSION today, so grouping it client-side is wrong at a page
 * boundary.
 */
import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { WorkflowDefinitionRepository } from '../generated/core/WorkflowDefinitionRepository';
import { ResourceStatusType, WorkflowDefinitionStatus } from '../../enums';

const TENANT = '50000000-0000-0000-0000-000000000000';
const OTHER = '50000000-0000-0000-0000-000000000009';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf-1',
    tenantId: TENANT,
    slug: 'discharge-summary',
    name: 'Discharge summary',
    paletteKey: 'core',
    versionNumber: 1,
    status: WorkflowDefinitionStatus.DRAFT,
    isActive: false,
    registryChecksum: null,
    compiledConfigChecksum: null,
    publishedAt: null,
    deprecatedAt: null,
    sourceTemplateSlug: null,
    templateLocked: false,
    tags: [],
    resourceStatus: ResourceStatusType.ENABLED,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    updatedBy: null,
    ...overrides,
  };
}

function makeRepo(rows: ReturnType<typeof row>[] = []) {
  const delegate = { findMany: vi.fn().mockResolvedValue(rows), findFirst: vi.fn().mockResolvedValue(rows[0] ?? null) };
  const uow = { getDatabaseService: () => ({ workflowDefinition: delegate }) };
  return { repo: new WorkflowDefinitionRepository(uow as never), delegate };
}

describe('WorkflowDefinitionRepository.findPublishedBySlugVersion', () => {
  it('reads the PINNED version — published, live, and NOT narrowed to the active pointer', async () => {
    const { repo, delegate } = makeRepo([row({ id: 'wf-v2', versionNumber: 2, status: WorkflowDefinitionStatus.PUBLISHED, isActive: false })]);

    const entity = await repo.findPublishedBySlugVersion(TENANT, 'discharge-summary', 2);

    expect(entity?.id).toBe('wf-v2');
    const where = delegate.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      tenantId: TENANT,
      slug: 'discharge-summary',
      versionNumber: 2,
      status: WorkflowDefinitionStatus.PUBLISHED,
      resourceStatus: ResourceStatusType.ENABLED,
    });
    expect(where.isActive).toBeUndefined();
  });

  it('answers null — never throws — for a miss', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findFirst.mockResolvedValue(null);

    await expect(repo.findPublishedBySlugVersion(TENANT, 'nope', 9)).resolves.toBeNull();
  });
});

describe('WorkflowDefinitionRepository.findLineagesForTenant', () => {
  it('folds a slug into ONE lineage with the active pointer, the open draft and the counts', async () => {
    const { repo } = makeRepo([
      row({ id: 'wf-v3', versionNumber: 3, status: WorkflowDefinitionStatus.DRAFT, updatedAt: new Date('2026-03-01T00:00:00Z') }),
      row({
        id: 'wf-v2',
        versionNumber: 2,
        status: WorkflowDefinitionStatus.PUBLISHED,
        isActive: true,
        publishedAt: new Date('2026-02-01T00:00:00Z'),
        updatedBy: 'user-publisher',
        registryChecksum: 'sha256:registry',
      }),
      row({ id: 'wf-v1', versionNumber: 1, status: WorkflowDefinitionStatus.DEPRECATED }),
    ]);

    const { data, count } = await repo.findLineagesForTenant(TENANT, { page: 1, limit: 10 });

    expect(count).toBe(1);
    expect(data[0]).toMatchObject({ slug: 'discharge-summary', paletteKey: 'core', versionCount: 3, latestVersionNumber: 3, deprecatedCount: 1 });
    expect(data[0].active).toMatchObject({ id: 'wf-v2', versionNumber: 2, publishedBy: 'user-publisher', registryChecksum: 'sha256:registry' });
    expect(data[0].draft).toMatchObject({ id: 'wf-v3', versionNumber: 3, status: WorkflowDefinitionStatus.DRAFT });
    expect(data[0].updatedAt).toEqual(new Date('2026-03-01T00:00:00Z'));
  });

  it('answers `active: null` for a lineage nothing serves', async () => {
    const { repo } = makeRepo([row({ id: 'wf-v1', versionNumber: 1, status: WorkflowDefinitionStatus.DEPRECATED })]);

    const { data } = await repo.findLineagesForTenant(TENANT, { page: 1, limit: 10 });

    expect(data[0].active).toBeNull();
    expect(data[0].draft).toBeNull();
  });

  it('paginates LINEAGES, not version rows, and narrows by palette', async () => {
    const rows = ['alpha', 'beta', 'gamma'].flatMap((slug) => [
      row({ id: `${slug}-1`, slug, name: slug, versionNumber: 1, status: WorkflowDefinitionStatus.DEPRECATED }),
      row({ id: `${slug}-2`, slug, name: slug, versionNumber: 2, status: WorkflowDefinitionStatus.PUBLISHED, isActive: true }),
    ]);
    const { repo, delegate } = makeRepo(rows);

    const first = await repo.findLineagesForTenant(TENANT, { page: 1, limit: 2, paletteKey: 'core' });

    expect(first.count).toBe(3);
    expect(first.data.map((lineage) => lineage.slug)).toEqual(['alpha', 'beta']);
    expect(delegate.findMany.mock.calls[0][0].where).toMatchObject({ paletteKey: 'core', resourceStatus: ResourceStatusType.ENABLED });
    // The heavy columns stay out of the register read.
    expect(delegate.findMany.mock.calls[0][0].select.graph).toBeUndefined();
    expect(delegate.findMany.mock.calls[0][0].select.compiledConfig).toBeUndefined();

    const second = await repo.findLineagesForTenant(TENANT, { page: 2, limit: 2, paletteKey: 'core' });
    expect(second.data.map((lineage) => lineage.slug)).toEqual(['gamma']);
  });

  it('drops another tenant’s rows', async () => {
    const { repo } = makeRepo([row({ id: 'mine', slug: 'mine', name: 'Mine' }), row({ id: 'theirs', slug: 'theirs', name: 'Theirs', tenantId: OTHER })]);

    const { data, count } = await repo.findLineagesForTenant(TENANT, { page: 1, limit: 10 });

    expect(count).toBe(1);
    expect(data.map((lineage) => lineage.slug)).toEqual(['mine']);
  });
});
