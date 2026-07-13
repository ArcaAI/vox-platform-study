import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { IdpProtocol, IdpStatus, SysEventType, TenantIdentityProviderFactory } from '@arcaai/domains';
import { TenantIdpConfigService } from '../tenant-idp-config.service';

const TENANT = 'tenant-abc';
const OTHER_TENANT = 'tenant-xyz';

const fakeSecrets = () => ({
  encrypt: vi.fn(async (buf: Buffer) => `vault:v1:${buf.toString('base64')}`),
  decrypt: vi.fn(async (ct: string) => Buffer.from(ct.split(':')[2] ?? '', 'base64')),
});

function makeService(opts: { withVault?: boolean } = { withVault: true }) {
  const repo = {
    findByTenantId: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateWithVersion: vi.fn(),
    softDelete: vi.fn(),
  };
  const resolver = {
    buildClient: vi.fn().mockResolvedValue({}),
    buildSamlClient: vi.fn().mockResolvedValue({ generateServiceProviderMetadata: vi.fn().mockReturnValue('<EntityDescriptor/>') }),
    invalidate: vi.fn(),
  };
  const emitter = { emit: vi.fn() };
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'u1' } : k === 'tenantId' ? TENANT : undefined)) };
  const secrets = opts.withVault ? fakeSecrets() : undefined;
  const svc = new TenantIdpConfigService(
    repo as never,
    resolver as never,
    emitter as never,
    cls as never,
    secrets as never,
  );
  return { svc, repo, resolver, emitter, secrets };
}

const validConfig = () => ({
  issuer: 'https://acme.okta.com',
  clientId: 'client-abc',
  defaultRoleId: 'role-1',
  defaultDepartmentId: 'dept-1',
});

const validSamlConfig = () => ({
  idpEntityId: 'https://adfs.acme.com/adfs/services/trust',
  idpSsoUrl: 'https://adfs.acme.com/adfs/ls/',
  idpSigningCert: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
  spEntityId: 'https://api.hope.dev/saml/acme',
  defaultRoleId: 'role-1',
  defaultDepartmentId: 'dept-1',
});

const existingRow = (overrides: Record<string, unknown> = {}) =>
  TenantIdentityProviderFactory.CreateTenantIdentityProvider({
    tenantId: TENANT,
    protocol: IdpProtocol.OIDC,
    displayName: 'Acme Okta',
    config: validConfig(),
    encryptedSecretRef: 'vault:v1:c2VjcmV0',
    ...overrides,
  });

const existingSamlRow = (overrides: Record<string, unknown> = {}) =>
  TenantIdentityProviderFactory.CreateTenantIdentityProvider({
    tenantId: TENANT,
    protocol: IdpProtocol.SAML,
    displayName: 'Acme AD FS',
    config: { ...validSamlConfig(), spCertificatePem: '-----BEGIN CERTIFICATE-----\nSP-CERT\n-----END CERTIFICATE-----' },
    encryptedSecretRef: 'vault:v1:c3Bwcml2YXRla2V5',
    ...overrides,
  });

