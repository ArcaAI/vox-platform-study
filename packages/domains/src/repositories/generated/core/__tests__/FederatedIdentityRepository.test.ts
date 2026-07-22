import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';
import { FederatedIdentityRepository } from '../FederatedIdentityRepository';
import { ResourceStatusType } from '../../../../enums';

function makeRepo(): FederatedIdentityRepository {
  const unitOfWork = { getDatabaseService: () => ({}) } as unknown as never;
  return new FederatedIdentityRepository(unitOfWork);
}

describe('FederatedIdentityRepository.findByProviderAndSubject', () => {
  it('pushes providerId + subject into a single findFirst query', async () => {
    const repo = makeRepo();
    const findFirstSpy = vi.spyOn(repo, 'findFirst').mockResolvedValue(null as never);

    await repo.findByProviderAndSubject('provider-1', 'auth0|abc123');

    expect(findFirstSpy).toHaveBeenCalledTimes(1);
    const props = findFirstSpy.mock.calls[0][0] as { filters?: Record<string, unknown> };
    expect(props.filters).toEqual({
      providerId: 'provider-1',
      subject: 'auth0|abc123',
      resourceStatus: ResourceStatusType.ENABLED,
    });
  });

  it('returns null instead of throwing when no row matches (unprovisioned subject)', async () => {
    const repo = makeRepo();
    vi.spyOn(repo, 'findFirst').mockRejectedValue(new Error('not found'));

    await expect(repo.findByProviderAndSubject('provider-1', 'auth0|abc123')).resolves.toBeNull();
  });
});

describe('FederatedIdentityRepository.findByUserId', () => {
  it('pushes userId into a single findAll query', async () => {
    const repo = makeRepo();
    const findAllSpy = vi.spyOn(repo, 'findAll').mockResolvedValue([] as never);

    await repo.findByUserId('user-1');

    expect(findAllSpy).toHaveBeenCalledTimes(1);
    const props = findAllSpy.mock.calls[0][0] as { filters?: Record<string, unknown> };
    expect(props.filters).toEqual({ userId: 'user-1', resourceStatus: ResourceStatusType.ENABLED });
  });
});
