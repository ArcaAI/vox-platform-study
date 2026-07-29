/**
 * UserRoleAssignmentDtoMapper Unit Tests
 *
 * Tests for the UserRoleAssignmentDtoMapper that handles entity to DTO transformations.
 *
 * Testing Strategy:
 * - Tests verify actual mapping behavior with complete entity structures
 * - All entity fields are validated in the response
 * - Edge cases with null/undefined values are covered
 * - Pagination metadata is verified
 */

import { describe, it, expect } from 'vitest';
import { UserRoleAssignmentDtoMapper } from '../userRoleAssignment.dto.mapper';
import { UserRoleAssignmentResponse, PaginatedUserRoleAssignmentResponse } from '../dto';
import { FetchResponse } from '../../../../common';

/**
 * Creates a complete mock user role assignment entity matching the real entity structure.
 * This ensures tests don't pass due to incomplete mock data.
 */
const createMockUserRoleAssignmentEntity = (
  overrides: Partial<{
    id: string;
    userId: string;
    roleId: string;
    tenantId: string | null;
    createdBy: string | null;
    updatedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    resourceStatus: string;
  }> = {},
) =>
  ({
    id: overrides.id ?? 'user-role-assignment-id-1',
    userId: overrides.userId ?? 'user-id-1',
    roleId: overrides.roleId ?? 'role-id-1',
    tenantId: 'tenantId' in overrides ? overrides.tenantId : 'tenant-1',
    createdBy: overrides.createdBy ?? 'creator-1',
    updatedBy: overrides.updatedBy ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
    deletedAt: overrides.deletedAt ?? null,
    resourceStatus: overrides.resourceStatus ?? 'ENABLED',
  }) as any;

