/**
 * TenantAllowedOriginRepository — repository shape (TASK-610).
 *
 * `findByOrigin` is a GLOBAL lookup (no tenantId) — `origin` is uniquely
 * indexed across all tenants (`TenantAllowedOrigin_origin_unique`), so the
 * (tenant, origin) pairing the other config repositories key on does not
 * apply here. ENABLED-only, tolerates a miss as `null`, and routes through a
 * supplied transaction client when given.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantAllowedOriginRepository } from '../TenantAllowedOriginRepository';
import { ResourceStatusType } from '../../../../enums';

const row = {
  id: 'tao-1',
  tenantId: 'tenant-1',
  origin: 'https://arcaai-u2204.bcmch.org',
  label: 'BCMCH production',
  description: null,
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

describe('TenantAllowedOriginRepository — findByOrigin', () => {
  let findFirst: ReturnType<typeof vi.fn>;
  let repo: TenantAllowedOriginRepository;

  beforeEach(() => {
    findFirst = vi.fn();
    const delegate = { findFirst };
    const unitOfWork = { getDatabaseService: () => ({ tenantAllowedOrigin: delegate }) };
    repo = new TenantAllowedOriginRepository(unitOfWork as never);
  });

  it('filters by exact origin, ENABLED only, with no tenant scoping', async () => {
    findFirst.mockResolvedValue(row);

    const entity = await repo.findByOrigin('https://arcaai-u2204.bcmch.org');

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          origin: 'https://arcaai-u2204.bcmch.org',
          resourceStatus: ResourceStatusType.ENABLED,
        }),
      }),
    );
    expect((findFirst.mock.calls[0][0].where as Record<string, unknown>).tenantId).toBeUndefined();
    expect(entity?.label).toBe('BCMCH production');
  });

  it('returns null when no row matches the origin', async () => {
    findFirst.mockResolvedValue(null);
    await expect(repo.findByOrigin('https://unregistered.example.com')).resolves.toBeNull();
  });

  it('routes the read through a supplied transaction client', async () => {
    const txFindFirst = vi.fn().mockResolvedValue(row);
    const tx = { tenantAllowedOrigin: { findFirst: txFindFirst } };

    const entity = await repo.findByOrigin('https://arcaai-u2204.bcmch.org', tx as any);

    expect(txFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ origin: 'https://arcaai-u2204.bcmch.org' }),
      }),
    );
    expect(findFirst).not.toHaveBeenCalled();
    expect(entity?.id).toBe('tao-1');
  });
});
