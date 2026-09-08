/**
 * TASK-932 R-6 / D-6 — "bootstrap, credential and data-plane settings must be
 * un-editable for everyone, platform admin included."
 *
 * The lock is DERIVED from descriptor metadata, and that is the property worth
 * testing: a hand-maintained list of locked keys drifts the moment someone
 * registers a new bootstrap variable, and it drifts SILENTLY — the new key
 * simply renders with an editor that 400s. So these tests assert coverage over
 * the whole live registry rather than over a fixture, and they assert the two
 * NEGATIVE cases too, because a lock that over-reaches is its own bug: telling
 * an admin "managed by deployment" about a key they can change on another screen
 * is a lie that costs a support ticket.
 */
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { isSettingLocked, settingLockFor, SETTING_TIER_LOCKED } from '../setting-lock';
import type { SettingDescriptor } from '../registry.types';

const descriptor = (over: Partial<SettingDescriptor>): SettingDescriptor => ({
  key: 'x.y',
  tier: 'global-kv',
  dataType: 'string',
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: 'GlobalSetting',
  failMode: 'open-to-default',
  category: 'Platform Operations',
  ...over,
});

describe('settingLockFor', () => {
  it('locks every env-tier key — the bootstrap and data-plane transport floor', () => {
    const envKeys = HOPE_SETTINGS_REGISTRY.list().filter((d) => d.tier === 'env');
    expect(envKeys.length).toBeGreaterThan(0);
    for (const d of envKeys) expect(isSettingLocked(d), d.key).toBe(true);
  });

  it('locks the data-plane transport keys the owner named, without a bespoke list', () => {
    // The point of the derivation: these are caught because of WHERE they live,
    // not because someone remembered to enumerate them.
    for (const key of ['databaseUrl', 'redis.url', 'redis.host', 'minio.endpoint', 'vault.addr', 'vault.kvMount']) {
      const d = HOPE_SETTINGS_REGISTRY.get(key);
      expect(d, `${key} should be registered`).toBeDefined();
      expect(isSettingLocked(d!), key).toBe(true);
    }
  });

  it('locks every vault-kv and db-secret key, and every secret whatever tier carries it', () => {
    for (const d of HOPE_SETTINGS_REGISTRY.list()) {
      if (d.tier === 'vault-kv' || d.tier === 'db-secret' || d.sensitivity === 'secret') {
        expect(isSettingLocked(d), d.key).toBe(true);
      }
    }
    // A secret reports as a SECRET, not as its tier: naming the wrong reason
    // sends the admin to the wrong runbook.
    expect(settingLockFor(descriptor({ sensitivity: 'secret', dataType: 'secret', failMode: 'closed', tier: 'vault-kv' }))!.label).toBe('Secret');
  });

  it('does NOT lock db-config or entitlement keys — those ARE editable, just not here', () => {
    // The distinction the console depends on: "not writable through this lane"
    // and "not editable anywhere" are different sentences, and only the second
    // is a lock. `db-config` (storage config) and `entitlement` (the plan
    // matrix) both have their own screens.
    expect(settingLockFor(descriptor({ tier: 'db-config' }))).toBeNull();
    expect(settingLockFor(descriptor({ tier: 'entitlement' }))).toBeNull();
    for (const d of HOPE_SETTINGS_REGISTRY.list().filter((x) => x.tier === 'db-config' || x.tier === 'entitlement')) {
      if (d.sensitivity !== 'secret') expect(isSettingLocked(d), d.key).toBe(false);
    }
  });

  it('leaves an ordinary global-kv key writable', () => {
    expect(settingLockFor(descriptor({}))).toBeNull();
    expect(isSettingLocked(HOPE_SETTINGS_REGISTRY.get('rateLimit.maxRequests')!)).toBe(false);
    expect(isSettingLocked(HOPE_SETTINGS_REGISTRY.get('console.mlflow.enabled')!)).toBe(false);
  });

  it('honours the descriptor own declaration of "no editor" for a future tier', () => {
    // The sentinel is the AUTHOR's statement. It is redundant with `env` today
    // and kept so a tier that adopts it locks without anyone editing the table.
    const lock = settingLockFor(descriptor({ tier: 'global-kv', editableBy: 'none' }));
    expect(lock).not.toBeNull();
    expect(lock!.label).toBe('Not editable');
  });

  it('always states WHERE the value actually changes, not merely that it did not', () => {
    for (const d of HOPE_SETTINGS_REGISTRY.list()) {
      const lock = settingLockFor(d);
      if (!lock) continue;
      expect(lock.reason.length, d.key).toBeGreaterThan(40);
      expect(lock.label.length, d.key).toBeGreaterThan(0);
    }
  });

  it('exports a machine-readable marker so a client can branch on the KIND of refusal', () => {
    expect(SETTING_TIER_LOCKED).toBe('SETTING_TIER_LOCKED');
  });
});
