import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCorsOrigins, isOriginAllowed, setOriginEnforcementResolver, setOriginRegistryResolver } from '../cors.config';

/**
 * CORS origin admission is a REGISTRY LOOKUP.
 *
 * This file replaces the D-1 test that pinned the dev RegExp's `source`
 * string. Pinning a RegExp source is what made it brittle: commit `7703e40f`
 * changed the pattern and the assertion failed without a single behaviour
 * having regressed. Nothing here asserts on an implementation artefact —
 * every case asks the only question that matters: given a registry, is this
 * origin admitted or refused?
 *
 * The headline assertion is `production > refuses an unregistered https://
 * origin`. That is defect D-3, the `https_sdk_allowed` catch-all which made
 * the whole allow-list decorative, and the reason this ticket exists. If that
 * block ever goes green while the catch-all is back, this file has failed at
 * its job.
 */

/**
 * A stand-in for `OriginRegistryService`.
 *
 * `cors.config` consumes only `has` — ADMISSION is "is this origin registered
 * at all", independent of which tenants hold a grant on it. Which tenant may
 * act from it is `OriginTenantBindingGuard`'s question, answered post-auth via
 * `allows()`. `allows` is stubbed here purely to satisfy `OriginIndexResolver`'s
 * `Pick<IOriginRegistry, 'has' | 'allows'>` shape; nothing in this file asserts
 * on it.
 *
 * The map value is the set of tenants granted that origin — since an
 * origin is granted to MANY tenants rather than owned by one.
 */
function fakeRegistry(entries: Record<string, string[]>) {
  const index = new Map(Object.entries(entries).map(([origin, tenants]) => [origin, new Set(tenants)]));
  return {
    has: (origin: string) => index.has(origin),
    allows: (origin: string, tenantId: string) => index.get(origin)?.has(tenantId) ?? false,
  };
}

const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';

/** The four day-1 origins from, as a loaded registry. */
const DAY_ONE = fakeRegistry({
  'http://localhost:5173': [SYSTEM_TENANT],
  'https://arcaai-u2204.bcmch.org': [SYSTEM_TENANT],
  'https://arcaai-staging.bcmch.org': [SYSTEM_TENANT],
  'https://mi-preproduction.bcmch.org:4433': [SYSTEM_TENANT],
});

