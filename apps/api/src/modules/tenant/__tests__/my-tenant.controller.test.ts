import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MyTenantController } from '../my-tenant.controller';

const SWAGGER = {
    API_OPERATION: 'swagger/apiOperation',
    API_RESPONSE: 'swagger/apiResponse',
    API_SECURITY: 'swagger/apiSecurity',
    API_TAGS: 'swagger/apiUseTags',
};

function getMethodMetadata(key: string, method: string) {
    return Reflect.getMetadata(key, MyTenantController.prototype[method]);
}

function createMockTenantService() {
    return {
        fetchById: vi.fn(),
        fetchTenantConfigs: vi.fn(),
        create: vi.fn(),
        fetchAll: vi.fn(),
        fetchAllCreatedByUser: vi.fn(),
        fetchByCodeName: vi.fn(),
        update: vi.fn(),
        deleteById: vi.fn(),
        updateTenantConfigs: vi.fn(),
        getUsageStats: vi.fn(),
    };
}

function createMockClsService(tenantId?: string, user?: { roles?: string[] }) {
    return {
        get: vi.fn((key: string) => {
            if (key === 'tenantId') return tenantId;
            if (key === 'user') return user;
            return undefined;
        }),
        set: vi.fn(),
        getId: vi.fn(),
    };
}

