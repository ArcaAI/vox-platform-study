/**
 * Seed ↔ registry parity for the consultation-pipeline kill-switch seed
 * (`11c-consultation-gate-settings.ts`).
 *
 * ⚠️ TASK-705 CHANGED WHAT THIS FILE GUARDS. It used to hold TWO keys, and its
 * headline case asserted that `harness.loop.enabled` was seeded `'true'` while
 * its descriptor default stayed `false` — the sanctioned way to land a
 * kill-switch ON, since `SettingsRegistry.killSwitches()` throws at assembly for
 * any kill-switch whose `default === true`.
 *
 * That shape was sound in the abstract and wrong for this key. It made the
 * DATABASE the only carrier of the product intent, in a platform where
 * `migrate.sh` defaults `RUN_SEED=none` and `hope-v2-dev` pins it to `"none"`
 * (owner decision 2026-08-09) — so the row was written once, at bootstrap, and
 * never re-asserted. Loop eligibility is now the tenant's SUBSCRIPTION
 * ENTITLEMENT (`agenticLoop`; owner decision 2026-08-17 §2 row 705) and the
 * residual operator stop is `harness.loop.emergencyStop`, whose disarmed
 * default IS the day-1 state. Nothing about the loop is seeded any more, and
 * this file now guards ONE key: `consultation.ocr.enabled`, whose ON-by-default
 * behaviour genuinely does need a seeded row.
 *
 * The mechanism the OCR row uses, unchanged:
 *
 *     descriptor default stays OFF   →  absence still resolves OFF (fail-safe)
 *     the seeded ROW carries 'true'  →  every seeded environment comes up ON
 *     `defaultValue` stays 'false'   →  a "reset to default" reverts to fail-safe
 *
 * The row identity matters as much as the value. `SettingsRegistryWriteService`
 * resolves an existing row by `(key, namespace='registry', tenantId=GLOBAL)` and
 * CREATES one named `descriptor.label ?? key`. `GlobalSetting` is unique on
 * `(tenantId, name, key)`. So a seed that writes a different tenant, namespace
 * or name would leave the operator's `PUT` creating a SECOND platform row for
 * the same key — and `AppSettingsService` REFUSES TO BOOT on a duplicate
 * platform key. These tests pin all four coordinates.
 *
 * `packages/database` must not depend on `@arcaai/applications`, so the seed
 * mirrors the keys and labels by hand; this test is what stops the two drifting.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { TenantSettingsService } from '../tenant-settings.service';
import { CONSULTATION_OCR_ENABLED_KEY, HARNESS_LOOP_EMERGENCY_STOP_KEY } from '../../consultation/consultation-gates.constants';

const SEED_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../database/src/prisma/db_main/seed/11c-consultation-gate-settings.ts',
);

const GATE_KEYS = [CONSULTATION_OCR_ENABLED_KEY];

function seedSource(): string {
  return readFileSync(SEED_FILE, 'utf8');
}

/** Every `key: '<dotted>'` literal in the seed's gate table. */
function seededKeys(): string[] {
  return [...seedSource().matchAll(/^\s{4}key: '([^']+)',$/gm)].map((m) => m[1]!);
}

/** Every `name: '<label>'` literal in the seed's gate table. */
function seededNames(): string[] {
  return [...seedSource().matchAll(/^\s{4}name: '([^']+)',$/gm)].map((m) => m[1]!);
}

/**
 * The same fake `GlobalSetting` cache the tier-compliance suite uses. It holds
 * PARSED values, which is what `AppSettingsService.getValueFromCache` returns —
 * `GlobalSettingEntity.parsedValue` maps a `Boolean` row's `'true'` string onto
 * a real boolean, and the gate reads compare with `=== true`.
 */
function fakeAppSettings(store: Map<string, unknown>) {
  return {
    getValueFromCache: (key: string) => (store.has(key) ? store.get(key) : null),
    getTenantValueFromCache: () => null,
  } as never;
}

