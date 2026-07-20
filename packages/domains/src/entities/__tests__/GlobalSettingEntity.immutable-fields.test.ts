/**
 * Phase 0 Item 2 (TASK-302 Stream A) — entity-level immutability pin.
 *
 * GlobalSettingEntity.key / tenantId / locked / defaultValue MUST throw
 * when assigned after construction. The mapper and factory build via
 * the constructor's `init` payload, so this contract does not break
 * legitimate persistence. Only setter-based mutation paths (mass
 * assignment, applyChangesToEntity, ad-hoc service code) are blocked.
 */
import { describe, it, expect } from 'vitest';
import { GlobalSettingFactory } from '../../factories';
import { ValueType } from '../../enums';

describe('GlobalSettingEntity — Phase 0 Item 2 immutable fields', () => {
  const build = () =>
    GlobalSettingFactory.CreateGlobalSetting({
      tenantId: 'tenant-1',
      key: 'enable-x',
      value: 'false',
      dataType: ValueType.Boolean,
      defaultValue: 'false',
      name: 'enable-x',
      namespace: 'com.flw.feature',
      description: '',
      locked: false,
    });

  it.each(['key', 'tenantId', 'locked', 'defaultValue'] as const)(
    'throws when setting %s post-construction',
    (field) => {
      const entity = build();
      expect(() => {
        (entity as any)[field] = field === 'locked' ? true : 'attacker';
      }).toThrow(/immutable|cannot be modified/i);
    },
  );

  it('allows mutating value and description post-construction', () => {
    const entity = build();
    expect(() => {
      entity.value = 'true';
    }).not.toThrow();
    expect(() => {
      entity.description = 'updated';
    }).not.toThrow();
  });
});
