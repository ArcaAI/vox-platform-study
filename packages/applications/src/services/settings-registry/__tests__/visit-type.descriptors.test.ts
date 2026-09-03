/**
 * `consultation.visitTypes` — the descriptor contract.
 *
 * The owner ruling is a CONFIGURATION statement, and every
 * clause of it lands on a descriptor field. This file is where those fields are
 * pinned, so a later edit that quietly re-platforms the key has to argue with a
 * test rather than slip through.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONSULTATION_VISIT_TYPES_DEFAULT,
  CONSULTATION_VISIT_TYPES_KEY,
  type VisitTypeDefinition,
} from '../../consultation/visit-type/visit-type.catalogue';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { TenantSettingsService } from '../tenant-settings.service';

const descriptor = () => HOPE_SETTINGS_REGISTRY.getOrThrow(CONSULTATION_VISIT_TYPES_KEY);

const SEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../database/src/prisma/db_main/seed');

function fakeAppSettings(platform: unknown, perTenant: Record<string, unknown> = {}) {
  return {
    getValueFromCache: (key: string) => (key === CONSULTATION_VISIT_TYPES_KEY ? (platform ?? null) : null),
    getTenantValueFromCache: (tenantId: string, key: string) => (key === CONSULTATION_VISIT_TYPES_KEY ? (perTenant[tenantId] ?? null) : null),
  } as never;
}

describe('the descriptor says what the ruling said', () => {
  it('is TENANT-scoped — "tenant-admin defined and controlled"', () => {
    expect(descriptor().maxScope).toBe('tenant');
    // …and therefore NOT a super-admin-only key. `agentic.*` is that boundary;
    // this key is deliberately `consultation.*`.
    expect(descriptor().globalOnly).toBeUndefined();
    expect(CONSULTATION_VISIT_TYPES_KEY.startsWith('agentic.')).toBe(false);
  });

  it('lives in `global-kv`, the tier whose cascade IS tenant → SYSTEM', () => {
    expect(descriptor().tier).toBe('global-kv');
    // No pending re-platforming is implied.
    expect(descriptor().targetTier).toBeUndefined();
  });

  it('ships the owner’s two defaults as the descriptor default', () => {
    expect(descriptor().default).toEqual(CONSULTATION_VISIT_TYPES_DEFAULT.map((e) => ({ ...e, aliases: [...e.aliases] })));
    expect((descriptor().default as VisitTypeDefinition[]).map((e) => e.label)).toEqual(['New visit', 'Revisit']);
  });

  it('fails OPEN to those defaults — a missing taxonomy must not take out every consultation', () => {
    expect(descriptor().failMode).toBe('open-to-default');
    // The fail-closed rule in 09 Tiers is about
    // provider/model SELECTION, where a fallback could silently become another
    // tenant's value. This key cannot do that: the only thing above a tenant is
    // the platform's own published default.
    expect(descriptor().sensitivity).not.toBe('secret');
  });

  it('declares the cross-entry invariant a shape check cannot express', () => {
    expect(typeof descriptor().validate).toBe('function');
    expect(descriptor().validate!([])).toMatch(/at least one/i);
  });

  it('is NOT served on the platform-scope effective-config pull route', () => {
    // A `maxScope: 'tenant'` key must never declare `consumedBy` — one cached
    // snapshot per service process would serve one tenant's taxonomy to all
    // (owner decision D-1, the `guardrail.policy.*` worked example).
    expect(descriptor().consumedBy).toBeUndefined();
  });
});

describe('the SYSTEM tier answers by DEFAULT, not by a seeded row', () => {
  /*
   * A `GlobalSetting` row carrying the same two types would be a SECOND source
   * of one truth — written once at bootstrap and never re-asserted, because
   * `RUN_SEED` defaults to `none`. That is the exact defect removed
   * from `harness.loop.enabled`. A row is warranted only when the intended
   * value DIFFERS from the descriptor default; here it does not.
*/
  it('is not written by any seed phase', () => {
    const seeds = readFileSync(resolve(SEED_DIR, 'index.ts'), 'utf8');
    const phases = [...seeds.matchAll(/from '\.\/([0-9a-z-]+)'/g)].map((m) => m[1]!);
    for (const phase of phases) {
      let source: string;
      try {
        source = readFileSync(resolve(SEED_DIR, `${phase}.ts`), 'utf8');
      } catch {
        continue;
      }
      expect(source, `${phase}.ts seeds ${CONSULTATION_VISIT_TYPES_KEY}`).not.toContain(CONSULTATION_VISIT_TYPES_KEY);
    }
  });

  it('resolves the two shipped types with no row anywhere, reported as the code default', () => {
    const resolved = new TenantSettingsService(fakeAppSettings(null)).resolve<VisitTypeDefinition[]>(CONSULTATION_VISIT_TYPES_KEY, 'tenant-1');
    expect(resolved.source).toBe('code-default');
    expect(resolved.value.map((e) => e.key)).toEqual(['new-visit', 'revisit']);
  });

  it('lets a platform admin override the SYSTEM tier without touching any tenant', () => {
    const platform = [
      { key: 'walk-in', label: 'Walk-in', aliases: [], promptSlot: 'new-patient' },
      { key: 'review', label: 'Review', aliases: [], promptSlot: 'revisit' },
    ];
    const settings = new TenantSettingsService(fakeAppSettings(platform));
    expect(settings.resolve(CONSULTATION_VISIT_TYPES_KEY, 'tenant-1').source).toBe('system');
  });

  it('lets a tenant override the platform, and reports which tier answered', () => {
    const own = [
      { key: 'clinic-visit', label: 'Clinic visit', aliases: [], promptSlot: 'new-patient' },
      { key: 'clinic-review', label: 'Clinic review', aliases: [], promptSlot: 'revisit' },
    ];
    const settings = new TenantSettingsService(fakeAppSettings(null, { 'tenant-1': own }));
    const resolved = settings.resolve<VisitTypeDefinition[]>(CONSULTATION_VISIT_TYPES_KEY, 'tenant-1');
    expect(resolved.source).toBe('tenant');
    expect(resolved.value.map((e) => e.key)).toEqual(['clinic-visit', 'clinic-review']);
  });
});
