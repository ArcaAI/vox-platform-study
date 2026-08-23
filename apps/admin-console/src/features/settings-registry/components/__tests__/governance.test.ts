/**
 * Descriptor governance (TASK-799 Phase 4, E.1).
 *
 * These rules decide what an admin is OFFERED, and they have to agree with what
 * the gateway will actually accept — otherwise the screen either hides a legal
 * write or dangles one that 400s. The gateway's guard order is the spec:
 * secret → 400, `globalOnly` without super admin → 403, scope deeper than
 * `maxScope` → 400, non-`global-kv` tier → 400, and a `system`-scope write
 * restricted to super administrators.
 */

import { describe, expect, it } from 'vitest';
import type { SettingCatalogItem } from '../../api/types';
import { floorHint, isUnsetAndFailClosed, killSwitchWarning, sourceScopeLabel, writableScopes, writeBlockFor } from '../governance';

function item(overrides: Partial<SettingCatalogItem> = {}): SettingCatalogItem {
  return {
    key: 'rate-limit.maxRequests',
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    category: 'Rate limits',
    ...overrides,
  };
}

describe('writeBlockFor — what this lane may write', () => {
  it('allows a plain global-kv key', () => {
    expect(writeBlockFor(item(), true)).toBeNull();
  });

  it('refuses a secret, because the value is never read back or accepted', () => {
    expect(writeBlockFor(item({ sensitivity: 'secret' }), true)?.label).toBe('Secret');
    expect(writeBlockFor(item({ dataType: 'secret' }), true)?.label).toBe('Secret');
  });

  it('refuses a secret even for a super admin — elevation is not the gate here', () => {
    expect(writeBlockFor(item({ sensitivity: 'secret' }), true)).not.toBeNull();
  });

  it('refuses a globalOnly key to a non-elevated caller', () => {
    expect(writeBlockFor(item({ globalOnly: true }), false)?.label).toBe('Super admin only');
  });

  it('allows a globalOnly key to a super admin', () => {
    expect(writeBlockFor(item({ globalOnly: true }), true)).toBeNull();
  });

  it.each(['env', 'vault-kv', 'db-secret', 'db-config', 'redis-flag', 'entitlement'] as const)(
    'refuses tier %s and names the owner instead of a bare "no"',
    (tier) => {
      const block = writeBlockFor(item({ tier }), true);
      expect(block).not.toBeNull();
      expect(block!.reason.length).toBeGreaterThan(20);
    },
  );

  it('checks secrecy BEFORE tier, matching the gateway guard order', () => {
    // A secret on a db-config tier must report as a secret, since that is the
    // guard the server would hit first.
    expect(writeBlockFor(item({ sensitivity: 'secret', tier: 'db-config' }), true)?.label).toBe('Secret');
  });
});

describe('writableScopes — globalOnly gates the KEY, scope gates the ROW', () => {
  it('offers a super admin both the platform row and the tenant override', () => {
    expect(writableScopes(item({ maxScope: 'tenant' }), true)).toEqual(['system', 'tenant']);
  });

  it('never offers system scope to a non-elevated caller — that write is a 403', () => {
    expect(writableScopes(item({ maxScope: 'tenant' }), false)).toEqual(['tenant']);
  });

  it('offers a tenant admin nothing on a system-only key: there is no tenant row to write', () => {
    expect(writableScopes(item({ maxScope: 'system' }), false)).toEqual([]);
  });

  it('offers a super admin only system scope on a system-only key', () => {
    expect(writableScopes(item({ maxScope: 'system' }), true)).toEqual(['system']);
  });

  it('never offers department or doctor — the gateway refuses both outright', () => {
    const scopes = writableScopes(item({ maxScope: 'doctor' }), true);
    expect(scopes).not.toContain('department');
    expect(scopes).not.toContain('doctor');
  });
});

describe('floorHint — a tighten-only key says so before the write', () => {
  it('is absent when no floor is declared', () => {
    expect(floorHint(item())).toBeNull();
  });

  it('names the safe direction for each declared floor', () => {
    expect(floorHint(item({ floorDirection: 'lower-is-stricter' }))).toMatch(/LOWER/);
    expect(floorHint(item({ floorDirection: 'higher-is-stricter' }))).toMatch(/RAISE/);
    expect(floorHint(item({ floorDirection: 'superset-is-stricter' }))).toMatch(/ADD/);
  });

  it('says the write is refused, not clamped — an admin must not think it applied', () => {
    expect(floorHint(item({ floorDirection: 'lower-is-stricter' }))).toMatch(/refused, not clamped/);
  });
});

describe('failMode — a required key that is unset is not a default', () => {
  it('flags a closed key sitting on its code default', () => {
    expect(isUnsetAndFailClosed(item({ failMode: 'closed' }), 'code-default')).toBe(true);
  });

  it('does not flag a closed key that a tier actually answers', () => {
    expect(isUnsetAndFailClosed(item({ failMode: 'closed' }), 'global-kv')).toBe(false);
  });

  it('does not flag an open-to-default key on its default — that is the intended behaviour', () => {
    expect(isUnsetAndFailClosed(item({ failMode: 'open-to-default' }), 'code-default')).toBe(false);
  });

  it('stays quiet when the gateway does not serve failMode at all', () => {
    expect(isUnsetAndFailClosed(item(), 'code-default')).toBe(false);
  });
});

describe('killSwitchWarning — the unsafe direction is the deliberate one', () => {
  const flag = item({ dataType: 'boolean', killSwitch: true });

  it('warns when switching a kill-switch ON', () => {
    expect(killSwitchWarning(flag, true)).toMatch(/safe position is OFF/);
  });

  it('does not warn when switching it OFF — that is the safe direction', () => {
    expect(killSwitchWarning(flag, false)).toBeNull();
  });

  it('does not warn for a non-kill-switch boolean', () => {
    expect(killSwitchWarning(item({ dataType: 'boolean' }), true)).toBeNull();
  });
});

describe('sourceScopeLabel — "why is this value what it is"', () => {
  it('names each tier in words rather than leaving a raw token', () => {
    expect(sourceScopeLabel('code-default')).toBe('code default');
    expect(sourceScopeLabel('global-kv')).toBe('platform (SYSTEM)');
    expect(sourceScopeLabel('system')).toBe('platform (SYSTEM)');
    expect(sourceScopeLabel('tenant')).toBe('this tenant');
  });

  it('degrades to the raw token rather than lying when it does not recognise one', () => {
    expect(sourceScopeLabel('something-new')).toBe('something-new');
    expect(sourceScopeLabel(undefined)).toBe('unknown');
  });
});
