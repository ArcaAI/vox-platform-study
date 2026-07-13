import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { IdpProtocol, IdpStatus, TenantIdentityProviderFactory } from '@arcaai/domains';

const discoverMock = vi.fn();

vi.mock('openid-client', () => {
  class FakeClient {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(options: any) {
      this.options = options;
    }
  }
  return {
    Issuer: {
      discover: (...args: unknown[]) => discoverMock(...args),
    },
    __FakeClient: FakeClient,
  };
});

const samlConstructorMock = vi.fn();

vi.mock('@node-saml/node-saml', () => {
  class FakeSAML {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(options: any) {
      this.options = options;
      samlConstructorMock(options);
    }
  }
  return {
    SAML: FakeSAML,
    ValidateInResponseTo: { never: 'never', ifPresent: 'ifPresent', always: 'always' },
  };
});

import { IdpResolverService } from '../idp-resolver.service';
import { RedisSamlCacheProvider } from '../saml-redis-cache-provider';

const TENANT = 'tenant-abc';
const REDIRECT_URI = 'https://api.hope.dev/auth/sso/callback';

function makeIssuer() {
  return {
    issuer: 'https://acme.okta.com',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Client: class {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(options: any) {
        this.options = options;
      }
    },
  };
}

const fakeSecrets = () => ({
  decrypt: vi.fn(async (ct: string) => Buffer.from(ct.split(':')[2] ?? 'plaintext-secret', 'utf8')),
});

const fakeRedisCache = () => {
  const store = new Map<string, string>();
  return {
    exists: vi.fn(async (key: string) => store.has(key)),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
};

function makeService(opts: { withVault?: boolean; withRedis?: boolean } = { withVault: true }) {
  const repo = { findEnabledByTenantAndProtocol: vi.fn(), findById: vi.fn() };
  const secrets = opts.withVault !== false ? fakeSecrets() : undefined;
  const redisCache = opts.withRedis ? fakeRedisCache() : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new IdpResolverService(repo as any, secrets as any, redisCache as any);
  return { svc, repo, secrets, redisCache };
}

const enabledProvider = () =>
  TenantIdentityProviderFactory.CreateTenantIdentityProvider({
    tenantId: TENANT,
    protocol: IdpProtocol.OIDC,
    displayName: 'Acme Okta',
    config: { issuer: 'https://acme.okta.com', clientId: 'client-abc' },
    providerStatus: IdpStatus.ENABLED,
    encryptedSecretRef: 'vault:v1:c2VjcmV0',
  });

const ACS_URL = 'https://api.hope.dev/api/v1/auth/sso/saml/acme/acs';

const enabledSamlProvider = (overrides: Record<string, unknown> = {}) =>
  TenantIdentityProviderFactory.CreateTenantIdentityProvider({
    tenantId: TENANT,
    protocol: IdpProtocol.SAML,
    displayName: 'Acme AD FS',
    config: {
      idpEntityId: 'https://adfs.acme.com/adfs/services/trust',
      idpSsoUrl: 'https://adfs.acme.com/adfs/ls/',
      idpSigningCert: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
      spEntityId: 'https://api.hope.dev/saml/acme',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
    },
    providerStatus: IdpStatus.ENABLED,
    encryptedSecretRef: 'vault:v1:c3Bwcml2YXRla2V5',
    ...overrides,
  });

describe('IdpResolverService.buildClient (TASK-498)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discoverMock.mockResolvedValue(makeIssuer());
  });

  it('discovers the issuer and constructs a client with the given credentials', async () => {
    const { svc } = makeService();
    const client = await svc.buildClient('https://acme.okta.com', 'client-abc', 'secret-xyz', REDIRECT_URI);
    expect(discoverMock).toHaveBeenCalledWith('https://acme.okta.com');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).options).toMatchObject({
      client_id: 'client-abc',
      client_secret: 'secret-xyz',
      redirect_uris: [REDIRECT_URI],
      response_types: ['code'],
    });
  });
});

