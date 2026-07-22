import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';
import { TenantIdentityProviderRepository } from '../TenantIdentityProviderRepository';
import { IdpProtocol, IdpStatus, ResourceStatusType } from '../../../../enums';

function makeRepo(): TenantIdentityProviderRepository {
  // The base Repository constructor only calls `getDatabaseService()`; every
  // query path under test is intercepted via a `findAll`/`findFirst` spy, so a
  // bare stub is enough to construct the repository without a real database.
  const unitOfWork = { getDatabaseService: () => ({}) } as unknown as never;
  return new TenantIdentityProviderRepository(unitOfWork);
}

describe('TenantIdentityProviderRepository.findByTenantId', () => {
  it('pushes tenantId + resourceStatus into a single findAll query', async () => {
    const repo = makeRepo();
    const findAllSpy = vi.spyOn(repo, 'findAll').mockResolvedValue([] as never);

    await repo.findByTenantId('tenant-1');

    expect(findAllSpy).toHaveBeenCalledTimes(1);
    const props = findAllSpy.mock.calls[0][0] as { filters?: Record<string, unknown> };
    expect(props.filters).toEqual({ tenantId: 'tenant-1', resourceStatus: ResourceStatusType.ENABLED });
  });
});

describe('TenantIdentityProviderRepository.findEnabledByTenantAndProtocol', () => {
  it('pushes tenantId + protocol + ENABLED providerStatus into a single findFirst query', async () => {
    const repo = makeRepo();
    const findFirstSpy = vi.spyOn(repo, 'findFirst').mockResolvedValue(null as never);

    await repo.findEnabledByTenantAndProtocol('tenant-1', IdpProtocol.OIDC);

    expect(findFirstSpy).toHaveBeenCalledTimes(1);
    const props = findFirstSpy.mock.calls[0][0] as { filters?: Record<string, unknown> };
    expect(props.filters).toEqual({
      tenantId: 'tenant-1',
      protocol: IdpProtocol.OIDC,
      providerStatus: IdpStatus.ENABLED,
      resourceStatus: ResourceStatusType.ENABLED,
    });
  });

  it('returns null instead of throwing when no row matches', async () => {
    const repo = makeRepo();
    vi.spyOn(repo, 'findFirst').mockRejectedValue(new Error('not found'));

    await expect(repo.findEnabledByTenantAndProtocol('tenant-1', IdpProtocol.OIDC)).resolves.toBeNull();
  });
});