describe('UserRoleAssignmentDtoMapper', () => {
  describe('ToResponse', () => {
    it('should map entity to response with all fields', () => {
      const entity = createMockUserRoleAssignmentEntity({
        id: 'assignment-123',
        userId: 'user-789',
      });

      const result = UserRoleAssignmentDtoMapper.ToResponse(entity);

      expect(result).toBeInstanceOf(UserRoleAssignmentResponse);
      expect(result.id).toBe('assignment-123');
      expect(result.userId).toBe('user-789');
    });

    it('should include base response fields', () => {
      const entity = createMockUserRoleAssignmentEntity({
        id: 'assignment-123',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-15T12:00:00Z'),
        createdBy: 'creator-user-id',
      });

      const result = UserRoleAssignmentDtoMapper.ToResponse(entity);

      expect(result.id).toBe('assignment-123');
      // AutoClassMapper may convert dates to ISO strings
      expect(new Date(result.createdAt).toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(new Date(result.updatedAt).toISOString()).toBe('2026-01-15T12:00:00.000Z');
      expect(result.createdBy).toBe('creator-user-id');
    });

    it('should handle different user IDs', () => {
      const entity1 = createMockUserRoleAssignmentEntity({
        id: 'assignment-1',
        userId: 'admin-user',
      });
      const entity2 = createMockUserRoleAssignmentEntity({
        id: 'assignment-2',
        userId: 'regular-user',
      });

      const result1 = UserRoleAssignmentDtoMapper.ToResponse(entity1);
      const result2 = UserRoleAssignmentDtoMapper.ToResponse(entity2);

      expect(result1.userId).toBe('admin-user');
      expect(result2.userId).toBe('regular-user');
    });
  });

  describe('ToPaginatedResponse', () => {
    it('should map fetch response to paginated response', () => {
      const entities = [
        createMockUserRoleAssignmentEntity({
          id: 'assignment-1',
          userId: 'user-1',
        }),
        createMockUserRoleAssignmentEntity({
          id: 'assignment-2',
          userId: 'user-2',
        }),
        createMockUserRoleAssignmentEntity({
          id: 'assignment-3',
          userId: 'user-3',
        }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities,
        count: 3,
        limit: 10,
        page: 1,
      });

      const result = UserRoleAssignmentDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result).toBeInstanceOf(PaginatedUserRoleAssignmentResponse);
      expect(result.data).toHaveLength(3);
      expect(result.count).toBe(3);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(1);
    });

    it('should map each entity in the data array', () => {
      const entities = [
        createMockUserRoleAssignmentEntity({
          id: 'assignment-1',
          userId: 'admin-user',
        }),
        createMockUserRoleAssignmentEntity({
          id: 'assignment-2',
          userId: 'editor-user',
        }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities,
        count: 2,
        limit: 10,
        page: 1,
      });

      const result = UserRoleAssignmentDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data[0]).toBeInstanceOf(UserRoleAssignmentResponse);
      expect(result.data[0].id).toBe('assignment-1');
      expect(result.data[0].userId).toBe('admin-user');
      expect(result.data[1]).toBeInstanceOf(UserRoleAssignmentResponse);
      expect(result.data[1].id).toBe('assignment-2');
      expect(result.data[1].userId).toBe('editor-user');
    });

    it('should handle empty data array', () => {
      const fetchResponse = new FetchResponse({
        data: [],
        count: 0,
        limit: 10,
        page: 1,
      });

      const result = UserRoleAssignmentDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result).toBeInstanceOf(PaginatedUserRoleAssignmentResponse);
      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('should preserve pagination metadata', () => {
      const entities = [createMockUserRoleAssignmentEntity({ id: 'assignment-1' }), createMockUserRoleAssignmentEntity({ id: 'assignment-2' })];

      const fetchResponse = new FetchResponse({
        data: entities,
        count: 500,
        limit: 2,
        page: 25,
      });

      const result = UserRoleAssignmentDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.count).toBe(500);
      expect(result.limit).toBe(2);
      expect(result.page).toBe(25);
      expect(result.data).toHaveLength(2);
    });

    it('should handle large result sets correctly', () => {
      const entities = Array.from({ length: 100 }, (_, i) =>
        createMockUserRoleAssignmentEntity({
          id: `assignment-${i + 1}`,
          userId: `user-${i + 1}`,
        }),
      );

      const fetchResponse = new FetchResponse({
        data: entities,
        count: 1000,
        limit: 100,
        page: 1,
      });

      const result = UserRoleAssignmentDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data).toHaveLength(100);
      expect(result.count).toBe(1000);
      expect(result.data[0].id).toBe('assignment-1');
      expect(result.data[99].id).toBe('assignment-100');
    });
  });

  describe('roleId and tenantId in response', () => {
    it('should include roleId in response', () => {
      const entity = createMockUserRoleAssignmentEntity({
        id: 'assignment-123',
        userId: 'user-789',
        roleId: 'role-456',
      });

      const result = UserRoleAssignmentDtoMapper.ToResponse(entity);

      expect(result.roleId).toBe('role-456');
    });

    it('should include tenantId in response', () => {
      const entity = createMockUserRoleAssignmentEntity({
        id: 'assignment-123',
        userId: 'user-789',
        tenantId: 'tenant-abc',
      });

      const result = UserRoleAssignmentDtoMapper.ToResponse(entity);

      expect(result.tenantId).toBe('tenant-abc');
    });

    it('should handle null tenantId in response', () => {
      const entity = createMockUserRoleAssignmentEntity({
        id: 'assignment-123',
        tenantId: null,
      });

      const result = UserRoleAssignmentDtoMapper.ToResponse(entity);

      expect(result.tenantId).toBeNull();
    });

    it('should include roleId and tenantId in paginated response items', () => {
      const entities = [
        createMockUserRoleAssignmentEntity({
          id: 'assignment-1',
          roleId: 'role-a',
          tenantId: 'tenant-x',
        }),
        createMockUserRoleAssignmentEntity({
          id: 'assignment-2',
          roleId: 'role-b',
          tenantId: null,
        }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities,
        count: 2,
        limit: 10,
        page: 1,
      });

      const result = UserRoleAssignmentDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data[0].roleId).toBe('role-a');
      expect(result.data[0].tenantId).toBe('tenant-x');
      expect(result.data[1].roleId).toBe('role-b');
      expect(result.data[1].tenantId).toBeNull();
    });
  });

  // The admin console renders role NAMES, not raw UUIDs. The
  // repository now eager-loads the Role relation into the entity's `Roles`
  // array so the mapper can surface `roleName`.
  describe('roleName population', () => {
    it('surfaces roleName from the loaded Roles relation', () => {
      const entity = {
        ...createMockUserRoleAssignmentEntity({ id: 'assignment-role', roleId: 'role-clin' }),
        Roles: [{ name: 'Clinician' }],
      } as any;

      const result = UserRoleAssignmentDtoMapper.ToResponse(entity);

      expect(result.roleName).toBe('Clinician');
    });

    it('leaves roleName undefined when Roles is empty', () => {
      const entity = {
        ...createMockUserRoleAssignmentEntity({ id: 'assignment-no-role' }),
        Roles: [],
      } as any;

      const result = UserRoleAssignmentDtoMapper.ToResponse(entity);

      expect(result.roleName).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle entity with null tenantId', () => {
      const entity = createMockUserRoleAssignmentEntity({
        id: 'assignment-123',
        tenantId: null,
      });

      const result = UserRoleAssignmentDtoMapper.ToResponse(entity);

      expect(result).toBeInstanceOf(UserRoleAssignmentResponse);
      expect(result.id).toBe('assignment-123');
    });

    it('should handle entity with all null optional fields', () => {
      const entity = {
        id: 'assignment-123',
        userId: 'user-789',
        roleId: 'role-456',
        tenantId: null,
        createdBy: null,
        updatedBy: null,
        createdAt: new Date('2026-01-29T10:00:00Z'),
        updatedAt: new Date('2026-01-29T10:00:00Z'),
        deletedAt: null,
        resourceStatus: 'ENABLED',
      } as any;

      const result = UserRoleAssignmentDtoMapper.ToResponse(entity);

      expect(result).toBeInstanceOf(UserRoleAssignmentResponse);
      expect(result.id).toBe('assignment-123');
      expect(result.userId).toBe('user-789');
    });
  });
});
