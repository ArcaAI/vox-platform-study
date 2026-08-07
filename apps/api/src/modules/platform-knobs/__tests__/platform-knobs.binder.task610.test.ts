import type { IOriginRegistry } from '@arcaai/applications';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isOriginAllowed, setOriginRegistryResolver } from '../../../cors.config';
import { PlatformKnobsBinder } from '../platform-knobs.binder';

/**
 * TASK-610 — the binder is what makes CORS DB-backed, and it owns one rule
 * `cors.config.ts` cannot express on its own: an EMPTY index is reported as
 * `null` ("not loaded"), not as a loaded-but-empty registry.
 *
 * Since §4A.1 removed the `CORS_ALLOWED_ORIGINS` bootstrap fallback entirely,
 * that split no longer changes the OUTCOME — both a `null` resolver and a
 * loaded-but-empty registry deny every origin (`cors.config.ts` denies
 * whenever `queryRegistry` returns `null`, and an empty registry's `has()`
 * would answer `false` for everything anyway). What the split still buys is
 * DIAGNOSTICS: a `null` registry logs the distinct, greppable
 * `origin_registry_unavailable` reason — "nothing is loaded platform-wide,
 * check the database" — instead of the ordinary per-origin
 * `origin_registry_miss` a populated registry's "no" produces. That matters
 * because `OriginRegistryService.refresh()` never throws on an unreachable
 * database — it keeps its previous (at boot: empty) index — so a real DB
 * outage and a merely-unseeded table both present as `size() === 0` and both
 * deserve the systemic signal, not one log line per attempted origin (plan
 * §3.8).
 */
/**
 * Map value is the set of tenants GRANTED that origin — since §4B an origin is
 * granted to many tenants rather than owned by one.
 */
function fakeRegistry(origins: Record<string, string[]>): IOriginRegistry {
  const index = new Map(Object.entries(origins).map(([origin, tenants]) => [origin, new Set(tenants)]));
  return {
    tenantsFor: (origin: string) => index.get(origin) ?? new Set<string>(),
    has: (origin: string) => index.has(origin),
    allows: (origin: string, tenantId: string) => index.get(origin)?.has(tenantId) ?? false,
    refresh: async () => undefined,
    size: () => index.size,
  };
}

const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';

describe('PlatformKnobsBinder — origin registry resolver', () => {
  beforeEach(() => {
    setOriginRegistryResolver(null);
  });

  afterEach(() => {
    setOriginRegistryResolver(null);
  });

  it('makes a populated registry authoritative — registered admitted, everything else refused', () => {
    new PlatformKnobsBinder(undefined, undefined, fakeRegistry({ 'https://registered.example.com': [SYSTEM_TENANT] })).onModuleInit();

    expect(isOriginAllowed('https://registered.example.com', 'production')).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', 'production')).toBe(false);
  });

  it('reports an EMPTY registry as unloaded, so CORS denies every origin (TASK-610 §4A.1: no bootstrap fallback)', () => {
    new PlatformKnobsBinder(undefined, undefined, fakeRegistry({})).onModuleInit();

    expect(isOriginAllowed('https://anything.example.com', 'production')).toBe(false);
  });

  it('denies every origin when no registry is wired at all', () => {
    new PlatformKnobsBinder().onModuleInit();

    expect(isOriginAllowed('https://anything.example.com', 'production')).toBe(false);
  });

  it('installs the resolver even when no settings resolver is wired (the two knobs are independent)', () => {
    const binder = new PlatformKnobsBinder(undefined, undefined, fakeRegistry({ 'https://registered.example.com': [SYSTEM_TENANT] }));

    expect(() => binder.onModuleInit()).not.toThrow();
    expect(isOriginAllowed('https://registered.example.com', 'production')).toBe(true);
  });
});
