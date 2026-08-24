/**
 * Seed ↔ registry parity for the tts provider/engine enable flags
 * (`11d-tts-engine-flags.ts`, TASK-799 lane H).
 *
 * `packages/database` must not depend on `@arcaai/applications`, so the seed
 * mirrors the descriptor keys and labels BY HAND. A hand-mirrored list drifts
 * silently, and here the drift is invisible rather than loud: a renamed key
 * leaves the seed writing a row nothing reads, so `apps/tts` keeps resolving the
 * descriptor default and the flag quietly reverts to its environment value.
 * Nothing throws. This file is what stops that.
 *
 * THE MECHANISM THE KOKORO ROW USES, stated once:
 *
 *     descriptor default stays `false`  →  an UNSEEDED deployment resolves the
 *                                          Python field's own value, so nothing
 *                                          is retuned on first deploy
 *     the seeded ROW carries `'true'`   →  every seeded environment comes up
 *                                          with an engine registered, which is
 *                                          what `/health/ready` needs
 *     `defaultValue` stays `'false'`    →  "reset to default" returns the code
 *                                          value, not the seeded one
 *
 * It is the same shape `11c-consultation-gate-settings.ts` uses for the OCR
 * gate. The reason it is REQUIRED here rather than merely tidy: the descriptor
 * default is pinned to the Python field verbatim by
 * `apps/tts/src/tts/tests/unit/test_task799_descriptor_parity.py`, so `true`
 * cannot be expressed as a default at all — only as a row.
 *
 * ROW IDENTITY MATTERS AS MUCH AS THE VALUE. `SettingsRegistryWriteService`
 * resolves an existing row by `(key, namespace='registry', tenantId=SYSTEM)` and
 * otherwise CREATES one named `descriptor.label`; `GlobalSetting` is unique on
 * `(tenantId, name, key)`. A seed writing a different tenant, namespace or name
 * would leave an operator's first `PUT` creating a SECOND platform row for the
 * same key — and `AppSettingsService` REFUSES TO BOOT on a duplicate platform
 * key. All four coordinates are pinned below.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { ENABLE_FLAG_SETTINGS } from '../descriptors/tts-runtime.descriptors';

const SEED_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../database/src/prisma/db_main/seed/11d-tts-engine-flags.ts');

function seedSource(): string {
  return readFileSync(SEED_FILE, 'utf8');
}

/** Every `key: '<dotted>'` literal in the seed's flag table. */
function seededKeys(): string[] {
  return [...seedSource().matchAll(/^\s{4}key: '([^']+)',$/gm)].map((m) => m[1]!);
}

/** Every `name: '<label>'` literal in the seed's flag table. */
function seededNames(): string[] {
  return [...seedSource().matchAll(/^\s{4}name: '([^']+)',$/gm)].map((m) => m[1]!);
}

/** `(key → value)` from the seed's flag table, in declaration order. */
function seededValues(): Record<string, string> {
  const rows = [...seedSource().matchAll(/^\s{4}key: '([^']+)',[\s\S]*?^\s{4}value: '([^']+)',/gm)];
  return Object.fromEntries(rows.map((m) => [m[1]!, m[2]!]));
}

describe('tts engine-flag seed ↔ registry parity', () => {
  it('seeds a row for every enable-flag descriptor, and only those', () => {
    expect(seededKeys().sort()).toEqual(ENABLE_FLAG_SETTINGS.map((d) => d.key).sort());
  });

  it('seeds only keys that are registered `global-kv` descriptors consumed by tts', () => {
    for (const key of seededKeys()) {
      const descriptor = HOPE_SETTINGS_REGISTRY.get(key);
      expect(descriptor, `seed writes '${key}' but no descriptor is registered for it`).toBeDefined();
      // `global-kv` is where D-2 puts a migrated Python knob. If this ever reads
      // `env` again, the seed is writing rows the service will never consult.
      expect(descriptor!.tier, key).toBe('global-kv');
      // Without `consumedBy`, `/internal/effective-config?service=tts` does not
      // carry the key at all and the seeded row is unreachable.
      expect(descriptor!.consumedBy, key).toContain('tts');
    }
  });

  it('names each row exactly as its descriptor label — the row-identity coordinate', () => {
    const labelsByKey = new Map(ENABLE_FLAG_SETTINGS.map((d) => [d.key, d.label]));
    const keys = seededKeys();
    const names = seededNames();
    expect(names).toHaveLength(keys.length);
    keys.forEach((key, i) => {
      expect(names[i], `row for '${key}' must be named after its descriptor label`).toBe(labelsByKey.get(key));
    });
  });

  it('uses the reserved `registry` namespace — the only one the settings cache admits', () => {
    expect(seedSource()).toContain("const NAMESPACE = 'registry'");
  });

  it('seeds onto the SYSTEM tenant — the sole platform-configuration tier — never GLOBAL or a customer tenant', () => {
    // Owner ruling 2026-08-20 (TASK-763 OD-1): the runtime cascade is request
    // tenant → SYSTEM. GLOBAL/`SEED_TENANT_ID` (`50000000-…`) is a CUSTOMER
    // tenant and must never be a platform write target.
    const source = seedSource();
    expect(source).toContain('tenantId: SYSTEM_TENANT_ID');
    expect(source).not.toMatch(/tenantId: SEED_TENANT_ID/);
    expect(source).not.toMatch(/tenantId: SEED_CUSTOMER_TENANT_IDS/);
  });

  it('keeps every descriptor default false while seeding kokoro ON — the only way `true` can be expressed', () => {
    // The defaults are pinned to the Python fields by the tts descriptor-parity
    // test, so a `default: true` here would break THAT gate instead. The row is
    // the sanctioned carrier of the platform's actual decision.
    for (const d of ENABLE_FLAG_SETTINGS) {
      expect(d.default, `${d.key} default must equal its Python field`).toBe(false);
    }
    expect(seededValues()['tts.kokoro.enabled']).toBe('true');
  });

  it('keeps the licence-gated engine OFF, and every other engine OFF with it', () => {
    // `tts.indicf5.enabled` gates CC-BY-NC weights: seeding it on would enable a
    // NonCommercial model for every environment that runs `db:seed`.
    const values = seededValues();
    expect(values['tts.indicf5.enabled']).toBe('false');
    expect(values['tts.azure.enabled']).toBe('false');
    expect(values['tts.sarvam.enabled']).toBe('false');
    expect(values['tts.parler.enabled']).toBe('false');
  });

  it('locks every row, so flipping an engine is a SUPER_ADMIN act with an audit trail', () => {
    // This is what replaces the code comment that used to be the only thing
    // enforcing the IndicF5 licence restriction.
    expect(seedSource()).toContain('locked: true');
    expect(seedSource()).not.toMatch(/locked: false/);
    for (const d of ENABLE_FLAG_SETTINGS) {
      expect(d.globalOnly, `${d.key} must be platform-only`).toBe(true);
    }
  });
});
