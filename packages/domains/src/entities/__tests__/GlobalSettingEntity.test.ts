/**
 * GlobalSettingEntity.validate() Unit Tests
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `globalSetting.prisma`):
 *   - name: non-empty trimmed
 *   - key:  non-empty trimmed, <= 100 chars
 *   - dataType: must be a valid `Enums.ValueType` member
 *   - value: must be a string (Prisma column is required); empty string is
 *     tolerated to support the `fetchTenantConfigs` masking pattern in
 *     `tenant.service.ts`, where locked rows are surfaced with `value=''`
 *     to non-super-admin callers.
 *   - namespace: optional; <= 100 chars when present
 *   - defaultValue: optional; <= 4000 chars when present
 *   - locked: must be a boolean (sanity check; Prisma column is non-null)
 */

import { describe, it, expect } from 'vitest';
import {
  GlobalSettingEntity,
  IGlobalSettingEntity,
} from '../generated/core/GlobalSettingEntity';
import { ResourceStatusType, ValueType } from '../../enums';

function createValidInit(
  overrides: Partial<IGlobalSettingEntity> = {},
): IGlobalSettingEntity {
  return {
    id: 'gs-test-id',
    tenantId: '50000000-0000-0000-0000-000000000000',
    name: 'feature_flag',
    description: null,
    key: 'enable_x',
    defaultValue: null,
    value: 'true',
    locked: false,
    dataType: ValueType.Boolean,
    namespace: 'platform',
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
  } as IGlobalSettingEntity;
}

