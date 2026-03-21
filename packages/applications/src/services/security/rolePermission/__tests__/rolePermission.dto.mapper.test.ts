/**
 * RolePermissionDtoMapper Unit Tests
 *
 * Tests for the RolePermissionDtoMapper that transforms between RolePermission entities and DTOs.
 *
 * Testing Strategy:
 * - Tests verify actual transformation behavior, not just that methods were called
 * - Mocks are complete representations of real entity structures
 * - All fields in the response DTO are verified
 * - Edge cases like null values are covered
 */

import { describe, it, expect } from 'vitest';
import { RolePermissionDtoMapper } from '../rolePermission.dto.mapper';
import { RolePermissionResponse, PaginatedRolePermissionResponse } from '../dto';
import { FetchResponse } from '../../../../common';
import { ResourceStatusType } from '@arcaai/domains';

/**
 * Creates a complete mock role permission entity matching the real RolePermissionEntity structure.
 * This ensures tests don't pass due to incomplete mock data (Anti-Pattern #4).
 */
const createMockRolePermissionEntity = (
    overrides: Partial<{
        id: string;
        roleId: string;
        permissionId: string;
        createdBy: string | null;
        updatedBy: string | null;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        resourceStatus: ResourceStatusType;
    }> = {}
) => ({
    id: overrides.id ?? 'role-permission-id-1',
    roleId: overrides.roleId ?? 'role-id-1',
    permissionId: overrides.permissionId ?? 'permission-id-1',
    createdBy: overrides.createdBy ?? 'creator-id',
    updatedBy: overrides.updatedBy ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
    deletedAt: overrides.deletedAt ?? null,
    resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
});