describe('MyTenantController', () => {
    let controller: MyTenantController;
    let tenantService: ReturnType<typeof createMockTenantService>;
    let clsService: ReturnType<typeof createMockClsService>;

    describe('me()', () => {
        it('should return tenant info when tenantId is in CLS context', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService('tenant-uuid-123');

            tenantService.fetchById.mockResolvedValue({
                id: 'tenant-uuid-123',
                name: 'Test Hospital',
                key: 'test-hospital',
                description: 'A test hospital tenant',
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            controller = new MyTenantController(tenantService as any, clsService as any);
            const result = await controller.me();

            expect(clsService.get).toHaveBeenCalledWith('tenantId');
            expect(tenantService.fetchById).toHaveBeenCalledWith('tenant-uuid-123');
            expect(result).toBeDefined();
            expect(result.name).toBe('Test Hospital');
            expect(result.key).toBe('test-hospital');
        });

        it('should throw BadRequestException when no tenantId and not super admin', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService(undefined, { roles: ['DOCTOR'] });

            controller = new MyTenantController(tenantService as any, clsService as any);

            await expect(controller.me()).rejects.toThrow(BadRequestException);
            expect(tenantService.fetchById).not.toHaveBeenCalled();
        });

        it('should throw BadRequestException when CLS has no tenantId, even for SUPER_ADMIN', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService(undefined, { roles: ['SUPER_ADMIN'] });

            controller = new MyTenantController(tenantService as any, clsService as any);

            await expect(controller.me()).rejects.toThrow(BadRequestException);
            await expect(controller.me()).rejects.toThrow(/Tenant context is required/);
            expect(tenantService.fetchByCodeName).not.toHaveBeenCalled();
            expect(tenantService.fetchById).not.toHaveBeenCalled();
        });

        it('should propagate NotFoundException when tenant not found', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService('nonexistent-tenant');

            tenantService.fetchById.mockRejectedValue(
                new NotFoundException('Tenant not found')
            );

            controller = new MyTenantController(tenantService as any, clsService as any);

            await expect(controller.me()).rejects.toThrow(NotFoundException);
        });
    });

    describe('myConfig()', () => {
        it('should return tenant configs when tenantId is in CLS context', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService('tenant-uuid-456');

            tenantService.fetchTenantConfigs.mockResolvedValue({
                data: [
                    {
                        id: 'cfg-1',
                        key: 'audio.stt.default_model',
                        value: 'whisper-large-v3',
                        name: 'Default STT Model',
                        dataType: 'STRING',
                        tenantId: 'tenant-uuid-456',
                        tenantCode: 'test-clinic',
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    },
                ],
                count: 1,
                limit: 100,
                page: 1,
            });

            controller = new MyTenantController(tenantService as any, clsService as any);
            const result = await controller.myConfig();

            expect(clsService.get).toHaveBeenCalledWith('tenantId');
            expect(tenantService.fetchTenantConfigs).toHaveBeenCalledWith(
                expect.objectContaining({ tenantId: 'tenant-uuid-456' })
            );
            expect(result).toBeDefined();
        });

        it('should request all configs with a high limit to avoid pagination truncation', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService('tenant-uuid-456');

            tenantService.fetchTenantConfigs.mockResolvedValue({
                data: [],
                count: 0,
                limit: 200,
                page: 1,
            });

            controller = new MyTenantController(tenantService as any, clsService as any);
            await controller.myConfig();

            expect(tenantService.fetchTenantConfigs).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 200, page: 1 }),
            );
        });

        it('should throw BadRequestException when no tenantId and not super admin', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService(undefined, { roles: ['DOCTOR'] });

            controller = new MyTenantController(tenantService as any, clsService as any);

            await expect(controller.myConfig()).rejects.toThrow(BadRequestException);
            expect(tenantService.fetchTenantConfigs).not.toHaveBeenCalled();
        });

        it('should throw BadRequestException for super admin with no tenantId (no silent fallback)', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService(undefined, { roles: ['SUPER_ADMIN'] });

            controller = new MyTenantController(tenantService as any, clsService as any);

            await expect(controller.myConfig()).rejects.toThrow(BadRequestException);
            expect(tenantService.fetchByCodeName).not.toHaveBeenCalled();
            expect(tenantService.fetchTenantConfigs).not.toHaveBeenCalled();
        });
    });

    describe('updateMyConfig()', () => {
        it('should update tenant configs when tenantId is in CLS context', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService('tenant-uuid-789');

            tenantService.updateTenantConfigs.mockResolvedValue({
                data: [
                    {
                        id: 'cfg-1',
                        key: 'default-language',
                        value: 'th',
                        name: 'Default Language',
                        dataType: 'STRING',
                        tenantId: 'tenant-uuid-789',
                        tenantCode: 'test-clinic',
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    },
                ],
                count: 1,
                limit: 100,
                page: 1,
            });

            controller = new MyTenantController(tenantService as any, clsService as any);
            const configs = [{ id: 'cfg-1', value: 'th' }];
            const result = await controller.updateMyConfig(configs as any);

            expect(clsService.get).toHaveBeenCalledWith('tenantId');
            expect(tenantService.updateTenantConfigs).toHaveBeenCalledWith('tenant-uuid-789', configs);
            expect(result).toBeDefined();
        });

        it('should throw BadRequestException when no tenantId and not super admin', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService(undefined, { roles: ['DOCTOR'] });

            controller = new MyTenantController(tenantService as any, clsService as any);

            await expect(controller.updateMyConfig([] as any)).rejects.toThrow(BadRequestException);
            expect(tenantService.updateTenantConfigs).not.toHaveBeenCalled();
        });

        it('should throw BadRequestException for super admin update with no tenantId (no silent fallback)', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService(undefined, { roles: ['SUPER_ADMIN'] });

            controller = new MyTenantController(tenantService as any, clsService as any);
            const configs = [{ id: 'cfg-1', value: 'th' }];

            await expect(controller.updateMyConfig(configs as any)).rejects.toThrow(BadRequestException);
            expect(tenantService.fetchByCodeName).not.toHaveBeenCalled();
            expect(tenantService.updateTenantConfigs).not.toHaveBeenCalled();
        });

        // TASK-302 Stream D Phase D (D.3.2) — the controller is annotated
        // with `@RequiresIfMatch()`, so under real HTTP traffic
        // `expectedFromHeader` is GUARANTEED to be a positive integer (the
        // 428 fires in the param decorator if it would have been undefined).
        // These unit tests cover the controller-internal logic of folding
        // the header value into each row's `expectedVersion`.
        it('TASK-302 Stream D Phase D — folds If-Match header value into each row\'s expectedVersion', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService('tenant-uuid-789');

            tenantService.updateTenantConfigs.mockResolvedValue({
                data: [],
                count: 0,
                limit: 100,
                page: 1,
            });

            controller = new MyTenantController(tenantService as any, clsService as any);
            const configs = [
                { id: 'cfg-1', value: 'th', expectedVersion: 99 },
                { id: 'cfg-2', value: 'en', expectedVersion: 99 },
            ];

            // Header carries 7 — it MUST override every row's body-field 99.
            await controller.updateMyConfig(configs as any, 7);

            expect(tenantService.updateTenantConfigs).toHaveBeenCalledWith(
                'tenant-uuid-789',
                [
                    { id: 'cfg-1', value: 'th', expectedVersion: 7 },
                    { id: 'cfg-2', value: 'en', expectedVersion: 7 },
                ],
            );
        });

        it('TASK-302 Stream D Phase D — preserves body-field expectedVersion when header is absent (service-to-service fallback)', async () => {
            // This path only fires off-route (i.e., a non-@RequiresIfMatch
            // route would let `expectedFromHeader = undefined` reach the
            // handler). Once `@RequiresIfMatch()` is on, the 428 fires
            // before the handler runs, so in production traffic this
            // branch is unreachable. Unit-testing it nonetheless documents
            // the controller's invariant.
            tenantService = createMockTenantService();
            clsService = createMockClsService('tenant-uuid-789');

            tenantService.updateTenantConfigs.mockResolvedValue({ data: [], count: 0, limit: 100, page: 1 });

            controller = new MyTenantController(tenantService as any, clsService as any);
            const configs = [
                { id: 'cfg-1', value: 'th', expectedVersion: 5 },
                { id: 'cfg-2', value: 'en', expectedVersion: 12 },
            ];

            await controller.updateMyConfig(configs as any, undefined);

            // Per-row body-field values preserved when header is absent.
            expect(tenantService.updateTenantConfigs).toHaveBeenCalledWith('tenant-uuid-789', configs);
        });
    });

    describe('OpenAPI/Swagger metadata', () => {
        it('should have @ApiTags("tenant")', () => {
            const tags = Reflect.getMetadata(SWAGGER.API_TAGS, MyTenantController);
            expect(tags).toContain('tenant');
        });

        it('should have @ApiBearerAuth()', () => {
            const security = Reflect.getMetadata(SWAGGER.API_SECURITY, MyTenantController);
            expect(security).toBeDefined();
            expect(security).toEqual(expect.arrayContaining([{ bearer: [] }]));
        });

        it('me() should have @ApiOperation', () => {
            const metadata = getMethodMetadata(SWAGGER.API_OPERATION, 'me');
            expect(metadata).toBeDefined();
            expect(metadata.summary).toBeDefined();
        });

        it('me() should have @ApiResponse for 400 (bad request - missing tenant context)', () => {
            const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'me');
            expect(responses).toBeDefined();
            expect(responses[400]).toBeDefined();
        });

        it('myConfig() should have @ApiOperation', () => {
            const metadata = getMethodMetadata(SWAGGER.API_OPERATION, 'myConfig');
            expect(metadata).toBeDefined();
            expect(metadata.summary).toBeDefined();
        });

        it('myConfig() should have @ApiResponse for 400 (bad request - missing tenant context)', () => {
            const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'myConfig');
            expect(responses).toBeDefined();
            expect(responses[400]).toBeDefined();
        });
    });
});
