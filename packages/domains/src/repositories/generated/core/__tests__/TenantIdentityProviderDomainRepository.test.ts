import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';
import { TenantIdentityProviderDomainRepository } from '../TenantIdentityProviderDomainRepository';
import { ResourceStatusType } from '../../../../enums';

function makeRepo(): TenantIdentityProviderDomainRepository {
  const unitOfWork = { getDatabaseService: () => ({}) } as unknown as never;
  return new TenantIdentityProviderDomainRepository(unitOfWork);
}

describe('TenantIdentityProviderDomainRepository.findByDomain (HRD)', () => {
  it('pushes domain into a single findFirst query', async () => {
    const repo = makeRepo();
    const findFirstSpy = vi.spyOn(repo, 'findFirst').mockResolvedValue(null as never);

    await repo.findByDomain('acme.com');

    expect(findFirstSpy).toHaveBeenCalledTimes(1);
    const props = findFirstSpy.mock.calls[0][0] as { filters?: Record<string, unknown> };
    expect(props.filters).toEqual({ domain: 'acme.com', resourceStatus: ResourceStatusType.ENABLED });
  });

  it('returns null instead of throwing when the domain is unmapped', async () => {
    const repo = makeRepo();
    vi.spyOn(repo, 'findFirst').mockRejectedValue(new Error('not found'));

    await expect(repo.findByDomain('unknown.com')).resolves.toBeNull();
  });
});
