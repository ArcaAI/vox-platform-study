/**
 * The PERMISSIVE side of the origin-enforcement switch.
 *
 * This file used to be headed "origin
 * enforcement is OFF BY DEFAULT", quoting the owner directive "make
 * sure by default (apply to all tenants including SYSTEM, GLOBAL) no origin
 * checks, ALL is ALLOWED for calling and using our APIs". That directive was
 * reversed: `origin.enforcementEnabled` DEFAULT is `true`, so
 * enforcement is now the platform default in every environment.
 *
 * None of the assertions below changed, because none of them was ever about the
 * DESCRIPTOR default. They pin `cors.config.ts`'s own resolver contract: with no
 * resolver installed — or one that returns false, or one that throws —
 * `isOriginEnforcementEnabled()` is false and the registry is never consulted.
 * A descriptor default cannot move any of that; only the binder installing a
 * resolver can. What the un-installed case now MEANS is narrower than it was: it
 * is this process's pre-boot window, not the platform's posture.
 *
 * This file pins the PERMISSIVE side of the switch. The enforcing side is
 * `cors.config.test.ts`, which now installs `setOriginEnforcementResolver(() =>
 * true)` and is otherwise unchanged — that pairing is the point: turning the
 * switch on must restore the enforcing path exactly, and turning it off must bypass all of
 * it without deleting any of it.
 *
 * The load-bearing assertion is `never consults the registry`. "Allowed" alone
 * would also be satisfied by a registry that happened to contain the origin, or
 * by a fail-open bug in the lookup. Asserting the lookup never RAN is what
 * proves the switch short-circuits ahead of the registry rather than merely
 * agreeing with it.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';

import {
  buildCorsOptions,
  isOriginAllowed,
  isOriginEnforcementEnabled,
  setOriginEnforcementResolver,
  setOriginRegistryResolver,
} from '../cors.config';

const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';

/** A registry whose lookups are spies, so "never consulted" is observable. */
function spyRegistry(entries: Record<string, string[]> = {}) {
  const index = new Map(Object.entries(entries).map(([origin, tenants]) => [origin, new Set(tenants)]));
  return {
    has: vi.fn((origin: string) => index.has(origin)),
    allows: vi.fn((origin: string, tenantId: string) => index.get(origin)?.has(tenantId) ?? false),
  };
}

