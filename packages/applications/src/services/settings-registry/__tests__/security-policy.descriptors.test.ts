/**
 * the credential-policy catalog.
 *
 * Registering a descriptor is the ONLY step that makes a key governed and
 * writable, so these assertions are the difference between "a super admin can
 * manage the policy" and "a super admin cannot reach it". Two invariants worth
 * pinning beyond mere presence: the keys are PLATFORM-only (a tenant admin must
 * not be able to weaken the material the platform issues), and every declared
 * `default` equals the reader's own code default, so cataloging them changed no
 * behaviour.
 */
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { DEFAULT_PASSWORD_POLICY, PASSWORD_POLICY_SETTING_KEYS } from '../../user/userPassword/password-policy';
import { DEFAULT_GENERATED_SECRET_POLICY, SECRET_POLICY_SETTING_KEYS } from '../../security/secretPolicy';

const ALL_KEYS = [...Object.values(PASSWORD_POLICY_SETTING_KEYS), ...Object.values(SECRET_POLICY_SETTING_KEYS)];

describe('security policy descriptors', () => {
  it('registers every password-policy and issued-secret key', () => {
    for (const key of ALL_KEYS) expect(HOPE_SETTINGS_REGISTRY.has(key), key).toBe(true);
  });

  it('scopes them to the platform: SYSTEM-only, super-admin-editable, global-kv', () => {
    for (const key of ALL_KEYS) {
      const d = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
      expect(d.tier, key).toBe('global-kv');
      expect(d.maxScope, key).toBe('system');
      expect(d.globalOnly, key).toBe(true);
      expect(d.editableBy, key).toBe('all');
    }
  });

  it('declares them as policy bounds that degrade to the default, never as secrets', () => {
    for (const key of ALL_KEYS) {
      const d = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
      expect(d.failMode, key).toBe('open-to-default');
      expect(d.sensitivity, key).toBe('internal');
      expect(d.killSwitch, key).toBeUndefined();
    }
  });

  it('mirrors the readers own code defaults (cataloging changed no behaviour)', () => {
    for (const [field, key] of Object.entries(PASSWORD_POLICY_SETTING_KEYS)) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key).default, key).toBe(DEFAULT_PASSWORD_POLICY[field as keyof typeof DEFAULT_PASSWORD_POLICY]);
    }
    for (const [field, key] of Object.entries(SECRET_POLICY_SETTING_KEYS)) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key).default, key).toBe(
        DEFAULT_GENERATED_SECRET_POLICY[field as keyof typeof DEFAULT_GENERATED_SECRET_POLICY],
      );
    }
  });

  it('does NOT catalog the password maximum length — it is a hashing bound, not policy', () => {
    expect(HOPE_SETTINGS_REGISTRY.has('security.password.maxLength')).toBe(false);
  });
});