describe('IdpResolverService.resolveForTenant (TASK-498, D4 — repository read, NOT AppSettingsService)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discoverMock.mockResolvedValue(makeIssuer());
  });

  it('throws when no enabled provider is configured for the tenant', async () => {
    const { svc, repo } = makeService();
    repo.findEnabledByTenantAndProtocol.mockResolvedValue(null);
    await expect(svc.resolveForTenant(TENANT, IdpProtocol.OIDC, REDIRECT_URI)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws when Vault is unavailable (no sealed-secret unseal path)', async () => {
    const { svc, repo } = makeService({ withVault: false });
    repo.findEnabledByTenantAndProtocol.mockResolvedValue(enabledProvider());
    await expect(svc.resolveForTenant(TENANT, IdpProtocol.OIDC, REDIRECT_URI)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('decrypts the sealed secret and builds a client from the persisted config', async () => {
    const { svc, repo, secrets } = makeService();
    repo.findEnabledByTenantAndProtocol.mockResolvedValue(enabledProvider());
    const { client, provider } = await svc.resolveForTenant(TENANT, IdpProtocol.OIDC, REDIRECT_URI);
    expect(secrets!.decrypt).toHaveBeenCalledWith('vault:v1:c2VjcmV0');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).options.client_id).toBe('client-abc');
    expect(provider.tenantId).toBe(TENANT);
  });

  it('caches the client per provider — a second resolve does not re-discover', async () => {
    const { svc, repo } = makeService();
    repo.findEnabledByTenantAndProtocol.mockResolvedValue(enabledProvider());
    await svc.resolveForTenant(TENANT, IdpProtocol.OIDC, REDIRECT_URI);
    await svc.resolveForTenant(TENANT, IdpProtocol.OIDC, REDIRECT_URI);
    expect(discoverMock).toHaveBeenCalledTimes(1);
  });

  it('invalidate() clears the cache so the next resolve rebuilds the client', async () => {
    const { svc, repo } = makeService();
    const provider = enabledProvider();
    repo.findEnabledByTenantAndProtocol.mockResolvedValue(provider);
    await svc.resolveForTenant(TENANT, IdpProtocol.OIDC, REDIRECT_URI);
    svc.invalidate(provider.id);
    await svc.resolveForTenant(TENANT, IdpProtocol.OIDC, REDIRECT_URI);
    expect(discoverMock).toHaveBeenCalledTimes(2);
  });
});

describe('IdpResolverService.resolveByProviderId (TASK-498 — callback path, no cache-warmth assumption)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discoverMock.mockResolvedValue(makeIssuer());
  });

  it('throws when the provider id does not exist', async () => {
    const { svc, repo } = makeService();
    repo.findById.mockResolvedValue(null);
    await expect(svc.resolveByProviderId('missing-id', REDIRECT_URI)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resolves independently of resolveForTenant ever having been called (cold cache)', async () => {
    const { svc, repo } = makeService();
    const provider = enabledProvider();
    repo.findById.mockResolvedValue(provider);
    const { client } = await svc.resolveByProviderId(provider.id, REDIRECT_URI);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).options.client_id).toBe('client-abc');
    expect(discoverMock).toHaveBeenCalledTimes(1);
  });

  it('shares the cache with resolveForTenant — a prior /start warm-up avoids re-discovery on /callback', async () => {
    const { svc, repo } = makeService();
    const provider = enabledProvider();
    repo.findEnabledByTenantAndProtocol.mockResolvedValue(provider);
    repo.findById.mockResolvedValue(provider);
    await svc.resolveForTenant(TENANT, IdpProtocol.OIDC, REDIRECT_URI);
    await svc.resolveByProviderId(provider.id, REDIRECT_URI);
    expect(discoverMock).toHaveBeenCalledTimes(1);
  });
});

describe('IdpResolverService.buildSamlClient (TASK-499 D4/§6 — hardened, non-negotiable options)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds a client with the pinned IdP cert, SP entityId, and hardened security options', async () => {
    const { svc } = makeService();
    const config = {
      idpEntityId: 'https://adfs.acme.com/adfs/services/trust',
      idpSsoUrl: 'https://adfs.acme.com/adfs/ls/',
      idpSigningCert: 'PEM-CERT',
      spEntityId: 'https://api.hope.dev/saml/acme',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
    };
    await svc.buildSamlClient(config, ACS_URL, 'PEM-SP-PRIVATE-KEY');

    expect(samlConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl: ACS_URL,
        issuer: config.spEntityId,
        idpCert: config.idpSigningCert,
        entryPoint: config.idpSsoUrl,
        identifierFormat: config.nameIdFormat,
        wantAssertionsSigned: true,
        wantAuthnResponseSigned: false,
        signatureAlgorithm: 'sha256',
        acceptedClockSkewMs: 60_000,
        validateInResponseTo: 'always',
        privateKey: 'PEM-SP-PRIVATE-KEY',
      }),
    );
  });

  it('omits the AuthnRequest signing key when signAuthnRequests is explicitly false', async () => {
    const { svc } = makeService();
    const config = {
      idpEntityId: 'https://adfs.acme.com/adfs/services/trust',
      idpSsoUrl: 'https://adfs.acme.com/adfs/ls/',
      idpSigningCert: 'PEM-CERT',
      spEntityId: 'https://api.hope.dev/saml/acme',
      signAuthnRequests: false,
    };
    await svc.buildSamlClient(config, ACS_URL, 'PEM-SP-PRIVATE-KEY');

    expect(samlConstructorMock).toHaveBeenCalledWith(expect.objectContaining({ privateKey: undefined }));
  });

  it('wires a RedisSamlCacheProvider when Redis is available', async () => {
    const { svc } = makeService({ withRedis: true });
    const config = {
      idpEntityId: 'https://adfs.acme.com/adfs/services/trust',
      idpSsoUrl: 'https://adfs.acme.com/adfs/ls/',
      idpSigningCert: 'PEM-CERT',
      spEntityId: 'https://api.hope.dev/saml/acme',
    };
    await svc.buildSamlClient(config, ACS_URL, 'PEM-SP-PRIVATE-KEY');

    const [callOptions] = samlConstructorMock.mock.calls[samlConstructorMock.mock.calls.length - 1];
    expect(callOptions.cacheProvider).toBeInstanceOf(RedisSamlCacheProvider);
  });

  it('falls back to the library default (no cacheProvider key) when Redis is unavailable', async () => {
    const { svc } = makeService({ withRedis: false });
    const config = {
      idpEntityId: 'https://adfs.acme.com/adfs/services/trust',
      idpSsoUrl: 'https://adfs.acme.com/adfs/ls/',
      idpSigningCert: 'PEM-CERT',
      spEntityId: 'https://api.hope.dev/saml/acme',
    };
    await svc.buildSamlClient(config, ACS_URL, 'PEM-SP-PRIVATE-KEY');

    const [callOptions] = samlConstructorMock.mock.calls[samlConstructorMock.mock.calls.length - 1];
    expect(callOptions.cacheProvider).toBeUndefined();
  });
});

