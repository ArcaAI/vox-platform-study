import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { UserRolesController } from '../user-roles.controller';

const SWAGGER = {
    API_OPERATION: 'swagger/apiOperation',
    API_RESPONSE: 'swagger/apiResponse',
    API_PARAMETERS: 'swagger/apiParameters',
    API_SECURITY: 'swagger/apiSecurity',
    API_TAGS: 'swagger/apiUseTags',
};

function getMethodMetadata(key: string, method: string) {
    return Reflect.getMetadata(key, UserRolesController.prototype[method]);
}

const createMockUserRoleAssignmentService = () => ({
    fetchAll: vi.fn(),
    fetchAllByUserId: vi.fn(),
});

const createMockClsService = (user?: { id?: string } | null) => ({
    get: vi.fn((key: string) => {
        if (key === 'user') return user ?? undefined;
        return undefined;
    }),
    set: vi.fn(),
    getId: vi.fn(),
});

const fakeUserRoleAssignmentEntity = {
    id: 'ura-1',
    userId: 'user-self',
    roleId: 'role-1',
    tenantId: 'tenant-1',
    createdBy: 'admin-1',
    updatedBy: null,
    createdAt: new Date('2026-01-29T10:00:00Z'),
    updatedAt: new Date('2026-01-29T10:00:00Z'),
    deletedAt: null,
    resourceStatus: 'ENABLED',
};

const fakeFetchResponse = {
    data: [fakeUserRoleAssignmentEntity],
    count: 1,
    limit: 10,
    page: 1,
};

describe('UserRolesController', () => {
    let controller: UserRolesController;
    let mockUserRoleAssignmentService: ReturnType<typeof createMockUserRoleAssignmentService>;
    let mockClsService: ReturnType<typeof createMockClsService>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockUserRoleAssignmentService = createMockUserRoleAssignmentService();
    });

    describe('GET /users/:id/roles (listMyRoleAssignments)', () => {
        it('should call userRoleAssignmentService.fetchAllByUserId when :id matches current user', async () => {
            mockClsService = createMockClsService({ id: 'user-self' });
            controller = new UserRolesController(
                mockUserRoleAssignmentService as any,
                mockClsService as any,
            );
            mockUserRoleAssignmentService.fetchAllByUserId.mockResolvedValue(fakeFetchResponse);

            await controller.listMyRoleAssignments('user-self', { page: 1, pageSize: 10 } as any);

            expect(mockClsService.get).toHaveBeenCalledWith('user');
            expect(mockUserRoleAssignmentService.fetchAllByUserId).toHaveBeenCalledWith(
                expect.objectContaining({ page: 1, pageSize: 10, userId: 'user-self' }),
            );
            expect(mockUserRoleAssignmentService.fetchAllByUserId).toHaveBeenCalledTimes(1);
        });

        it('should return a paginated UserRoleAssignmentResponse mapped from service result', async () => {
            mockClsService = createMockClsService({ id: 'user-self' });
            controller = new UserRolesController(
                mockUserRoleAssignmentService as any,
                mockClsService as any,
            );
            mockUserRoleAssignmentService.fetchAllByUserId.mockResolvedValue(fakeFetchResponse);

            const result = await controller.listMyRoleAssignments('user-self', { page: 1, pageSize: 10 } as any);

            expect(result).toBeDefined();
            expect(result.data).toBeDefined();
            expect(result.data).toHaveLength(1);
            expect(result.data[0].userId).toBe('user-self');
            expect(result.data[0].roleId).toBe('role-1');
            expect(result.count).toBe(1);
        });

        it('should throw ForbiddenException when :id does not match current user', async () => {
            mockClsService = createMockClsService({ id: 'user-self' });
            controller = new UserRolesController(
                mockUserRoleAssignmentService as any,
                mockClsService as any,
            );

            await expect(
                controller.listMyRoleAssignments('other-user', { page: 1, pageSize: 10 } as any),
            ).rejects.toThrow(ForbiddenException);
            await expect(
                controller.listMyRoleAssignments('other-user', { page: 1, pageSize: 10 } as any),
            ).rejects.toThrow(/Cannot list roles for a different user/);
            expect(mockUserRoleAssignmentService.fetchAllByUserId).not.toHaveBeenCalled();
        });

        it('should throw ForbiddenException when CLS user context is missing', async () => {
            mockClsService = createMockClsService(null);
            controller = new UserRolesController(
                mockUserRoleAssignmentService as any,
                mockClsService as any,
            );

            await expect(
                controller.listMyRoleAssignments('user-self', { page: 1 } as any),
            ).rejects.toThrow(ForbiddenException);
            expect(mockUserRoleAssignmentService.fetchAllByUserId).not.toHaveBeenCalled();
        });
    });

    describe('OpenAPI/Swagger metadata', () => {
        it('should have @ApiTags("user")', () => {
            const tags = Reflect.getMetadata(SWAGGER.API_TAGS, UserRolesController);
            expect(tags).toContain('user');
        });

        it('should have @ApiBearerAuth()', () => {
            const security = Reflect.getMetadata(SWAGGER.API_SECURITY, UserRolesController);
            expect(security).toBeDefined();
            expect(security).toEqual(expect.arrayContaining([{ bearer: [] }]));
        });

        it('listMyRoleAssignments should have @ApiOperation with summary', () => {
            const metadata = getMethodMetadata(SWAGGER.API_OPERATION, 'listMyRoleAssignments');
            expect(metadata).toBeDefined();
            expect(metadata.summary).toBeDefined();
        });

        it('listMyRoleAssignments should have @ApiParam for id', () => {
            const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'listMyRoleAssignments');
            expect(params).toBeDefined();
            const pathParams = params.filter((p: any) => p.in === 'path');
            const names = pathParams.map((p: any) => p.name);
            expect(names).toContain('id');
        });

        it('listMyRoleAssignments should have @ApiResponse for 403 (self-only enforcement)', () => {
            const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'listMyRoleAssignments');
            expect(responses).toBeDefined();
            expect(responses[403]).toBeDefined();
        });
    });
});
