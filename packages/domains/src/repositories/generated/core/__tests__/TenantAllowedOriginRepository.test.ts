/**
 * TenantAllowedOriginRepository — repository shape (TASK-610 §4B).
 *
 * `findByOriginAndTenant` is scoped to the (origin, tenantId) PAIR —
 * uniqueness moved from a global `origin` index to the composite
 * `TenantAllowedOrigin_origin_tenantId_unique` index, so a row is a grant for
 * ONE tenant, not a claim on the origin as a whole. Several tenants may hold
 * a grant on the same origin simultaneously; this lookup only answers
 * whether THIS tenant already holds one. ENABLED-only, tolerates a miss as
 * `null`, and routes through a supplied transaction client when given.
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

describe('TenantAllowedOriginRepository — findByOriginAndTenant', () => {
  let findFirst: ReturnType<typeof vi.fn>;
  let repo: TenantAllowedOriginRepository;

  beforeEach(() => {
    findFirst = vi.fn();
    const delegate = { findFirst };
    const unitOfWork = { getDatabaseService: () => ({ tenantAllowedOrigin: delegate }) };
    repo = new TenantAllowedOriginRepository(unitOfWork as never);
  });

  it('filters by exact origin AND tenantId, ENABLED only', async () => {
    findFirst.mockResolvedValue(row);

    const entity = await repo.findByOriginAndTenant('https://arcaai-u2204.bcmch.org', 'tenant-1');

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          origin: 'https://arcaai-u2204.bcmch.org',
          tenantId: 'tenant-1',
          resourceStatus: ResourceStatusType.ENABLED,
        }),
      }),
    );
    expect(entity?.label).toBe('BCMCH production');
  });

  it('returns null when no row matches the (origin, tenantId) pair', async () => {
    findFirst.mockResolvedValue(null);
    await expect(repo.findByOriginAndTenant('https://unregistered.example.com', 'tenant-1')).resolves.toBeNull();
  });

  it('is scoped per tenant — the same origin held by a DIFFERENT tenant is not a match', async () => {
    // The delegate is trusted to apply the `where` filter; this test asserts
    // the repository ASKS for tenant-scoping, not that the mock enforces it.
    findFirst.mockResolvedValue(null);

    await repo.findByOriginAndTenant('https://arcaai-u2204.bcmch.org', 'tenant-2');

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-2' }),
      }),
    );
  });

  it('routes the read through a supplied transaction client', async () => {
    const txFindFirst = vi.fn().mockResolvedValue(row);
    const tx = { tenantAllowedOrigin: { findFirst: txFindFirst } };

    const entity = await repo.findByOriginAndTenant('https://arcaai-u2204.bcmch.org', 'tenant-1', tx as any);

    expect(txFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          origin: 'https://arcaai-u2204.bcmch.org',
          tenantId: 'tenant-1',
        }),
      }),
    );
    expect(findFirst).not.toHaveBeenCalled();
    expect(entity?.id).toBe('tao-1');
  });
});
