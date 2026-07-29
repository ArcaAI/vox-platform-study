/**
 * PermissionDtoMapper Unit Tests
 *
 * Tests for the PermissionDtoMapper that transforms between Permission entities and DTOs.
 *
 * Testing Strategy:
 * - Tests verify actual transformation behavior, not just that methods were called
 * - Mocks are complete representations of real entity structures
 * - All fields in the response DTO are verified
 * - Edge cases like null values and complex conditions are covered
 */

import { describe, it, expect, vi } from 'vitest';
import { PermissionDtoMapper } from '../permission.dto.mapper';
import { PermissionResponse, PaginatedPermissionResponse } from '../dto';
import { FetchResponse } from '../../../../common';
import { PermissionAction, ResourceStatusType } from '@arcaai/domains';

/**
 * Creates a complete mock permission entity matching the real PermissionEntity structure.
 * This ensures tests don't pass due to incomplete mock data (Anti-Pattern #4).
 */
const createMockPermissionEntity = (
  overrides: Partial<{
    id: string;
    name: string;
    description: string | null;
    permissionAction: PermissionAction;
    resourceTypeName: string;
    conditions: object | null;
    createdBy: string | null;
    updatedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    resourceStatus: ResourceStatusType;
  }> = {},
) => ({
  id: overrides.id ?? 'permission-id-1',
  name: overrides.name ?? 'Test Permission',
  description: overrides.description ?? null,
  permissionAction: overrides.permissionAction ?? PermissionAction.READ,
  resourceTypeName: overrides.resourceTypeName ?? 'User',
  conditions: overrides.conditions ?? null,
  createdBy: overrides.createdBy ?? 'creator-id',
  updatedBy: overrides.updatedBy ?? null,
  createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
  deletedAt: overrides.deletedAt ?? null,
  resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
});

