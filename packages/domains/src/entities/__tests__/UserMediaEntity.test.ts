/**
 * UserMediaEntity.validate() Unit Tests
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `user.prisma` model `UserMedia`):
 *   - userId:  required, non-empty after trim (FK to User).
 *   - mediaId: required, non-empty after trim (FK to Media).
 *   - sharedAt: optional DateTime — track-only per Conservative Defaults.
 */

import { describe, it, expect } from 'vitest';
import {
  UserMediaEntity,
  IUserMediaEntity,
} from '../generated/core/UserMediaEntity';
import { ResourceStatusType } from '../../enums';

function createValidInit(
  overrides: Partial<IUserMediaEntity> = {},
): IUserMediaEntity {
  return {
    id: 'um-test-id',
    tenantId: '50000000-0000-0000-0000-000000000000',
    sharedAt: null,
    userId: '60000000-0000-0000-0000-000000000001',
    User: null,
    mediaId: '70000000-0000-0000-0000-000000000001',
    Media: null,
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
  } as IUserMediaEntity;
}

describe('UserMediaEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new UserMediaEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new UserMediaEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it('should accept a populated sharedAt (track-only)', () => {
      const entity = new UserMediaEntity(
        createValidInit({ sharedAt: new Date('2026-05-01') }),
      );

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('userId', () => {
    it('should throw when userId is empty', () => {
      const entity = new UserMediaEntity(createValidInit({ userId: '' }));

      expect(() => entity.validate()).toThrow('User media userId is required');
    });

    it('should throw when userId is whitespace only', () => {
      const entity = new UserMediaEntity(createValidInit({ userId: '   ' }));

      expect(() => entity.validate()).toThrow('User media userId is required');
    });
  });

  describe('mediaId', () => {
    it('should throw when mediaId is empty', () => {
      const entity = new UserMediaEntity(createValidInit({ mediaId: '' }));

      expect(() => entity.validate()).toThrow('User media mediaId is required');
    });

    it('should throw when mediaId is whitespace only', () => {
      const entity = new UserMediaEntity(createValidInit({ mediaId: '   ' }));

      expect(() => entity.validate()).toThrow('User media mediaId is required');
    });
  });
});
