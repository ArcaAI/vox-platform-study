/**
 * AiTaskDefaultRepository — repository shape (TASK-506 Phase 3).
 *
 * One row per (tenant, taskKey); the SYSTEM tenant row is the platform
 * default. `findByTenantAndTaskKey` pins the read to an EXACT tenant (the
 * effective cascade is resolved in the application service), filters
 * ENABLED-only, tolerates a miss as `null`, and routes through a supplied
 * transaction client when given (mirrors the `updateWithVersion(..., tx)`
 * contract).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiTaskDefaultRepository } from '../AiTaskDefaultRepository';
import { ResourceStatusType } from '../../../../enums';

const row = {
  id: 'atd-1',
  tenantId: 'tenant-1',
  taskKey: 'nlp.ner',
  modelSlug: 'medical-ner',
  configJson: null,
  resourceStatus: ResourceStatusType.ENABLED,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: null,
  updatedBy: null,
  resourceStatusUpdatedAt: null,
  resourceStatusUpdatedBy: null,
  metaData: null,
};

describe('AiTaskDefaultRepository — findByTenantAndTaskKey (TASK-506)', () => {
  let findFirst: ReturnType<typeof vi.fn>;
  let repo: AiTaskDefaultRepository;

  beforeEach(() => {
    findFirst = vi.fn();
    const delegate = { findFirst };
    const unitOfWork = { getDatabaseService: () => ({ aiTaskDefault: delegate }) };
    repo = new AiTaskDefaultRepository(unitOfWork as never);
  });

  it('filters by exact tenant + taskKey, ENABLED only', async () => {
    findFirst.mockResolvedValue(row);

    const entity = await repo.findByTenantAndTaskKey('tenant-1', 'nlp.ner');

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          taskKey: 'nlp.ner',
          resourceStatus: ResourceStatusType.ENABLED,
        }),
      }),
    );
    expect(entity?.modelSlug).toBe('medical-ner');
    expect(entity?.taskKey).toBe('nlp.ner');
  });

  it('returns null when the (tenant, taskKey) row does not exist', async () => {
    findFirst.mockResolvedValue(null);
    await expect(repo.findByTenantAndTaskKey('tenant-1', 'guardrail.validate')).resolves.toBeNull();
  });

  it('routes the read through a supplied transaction client', async () => {
    const txFindFirst = vi.fn().mockResolvedValue(row);
    const tx = { aiTaskDefault: { findFirst: txFindFirst } };

    const entity = await repo.findByTenantAndTaskKey('tenant-1', 'nlp.ner', tx as any);

    expect(txFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-1', taskKey: 'nlp.ner' }),
      }),
    );
    expect(findFirst).not.toHaveBeenCalled();
    expect(entity?.id).toBe('atd-1');
  });
});
