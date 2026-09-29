/**
 * UnifiedAuthGuard — the logging contract (no auth behaviour change).
 *
 *  1. On a successful authentication the guard publishes the CLS keys the
 *     logger reads: `userId` and `credentialClass` (`jwt` | `apiKey` |
 *     `serviceAccount` | `anonymous`), alongside the `tenantId` it already set.
 *  2. A rejection writes NO line of its own: the reason rides on the thrown
 *     exception (`Symbol.for('hope.failureLogContext')`) and the gateway's
 *     terminal filter writes the request's single failure line with it.
 *  3. The expected pre-auth 401 for a rejected/expired JWT stays at `debug`.
 *  4. The API-key limiter's 429 carries `limiter`, `retryAfter` and the key id.
 *  5. Route fields are the template (`req.route.path`), never the URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles stand in for framework types */
import { ExecutionContext, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY } from '../authorization.guard';
import { PolicyEngine } from '../policy.engine';
import { API_KEY_REQUIRED_SCOPES, SERVICE_ACCOUNT_REQUIRED_SCOPES, SERVICE_ACCOUNT_TOKEN_HEADER, UnifiedAuthGuard } from '../unified-auth.guard';

const FAILURE_LOG_CONTEXT = Symbol.for('hope.failureLogContext');
const contextOf = (err: unknown): Record<string, unknown> | undefined => (err as Record<symbol, Record<string, unknown>>)?.[FAILURE_LOG_CONTEXT];