describe('origin enforcement switch', () => {
  beforeEach(() => {
    setOriginRegistryResolver(null);
    setOriginEnforcementResolver(null);
  });

  afterEach(() => {
    setOriginRegistryResolver(null);
    setOriginEnforcementResolver(null);
    vi.restoreAllMocks();
  });

  describe('the pre-boot state — nothing installed at all', () => {
    it('reports enforcement DISABLED when no resolver was ever installed', () => {
      expect(isOriginEnforcementEnabled()).toBe(false);
    });

    it('admits an unregistered origin and never consults the registry', () => {
      const registry = spyRegistry({ 'https://registered.example.com': [SYSTEM_TENANT] });
      setOriginRegistryResolver(() => registry);

      expect(isOriginAllowed('https://evil.example.com', 'production')).toBe(true);
      expect(registry.has).not.toHaveBeenCalled();
    });

    it('admits every origin shape a hostile caller could send, in every environment', () => {
      setOriginRegistryResolver(() => spyRegistry({}));

      for (const nodeEnv of ['development', 'staging', 'production', 'test']) {
        for (const origin of ['https://evil.example.com', 'http://localhost:9999', 'null', 'not a url', '*', 'file:///etc/passwd']) {
          expect(isOriginAllowed(origin, nodeEnv), `${origin} in ${nodeEnv}`).toBe(true);
        }
      }
    });

    it('admits an unregistered origin even when NO registry is wired (the pre-boot case)', () => {
      // Pre- this exact case was the fail-closed `origin_registry_unavailable`
      // deny. made it permissive so a request landing before the binder is
      // up is not refused on the strength of a guess.
      //
      // This is NOT "a deployment cannot lock itself out" any more
      // defaults enforcement ON, so once the binder installs the resolver
      // an origin with no matching row IS refused. What prevents the lock-out is
      // that the six SYSTEM loopback rows are guaranteed by a migration
      // (`20260808160000_task_641_bootstrap_loopback_origins`) rather than by
      // the opt-in seed — see `cors.config.ts` and.
      expect(isOriginAllowed('https://anything.example.com', 'production')).toBe(true);
    });
  });

  describe('an installed resolver', () => {
    it('reports enforcement ENABLED when the resolver says true', () => {
      setOriginEnforcementResolver(() => true);
      expect(isOriginEnforcementEnabled()).toBe(true);
    });

    it('reports DISABLED when the resolver says false, and admits an unregistered origin', () => {
      const registry = spyRegistry({});
      setOriginRegistryResolver(() => registry);
      setOriginEnforcementResolver(() => false);

      expect(isOriginEnforcementEnabled()).toBe(false);
      expect(isOriginAllowed('https://evil.example.com', 'production')).toBe(true);
      expect(registry.has).not.toHaveBeenCalled();
    });

    it('is resolved PER CALL, so a settings write takes effect without a restart', () => {
      let enabled = false;
      setOriginEnforcementResolver(() => enabled);
      setOriginRegistryResolver(() => spyRegistry({}));

      expect(isOriginAllowed('https://evil.example.com', 'production')).toBe(true);
      enabled = true;
      expect(isOriginAllowed('https://evil.example.com', 'production')).toBe(false);
    });

    it('treats a THROWING resolver as disabled (permissive) rather than surfacing a 500 into the cors middleware', () => {
      setOriginEnforcementResolver(() => {
        throw new Error('settings cache exploded');
      });
      setOriginRegistryResolver(() => spyRegistry({}));

      expect(() => isOriginEnforcementEnabled()).not.toThrow();
      expect(isOriginEnforcementEnabled()).toBe(false);
      expect(isOriginAllowed('https://evil.example.com', 'production')).toBe(true);
    });

    it('treats a non-boolean resolved value as disabled — only a literal `true` enforces', () => {
      setOriginEnforcementResolver(() => undefined as unknown as boolean);
      expect(isOriginEnforcementEnabled()).toBe(false);
    });
  });

  describe('enforcement ENABLED restores the enforcing path exactly', () => {
    beforeEach(() => setOriginEnforcementResolver(() => true));

    it('refuses an unregistered origin and consults the registry to decide', () => {
      const registry = spyRegistry({ 'https://registered.example.com': [SYSTEM_TENANT] });
      setOriginRegistryResolver(() => registry);

      expect(isOriginAllowed('https://evil.example.com', 'production')).toBe(false);
      expect(isOriginAllowed('https://registered.example.com', 'production')).toBe(true);
      expect(registry.has).toHaveBeenCalledWith('https://evil.example.com');
    });

    it('still fails CLOSED when the registry is unavailable (no env fallback)', () => {
      expect(isOriginAllowed('https://anything.example.com', 'production')).toBe(false);
    });
  });
});

describe('buildCorsOptions (credentials: false)', () => {
  /**
   * Allow-all origins WITH credentials is a cross-origin read primitive: any
   * site a logged-in user visits could issue authenticated requests and read
   * the responses, PHI included. `credentials: false` is what keeps a permissive
   * posture an ordinary public-API one instead of a data-leak path — so it is
   * pinned here rather than left to review. narrowed that window
   * (enforcement now defaults ON) but did not close it: an operator may still
   * turn the switch off, and H-4 records that `credentials` stays `false`
   * regardless, so nobody "restores" it as a tidy-up.
   */
  it('never permits cross-origin credentials', () => {
    expect(buildCorsOptions('production').credentials).toBe(false);
    expect(buildCorsOptions('development').credentials).toBe(false);
  });

  it('still carries the origin callback and the explicit header lists', () => {
    const options = buildCorsOptions('production');

    expect(typeof options.origin).toBe('function');
    expect(options.allowedHeaders).toContain('Authorization');
    expect(options.allowedHeaders).toContain('If-Match');
    expect(options.exposedHeaders).toContain('ETag');
    expect(options.methods).toContain('PATCH');
  });
});
