/**
 * TASK-965 WS-2 — `AgentRepository.findLineagesForTenant`.
 *
 * The defect this closes (AG-13/AG-14, OD-965-3): `Agent` rows ARE versions, so every list read
 * answers one row per VERSION and the console renders one grid row per version. A lineage is the
 * unit an admin manages — "Realtime transcription, v2 active, v3 in draft, 3 versions" — and it
 * cannot be assembled client-side because the page boundary can split a slug across pages.
 *
 * What is pinned here is the GROUPING and the PAGINATION UNIT, because those are the two things
 * a client-side implementation gets wrong: the count is a count of LINEAGES, and the slice is a
 * slice of LINEAGES, never of rows.
 */
import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { AgentRepository } from '../generated/core/AgentRepository';
import { AgentTask, ResourceStatusType, WorkflowDefinitionStatus } from '../../enums';

const TENANT = '50000000-0000-0000-0000-000000000000';
const OTHER = '50000000-0000-0000-0000-000000000009';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    tenantId: TENANT,
    slug: 'realtime-transcription',
    name: 'Realtime transcription',
    description: null,
    task: AgentTask.SPEECH_TO_TEXT,
    versionNumber: 1,
    status: WorkflowDefinitionStatus.DRAFT,
    isActive: false,
    modelId: 'model-asr',
    compiledConfigChecksum: null,
    publishedAt: null,
    deprecatedAt: null,
    sourceTenantId: null,
    sourceSlug: null,
    sourceVersionNumber: null,
    tags: [],
    resourceStatus: ResourceStatusType.ENABLED,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    updatedBy: null,
    ...overrides,
  };
}

function makeRepo(rows: ReturnType<typeof row>[]) {
  const delegate = { findMany: vi.fn().mockResolvedValue(rows) };
  const uow = { getDatabaseService: () => ({ agent: delegate }) };
  return { repo: new AgentRepository(uow as never), delegate };
}

describe('AgentRepository.findLineagesForTenant', () => {
  it('folds v1 DEPRECATED + v2 PUBLISHED/active + v3 DRAFT into ONE lineage with the right pointers and counts', async () => {
    const { repo } = makeRepo([
      row({
        id: 'a-v3',
        versionNumber: 3,
        status: WorkflowDefinitionStatus.DRAFT,
        name: 'Realtime transcription (draft)',
        updatedAt: new Date('2026-03-01T00:00:00Z'),
      }),
      row({
        id: 'a-v2',
        versionNumber: 2,
        status: WorkflowDefinitionStatus.PUBLISHED,
        isActive: true,
        publishedAt: new Date('2026-02-01T00:00:00Z'),
        updatedBy: 'user-publisher',
        compiledConfigChecksum: 'sha256:abc',
        updatedAt: new Date('2026-02-01T00:00:00Z'),
      }),
      row({ id: 'a-v1', versionNumber: 1, status: WorkflowDefinitionStatus.DEPRECATED, deprecatedAt: new Date('2026-02-01T00:00:00Z') }),
    ]);

    const { data, count } = await repo.findLineagesForTenant(TENANT, { page: 1, limit: 10 });

    expect(count).toBe(1);
    expect(data).toHaveLength(1);
    const lineage = data[0];
    expect(lineage.slug).toBe('realtime-transcription');
    // The ACTIVE row names the lineage — that is the version the tenant is serving.
    expect(lineage.name).toBe('Realtime transcription');
    expect(lineage.versionCount).toBe(3);
    expect(lineage.latestVersionNumber).toBe(3);
    expect(lineage.deprecatedCount).toBe(1);
    expect(lineage.active).toMatchObject({ id: 'a-v2', versionNumber: 2, publishedBy: 'user-publisher', compiledConfigChecksum: 'sha256:abc' });
    expect(lineage.draft).toMatchObject({ id: 'a-v3', versionNumber: 3, status: WorkflowDefinitionStatus.DRAFT });
    // The lineage's `updatedAt` is the NEWEST touch anywhere in it, not the active row's.
    expect(lineage.updatedAt).toEqual(new Date('2026-03-01T00:00:00Z'));
  });

  it('answers `active: null` for a lineage with no active row, and names it after its newest version', async () => {
    const { repo } = makeRepo([
      row({ id: 'b-v1', slug: 'triage', name: 'Triage v1', versionNumber: 1, status: WorkflowDefinitionStatus.DEPRECATED }),
      row({ id: 'b-v2', slug: 'triage', name: 'Triage renamed', versionNumber: 2, status: WorkflowDefinitionStatus.VALIDATED }),
    ]);

    const { data } = await repo.findLineagesForTenant(TENANT, { page: 1, limit: 10 });

    expect(data[0].active).toBeNull();
    expect(data[0].name).toBe('Triage renamed');
    // VALIDATED is an open draft: it is still editable and it is what "continue" continues.
    expect(data[0].draft).toMatchObject({ id: 'b-v2', status: WorkflowDefinitionStatus.VALIDATED });
  });

  it('paginates LINEAGES, not version rows', async () => {
    const rows = ['alpha', 'beta', 'gamma'].flatMap((slug) => [
      row({ id: `${slug}-1`, slug, name: slug, versionNumber: 1, status: WorkflowDefinitionStatus.DEPRECATED }),
      row({ id: `${slug}-2`, slug, name: slug, versionNumber: 2, status: WorkflowDefinitionStatus.PUBLISHED, isActive: true }),
    ]);
    const { repo } = makeRepo(rows);

    const first = await repo.findLineagesForTenant(TENANT, { page: 1, limit: 2 });
    expect(first.count).toBe(3);
    expect(first.data.map((lineage) => lineage.slug)).toEqual(['alpha', 'beta']);

    const second = await repo.findLineagesForTenant(TENANT, { page: 2, limit: 2 });
    expect(second.count).toBe(3);
    expect(second.data.map((lineage) => lineage.slug)).toEqual(['gamma']);
  });

  it('drops another tenant’s rows even when the extension did not filter (no CLS tenant)', async () => {
    const { repo } = makeRepo([
      row({ id: 'mine', slug: 'mine', name: 'Mine' }),
      row({ id: 'theirs', slug: 'theirs', name: 'Theirs', tenantId: OTHER }),
    ]);

    const { data, count } = await repo.findLineagesForTenant(TENANT, { page: 1, limit: 10 });

    expect(count).toBe(1);
    expect(data.map((lineage) => lineage.slug)).toEqual(['mine']);
  });

  it('narrows the population by task and to live rows, and never asks for the heavy JSON columns', async () => {
    const { repo, delegate } = makeRepo([]);

    await repo.findLineagesForTenant(TENANT, { page: 1, limit: 10, task: AgentTask.TEXT_GENERATION });

    const args = delegate.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ task: AgentTask.TEXT_GENERATION, resourceStatus: ResourceStatusType.ENABLED });
    expect(args.select).toBeDefined();
    for (const heavy of ['graph', 'instruction', 'compiledConfig', 'validationReport']) {
      expect(args.select[heavy]).toBeUndefined();
    }
  });
});
