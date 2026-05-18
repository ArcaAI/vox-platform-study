/**
 * UserSettingsEntity.validate() Unit Tests — TASK-261 (Tier 2)
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `user.prisma` model `UserSettings`):
 *   - name: required, non-empty after trim, <= 255 chars (no Prisma cap → default).
 *   - key:  required, non-empty after trim, <= 100 chars (mirrors GlobalSetting).
 *   - value: required string (Prisma column non-null).
 *   - dataType: must be a valid `Enums.ValueType` member.
 *   - namespace: optional; <= 100 chars when present.
 *   - userId: required, non-empty after trim (FK to User).
 *
 * Per Conservative Defaults (TASK-261 README), no JSON-shape parsing is
 * applied to `value` here — track-only.
 */

import { describe, it, expect } from 'vitest';
import {
  UserSettingsEntity,
  IUserSettingsEntity,
} from '../generated/core/UserSettingsEntity';
import { ResourceStatusType, ValueType } from '../../enums';

function createValidInit(
  overrides: Partial<IUserSettingsEntity> = {},
): IUserSettingsEntity {
  return {
    id: 'us-test-id',
    name: 'theme',
    key: 'ui.theme',
    value: 'dark',
    dataType: ValueType.String,
    namespace: 'preferences',
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
  } as IUserSettingsEntity;
}

describe('UserSettingsEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new UserSettingsEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new UserSettingsEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it.each(Object.values(ValueType))(
      'should accept dataType %s (track-only on value)',
      (dataType) => {
        const entity = new UserSettingsEntity(
          createValidInit({ dataType, value: 'anything' }),
        );

        expect(() => entity.validate()).not.toThrow();
      },
    );
  });

  describe('name', () => {
    it('should throw when name is empty', () => {
      const entity = new UserSettingsEntity(createValidInit({ name: '' }));

      expect(() => entity.validate()).toThrow('User settings name is required');
    });

    it('should throw when name is whitespace only', () => {
      const entity = new UserSettingsEntity(createValidInit({ name: '   ' }));

      expect(() => entity.validate()).toThrow('User settings name is required');
    });

    it('should throw when name exceeds 255 characters', () => {
      const entity = new UserSettingsEntity(
        createValidInit({ name: 'x'.repeat(256) }),
      );

      expect(() => entity.validate()).toThrow(
        'User settings name must not exceed 255 characters',
      );
    });
  });

  describe('key', () => {
    it('should throw when key is empty', () => {
      const entity = new UserSettingsEntity(createValidInit({ key: '' }));

      expect(() => entity.validate()).toThrow('User settings key is required');
    });

    it('should throw when key is whitespace only', () => {
      const entity = new UserSettingsEntity(createValidInit({ key: '   ' }));

      expect(() => entity.validate()).toThrow('User settings key is required');
    });

    it('should throw when key exceeds 100 characters', () => {
      const entity = new UserSettingsEntity(
        createValidInit({ key: 'x'.repeat(101) }),
      );

      expect(() => entity.validate()).toThrow(
        'User settings key must not exceed 100 characters',
      );
    });
  });

  describe('value', () => {
    it('should throw when value is undefined', () => {
      const entity = new UserSettingsEntity(
        createValidInit({ value: undefined as unknown as string }),
      );

      expect(() => entity.validate()).toThrow(
        'User settings value must be a string',
      );
    });

    it('should throw when value is null', () => {
      const entity = new UserSettingsEntity(
        createValidInit({ value: null as unknown as string }),
      );

      expect(() => entity.validate()).toThrow(
        'User settings value must be a string',
      );
    });

    it('should accept empty string value', () => {
      const entity = new UserSettingsEntity(createValidInit({ value: '' }));

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('dataType', () => {
    it('should throw when dataType is undefined', () => {
      const entity = new UserSettingsEntity(
        createValidInit({ dataType: undefined as unknown as ValueType }),
      );

      expect(() => entity.validate()).toThrow(
        'User settings dataType is required',
      );
    });

    it('should throw when dataType is not a member of ValueType', () => {
      const entity = new UserSettingsEntity(
        createValidInit({ dataType: 'NotAValueType' as unknown as ValueType }),
      );

      expect(() => entity.validate()).toThrow(
        'User settings dataType is invalid',
      );
    });
  });

  describe('namespace', () => {
    it('should accept null namespace', () => {
      const entity = new UserSettingsEntity(
        createValidInit({ namespace: null }),
      );

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw when namespace exceeds 100 characters', () => {
      const entity = new UserSettingsEntity(
        createValidInit({ namespace: 'x'.repeat(101) }),
      );

      expect(() => entity.validate()).toThrow(
        'User settings namespace must not exceed 100 characters',
      );
    });
  });

  describe('userId', () => {
    it('should throw when userId is empty', () => {
      const entity = new UserSettingsEntity(createValidInit({ userId: '' }));

      expect(() => entity.validate()).toThrow('User settings userId is required');
    });

    it('should throw when userId is whitespace only', () => {
      const entity = new UserSettingsEntity(createValidInit({ userId: '   ' }));

      expect(() => entity.validate()).toThrow('User settings userId is required');
    });
  });
});
