import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UserController } from '../user.controller';

const createMockUserService = () => ({
    create: vi.fn(),
    fetchAll: vi.fn(),
    fetchAllByTenantId: vi.fn(),
    fetchAllCreatedByUser: vi.fn(),
    fetchById: vi.fn(),
    fetchByExternalId: vi.fn(),
    update: vi.fn(),
    deleteById: vi.fn(),
});

const createMockApiKeyService = () => ({
    fetchAll: vi.fn(),
    fetchAllByTenantId: vi.fn(),
    fetchAllByUserId: vi.fn(),
});

const createMockUserSettingsService = () => ({
    fetchAllByUserId: vi.fn(),
    upsertByUserKeyNamespace: vi.fn(),
});

const createMockUserRoleAssignmentService = () => ({
    create: vi.fn(),
    deleteById: vi.fn(),
    fetchAll: vi.fn(),
    fetchAllByUserId: vi.fn(),
});

const fakeUserEntity = {
    id: 'user-1',
    username: 'john_doe',
    lastLoginAt: new Date('2025-06-01T00:00:00Z'),
    lastActiveAt: new Date('2025-06-02T00:00:00Z'),
    externalId: 'ext-123',
    isServiceAccount: false,
    resourceStatus: 'ENABLED',
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: 'system',
    updatedBy: 'system',
    toObject: () => ({ id: 'user-1', username: 'john_doe' }),
};

const fakeFetchResponse = {
    data: [fakeUserEntity],
    count: 1,
    limit: 10,
    page: 1,
};

const fakeApiKeyEntity = {
    id: 'key-1',
    keyName: 'test-key',
    keyPrefix: 'hk_',
    keyType: 'STANDARD',
    keyStatus: 'ACTIVE',
    scopes: ['stt:transcription:read'],
    userId: 'user-1',
    tenantId: 'tenant-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    resourceStatus: 'ENABLED',
};

const fakeApiKeyFetchResponse = {
    data: [fakeApiKeyEntity],
    count: 1,
    limit: 10,
    page: 1,
};

const fakeUserRoleAssignmentEntity = {
    id: 'ura-1',
    userId: 'user-1',
    roleId: 'role-1',
    tenantId: 'tenant-1',
    createdBy: 'admin-1',
    updatedBy: null,
    createdAt: new Date('2026-01-29T10:00:00Z'),
    updatedAt: new Date('2026-01-29T10:00:00Z'),
    deletedAt: null,
    resourceStatus: 'ENABLED',
};

const fakeUserRoleAssignmentFetchResponse = {
    data: [fakeUserRoleAssignmentEntity],
    count: 1,
    limit: 10,
    page: 1,
};