describe('IdpResolverService.resolveSamlForTenant (TASK-499)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws when no enabled SAML provider is configured for the tenant', async () => {
    const { svc, repo } = makeService();
    repo.findEnabledByTenantAndProtocol.mockResolvedValue(null);
    await expect(svc.resolveSamlForTenant(TENANT, ACS_URL)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws when Vault is unavailable and the provider requires a signing key', async () => {
    const { svc, repo } = makeService({ withVault: false });
    repo.findEnabledByTenantAndProtocol.mockResolvedValue(enabledSamlProvider());
    await expect(svc.resolveSamlForTenant(TENANT, ACS_URL)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('decrypts the sealed SP private key and builds a client from the persisted config', async () => {
    const { svc, repo, secrets } = makeService();
    repo.findEnabledByTenantAndProtocol.mockResolvedValue(enabledSamlProvider());
    const { client, provider } = await svc.resolveSamlForTenant(TENANT, ACS_URL);
    expect(secrets!.decrypt).toHaveBeenCalledWith('vault:v1:c3Bwcml2YXRla2V5');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).options.issuer).toBe('https://api.hope.dev/saml/acme');
    expect(provider.tenantId).toBe(TENANT);
  });

  it('does not require a sealed secret when signAuthnRequests is false', async () => {
    const { svc, repo } = makeService({ withVault: false });
    repo.findEnabledByTenantAndProtocol.mockResolvedValue(
      enabledSamlProvider({
        config: {
          idpEntityId: 'https://adfs.acme.com/adfs/services/trust',
          idpSsoUrl: 'https://adfs.acme.com/adfs/ls/',
          idpSigningCert: 'PEM-CERT',
          spEntityId: 'https://api.hope.dev/saml/acme',
          signAuthnRequests: false,
        },
        encryptedSecretRef: null,
      }),
    );
    const { client } = await svc.resolveSamlForTenant(TENANT, ACS_URL);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).options.privateKey).toBeUndefined();
  });

  it('caches the SAML client per provider — a second resolve does not reconstruct', async () => {
    const { svc, repo } = makeService();
    repo.findEnabledByTenantAndProtocol.mockResolvedValue(enabledSamlProvider());
    await svc.resolveSamlForTenant(TENANT, ACS_URL);
    await svc.resolveSamlForTenant(TENANT, ACS_URL);
    expect(samlConstructorMock).toHaveBeenCalledTimes(1);
  });

  it('invalidate() clears the SAML cache so the next resolve rebuilds the client', async () => {
    const { svc, repo } = makeService();
    const provider = enabledSamlProvider();
    repo.findEnabledByTenantAndProtocol.mockResolvedValue(provider);
    await svc.resolveSamlForTenant(TENANT, ACS_URL);
    svc.invalidate(provider.id);
    await svc.resolveSamlForTenant(TENANT, ACS_URL);
    expect(samlConstructorMock).toHaveBeenCalledTimes(2);
  });
});

describe('IdpResolverService.resolveSamlByProviderId (TASK-499 — ACS path, no cache-warmth assumption)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws when the provider id does not exist', async () => {
    const { svc, repo } = makeService();
    repo.findById.mockResolvedValue(null);
    await expect(svc.resolveSamlByProviderId('missing-id', ACS_URL)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('shares the cache with resolveSamlForTenant — a prior /start warm-up avoids rebuilding on /acs', async () => {
    const { svc, repo } = makeService();
    const provider = enabledSamlProvider();
    repo.findEnabledByTenantAndProtocol.mockResolvedValue(provider);
    repo.findById.mockResolvedValue(provider);
    await svc.resolveSamlForTenant(TENANT, ACS_URL);
    await svc.resolveSamlByProviderId(provider.id, ACS_URL);
    expect(samlConstructorMock).toHaveBeenCalledTimes(1);
  });
});