describe('consultation-gate seed ↔ registry parity', () => {
  it('seeds exactly the consultation-pipeline gate keys that need a seeded row', () => {
    expect(seededKeys().sort()).toEqual([...GATE_KEYS].sort());
  });

  it('seeds only keys that are registered `global-kv` kill-switch descriptors', () => {
    for (const key of seededKeys()) {
      const descriptor = HOPE_SETTINGS_REGISTRY.get(key);
      expect(descriptor, `seed writes '${key}' but no descriptor is registered for it`).toBeDefined();
      expect(descriptor!.tier, key).toBe('global-kv');
      expect(descriptor!.killSwitch, key).toBe(true);
    }
  });

  // The row-identity guard. A drifted label silently creates a second platform
  // row on the operator's first write, which refuses boot.
  it('names each row exactly as the descriptor label the write lane would create', () => {
    const labels = GATE_KEYS.map((key) => HOPE_SETTINGS_REGISTRY.get(key)!.label!);
    expect(seededNames().sort()).toEqual([...labels].sort());
  });

  it('seeds the value ON while leaving `defaultValue` at the fail-safe OFF', () => {
    const source = seedSource();
    // One row, turned on, resetting to OFF.
    expect([...source.matchAll(/^\s{4}value: 'true',$/gm)]).toHaveLength(1);
    expect([...source.matchAll(/^\s{4}defaultValue: 'false',$/gm)]).toHaveLength(1);
    expect(source).not.toMatch(/^\s{4}value: 'false',$/gm);
  });

  /*
   * TASK-705 — the regression guard for the defect this ticket removed. A
   * seeded `harness.loop.enabled = 'true'` disagreed with its own descriptor
   * default and was never re-asserted in any environment that does not seed.
   * Loop eligibility is an entitlement now; re-adding a row here would restore
   * a second, silently-disagreeing source of truth.
   */
  it('never re-introduces a seeded loop gate — eligibility is the subscription entitlement', () => {
    // Checked against the seeded KEY TABLE, not the file text: the header
    // comment names the retired key on purpose, to explain why it is gone.
    expect(seededKeys()).not.toContain('harness.loop.enabled');
    expect(seededKeys()).not.toContain(HARNESS_LOOP_EMERGENCY_STOP_KEY);
  });

  // …and the emergency stop is a REGISTERED kill-switch that is simply never
  // seeded: its disarmed default is the intended state everywhere.
  it('registers harness.loop.emergencyStop as a disarmed global-kv kill-switch', () => {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(HARNESS_LOOP_EMERGENCY_STOP_KEY);
    expect(descriptor).toBeDefined();
    expect(descriptor!.tier).toBe('global-kv');
    expect(descriptor!.killSwitch).toBe(true);
    expect(descriptor!.maxScope).toBe('system');
    expect(descriptor!.default).toBe(false);
  });

  it('writes the same row coordinates the registry write lane resolves', () => {
    // Owner ruling 2026-08-20 (TASK-763 OD-1): the runtime cascade is request
    // tenant → SYSTEM, full stop. `SettingsRegistryWriteService.targetTenantFor`
    // resolves a `system`-scope write to `SYSTEM_TENANT_ID`, so the seed's row
    // coordinates must match it exactly, or the operator's first PUT creates a
    // second platform row for the same key. GLOBAL/`SEED_TENANT_ID`
    // (`50000000-…`) is a CUSTOMER tenant and must never be the target.
    const source = seedSource();
    expect(source).toContain("const NAMESPACE = 'registry'");
    expect(source).toContain('tenantId: SYSTEM_TENANT_ID');
    expect(source).not.toMatch(/tenantId: SEED_TENANT_ID/);
    expect(source).not.toMatch(/tenantId: SEED_CUSTOMER_TENANT_IDS/);
  });

  // Idempotency is also enforced globally by
  // `seed/__tests__/seed-idempotency.test.ts`, which scans every `NN-name.ts`
  // phase file; restated here so this contract is self-contained.
  it('never clobbers an operator override on re-seed — `value` is create-only', () => {
    const source = seedSource();
    const update = source.slice(source.indexOf('update: {'), source.indexOf('create: {'));
    expect(update).not.toMatch(/\bvalue:/);
  });

  it('leaves the kill-switch defaults-OFF invariant intact — the registry still assembles', () => {
    expect(() => HOPE_SETTINGS_REGISTRY.killSwitches()).not.toThrow();
    for (const key of GATE_KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.get(key)!.default, key).toBe(false);
    }
  });
});

describe('the seeded row resolves the gate ON', () => {
  it('resolves OFF with no row — absence is still fail-safe', () => {
    const settings = new TenantSettingsService(fakeAppSettings(new Map()));
    for (const key of GATE_KEYS) {
      const resolved = settings.resolvePlatform<boolean>(key);
      expect(resolved.value, key).toBe(false);
      expect(resolved.source, key).toBe('code-default');
    }
  });

  it('resolves ON once the seeded row is in the platform cache', () => {
    const store = new Map<string, unknown>(GATE_KEYS.map((key) => [key, true]));
    const settings = new TenantSettingsService(fakeAppSettings(store));
    for (const key of GATE_KEYS) {
      const resolved = settings.resolvePlatform<boolean>(key);
      expect(resolved.value, key).toBe(true);
      expect(resolved.source, key).toBe('system');
    }
  });
});
