import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException, NotFoundException } from '@nestjs/common';
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

        it('should throw UnauthorizedException when no tenantId and not super admin', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService(undefined, { roles: ['DOCTOR'] });

            controller = new MyTenantController(tenantService as any, clsService as any);

            await expect(controller.me()).rejects.toThrow(UnauthorizedException);
            expect(tenantService.fetchById).not.toHaveBeenCalled();
        });

        it('should fall back to global tenant for super admin with no tenantId', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService(undefined, { roles: ['SUPER_ADMIN'] });

            tenantService.fetchByCodeName.mockResolvedValue({
                id: 'global-tenant-id',
                name: 'Global',
                key: '__GLOBAL__',
            });
            tenantService.fetchById.mockResolvedValue({
                id: 'global-tenant-id',
                name: 'Global',
                key: '__GLOBAL__',
                description: 'System-wide default tenant',
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            controller = new MyTenantController(tenantService as any, clsService as any);
            const result = await controller.me();

            expect(tenantService.fetchByCodeName).toHaveBeenCalledWith('__GLOBAL__');
            expect(tenantService.fetchById).toHaveBeenCalledWith('global-tenant-id');
            expect(result.name).toBe('Global');
            expect(result.key).toBe('__GLOBAL__');
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

        it('should throw UnauthorizedException when no tenantId and not super admin', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService(undefined, { roles: ['DOCTOR'] });

            controller = new MyTenantController(tenantService as any, clsService as any);

            await expect(controller.myConfig()).rejects.toThrow(UnauthorizedException);
            expect(tenantService.fetchTenantConfigs).not.toHaveBeenCalled();
        });

        it('should fall back to global tenant config for super admin with no tenantId', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService(undefined, { roles: ['SUPER_ADMIN'] });

            tenantService.fetchByCodeName.mockResolvedValue({
                id: 'global-tenant-id',
                name: 'Global',
                key: '__GLOBAL__',
            });
            tenantService.fetchTenantConfigs.mockResolvedValue({
                data: [{ id: 'cfg-1', key: 'default-language', value: 'en' }],
                count: 1,
                limit: 100,
                page: 1,
            });

            controller = new MyTenantController(tenantService as any, clsService as any);
            const result = await controller.myConfig();

            expect(tenantService.fetchByCodeName).toHaveBeenCalledWith('__GLOBAL__');
            expect(tenantService.fetchTenantConfigs).toHaveBeenCalledWith(
                expect.objectContaining({ tenantId: 'global-tenant-id' }),
            );
            expect(result).toBeDefined();
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

        it('should throw UnauthorizedException when no tenantId and not super admin', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService(undefined, { roles: ['DOCTOR'] });

            controller = new MyTenantController(tenantService as any, clsService as any);

            await expect(controller.updateMyConfig([] as any)).rejects.toThrow(UnauthorizedException);
            expect(tenantService.updateTenantConfigs).not.toHaveBeenCalled();
        });

        it('should fall back to global tenant for super admin update with no tenantId', async () => {
            tenantService = createMockTenantService();
            clsService = createMockClsService(undefined, { roles: ['SUPER_ADMIN'] });

            tenantService.fetchByCodeName.mockResolvedValue({
                id: 'global-tenant-id',
                name: 'Global',
                key: '__GLOBAL__',
            });
            tenantService.updateTenantConfigs.mockResolvedValue({
                data: [{ id: 'cfg-1', key: 'default-language', value: 'th' }],
                count: 1,
                limit: 100,
                page: 1,
            });

            controller = new MyTenantController(tenantService as any, clsService as any);
            const configs = [{ id: 'cfg-1', value: 'th' }];
            const result = await controller.updateMyConfig(configs as any);

            expect(tenantService.fetchByCodeName).toHaveBeenCalledWith('__GLOBAL__');
            expect(tenantService.updateTenantConfigs).toHaveBeenCalledWith('global-tenant-id', configs);
            expect(result).toBeDefined();
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

        it('me() should have @ApiResponse for 401', () => {
            const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'me');
            expect(responses).toBeDefined();
            expect(responses[401]).toBeDefined();
        });

        it('myConfig() should have @ApiOperation', () => {
            const metadata = getMethodMetadata(SWAGGER.API_OPERATION, 'myConfig');
            expect(metadata).toBeDefined();
            expect(metadata.summary).toBeDefined();
        });

        it('myConfig() should have @ApiResponse for 401', () => {
            const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'myConfig');
            expect(responses).toBeDefined();
            expect(responses[401]).toBeDefined();
        });
    });
});
