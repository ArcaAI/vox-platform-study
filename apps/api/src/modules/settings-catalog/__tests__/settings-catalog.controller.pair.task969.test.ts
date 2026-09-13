/**
 * TASK-969 WS-1 — `platformTierKey` reaches the CATALOG, not only the value read.
 *
 * The pair collapses into ONE console row, and the console decides that at LIST
 * time. But the `pair` block on `GET registry/:key` is built from resolved
 * VALUES, which the catalog deliberately does not carry (metadata only, so the
 * listing is safe for any admin and costs no cascade reads). Without the raw
 * `platformTierKey` on the catalog item there is nothing at list time that says
 * these two keys are one thing, and the screen silently degrades to the two
 * confusing rows this ticket exists to remove.
 *
 * So the field is projected twice, from the same descriptor: as the identifier
 * here, and inside the value-bearing `pair` block there.
 */
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY, type EffectiveSettingsService } from '@arcaai/applications';
import { SettingsCatalogController } from '../settings-catalog.controller';

const TENANT_HALF = 'text.guardrailPolicy.requireMedical';
const TENANT_HALF_2 = 'text.guardrailPolicy.includeReasoning';
const PLATFORM_TWIN = 'text.externalGuardrail.requireMedical';
const PLATFORM_TWIN_2 = 'text.externalGuardrail.includeReasoning';

function superAdminCatalog() {
  const cls = { get: (k: string) => (k === 'user' ? { roles: ['SUPER_ADMIN'] } : undefined) } as never;
  return new SettingsCatalogController(cls, {} as EffectiveSettingsService).getCatalog();
}

describe('GET admin/settings/catalog — platformTierKey', () => {
  it('carries the twin for both tenant-half keys', () => {
    const items = superAdminCatalog().items;

    expect(items.find((i) => i.key === TENANT_HALF)?.platformTierKey).toBe(PLATFORM_TWIN);
    expect(items.find((i) => i.key === TENANT_HALF_2)?.platformTierKey).toBe(PLATFORM_TWIN_2);
  });

  it('OMITS the field — not null, not undefined-valued — on every key that declares no twin', () => {
    const items = superAdminCatalog().items;
    const unpaired = items.filter((i) => ![TENANT_HALF, TENANT_HALF_2].includes(i.key));

    expect(unpaired.length).toBeGreaterThan(200);
    expect(unpaired.every((i) => !('platformTierKey' in i))).toBe(true);
    // including the PLATFORM halves themselves: a platform tier is the top of
    // the pair, so it names no tier of its own.
    expect('platformTierKey' in items.find((i) => i.key === PLATFORM_TWIN)!).toBe(false);
  });

  it('projects it from the descriptor for EVERY key, so the two surfaces cannot disagree', () => {
    for (const item of superAdminCatalog().items) {
      expect(item.platformTierKey).toBe(HOPE_SETTINGS_REGISTRY.getOrThrow(item.key).platformTierKey);
    }
  });
});

describe('tenant visibility is unchanged by the pairing', () => {
  it('neither half reaches a tenant admin — both are globalOnly (OD-2)', () => {
    const cls = { get: (k: string) => (k === 'user' ? { roles: ['TENANT_ADMIN'], tenantId: 't1' } : k === 'tenantId' ? 't1' : undefined) } as never;
    const items = new SettingsCatalogController(cls, {} as EffectiveSettingsService).getCatalog().items;

    for (const key of [TENANT_HALF, TENANT_HALF_2, PLATFORM_TWIN, PLATFORM_TWIN_2]) {
      expect(items.some((i) => i.key === key)).toBe(false);
    }
    // and the general rule still holds, so the projection did not widen the filter.
    expect(items.every((i) => !i.globalOnly)).toBe(true);
  });
});
