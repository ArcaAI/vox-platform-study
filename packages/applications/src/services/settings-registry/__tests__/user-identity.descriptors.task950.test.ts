/**
 * TASK-950 — the three `identity.autoProvision.*` descriptors.
 *
 * These assertions are the CONTRACT `ContextUserIdentityService` codes against, not decoration:
 * the service resolves all three through `EffectiveSettingsService.resolveEffective`, and each
 * property below decides a branch it takes.
 *
 *  · `tier: 'global-kv'` is the only tier that RESOLVES and the only tier that is WRITABLE
 *    through the registry lane (see the descriptor file's header for the measured evidence).
 *    A drift to `db-config` turns every identity-bearing request into a 400.
 *  · `maxScope: 'tenant'` is what makes the cascade a cascade — with `'system'`,
 *    `TenantSettingsService.resolve` skips the tenant lane entirely and a tenant's own row
 *    could never govern.
 *  · `failMode` decides whether an unresolved value raises or degrades. `enabled` degrades to
 *    ON; the two SELECTION keys raise, and carry no code default that could be substituted.
 */

import { describe, expect, it } from 'vitest';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { applyDeclaredFailMode } from '../tenant-settings.service';
import { isTenantVisibleSetting } from '../catalog-visibility';
import {
  IDENTITY_AUTO_PROVISION_DEPARTMENT_ID_KEY,
  IDENTITY_AUTO_PROVISION_ENABLED_KEY,
  IDENTITY_AUTO_PROVISION_ROLE_ID_KEY,
  USER_IDENTITY_CATEGORY,
  USER_IDENTITY_SETTINGS,
} from '../descriptors/user-identity.descriptors';

const ALL_KEYS = [IDENTITY_AUTO_PROVISION_ENABLED_KEY, IDENTITY_AUTO_PROVISION_ROLE_ID_KEY, IDENTITY_AUTO_PROVISION_DEPARTMENT_ID_KEY];

describe('TASK-950 — identity.autoProvision.* descriptors are registered', () => {
  it('registers exactly the three keys, and the file exports the same three', () => {
    for (const key of ALL_KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.has(key), key).toBe(true);
    }
    expect(USER_IDENTITY_SETTINGS.map((d) => d.key)).toEqual(ALL_KEYS);
  });

  // The shared half. Hand-copying three descriptors is three chances for one to drift to a
  // tier that cannot resolve or a scope that skips the tenant lane, so assert it over all three.
  it('every key is global-kv, tenant-scoped, non-secret, and editable as a GlobalSetting', () => {
    for (const key of ALL_KEYS) {
      const d = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
      expect(d.tier, key).toBe('global-kv');
      expect(d.maxScope, key).toBe('tenant');
      expect(d.sensitivity, key).toBe('internal');
      expect(d.editableBy, key).toBe('GlobalSetting');
      expect(d.category, key).toBe(USER_IDENTITY_CATEGORY);
      // Not `globalOnly`: with `maxScope: 'tenant'` that pair is what makes the key visible
      // and writable to a TENANT admin (`isTenantVisibleSetting`), which is the whole point
      // of a tenant → SYSTEM cascade.
      expect(d.globalOnly, key).toBeUndefined();
      expect(isTenantVisibleSetting(d), key).toBe(true);
    }
  });

  it('`enabled` is a boolean that defaults ON and degrades to that default (OD-3)', () => {
    const d = HOPE_SETTINGS_REGISTRY.getOrThrow(IDENTITY_AUTO_PROVISION_ENABLED_KEY);
    expect(d.dataType).toBe('boolean');
    expect(d.failMode).toBe('open-to-default');
    expect(d.default).toBe(true);
    expect(applyDeclaredFailMode(d)).toBe(true);
    // Deliberately NOT a kill-switch: that flag binds a descriptor to the "must default OFF"
    // governance invariant, and the owner's answer here is ON.
    expect(d.killSwitch).toBeUndefined();
  });

  it('both id keys are fail-closed SELECTION with NO code default', () => {
    for (const key of [IDENTITY_AUTO_PROVISION_ROLE_ID_KEY, IDENTITY_AUTO_PROVISION_DEPARTMENT_ID_KEY]) {
      const d = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
      expect(d.dataType, key).toBe('string');
      expect(d.failMode, key).toBe('closed');
      // A default would be a substituted selection — exactly what fail-closed forbids. The
      // platform role value is a SEEDED SYSTEM row, not a literal in the descriptor file.
      expect(d.default, key).toBeUndefined();
      expect(() => applyDeclaredFailMode(d), key).toThrow(ArgumentInvalidException);
    }
  });

  it('both id keys refuse a value that is not a 36-char hyphenated hex id', () => {
    for (const key of [IDENTITY_AUTO_PROVISION_ROLE_ID_KEY, IDENTITY_AUTO_PROVISION_DEPARTMENT_ID_KEY]) {
      const validate = HOPE_SETTINGS_REGISTRY.getOrThrow(key).validate;
      expect(validate, key).toBeTypeOf('function');
      // Accepts the seeded reserved-prefix ids (which are NOT valid UUIDv4/v7) and a real
      // UUIDv7 alike — the grammar is 8-4-4-4-12 hex, deliberately version-agnostic.
      expect(validate!('00000000-0000-0000-0000-000000000010'), key).toBeUndefined();
      expect(validate!('0198f3a1-2b4c-7d8e-9f01-23456789abcd'), key).toBeUndefined();
      for (const bad of ['DOCTOR', '', 'not-an-id', '00000000-0000-0000-0000-00000000001', 42, null, undefined]) {
        expect(validate!(bad), `${key} ← ${String(bad)}`).toMatch(/36-character hyphenated hex id/);
      }
    }
  });

  it('neither id key declares an envOverride — these are control-plane rows, not deploy values', () => {
    for (const key of ALL_KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key).envOverride, key).toBeUndefined();
    }
  });

  // `consumedBy` puts a key on the PLATFORM-scope effective-config pull route — one cached
  // snapshot per Python process. A `maxScope: 'tenant'` key on that route would serve one
  // tenant's role/department id to every other tenant.
  it('declares no consumedBy — a tenant-scoped key never rides the platform pull route', () => {
    for (const key of ALL_KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key).consumedBy, key).toBeUndefined();
    }
  });
});