describe('UserController', () => {
    let controller: UserController;
    let mockUserService: ReturnType<typeof createMockUserService>;
    let mockApiKeyService: ReturnType<typeof createMockApiKeyService>;
    let mockUserSettingsService: ReturnType<typeof createMockUserSettingsService>;
    let mockUserRoleAssignmentService: ReturnType<typeof createMockUserRoleAssignmentService>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockUserService = createMockUserService();
        mockApiKeyService = createMockApiKeyService();
        mockUserSettingsService = createMockUserSettingsService();
        mockUserRoleAssignmentService = createMockUserRoleAssignmentService();
        controller = new UserController(
            mockUserService as any,
            mockApiKeyService as any,
            mockUserSettingsService as any,
            mockUserRoleAssignmentService as any,
        );
    });

    describe('POST /admin/users (create)', () => {
        it('should call userService.create with request body', async () => {
            const request = { username: 'new_user', password: 'pass123' };
            mockUserService.create.mockResolvedValue(fakeUserEntity);

            await controller.create(request as any);

            expect(mockUserService.create).toHaveBeenCalledWith(request);
            expect(mockUserService.create).toHaveBeenCalledTimes(1);
        });

        it('should return a mapped UserResponse', async () => {
            mockUserService.create.mockResolvedValue(fakeUserEntity);

            const result = await controller.create({ username: 'new_user', password: 'pass123' } as any);

            expect(result).toBeDefined();
            expect(result.username).toBe('john_doe');
        });
    });

    describe('GET /admin/users (fetchAll)', () => {
        it('should call userService.fetchAll with query params', async () => {
            mockUserService.fetchAll.mockResolvedValue(fakeFetchResponse);

            await controller.fetchAll({ page: 1, pageSize: 10 } as any);

            expect(mockUserService.fetchAll).toHaveBeenCalledWith(
                expect.objectContaining({ page: 1, pageSize: 10 }),
            );
        });

        it('should return paginated response', async () => {
            mockUserService.fetchAll.mockResolvedValue(fakeFetchResponse);

            const result = await controller.fetchAll({ page: 1, pageSize: 10 } as any);

            expect(result).toBeDefined();
            expect(result.data).toBeDefined();
        });
    });

    describe('GET /admin/users/:id (fetchById)', () => {
        it('should call userService.fetchById with correct id', async () => {
            mockUserService.fetchById.mockResolvedValue(fakeUserEntity);

            await controller.fetchById('user-1');

            expect(mockUserService.fetchById).toHaveBeenCalledWith('user-1');
            expect(mockUserService.fetchById).toHaveBeenCalledTimes(1);
        });

        it('should return a mapped UserResponse', async () => {
            mockUserService.fetchById.mockResolvedValue(fakeUserEntity);

            const result = await controller.fetchById('user-1');

            expect(result).toBeDefined();
            expect(result.username).toBe('john_doe');
        });
    });

    describe('GET /admin/users/tenant/:tenantId (fetchByTenant)', () => {
        it('should call userService.fetchAllByTenantId with tenantId and query params', async () => {
            mockUserService.fetchAllByTenantId.mockResolvedValue(fakeFetchResponse);

            await controller.fetchByTenant('tenant-1', { page: 1, pageSize: 10 } as any);

            expect(mockUserService.fetchAllByTenantId).toHaveBeenCalledWith(
                expect.objectContaining({ tenantId: 'tenant-1', page: 1, pageSize: 10 }),
            );
        });

        it('should return paginated response', async () => {
            mockUserService.fetchAllByTenantId.mockResolvedValue(fakeFetchResponse);

            const result = await controller.fetchByTenant('tenant-1', { page: 1 } as any);

            expect(result).toBeDefined();
            expect(result.data).toBeDefined();
        });
    });

    describe('PATCH /admin/users/:id (update)', () => {
        it('should call userService.update with id and request body', async () => {
            const request = { username: 'updated_user' };
            mockUserService.update.mockResolvedValue(fakeUserEntity);

            await controller.update('user-1', request as any);

            expect(mockUserService.update).toHaveBeenCalledWith('user-1', request);
        });

        it('should return a mapped UserResponse', async () => {
            mockUserService.update.mockResolvedValue(fakeUserEntity);

            const result = await controller.update('user-1', { username: 'updated' } as any);

            expect(result).toBeDefined();
            expect(result.username).toBe('john_doe');
        });
    });

    describe('PATCH /admin/users/:id/status (updateStatus)', () => {
        it('should call userService.update with id and resourceStatus', async () => {
            mockUserService.update.mockResolvedValue(fakeUserEntity);

            await controller.updateStatus('user-1', { resourceStatus: 'DISABLED' } as any);

            expect(mockUserService.update).toHaveBeenCalledWith('user-1', { resourceStatus: 'DISABLED' });
        });
    });

    describe('DELETE /admin/users/:id (delete)', () => {
        it('should call userService.deleteById with correct id', async () => {
            mockUserService.deleteById.mockResolvedValue(fakeUserEntity);

            await controller.delete('user-1');

            expect(mockUserService.deleteById).toHaveBeenCalledWith('user-1');
            expect(mockUserService.deleteById).toHaveBeenCalledTimes(1);
        });

        it('should return a mapped UserResponse', async () => {
            mockUserService.deleteById.mockResolvedValue(fakeUserEntity);

            const result = await controller.delete('user-1');

            expect(result).toBeDefined();
        });
    });

    describe('DELETE /admin/users/bulk (bulkDelete)', () => {
        it('should call userService.deleteById for each id', async () => {
            mockUserService.deleteById.mockResolvedValue(fakeUserEntity);

            await controller.bulkDelete({ ids: ['user-1', 'user-2'] });

            expect(mockUserService.deleteById).toHaveBeenCalledTimes(2);
            expect(mockUserService.deleteById).toHaveBeenCalledWith('user-1');
            expect(mockUserService.deleteById).toHaveBeenCalledWith('user-2');
        });

        it('should return array of mapped responses', async () => {
            mockUserService.deleteById.mockResolvedValue(fakeUserEntity);

            const result = await controller.bulkDelete({ ids: ['user-1', 'user-2'] });

            expect(result).toHaveLength(2);
        });

        it('should return empty array when no ids provided', async () => {
            const result = await controller.bulkDelete({ ids: [] });

            expect(result).toEqual([]);
            expect(mockUserService.deleteById).not.toHaveBeenCalled();
        });
    });

    describe('GET /admin/users/:id/roles (fetchUserRoleAssignments)', () => {
        it('should call userRoleAssignmentService.fetchAllByUserId with userId and query params', async () => {
            mockUserRoleAssignmentService.fetchAllByUserId.mockResolvedValue(fakeUserRoleAssignmentFetchResponse);

            await controller.fetchUserRoleAssignments('user-1', { page: 1, pageSize: 10 } as any);

            expect(mockUserRoleAssignmentService.fetchAllByUserId).toHaveBeenCalledWith(
                expect.objectContaining({ page: 1, pageSize: 10, userId: 'user-1' }),
            );
            expect(mockUserRoleAssignmentService.fetchAllByUserId).toHaveBeenCalledTimes(1);
        });

        it('should return a paginated UserRoleAssignmentResponse mapped from service result', async () => {
            mockUserRoleAssignmentService.fetchAllByUserId.mockResolvedValue(fakeUserRoleAssignmentFetchResponse);

            const result = await controller.fetchUserRoleAssignments('user-1', { page: 1, pageSize: 10 } as any);

            expect(result).toBeDefined();
            expect(result.data).toBeDefined();
            expect(result.data).toHaveLength(1);
            expect(result.data[0].userId).toBe('user-1');
            expect(result.data[0].roleId).toBe('role-1');
            expect(result.count).toBe(1);
        });

        it('should NOT call fetchAll (which ignores userId)', async () => {
            mockUserRoleAssignmentService.fetchAllByUserId.mockResolvedValue(fakeUserRoleAssignmentFetchResponse);

            await controller.fetchUserRoleAssignments('user-1', { page: 1 } as any);

            expect(mockUserRoleAssignmentService.fetchAll).not.toHaveBeenCalled();
        });
    });

    describe('POST /admin/users/:id/roles (assignRole)', () => {
        it('should call userRoleAssignmentService.create with body merged with userId', async () => {
            const body = { roleId: 'role-1' };
            mockUserRoleAssignmentService.create.mockResolvedValue(fakeUserRoleAssignmentEntity);

            await controller.assignRole('user-1', body as any);

            expect(mockUserRoleAssignmentService.create).toHaveBeenCalledWith({ roleId: 'role-1', userId: 'user-1' });
            expect(mockUserRoleAssignmentService.create).toHaveBeenCalledTimes(1);
        });

        it('should return a mapped UserRoleAssignmentResponse', async () => {
            mockUserRoleAssignmentService.create.mockResolvedValue(fakeUserRoleAssignmentEntity);

            const result = await controller.assignRole('user-1', { roleId: 'role-1' } as any);

            expect(result).toBeDefined();
            expect(result.userId).toBe('user-1');
            expect(result.roleId).toBe('role-1');
        });

        it('should propagate errors thrown by the service', async () => {
            mockUserRoleAssignmentService.create.mockRejectedValue(new Error('Conflict'));

            await expect(controller.assignRole('user-1', { roleId: 'role-1' } as any)).rejects.toThrow('Conflict');
        });
    });

    describe('DELETE /admin/users/:id/roles/:assignmentId (removeRole)', () => {
        it('should call userRoleAssignmentService.deleteById with assignmentId', async () => {
            mockUserRoleAssignmentService.deleteById.mockResolvedValue(undefined);

            await controller.removeRole('assignment-1');

            expect(mockUserRoleAssignmentService.deleteById).toHaveBeenCalledWith('assignment-1');
            expect(mockUserRoleAssignmentService.deleteById).toHaveBeenCalledTimes(1);
        });

        it('should return void (no response body)', async () => {
            mockUserRoleAssignmentService.deleteById.mockResolvedValue(undefined);

            const result = await controller.removeRole('assignment-1');

            expect(result).toBeUndefined();
        });
    });

    describe('GET /admin/users/:id/api-keys (fetchUserApiKeys)', () => {
        it('should call apiKeyService.fetchAllByUserId with userId', async () => {
            mockApiKeyService.fetchAllByUserId.mockResolvedValue(fakeApiKeyFetchResponse);

            await controller.fetchUserApiKeys('user-1', { page: 1, pageSize: 10 } as any);

            expect(mockApiKeyService.fetchAllByUserId).toHaveBeenCalledWith(
                expect.objectContaining({ page: 1, pageSize: 10, userId: 'user-1' }),
            );
        });

        it('should NOT call fetchAll (which ignores userId)', async () => {
            mockApiKeyService.fetchAllByUserId.mockResolvedValue(fakeApiKeyFetchResponse);

            await controller.fetchUserApiKeys('user-1', { page: 1 } as any);

            expect(mockApiKeyService.fetchAll).not.toHaveBeenCalled();
        });

        it('should return paginated API key response', async () => {
            mockApiKeyService.fetchAllByUserId.mockResolvedValue(fakeApiKeyFetchResponse);

            const result = await controller.fetchUserApiKeys('user-1', { page: 1 } as any);

            expect(result).toBeDefined();
            expect(result.data).toBeDefined();
        });
    });
});

