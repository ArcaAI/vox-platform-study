import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { IdpProtocol, IdpStatus, ResourceStatusType, TenantIdentityProviderFactory, FederatedIdentityFactory } from '@arcaai/domains';

vi.mock('openid-client', () => ({
  generators: {
    codeVerifier: vi.fn(() => 'fixed-code-verifier'),
    codeChallenge: vi.fn((v: string) => `challenge-of-${v}`),
    nonce: vi.fn(() => 'fixed-nonce'),
  },
}));

import { FederatedAuthService } from '../federated-auth.service';

const TENANT = 'tenant-abc';
const JWT_SECRET = 'test-jwt-secret';
const REDIRECT_URI = 'https://api.hope.dev/auth/sso/callback';

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
      jitEnabled: true,
      ...(overrides.config as object),
    },
    encryptedSecretRef: 'vault:v1:c2VjcmV0',
    ...overrides,
  });
}

function makeFakeClient() {
  return {
    authorizationUrl: vi.fn((params: Record<string, unknown>) => `https://acme.okta.com/authorize?${new URLSearchParams(params as never).toString()}`),
    callback: vi.fn(),
  };
}

function makeFakeSamlClient() {
  return {
    getAuthorizeUrlAsync: vi.fn(async () => 'https://adfs.acme.com/adfs/ls/?SAMLRequest=xyz'),
    validatePostResponseAsync: vi.fn(),
    generateServiceProviderMetadata: vi.fn(() => '<EntityDescriptor/>'),
  };
}

function makeSamlProvider(overrides: Record<string, unknown> = {}) {
  return TenantIdentityProviderFactory.CreateTenantIdentityProvider({
    tenantId: TENANT,
    protocol: IdpProtocol.SAML,
    displayName: 'Acme AD FS',
    providerStatus: IdpStatus.ENABLED,
    config: {
      idpEntityId: 'https://adfs.acme.com/adfs/services/trust',
      idpSsoUrl: 'https://adfs.acme.com/adfs/ls/',
      idpSigningCert: 'PEM-CERT',
      spEntityId: 'https://api.hope.dev/saml/acme',
      spCertificatePem: 'SP-CERT',
      defaultRoleId: 'role-default',
      defaultDepartmentId: 'dept-default',
      jitEnabled: true,
      ...(overrides.config as object),
    },
    encryptedSecretRef: 'vault:v1:c3Bwcml2YXRla2V5',
    ...overrides,
  });
}

function makeService(opts: { withRedis?: boolean } = {}) {
  const idpResolver = { resolveByProviderId: vi.fn(), resolveSamlForTenant: vi.fn(), resolveSamlByProviderId: vi.fn() };
  const providerRepository = { findEnabledByTenantAndProtocol: vi.fn(), findByTenantId: vi.fn() };
  const domainRepository = { findByDomain: vi.fn() };
  const federatedIdentityRepository = { findByProviderAndSubject: vi.fn(), create: vi.fn(), update: vi.fn() };
  const userRepository = { findById: vi.fn(), update: vi.fn() };
  const userRoleAssignmentRepository = { create: vi.fn() };
  const userDepartmentRepository = { create: vi.fn() };
  const tenantRepository = { findFirst: vi.fn() };
  const userRoleAssignmentService = {
    findActiveRolesForUser: vi.fn().mockResolvedValue([{ id: 'role-default', name: 'DOCTOR', permissions: ['read:x'] }]),
    findActiveAssignmentForUserInTenant: vi.fn().mockResolvedValue({ id: 'assignment-1' }),
  };
  const userDepartmentService = {
    findActiveDepartmentForUserInTenant: vi.fn().mockResolvedValue({ id: 'dept-assignment-1' }),
  };
  const userProfileService = { upsertByUserId: vi.fn() };
  const eventEmitter = { emit: vi.fn() };
  const roleFindUnique = vi.fn().mockResolvedValue({ name: 'DOCTOR' });
  const roleFindFirst = vi.fn().mockResolvedValue(null);
  const databaseService = {
    baseClient: {
      role: { findUnique: roleFindUnique, findFirst: roleFindFirst },
      $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
    },
  };
  const secretsService = {
    getSecretSync: vi.fn(() => JWT_SECRET),
    getSecretOptional: vi.fn(async () => JWT_SECRET),
  };
  const redisStore = new Map<string, string>();
  const redisCache = opts.withRedis
    ? {
        exists: vi.fn(async (key: string) => redisStore.has(key)),
        set: vi.fn(async (key: string, value: string) => {
          redisStore.set(key, value);
        }),
      }
    : undefined;

  const svc = new FederatedAuthService(
    idpResolver as never,
    providerRepository as never,
    domainRepository as never,
    federatedIdentityRepository as never,
    userRepository as never,
    userRoleAssignmentRepository as never,
    userDepartmentRepository as never,
    tenantRepository as never,
    userRoleAssignmentService as never,
    userDepartmentService as never,
    userProfileService as never,
    eventEmitter as never,
    databaseService as never,
    secretsService as never,
    redisCache as never,
  );

  return {
    svc,
    idpResolver,
    providerRepository,
    domainRepository,
    federatedIdentityRepository,
    userRepository,
    userRoleAssignmentRepository,
    userDepartmentRepository,
    tenantRepository,
    userRoleAssignmentService,
    userDepartmentService,
    userProfileService,
    eventEmitter,
    roleFindUnique,
    roleFindFirst,
    redisCache,
  };
}