describe('RolePermissionDtoMapper', () => {
    describe('ToResponse', () => {
        it('should map role permission entity to response DTO with all fields', () => {
            const entity = createMockRolePermissionEntity({
                id: 'rp-123',
                roleId: 'role-456',
                permissionId: 'perm-789',
                createdAt: new Date('2026-01-29T10:00:00Z'),
                updatedAt: new Date('2026-01-29T11:00:00Z'),
            });

            const result = RolePermissionDtoMapper.ToResponse(entity as any);

            // Verify instance type
            expect(result).toBeInstanceOf(RolePermissionResponse);
            // Verify ID
            expect(result.id).toBe('rp-123');
            // Verify base response fields
            expect(new Date(result.createdAt).toISOString()).toBe('2026-01-29T10:00:00.000Z');
            expect(new Date(result.updatedAt).toISOString()).toBe('2026-01-29T11:00:00.000Z');
        });

        it('should include base response fields correctly', () => {
            const entity = createMockRolePermissionEntity({
                id: 'rp-123',
                createdAt: new Date('2026-01-29T10:00:00Z'),
                updatedAt: new Date('2026-01-29T11:00:00Z'),
            });

            const result = RolePermissionDtoMapper.ToResponse(entity as any);

            expect(result.id).toBe('rp-123');
            expect(new Date(result.createdAt).toISOString()).toBe('2026-01-29T10:00:00.000Z');
            expect(new Date(result.updatedAt).toISOString()).toBe('2026-01-29T11:00:00.000Z');
        });

        it('should map entities with different role IDs correctly', () => {
            const roleIds = ['role-1', 'role-2', 'admin-role', 'user-role', 'manager-role'];

            for (const roleId of roleIds) {
                const entity = createMockRolePermissionEntity({
                    id: `rp-${roleId}`,
                    roleId,
                });

                const result = RolePermissionDtoMapper.ToResponse(entity as any);

                expect(result.id).toBe(`rp-${roleId}`);
            }
        });

        it('should map entities with different permission IDs correctly', () => {
            const permissionIds = ['perm-1', 'perm-2', 'read-users', 'write-roles', 'delete-all'];

            for (const permissionId of permissionIds) {
                const entity = createMockRolePermissionEntity({
                    id: `rp-${permissionId}`,
                    permissionId,
                });

                const result = RolePermissionDtoMapper.ToResponse(entity as any);

                expect(result.id).toBe(`rp-${permissionId}`);
            }
        });

        it('should handle entity with null createdBy', () => {
            const entity = createMockRolePermissionEntity({
                id: 'rp-123',
                createdBy: null,
            });

            const result = RolePermissionDtoMapper.ToResponse(entity as any);

            expect(result.id).toBe('rp-123');
        });

        it('should handle various role-permission combinations', () => {
            const combinations = [
                { roleId: 'admin', permissionId: 'full-access' },
                { roleId: 'user', permissionId: 'read-only' },
                { roleId: 'manager', permissionId: 'team-manage' },
            ];

            for (const combo of combinations) {
                const entity = createMockRolePermissionEntity({
                    id: `rp-${combo.roleId}-${combo.permissionId}`,
                    roleId: combo.roleId,
                    permissionId: combo.permissionId,
                });

                const result = RolePermissionDtoMapper.ToResponse(entity as any);

                expect(result.id).toBe(`rp-${combo.roleId}-${combo.permissionId}`);
            }
        });
    });

    describe('ToPaginatedResponse', () => {
        it('should map fetch response to paginated response with correct type', () => {
            const entities = [
                createMockRolePermissionEntity({ id: 'rp-1' }),
                createMockRolePermissionEntity({ id: 'rp-2' }),
            ];

            const fetchResponse = new FetchResponse({
                data: entities as any,
                count: 2,
                limit: 10,
                page: 1,
            });

            const result = RolePermissionDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result).toBeInstanceOf(PaginatedRolePermissionResponse);
            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
        });

        it('should correctly transform each entity in the data array', () => {
            const entities = [
                createMockRolePermissionEntity({
                    id: 'rp-1',
                    roleId: 'role-1',
                    permissionId: 'perm-1',
                }),
                createMockRolePermissionEntity({
                    id: 'rp-2',
                    roleId: 'role-2',
                    permissionId: 'perm-2',
                }),
            ];

            const fetchResponse = new FetchResponse({
                data: entities as any,
                count: 2,
                limit: 10,
                page: 1,
            });

            const result = RolePermissionDtoMapper.ToPaginatedResponse(fetchResponse);

            // Verify first entity
            expect(result.data[0]).toBeInstanceOf(RolePermissionResponse);
            expect(result.data[0].id).toBe('rp-1');

            // Verify second entity
            expect(result.data[1]).toBeInstanceOf(RolePermissionResponse);
            expect(result.data[1].id).toBe('rp-2');
        });

        it('should handle empty data array gracefully', () => {
            const fetchResponse = new FetchResponse({
                data: [],
                count: 0,
                limit: 10,
                page: 1,
            });

            const result = RolePermissionDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result).toBeInstanceOf(PaginatedRolePermissionResponse);
            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should preserve pagination metadata accurately', () => {
            const entities = [createMockRolePermissionEntity({ id: 'rp-1' })];

            const fetchResponse = new FetchResponse({
                data: entities as any,
                count: 100,
                limit: 25,
                page: 4,
            });

            const result = RolePermissionDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.count).toBe(100);
            expect(result.limit).toBe(25);
            expect(result.page).toBe(4);
        });

        it('should handle large data sets efficiently', () => {
            const entities = Array.from({ length: 50 }, (_, i) =>
                createMockRolePermissionEntity({
                    id: `rp-${i + 1}`,
                    roleId: `role-${(i % 5) + 1}`,
                    permissionId: `perm-${(i % 10) + 1}`,
                })
            );

            const fetchResponse = new FetchResponse({
                data: entities as any,
                count: 500,
                limit: 50,
                page: 1,
            });

            const result = RolePermissionDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data).toHaveLength(50);
            expect(result.count).toBe(500);
            expect(result.data[0].id).toBe('rp-1');
            expect(result.data[49].id).toBe('rp-50');
        });

        it('should handle single item in data array', () => {
            const entities = [
                createMockRolePermissionEntity({
                    id: 'rp-single',
                    roleId: 'role-single',
                    permissionId: 'perm-single',
                }),
            ];

            const fetchResponse = new FetchResponse({
                data: entities as any,
                count: 1,
                limit: 10,
                page: 1,
            });

            const result = RolePermissionDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data).toHaveLength(1);
            expect(result.data[0].id).toBe('rp-single');
        });

        it('should handle last page with fewer items than limit', () => {
            const entities = [
                createMockRolePermissionEntity({ id: 'rp-21' }),
                createMockRolePermissionEntity({ id: 'rp-22' }),
                createMockRolePermissionEntity({ id: 'rp-23' }),
            ];

            const fetchResponse = new FetchResponse({
                data: entities as any,
                count: 23,
                limit: 10,
                page: 3,
            });

            const result = RolePermissionDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data).toHaveLength(3);
            expect(result.count).toBe(23);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(3);
        });

        it('should handle role-permission assignments for same role', () => {
            const entities = [
                createMockRolePermissionEntity({
                    id: 'rp-1',
                    roleId: 'admin-role',
                    permissionId: 'read-users',
                }),
                createMockRolePermissionEntity({
                    id: 'rp-2',
                    roleId: 'admin-role',
                    permissionId: 'write-users',
                }),
                createMockRolePermissionEntity({
                    id: 'rp-3',
                    roleId: 'admin-role',
                    permissionId: 'delete-users',
                }),
            ];

            const fetchResponse = new FetchResponse({
                data: entities as any,
                count: 3,
                limit: 10,
                page: 1,
            });

            const result = RolePermissionDtoMapper.ToPaginatedResponse(fetchResponse);

            expect(result.data).toHaveLength(3);
            expect(result.data[0].id).toBe('rp-1');
            expect(result.data[1].id).toBe('rp-2');
            expect(result.data[2].id).toBe('rp-3');
        });
    });
});
