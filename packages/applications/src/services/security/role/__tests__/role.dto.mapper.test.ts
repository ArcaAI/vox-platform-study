/**
 * RoleDtoMapper Unit Tests
 *
 * Tests for the RoleDtoMapper that transforms between Role entities and DTOs.
 *
 * Testing Strategy:
 * - Tests verify actual transformation behavior, not just that methods were called
 * - Mocks are complete representations of real entity structures
 * - All fields in the response DTO are verified
 * - Edge cases like null values are covered
 */

import { describe, it, expect } from 'vitest';
import { RoleDtoMapper } from '../role.dto.mapper';
import { RoleResponse, PaginatedRoleResponse } from '../dto';
import { FetchResponse } from '../../../../common';
import { ResourceStatusType } from '@arcaai/domains';

/**
 * Creates a complete mock role entity matching the real RoleEntity structure.
 * This ensures tests don't pass due to incomplete mock data (Anti-Pattern #4).
 */
const createMockRoleEntity = (
  overrides: Partial<{
    id: string;
    name: string;
    description: string | null;
    externalName: string | null;
    externalId: string | null;
    isSystemRole: boolean;
    parentRoleId: string | null;
    userRoleAssignmentId: string | null;
    createdBy: string | null;
    updatedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    resourceStatus: ResourceStatusType;
  }> = {},
) => ({
  id: overrides.id ?? 'role-id-1',
  name: overrides.name ?? 'Test Role',
  description: overrides.description ?? null,
  externalName: overrides.externalName ?? null,
  externalId: overrides.externalId ?? null,
  isSystemRole: overrides.isSystemRole ?? false,
  parentRoleId: overrides.parentRoleId ?? null,
  userRoleAssignmentId: overrides.userRoleAssignmentId ?? null,
  createdBy: overrides.createdBy ?? 'creator-id',
  updatedBy: overrides.updatedBy ?? null,
  createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
  deletedAt: overrides.deletedAt ?? null,
  resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
});

