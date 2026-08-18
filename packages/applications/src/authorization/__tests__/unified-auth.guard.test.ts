import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PolicyEngine, AppAbility } from '../policy.engine';
import { REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY, PERMISSION_MODE_KEY } from '../authorization.guard';
import { UnifiedAuthGuard, JWT_AUTH_GUARD, API_KEY_REQUIRED_SCOPES } from '../unified-auth.guard';
import { IApiKeyService } from '../../services/apiKey/IApiKeyService';
import { IApiKeyRateLimiter } from '../../services/apiKey/apikey-rate-limiter.service';

const createMockAbility = (permissions: Record<string, boolean>): AppAbility =>
  ({
    can: vi.fn((action: string, subject: string) => {
      return permissions[`${action}:${subject}`] ?? false;
    }),
    cannot: vi.fn(),
    relevantRuleFor: vi.fn(),
  }) as unknown as AppAbility;

const createMockContext = (overrides: any = {}) => {
  const request = {
    headers: {},
    method: 'GET',
    url: '/test',
    ip: '127.0.0.1',
    params: {},
    ...overrides,
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
};

const MOCK_API_KEY_ENTITY = {
  id: 'key-1',
  keyName: 'test-key',
  tenantId: 'tenant-1',
  userId: 'user-api-1',
  scopes: ['read:data', 'write:data'],
  rateLimit: 100,
  allowedIps: [],
};

describe('UnifiedAuthGuard', () => {
  let guard: UnifiedAuthGuard;
  let reflector: Reflector;
  let apiKeyService: any;
  let policyEngine: PolicyEngine;
  let clsService: any;
  let rateLimiter: any;
  let jwtAuthGuard: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // TASK-742: the API-key path now DENIES any route that declares no
    // `@RequiredScopes(...)`, so a bare "everything is undefined" reflector no
    // longer represents an API-key-reachable route — it represents a route that
    // is not an API-key surface at all. Every API-key test in THIS file is
    // about some other concern (rate limiting, CLS wiring, IP extraction, error
    // wrapping, idempotency), so the default now presents a route that IS a
    // declared API-key surface. The deny-by-default rule itself is pinned
    // exhaustively in `unified-auth.guard.deny-by-default.test.ts`; tests below
    // that install their own `mockImplementation` still control it completely.
    reflector = {
      getAllAndOverride: vi.fn((key: string) => (key === API_KEY_REQUIRED_SCOPES ? ['read:data'] : undefined)),
    } as unknown as Reflector;

    apiKeyService = {
      extractApiKeyFromRequest: vi.fn().mockReturnValue(null),
      authenticateByRawKey: vi.fn(),
      hasScope: vi.fn().mockReturnValue(true),
    };

    policyEngine = {
      buildAbility: vi.fn(),
    } as unknown as PolicyEngine;

    clsService = {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
    };

    rateLimiter = {
      checkRateLimit: vi.fn().mockResolvedValue({
        allowed: true,
        remaining: 99,
        limit: 100,
        resetAt: new Date(),
      }),
    };

    jwtAuthGuard = {
      canActivate: vi.fn().mockResolvedValue(true),
    };

    guard = new UnifiedAuthGuard(reflector, apiKeyService, policyEngine, clsService, rateLimiter, jwtAuthGuard);
  });

  // ─── 1. Public Routes ─────────────────────────────────────────────

  describe('public routes', () => {
    it('should return true when SKIP_AUTH_KEY metadata is set', async () => {
      const context = createMockContext();
      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === SKIP_AUTH_KEY) return true;
        return undefined;
      });

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(apiKeyService.extractApiKeyFromRequest).not.toHaveBeenCalled();
    });

    it('should return true when legacy isPublic key is set', async () => {
      const context = createMockContext();
      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === SKIP_AUTH_KEY) return false;
        if (key === 'isPublic') return true;
        return undefined;
      });

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(apiKeyService.extractApiKeyFromRequest).not.toHaveBeenCalled();
    });
  });

  // ─── 2. API Key Auth Path ─────────────────────────────────────────

  describe('API key authentication', () => {
    it('should return true for a valid API key', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue({ ...MOCK_API_KEY_ENTITY, rateLimit: 0 });

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
    });

    it('should delegate to authenticateByRawKey with ip address', async () => {
      const context = createMockContext({ ip: '10.0.0.1' });
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue({ ...MOCK_API_KEY_ENTITY, rateLimit: 0 });

      await guard.canActivate(context);

      expect(apiKeyService.authenticateByRawKey).toHaveBeenCalledWith('raw-key-123', '10.0.0.1');
    });

    it('should check rate limit when configured', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue(MOCK_API_KEY_ENTITY);

      await guard.canActivate(context);

      expect(rateLimiter.checkRateLimit).toHaveBeenCalledWith('key-1', 'tenant-1', 100);
    });

    it('should throw 429 when rate limit exceeded', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue(MOCK_API_KEY_ENTITY);
      rateLimiter.checkRateLimit.mockResolvedValue({
        allowed: false,
        remaining: 0,
        limit: 100,
        resetAt: new Date('2026-01-01'),
      });

      try {
        await guard.canActivate(context);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(429);
      }
    });

    it('should skip rate limit when rateLimit is 0 or not set', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue({ ...MOCK_API_KEY_ENTITY, rateLimit: 0 });

      await guard.canActivate(context);

      expect(rateLimiter.checkRateLimit).not.toHaveBeenCalled();
    });

    it('should check scopes when API_KEY_REQUIRED_SCOPES metadata is present', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue({ ...MOCK_API_KEY_ENTITY, rateLimit: 0 });
      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === API_KEY_REQUIRED_SCOPES) return ['read:data'];
        return undefined;
      });

      await guard.canActivate(context);

      expect(apiKeyService.hasScope).toHaveBeenCalledWith(expect.objectContaining({ id: 'key-1' }), 'read:data');
    });

    it('should throw 403 when scopes are insufficient', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue({ ...MOCK_API_KEY_ENTITY, rateLimit: 0 });
      apiKeyService.hasScope.mockReturnValue(false);
      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === API_KEY_REQUIRED_SCOPES) return ['admin:manage'];
        return undefined;
      });

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(context)).rejects.toThrow('API key does not have required scope(s): admin:manage');
    });

    it('should set request.apiKey on successful API key auth', async () => {
      const context = createMockContext();
      const request = context.switchToHttp().getRequest();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue({ ...MOCK_API_KEY_ENTITY, rateLimit: 0 });

      await guard.canActivate(context);

      expect(request['apiKey']).toEqual(expect.objectContaining({ id: 'key-1' }));
    });

    it('should set CLS user and tenantId context from API key', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue({ ...MOCK_API_KEY_ENTITY, rateLimit: 0 });

      await guard.canActivate(context);

      expect(clsService.set).toHaveBeenCalledWith('user', {
        id: 'user-api-1',
        tenantId: 'tenant-1',
      });
      expect(clsService.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
    });
  });

  // ─── 3. JWT Auth Path ─────────────────────────────────────────────

  describe('JWT authentication', () => {
    it('should fall through to JWT when no API key header present', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue(null);

      await guard.canActivate(context);

      expect(jwtAuthGuard.canActivate).toHaveBeenCalledWith(context);
    });

    it('should delegate to jwtAuthGuard.canActivate', async () => {
      const context = createMockContext();

      await guard.canActivate(context);

      expect(jwtAuthGuard.canActivate).toHaveBeenCalledWith(context);
    });

    it('should check CASL permissions after JWT succeeds', async () => {
      const context = createMockContext();
      const mockAbility = createMockAbility({ 'read:User': true });
      const mockUser = { id: 'jwt-user-1', tenantId: 'tenant-1' };

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === REQUIRED_PERMISSIONS_KEY) return [{ action: 'read', subject: 'User' }];
        if (key === PERMISSION_MODE_KEY) return 'AND';
        return undefined;
      });
      clsService.get.mockImplementation((key: string) => {
        if (key === 'user') return mockUser;
        return undefined;
      });
      (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(policyEngine.buildAbility).toHaveBeenCalledWith({
        userId: 'jwt-user-1',
        tenantId: 'tenant-1',
        params: {},
      });
    });

    it('should throw 403 when CASL permissions are denied', async () => {
      const context = createMockContext();
      const mockAbility = createMockAbility({ 'read:User': false });
      const mockUser = { id: 'jwt-user-1', tenantId: 'tenant-1' };

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === REQUIRED_PERMISSIONS_KEY) return [{ action: 'read', subject: 'User' }];
        if (key === PERMISSION_MODE_KEY) return 'AND';
        return undefined;
      });
      clsService.get.mockImplementation((key: string) => {
        if (key === 'user') return mockUser;
        return undefined;
      });
      (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(context)).rejects.toThrow('Missing permissions: read:User');
    });

    it('should set request.ability after CASL check', async () => {
      const context = createMockContext();
      const request = context.switchToHttp().getRequest();
      const mockAbility = createMockAbility({ 'read:User': true });
      const mockUser = { id: 'jwt-user-1', tenantId: 'tenant-1' };

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === REQUIRED_PERMISSIONS_KEY) return [{ action: 'read', subject: 'User' }];
        if (key === PERMISSION_MODE_KEY) return 'AND';
        return undefined;
      });
      clsService.get.mockImplementation((key: string) => {
        if (key === 'user') return mockUser;
        return undefined;
      });
      (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

      await guard.canActivate(context);

      expect(request.ability).toBe(mockAbility);
      expect(clsService.set).toHaveBeenCalledWith('userAbility', mockAbility);
    });
  });

  // ─── 4. No Auth ───────────────────────────────────────────────────

  describe('no authentication', () => {
    it('should throw 401 when both API key and JWT fail', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue(null);
      jwtAuthGuard.canActivate.mockRejectedValue(new Error('JWT invalid'));

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow(
        'Authentication required. Provide a valid JWT (Authorization: Bearer) or API key (X-API-Key).',
      );
    });
  });

  // ─── 5. Priority ─────────────────────────────────────────────────

  describe('priority', () => {
    it('should use API key auth when both API key and JWT are available', async () => {
      const context = createMockContext({
        headers: { authorization: 'Bearer some-token', 'x-api-key': 'raw-key' },
      });
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key');
      apiKeyService.authenticateByRawKey.mockResolvedValue({ ...MOCK_API_KEY_ENTITY, rateLimit: 0 });

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(jwtAuthGuard.canActivate).not.toHaveBeenCalled();
    });
  });

  // ─── 6. No JWT Guard ──────────────────────────────────────────────

  describe('no JWT guard injected', () => {
    it('should work with only API key auth when JWT guard is not provided', async () => {
      const guardWithoutJwt = new UnifiedAuthGuard(reflector, apiKeyService, policyEngine, clsService, rateLimiter, undefined);

      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue({ ...MOCK_API_KEY_ENTITY, rateLimit: 0 });

      const result = await guardWithoutJwt.canActivate(context);
      expect(result).toBe(true);
    });

    it('should throw 401 when no JWT guard and no API key', async () => {
      const guardWithoutJwt = new UnifiedAuthGuard(reflector, apiKeyService, policyEngine, clsService, rateLimiter, undefined);

      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue(null);

      await expect(guardWithoutJwt.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });
  });

  // ─── 7. Edge Cases ────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should extract client IP from x-forwarded-for header', async () => {
      const context = createMockContext({
        headers: { 'x-forwarded-for': '203.0.113.50, 70.41.3.18' },
      });
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue({ ...MOCK_API_KEY_ENTITY, rateLimit: 0 });

      await guard.canActivate(context);

      expect(apiKeyService.authenticateByRawKey).toHaveBeenCalledWith('raw-key-123', '203.0.113.50');
    });

    it('should allow JWT-authenticated request with no CASL requirements', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue(null);

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === REQUIRED_PERMISSIONS_KEY) return [];
        return undefined;
      });

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(policyEngine.buildAbility).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException when PolicyEngine fails to build ability', async () => {
      const context = createMockContext();
      const mockUser = { id: 'jwt-user-1', tenantId: 'tenant-1' };

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === REQUIRED_PERMISSIONS_KEY) return [{ action: 'read', subject: 'User' }];
        return undefined;
      });
      clsService.get.mockImplementation((key: string) => {
        if (key === 'user') return mockUser;
        return undefined;
      });
      (policyEngine.buildAbility as any).mockRejectedValue(new Error('DB error'));

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(context)).rejects.toThrow('Authorization failed');
    });

    it('should support OR permission mode after JWT auth', async () => {
      const context = createMockContext();
      const mockAbility = createMockAbility({
        'manage:User': false,
        'read:AuditLog': true,
      });
      const mockUser = { id: 'jwt-user-1', tenantId: 'tenant-1' };

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === REQUIRED_PERMISSIONS_KEY)
          return [
            { action: 'manage', subject: 'User' },
            { action: 'read', subject: 'AuditLog' },
          ];
        if (key === PERMISSION_MODE_KEY) return 'OR';
        return undefined;
      });
      clsService.get.mockImplementation((key: string) => {
        if (key === 'user') return mockUser;
        return undefined;
      });
      (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should skip rate limit when rateLimiter is not injected', async () => {
      const guardNoRateLimiter = new UnifiedAuthGuard(reflector, apiKeyService, policyEngine, clsService, undefined, jwtAuthGuard);

      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue(MOCK_API_KEY_ENTITY);

      const result = await guardNoRateLimiter.canActivate(context);
      expect(result).toBe(true);
    });
  });

  // ─── 8. API Key Error Wrapping ────────────────────────────────────

  describe('API key auth error wrapping', () => {
    it('should convert non-HttpException API key errors to UnauthorizedException', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockRejectedValue(new Error('DB connection failed'));

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Invalid API key');
    });

    it('should re-throw HttpException from API key auth path', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockRejectedValue(new ForbiddenException('IP blocked'));

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(context)).rejects.toThrow('IP blocked');
    });
  });

  // ─── 9. API Key CLS Context Edge Cases ────────────────────────────

  describe('API key CLS context edge cases', () => {
    it('should not set CLS user when API key has no userId', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue({
        ...MOCK_API_KEY_ENTITY,
        userId: null,
        rateLimit: 0,
      });

      await guard.canActivate(context);

      const userCalls = clsService.set.mock.calls.filter((call: any[]) => call[0] === 'user');
      expect(userCalls).toHaveLength(0);
    });

    it('should not overwrite CLS tenantId when already set', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue({
        ...MOCK_API_KEY_ENTITY,
        rateLimit: 0,
      });
      clsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'existing-tenant';
        return undefined;
      });

      await guard.canActivate(context);

      const tenantCalls = clsService.set.mock.calls.filter((call: any[]) => call[0] === 'tenantId');
      expect(tenantCalls).toHaveLength(0);
    });
  });

  // ─── 10. JWT User Resolution & CLS ────────────────────────────────

  describe('JWT user resolution and CLS context', () => {
    it('should prefer request.user over CLS user', async () => {
      const requestUser = { id: 'req-user-1', tenantId: 'tenant-req' };
      const clsUser = { id: 'cls-user-99', tenantId: 'tenant-cls' };
      const context = createMockContext({ user: requestUser });
      const mockAbility = createMockAbility({ 'read:User': true });

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === REQUIRED_PERMISSIONS_KEY) return [{ action: 'read', subject: 'User' }];
        if (key === PERMISSION_MODE_KEY) return 'AND';
        return undefined;
      });
      clsService.get.mockImplementation((key: string) => {
        if (key === 'user') return clsUser;
        return undefined;
      });
      (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

      await guard.canActivate(context);

      expect(policyEngine.buildAbility).toHaveBeenCalledWith(expect.objectContaining({ userId: 'req-user-1' }));
    });

    it('should set CLS user from request.user when CLS has no user', async () => {
      const requestUser = { id: 'req-user-2', tenantId: 'tenant-req' };
      const context = createMockContext({ user: requestUser });

      clsService.get.mockImplementation(() => undefined);

      await guard.canActivate(context);

      expect(clsService.set).toHaveBeenCalledWith('user', requestUser);
    });

    it('should not overwrite CLS user when already set', async () => {
      const requestUser = { id: 'req-user-3', tenantId: 'tenant-req' };
      const clsUser = { id: 'cls-user-3', tenantId: 'tenant-cls' };
      const context = createMockContext({ user: requestUser });

      clsService.get.mockImplementation((key: string) => {
        if (key === 'user') return clsUser;
        return undefined;
      });

      await guard.canActivate(context);

      const userSetCalls = clsService.set.mock.calls.filter((call: any[]) => call[0] === 'user');
      expect(userSetCalls).toHaveLength(0);
    });

    it('should set CLS tenantId from user when not already set', async () => {
      const requestUser = { id: 'req-user-4', tenantId: 'tenant-from-user' };
      const context = createMockContext({ user: requestUser });

      clsService.get.mockImplementation(() => undefined);

      await guard.canActivate(context);

      expect(clsService.set).toHaveBeenCalledWith('tenantId', 'tenant-from-user');
    });

    it('should not set CLS tenantId when user has no tenantId', async () => {
      const requestUser = { id: 'req-user-5', tenantId: undefined };
      const context = createMockContext({ user: requestUser });

      clsService.get.mockImplementation(() => undefined);

      await guard.canActivate(context);

      const tenantCalls = clsService.set.mock.calls.filter((call: any[]) => call[0] === 'tenantId');
      expect(tenantCalls).toHaveLength(0);
    });
  });

  // ─── 11. JWT No User With Required Permissions ────────────────────

  describe('JWT no user with required permissions', () => {
    it('should throw ForbiddenException when JWT passes but no user and permissions required', async () => {
      const context = createMockContext();

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === REQUIRED_PERMISSIONS_KEY) return [{ action: 'manage', subject: 'Tenant' }];
        if (key === PERMISSION_MODE_KEY) return 'AND';
        return undefined;
      });
      clsService.get.mockImplementation(() => undefined);

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(context)).rejects.toThrow('Authentication required');
    });
  });

  // ─── 12. OR Mode Denial Message ───────────────────────────────────

  describe('OR mode permission denial message', () => {
    it('should list all required permissions in OR mode denial message', async () => {
      const context = createMockContext();
      const mockAbility = createMockAbility({
        'manage:Tenant': false,
        'delete:User': false,
      });
      const mockUser = { id: 'jwt-user-or', tenantId: 'tenant-1' };

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === REQUIRED_PERMISSIONS_KEY)
          return [
            { action: 'manage', subject: 'Tenant' },
            { action: 'delete', subject: 'User' },
          ];
        if (key === PERMISSION_MODE_KEY) return 'OR';
        return undefined;
      });
      clsService.get.mockImplementation((key: string) => {
        if (key === 'user') return mockUser;
        return undefined;
      });
      (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(context)).rejects.toThrow('Requires at least one of: manage:Tenant, delete:User');
    });
  });

  // ─── 13. getClientIp Edge Cases ───────────────────────────────────

  describe('getClientIp edge cases', () => {
    it('should handle x-forwarded-for as array', async () => {
      const context = createMockContext({
        headers: { 'x-forwarded-for': ['203.0.113.50, 70.41.3.18', '10.0.0.1'] },
      });
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue({
        ...MOCK_API_KEY_ENTITY,
        rateLimit: 0,
      });

      await guard.canActivate(context);

      expect(apiKeyService.authenticateByRawKey).toHaveBeenCalledWith('raw-key-123', '203.0.113.50');
    });

    it('should fall back to socket.remoteAddress when ip is undefined', async () => {
      const context = createMockContext({
        ip: undefined,
        socket: { remoteAddress: '192.168.1.1' },
      });
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue({
        ...MOCK_API_KEY_ENTITY,
        rateLimit: 0,
      });

      await guard.canActivate(context);

      expect(apiKeyService.authenticateByRawKey).toHaveBeenCalledWith('raw-key-123', '192.168.1.1');
    });

    it('should return "unknown" when no IP source available', async () => {
      const context = createMockContext({
        ip: undefined,
        headers: {},
      });
      apiKeyService.extractApiKeyFromRequest.mockReturnValue('raw-key-123');
      apiKeyService.authenticateByRawKey.mockResolvedValue({
        ...MOCK_API_KEY_ENTITY,
        rateLimit: 0,
      });

      await guard.canActivate(context);

      expect(apiKeyService.authenticateByRawKey).toHaveBeenCalledWith('raw-key-123', 'unknown');
    });
  });

  // ─── 14. Idempotency (single enforcement per request) ──
  describe('idempotency', () => {
    it('memoises the success path: two canActivate calls on one request build the CASL ability once and return true twice', async () => {
      const context = createMockContext();
      const mockAbility = createMockAbility({ 'read:User': true });
      const mockUser = { id: 'jwt-user-1', tenantId: 'tenant-1' };

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === REQUIRED_PERMISSIONS_KEY) return [{ action: 'read', subject: 'User' }];
        if (key === PERMISSION_MODE_KEY) return 'AND';
        return undefined;
      });
      clsService.get.mockImplementation((key: string) => (key === 'user' ? mockUser : undefined));
      (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

      const first = await guard.canActivate(context);
      const second = await guard.canActivate(context);

      expect(first).toBe(true);
      expect(second).toBe(true);
      // The expensive work (CASL build + JWT pass) runs EXACTLY once across
      // both passes — the 2nd pass short-circuits on the request-scoped memo.
      expect(policyEngine.buildAbility).toHaveBeenCalledTimes(1);
      expect(jwtAuthGuard.canActivate).toHaveBeenCalledTimes(1);
    });

    it('does NOT memoise across different requests (each fresh request re-authenticates)', async () => {
      const mockAbility = createMockAbility({ 'read:User': true });
      const mockUser = { id: 'jwt-user-1', tenantId: 'tenant-1' };

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === REQUIRED_PERMISSIONS_KEY) return [{ action: 'read', subject: 'User' }];
        if (key === PERMISSION_MODE_KEY) return 'AND';
        return undefined;
      });
      clsService.get.mockImplementation((key: string) => (key === 'user' ? mockUser : undefined));
      (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

      await guard.canActivate(createMockContext());
      await guard.canActivate(createMockContext());

      // Two distinct request objects → two independent authentications.
      expect(policyEngine.buildAbility).toHaveBeenCalledTimes(2);
    });
  });

  // ─── 15. Swallowed JWT error is now logged ─────────────
  describe('swallowed-error diagnostics', () => {
    it('logs a swallowed UnauthorizedException at DEBUG while the client still gets the generic 401', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue(null);
      jwtAuthGuard.canActivate.mockRejectedValue(new UnauthorizedException('jwt expired'));

      const debugSpy = vi.spyOn((guard as any).logger, 'debug').mockImplementation(() => undefined);
      const warnSpy = vi.spyOn((guard as any).logger, 'warn').mockImplementation(() => undefined);

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow(
        'Authentication required. Provide a valid JWT (Authorization: Bearer) or API key (X-API-Key).',
      );

      // The underlying reason is logged (was previously swallowed by `catch {}`).
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'JWT/ticket auth failed; falling through to 401',
          reason: 'jwt expired',
        }),
      );
      // An expected auth failure is debug noise — NOT escalated to the
      // "unexpected error" warn branch.
      expect(warnSpy).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Unexpected error during JWT auth' }));
    });

    it('logs an unexpected (non-UnauthorizedException) JWT error at WARN', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue(null);
      jwtAuthGuard.canActivate.mockRejectedValue(new Error('redis down'));

      const warnSpy = vi.spyOn((guard as any).logger, 'warn').mockImplementation(() => undefined);

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Unexpected error during JWT auth',
          reason: 'redis down',
        }),
      );
    });
  });

  // ─── 16. 403 (permission denied) ≠ 401 (unauthenticated) ─
  describe('403 stays distinct from 401', () => {
    it('throws ForbiddenException (403), NOT UnauthorizedException, when JWT succeeds but CASL denies', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue(null);
      jwtAuthGuard.canActivate.mockResolvedValue(true);
      const mockAbility = createMockAbility({ 'read:User': false });
      const mockUser = { id: 'jwt-user-1', tenantId: 'tenant-1' };

      (reflector.getAllAndOverride as any).mockImplementation((key: string) => {
        if (key === REQUIRED_PERMISSIONS_KEY) return [{ action: 'read', subject: 'User' }];
        if (key === PERMISSION_MODE_KEY) return 'AND';
        return undefined;
      });
      clsService.get.mockImplementation((key: string) => (key === 'user' ? mockUser : undefined));
      (policyEngine.buildAbility as any).mockResolvedValue(mockAbility);

      let caught: unknown;
      try {
        await guard.canActivate(context);
        expect.fail('should have thrown a ForbiddenException');
      } catch (error) {
        caught = error;
      }

      // The un-awaited `return this.handleJwtPostAuth(...)` lets the 403
      // escape the JWT `catch` instead of being masked as the generic 401.
      expect(caught).toBeInstanceOf(ForbiddenException);
      expect(caught).not.toBeInstanceOf(UnauthorizedException);
      expect((caught as ForbiddenException).getStatus()).toBe(403);
    });

    it('throws UnauthorizedException (401) when no credentials authenticate', async () => {
      const context = createMockContext();
      apiKeyService.extractApiKeyFromRequest.mockReturnValue(null);
      jwtAuthGuard.canActivate.mockRejectedValue(new UnauthorizedException('bad token'));

      let caught: unknown;
      try {
        await guard.canActivate(context);
        expect.fail('should have thrown an UnauthorizedException');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(UnauthorizedException);
      expect((caught as UnauthorizedException).getStatus()).toBe(401);
    });
  });
});
