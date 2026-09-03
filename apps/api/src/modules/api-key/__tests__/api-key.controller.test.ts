import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SUBJECT_INSTANCE_RESOLVER_KEY } from '@arcaai/applications';
import { ApiKeyController } from '../api-key.controller';

const createMockApiKeyService = () => ({
  create: vi.fn(),
  fetchAll: vi.fn(),
  fetchAllByTenantId: vi.fn(),
  fetchById: vi.fn(),
  update: vi.fn(),
  deleteById: vi.fn(),
  revokeKey: vi.fn(),
  rotateKey: vi.fn(),
});

const createMockClsService = () => ({
  get: vi.fn(),
});

describe('ApiKeyController', () => {
  let controller: ApiKeyController;
  let mockService: ReturnType<typeof createMockApiKeyService>;
  let mockCls: ReturnType<typeof createMockClsService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = createMockApiKeyService();
    mockCls = createMockClsService();
    controller = new ApiKeyController(mockService as any, mockCls as any);
  });

  describe('GET /admin/api-keys/scopes', () => {
    it('should return scopes grouped by category', () => {
      const result = controller.getAvailableScopes();

      expect(result).toHaveProperty('STT');
      expect(result).toHaveProperty('Consultation');
      expect(result).toHaveProperty('Wildcard');
    });

    /**
     * (policy A2) — the admin plane is JWT-only, so every `admin:*`
     * and `webhook:*` scope is RESERVED: refused at grant time and dropped from
     * this catalog. Both categories vanish entirely rather than appearing
     * empty, because advertising a scope the platform will always refuse to
     * mint is worse than not listing it.
 */
    it('does not advertise the reserved Admin / Webhook families', () => {
      const result = controller.getAvailableScopes();

      expect(result).not.toHaveProperty('Admin');
      expect(result).not.toHaveProperty('Webhook');

      const wildcard = (result['Wildcard'] as Array<{ scope: string }>).map((s) => s.scope);
      expect(wildcard).not.toContain('admin:*');
      expect(wildcard).not.toContain('webhook:*');
      // The bare '*' stays — it is the platform SERVICE_ACCOUNT wildcard for
      // /internal/*, made inert on admin by @ForbidApiKey() alone.
      expect(wildcard).toContain('*');
    });

    it('should include scope and description in each category entry', () => {
      const result = controller.getAvailableScopes();

      for (const [, scopes] of Object.entries(result)) {
        expect(Array.isArray(scopes)).toBe(true);
        for (const entry of scopes as Array<{ scope: string; description: string }>) {
          expect(entry).toHaveProperty('scope');
          expect(entry).toHaveProperty('description');
        }
      }
    });

    it('should include STT scopes in the STT category', () => {
      const result = controller.getAvailableScopes();
      const sttScopes = (result['STT'] as Array<{ scope: string }>).map((s) => s.scope);

      expect(sttScopes).toContain('stt:transcription:read');
      expect(sttScopes).toContain('stt:transcription:write');
      expect(sttScopes).toContain('stt:stream:write');
    });

    it('should not require any service dependencies', () => {
      expect(mockService.fetchAll).not.toHaveBeenCalled();
      expect(mockService.fetchById).not.toHaveBeenCalled();

      controller.getAvailableScopes();

      expect(mockService.fetchAll).not.toHaveBeenCalled();
      expect(mockService.fetchById).not.toHaveBeenCalled();
    });
  });

  describe('GET /admin/api-keys/:id/usage', () => {
    const fakeEntity = {
      id: 'key-1',
      keyName: 'test-key',
      keyPrefix: 'hk_',
      keyType: 'STANDARD',
      keyStatus: 'ACTIVE',
      scopes: ['stt:transcription:read'],
      allowedIps: null,
      rateLimit: 500,
      expiresAt: null,
      lastUsedAt: new Date('2025-06-01T00:00:00Z'),
      usageCount: 42,
      description: null,
      environment: 'production',
      userId: 'user-1',
      tenantId: 'tenant-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      resourceStatus: 'ENABLED',
      resourceStatusUpdatedAt: new Date(),
      resourceStatusUpdatedBy: 'system',
      createdBy: 'system',
      updatedBy: 'system',
    };

    it('should return totalCalls, lastUsedAt, and rateLimit only', async () => {
      mockService.fetchById.mockResolvedValue(fakeEntity);

      const result = await controller.getUsage('key-1');

      expect(result).toEqual({
        totalCalls: 42,
        lastUsedAt: new Date('2025-06-01T00:00:00Z'),
        rateLimit: 500,
      });
    });

    it('should NOT return rateLimitRemaining or rateLimitTotal', async () => {
      mockService.fetchById.mockResolvedValue(fakeEntity);

      const result = await controller.getUsage('key-1');

      expect(result).not.toHaveProperty('rateLimitRemaining');
      expect(result).not.toHaveProperty('rateLimitTotal');
    });

    it('should default usageCount to 0 when null', async () => {
      mockService.fetchById.mockResolvedValue({ ...fakeEntity, usageCount: null });

      const result = await controller.getUsage('key-1');

      expect(result.totalCalls).toBe(0);
    });

    it('should default lastUsedAt to null when undefined', async () => {
      mockService.fetchById.mockResolvedValue({ ...fakeEntity, lastUsedAt: undefined });

      const result = await controller.getUsage('key-1');

      expect(result.lastUsedAt).toBeNull();
    });

    it('should default rateLimit to 0 when null', async () => {
      mockService.fetchById.mockResolvedValue({ ...fakeEntity, rateLimit: null });

      const result = await controller.getUsage('key-1');

      expect(result.rateLimit).toBe(0);
    });

    it('should call fetchById with the correct id', async () => {
      mockService.fetchById.mockResolvedValue(fakeEntity);

      await controller.getUsage('key-1');

      expect(mockService.fetchById).toHaveBeenCalledWith('key-1');
      expect(mockService.fetchById).toHaveBeenCalledTimes(1);
    });

    it('should rotate the key and return the new raw key once (create shape)', async () => {
      mockService.rotateKey.mockResolvedValue({ newRawKey: 'hk_new_secret_raw', newApiKey: { ...fakeEntity, id: 'key-2' } });

      const result = await controller.rotate('key-1');

      expect(mockService.rotateKey).toHaveBeenCalledWith('key-1');
      expect(result.rawKey).toBe('hk_new_secret_raw');
      expect(result.apiKey.id).toBe('key-2');
    });
  });

  /**
   * WHY `read`/`update`/`delete:ApiKey` were removed from
   * `CASL_ENFORCED_PAIRS`, proven at the resolver rather than argued in prose.
   *
   * An enforced pair only ever exists to deny ONE request: the caller
   * addressing a row they do not own. This resolver cannot produce an instance
   * for that request, because it loads the row through
   * `IApiKeyService.fetchById`, which runs `assertKeyAccess` and throws 404.
   * `runCaslInstanceChecks` swallows resolver throws by design, so the pair
   * was structurally unable to move `casl_enforce_denial_total`
   * F-1). The other half of the removal — that "fixing" it by dropping the
   * assertion would replace a deliberate 404 with an existence-leaking 403 —
   * is a property of that same delegation.
   *
   * The guard-side half of this proof (identical outcomes with and without the
   * pairs listed) lives in
   * `packages/applications/src/authorization/__tests__/casl-conditions.enforce-apikey.test.ts`.
 */
  describe('subject-instance resolver (why the ApiKey pairs are unreachable)', () => {
    const descriptorFor = (method: keyof ApiKeyController) =>
      Reflect.getMetadata(SUBJECT_INSTANCE_RESOLVER_KEY, ApiKeyController.prototype[method] as object) as
        | { resolver: (req: unknown, ctx: { get: (t: unknown) => unknown }) => Promise<Record<string, unknown> | undefined>; subject?: string; enforceGrade: boolean }
        | undefined;

    const ctxFor = (service: unknown) => ({ get: () => service });

    for (const method of ['fetchById', 'getUsage', 'update', 'delete', 'revoke', 'rotate'] as const) {
      it(`${method} declares subject 'ApiKey' and never claims enforce grade`, () => {
        const descriptor = descriptorFor(method);
        expect(descriptor).toBeDefined();
        expect(descriptor?.subject).toBe('ApiKey');
        // The attestation the boot audit consumes. Claiming `true` here while
        // delegating to `fetchById` is the ONE mis-declaration
        // `assertCaslEnforcePairReachability` cannot catch.
        expect(descriptor?.enforceGrade).toBe(false);
      });
    }

    it('THE UNREACHABILITY: on a key the caller does not own the resolver THROWS — the guard can never see an instance to deny', async () => {
      const descriptor = descriptorFor('fetchById');
      const notOwned = new Error('API key not found'); // `assertKeyAccess` → NotFoundException
      mockService.fetchById.mockRejectedValue(notOwned);

      await expect(descriptor!.resolver({ params: { id: 'someone-elses-key' } }, ctxFor(mockService))).rejects.toThrow('API key not found');
      expect(mockService.fetchById).toHaveBeenCalledWith('someone-elses-key');
    });

    it('and when it does NOT throw, access was already asserted — so the instance verdict could only ever be an allow', async () => {
      const descriptor = descriptorFor('fetchById');
      mockService.fetchById.mockResolvedValue({ id: 'key-1', tenantId: 'tenant-1', userId: 'user-1' });

      await expect(descriptor!.resolver({ params: { id: 'key-1' } }, ctxFor(mockService))).resolves.toEqual({ tenantId: 'tenant-1', userId: 'user-1' });
    });

    it('no id on the request → no row is loaded at all', async () => {
      const descriptor = descriptorFor('fetchById');

      await expect(descriptor!.resolver({ params: {} }, ctxFor(mockService))).resolves.toBeUndefined();
      expect(mockService.fetchById).not.toHaveBeenCalled();
    });
  });
});
