/**
 * TASK-307 W6.1 — UserRoleAssignmentService: tenant-scoped read methods
 *
 * Pins the contract for the three callsites that AuthController previously
 * answered with direct `databaseService.client.userRoleAssignment` access
 * (audit C-10):
 *   1. `findActiveAssignmentForUserInTenant(userId, tenantId)`
 *      → login-time tenant validation
 *   2. `findActiveTenantIdsForUser(userId)`
 *      → impersonation target tenant resolution
 *   3. `findActiveRolesForUser(userId)`
 *      → JWT role / permission claim build
 *
 * Behaviour preservation is the contract — every test below mirrors the
 * Prisma call shape the controller relied on.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResourceStatusType } from '@arcaai/domains';
import { DataNotFoundException } from '@arcaai/exceptions';
import { UserRoleAssignmentService } from '../userRoleAssignment.service';

const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

const mockEventEmitter = {
    emit: vi.fn(),
};

const mockUserRoleAssignmentRepository = {
    findFirst: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    restore: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    findById: vi.fn(),
};

const mockDatabaseService = {
    client: {
        userRoleAssignment: {
            findFirst: vi.fn(),
            findMany: vi.fn(),
        },
    },
};

const buildService = () =>
    new UserRoleAssignmentService(
        mockUserRoleAssignmentRepository as any,
        mockEventEmitter as any,
        mockClsService as any,
        mockDatabaseService as any,
    );

describe('TASK-307 W6.1 — UserRoleAssignmentService tenant-scoped reads', () => {
    let service: UserRoleAssignmentService;

    beforeEach(() => {
        vi.clearAllMocks();

        mockClsService.get.mockImplementation((key: string) => {
            switch (key) {
                case 'user':
                    return { id: 'caller-id', firstName: 'Test', lastName: 'User', email: 'test@example.com' };
                case 'tenantId':
                    return 'tenant-A';
                case 'correlationId':
                    return 'corr-307-w6';
                case 'requestIp':
                    return '127.0.0.1';
                default:
                    return null;
            }
        });

        mockUserRoleAssignmentRepository.findFirst.mockRejectedValue(
            new DataNotFoundException('UserRoleAssignment', 'not-found'),
        );

        service = buildService();
    });

    describe('findActiveAssignmentForUserInTenant', () => {
        it('returns the assignment when the user is ENABLED in the requested tenant', async () => {
            const assignment = {
                id: 'ura-1',
                userId: 'user-1',
                roleId: 'role-1',
                tenantId: 'tenant-B',
                resourceStatus: ResourceStatusType.ENABLED,
            };
            mockDatabaseService.client.userRoleAssignment.findFirst.mockResolvedValue(assignment);

            const result = await service.findActiveAssignmentForUserInTenant('user-1', 'tenant-B');

            expect(result).toEqual(assignment);
            expect(mockDatabaseService.client.userRoleAssignment.findFirst).toHaveBeenCalledWith({
                where: {
                    userId: 'user-1',
                    tenantId: 'tenant-B',
                    resourceStatus: ResourceStatusType.ENABLED,
                },
            });
        });

        it('returns null when no ENABLED assignment exists for the user in the tenant (cross-tenant probe)', async () => {
            mockDatabaseService.client.userRoleAssignment.findFirst.mockResolvedValue(null);

            const result = await service.findActiveAssignmentForUserInTenant('user-A', 'tenant-B');

            expect(result).toBeNull();
            expect(mockDatabaseService.client.userRoleAssignment.findFirst).toHaveBeenCalledWith({
                where: {
                    userId: 'user-A',
                    tenantId: 'tenant-B',
                    resourceStatus: ResourceStatusType.ENABLED,
                },
            });
        });
    });

    describe('findActiveTenantIdsForUser', () => {
        it('returns unique tenant ids in creation order (oldest first)', async () => {
            mockDatabaseService.client.userRoleAssignment.findMany.mockResolvedValue([
                { tenantId: 'tenant-A' },
                { tenantId: 'tenant-B' },
                { tenantId: 'tenant-A' }, // duplicate via second role in same tenant
                { tenantId: 'tenant-C' },
            ]);

            const result = await service.findActiveTenantIdsForUser('user-1');

            expect(result).toEqual(['tenant-A', 'tenant-B', 'tenant-C']);
            expect(mockDatabaseService.client.userRoleAssignment.findMany).toHaveBeenCalledWith({
                where: {
                    userId: 'user-1',
                    resourceStatus: ResourceStatusType.ENABLED,
                    tenantId: { not: null },
                },
                select: { tenantId: true },
                orderBy: { createdAt: 'asc' },
            });
        });

        it('drops null/empty tenantIds (defensive — TASK-295 H-3 contract)', async () => {
            mockDatabaseService.client.userRoleAssignment.findMany.mockResolvedValue([
                { tenantId: null },
                { tenantId: '' },
                { tenantId: 'tenant-A' },
            ]);

            const result = await service.findActiveTenantIdsForUser('user-1');

            expect(result).toEqual(['tenant-A']);
        });

        it('returns [] when the user has no ENABLED assignments', async () => {
            mockDatabaseService.client.userRoleAssignment.findMany.mockResolvedValue([]);

            const result = await service.findActiveTenantIdsForUser('user-1');

            expect(result).toEqual([]);
        });
    });

    describe('findActiveRolesForUser', () => {
        it('returns the Role objects from each ENABLED assignment, filtering null Roles', async () => {
            mockDatabaseService.client.userRoleAssignment.findMany.mockResolvedValue([
                { Role: { id: 'role-1', name: 'doctor', permissions: ['read:Consultation'] } },
                { Role: null }, // stale join — must be filtered
                { Role: { id: 'role-2', name: 'admin', permissions: ['manage:all'] } },
            ]);

            const result = await service.findActiveRolesForUser('user-1');

            expect(result).toEqual([
                { id: 'role-1', name: 'doctor', permissions: ['read:Consultation'] },
                { id: 'role-2', name: 'admin', permissions: ['manage:all'] },
            ]);
            expect(mockDatabaseService.client.userRoleAssignment.findMany).toHaveBeenCalledWith({
                where: {
                    userId: 'user-1',
                    resourceStatus: ResourceStatusType.ENABLED,
                },
                include: { Role: true },
            });
        });

        it('returns [] when the user has no ENABLED assignments', async () => {
            mockDatabaseService.client.userRoleAssignment.findMany.mockResolvedValue([]);

            const result = await service.findActiveRolesForUser('user-1');

            expect(result).toEqual([]);
        });
    });
});