const createMockContext = (overrides: Record<string, unknown> = {}) => {
  const request = {
    headers: {},
    method: 'GET',
    url: '/api/v1/items/abc?secret=hunter2',
    route: { path: '/api/v1/items/:id' },
    ip: '127.0.0.1',
    params: {},
    ...overrides,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
};

const allowAll = { can: vi.fn(() => true), cannot: vi.fn(), relevantRuleFor: vi.fn() };

describe('UnifiedAuthGuard — logging contract', () => {
  let metadata: Record<string, unknown>;
  let reflector: Reflector;
  let apiKeyService: any;
  let policyEngine: any;
  let cls: any;
  let rateLimiter: any;
  let jwtAuthGuard: any;
  let serviceAccounts: any;
  let guard: UnifiedAuthGuard;
  let logSpies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    metadata = {};
    reflector = { getAllAndOverride: vi.fn((key: string) => metadata[key]) } as unknown as Reflector;
    apiKeyService = { extractApiKeyFromRequest: vi.fn(() => null), authenticateByRawKey: vi.fn(), hasScope: vi.fn(() => true) };
    policyEngine = { buildAbility: vi.fn(async () => allowAll), buildAbilityFromRules: vi.fn(() => allowAll) };
    const store = new Map<string, unknown>();
    cls = { get: vi.fn((k: string) => store.get(k)), set: vi.fn((k: string, v: unknown) => store.set(k, v)) };
    rateLimiter = { checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9, limit: 10, resetAt: new Date() })) };
    jwtAuthGuard = { canActivate: vi.fn(async () => true) };
    serviceAccounts = {
      authenticateByToken: vi.fn(async () => ({
        id: 'sa-1',
        clientId: 'c',
        tenantId: 't-sa',
        workingTenantId: 't-sa',
        scopes: ['svc:x'],
        roles: [],
      })),
      hasScope: vi.fn(() => true),
    };
    guard = new UnifiedAuthGuard(reflector, apiKeyService, policyEngine as PolicyEngine, cls, rateLimiter, jwtAuthGuard, serviceAccounts);
    const logger = (guard as any).logger;
    logSpies = ['warn', 'error', 'debug', 'log'].map((m) => vi.spyOn(logger, m).mockImplementation(() => undefined));
  });

  const warnOrError = () => logSpies[0].mock.calls.length + logSpies[1].mock.calls.length;

  describe('CLS keys on success', () => {
    it('JWT → userId + credentialClass=jwt + tenantId', async () => {
      await guard.canActivate(createMockContext({ user: { id: 'u-1', tenantId: 't-1' } }));
      expect(cls.set).toHaveBeenCalledWith('userId', 'u-1');
      expect(cls.set).toHaveBeenCalledWith('credentialClass', 'jwt');
      expect(cls.set).toHaveBeenCalledWith('tenantId', 't-1');
    });

    it('API key → userId (the bound human) + credentialClass=apiKey', async () => {
      metadata[API_KEY_REQUIRED_SCOPES] = ['read:data'];
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw');
      apiKeyService.authenticateByRawKey.mockResolvedValue({ id: 'k-1', tenantId: 't-2', userId: 'u-2', scopes: ['read:data'] });
      await guard.canActivate(createMockContext());
      expect(cls.set).toHaveBeenCalledWith('userId', 'u-2');
      expect(cls.set).toHaveBeenCalledWith('credentialClass', 'apiKey');
    });

    it('service account → credentialClass=serviceAccount, no userId', async () => {
      metadata[SERVICE_ACCOUNT_REQUIRED_SCOPES] = ['svc:x'];
      await guard.canActivate(createMockContext({ headers: { [SERVICE_ACCOUNT_TOKEN_HEADER]: 'tok' } }));
      expect(cls.set).toHaveBeenCalledWith('credentialClass', 'serviceAccount');
      expect(cls.set).not.toHaveBeenCalledWith('userId', expect.anything());
    });

    it('@Public() → credentialClass=anonymous', async () => {
      metadata[SKIP_AUTH_KEY] = true;
      await guard.canActivate(createMockContext());
      expect(cls.set).toHaveBeenCalledWith('credentialClass', 'anonymous');
    });
  });

  describe('rejections carry their reason on the exception, not on a line of their own', () => {
    it('a rejected JWT 401 is marked debug, with the reason', async () => {
      jwtAuthGuard.canActivate.mockRejectedValue(new UnauthorizedException('jwt expired'));
      const err = await guard.canActivate(createMockContext()).catch((e) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(contextOf(err)).toMatchObject({ level: 'debug', reason: 'jwt_rejected', jwtReason: 'jwt expired' });
      expect(warnOrError()).toBe(0);
    });

    it('no credential at all is a plain 401 (default warn level) with reason no_valid_credentials', async () => {
      jwtAuthGuard.canActivate.mockResolvedValue(false);
      const err = await guard.canActivate(createMockContext()).catch((e) => e);
      expect(contextOf(err)).toMatchObject({ reason: 'no_valid_credentials' });
      expect(contextOf(err)?.level).toBeUndefined();
      expect(warnOrError()).toBe(0);
    });

    it('an unexpected JWT-path error keeps its Error on the context', async () => {
      const boom = new Error('redis down');
      jwtAuthGuard.canActivate.mockRejectedValue(boom);
      const err = await guard.canActivate(createMockContext()).catch((e) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(contextOf(err)).toMatchObject({ reason: 'jwt_auth_error', error: boom });
    });

    it('a CASL denial 403 names the denied permissions and the route template', async () => {
      metadata[REQUIRED_PERMISSIONS_KEY] = [{ action: 'read', subject: 'User' }];
      policyEngine.buildAbility.mockResolvedValue({ can: vi.fn(() => false), cannot: vi.fn(), relevantRuleFor: vi.fn() });
      const err = await guard.canActivate(createMockContext({ user: { id: 'u-1', tenantId: 't-1' } })).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(contextOf(err)).toMatchObject({ reason: 'missing_permissions', route: '/api/v1/items/:id' });
      expect(JSON.stringify(contextOf(err))).not.toContain('hunter2');
      expect(warnOrError()).toBe(0);
    });
  });

  it('the API-key limiter 429 carries limiter, retryAfter and the key id', async () => {
    metadata[API_KEY_REQUIRED_SCOPES] = ['read:data'];
    apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw');
    apiKeyService.authenticateByRawKey.mockResolvedValue({ id: 'k-9', tenantId: 't-2', userId: 'u-2', scopes: ['read:data'], rateLimit: 1 });
    rateLimiter.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, limit: 1, resetAt: new Date(Date.now() + 30_000) });

    const err = await guard.canActivate(createMockContext()).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    const ctx = contextOf(err);
    expect(ctx).toMatchObject({ limiter: 'apiKey', apiKeyId: 'k-9' });
    expect(ctx?.retryAfter).toBeGreaterThanOrEqual(29);
    expect(ctx?.retryAfter).toBeLessThanOrEqual(30);
  });
});
