// TASK-932 wave 4, lane S1-2 — the structural guard that keeps a legacy
// per-tenant seed row and a governed registry descriptor from silently
// sharing a key.
//
// THE LATENT RISK THIS EXISTS TO PREVENT. `AppSettingsService`'s tenant
// cascade admits ONLY `namespace === 'registry'` rows (deliberate — see
// `appSettings.service.ts`). A legacy per-tenant clone seeded by
// `seed/11-global-setting.ts` under some OTHER namespace (`general`,
// `feature-flags`, `stt`, `text`, `ux-constants`, `admin`, `arcaai-admin`)
// therefore does not collide with the registry cascade TODAY. But a key
// string is shared identity across both systems, and a future registry
// descriptor authored with the SAME key as a still-cloned legacy row would be
// a naming collision that confuses the write lane's own namespace-agnostic
// `(tenantId, key)` read (`pickBackingRow` in
// `settings-registry-write.service.ts`) — the exact class of bug that made
// `rate-limit.enabled` produce a duplicate SYSTEM row. This test pins the
// invariant statically so a new descriptor can never reuse a key the legacy
// seed still clones into every tenant.
//
// `packages/applications` must not import `@arcaai/database` runtime code
// (04-application-services.md), so the seed file is read as TEXT here, not
// imported as a module — this is also why the check is self-contained rather
// than depending on a package export the database package does not offer.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import type { SettingScope } from '../registry.types';

/** A descriptor's key collides only when its scope reaches a tenant — a SYSTEM-only descriptor can safely reuse a legacy key (it never resolves through the tenant cascade the legacy row occupies). */
function collidingKeys(cloneKeys: readonly string[], descriptors: ReadonlyArray<{ key: string; maxScope: SettingScope }>): string[] {
  const cloneKeySet = new Set(cloneKeys);
  return descriptors.filter((d) => d.maxScope !== 'system' && cloneKeySet.has(d.key)).map((d) => d.key);
}

describe('collidingKeys (the pin itself)', () => {
  it('flags a tenant-scope descriptor that reuses a still-cloned legacy key', () => {
    const result = collidingKeys(['enable-consultation-sharing'], [{ key: 'enable-consultation-sharing', maxScope: 'tenant' }]);
    expect(result).toEqual(['enable-consultation-sharing']);
  });

  it('does not flag a SYSTEM-scoped descriptor even when the key string matches', () => {
    // `enable-local-raw-capture` is exactly this shape: a SYSTEM-only
    // PLATFORM_SETTINGS row, never cloned per tenant, so a `maxScope:
    // 'system'` descriptor of the same key is not a collision.
    const result = collidingKeys(['enable-local-raw-capture'], [{ key: 'enable-local-raw-capture', maxScope: 'system' }]);
    expect(result).toEqual([]);
  });

  it('does not flag an unrelated key', () => {
    const result = collidingKeys(['default-language'], [{ key: 'consultation.ocr.enabled', maxScope: 'tenant' }]);
    expect(result).toEqual([]);
  });
});

describe('seed-11 per-tenant clone keys vs. the real registry', () => {
  // Extract exactly the keys `tenantSettings()` clones into every tenant —
  // NOT `PLATFORM_SETTINGS` (SYSTEM-tenant-only, never cloned) and NOT
  // `RETIRED_GLOBAL_SETTING_KEYS` (swept to DELETED, no longer seeded). The
  // function body sits between its own declaration and the `ALL_SETTINGS`
  // export that consumes it, so slicing between those two markers isolates
  // it without parsing the file as TypeScript.
  const seedSource = readFileSync(resolve(__dirname, '../../../../../database/src/prisma/db_main/seed/11-global-setting.ts'), 'utf8');
  const fnStart = seedSource.indexOf('function tenantSettings(');
  const fnEnd = seedSource.indexOf('export const ALL_SETTINGS');
  if (fnStart === -1 || fnEnd === -1 || fnEnd <= fnStart) {
    throw new Error(
      'tenant-clone-key-collision.governance.test.ts could not locate tenantSettings() in seed/11-global-setting.ts — the extraction markers drifted, fix the slice before trusting this test.',
    );
  }
  const tenantSettingsBody = seedSource.slice(fnStart, fnEnd);
  const cloneKeys = [...tenantSettingsBody.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]);

  it('found at least one clone key (the extraction itself is not silently empty)', () => {
    expect(cloneKeys.length).toBeGreaterThan(0);
  });

  it('no seed-11 per-tenant clone key collides with a tenant-reaching registry descriptor', () => {
    const descriptors = HOPE_SETTINGS_REGISTRY.list();
    const offenders = collidingKeys(cloneKeys, descriptors);

    expect(
      offenders,
      'these keys are BOTH seeded per-tenant by seed/11-global-setting.ts AND registered as a tenant-reaching descriptor — pick one owner for the key',
    ).toEqual([]);
  });

  it('enable-consultation-sharing is no longer a seed-11 clone key (TASK-932 OD-1 retired it, so a future tenant-scope descriptor of the same name cannot collide)', () => {
    // A named regression anchor: this is exactly the collision OD-1 was
    // answered to avoid. If this ever starts failing, the per-tenant clone
    // came back and needs to be retired again, not this test relaxed.
    expect(cloneKeys).not.toContain('enable-consultation-sharing');
  });
});
