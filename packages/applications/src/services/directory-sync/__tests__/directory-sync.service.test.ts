import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IdpProtocol, IdpStatus, TenantIdentityProviderFactory } from '@arcaai/domains';
import { DirectorySyncService } from '../directory-sync.service';

const TENANT = 'tenant-abc';
const OTHER_TENANT = 'tenant-xyz';

function makeProvider(overrides: Record<string, unknown> = {}) {
  return TenantIdentityProviderFactory.CreateTenantIdentityProvider({
    tenantId: TENANT,
    protocol: IdpProtocol.OIDC,
    displayName: 'Acme Okta',
    providerStatus: IdpStatus.ENABLED,
    config: {
      issuer: 'https://acme.okta.com',
      clientId: 'client-abc',
      defaultRoleId: 'role-default',
      defaultDepartmentId: 'dept-default',
      directoryProvider: 'ms-graph',
    },
    encryptedSecretRef: 'vault:v1:c2VjcmV0',
    directoryCredentialsRef: 'vault:v1:ZGlyZWN0b3J5',
    ...overrides,
  });
}

function makeService() {
  const providerRepository = { findById: vi.fn() };
  const queue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };
  const svc = new DirectorySyncService(providerRepository as never, queue as never);
  return { svc, providerRepository, queue };
}

describe('DirectorySyncService.enqueueSync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404s (not 403) when the provider belongs to a different tenant', async () => {
    const { svc, providerRepository } = makeService();
    providerRepository.findById.mockResolvedValue(makeProvider({ tenantId: OTHER_TENANT }));
    await expect(svc.enqueueSync(TENANT, 'provider-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s when the provider does not exist', async () => {
    const { svc, providerRepository } = makeService();
    providerRepository.findById.mockResolvedValue(null);
    await expect(svc.enqueueSync(TENANT, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects when the provider has no directoryProvider configured', async () => {
    const { svc, providerRepository } = makeService();
    providerRepository.findById.mockResolvedValue(
      makeProvider({ config: { issuer: 'x', clientId: 'y', defaultRoleId: 'r', defaultDepartmentId: 'd' } }),
    );
    await expect(svc.enqueueSync(TENANT, 'provider-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when the provider has no directoryCredentialsRef sealed', async () => {
    const { svc, providerRepository } = makeService();
    providerRepository.findById.mockResolvedValue(makeProvider({ directoryCredentialsRef: null }));
    await expect(svc.enqueueSync(TENANT, 'provider-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enqueues a job with a generated jobId and returns it', async () => {
    const { svc, providerRepository, queue } = makeService();
    const provider = makeProvider();
    providerRepository.findById.mockResolvedValue(provider);

    const res = await svc.enqueueSync(TENANT, provider.id);

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [, payload, opts] = queue.add.mock.calls[0];
    expect(payload).toMatchObject({ tenantId: TENANT, providerId: provider.id });
    expect(opts.jobId).toBe(res.jobId);
    expect(res.jobId).toEqual(expect.any(String));
  });
});
