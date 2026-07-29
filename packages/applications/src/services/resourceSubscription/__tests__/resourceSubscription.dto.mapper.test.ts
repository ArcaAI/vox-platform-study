/**
 * ResourceSubscriptionDtoMapper Unit Tests
 *
 * Tests for the ResourceSubscriptionDtoMapper that transforms resource subscription entities to response DTOs.
 *
 * Testing Strategy:
 * - Use complete mock entities matching real entity structure
 * - Test all field mappings including timestamps
 * - Test edge cases and boundary conditions
 * - Verify mapper handles all enum values correctly
 */

import { describe, it, expect } from 'vitest';
import { ResourceSubscriptionDtoMapper } from '../resourceSubscription.dto.mapper';
import { ResourceType, ResourceSubscriptionType, ResourceStatusType } from '@arcaai/domains';
import { FetchResponse } from '../../../common';

/**
 * Helper to create mock resource subscription entity with complete structure.
 * Uses default values that can be overridden for specific test cases.
 * Note: Uses 'in' operator to properly handle null values as explicit overrides.
 */
const createMockResourceSubscriptionEntity = (
  overrides: Partial<{
    id: string;
    resourceId: string;
    resourceTypeName: ResourceType;
    subscriptionType: ResourceSubscriptionType;
    resourceStatus: ResourceStatusType;
    targetUserId: string;
    subscriptionMetadata: Record<string, unknown> | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }> = {},
) => ({
  id: 'id' in overrides ? overrides.id : 'subscription-id-1',
  resourceId: 'resourceId' in overrides ? overrides.resourceId : 'resource-123',
  resourceTypeName: 'resourceTypeName' in overrides ? overrides.resourceTypeName : ResourceType.Consultation,
  subscriptionType: 'subscriptionType' in overrides ? overrides.subscriptionType : ResourceSubscriptionType.SUBSCRIBER,
  resourceStatus: 'resourceStatus' in overrides ? overrides.resourceStatus : ResourceStatusType.ENABLED,
  targetUserId: 'targetUserId' in overrides ? overrides.targetUserId : 'user-123',
  subscriptionMetadata: 'subscriptionMetadata' in overrides ? overrides.subscriptionMetadata : null,
  createdBy: 'createdBy' in overrides ? overrides.createdBy : 'creator-123',
  createdAt: 'createdAt' in overrides ? overrides.createdAt : new Date('2026-01-29T10:00:00Z'),
  updatedAt: 'updatedAt' in overrides ? overrides.updatedAt : new Date('2026-01-29T10:30:00Z'),
  deletedAt: 'deletedAt' in overrides ? overrides.deletedAt : null,
});

