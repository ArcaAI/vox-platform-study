// Governance test locking in "no CORS config in Vault".
//
// Owner directive: origins and the enforcement switch are
// tenant/platform *config*, not secrets — no CORS-related setting may live
// behind a Vault-backed tier. Inspection verified this is ALREADY true by
// inspection: the one descriptor in this family, `origin.enforcementEnabled`
// (`platform-ops.descriptors.ts`), is `global-kv` (-> `GlobalSetting`), and
// `TenantAllowedOrigin` rows are a plain `core` table (`db-config` tier,
// resolved via the domain repository) that never enters the settings
// registry at all. That state needs a test, not just a grep, so a future
// descriptor cannot regress it silently — this file follows the established
// registry-governance shape (`fail-mode.governance.test.ts`): scan the
// ASSEMBLED `HOPE_SETTINGS_REGISTRY`, not a hand-built fixture, so a real
// addition to any `descriptors/*.ts` file is caught here automatically.
//
// "Origin/CORS family" is identified by vocabulary, not by importing a fixed
// key list, precisely so a NEW key (e.g. `origin.someNewSetting`,
// `cors.somethingElse`) is still caught the day it is registered — a filter
// keyed to today's one known key (`origin.enforcementEnabled`) would miss any
// sibling added later and pass by omission, which is worse than no test at
// all (per the task brief: "a governance test that cannot fail is worse than
// none").
//
// RED/GREEN evidence for this file (planted a `origin.vaultLeakProbe`
// descriptor with `tier: 'vault-kv'` in `platform-ops.descriptors.ts`, ran
// the suite, observed the second test fail, then removed the plant) is
// recorded in the origin-enforcement change history.

import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import type { SettingDescriptor, StorageTier } from '../registry.types';

/** The two tiers that mean "backed by Vault" per `registry.types.ts`'s `StorageTier` doc comment. */
const VAULT_BACKED_TIERS: ReadonlySet<StorageTier> = new Set(['vault-kv', 'db-secret']);

/**
 * Matches a descriptor's key, label, or description against the origin/CORS
 * vocabulary — not just today's single known key — so a differently-named
 * sibling descriptor added later is still caught.
 */
function isOriginOrCorsDescriptor(d: SettingDescriptor): boolean {
  const haystack = `${d.key} ${d.label ?? ''} ${d.description ?? ''}`.toLowerCase();
  return d.key.toLowerCase().startsWith('origin.') || /\bcors\b/.test(haystack) || /allowed[- ]?origin/.test(haystack);
}

describe('Settings registry governance — no CORS/origin config in Vault', () => {
  it('the origin/CORS descriptor family is non-empty — this test can actually exercise something', () => {
    // A guard against the filter itself silently matching nothing (e.g. after
    // a rename) and the assertion below passing vacuously forever.
    const family = HOPE_SETTINGS_REGISTRY.list().filter(isOriginOrCorsDescriptor);
    expect(family.map((d) => d.key)).toContain('origin.enforcementEnabled');
    expect(family.length).toBeGreaterThan(0);
  });

  it('no origin/CORS descriptor carries a Vault-backed tier (vault-kv or db-secret)', () => {
    const offenders = HOPE_SETTINGS_REGISTRY.list()
      .filter(isOriginOrCorsDescriptor)
      .filter((d) => VAULT_BACKED_TIERS.has(d.tier));
    // Assert on the mapped, human-readable list (not just `.length`) so a
    // failure names the offending key(s) and tier(s) directly in the diff.
    expect(offenders.map((d) => `${d.key} (tier: ${d.tier})`)).toEqual([]);
  });

  it('origin.enforcementEnabled specifically stays global-kv (the config tier, never a secret tier)', () => {
    const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow('origin.enforcementEnabled');
    expect(descriptor.tier).toBe('global-kv');
    expect(descriptor.sensitivity).not.toBe('secret');
  });
});
