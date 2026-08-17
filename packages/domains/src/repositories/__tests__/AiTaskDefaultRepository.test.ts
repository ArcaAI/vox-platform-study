/**
 * AiTaskDefaultRepository — unit tests.
 *
 * Pinned behaviour of `findByTenantAndTaskKey`:
 *  - a genuine miss (base `findFirst` throws `DataNotFoundException`) → null;
 *  - any OTHER error — most importantly the tenant-scope extension's
 *    `TenantScope: tenantId mismatch` throw — must SURFACE, not be swallowed
 *    into a silent null (that masking made cross-tenant super-admin reads
 *    "succeed" as empty);
 *  - a supplied `tx` client routes the read through `tx.aiTaskDefault`
 *    (unscoped base-client lane), never the cached extended delegate.
 */
import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { DataNotFoundException } from '@arcaai/exceptions';
import { AiTaskDefaultRepository } from '../generated/core/AiTaskDefaultRepository';
import { ResourceStatusType } from '../../enums';

const ROW = {
  id: 'a0000000-0000-0000-0000-000000000001',
  tenantId: 'tenant-abc',
  taskKey: 'nlp.ner',
  modelSlug: 'medical-ner',
  configJson: null,
  version: 1,
  resourceStatus: ResourceStatusType.ENABLED,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  createdBy: null,
  updatedBy: null,
};

function makeRepo() {
  const delegate = { findFirst: vi.fn() };
  const uow = { getDatabaseService: () => ({ aiTaskDefault: delegate }) };
  const repo = new AiTaskDefaultRepository(uow as never);
  return { repo, delegate };
}

describe('AiTaskDefaultRepository.findByTenantAndTaskKey', () => {
  it('returns the mapped entity when a row matches', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findFirst.mockResolvedValue(ROW);

    const entity = await repo.findByTenantAndTaskKey('tenant-abc', 'nlp.ner');

    expect(entity?.modelSlug).toBe('medical-ner');
    expect(delegate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-abc', taskKey: 'nlp.ner', resourceStatus: ResourceStatusType.ENABLED }),
      }),
    );
  });

  it('returns null on a genuine miss (DataNotFoundException from the base finder)', async () => {
    const { repo, delegate } = makeRepo();
    // Base Repository.findFirst throws DataNotFoundException on a null model.
    delegate.findFirst.mockResolvedValue(null);

    await expect(repo.findByTenantAndTaskKey('tenant-abc', 'nlp.ner')).resolves.toBeNull();
  });

  it('SURFACES a tenant-scope violation instead of swallowing it into null', async () => {
    const { repo, delegate } = makeRepo();
    const violation = new Error(
      'TenantScope: tenantId mismatch on AiTaskDefault.findFirst — caller passed "00000000-0000-0000-0000-000000000000" but context is "tenant-w"',
    );
    delegate.findFirst.mockRejectedValue(violation);

    await expect(repo.findByTenantAndTaskKey('00000000-0000-0000-0000-000000000000', 'nlp.ner')).rejects.toBe(violation);
  });

  it('still maps DataNotFoundException thrown directly to null', async () => {
    const { repo, delegate } = makeRepo();
    delegate.findFirst.mockRejectedValue(new DataNotFoundException('aiTaskDefault', 'x'));

    await expect(repo.findByTenantAndTaskKey('tenant-abc', 'nlp.ner')).resolves.toBeNull();
  });

  it('routes the read through a supplied tx client (base-client lane), not the extended delegate', async () => {
    const { repo, delegate } = makeRepo();
    const tx = { aiTaskDefault: { findFirst: vi.fn().mockResolvedValue(ROW) } };

    const entity = await repo.findByTenantAndTaskKey('tenant-abc', 'nlp.ner', tx);

    expect(entity?.taskKey).toBe('nlp.ner');
    expect(tx.aiTaskDefault.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-abc', taskKey: 'nlp.ner', resourceStatus: ResourceStatusType.ENABLED },
    });
    expect(delegate.findFirst).not.toHaveBeenCalled();
  });
});