describe('GlobalSettingEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new GlobalSettingEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new GlobalSettingEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it.each(Object.values(ValueType))(
      'should accept dataType %s with a matching value',
      (dataType) => {
        const sampleValues: Record<ValueType, string> = {
          [ValueType.String]: 'hello',
          [ValueType.Integer]: '42',
          [ValueType.Float]: '3.14',
          [ValueType.Double]: '3.14',
          [ValueType.Decimal]: '3.14',
          [ValueType.Boolean]: 'true',
          [ValueType.Json]: '{"a":1}',
          [ValueType.Date]: '2026-01-01',
          [ValueType.DateTime]: '2026-01-01T00:00:00Z',
          [ValueType.Array]: '[1,2,3]',
          [ValueType.Uuid]: '50000000-0000-0000-0000-000000000000',
          [ValueType.Binary]: 'aGVsbG8=',
          [ValueType.Enum]: 'ENABLED',
          [ValueType.Hstore]: '"a"=>"1"',
          [ValueType.Inet]: '127.0.0.1',
          [ValueType.Citext]: 'hello',
          [ValueType.Interval]: '1 day',
        };
        const entity = new GlobalSettingEntity(
          createValidInit({ dataType, value: sampleValues[dataType] }),
        );

        expect(() => entity.validate()).not.toThrow();
      },
    );
  });

  describe('name', () => {
    it('should throw when name is empty', () => {
      const entity = new GlobalSettingEntity(createValidInit({ name: '' }));

      expect(() => entity.validate()).toThrow('Global setting name is required');
    });

    it('should throw when name is whitespace only', () => {
      const entity = new GlobalSettingEntity(createValidInit({ name: '   ' }));

      expect(() => entity.validate()).toThrow('Global setting name is required');
    });
  });

  describe('key', () => {
    it('should throw when key is empty', () => {
      const entity = new GlobalSettingEntity(createValidInit({ key: '' }));

      expect(() => entity.validate()).toThrow('Global setting key is required');
    });

    it('should throw when key is whitespace only', () => {
      const entity = new GlobalSettingEntity(createValidInit({ key: '   ' }));

      expect(() => entity.validate()).toThrow('Global setting key is required');
    });

    it('should throw when key exceeds 100 characters', () => {
      const entity = new GlobalSettingEntity(
        createValidInit({ key: 'x'.repeat(101) }),
      );

      expect(() => entity.validate()).toThrow('must not exceed 100 characters');
    });

    it('should accept key exactly 100 characters', () => {
      const entity = new GlobalSettingEntity(
        createValidInit({ key: 'x'.repeat(100) }),
      );

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('dataType', () => {
    it('should throw when dataType is undefined', () => {
      const entity = new GlobalSettingEntity(
        createValidInit({ dataType: undefined as unknown as ValueType }),
      );

      expect(() => entity.validate()).toThrow('Global setting dataType is required');
    });

    it('should throw when dataType is not a member of ValueType', () => {
      const entity = new GlobalSettingEntity(
        createValidInit({ dataType: 'NotAValueType' as unknown as ValueType }),
      );

      expect(() => entity.validate()).toThrow('Global setting dataType is invalid');
    });
  });

  describe('value', () => {
    it('should throw when value is undefined', () => {
      const entity = new GlobalSettingEntity(
        createValidInit({ value: undefined as unknown as string }),
      );

      expect(() => entity.validate()).toThrow('Global setting value must be a string');
    });

    it('should throw when value is null', () => {
      const entity = new GlobalSettingEntity(
        createValidInit({ value: null as unknown as string }),
      );

      expect(() => entity.validate()).toThrow('Global setting value must be a string');
    });

    it('should accept empty string value (masked-on-read scenario)', () => {
      // tenant.service.ts:fetchTenantConfigs sets `config.value = ''` for locked
      // rows surfaced to non-super-admins. validate() must tolerate that case.
      const entity = new GlobalSettingEntity(createValidInit({ value: '' }));

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw when Integer value cannot be parsed', () => {
      const entity = new GlobalSettingEntity(
        createValidInit({ dataType: ValueType.Integer, value: 'not-a-number' }),
      );

      expect(() => entity.validate()).toThrow('cannot be parsed as Integer');
    });

    it('should throw when Json value is malformed', () => {
      const entity = new GlobalSettingEntity(
        createValidInit({ dataType: ValueType.Json, value: '{not-json}' }),
      );

      expect(() => entity.validate()).toThrow('cannot be parsed as Json');
    });

    it('should throw when Boolean value is neither "true" nor "false"', () => {
      const entity = new GlobalSettingEntity(
        createValidInit({ dataType: ValueType.Boolean, value: 'maybe' }),
      );

      expect(() => entity.validate()).toThrow('cannot be parsed as Boolean');
    });
  });

  describe('namespace', () => {
    it('should accept null namespace', () => {
      const entity = new GlobalSettingEntity(
        createValidInit({ namespace: null }),
      );

      expect(() => entity.validate()).not.toThrow();
    });

    it('should accept undefined namespace', () => {
      const entity = new GlobalSettingEntity(
        createValidInit({ namespace: undefined }),
      );

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw when namespace exceeds 100 characters', () => {
      const entity = new GlobalSettingEntity(
        createValidInit({ namespace: 'x'.repeat(101) }),
      );

      expect(() => entity.validate()).toThrow('namespace must not exceed 100 characters');
    });
  });

  describe('defaultValue', () => {
    it('should accept null defaultValue', () => {
      const entity = new GlobalSettingEntity(
        createValidInit({ defaultValue: null }),
      );

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw when defaultValue exceeds 4000 characters', () => {
      const entity = new GlobalSettingEntity(
        createValidInit({ defaultValue: 'x'.repeat(4001) }),
      );

      expect(() => entity.validate()).toThrow('defaultValue must not exceed 4000 characters');
    });
  });

  describe('locked', () => {
    it('should throw when locked is not a boolean', () => {
      const entity = new GlobalSettingEntity(
        createValidInit({ locked: null as unknown as boolean }),
      );

      expect(() => entity.validate()).toThrow('Global setting locked must be a boolean');
    });

    it('should accept locked=true', () => {
      const entity = new GlobalSettingEntity(createValidInit({ locked: true }));

      expect(() => entity.validate()).not.toThrow();
    });

    it('should accept locked=false', () => {
      const entity = new GlobalSettingEntity(createValidInit({ locked: false }));

      expect(() => entity.validate()).not.toThrow();
    });
  });
});