describe('ResourceSubscriptionDtoMapper', () => {
  describe('ToResponse', () => {
    it('should map basic resource subscription entity to response', () => {
      const entity = createMockResourceSubscriptionEntity();

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(result.id).toBe('subscription-id-1');
      expect(result.resourceId).toBe('resource-123');
      expect(result.resourceTypeName).toBe(ResourceType.Consultation);
      expect(result.subscriptionType).toBe(ResourceSubscriptionType.SUBSCRIBER);
      expect(result.targetUserId).toBe('user-123');
    });

    it('should map resourceId when present', () => {
      const entity = createMockResourceSubscriptionEntity({
        resourceId: 'custom-resource-456',
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(result.resourceId).toBe('custom-resource-456');
    });

    it('should map resourceTypeName correctly', () => {
      const resourceTypes = [ResourceType.Consultation, ResourceType.User, ResourceType.Tag, ResourceType.Media];

      resourceTypes.forEach((resourceTypeName) => {
        const entity = createMockResourceSubscriptionEntity({ resourceTypeName });
        const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);
        expect(result.resourceTypeName).toBe(resourceTypeName);
      });
    });

    it('should map subscriptionType correctly', () => {
      const subscriptionTypes = [ResourceSubscriptionType.SUBSCRIBER, ResourceSubscriptionType.CREATOR, ResourceSubscriptionType.MENTIONED];

      subscriptionTypes.forEach((subscriptionType) => {
        const entity = createMockResourceSubscriptionEntity({ subscriptionType });
        const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);
        expect(result.subscriptionType).toBe(subscriptionType);
      });
    });

    it('should map targetUserId when present', () => {
      const entity = createMockResourceSubscriptionEntity({
        targetUserId: 'target-user-789',
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(result.targetUserId).toBe('target-user-789');
    });

    it('should map subscriptionMetadata when present', () => {
      const metadata = { key: 'value', nested: { data: true } };
      const entity = createMockResourceSubscriptionEntity({
        subscriptionMetadata: metadata,
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(result.subscriptionMetadata).toEqual(metadata);
    });

    it('should handle null subscriptionMetadata', () => {
      const entity = createMockResourceSubscriptionEntity({
        subscriptionMetadata: null,
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      // AutoClassMapper preserves null values
      expect(result.subscriptionMetadata).toBeNull();
    });

    it('should handle entity with all fields populated', () => {
      const entity = createMockResourceSubscriptionEntity({
        id: 'sub-123',
        resourceId: 'res-456',
        resourceTypeName: ResourceType.Consultation,
        subscriptionType: ResourceSubscriptionType.CREATOR,
        targetUserId: 'user-789',
        subscriptionMetadata: { priority: 'high' },
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(result.id).toBe('sub-123');
      expect(result.resourceId).toBe('res-456');
      expect(result.resourceTypeName).toBe(ResourceType.Consultation);
      expect(result.subscriptionType).toBe(ResourceSubscriptionType.CREATOR);
      expect(result.targetUserId).toBe('user-789');
      expect(result.subscriptionMetadata).toEqual({ priority: 'high' });
    });
  });

  describe('ToPaginatedResponse', () => {
    it('should map paginated resource subscriptions correctly', () => {
      const entities = [
        createMockResourceSubscriptionEntity({ id: 'sub-1' }),
        createMockResourceSubscriptionEntity({ id: 'sub-2' }),
        createMockResourceSubscriptionEntity({ id: 'sub-3' }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 3,
        limit: 10,
        page: 1,
      });

      const result = ResourceSubscriptionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data).toHaveLength(3);
      expect(result.count).toBe(3);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(1);
      expect(result.data[0].id).toBe('sub-1');
      expect(result.data[1].id).toBe('sub-2');
      expect(result.data[2].id).toBe('sub-3');
    });

    it('should handle empty data array', () => {
      const fetchResponse = new FetchResponse({
        data: [] as any[],
        count: 0,
        limit: 10,
        page: 1,
      });

      const result = ResourceSubscriptionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(0);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(1);
    });

    it('should preserve pagination metadata', () => {
      const entities = [createMockResourceSubscriptionEntity({ id: 'sub-1' })];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 100,
        limit: 25,
        page: 4,
      });

      const result = ResourceSubscriptionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.count).toBe(100);
      expect(result.limit).toBe(25);
      expect(result.page).toBe(4);
    });

    it('should map each entity in the data array', () => {
      const entities = [
        createMockResourceSubscriptionEntity({
          id: 'sub-1',
          subscriptionType: ResourceSubscriptionType.SUBSCRIBER,
        }),
        createMockResourceSubscriptionEntity({
          id: 'sub-2',
          subscriptionType: ResourceSubscriptionType.CREATOR,
        }),
        createMockResourceSubscriptionEntity({
          id: 'sub-3',
          subscriptionType: ResourceSubscriptionType.MENTIONED,
        }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 3,
        limit: 10,
        page: 1,
      });

      const result = ResourceSubscriptionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data[0].subscriptionType).toBe(ResourceSubscriptionType.SUBSCRIBER);
      expect(result.data[1].subscriptionType).toBe(ResourceSubscriptionType.CREATOR);
      expect(result.data[2].subscriptionType).toBe(ResourceSubscriptionType.MENTIONED);
    });

    it('should handle large page numbers', () => {
      const entities = [createMockResourceSubscriptionEntity({ id: 'sub-1' })];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 1000,
        limit: 10,
        page: 100,
      });

      const result = ResourceSubscriptionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.page).toBe(100);
      expect(result.count).toBe(1000);
    });
  });

  describe('ToResponse - timestamp handling', () => {
    it('should map createdAt correctly', () => {
      const createdAt = new Date('2026-01-15T08:30:00Z');
      const entity = createMockResourceSubscriptionEntity({ createdAt });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      // Result may be Date or string depending on mapper implementation
      expect(new Date(result.createdAt).toISOString()).toBe(createdAt.toISOString());
    });

    it('should map updatedAt correctly', () => {
      const updatedAt = new Date('2026-01-20T14:45:00Z');
      const entity = createMockResourceSubscriptionEntity({ updatedAt });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(new Date(result.updatedAt).toISOString()).toBe(updatedAt.toISOString());
    });

    it('should handle different timezone dates', () => {
      // UTC date
      const utcDate = new Date('2026-06-15T12:00:00Z');
      const entity = createMockResourceSubscriptionEntity({
        createdAt: utcDate,
        updatedAt: utcDate,
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(new Date(result.createdAt).toISOString()).toBe('2026-06-15T12:00:00.000Z');
    });

    it('should handle dates at epoch boundaries', () => {
      const epochStart = new Date(0);
      const entity = createMockResourceSubscriptionEntity({
        createdAt: epochStart,
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(new Date(result.createdAt).toISOString()).toBe(epochStart.toISOString());
    });
  });

  describe('ToResponse - resourceStatus mapping', () => {
    it('should map ENABLED status correctly', () => {
      const entity = createMockResourceSubscriptionEntity({
        resourceStatus: ResourceStatusType.ENABLED,
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(result.resourceStatus).toBe(ResourceStatusType.ENABLED);
    });

    it('should map DISABLED status correctly', () => {
      const entity = createMockResourceSubscriptionEntity({
        resourceStatus: ResourceStatusType.DISABLED,
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(result.resourceStatus).toBe(ResourceStatusType.DISABLED);
    });

    it('should map ARCHIVED status correctly', () => {
      const entity = createMockResourceSubscriptionEntity({
        resourceStatus: ResourceStatusType.ARCHIVED,
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(result.resourceStatus).toBe(ResourceStatusType.ARCHIVED);
    });
  });

  describe('ToResponse - edge cases', () => {
    it('should handle empty subscriptionMetadata object', () => {
      const entity = createMockResourceSubscriptionEntity({
        subscriptionMetadata: {},
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(result.subscriptionMetadata).toEqual({});
    });

    it('should handle deeply nested subscriptionMetadata', () => {
      const metadata = {
        level1: {
          level2: {
            level3: {
              value: 'deep',
              array: [1, 2, 3],
            },
          },
        },
      };
      const entity = createMockResourceSubscriptionEntity({
        subscriptionMetadata: metadata,
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(result.subscriptionMetadata).toEqual(metadata);
    });

    it('should handle subscriptionMetadata with special characters', () => {
      const metadata = {
        'key-with-dash': 'value',
        'key.with.dots': 'value',
        'key with spaces': 'value',
        unicode: '日本語テスト',
      };
      const entity = createMockResourceSubscriptionEntity({
        subscriptionMetadata: metadata,
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(result.subscriptionMetadata).toEqual(metadata);
    });

    it('should handle null createdBy', () => {
      const entity = createMockResourceSubscriptionEntity({
        createdBy: null,
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(result.createdBy).toBeNull();
    });

    it('should handle createdBy with value', () => {
      const entity = createMockResourceSubscriptionEntity({
        createdBy: 'system-user-123',
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(result.createdBy).toBe('system-user-123');
    });

    it('should handle UUID format IDs', () => {
      const entity = createMockResourceSubscriptionEntity({
        id: '01912345-6789-7abc-def0-123456789abc',
        resourceId: '01987654-3210-7fed-cba9-876543210fed',
        targetUserId: '01abcdef-0123-7456-789a-bcdef0123456',
      });

      const result = ResourceSubscriptionDtoMapper.ToResponse(entity as any);

      expect(result.id).toBe('01912345-6789-7abc-def0-123456789abc');
      expect(result.resourceId).toBe('01987654-3210-7fed-cba9-876543210fed');
      expect(result.targetUserId).toBe('01abcdef-0123-7456-789a-bcdef0123456');
    });
  });

  describe('ToPaginatedResponse - edge cases', () => {
    it('should handle single item in data array', () => {
      const entities = [createMockResourceSubscriptionEntity({ id: 'single-sub' })];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 1,
        limit: 10,
        page: 1,
      });

      const result = ResourceSubscriptionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('single-sub');
    });

    it('should handle mixed subscription types in paginated results', () => {
      const entities = [
        createMockResourceSubscriptionEntity({
          id: 'sub-1',
          subscriptionType: ResourceSubscriptionType.SUBSCRIBER,
          resourceStatus: ResourceStatusType.ENABLED,
        }),
        createMockResourceSubscriptionEntity({
          id: 'sub-2',
          subscriptionType: ResourceSubscriptionType.CREATOR,
          resourceStatus: ResourceStatusType.DISABLED,
        }),
        createMockResourceSubscriptionEntity({
          id: 'sub-3',
          subscriptionType: ResourceSubscriptionType.MENTIONED,
          resourceStatus: ResourceStatusType.ARCHIVED,
        }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 3,
        limit: 10,
        page: 1,
      });

      const result = ResourceSubscriptionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data[0].subscriptionType).toBe(ResourceSubscriptionType.SUBSCRIBER);
      expect(result.data[0].resourceStatus).toBe(ResourceStatusType.ENABLED);
      expect(result.data[1].subscriptionType).toBe(ResourceSubscriptionType.CREATOR);
      expect(result.data[1].resourceStatus).toBe(ResourceStatusType.DISABLED);
      expect(result.data[2].subscriptionType).toBe(ResourceSubscriptionType.MENTIONED);
      expect(result.data[2].resourceStatus).toBe(ResourceStatusType.ARCHIVED);
    });

    it('should handle mixed null and non-null subscriptionMetadata', () => {
      const entities = [
        createMockResourceSubscriptionEntity({
          id: 'sub-1',
          subscriptionMetadata: { key: 'value' },
        }),
        createMockResourceSubscriptionEntity({
          id: 'sub-2',
          subscriptionMetadata: null,
        }),
        createMockResourceSubscriptionEntity({
          id: 'sub-3',
          subscriptionMetadata: { another: 'data' },
        }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 3,
        limit: 10,
        page: 1,
      });

      const result = ResourceSubscriptionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data[0].subscriptionMetadata).toEqual({ key: 'value' });
      expect(result.data[1].subscriptionMetadata).toBeNull();
      expect(result.data[2].subscriptionMetadata).toEqual({ another: 'data' });
    });

    it('should preserve order of entities in paginated response', () => {
      const entities = [
        createMockResourceSubscriptionEntity({ id: 'first' }),
        createMockResourceSubscriptionEntity({ id: 'second' }),
        createMockResourceSubscriptionEntity({ id: 'third' }),
        createMockResourceSubscriptionEntity({ id: 'fourth' }),
        createMockResourceSubscriptionEntity({ id: 'fifth' }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 5,
        limit: 10,
        page: 1,
      });

      const result = ResourceSubscriptionDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data.map((d) => d.id)).toEqual(['first', 'second', 'third', 'fourth', 'fifth']);
    });
  });
});
