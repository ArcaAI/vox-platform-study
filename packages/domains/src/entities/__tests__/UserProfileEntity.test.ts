/**
 * UserProfileEntity.validate() Unit Tests
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `user.prisma` model `UserProfile`):
 *   - userId: required, non-empty after trim (FK to User)
 *   - firstName / lastName / email / phone / avatarId: optional;
 *     when present, length <= 255 (Prisma column has no explicit cap,
 *     so the conservative default applies).
 */

import { describe, it, expect } from 'vitest';
import { UserProfileEntity, IUserProfileEntity } from '../generated/core/UserProfileEntity';
import { ResourceStatusType } from '../../enums';

function createValidInit(overrides: Partial<IUserProfileEntity> = {}): IUserProfileEntity {
  return {
    id: 'up-test-id',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    phone: '+1-555-0100',
    avatarId: null,
    userId: '60000000-0000-0000-0000-000000000001',
    User: null,
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
  } as IUserProfileEntity;
}

describe('UserProfileEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new UserProfileEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new UserProfileEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it('should accept null/undefined optional fields', () => {
      const entity = new UserProfileEntity(
        createValidInit({
          firstName: null,
          lastName: null,
          email: null,
          phone: null,
          avatarId: null,
        }),
      );

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('userId', () => {
    it('should throw when userId is empty', () => {
      const entity = new UserProfileEntity(createValidInit({ userId: '' }));

      expect(() => entity.validate()).toThrow('User profile userId is required');
    });

    it('should throw when userId is whitespace only', () => {
      const entity = new UserProfileEntity(createValidInit({ userId: '   ' }));

      expect(() => entity.validate()).toThrow('User profile userId is required');
    });
  });

  describe('firstName', () => {
    it('should throw when firstName exceeds 255 characters', () => {
      const entity = new UserProfileEntity(createValidInit({ firstName: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('User profile firstName must not exceed 255 characters');
    });

    it('should accept firstName exactly 255 characters', () => {
      const entity = new UserProfileEntity(createValidInit({ firstName: 'x'.repeat(255) }));

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('lastName', () => {
    it('should throw when lastName exceeds 255 characters', () => {
      const entity = new UserProfileEntity(createValidInit({ lastName: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('User profile lastName must not exceed 255 characters');
    });
  });

  describe('email', () => {
    it('should throw when email exceeds 255 characters', () => {
      const entity = new UserProfileEntity(createValidInit({ email: `${'x'.repeat(251)}@a.io` }));

      expect(() => entity.validate()).toThrow('User profile email must not exceed 255 characters');
    });
  });

  describe('phone', () => {
    it('should throw when phone exceeds 255 characters', () => {
      const entity = new UserProfileEntity(createValidInit({ phone: '1'.repeat(256) }));

      expect(() => entity.validate()).toThrow('User profile phone must not exceed 255 characters');
    });
  });

  describe('avatarId', () => {
    it('should throw when avatarId exceeds 255 characters', () => {
      const entity = new UserProfileEntity(createValidInit({ avatarId: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('User profile avatarId must not exceed 255 characters');
    });
  });

  // Backend preferred prompt template soft reference.
  describe('preferredPromptTemplateId', () => {
    it('should carry preferredPromptTemplateId through the constructor', () => {
      const entity = new UserProfileEntity(createValidInit({ preferredPromptTemplateId: 'tpl-123' }));

      expect(entity.preferredPromptTemplateId).toBe('tpl-123');
    });

    it('should record a tracked change when reassigned via the setter', () => {
      const entity = new UserProfileEntity(createValidInit());

      entity.preferredPromptTemplateId = 'tpl-new';

      expect(entity.preferredPromptTemplateId).toBe('tpl-new');
      expect(entity.changes).toMatchObject({ preferredPromptTemplateId: 'tpl-new' });
    });

    it('should throw when preferredPromptTemplateId exceeds 255 characters', () => {
      const entity = new UserProfileEntity(createValidInit({ preferredPromptTemplateId: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('User profile preferredPromptTemplateId must not exceed 255 characters');
    });
  });
});
