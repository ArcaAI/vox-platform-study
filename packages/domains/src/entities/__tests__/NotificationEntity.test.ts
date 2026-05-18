/**
 * NotificationEntity.validate() Unit Tests — TASK-261 (Tier 2)
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `notification.prisma`):
 *   - title:        required, non-empty after trim, <= 255 chars.
 *   - type:         required, must be a valid `Enums.NotificationType` member.
 *   - read:         required boolean.
 *   - targetUserId: required, non-empty after trim (FK to User).
 *   - resourceSubscriptionId: optional FK; non-empty when present.
 *   - messageText / messageRichText: optional unbounded TEXT — track-only.
 *   - messageContent: optional JSON — track-only per Conservative Defaults.
 */

import { describe, it, expect } from 'vitest';
import {
  NotificationEntity,
  INotificationEntity,
} from '../generated/core/NotificationEntity';
import { NotificationType, ResourceStatusType } from '../../enums';

function createValidInit(
  overrides: Partial<INotificationEntity> = {},
): INotificationEntity {
  return {
    id: 'notif-test-id',
    tenantId: '50000000-0000-0000-0000-000000000000',
    title: 'Hello',
    messageText: 'You have a new message.',
    messageRichText: null,
    messageContent: null,
    type: NotificationType.STANDARD,
    read: false,
    resourceSubscriptionId: null,
    ResourceSubscription: null,
    targetUserId: '60000000-0000-0000-0000-000000000001',
    TargetUser: null,
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
  } as INotificationEntity;
}

describe('NotificationEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new NotificationEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new NotificationEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it.each(Object.values(NotificationType))(
      'should accept type %s',
      (type) => {
        const entity = new NotificationEntity(createValidInit({ type }));

        expect(() => entity.validate()).not.toThrow();
      },
    );

    it('should accept null/undefined optional message fields', () => {
      const entity = new NotificationEntity(
        createValidInit({
          messageText: null,
          messageRichText: null,
          messageContent: null,
          resourceSubscriptionId: null,
        }),
      );

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('title', () => {
    it('should throw when title is empty', () => {
      const entity = new NotificationEntity(createValidInit({ title: '' }));

      expect(() => entity.validate()).toThrow('Notification title is required');
    });

    it('should throw when title is whitespace only', () => {
      const entity = new NotificationEntity(createValidInit({ title: '   ' }));

      expect(() => entity.validate()).toThrow('Notification title is required');
    });

    it('should throw when title exceeds 255 characters', () => {
      const entity = new NotificationEntity(
        createValidInit({ title: 'x'.repeat(256) }),
      );

      expect(() => entity.validate()).toThrow(
        'Notification title must not exceed 255 characters',
      );
    });

    it('should accept title exactly 255 characters', () => {
      const entity = new NotificationEntity(
        createValidInit({ title: 'x'.repeat(255) }),
      );

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('type', () => {
    it('should throw when type is undefined', () => {
      const entity = new NotificationEntity(
        createValidInit({ type: undefined as unknown as NotificationType }),
      );

      expect(() => entity.validate()).toThrow('Notification type is required');
    });

    it('should throw when type is not a member of NotificationType', () => {
      const entity = new NotificationEntity(
        createValidInit({
          type: 'NotARealType' as unknown as NotificationType,
        }),
      );

      expect(() => entity.validate()).toThrow('Notification type is invalid');
    });
  });

  describe('read', () => {
    it('should throw when read is not a boolean', () => {
      const entity = new NotificationEntity(
        createValidInit({ read: null as unknown as boolean }),
      );

      expect(() => entity.validate()).toThrow(
        'Notification read must be a boolean',
      );
    });

    it('should accept read=true', () => {
      const entity = new NotificationEntity(createValidInit({ read: true }));

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('targetUserId', () => {
    it('should throw when targetUserId is empty', () => {
      const entity = new NotificationEntity(
        createValidInit({ targetUserId: '' }),
      );

      expect(() => entity.validate()).toThrow(
        'Notification targetUserId is required',
      );
    });

    it('should throw when targetUserId is whitespace only', () => {
      const entity = new NotificationEntity(
        createValidInit({ targetUserId: '   ' }),
      );

      expect(() => entity.validate()).toThrow(
        'Notification targetUserId is required',
      );
    });
  });

  describe('resourceSubscriptionId', () => {
    it('should accept null resourceSubscriptionId', () => {
      const entity = new NotificationEntity(
        createValidInit({ resourceSubscriptionId: null }),
      );

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw when resourceSubscriptionId is an empty string', () => {
      const entity = new NotificationEntity(
        createValidInit({ resourceSubscriptionId: '   ' }),
      );

      expect(() => entity.validate()).toThrow(
        'Notification resourceSubscriptionId must not be empty when provided',
      );
    });
  });
});