describe('TenantIdpConfigService.create (TASK-498)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects when Vault is unavailable', async () => {
    const { svc } = makeService({ withVault: false });
    await expect(
      svc.create(TENANT, {
        protocol: IdpProtocol.OIDC,
        displayName: 'Acme Okta',
        config: validConfig(),
        clientSecret: 'super-secret',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('seals the client secret, persists status DRAFT, and never returns the secret', async () => {
    const { svc, repo, secrets } = makeService();
    repo.create.mockImplementation(async (e: unknown) => e);

    const res = await svc.create(TENANT, {
      protocol: IdpProtocol.OIDC,
      displayName: 'Acme Okta',
      config: validConfig(),
      clientSecret: 'super-secret',
    });

    expect(secrets!.encrypt).toHaveBeenCalledOnce();
    expect(JSON.stringify(res)).not.toContain('super-secret');
    expect(res.providerStatus).toBe(IdpStatus.DRAFT);
    expect(res.hasSecret).toBe(true);
    expect(res.tenantId).toBe(TENANT);
  });

  it('broadcasts ResourceCreated', async () => {
    const { svc, repo, emitter } = makeService();
    repo.create.mockImplementation(async (e: unknown) => e);
    await svc.create(TENANT, {
      protocol: IdpProtocol.OIDC,
      displayName: 'Acme Okta',
      config: validConfig(),
      clientSecret: 'super-secret',
    });
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.any(Object));
  });
});

describe('TenantIdpConfigService.getById / list — tenant scoping (404-over-403)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getById returns the row when it belongs to the caller tenant', async () => {
    const { svc, repo } = makeService();
    const row = existingRow();
    repo.findById.mockResolvedValue(row);
    const res = await svc.getById(TENANT, row.id);
    expect(res.id).toBe(row.id);
  });

  it('getById 404s (not 403) when the row belongs to a different tenant', async () => {
    const { svc, repo } = makeService();
    repo.findById.mockResolvedValue(existingRow({ tenantId: OTHER_TENANT }));
    await expect(svc.getById(TENANT, 'some-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getById 404s when the row does not exist', async () => {
    const { svc, repo } = makeService();
    repo.findById.mockResolvedValue(null);
    await expect(svc.getById(TENANT, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list delegates to the tenant-scoped repository read', async () => {
    const { svc, repo } = makeService();
    repo.findByTenantId.mockResolvedValue([existingRow()]);
    const res = await svc.list(TENANT);
    expect(repo.findByTenantId).toHaveBeenCalledWith(TENANT);
    expect(res).toHaveLength(1);
  });
});

describe('TenantIdpConfigService.update (TASK-498)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('compare-and-set updates via updateWithVersion + broadcasts ResourceUpdated', async () => {
    const { svc, repo, emitter } = makeService();
    const row = existingRow();
    repo.findById.mockResolvedValue(row);
    repo.updateWithVersion.mockImplementation(async () => row);

    await svc.update(TENANT, row.id, { displayName: 'Acme Okta (renamed)', expectedVersion: 1 });

    expect(repo.updateWithVersion).toHaveBeenCalledWith(row.id, row, 1);
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.any(Object));
  });

  it('rotates the sealed secret when clientSecret is provided', async () => {
    const { svc, repo, secrets } = makeService();
    const row = existingRow();
    repo.findById.mockResolvedValue(row);
    repo.updateWithVersion.mockImplementation(async () => row);

    await svc.update(TENANT, row.id, { clientSecret: 'new-secret', expectedVersion: 1 });

    expect(secrets!.encrypt).toHaveBeenCalledOnce();
  });

  it('leaves the sealed secret untouched when clientSecret is omitted', async () => {
    const { svc, repo, secrets } = makeService();
    const row = existingRow();
    repo.findById.mockResolvedValue(row);
    repo.updateWithVersion.mockImplementation(async () => row);

    await svc.update(TENANT, row.id, { displayName: 'renamed', expectedVersion: 1 });

    expect(secrets!.encrypt).not.toHaveBeenCalled();
  });

  it('invalidates the resolver cache for the provider (secret/config may have changed)', async () => {
    const { svc, repo, resolver } = makeService();
    const row = existingRow();
    repo.findById.mockResolvedValue(row);
    repo.updateWithVersion.mockImplementation(async () => row);

    await svc.update(TENANT, row.id, { displayName: 'renamed', expectedVersion: 1 });

    expect(resolver.invalidate).toHaveBeenCalledWith(row.id);
  });

  it('404s (not 403) when updating a row in a different tenant', async () => {
    const { svc, repo } = makeService();
    repo.findById.mockResolvedValue(existingRow({ tenantId: OTHER_TENANT }));
    await expect(svc.update(TENANT, 'some-id', { expectedVersion: 1 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('drift on updateWithVersion surfaces as OptimisticConcurrencyException', async () => {
    const { svc, repo } = makeService();
    const row = existingRow();
    repo.findById.mockResolvedValue(row);
    repo.updateWithVersion.mockRejectedValue(new OptimisticConcurrencyException('TenantIdentityProvider', row.id, {}));
    await expect(svc.update(TENANT, row.id, { displayName: 'renamed', expectedVersion: 1 })).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
  });
});

describe('TenantIdpConfigService.setDirectoryCredentials (TASK-498 P3/P4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects when Vault is unavailable', async () => {
    const { svc, repo } = makeService({ withVault: false });
    repo.findById.mockResolvedValue(existingRow());
    await expect(
      svc.setDirectoryCredentials(TENANT, 'provider-1', { credentials: { azureTenantId: 't', clientId: 'c', clientSecret: 's' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('seals the credentials and persists directoryCredentialsRef', async () => {
    const { svc, repo, secrets } = makeService();
    const row = existingRow();
    repo.findById.mockResolvedValue(row);
    repo.update.mockImplementation(async (id: string, e: unknown) => e);

    const res = await svc.setDirectoryCredentials(TENANT, row.id, { credentials: { azureTenantId: 't', clientId: 'c', clientSecret: 's' } });

    expect(secrets!.encrypt).toHaveBeenCalledOnce();
    const [sealedBuffer] = secrets!.encrypt.mock.calls[0];
    expect(JSON.parse(Buffer.from(sealedBuffer).toString('utf8'))).toEqual({ azureTenantId: 't', clientId: 'c', clientSecret: 's' });
    expect(repo.update).toHaveBeenCalledOnce();
    expect(JSON.stringify(res)).not.toContain('"s"'); // never echoes the raw secret back
  });

  it('invalidates the resolver cache (a future resolveByProviderId should not reuse a stale-credential client)', async () => {
    const { svc, repo, resolver } = makeService();
    const row = existingRow();
    repo.findById.mockResolvedValue(row);
    repo.update.mockImplementation(async (id: string, e: unknown) => e);

    await svc.setDirectoryCredentials(TENANT, row.id, { credentials: { azureTenantId: 't', clientId: 'c', clientSecret: 's' } });

    expect(resolver.invalidate).toHaveBeenCalledWith(row.id);
  });

  it('404s (not 403) when setting credentials on a row in a different tenant', async () => {
    const { svc, repo } = makeService();
    repo.findById.mockResolvedValue(existingRow({ tenantId: OTHER_TENANT }));
    await expect(
      svc.setDirectoryCredentials(TENANT, 'some-id', { credentials: { azureTenantId: 't', clientId: 'c', clientSecret: 's' } }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TenantIdpConfigService.remove (TASK-498)', () => {
  it('soft-deletes, broadcasts ResourceDeleted, and invalidates the resolver cache', async () => {
    const { svc, repo, emitter, resolver } = makeService();
    const row = existingRow();
    repo.findById.mockResolvedValue(row);

    await svc.remove(TENANT, row.id);

    expect(repo.softDelete).toHaveBeenCalledWith(row.id);
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.any(Object));
    expect(resolver.invalidate).toHaveBeenCalledWith(row.id);
  });

  it('404s (not 403) when removing a row in a different tenant', async () => {
    const { svc, repo } = makeService();
    repo.findById.mockResolvedValue(existingRow({ tenantId: OTHER_TENANT }));
    await expect(svc.remove(TENANT, 'some-id')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TenantIdpConfigService.testConnection (TASK-498 D7 — no self-lockout)', () => {
  it('flips DRAFT to ENABLED on a successful discovery probe', async () => {
    const { svc, repo, resolver } = makeService();
    const row = existingRow({ providerStatus: IdpStatus.DRAFT });
    repo.findById.mockResolvedValue(row);
    repo.update.mockImplementation(async (id: string, e: { providerStatus: IdpStatus }) => e);

    const res = await svc.testConnection(TENANT, row.id);

    expect(resolver.buildClient).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
    expect(res.providerStatus).toBe(IdpStatus.ENABLED);
    expect(repo.update).toHaveBeenCalledOnce();
  });

  it('leaves the row DRAFT and returns ok:false when discovery fails', async () => {
    const { svc, repo, resolver } = makeService();
    const row = existingRow({ providerStatus: IdpStatus.DRAFT });
    repo.findById.mockResolvedValue(row);
    resolver.buildClient.mockRejectedValue(new Error('discovery unreachable'));

    const res = await svc.testConnection(TENANT, row.id);

    expect(res.ok).toBe(false);
    expect(res.providerStatus).toBe(IdpStatus.DRAFT);
    expect(res.error).toContain('discovery unreachable');
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('invalidates the resolver cache after a successful probe (fresh client replaces the probe instance)', async () => {
    const { svc, repo, resolver } = makeService();
    const row = existingRow({ providerStatus: IdpStatus.DRAFT });
    repo.findById.mockResolvedValue(row);
    repo.update.mockImplementation(async (id: string, e: { providerStatus: IdpStatus }) => e);

    await svc.testConnection(TENANT, row.id);

    expect(resolver.invalidate).toHaveBeenCalledWith(row.id);
  });

  it('404s (not 403) when testing a row in a different tenant', async () => {
    const { svc, repo } = makeService();
    repo.findById.mockResolvedValue(existingRow({ tenantId: OTHER_TENANT }));
    await expect(svc.testConnection(TENANT, 'some-id')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TenantIdpConfigService.create — SAML branch (TASK-499 D5)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a SAML create with no samlConfig', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(TENANT, { protocol: IdpProtocol.SAML, displayName: 'Acme AD FS' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('generates and seals an SP key pair, persists DRAFT with the cert in config, and never returns the private key', async () => {
    const { svc, repo, secrets } = makeService();
    repo.create.mockImplementation(async (e: unknown) => e);

    const res = await svc.create(TENANT, {
      protocol: IdpProtocol.SAML,
      displayName: 'Acme AD FS',
      samlConfig: validSamlConfig(),
    });

    expect(secrets!.encrypt).toHaveBeenCalledOnce();
    const [sealedKey] = secrets!.encrypt.mock.calls[0];
    expect(Buffer.from(sealedKey).toString('utf8')).toContain('BEGIN PRIVATE KEY');
    expect(JSON.stringify(res)).not.toContain('BEGIN PRIVATE KEY');
    expect(res.providerStatus).toBe(IdpStatus.DRAFT);
    expect(res.hasSecret).toBe(true);
    expect((res.config as { spCertificatePem?: string }).spCertificatePem).toContain('BEGIN CERTIFICATE');
  });

  it('does not require clientSecret for a SAML create', async () => {
    const { svc, repo } = makeService();
    repo.create.mockImplementation(async (e: unknown) => e);

    await expect(
      svc.create(TENANT, { protocol: IdpProtocol.SAML, displayName: 'Acme AD FS', samlConfig: validSamlConfig() }),
    ).resolves.toBeDefined();
  });
});

describe('TenantIdpConfigService.update — SAML branch (TASK-499)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('replaces samlConfig while preserving the server-generated SP cert', async () => {
    const { svc, repo } = makeService();
    const row = existingSamlRow();
    repo.findById.mockResolvedValue(row);
    repo.updateWithVersion.mockImplementation(async () => row);

    await svc.update(TENANT, row.id, { samlConfig: { ...validSamlConfig(), idpSsoUrl: 'https://adfs.acme.com/adfs/ls/new' }, expectedVersion: 1 });

    const persistedConfig = row.config as { idpSsoUrl: string; spCertificatePem?: string };
    expect(persistedConfig.idpSsoUrl).toBe('https://adfs.acme.com/adfs/ls/new');
    expect(persistedConfig.spCertificatePem).toContain('SP-CERT');
  });
});

describe('TenantIdpConfigService.testConnection — SAML branch (TASK-499)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('flips DRAFT to ENABLED when the config-consistency smoke test succeeds', async () => {
    const { svc, repo, resolver } = makeService();
    const row = existingSamlRow({ providerStatus: IdpStatus.DRAFT });
    repo.findById.mockResolvedValue(row);
    repo.update.mockImplementation(async (id: string, e: { providerStatus: IdpStatus }) => e);

    const res = await svc.testConnection(TENANT, row.id);

    expect(resolver.buildSamlClient).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
    expect(res.providerStatus).toBe(IdpStatus.ENABLED);
  });

  it('leaves the row DRAFT and returns ok:false when the client build fails (e.g. malformed IdP cert)', async () => {
    const { svc, repo, resolver } = makeService();
    const row = existingSamlRow({ providerStatus: IdpStatus.DRAFT });
    repo.findById.mockResolvedValue(row);
    resolver.buildSamlClient.mockRejectedValue(new Error('malformed cert'));

    const res = await svc.testConnection(TENANT, row.id);

    expect(res.ok).toBe(false);
    expect(res.providerStatus).toBe(IdpStatus.DRAFT);
    expect(res.error).toContain('malformed cert');
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('returns ok:false when no sealed SP key is configured and signing is required', async () => {
    const { svc, repo } = makeService();
    const row = existingSamlRow({ providerStatus: IdpStatus.DRAFT, encryptedSecretRef: null });
    repo.findById.mockResolvedValue(row);

    const res = await svc.testConnection(TENANT, row.id);

    expect(res.ok).toBe(false);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('succeeds without a sealed SP key when signAuthnRequests is false', async () => {
    const { svc, repo } = makeService();
    const row = existingSamlRow({
      providerStatus: IdpStatus.DRAFT,
      encryptedSecretRef: null,
      config: { ...validSamlConfig(), signAuthnRequests: false, spCertificatePem: 'CERT' },
    });
    repo.findById.mockResolvedValue(row);
    repo.update.mockImplementation(async (id: string, e: { providerStatus: IdpStatus }) => e);

    const res = await svc.testConnection(TENANT, row.id);

    expect(res.ok).toBe(true);
  });

  it('invalidates the resolver cache after a successful probe', async () => {
    const { svc, repo, resolver } = makeService();
    const row = existingSamlRow({ providerStatus: IdpStatus.DRAFT });
    repo.findById.mockResolvedValue(row);
    repo.update.mockImplementation(async (id: string, e: { providerStatus: IdpStatus }) => e);

    await svc.testConnection(TENANT, row.id);

    expect(resolver.invalidate).toHaveBeenCalledWith(row.id);
  });
});
