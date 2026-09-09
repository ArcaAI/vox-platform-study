/**
 * Seed ↔ registry parity for the two adopted legacy feature flags (TASK-932 S2-4).
 *
 * `enable-consultation-sharing` and `enable-local-raw-capture` are the only two
 * rows of the legacy `feature-flags` `GlobalSetting` namespace that ever had a
 * runtime consumer (R-8 removed the other five, which had none). Their readers
 * now resolve through the settings-registry cascade, which means the value a
 * tenant gets when it holds no opinion is the DESCRIPTOR default — not the
 * literal the seed writes into a row.
 *
 * That is exactly where a silent flip could hide, and it is what this file
 * exists to prevent. OD-1 soft-deletes every tenant's explicit
 * `enable-consultation-sharing: 'true'` clone so tenants inherit the default;
 * that is behaviour-preserving ONLY while the descriptor default equals the
 * value those rows carried. If someone later "tidies" the descriptor default to
 * `false`, the sweep stops being a no-op and quietly withdraws continuity-of-care
 * reads from every tenant on the next deploy.
 *
 * WHY IT READS THE SEED SOURCE. `packages/database` must not depend on
 * `@arcaai/applications` (the constraint `12-rate-limit-settings.ts` documents),
 * so the two sides cannot import each other's constants — the same reason
 * `platform-knob-seed-parity.test.ts` reads its seed file as text.
 *
 * WHY THE SEED ROWS ARE OPTIONAL HERE. Lane S1 owns seed 11 and removes the
 * per-tenant sharing clones. Asserting that a row EXISTS would make this file
 * fail on one side of that merge and pass on the other, which is a test that
 * measures merge order rather than behaviour. So the rule is conditional and
 * true in both worlds: *if* the seed still declares one of these keys, its
 * declared values must agree with the descriptor.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONSULTATION_SHARING_ENABLED_KEY,
  FEATURE_AVAILABILITY_CATEGORY,
  LOCAL_RAW_CAPTURE_ENABLED_KEY,
} from '../descriptors/feature-availability.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../registry';

const SEED_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../database/src/prisma/db_main/seed/11-global-setting.ts');

interface SeededRow {
  namespace: string;
  value: string;
  defaultValue: string;
}

/**
 * Every seeded row declaring `key`, as `{ value, defaultValue }`. The seed's
 * rows are object literals whose `value` / `defaultValue` follow the `key`
 * within a few lines, so the window is bounded rather than parsed.
 */
function seededRows(key: string): SeededRow[] {
  const source = readFileSync(SEED_FILE, 'utf8');
  const rows: SeededRow[] = [];
  for (const match of source.matchAll(new RegExp(`key: '${key}',`, 'g'))) {
    // `namespace` precedes `key` in the seed's row literals, so it is read from
    // a window BEFORE the match; `value` / `defaultValue` follow it.
    const before = source.slice(Math.max(0, (match.index ?? 0) - 400), match.index ?? 0);
    const after = source.slice(match.index ?? 0, (match.index ?? 0) + 600);
    const namespace = [...before.matchAll(/\n\s*namespace: '([^']*)',/g)].pop();
    const value = /\n\s*value: '([^']*)',/.exec(after);
    const defaultValue = /\n\s*defaultValue: '([^']*)',/.exec(after);
    if (namespace && value && defaultValue) rows.push({ namespace: namespace[1]!, value: value[1]!, defaultValue: defaultValue[1]! });
  }
  return rows;
}

/** `'true'` / `'false'` as the boolean the `Boolean` ValueType parses them into. */
const asBoolean = (literal: string): boolean => literal === 'true';

describe('adopted legacy feature flags — seed ↔ registry parity', () => {
  it.each([
    ['consultation sharing', CONSULTATION_SHARING_ENABLED_KEY],
    ['local raw capture', LOCAL_RAW_CAPTURE_ENABLED_KEY],
  ])('%s is a registered global-kv Feature Availability descriptor, so a seeded row is governed', (_name, key) => {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(key);
    expect(descriptor, `${key} must be registered, or its seeded row governs nothing`).toBeDefined();
    expect(descriptor!.tier).toBe('global-kv');
    expect(descriptor!.dataType).toBe('boolean');
    expect(descriptor!.category).toBe(FEATURE_AVAILABILITY_CATEGORY);
  });

  it('the sharing descriptor default equals the value the seeded clones carry, so OD-1 removing them changes nothing', () => {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(CONSULTATION_SHARING_ENABLED_KEY)!;
    for (const row of seededRows(CONSULTATION_SHARING_ENABLED_KEY)) {
      expect(asBoolean(row.value), 'a seeded row that disagrees with the default makes the OD-1 sweep a behaviour change').toBe(descriptor.default);
      expect(asBoolean(row.defaultValue)).toBe(descriptor.default);
    }
  });

  /**
   * The coupling between this lane and OD-1, stated where it can be read.
   *
   * `AppSettingsService`'s TENANT lane admits only rows in the reserved
   * `registry` namespace, and the settings write lane ADOPTS an existing seeded
   * row rather than creating a second one (`pickBackingRow`). Put together: while
   * a tenant still carries its seeded `feature-flags` clone of an adopted key, a
   * per-tenant write through the governed lane would update THAT row — and the
   * cascade would not see it, because the row is not in the `registry`
   * namespace. The admin would set the toggle and nothing would happen.
   *
   * That is not a defect in either mechanism; it is why OD-1 retires the clones
   * (lane S1) rather than leaving them as explicit overrides. This test records
   * the shape so the two decisions cannot be separated by accident: any seeded
   * row for an adopted key is in a namespace the tenant lane ignores.
   */
  it('records why the clones must go: a seeded row for an adopted key is NOT in the namespace the tenant lane reads', () => {
    for (const key of [CONSULTATION_SHARING_ENABLED_KEY, LOCAL_RAW_CAPTURE_ENABLED_KEY]) {
      for (const row of seededRows(key)) {
        expect(row.namespace, `${key}: a seeded row already in 'registry' would change the adoption analysis above`).toBe('feature-flags');
      }
    }
  });

  it("the raw-capture descriptor default matches the seeded row's declared defaultValue, so a reset reverts to the same posture", () => {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(LOCAL_RAW_CAPTURE_ENABLED_KEY)!;
    expect(descriptor.default).toBe(false);

    for (const row of seededRows(LOCAL_RAW_CAPTURE_ENABLED_KEY)) {
      // The seeded `value` is deliberately ON for dev; only the DECLARED
      // default has to agree — the `pipeline.templateResync.enabled` pattern,
      // where a platform VALUE carries the deployed posture and the fail-safe
      // stays the thing a reset returns to.
      expect(asBoolean(row.defaultValue), 'a reset must land on the fail-safe end, not on the deployed one').toBe(descriptor.default);
    }
  });
});
