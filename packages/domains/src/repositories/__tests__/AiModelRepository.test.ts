/**
 * AiModelRepository (TASK-506 r2605 Findings A + E) — unit tests.
 *
 *  - Finding A: `findBySlug` accepts an optional `tx` client so the
 *    cross-tenant base-client lane in `AiTaskDefaultService` can resolve
 *    slugs without the tenant-scope extension rewriting the filter.
 *  - Finding E: `findByTaskTypeSharedRead` queries WITHOUT any tenantId
 *    filter so the tenant-scope extension's SYSTEM-shared-read widening
 *    (`tenantId IN [caller, SYSTEM]`) actually fires; passing an explicit
 *    `{ in: [...] }` ourselves would trip the extension's strict-equality
 *    guard, and pinning the caller tenant (legacy `findByTaskType`) blinds
 *    tenants without clones to the SYSTEM catalog.
 */
import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { AiModelRepository } from '../generated/core/AiModelRepository';
import { ModelTaskType, ResourceStatusType } from '../../enums';

const ROW = {
  id: 'b0000000-0000-0000-0000-000000000001',
  tenantId: '00000000-0000-0000-0000-000000000000',
  name: 'Medical NER',
  slug: 'medical-ner',
  category: 'NLP',
  taskType: ModelTaskType.TOKEN_CLASSIFICATION,
  modelType: 'BASE_MODEL',
  source: 'HUGGINGFACE',
  sourceUri: 'blaze999/Medical-NER',
  format: 'SAFETENSOR',
  provider: 'built-in',
  architecture: null,
  tags: [],
  version: 1,
  resourceStatus: ResourceStatusType.ENABLED,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  createdBy: null,
  updatedBy: null,
};

function makeRepo() {
  const delegate = { findFirst: vi.fn(), findMany: vi.fn() };
  const uow = { getDatabaseService: () => ({ aiModel: delegate }) };
  const repo = new AiModelRepository(uow as never);
  return { repo, delegate };
}

describe('AiModelRepository.findBySlug — optional tx client (r2605 Finding A)', () => {
  it('routes the read through a supplied tx client, not the extended delegate', async () => {
    const { repo, delegate } = makeRepo();
    const tx = { aiModel: { findFirst: vi.fn().mockResolvedValue(ROW) } };

    const entity = await repo.findBySlug('00000000-0000-0000-0000-000000000000', 'medical-ner', tx);

    expect(entity?.slug).toBe('medical-ner');
    expect(tx.aiModel.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: '00000000-0000-0000-0000-000000000000',
        slug: 'medical-ner',
        resourceStatus: ResourceStatusType.ENABLED,
      },
    });
    expect(delegate.findFirst).not.toHaveBeenCalled();
  });

  it('tx path returns null on a miss', async () => {
    const { repo } = makeRepo();
    const tx = { aiModel: { findFirst: vi.fn().mockResolvedValue(null) } };

    await expect(repo.findBySlug('t1', 'ghost', tx)).resolves.toBeNull();
  });

  it('without tx the cached extended delegate is used (behaviour unchanged)', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findFirst.mockResolvedValue(ROW);

    const entity = await repo.findBySlug('00000000-0000-0000-0000-000000000000', 'medical-ner');

    expect(entity?.slug).toBe('medical-ner');
    expect(delegate.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('AiModelRepository.findByTaskTypeSharedRead (r2605 Finding E)', () => {
  it('queries WITHOUT a tenantId filter so the extension can widen reads to [caller, SYSTEM]', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findMany.mockResolvedValue([ROW]);

    const rows = await repo.findByTaskTypeSharedRead(ModelTaskType.TOKEN_CLASSIFICATION);

    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('medical-ner');
    expect(delegate.findMany).toHaveBeenCalledTimes(1);
    const args = delegate.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ taskType: ModelTaskType.TOKEN_CLASSIFICATION, resourceStatus: ResourceStatusType.ENABLED });
    expect('tenantId' in args.where).toBe(false);
  });

  it('routes through a supplied tx client when provided', async () => {
    const { repo, delegate } = makeRepo();
    const tx = { aiModel: { findMany: vi.fn().mockResolvedValue([ROW]) } };

    const rows = await repo.findByTaskTypeSharedRead(ModelTaskType.TOKEN_CLASSIFICATION, tx);

    expect(rows).toHaveLength(1);
    expect(tx.aiModel.findMany).toHaveBeenCalledTimes(1);
    expect(delegate.findMany).not.toHaveBeenCalled();
  });
});
