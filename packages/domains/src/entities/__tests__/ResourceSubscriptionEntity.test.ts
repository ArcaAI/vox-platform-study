/**
 * ResourceSubscriptionEntity.validate() Unit Tests
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `notification.prisma` model
 * `ResourceSubscription`):
 *   - subscriptionType: required, must be a valid `Enums.ResourceSubscriptionType` member.
 *   - targetUserId: required, non-empty after trim (FK to User).
 *   - resourceId: optional FK; non-empty when present.
 *   - resourceTypeName: optional; <= 255 chars when present.
 *   - subscriptionMetadata: optional JSON — track-only per Conservative Defaults.
 */

import { describe, it, expect } from 'vitest';
import {
  ResourceSubscriptionEntity,
  IResourceSubscriptionEntity,
} from '../generated/core/ResourceSubscriptionEntity';
import { ResourceStatusType, ResourceSubscriptionType } from '../../enums';

function createValidInit(
  overrides: Partial<IResourceSubscriptionEntity> = {},
): IResourceSubscriptionEntity {
  return {
    id: 'rs-test-id',
    tenantId: '50000000-0000-0000-0000-000000000000',
    resourceId: '70000000-0000-0000-0000-000000000001',
    resourceTypeName: 'Consultation',
    subscriptionType: ResourceSubscriptionType.SUBSCRIBER,
    targetUserId: '60000000-0000-0000-0000-000000000001',
    subscriptionMetadata: null,
    Subscribers: null,
    Notifications: null,
    tags: [],
    Tenant: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    createdBy: 'user-1',
    updatedBy: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    metaData: undefined,
    version: 1,
    ...overrides,
  } as IResourceSubscriptionEntity;
}

describe('ResourceSubscriptionEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new ResourceSubscriptionEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new ResourceSubscriptionEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it.each(Object.values(ResourceSubscriptionType))(
      'should accept subscriptionType %s',
      (subscriptionType) => {
        const entity = new ResourceSubscriptionEntity(
          createValidInit({ subscriptionType }),
        );

        expect(() => entity.validate()).not.toThrow();
      },
    );

    it('should accept null/undefined optional resourceId, resourceTypeName, subscriptionMetadata', () => {
      const entity = new ResourceSubscriptionEntity(
        createValidInit({
          resourceId: null,
          resourceTypeName: null,
          subscriptionMetadata: null,
        }),
      );

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('subscriptionType', () => {
    it('should throw when subscriptionType is undefined', () => {
      const entity = new ResourceSubscriptionEntity(
        createValidInit({
          subscriptionType: undefined as unknown as ResourceSubscriptionType,
        }),
      );

      expect(() => entity.validate()).toThrow(
        'Resource subscription subscriptionType is required',
      );
    });

    it('should throw when subscriptionType is not a member of ResourceSubscriptionType', () => {
      const entity = new ResourceSubscriptionEntity(
        createValidInit({
          subscriptionType: 'NOT_A_TYPE' as unknown as ResourceSubscriptionType,
        }),
      );

      expect(() => entity.validate()).toThrow(
        'Resource subscription subscriptionType is invalid',
      );
    });
  });

  describe('targetUserId', () => {
    it('should throw when targetUserId is empty', () => {
      const entity = new ResourceSubscriptionEntity(
        createValidInit({ targetUserId: '' }),
      );

      expect(() => entity.validate()).toThrow(
        'Resource subscription targetUserId is required',
      );
    });

    it('should throw when targetUserId is whitespace only', () => {
      const entity = new ResourceSubscriptionEntity(
        createValidInit({ targetUserId: '   ' }),
      );

      expect(() => entity.validate()).toThrow(
        'Resource subscription targetUserId is required',
      );
    });
  });

  describe('resourceId', () => {
    it('should throw when resourceId is whitespace only', () => {
      const entity = new ResourceSubscriptionEntity(
        createValidInit({ resourceId: '   ' }),
      );

      expect(() => entity.validate()).toThrow(
        'Resource subscription resourceId must not be empty when provided',
      );
    });
  });

  describe('resourceTypeName', () => {
    it('should throw when resourceTypeName exceeds 255 characters', () => {
      const entity = new ResourceSubscriptionEntity(
        createValidInit({ resourceTypeName: 'x'.repeat(256) }),
      );

      expect(() => entity.validate()).toThrow(
        'Resource subscription resourceTypeName must not exceed 255 characters',
      );
    });

    it('should accept resourceTypeName exactly 255 characters', () => {
      const entity = new ResourceSubscriptionEntity(
        createValidInit({ resourceTypeName: 'x'.repeat(255) }),
      );

      expect(() => entity.validate()).not.toThrow();
    });
  });
});
