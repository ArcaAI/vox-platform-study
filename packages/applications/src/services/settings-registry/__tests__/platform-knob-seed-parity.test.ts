/**
 * Seed ↔ registry parity for the migrated platform knobs.
 *
 * `packages/database` must not depend on `@arcaai/applications` (the constraint
 * `12-rate-limit-settings.ts` documents), so `seed/11a-platform-knob-settings.ts`
 * mirrors the descriptor keys by hand. A hand-mirrored list drifts silently —
 * a renamed descriptor would leave the seed writing a row nothing reads, and
 * the migrated knob would quietly fall back to env forever.
 *
 * This test reads the seed file and holds the two sides together: every key it
 * seeds must be a registered `global-kv` descriptor, and every `global-kv`
 * descriptor that CAME FROM an env var must be seeded (or explicitly excluded
 * with a reason).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { PLATFORM_KNOB_SETTINGS } from '../descriptors/platform-knobs.descriptors';

const SEED_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../database/src/prisma/db_main/seed/11a-platform-knob-settings.ts');

/** Every `key: '<dotted>'` literal in the seed's knob tables. */
function seededKeys(): string[] {
  const source = readFileSync(SEED_FILE, 'utf8');
  return [...source.matchAll(/^\s{4}key: '([^']+)',$/gm)].map((m) => m[1]!);
}

describe('platform-knob seed ↔ registry parity', () => {
  it('seeds a key for every migrated platform knob', () => {
    expect(seededKeys().sort()).toEqual(PLATFORM_KNOB_SETTINGS.map((d) => d.key).sort());
  });

  it('seeds only keys that are registered `global-kv` descriptors', () => {
    for (const key of seededKeys()) {
      const descriptor = HOPE_SETTINGS_REGISTRY.get(key);
      expect(descriptor, `seed writes '${key}' but no descriptor is registered for it`).toBeDefined();
      expect(descriptor!.tier, key).toBe('global-kv');
    }
  });

  it('uses the reserved `registry` namespace — the only one the settings cache admits', () => {
    const source = readFileSync(SEED_FILE, 'utf8');
    expect(source).toContain("const NAMESPACE = 'registry'");
  });

  it('seeds onto the SYSTEM tenant — the sole platform-configuration tier — never GLOBAL or a customer tenant', () => {
    // Owner ruling 2026-08-20: the runtime cascade is request
    // tenant → SYSTEM, full stop. GLOBAL/`SEED_TENANT_ID` (`50000000-…`) is a
    // CUSTOMER tenant and must never be the platform-knob write target.
    const source = readFileSync(SEED_FILE, 'utf8');
    expect(source).toContain('tenantId: SYSTEM_TENANT_ID');
    expect(source).not.toMatch(/tenantId: SEED_TENANT_ID/);
    expect(source).not.toMatch(/tenantId: SEED_CUSTOMER_TENANT_IDS/);
  });
});
