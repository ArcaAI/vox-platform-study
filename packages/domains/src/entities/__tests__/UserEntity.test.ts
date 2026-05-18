/**
 * UserEntity.validate() Unit Tests — TASK-261 (Tier 1)
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `user.prisma` `User` model +
 * `IUserEntity` interface):
 *   - username: non-empty trimmed, <= 255 chars (unique constraint at DB)
 *   - password: non-empty (opaque hash; treated as required string)
 *   - isServiceAccount: must be a boolean
 *   - externalId: optional; <= 255 chars when present
 *   - secret1 / secret2: optional; <= 255 chars when present
 *
 * Note: `secret*Expiry` and `lastLoginAt` / `lastActiveAt` dates are
 * track-only per TASK-261 Conservative Defaults.
 */

import { describe, it, expect } from 'vitest';
import { UserEntity, IUserEntity } from '../generated/core/UserEntity';
import { ResourceStatusType } from '../../enums';

function createValidInit(overrides: Partial<IUserEntity> = {}): IUserEntity {
  return {
    id: 'user-test-id',
    username: 'jane.doe',
    password: '$2b$10$hashedpasswordvalue',
    lastLoginAt: null,
    lastActiveAt: null,
    externalId: null,
    isServiceAccount: false,
    secret1: null,
    secret1Expiry: null,
    secret2: null,
    secret2Expiry: null,
    UserProfile: null,
    UserSettings: [],
    UserRoleAssignments: [],
    UserNotifications: [],
    ResourceSubscriptions: [],
    UserMedias: [],
    tags: [],
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
  } as IUserEntity;
}

describe('UserEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new UserEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new UserEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it('should accept a service account', () => {
      const entity = new UserEntity(
        createValidInit({
          username: 'svc.api',
          isServiceAccount: true,
        }),
      );

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('username', () => {
    it('should throw when username is empty', () => {
      const entity = new UserEntity(createValidInit({ username: '' }));

      expect(() => entity.validate()).toThrow('User username is required');
    });

    it('should throw when username is whitespace only', () => {
      const entity = new UserEntity(createValidInit({ username: '   ' }));

      expect(() => entity.validate()).toThrow('User username is required');
    });

    it('should throw when username exceeds 255 characters', () => {
      const entity = new UserEntity(
        createValidInit({ username: 'x'.repeat(256) }),
      );

      expect(() => entity.validate()).toThrow(
        'User username must not exceed 255 characters',
      );
    });

    it('should accept username exactly 255 characters', () => {
      const entity = new UserEntity(
        createValidInit({ username: 'x'.repeat(255) }),
      );

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('password', () => {
    it('should throw when password is empty', () => {
      const entity = new UserEntity(createValidInit({ password: '' }));

      expect(() => entity.validate()).toThrow('User password is required');
    });

    it('should throw when password is whitespace only', () => {
      const entity = new UserEntity(createValidInit({ password: '   ' }));

      expect(() => entity.validate()).toThrow('User password is required');
    });
  });

  describe('isServiceAccount', () => {
    it('should throw when isServiceAccount is not a boolean', () => {
      const entity = new UserEntity(
        createValidInit({
          isServiceAccount: null as unknown as boolean,
        }),
      );

      expect(() => entity.validate()).toThrow(
        'User isServiceAccount must be a boolean',
      );
    });
  });

  describe('externalId', () => {
    it('should accept null externalId', () => {
      const entity = new UserEntity(createValidInit({ externalId: null }));

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw when externalId exceeds 255 characters', () => {
      const entity = new UserEntity(
        createValidInit({ externalId: 'x'.repeat(256) }),
      );

      expect(() => entity.validate()).toThrow(
        'User externalId must not exceed 255 characters',
      );
    });
  });

  describe('secret fields', () => {
    it('should accept null secret1/secret2', () => {
      const entity = new UserEntity(
        createValidInit({ secret1: null, secret2: null }),
      );

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw when secret1 exceeds 255 characters', () => {
      const entity = new UserEntity(
        createValidInit({ secret1: 'x'.repeat(256) }),
      );

      expect(() => entity.validate()).toThrow(
        'User secret1 must not exceed 255 characters',
      );
    });

    it('should throw when secret2 exceeds 255 characters', () => {
      const entity = new UserEntity(
        createValidInit({ secret2: 'x'.repeat(256) }),
      );

      expect(() => entity.validate()).toThrow(
        'User secret2 must not exceed 255 characters',
      );
    });
  });
});
