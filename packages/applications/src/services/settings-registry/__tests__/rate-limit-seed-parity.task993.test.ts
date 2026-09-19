/**
 * Seed ↔ registry parity for the rate-limit `GlobalSetting` rows.
 *
 * `packages/database` must not depend on `@arcaai/applications` (the
 * constraint `12-rate-limit-settings.ts` documents in its own header), so the
 * seed mirrors the descriptor keys, values and types BY HAND. A hand-mirrored
 * list drifts silently, and the drift is invisible at runtime: every one of
 * these keys has a code baseline, so a seed row written under a stale key
 * simply sits in the database being read by nothing while the admin screen
 * shows a value that governs nothing.
 *
 * Lane F shipped `rate-limit.principal.{enabled,limit,ttl}` as descriptors but
 * could not seed them (`packages/database` was outside its boundary); lane J
 * seeded them, and added the same for `rate-limit.lockout.enabled`. This test
 * is what stops the two halves parting company again. Shape borrowed
 * deliberately from `platform-knob-seed-parity.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { RATE_LIMIT_LOCKOUT_SETTINGS, RATE_LIMIT_PRINCIPAL_SETTINGS, RATE_LIMIT_TIER_SETTINGS } from '../descriptors/platform-knobs.descriptors';

const SEED_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../database/src/prisma/db_main/seed/12-rate-limit-settings.ts');

/** Every `{ key, value }` pair the seed writes, in file order. */
function seededRows(): Array<{ key: string; value: string }> {
  const source = readFileSync(SEED_FILE, 'utf8');
  return [...source.matchAll(/^ {4}key: '([^']+)',\n {4}value: '([^']*)',$/gm)].map((m) => ({ key: m[1]!, value: m[2]! }));
}

/** The kill-switch is the one seeded rate-limit key with no descriptor of its own. */
const KILL_SWITCH = 'rate-limit.enabled';

describe('rate-limit seed ↔ registry parity', () => {
  it('seeds a row for every cataloged rate-limit descriptor', () => {
    const cataloged = [...RATE_LIMIT_TIER_SETTINGS, ...RATE_LIMIT_PRINCIPAL_SETTINGS, ...RATE_LIMIT_LOCKOUT_SETTINGS].map((d) => d.key);
    const seeded = seededRows().map((r) => r.key);

    expect(cataloged.filter((k) => !seeded.includes(k))).toEqual([]);
  });

  it('seeds only keys that are registered `global-kv` descriptors', () => {
    for (const { key } of seededRows()) {
      if (key === KILL_SWITCH) continue;
      const descriptor = HOPE_SETTINGS_REGISTRY.get(key);
      expect(descriptor, `seed writes '${key}' but no descriptor is registered for it`).toBeDefined();
      expect(descriptor!.tier, key).toBe('global-kv');
    }
  });

  it('seeds the descriptor DEFAULT, so a fresh database behaves like an unseeded one', () => {
    // A seeded value that disagrees with the code baseline is the worst of the
    // two worlds: the platform behaves one way before `db:seed` and another
    // after, with nothing in the diff to say so.
    for (const { key, value } of seededRows()) {
      const descriptor = HOPE_SETTINGS_REGISTRY.get(key);
      if (!descriptor) continue;
      expect(String(descriptor.default), key).toBe(value);
    }
  });

  it('is actually checking something', () => {
    // A regex that stops matching would make every assertion above vacuous.
    expect(seededRows().length).toBeGreaterThanOrEqual(13);
  });

  it('seeds onto the SYSTEM tenant — the sole platform-configuration tier', () => {
    const source = readFileSync(SEED_FILE, 'utf8');
    expect(source).toContain('tenantId: SYSTEM_TENANT_ID');
    expect(source).not.toMatch(/tenantId: SEED_TENANT_ID/);
    expect(source).not.toMatch(/tenantId: SEED_CUSTOMER_TENANT_IDS/);
  });
});
