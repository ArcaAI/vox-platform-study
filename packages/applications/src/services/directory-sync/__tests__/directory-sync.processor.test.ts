import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdpProtocol, IdpStatus, TenantIdentityProviderFactory } from '@arcaai/domains';
import { DirectorySyncProcessor } from '../directory-sync.processor';

const TENANT = 'tenant-abc';

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
    directoryCredentialsRef: 'vault:v1:ZGlyZWN0b3J5',
    ...overrides,
  });
}

function makeJob(data: Record<string, unknown>) {
  return { id: 'bull-job-1', data, updateProgress: vi.fn() } as never;
}

function makeProcessor() {
  const providerRepository = { findById: vi.fn() };
  const federatedIdentityRepository = { findByProviderAndSubject: vi.fn().mockResolvedValue(null) };
  const msGraphProvider = { key: 'ms-graph', fetchUsers: vi.fn() };
  const googleProvider = { key: 'google-directory', fetchUsers: vi.fn() };
  const federatedAuthService = { resolveOrProvisionUser: vi.fn().mockResolvedValue({ id: 'user-1' }) };
  const cls = {
    run: vi.fn((fn: () => unknown) => fn()),
    set: vi.fn(),
  };
  const secretsService = { decrypt: vi.fn(async () => Buffer.from(JSON.stringify({ azureTenantId: 't', clientId: 'c', clientSecret: 's' }))) };
  const databaseService = { baseClient: { userRoleAssignment: { findMany: vi.fn().mockResolvedValue([]) } } };
  const entitlements = { isEnforcementEnabled: vi.fn(() => false), assertQuantityQuota: vi.fn() };
  // TASK-870 item 12 — ENABLED, because these cases are about the paging/provisioning
  // loop rather than availability. The gate is covered in
  // `directory-sync.feature-gate.task870.test.ts`.
  const effectiveSettings = { resolveEffective: vi.fn().mockResolvedValue({ value: true, sourceScope: 'global-kv' }) };

  const processor = new DirectorySyncProcessor(
    providerRepository as never,
    federatedIdentityRepository as never,
    msGraphProvider as never,
    googleProvider as never,
    federatedAuthService as never,
    cls as never,
    secretsService as never,
    databaseService as never,
    entitlements as never,
    effectiveSettings as never,
  );

  return { processor, providerRepository, federatedIdentityRepository, msGraphProvider, googleProvider, federatedAuthService, cls, entitlements, effectiveSettings };
}