describe('UserController - OpenAPI/Swagger metadata', () => {
    const SWAGGER = {
        API_OPERATION: 'swagger/apiOperation',
        API_RESPONSE: 'swagger/apiResponse',
        API_PARAMETERS: 'swagger/apiParameters',
        API_SECURITY: 'swagger/apiSecurity',
        API_TAGS: 'swagger/apiUseTags',
    };

    function getMethodMetadata(key: string, method: string) {
        return Reflect.getMetadata(key, UserController.prototype[method]);
    }

    describe('class-level decorators', () => {
        it('should have @ApiTags("admin-users")', () => {
            const tags = Reflect.getMetadata(SWAGGER.API_TAGS, UserController);
            expect(tags).toContain('admin-users');
        });

        it('should have @ApiBearerAuth()', () => {
            const security = Reflect.getMetadata(SWAGGER.API_SECURITY, UserController);
            expect(security).toBeDefined();
            expect(security).toEqual(expect.arrayContaining([{ bearer: [] }]));
        });
    });

    describe('create', () => {
        it('should have @ApiOperation with summary', () => {
            const metadata = getMethodMetadata(SWAGGER.API_OPERATION, 'create');
            expect(metadata).toBeDefined();
            expect(metadata.summary).toBeDefined();
        });

        it('should have @ApiResponse for 400 (bad request)', () => {
            const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'create');
            expect(responses).toBeDefined();
            expect(responses[400]).toBeDefined();
        });
    });

    describe('fetchAll', () => {
        it('should have @ApiOperation with summary', () => {
            const metadata = getMethodMetadata(SWAGGER.API_OPERATION, 'fetchAll');
            expect(metadata).toBeDefined();
            expect(metadata.summary).toBeDefined();
        });

        it('should have @ApiQuery parameters for pagination', () => {
            const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'fetchAll');
            expect(params).toBeDefined();
            const queryParams = params.filter((p: any) => p.in === 'query');
            const names = queryParams.map((p: any) => p.name);
            expect(names).toEqual(expect.arrayContaining(['page', 'pageSize']));
        });
    });

    describe('fetchById', () => {
        it('should have @ApiParam for id', () => {
            const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'fetchById');
            expect(params).toBeDefined();
            const pathParams = params.filter((p: any) => p.in === 'path');
            const names = pathParams.map((p: any) => p.name);
            expect(names).toContain('id');
        });

        it('should have @ApiResponse for 404 (not found)', () => {
            const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'fetchById');
            expect(responses).toBeDefined();
            expect(responses[404]).toBeDefined();
        });
    });

    describe('fetchByTenant', () => {
        it('should have @ApiParam for tenantId', () => {
            const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'fetchByTenant');
            expect(params).toBeDefined();
            const pathParams = params.filter((p: any) => p.in === 'path');
            const names = pathParams.map((p: any) => p.name);
            expect(names).toContain('tenantId');
        });
    });

    describe('update', () => {
        it('should have @ApiParam for id', () => {
            const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'update');
            expect(params).toBeDefined();
            const pathParams = params.filter((p: any) => p.in === 'path');
            const names = pathParams.map((p: any) => p.name);
            expect(names).toContain('id');
        });

        it('should have @ApiResponse for 404 (not found)', () => {
            const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'update');
            expect(responses).toBeDefined();
            expect(responses[404]).toBeDefined();
        });
    });

    describe('delete', () => {
        it('should have @ApiParam for id', () => {
            const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'delete');
            expect(params).toBeDefined();
            const pathParams = params.filter((p: any) => p.in === 'path');
            const names = pathParams.map((p: any) => p.name);
            expect(names).toContain('id');
        });

        it('should have @ApiResponse for 404 (not found)', () => {
            const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'delete');
            expect(responses).toBeDefined();
            expect(responses[404]).toBeDefined();
        });
    });

    describe('fetchUserApiKeys', () => {
        it('should have @ApiParam for id', () => {
            const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'fetchUserApiKeys');
            expect(params).toBeDefined();
            const pathParams = params.filter((p: any) => p.in === 'path');
            const names = pathParams.map((p: any) => p.name);
            expect(names).toContain('id');
        });
    });
});