describe('RoleDtoMapper', () => {
  describe('ToResponse', () => {
    it('should map role entity to response DTO with all fields', () => {
      const entity = createMockRoleEntity({
        id: 'role-123',
        name: 'Admin Role',
        description: 'Administrator role with full access',
        createdAt: new Date('2026-01-29T10:00:00Z'),
        updatedAt: new Date('2026-01-29T11:00:00Z'),
      });

      const result = RoleDtoMapper.ToResponse(entity as any);

      // Verify instance type
      expect(result).toBeInstanceOf(RoleResponse);
      // Verify all role-specific fields
      expect(result.id).toBe('role-123');
      expect(result.name).toBe('Admin Role');
      expect(result.description).toBe('Administrator role with full access');
      // Verify base response fields
      expect(new Date(result.createdAt).toISOString()).toBe('2026-01-29T10:00:00.000Z');
      expect(new Date(result.updatedAt).toISOString()).toBe('2026-01-29T11:00:00.000Z');
    });

    it('should preserve null description value', () => {
      const entity = createMockRoleEntity({
        id: 'role-123',
        description: null,
      });

      const result = RoleDtoMapper.ToResponse(entity as any);

      // AutoClassMapper preserves null values - important for API contracts
      expect(result.description).toBeNull();
    });

    it('should map entity with external name', () => {
      const entity = createMockRoleEntity({
        id: 'role-123',
        externalName: 'External Admin',
      });

      const result = RoleDtoMapper.ToResponse(entity as any);

      expect(result.externalName).toBe('External Admin');
    });

    it('should map entity with external ID', () => {
      const entity = createMockRoleEntity({
        id: 'role-123',
        externalId: 'ext-role-456',
      });

      const result = RoleDtoMapper.ToResponse(entity as any);

      expect(result.externalId).toBe('ext-role-456');
    });

    it('should map entity with user role assignment ID', () => {
      const entity = createMockRoleEntity({
        id: 'role-123',
        userRoleAssignmentId: 'ura-789',
      });

      const result = RoleDtoMapper.ToResponse(entity as any);

      expect(result.userRoleAssignmentId).toBe('ura-789');
    });

    it('should preserve null optional fields', () => {
      const entity = createMockRoleEntity({
        id: 'role-123',
        description: null,
        externalName: null,
        externalId: null,
        userRoleAssignmentId: null,
      });

      const result = RoleDtoMapper.ToResponse(entity as any);

      expect(result.description).toBeNull();
      expect(result.externalName).toBeNull();
      expect(result.externalId).toBeNull();
      expect(result.userRoleAssignmentId).toBeNull();
    });

    it('should map different role names correctly', () => {
      const roleNames = ['Admin', 'User', 'Manager', 'Viewer', 'Super Admin'];

      for (const name of roleNames) {
        const entity = createMockRoleEntity({
          id: `role-${name}`,
          name,
        });

        const result = RoleDtoMapper.ToResponse(entity as any);

        expect(result.name).toBe(name);
      }
    });

    it('should handle entity with all optional fields populated', () => {
      const entity = createMockRoleEntity({
        id: 'role-full',
        name: 'Full Role',
        description: 'A role with all fields',
        externalName: 'External Full',
        externalId: 'ext-full-123',
        userRoleAssignmentId: 'ura-full-456',
      });

      const result = RoleDtoMapper.ToResponse(entity as any);

      expect(result.id).toBe('role-full');
      expect(result.name).toBe('Full Role');
      expect(result.description).toBe('A role with all fields');
      expect(result.externalName).toBe('External Full');
      expect(result.externalId).toBe('ext-full-123');
      expect(result.userRoleAssignmentId).toBe('ura-full-456');
    });
  });

  describe('ToPaginatedResponse', () => {
    it('should map fetch response to paginated response with correct type', () => {
      const entities = [createMockRoleEntity({ id: 'role-1', name: 'Role 1' }), createMockRoleEntity({ id: 'role-2', name: 'Role 2' })];

      const fetchResponse = new FetchResponse({
        data: entities as any,
        count: 2,
        limit: 10,
        page: 1,
      });

      const result = RoleDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result).toBeInstanceOf(PaginatedRoleResponse);
      expect(result.data).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(1);
    });

    it('should correctly transform each entity in the data array', () => {
      const entities = [
        createMockRoleEntity({
          id: 'role-1',
          name: 'Admin',
          description: 'Administrator role',
        }),
        createMockRoleEntity({
          id: 'role-2',
          name: 'User',
          description: 'Standard user role',
        }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any,
        count: 2,
        limit: 10,
        page: 1,
      });

      const result = RoleDtoMapper.ToPaginatedResponse(fetchResponse);

      // Verify first entity
      expect(result.data[0]).toBeInstanceOf(RoleResponse);
      expect(result.data[0].id).toBe('role-1');
      expect(result.data[0].name).toBe('Admin');
      expect(result.data[0].description).toBe('Administrator role');

      // Verify second entity
      expect(result.data[1]).toBeInstanceOf(RoleResponse);
      expect(result.data[1].id).toBe('role-2');
      expect(result.data[1].name).toBe('User');
      expect(result.data[1].description).toBe('Standard user role');
    });

    it('should handle empty data array gracefully', () => {
      const fetchResponse = new FetchResponse({
        data: [],
        count: 0,
        limit: 10,
        page: 1,
      });

      const result = RoleDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result).toBeInstanceOf(PaginatedRoleResponse);
      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('should preserve pagination metadata accurately', () => {
      const entities = [createMockRoleEntity({ id: 'role-1' })];

      const fetchResponse = new FetchResponse({
        data: entities as any,
        count: 100,
        limit: 25,
        page: 4,
      });

      const result = RoleDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.count).toBe(100);
      expect(result.limit).toBe(25);
      expect(result.page).toBe(4);
    });

    it('should handle large data sets efficiently', () => {
      const entities = Array.from({ length: 50 }, (_, i) =>
        createMockRoleEntity({
          id: `role-${i + 1}`,
          name: `Role ${i + 1}`,
        }),
      );

      const fetchResponse = new FetchResponse({
        data: entities as any,
        count: 500,
        limit: 50,
        page: 1,
      });

      const result = RoleDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data).toHaveLength(50);
      expect(result.count).toBe(500);
      expect(result.data[0].id).toBe('role-1');
      expect(result.data[0].name).toBe('Role 1');
      expect(result.data[49].id).toBe('role-50');
      expect(result.data[49].name).toBe('Role 50');
    });

    it('should handle last page with fewer items than limit', () => {
      const entities = [createMockRoleEntity({ id: 'role-21' }), createMockRoleEntity({ id: 'role-22' }), createMockRoleEntity({ id: 'role-23' })];

      const fetchResponse = new FetchResponse({
        data: entities as any,
        count: 23,
        limit: 10,
        page: 3,
      });

      const result = RoleDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data).toHaveLength(3);
      expect(result.count).toBe(23);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(3);
    });

    it('should handle single item in data array', () => {
      const entities = [
        createMockRoleEntity({
          id: 'role-single',
          name: 'Single Role',
        }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any,
        count: 1,
        limit: 10,
        page: 1,
      });

      const result = RoleDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('role-single');
      expect(result.data[0].name).toBe('Single Role');
    });

    it('should preserve external identifiers in paginated results', () => {
      const entities = [
        createMockRoleEntity({
          id: 'role-1',
          externalName: 'External Role 1',
          externalId: 'ext-1',
        }),
        createMockRoleEntity({
          id: 'role-2',
          externalName: 'External Role 2',
          externalId: 'ext-2',
        }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any,
        count: 2,
        limit: 10,
        page: 1,
      });

      const result = RoleDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data[0].externalName).toBe('External Role 1');
      expect(result.data[0].externalId).toBe('ext-1');
      expect(result.data[1].externalName).toBe('External Role 2');
      expect(result.data[1].externalId).toBe('ext-2');
    });
  });
});