describe('cors.config', () => {
  beforeEach(() => {
    setOriginRegistryResolver(null);
    // Every case in THIS file describes the ENFORCING posture.
    // Since that IS the shipped default (`origin.enforcementEnabled`
    // defaults `true`), so arming the switch here reproduces production rather
    // than overriding it. It must still be set explicitly: `cors.config.ts` gets
    // the value from a resolver, and in a unit test no `PlatformKnobsBinder` has
    // installed one — the descriptor default never reaches this module by
    // itself. The permissive/off state is pinned separately in
    // `cors.config.enforcement.task610.test.ts`.
    setOriginEnforcementResolver(() => true);
  });

  afterEach(() => {
    setOriginRegistryResolver(null);
    setOriginEnforcementResolver(null);
    vi.restoreAllMocks();
  });

  describe('production — registry hit', () => {
    beforeEach(() => setOriginRegistryResolver(() => DAY_ONE));

    it.each([
      'http://localhost:5173',
      'https://arcaai-u2204.bcmch.org',
      'https://arcaai-staging.bcmch.org',
      'https://mi-preproduction.bcmch.org:4433',
    ])('admits the registered origin %s', (origin) => {
      expect(isOriginAllowed(origin, 'production')).toBe(true);
    });
  });

  describe('production — registry MISS (D-3: the catch-all is closed)', () => {
    beforeEach(() => setOriginRegistryResolver(() => DAY_ONE));

    /**
     * Every origin below was ALLOWED by the the previous implementation implementation:
     * the first group by `https_sdk_allowed` (any https:// origin at all),
     * the rest by the hardcoded domain list, the tunnel/preview wildcards,
     * and the `compat-playground.taphuynh.dev` source literal (D-2).
     */
    it.each([
      'https://evil.example.com',
      'https://attacker.test',
      'https://bcmch.org.evil.example.com',
      'https://app.arcaai.com',
      'https://dashboard.arcaai.com',
      'https://admin.arcaai.com',
      'https://staging.arcaai.com',
      'https://tenant.ngrok.io',
      'https://preview.vercel.app',
      'https://preview.netlify.app',
      'https://x.loca.lt',
      'https://x.gitpod.io',
      'https://x.codesandbox.io',
      'https://compat-playground.taphuynh.dev',
    ])('REFUSES the unregistered https origin %s', (origin) => {
      expect(isOriginAllowed(origin, 'production')).toBe(false);
    });

    it('refuses an unregistered origin in staging too', () => {
      expect(isOriginAllowed('https://staging.arcaai.com', 'staging')).toBe(false);
    });

    it('refuses a near-miss of a registered origin (port and host must match exactly)', () => {
      expect(isOriginAllowed('https://mi-preproduction.bcmch.org', 'production')).toBe(false);
      expect(isOriginAllowed('https://arcaai-u2204.bcmch.org.evil.test', 'production')).toBe(false);
    });

    // Title corrected by : development does not "allow it" any
    // more either — see the `development is NOT a special case` block below.
    it('refuses an unregistered loopback origin in production', () => {
      expect(isOriginAllowed('http://localhost:9999', 'production')).toBe(false);
    });
  });

  describe('no Origin header', () => {
    it('is allowed — server-to-server, curl and internal callers send none', () => {
      setOriginRegistryResolver(() => fakeRegistry({}));
      expect(isOriginAllowed(undefined, 'production')).toBe(true);
      expect(isOriginAllowed('', 'production')).toBe(true);
    });

    it('is allowed even with no resolver installed at all', () => {
      expect(isOriginAllowed(undefined, 'production')).toBe(true);
    });
  });

  describe('registry unavailable — fail CLOSED (no env-var fallback of any kind)', () => {
    it('denies when no resolver is installed at all', () => {
      expect(isOriginAllowed('https://anything.example.com', 'production')).toBe(false);
    });

    it('denies when the resolver is installed but the registry has not loaded (null)', () => {
      setOriginRegistryResolver(() => null);

      expect(isOriginAllowed('https://anything.example.com', 'production')).toBe(false);
    });

    /**
     * A non-null registry is AUTHORITATIVE here — a miss is a refusal, and
     * there is nothing else to fall through to. "The registry is
     * empty/unreadable" is not expressed as an empty index at this layer:
     * `PlatformKnobsBinder` collapses an empty index to `null` (asserted in
     * `platform-knobs.binder.task610.test.ts`) purely so the two DENY paths
     * log under distinct, greppable reasons — not to reach a different
     * outcome (both deny).
     */
    it('a populated registry answering "no" is still a refusal — same outcome as an unavailable one, distinct log reason', () => {
      setOriginRegistryResolver(() => fakeRegistry({ 'https://registered.example.com': [SYSTEM_TENANT] }));

      expect(isOriginAllowed('https://not-registered.example.com', 'production')).toBe(false);
      expect(isOriginAllowed('https://registered.example.com', 'production')).toBe(true);
    });

    /**
     * The operator diagnostic this whole behavior exists for: a total CORS
     * outage (registry unavailable) must be greppable as `origin_registry_
     * unavailable`, distinct from an ordinary per-origin `origin_registry_
     * miss`. Collapsing the two into one message is exactly what an operator
     * staring at a wall of refusals cannot afford (see `logCorsDecision` in
     * `cors.config.ts`).
     */
    it('logs a DISTINCT reason for "registry unavailable" vs an ordinary registry miss', () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      setOriginRegistryResolver(() => null);
      isOriginAllowed('https://unavailable-case.example.com', 'production');

      setOriginRegistryResolver(() => fakeRegistry({ 'https://registered.example.com': [SYSTEM_TENANT] }));
      isOriginAllowed('https://miss-case.example.com', 'production');

      const messages = warnSpy.mock.calls.map(([payload]) => payload as { origin?: string; reason?: string });
      const unavailable = messages.find((m) => m.origin === 'https://unavailable-case.example.com');
      const miss = messages.find((m) => m.origin === 'https://miss-case.example.com');

      expect(unavailable?.reason).toBe('origin_registry_unavailable');
      expect(miss?.reason).toBe('origin_registry_miss');
      expect(unavailable?.reason).not.toBe(miss?.reason);
    });
  });

  /**
   * THIS BLOCK USED TO ASSERT THE OPPOSITE.
   *
   * It pinned a `nodeEnv === 'development'` branch that admitted any loopback
   * origin with an EMPTY registry. That branch was the last environment
   * variable participating in a CORS decision, and the owner directive is that
   * none may: *"no env var may participate in any CORS decision — not as an
   * allow-list, and not as a behavioural branch."*
   *
   * Local development is covered instead by SEEDED SYSTEM-tenant rows
   * (`http://localhost:*`, `http://127.0.0.1:*` — step 2), which
   * are ordinary registry rows and therefore take the ordinary path. That is
   * the point: there is now exactly ONE way in, in every environment.
   *
   * The consequence, stated so nobody rediscovers it in an outage: an
   * environment that never ran the origin seed refuses every browser origin,
   * loopback included. That is hazard H-2, and the mitigation is making those
   * rows unconditional bootstrap data — NOT a code fallback here.
   *
   * 's general form is pinned in `cors.config.task641.test.ts`.
   */
  describe('development is NOT a special case (the loopback branch is deleted)', () => {
    it.each([
      'http://localhost',
      'http://localhost:5173',
      'https://localhost:8868',
      'http://127.0.0.1',
      'http://127.0.0.1:5173',
      'https://127.0.0.1:5174',
      'http://[::1]:5173',
    ])('REFUSES %s in development when the registry does not hold it', (origin) => {
      setOriginRegistryResolver(() => fakeRegistry({}));
      expect(isOriginAllowed(origin, 'development')).toBe(false);
    });

    it.each([
      'http://evil.example.com',
      'https://evil.example.com',
      'http://localhost.evil.example.com',
      'http://127.0.0.1.evil.example.com',
      'https://compat-playground.taphuynh.dev',
      'ftp://localhost:8080',
      'ws://localhost:3000',
      'file:///etc/passwd',
    ])('still refuses the unregistered non-loopback origin %s in development', (origin) => {
      setOriginRegistryResolver(() => fakeRegistry({}));
      expect(isOriginAllowed(origin, 'development')).toBe(false);
    });

    it('admits a registered non-loopback origin in development', () => {
      setOriginRegistryResolver(() => DAY_ONE);
      expect(isOriginAllowed('https://arcaai-u2204.bcmch.org', 'development')).toBe(true);
    });

    /**
     * The replacement path, end to end: registration — not the environment — is
     * what admits loopback now. `DAY_ONE` already carries `http://localhost:5173`
     * as a SYSTEM row, so this is the seeded case with no new fixture.
     */
    it('admits a REGISTERED loopback origin — in development and in production alike', () => {
      setOriginRegistryResolver(() => DAY_ONE);
      expect(isOriginAllowed('http://localhost:5173', 'development')).toBe(true);
      expect(isOriginAllowed('http://localhost:5173', 'production')).toBe(true);
    });
  });

  describe('a broken registry never takes the gateway down', () => {
    it('does not throw when the resolver itself throws, and DENIES (no bootstrap fallback)', () => {
      setOriginRegistryResolver(() => {
        throw new Error('registry exploded');
      });

      expect(() => isOriginAllowed('https://anything.example.com', 'production')).not.toThrow();
      expect(isOriginAllowed('https://anything.example.com', 'production')).toBe(false);
    });

    it('does not throw when has() throws', () => {
      setOriginRegistryResolver(() => ({
        has: () => {
          throw new Error('lookup exploded');
        },
        allows: () => false,
      }));

      expect(() => isOriginAllowed('https://evil.example.com', 'production')).not.toThrow();
      expect(isOriginAllowed('https://evil.example.com', 'production')).toBe(false);
    });

    it('does not throw on a malformed Origin header', () => {
      setOriginRegistryResolver(() => DAY_ONE);
      for (const junk of ['null', 'not a url', '*', 'https://', '://x']) {
        expect(() => isOriginAllowed(junk, 'production')).not.toThrow();
        expect(isOriginAllowed(junk, 'production')).toBe(false);
      }
    });
  });

  describe('getCorsOrigins', () => {
    /**
     * Deliberately NOT asserting a RegExp source (the D-1 mistake). Every
     * environment now returns the same callback so the registry is the single
     * decision point; the assertions are on what the callback ANSWERS.
     */
    it.each(['development', 'staging', 'production', 'test'])('returns a callback in %s', (nodeEnv) => {
      expect(typeof getCorsOrigins(nodeEnv)).toBe('function');
    });

    it('answers via the registry and never surfaces an error to the cors middleware', () => {
      setOriginRegistryResolver(() => DAY_ONE);
      const origin = getCorsOrigins('production') as (
        o: string | undefined,
        cb: (err: Error | null, allow?: boolean) => void,
      ) => void;

      const seen: Array<[Error | null, boolean | undefined]> = [];
      const cb = (err: Error | null, allow?: boolean) => seen.push([err, allow]);

      origin('https://arcaai-u2204.bcmch.org', cb);
      origin('https://evil.example.com', cb);
      origin(undefined, cb);

      expect(seen).toEqual([
        [null, true],
        [null, false],
        [null, true],
      ]);
    });
  });
});