describe('FederatedAuthService.buildAuthorizeUrl (TASK-498 D5 — HRD with explicit tenant fallback)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves via HRD when the email domain is mapped to a provider', async () => {
    const ctx = makeService();
    const provider = makeProvider();
    ctx.domainRepository.findByDomain.mockResolvedValue({ tenantId: TENANT, providerId: provider.id });
    ctx.idpResolver.resolveByProviderId.mockResolvedValue({ client: makeFakeClient(), provider });

    const res = await ctx.svc.buildAuthorizeUrl({ email: 'doctor@acme.com', redirectUri: REDIRECT_URI });

    expect(ctx.domainRepository.findByDomain).toHaveBeenCalledWith('acme.com');
    expect(ctx.idpResolver.resolveByProviderId).toHaveBeenCalledWith(provider.id, REDIRECT_URI);
    expect(res.authorizeUrl).toContain('https://acme.okta.com/authorize');
  });

  it('builds the authorize URL with PKCE (S256) + nonce + a signed state', async () => {
    const ctx = makeService();
    const provider = makeProvider();
    ctx.domainRepository.findByDomain.mockResolvedValue({ tenantId: TENANT, providerId: provider.id });
    const client = makeFakeClient();
    ctx.idpResolver.resolveByProviderId.mockResolvedValue({ client, provider });

    await ctx.svc.buildAuthorizeUrl({ email: 'doctor@acme.com', redirectUri: REDIRECT_URI });

    const callArgs = client.authorizationUrl.mock.calls[0][0];
    expect(callArgs.code_challenge).toBe('challenge-of-fixed-code-verifier');
    expect(callArgs.code_challenge_method).toBe('S256');
    expect(callArgs.nonce).toBe('fixed-nonce');
    expect(typeof callArgs.state).toBe('string');
    const decoded = jwt.verify(callArgs.state, JWT_SECRET) as Record<string, unknown>;
    expect(decoded.providerId).toBe(provider.id);
    expect(decoded.tenantId).toBe(TENANT);
    expect(decoded.codeVerifier).toBe('fixed-code-verifier');
  });

  it('falls back to tenantKey when the email domain is unmapped', async () => {
    const ctx = makeService();
    const provider = makeProvider();
    ctx.domainRepository.findByDomain.mockResolvedValue(null);
    ctx.tenantRepository.findFirst.mockResolvedValue({ id: TENANT, key: 'acme' });
    ctx.providerRepository.findEnabledByTenantAndProtocol.mockResolvedValue(provider);
    ctx.idpResolver.resolveByProviderId.mockResolvedValue({ client: makeFakeClient(), provider });

    const res = await ctx.svc.buildAuthorizeUrl({ email: 'doctor@unmapped.com', tenantKey: 'acme', redirectUri: REDIRECT_URI });

    expect(res.authorizeUrl).toContain('https://acme.okta.com/authorize');
  });

  it('throws when neither a mapped email domain nor a tenantKey is given', async () => {
    const ctx = makeService();
    ctx.domainRepository.findByDomain.mockResolvedValue(null);
    await expect(ctx.svc.buildAuthorizeUrl({ redirectUri: REDIRECT_URI })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws when the tenantKey resolves but has no enabled OIDC provider', async () => {
    const ctx = makeService();
    ctx.tenantRepository.findFirst.mockResolvedValue({ id: TENANT, key: 'acme' });
    ctx.providerRepository.findEnabledByTenantAndProtocol.mockResolvedValue(null);
    await expect(
      ctx.svc.buildAuthorizeUrl({ tenantKey: 'acme', redirectUri: REDIRECT_URI }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('FederatedAuthService.verifyOidcCallback — state verification', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws UnauthorizedException on an invalid/tampered state', async () => {
    const ctx = makeService();
    await expect(
      ctx.svc.verifyOidcCallback({ code: 'abc', state: 'not-a-real-jwt', redirectUri: REDIRECT_URI }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('FederatedAuthService.verifyOidcCallback — existing FederatedIdentity link', () => {
  beforeEach(() => vi.clearAllMocks());

  function signState(providerId: string) {
    return jwt.sign({ tenantId: TENANT, providerId, nonce: 'fixed-nonce', codeVerifier: 'fixed-code-verifier' }, JWT_SECRET, {
      expiresIn: '5m',
    });
  }

  it('logs in the linked user without creating a new one', async () => {
    const ctx = makeService();
    const provider = makeProvider();
    const client = makeFakeClient();
    client.callback.mockResolvedValue({ claims: () => ({ sub: 'okta-sub-1', email: 'doctor@acme.com' }) });
    ctx.idpResolver.resolveByProviderId.mockResolvedValue({ client, provider });

    const link = FederatedIdentityFactory.CreateFederatedIdentity({
      tenantId: TENANT,
      userId: 'user-1',
      providerId: provider.id,
      subject: 'okta-sub-1',
    });
    ctx.federatedIdentityRepository.findByProviderAndSubject.mockResolvedValue(link);
    ctx.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'oidc:x', resourceStatus: ResourceStatusType.ENABLED });

    const session = await ctx.svc.verifyOidcCallback({ code: 'auth-code', state: signState(provider.id), redirectUri: REDIRECT_URI });

    expect(session.id).toBe('user-1');
    expect(session.tenantId).toBe(TENANT);
    expect(ctx.userRoleAssignmentRepository.create).not.toHaveBeenCalled();
    expect(ctx.federatedIdentityRepository.update).toHaveBeenCalledOnce();
  });

  it('rejects when the linked user no longer has tenant membership (revoked)', async () => {
    const ctx = makeService();
    const provider = makeProvider();
    const client = makeFakeClient();
    client.callback.mockResolvedValue({ claims: () => ({ sub: 'okta-sub-1' }) });
    ctx.idpResolver.resolveByProviderId.mockResolvedValue({ client, provider });
    ctx.federatedIdentityRepository.findByProviderAndSubject.mockResolvedValue(
      FederatedIdentityFactory.CreateFederatedIdentity({ tenantId: TENANT, userId: 'user-1', providerId: provider.id, subject: 'okta-sub-1' }),
    );
    ctx.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'oidc:x', resourceStatus: ResourceStatusType.ENABLED });
    ctx.userRoleAssignmentService.findActiveAssignmentForUserInTenant.mockResolvedValue(null);

    await expect(
      ctx.svc.verifyOidcCallback({ code: 'auth-code', state: signState(provider.id), redirectUri: REDIRECT_URI }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('FederatedAuthService.verifyOidcCallback — JIT provisioning (D3/D6)', () => {
  beforeEach(() => vi.clearAllMocks());

  function signState(providerId: string) {
    return jwt.sign({ tenantId: TENANT, providerId, nonce: 'fixed-nonce', codeVerifier: 'fixed-code-verifier' }, JWT_SECRET, {
      expiresIn: '5m',
    });
  }

  function setupUnlinkedCallback(ctx: ReturnType<typeof makeService>, provider: ReturnType<typeof makeProvider>, claims: Record<string, unknown>) {
    const client = makeFakeClient();
    client.callback.mockResolvedValue({ claims: () => claims });
    ctx.idpResolver.resolveByProviderId.mockResolvedValue({ client, provider });
    ctx.federatedIdentityRepository.findByProviderAndSubject.mockResolvedValue(null);
    ctx.userRepository.create = vi.fn(async (e: { id: string }) => e);
    ctx.federatedIdentityRepository.create.mockImplementation(async (e: unknown) => e);
    ctx.userRoleAssignmentRepository.create.mockImplementation(async (e: unknown) => e);
    ctx.userDepartmentRepository.create.mockImplementation(async (e: unknown) => e);
    return client;
  }

  it('creates a user + default role + default department + federated link atomically', async () => {
    const ctx = makeService();
    const provider = makeProvider();
    setupUnlinkedCallback(ctx, provider, { sub: 'okta-sub-new', email: 'newdoc@acme.com' });

    const session = await ctx.svc.verifyOidcCallback({ code: 'auth-code', state: signState(provider.id), redirectUri: REDIRECT_URI });

    expect(session.tenantId).toBe(TENANT);
    expect(ctx.userRoleAssignmentRepository.create).toHaveBeenCalledOnce();
    const roleCallArg = ctx.userRoleAssignmentRepository.create.mock.calls[0][0];
    expect(roleCallArg.roleId).toBe('role-default');
    expect(roleCallArg.tenantId).toBe(TENANT);
    expect(ctx.userDepartmentRepository.create).toHaveBeenCalledOnce();
    const deptCallArg = ctx.userDepartmentRepository.create.mock.calls[0][0];
    expect(deptCallArg.departmentId).toBe('dept-default');
    expect(ctx.federatedIdentityRepository.create).toHaveBeenCalledOnce();
    expect(ctx.userProfileService.upsertByUserId).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ email: 'newdoc@acme.com' }),
    );
  });

  it('maps an IdP group claim to a HOPE role via Role.externalName, overriding the default role', async () => {
    const ctx = makeService();
    const provider = makeProvider({
      config: {
        issuer: 'https://acme.okta.com',
        clientId: 'client-abc',
        defaultRoleId: 'role-default',
        defaultDepartmentId: 'dept-default',
        jitEnabled: true,
        groupToRoleMap: { 'acme-clinicians': 'DOCTOR' },
      },
    });
    setupUnlinkedCallback(ctx, provider, { sub: 'okta-sub-new', groups: ['acme-clinicians'] });
    ctx.roleFindFirst.mockResolvedValue({ id: 'role-doctor', name: 'DOCTOR' });
    ctx.roleFindUnique.mockResolvedValue({ name: 'DOCTOR' });

    await ctx.svc.verifyOidcCallback({ code: 'auth-code', state: signState(provider.id), redirectUri: REDIRECT_URI });

    expect(ctx.roleFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ externalName: 'DOCTOR' }) }));
    const roleCallArg = ctx.userRoleAssignmentRepository.create.mock.calls[0][0];
    expect(roleCallArg.roleId).toBe('role-doctor');
  });

  it('never assigns GLOBAL_ADMIN via IdP mapping (D6, hard guard)', async () => {
    const ctx = makeService();
    const provider = makeProvider({
      config: {
        issuer: 'https://acme.okta.com',
        clientId: 'client-abc',
        defaultRoleId: 'role-global-admin',
        defaultDepartmentId: 'dept-default',
        jitEnabled: true,
      },
    });
    setupUnlinkedCallback(ctx, provider, { sub: 'okta-sub-new' });
    ctx.roleFindUnique.mockResolvedValue({ name: 'GLOBAL_ADMIN' });

    await expect(
      ctx.svc.verifyOidcCallback({ code: 'auth-code', state: signState(provider.id), redirectUri: REDIRECT_URI }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ctx.userRoleAssignmentRepository.create).not.toHaveBeenCalled();
  });

  it('rejects an unprovisioned subject when jitEnabled is false', async () => {
    const ctx = makeService();
    const provider = makeProvider({
      config: {
        issuer: 'https://acme.okta.com',
        clientId: 'client-abc',
        defaultRoleId: 'role-default',
        defaultDepartmentId: 'dept-default',
        jitEnabled: false,
      },
    });
    setupUnlinkedCallback(ctx, provider, { sub: 'okta-sub-new' });

    await expect(
      ctx.svc.verifyOidcCallback({ code: 'auth-code', state: signState(provider.id), redirectUri: REDIRECT_URI }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ctx.userRepository.create).not.toHaveBeenCalled();
  });
});

const ACS_URL = 'https://api.hope.dev/api/v1/auth/sso/saml/acme/acs';

describe('FederatedAuthService.buildSamlAuthnRequest (TASK-499 — SP-initiated, tenantKey only)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves the tenant by key and returns the AuthnRequest redirect URL', async () => {
    const ctx = makeService();
    const provider = makeSamlProvider();
    ctx.tenantRepository.findFirst.mockResolvedValue({ id: TENANT, key: 'acme' });
    const client = makeFakeSamlClient();
    ctx.idpResolver.resolveSamlForTenant.mockResolvedValue({ client, provider });

    const res = await ctx.svc.buildSamlAuthnRequest({ tenantKey: 'acme', acsUrl: ACS_URL });

    expect(ctx.idpResolver.resolveSamlForTenant).toHaveBeenCalledWith(TENANT, ACS_URL);
    expect(client.getAuthorizeUrlAsync).toHaveBeenCalledOnce();
    expect(res.redirectUrl).toBe('https://adfs.acme.com/adfs/ls/?SAMLRequest=xyz');
  });

  it('throws BadRequestException when the tenant key does not resolve', async () => {
    const ctx = makeService();
    ctx.tenantRepository.findFirst.mockResolvedValue(null);
    await expect(ctx.svc.buildSamlAuthnRequest({ tenantKey: 'missing', acsUrl: ACS_URL })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('propagates the resolver error when no enabled SAML provider is configured', async () => {
    const ctx = makeService();
    ctx.tenantRepository.findFirst.mockResolvedValue({ id: TENANT, key: 'acme' });
    ctx.idpResolver.resolveSamlForTenant.mockRejectedValue(new BadRequestException('No enabled identity provider configured for this tenant'));
    await expect(ctx.svc.buildSamlAuthnRequest({ tenantKey: 'acme', acsUrl: ACS_URL })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('FederatedAuthService.getSamlServiceProviderMetadata (TASK-499 — servable regardless of DRAFT/ENABLED)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns SP metadata XML for a DRAFT (not-yet-tested) provider', async () => {
    const ctx = makeService();
    const provider = makeSamlProvider({ providerStatus: IdpStatus.DRAFT });
    ctx.tenantRepository.findFirst.mockResolvedValue({ id: TENANT, key: 'acme' });
    ctx.providerRepository.findByTenantId.mockResolvedValue([provider]);
    const client = makeFakeSamlClient();
    ctx.idpResolver.resolveSamlByProviderId.mockResolvedValue({ client, provider });

    const xml = await ctx.svc.getSamlServiceProviderMetadata('acme', ACS_URL);

    expect(xml).toBe('<EntityDescriptor/>');
    expect(client.generateServiceProviderMetadata).toHaveBeenCalledWith(null, 'SP-CERT');
  });

  it('throws BadRequestException when the tenant has no SAML provider at all', async () => {
    const ctx = makeService();
    ctx.tenantRepository.findFirst.mockResolvedValue({ id: TENANT, key: 'acme' });
    ctx.providerRepository.findByTenantId.mockResolvedValue([]);
    await expect(ctx.svc.getSamlServiceProviderMetadata('acme', ACS_URL)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('FederatedAuthService.verifySamlResponse (TASK-499 D4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws UnauthorizedException when no enabled SAML provider is configured for the tenant', async () => {
    const ctx = makeService();
    ctx.tenantRepository.findFirst.mockResolvedValue({ id: TENANT, key: 'acme' });
    ctx.providerRepository.findEnabledByTenantAndProtocol.mockResolvedValue(null);
    await expect(
      ctx.svc.verifySamlResponse({ tenantKey: 'acme', samlResponse: 'base64response', acsUrl: ACS_URL }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws UnauthorizedException when the library rejects the response (tampered/invalid)', async () => {
    const ctx = makeService();
    const provider = makeSamlProvider();
    ctx.tenantRepository.findFirst.mockResolvedValue({ id: TENANT, key: 'acme' });
    ctx.providerRepository.findEnabledByTenantAndProtocol.mockResolvedValue(provider);
    const client = makeFakeSamlClient();
    client.validatePostResponseAsync.mockRejectedValue(new Error('Invalid signature'));
    ctx.idpResolver.resolveSamlByProviderId.mockResolvedValue({ client, provider });

    await expect(
      ctx.svc.verifySamlResponse({ tenantKey: 'acme', samlResponse: 'base64response', acsUrl: ACS_URL }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws UnauthorizedException when the response carries no assertion profile (e.g. a logout message)', async () => {
    const ctx = makeService();
    const provider = makeSamlProvider();
    ctx.tenantRepository.findFirst.mockResolvedValue({ id: TENANT, key: 'acme' });
    ctx.providerRepository.findEnabledByTenantAndProtocol.mockResolvedValue(provider);
    const client = makeFakeSamlClient();
    client.validatePostResponseAsync.mockResolvedValue({ profile: null, loggedOut: false });
    ctx.idpResolver.resolveSamlByProviderId.mockResolvedValue({ client, provider });

    await expect(
      ctx.svc.verifySamlResponse({ tenantKey: 'acme', samlResponse: 'base64response', acsUrl: ACS_URL }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('logs in an already-linked SAML user without creating a new one', async () => {
    const ctx = makeService();
    const provider = makeSamlProvider();
    ctx.tenantRepository.findFirst.mockResolvedValue({ id: TENANT, key: 'acme' });
    ctx.providerRepository.findEnabledByTenantAndProtocol.mockResolvedValue(provider);
    const client = makeFakeSamlClient();
    client.validatePostResponseAsync.mockResolvedValue({
      profile: { nameID: 'adfs-nameid-1', email: 'doctor@acme.com', ID: 'assertion-1' },
      loggedOut: false,
    });
    ctx.idpResolver.resolveSamlByProviderId.mockResolvedValue({ client, provider });

    const link = FederatedIdentityFactory.CreateFederatedIdentity({
      tenantId: TENANT,
      userId: 'user-1',
      providerId: provider.id,
      subject: 'adfs-nameid-1',
    });
    ctx.federatedIdentityRepository.findByProviderAndSubject.mockResolvedValue(link);
    ctx.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'saml:x', resourceStatus: ResourceStatusType.ENABLED });

    const session = await ctx.svc.verifySamlResponse({ tenantKey: 'acme', samlResponse: 'base64response', acsUrl: ACS_URL });

    expect(session.id).toBe('user-1');
    expect(session.email).toBe('doctor@acme.com');
    expect(ctx.userRoleAssignmentRepository.create).not.toHaveBeenCalled();
  });

  it('JIT-provisions a new user with a saml:-prefixed username (regression: was hardcoded oidc:)', async () => {
    const ctx = makeService();
    const provider = makeSamlProvider();
    ctx.tenantRepository.findFirst.mockResolvedValue({ id: TENANT, key: 'acme' });
    ctx.providerRepository.findEnabledByTenantAndProtocol.mockResolvedValue(provider);
    const client = makeFakeSamlClient();
    client.validatePostResponseAsync.mockResolvedValue({
      profile: { nameID: 'adfs-nameid-new', email: 'newdoc@acme.com', ID: 'assertion-2' },
      loggedOut: false,
    });
    ctx.idpResolver.resolveSamlByProviderId.mockResolvedValue({ client, provider });
    ctx.federatedIdentityRepository.findByProviderAndSubject.mockResolvedValue(null);
    ctx.userRepository.create = vi.fn(async (e: { id: string; username: string }) => e);
    ctx.federatedIdentityRepository.create.mockImplementation(async (e: unknown) => e);
    ctx.userRoleAssignmentRepository.create.mockImplementation(async (e: unknown) => e);
    ctx.userDepartmentRepository.create.mockImplementation(async (e: unknown) => e);

    await ctx.svc.verifySamlResponse({ tenantKey: 'acme', samlResponse: 'base64response', acsUrl: ACS_URL });

    const createdUser = (ctx.userRepository.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createdUser.username).toBe(`saml:${provider.id}:adfs-nameid-new`);
  });

  it('rejects when the linked SAML user no longer has tenant membership (revoked)', async () => {
    const ctx = makeService();
    const provider = makeSamlProvider();
    ctx.tenantRepository.findFirst.mockResolvedValue({ id: TENANT, key: 'acme' });
    ctx.providerRepository.findEnabledByTenantAndProtocol.mockResolvedValue(provider);
    const client = makeFakeSamlClient();
    client.validatePostResponseAsync.mockResolvedValue({
      profile: { nameID: 'adfs-nameid-1', ID: 'assertion-1' },
      loggedOut: false,
    });
    ctx.idpResolver.resolveSamlByProviderId.mockResolvedValue({ client, provider });
    ctx.federatedIdentityRepository.findByProviderAndSubject.mockResolvedValue(
      FederatedIdentityFactory.CreateFederatedIdentity({ tenantId: TENANT, userId: 'user-1', providerId: provider.id, subject: 'adfs-nameid-1' }),
    );
    ctx.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'saml:x', resourceStatus: ResourceStatusType.ENABLED });
    ctx.userRoleAssignmentService.findActiveAssignmentForUserInTenant.mockResolvedValue(null);

    await expect(
      ctx.svc.verifySamlResponse({ tenantKey: 'acme', samlResponse: 'base64response', acsUrl: ACS_URL }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('D4 replay defense: rejects a second use of the same assertion ID when Redis is available', async () => {
    const ctx = makeService({ withRedis: true });
    const provider = makeSamlProvider();
    ctx.tenantRepository.findFirst.mockResolvedValue({ id: TENANT, key: 'acme' });
    ctx.providerRepository.findEnabledByTenantAndProtocol.mockResolvedValue(provider);
    const client = makeFakeSamlClient();
    client.validatePostResponseAsync.mockResolvedValue({
      profile: { nameID: 'adfs-nameid-1', email: 'doctor@acme.com', ID: 'assertion-replay' },
      loggedOut: false,
    });
    ctx.idpResolver.resolveSamlByProviderId.mockResolvedValue({ client, provider });
    ctx.federatedIdentityRepository.findByProviderAndSubject.mockResolvedValue(
      FederatedIdentityFactory.CreateFederatedIdentity({ tenantId: TENANT, userId: 'user-1', providerId: provider.id, subject: 'adfs-nameid-1' }),
    );
    ctx.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'saml:x', resourceStatus: ResourceStatusType.ENABLED });

    const first = await ctx.svc.verifySamlResponse({ tenantKey: 'acme', samlResponse: 'base64response', acsUrl: ACS_URL });
    expect(first.id).toBe('user-1');

    await expect(
      ctx.svc.verifySamlResponse({ tenantKey: 'acme', samlResponse: 'base64response', acsUrl: ACS_URL }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('skips the replay check (does not throw) when Redis is unavailable', async () => {
    const ctx = makeService({ withRedis: false });
    const provider = makeSamlProvider();
    ctx.tenantRepository.findFirst.mockResolvedValue({ id: TENANT, key: 'acme' });
    ctx.providerRepository.findEnabledByTenantAndProtocol.mockResolvedValue(provider);
    const client = makeFakeSamlClient();
    client.validatePostResponseAsync.mockResolvedValue({
      profile: { nameID: 'adfs-nameid-1', email: 'doctor@acme.com', ID: 'assertion-1' },
      loggedOut: false,
    });
    ctx.idpResolver.resolveSamlByProviderId.mockResolvedValue({ client, provider });
    ctx.federatedIdentityRepository.findByProviderAndSubject.mockResolvedValue(
      FederatedIdentityFactory.CreateFederatedIdentity({ tenantId: TENANT, userId: 'user-1', providerId: provider.id, subject: 'adfs-nameid-1' }),
    );
    ctx.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'saml:x', resourceStatus: ResourceStatusType.ENABLED });

    await expect(
      ctx.svc.verifySamlResponse({ tenantKey: 'acme', samlResponse: 'base64response', acsUrl: ACS_URL }),
    ).resolves.toBeDefined();
  });
});