describe('PermissionDtoMapper', () => {
  describe('ToResponse', () => {
    it('should map permission entity to response DTO with all fields', () => {
      const entity = createMockPermissionEntity({
        id: 'permission-123',
        name: 'Read Users',
        description: 'Allows reading user data',
        permissionAction: PermissionAction.READ,
        resourceTypeName: 'User',
        createdAt: new Date('2026-01-29T10:00:00Z'),
        updatedAt: new Date('2026-01-29T11:00:00Z'),
      });

      const result = PermissionDtoMapper.ToResponse(entity as any);

      // Verify instance type
      expect(result).toBeInstanceOf(PermissionResponse);
      // Verify all permission-specific fields
      expect(result.id).toBe('permission-123');
      expect(result.name).toBe('Read Users');
      expect(result.description).toBe('Allows reading user data');
      expect(result.permissionAction).toBe(PermissionAction.READ);
      expect(result.resourceTypeName).toBe('User');
      // Verify base response fields
      expect(new Date(result.createdAt).toISOString()).toBe('2026-01-29T10:00:00.000Z');
      expect(new Date(result.updatedAt).toISOString()).toBe('2026-01-29T11:00:00.000Z');
    });

    it('should preserve null description value', () => {
      const entity = createMockPermissionEntity({
        id: 'permission-123',
        description: null,
      });

      const result = PermissionDtoMapper.ToResponse(entity as any);

      // AutoClassMapper preserves null values - important for API contracts
      expect(result.description).toBeNull();
    });

    it('should map entity with conditions object', () => {
      const conditions = { field: 'status', operator: 'eq', value: 'active' };
      const entity = createMockPermissionEntity({
        id: 'permission-123',
        conditions,
      });

      const result = PermissionDtoMapper.ToResponse(entity as any);

      expect(result.conditions).toEqual(conditions);
    });

    it('should preserve null conditions value', () => {
      const entity = createMockPermissionEntity({
        id: 'permission-123',
        conditions: null,
      });

      const result = PermissionDtoMapper.ToResponse(entity as any);

      expect(result.conditions).toBeNull();
    });

    it('should correctly map all permission action types', () => {
      const actions = [PermissionAction.CREATE, PermissionAction.READ, PermissionAction.UPDATE, PermissionAction.DELETE];

      for (const action of actions) {
        const entity = createMockPermissionEntity({
          id: `permission-${action}`,
          permissionAction: action,
        });

        const result = PermissionDtoMapper.ToResponse(entity as any);

        expect(result.permissionAction).toBe(action);
      }
    });

    it('should map different resource type names correctly', () => {
      const resourceTypes = ['User', 'Role', 'Permission', 'Tenant', 'Consultation', 'Media'];

      for (const resourceType of resourceTypes) {
        const entity = createMockPermissionEntity({
          id: `permission-${resourceType}`,
          resourceTypeName: resourceType,
        });

        const result = PermissionDtoMapper.ToResponse(entity as any);

        expect(result.resourceTypeName).toBe(resourceType);
      }
    });

    it('should handle complex nested conditions', () => {
      const complexConditions = {
        and: [
          { field: 'status', operator: 'eq', value: 'active' },
          {
            or: [
              { field: 'role', operator: 'in', value: ['admin', 'manager'] },
              { field: 'department', operator: 'eq', value: 'engineering' },
            ],
          },
        ],
      };

      const entity = createMockPermissionEntity({
        id: 'permission-complex',
        conditions: complexConditions,
      });

      const result = PermissionDtoMapper.ToResponse(entity as any);

      expect(result.conditions).toEqual(complexConditions);
    });
  });

  describe('ToPaginatedResponse', () => {
    it('should map fetch response to paginated response with correct type', () => {
      const entities = [
        createMockPermissionEntity({ id: 'permission-1', name: 'Permission 1' }),
        createMockPermissionEntity({ id: 'permission-2', name: 'Permission 2' }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any,
        count: 2,
        limit: 10,
        page: 1,
      });

      const result = PermissionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result).toBeInstanceOf(PaginatedPermissionResponse);
      expect(result.data).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(1);
    });

    it('should correctly transform each entity in the data array', () => {
      const entities = [
        createMockPermissionEntity({
          id: 'permission-1',
          name: 'Read Users',
          permissionAction: PermissionAction.READ,
          resourceTypeName: 'User',
        }),
        createMockPermissionEntity({
          id: 'permission-2',
          name: 'Create Roles',
          permissionAction: PermissionAction.CREATE,
          resourceTypeName: 'Role',
        }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any,
        count: 2,
        limit: 10,
        page: 1,
      });

      const result = PermissionDtoMapper.ToPaginatedResponse(fetchResponse);

      // Verify first entity
      expect(result.data[0]).toBeInstanceOf(PermissionResponse);
      expect(result.data[0].id).toBe('permission-1');
      expect(result.data[0].name).toBe('Read Users');
      expect(result.data[0].permissionAction).toBe(PermissionAction.READ);
      expect(result.data[0].resourceTypeName).toBe('User');

      // Verify second entity
      expect(result.data[1]).toBeInstanceOf(PermissionResponse);
      expect(result.data[1].id).toBe('permission-2');
      expect(result.data[1].name).toBe('Create Roles');
      expect(result.data[1].permissionAction).toBe(PermissionAction.CREATE);
      expect(result.data[1].resourceTypeName).toBe('Role');
    });

    it('should handle empty data array gracefully', () => {
      const fetchResponse = new FetchResponse({
        data: [],
        count: 0,
        limit: 10,
        page: 1,
      });

      const result = PermissionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result).toBeInstanceOf(PaginatedPermissionResponse);
      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('should preserve pagination metadata accurately', () => {
      const entities = [createMockPermissionEntity({ id: 'permission-1' })];

      const fetchResponse = new FetchResponse({
        data: entities as any,
        count: 100,
        limit: 25,
        page: 4,
      });

      const result = PermissionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.count).toBe(100);
      expect(result.limit).toBe(25);
      expect(result.page).toBe(4);
    });

    it('should handle large data sets efficiently', () => {
      const entities = Array.from({ length: 50 }, (_, i) =>
        createMockPermissionEntity({
          id: `permission-${i + 1}`,
          name: `Permission ${i + 1}`,
          permissionAction: i % 2 === 0 ? PermissionAction.READ : PermissionAction.CREATE,
        }),
      );

      const fetchResponse = new FetchResponse({
        data: entities as any,
        count: 500,
        limit: 50,
        page: 1,
      });

      const result = PermissionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data).toHaveLength(50);
      expect(result.count).toBe(500);
      expect(result.data[0].id).toBe('permission-1');
      expect(result.data[0].name).toBe('Permission 1');
      expect(result.data[49].id).toBe('permission-50');
      expect(result.data[49].name).toBe('Permission 50');
    });

    it('should preserve complex conditions in paginated results', () => {
      const complexConditions = {
        and: [
          { field: 'status', operator: 'eq', value: 'active' },
          { field: 'role', operator: 'in', value: ['admin', 'manager'] },
        ],
      };

      const entities = [
        createMockPermissionEntity({
          id: 'permission-1',
          conditions: complexConditions,
        }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any,
        count: 1,
        limit: 10,
        page: 1,
      });

      const result = PermissionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data[0].conditions).toEqual(complexConditions);
    });

    it('should handle last page with fewer items than limit', () => {
      const entities = [
        createMockPermissionEntity({ id: 'permission-21' }),
        createMockPermissionEntity({ id: 'permission-22' }),
        createMockPermissionEntity({ id: 'permission-23' }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any,
        count: 23,
        limit: 10,
        page: 3,
      });

      const result = PermissionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data).toHaveLength(3);
      expect(result.count).toBe(23);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(3);
    });

    it('should handle single item in data array', () => {
      const entities = [
        createMockPermissionEntity({
          id: 'permission-single',
          name: 'Single Permission',
        }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any,
        count: 1,
        limit: 10,
        page: 1,
      });

      const result = PermissionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('permission-single');
      expect(result.data[0].name).toBe('Single Permission');
    });
  });
});
