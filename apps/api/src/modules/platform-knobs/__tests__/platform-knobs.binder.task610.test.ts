import type { IOriginRegistry } from '@arcaai/applications';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isOriginAllowed, setOriginRegistryResolver } from '../../../cors.config';
import { PlatformKnobsBinder } from '../platform-knobs.binder';

/**
 * TASK-610 — the binder is what makes CORS DB-backed, and it owns one rule
 * `cors.config.ts` cannot express on its own: an EMPTY index is reported as
 * `null` ("not loaded"), not as a loaded-but-empty registry.
 *
 * That split is FR-6. `OriginRegistryService.refresh()` never throws on an
 * unreachable database — it keeps its previous (at boot: empty) index. If the
 * binder handed that empty index over as authoritative, a database outage or
 * an unseeded table would refuse every browser origin on the platform instead
 * of falling back to `CORS_ALLOWED_ORIGINS` (plan §3.8).
 */
function fakeRegistry(origins: Record<string, string>): IOriginRegistry {
  const index = new Map(Object.entries(origins));
  return {
    has: (origin: string) => index.has(origin),
    ownerOf: (origin: string) => index.get(origin) ?? null,
    refresh: async () => undefined,
    size: () => index.size,
  };
}

const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';

describe('PlatformKnobsBinder — origin registry resolver', () => {
  const envBackup = process.env.CORS_ALLOWED_ORIGINS;

  beforeEach(() => {
    setOriginRegistryResolver(null);
    process.env.CORS_ALLOWED_ORIGINS = 'https://boot.example.com';
  });

  afterEach(() => {
    setOriginRegistryResolver(null);
    if (envBackup === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = envBackup;
  });

  it('makes a populated registry authoritative — registered admitted, everything else refused', () => {
    new PlatformKnobsBinder(undefined, undefined, fakeRegistry({ 'https://registered.example.com': SYSTEM_TENANT })).onModuleInit();

    expect(isOriginAllowed('https://registered.example.com', 'production')).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', 'production')).toBe(false);
    // The registry answered, so the bootstrap allow-list is no longer consulted.
    expect(isOriginAllowed('https://boot.example.com', 'production')).toBe(false);
  });

  it('reports an EMPTY registry as unloaded, so CORS keeps using the bootstrap allow-list (FR-6)', () => {
    new PlatformKnobsBinder(undefined, undefined, fakeRegistry({})).onModuleInit();

    expect(isOriginAllowed('https://boot.example.com', 'production')).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', 'production')).toBe(false);
  });

  it('leaves the bootstrap allow-list in charge when no registry is wired at all', () => {
    new PlatformKnobsBinder().onModuleInit();

    expect(isOriginAllowed('https://boot.example.com', 'production')).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', 'production')).toBe(false);
  });

  it('installs the resolver even when no settings resolver is wired (the two knobs are independent)', () => {
    const binder = new PlatformKnobsBinder(undefined, undefined, fakeRegistry({ 'https://registered.example.com': SYSTEM_TENANT }));

    expect(() => binder.onModuleInit()).not.toThrow();
    expect(isOriginAllowed('https://registered.example.com', 'production')).toBe(true);
  });
});
