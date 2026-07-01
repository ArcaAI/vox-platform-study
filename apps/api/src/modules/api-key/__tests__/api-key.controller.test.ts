import { describe, it, expect, beforeEach, vi } from 'vitest';
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
            expect(result).toHaveProperty('Admin');
            expect(result).toHaveProperty('Wildcard');
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
            const sttScopes = (result['STT'] as Array<{ scope: string }>).map(s => s.scope);

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

        // TASK-390 #23 (K5) — rotate endpoint.
        it('should rotate the key and return the new raw key once (create shape)', async () => {
            mockService.rotateKey.mockResolvedValue({ newRawKey: 'hk_new_secret_raw', newApiKey: { ...fakeEntity, id: 'key-2' } });

            const result = await controller.rotate('key-1');

            expect(mockService.rotateKey).toHaveBeenCalledWith('key-1');
            expect(result.rawKey).toBe('hk_new_secret_raw');
            expect(result.apiKey.id).toBe('key-2');
        });
    });
});