describe('DirectorySyncProcessor.process', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws when the job payload is missing tenantId', async () => {
    const { processor } = makeProcessor();
    await expect(processor.process(makeJob({ providerId: 'p1' }))).rejects.toThrow(/tenantId/);
  });

  it('rebinds CLS tenant + a worker session before touching tenant-scoped repositories', async () => {
    const { processor, providerRepository, msGraphProvider, cls } = makeProcessor();
    const provider = makeProvider();
    providerRepository.findById.mockResolvedValue(provider);
    msGraphProvider.fetchUsers.mockResolvedValue({ users: [] });

    await processor.process(makeJob({ tenantId: TENANT, providerId: provider.id }));

    expect(cls.run).toHaveBeenCalledOnce();
    expect(cls.set).toHaveBeenCalledWith('tenantId', TENANT);
  });

  it('pages through fetchUsers until nextPageToken is undefined, provisioning each user', async () => {
    const { processor, providerRepository, msGraphProvider, federatedAuthService } = makeProcessor();
    const provider = makeProvider();
    providerRepository.findById.mockResolvedValue(provider);
    msGraphProvider.fetchUsers
      .mockResolvedValueOnce({ users: [{ externalId: 'u1', email: 'a@acme.com', groups: [] }], nextPageToken: 'page-2' })
      .mockResolvedValueOnce({ users: [{ externalId: 'u2', email: 'b@acme.com', groups: [] }] });

    const result = await processor.process(makeJob({ tenantId: TENANT, providerId: provider.id }));

    expect(msGraphProvider.fetchUsers).toHaveBeenCalledTimes(2);
    expect(msGraphProvider.fetchUsers).toHaveBeenNthCalledWith(2, expect.anything(), 'page-2');
    expect(federatedAuthService.resolveOrProvisionUser).toHaveBeenCalledTimes(2);
    expect(result.processed).toBe(2);
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it('passes the directory user groups through as synthesized claims for group→role mapping', async () => {
    const { processor, providerRepository, msGraphProvider, federatedAuthService } = makeProcessor();
    const provider = makeProvider();
    providerRepository.findById.mockResolvedValue(provider);
    msGraphProvider.fetchUsers.mockResolvedValue({ users: [{ externalId: 'u1', email: 'a@acme.com', groups: ['acme-clinicians'] }] });

    await processor.process(makeJob({ tenantId: TENANT, providerId: provider.id }));

    expect(federatedAuthService.resolveOrProvisionUser).toHaveBeenCalledWith(
      'u1',
      provider,
      expect.objectContaining({ sub: 'u1', email: 'a@acme.com', groups: ['acme-clinicians'] }),
    );
  });

  it('does not count an already-linked user toward "created"', async () => {
    const { processor, providerRepository, msGraphProvider, federatedIdentityRepository } = makeProcessor();
    const provider = makeProvider();
    providerRepository.findById.mockResolvedValue(provider);
    msGraphProvider.fetchUsers.mockResolvedValue({ users: [{ externalId: 'u1', email: 'a@acme.com', groups: [] }] });
    federatedIdentityRepository.findByProviderAndSubject.mockResolvedValue({ id: 'link-1', userId: 'user-1' });

    const result = await processor.process(makeJob({ tenantId: TENANT, providerId: provider.id }));

    expect(result.processed).toBe(1);
    expect(result.created).toBe(0);
  });

  it('skips a user whose seat quota is exceeded, continues the batch, and records the reason', async () => {
    const { processor, providerRepository, msGraphProvider, federatedAuthService, entitlements } = makeProcessor();
    const provider = makeProvider();
    providerRepository.findById.mockResolvedValue(provider);
    msGraphProvider.fetchUsers.mockResolvedValue({
      users: [
        { externalId: 'u1', email: 'a@acme.com', groups: [] },
        { externalId: 'u2', email: 'b@acme.com', groups: [] },
      ],
    });
    entitlements.isEnforcementEnabled.mockReturnValue(true);
    entitlements.assertQuantityQuota.mockRejectedValueOnce(new Error('Quota exceeded for maxUsers')).mockResolvedValueOnce(undefined);

    const result = await processor.process(makeJob({ tenantId: TENANT, providerId: provider.id }));

    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.created).toBe(1);
    expect(result.skippedReasons[0]).toMatchObject({ externalId: 'u1', reason: expect.stringContaining('Quota exceeded') });
    // The batch continues past the skipped user — u2 still gets provisioned.
    expect(federatedAuthService.resolveOrProvisionUser).toHaveBeenCalledWith('u2', provider, expect.anything());
  });

  it('throws when the provider is not found', async () => {
    const { processor, providerRepository } = makeProcessor();
    providerRepository.findById.mockResolvedValue(null);
    await expect(processor.process(makeJob({ tenantId: TENANT, providerId: 'missing' }))).rejects.toThrow();
  });

  it('throws when the provider belongs to a different tenant (defense-in-depth against a stale payload)', async () => {
    const { processor, providerRepository } = makeProcessor();
    providerRepository.findById.mockResolvedValue(makeProvider({ tenantId: 'other-tenant' }));
    await expect(processor.process(makeJob({ tenantId: TENANT, providerId: 'provider-1' }))).rejects.toThrow();
  });

  it('dispatches to the Google Directory provider when config.directoryProvider is google-directory', async () => {
    const { processor, providerRepository, googleProvider, msGraphProvider } = makeProcessor();
    const provider = makeProvider({
      config: {
        issuer: 'https://accounts.google.com',
        clientId: 'x',
        defaultRoleId: 'role-default',
        defaultDepartmentId: 'dept-default',
        directoryProvider: 'google-directory',
      },
    });
    providerRepository.findById.mockResolvedValue(provider);
    googleProvider.fetchUsers.mockResolvedValue({ users: [] });

    await processor.process(makeJob({ tenantId: TENANT, providerId: provider.id }));

    expect(googleProvider.fetchUsers).toHaveBeenCalledOnce();
    expect(msGraphProvider.fetchUsers).not.toHaveBeenCalled();
  });
});
