/**
 * TASK-762 §5.5 — the THIRD auth branch in `UnifiedAuthGuard`.
 *
 * The invariants under test are the ones that keep the three credential classes
 * genuinely separate rather than separate-by-convention:
 *
 *  - `@ForbidApiKey()` and `@ForbidServiceAccount()` are INDEPENDENT. Reusing
 *    one decorator for both would re-create exactly the "one mechanism, two
 *    purposes" conflation the TASK-708 §6 owner ruling forbids.
 *  - Scopes and abilities are a CONJUNCTION in both directions, never a
 *    fallback — the same rule the API-key path enforces.
 *  - `isSuperAdmin` reflects the account's CONFIGURED value. §2.7: a principal
 *    that omits `roles` silently fails every super-admin check, one that fills
 *    it carelessly silently becomes a super admin. Both directions are pinned.
 *  - A request presenting two credential classes is REJECTED, never silently
 *    resolved to one of them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PolicyEngine, AppAbility } from '../policy.engine';
import { REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY } from '../authorization.guard';
import {
  UnifiedAuthGuard,
  API_KEY_FORBIDDEN,
  API_KEY_REQUIRED_SCOPES,
  SERVICE_ACCOUNT_FORBIDDEN,
  SERVICE_ACCOUNT_REQUIRED_SCOPES,
  SERVICE_ACCOUNT_TOKEN_HEADER,
} from '../unified-auth.guard';
import { IApiKeyService } from '../../services/apiKey/IApiKeyService';
import { isSuperAdmin } from '../../common/tenant-guards';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

const createMockAbility = (permissions: Record<string, boolean>): AppAbility =>
  ({ can: vi.fn((a: string, s: string) => permissions[`${a}:${s}`] ?? false), cannot: vi.fn(), relevantRuleFor: vi.fn() }) as unknown as AppAbility;

const createMockContext = (headers: Record<string, string> = {}) => {
  const request = { headers, method: 'POST', url: '/api/v1/admin/departments', ip: '127.0.0.1', params: {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
};

function principal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sa-1',
    clientId: 'hope_svc_x',
    tenantId: TENANT_A,
    workingTenantId: TENANT_A,
    scopes: ['svc:admin:department:manage'],
    roles: [],
    allowedTenantIds: null,
    ...overrides,
  };
}

describe('UnifiedAuthGuard — service-account branch', () => {
  let guard: UnifiedAuthGuard;
  let reflector: Reflector;
  let apiKeyService: any;
  let policyEngine: any;
  let clsService: any;
  let serviceAccountService: any;
  let metadata: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    metadata = {};

    reflector = { getAllAndOverride: vi.fn((key: string) => metadata[key]) } as unknown as Reflector;
    apiKeyService = { extractApiKeyFromRequest: vi.fn(() => null), authenticateByRawKey: vi.fn(), hasScope: vi.fn(() => true) };
    policyEngine = { buildAbility: vi.fn(), buildAbilityFromRules: vi.fn(() => createMockAbility({ 'manage:Department': true })) };
    clsService = { get: vi.fn(() => undefined), set: vi.fn() };
    serviceAccountService = {
      authenticateByToken: vi.fn(async () => principal()),
      hasScope: vi.fn((p: any, required: string) => (p.scopes as string[]).some((s) => s === required || required.startsWith(`${s.replace(/\*$/, '')}`))),
      serviceAccountRules: vi.fn(() => [{ action: 'manage', subject: 'Department' }]),
    };

    guard = new UnifiedAuthGuard(
      reflector,
      apiKeyService as unknown as typeof IApiKeyService,
      policyEngine as PolicyEngine,
      clsService,
      undefined,
      undefined,
      serviceAccountService,
    );

    metadata[SERVICE_ACCOUNT_REQUIRED_SCOPES] = ['svc:admin:department:manage'];
    metadata[REQUIRED_PERMISSIONS_KEY] = [{ action: 'manage', subject: 'Department' }];
  });

  const withToken = () => createMockContext({ [SERVICE_ACCOUNT_TOKEN_HEADER]: 'opaque-token' });

  it('authenticates a valid token and publishes the principal on its OWN CLS key', async () => {
    await expect(guard.canActivate(withToken())).resolves.toBe(true);
    expect(clsService.set).toHaveBeenCalledWith('serviceAccount', expect.objectContaining({ id: 'sa-1' }));
    // NEVER on `user` — every requestUser?.id read would otherwise see a machine as a person.
    expect(clsService.set).not.toHaveBeenCalledWith('user', expect.anything());
  });

  it('rejects an unknown/expired token with 401 (test 19)', async () => {
    serviceAccountService.authenticateByToken.mockResolvedValue(null);
    await expect(guard.canActivate(withToken())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('@ForbidServiceAccount() → 403 even for a token holding svc:* (test 23)', async () => {
    metadata[SERVICE_ACCOUNT_FORBIDDEN] = true;
    serviceAccountService.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:*'] }));
    await expect(guard.canActivate(withToken())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('@ForbidApiKey() alone does NOT block a service-account token — the decorators are independent (test 24)', async () => {
    metadata[API_KEY_FORBIDDEN] = true;
    await expect(guard.canActivate(withToken())).resolves.toBe(true);
  });

  it('@ForbidServiceAccount() alone does NOT block an API key — the mirror of the above', async () => {
    metadata[SERVICE_ACCOUNT_FORBIDDEN] = true;
    metadata[API_KEY_REQUIRED_SCOPES] = ['admin:department:manage'];
    apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key');
    apiKeyService.authenticateByRawKey.mockResolvedValue({ id: 'k1', tenantId: TENANT_A, userId: 'u1', scopes: ['admin:department:manage'] });
    policyEngine.buildAbility.mockResolvedValue(createMockAbility({ 'manage:Department': true }));

    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);
  });

  it('denies by default: a route declaring no svc:* scope is not a service-account surface (test 25 mirror)', async () => {
    delete metadata[SERVICE_ACCOUNT_REQUIRED_SCOPES];
    await expect(guard.canActivate(withToken())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies a token missing the required svc:* scope even when its ability would allow (test 25)', async () => {
    serviceAccountService.authenticateByToken.mockResolvedValue(principal({ scopes: ['svc:admin:tenant:manage'] }));
    serviceAccountService.hasScope.mockReturnValue(false);
    await expect(guard.canActivate(withToken())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies a token holding the scope but lacking the ability — conjunction, both directions (test 26)', async () => {
    policyEngine.buildAbilityFromRules.mockReturnValue(createMockAbility({ 'manage:Department': false }));
    await expect(guard.canActivate(withToken())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('builds the ability for the ACCOUNT, never for a bound human', async () => {
    await guard.canActivate(withToken());
    expect(policyEngine.buildAbility).not.toHaveBeenCalled();
    expect(policyEngine.buildAbilityFromRules).toHaveBeenCalled();
  });

  it('isSuperAdmin reflects the account CONFIGURED value — elevated (test 27a)', async () => {
    serviceAccountService.authenticateByToken.mockResolvedValue(principal({ roles: ['SUPER_ADMIN'] }));
    await guard.canActivate(withToken());
    const published = clsService.set.mock.calls.find((c: unknown[]) => c[0] === 'serviceAccount')?.[1];
    expect(isSuperAdmin(published)).toBe(true);
  });

  it('isSuperAdmin reflects the account CONFIGURED value — not elevated (test 27b)', async () => {
    await guard.canActivate(withToken());
    const published = clsService.set.mock.calls.find((c: unknown[]) => c[0] === 'serviceAccount')?.[1];
    // `roles` is present and EMPTY — never undefined, which would make every
    // imperative super-admin check silently false rather than deliberately so.
    expect(published.roles).toEqual([]);
    expect(isSuperAdmin(published)).toBe(false);
  });

  it('rejects a request presenting BOTH a service token and an API key — never silently resolves one (test 28)', async () => {
    apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key');
    await expect(guard.canActivate(withToken())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(serviceAccountService.authenticateByToken).not.toHaveBeenCalled();
    expect(apiKeyService.authenticateByRawKey).not.toHaveBeenCalled();
  });

  it('is skipped entirely on a @Public() route', async () => {
    metadata[SKIP_AUTH_KEY] = true;
    await expect(guard.canActivate(withToken())).resolves.toBe(true);
    expect(serviceAccountService.authenticateByToken).not.toHaveBeenCalled();
  });

  it('sets the request tenant from the principal WORKING tenant, not its home tenant', async () => {
    serviceAccountService.authenticateByToken.mockResolvedValue(
      principal({ tenantId: '00000000-0000-0000-0000-000000000000', workingTenantId: TENANT_A }),
    );
    await guard.canActivate(withToken());
    expect(clsService.set).toHaveBeenCalledWith('tenantId', TENANT_A);
  });
});
