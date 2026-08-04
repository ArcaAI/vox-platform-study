import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCorsOrigins, isOriginAllowed, setOriginRegistryResolver } from '../cors.config';

/**
 * TASK-610 T-4 — CORS origin admission is a REGISTRY LOOKUP.
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

/** A stand-in for `OriginRegistryService` — only `has`/`ownerOf` are consumed. */
function fakeRegistry(entries: Record<string, string>) {
  const index = new Map(Object.entries(entries));
  return {
    has: (origin: string) => index.has(origin),
    ownerOf: (origin: string) => index.get(origin) ?? null,
  };
}

const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';

/** The four day-1 origins from plan §1, as a loaded registry. */
const DAY_ONE = fakeRegistry({
  'http://localhost:5173': SYSTEM_TENANT,
  'https://arcaai-u2204.bcmch.org': SYSTEM_TENANT,
  'https://arcaai-staging.bcmch.org': SYSTEM_TENANT,
  'https://mi-preproduction.bcmch.org:4433': SYSTEM_TENANT,
});

describe('cors.config', () => {
  const envBackup = process.env.CORS_ALLOWED_ORIGINS;

  beforeEach(() => {
    setOriginRegistryResolver(null);
    delete process.env.CORS_ALLOWED_ORIGINS;
  });

  afterEach(() => {
    setOriginRegistryResolver(null);
    if (envBackup === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = envBackup;
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
     * Every origin below was ALLOWED by the pre-TASK-610 implementation:
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

    it('refuses loopback in production even though development allows it', () => {
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

  describe('bootstrap fallback (FR-6)', () => {
    it('falls back to CORS_ALLOWED_ORIGINS when no resolver is installed', () => {
      process.env.CORS_ALLOWED_ORIGINS = 'https://boot.example.com, https://other.example.com';

      expect(isOriginAllowed('https://boot.example.com', 'production')).toBe(true);
      expect(isOriginAllowed('https://other.example.com', 'production')).toBe(true);
      expect(isOriginAllowed('https://not-listed.example.com', 'production')).toBe(false);
    });

    it('falls back when the resolver is installed but the registry has not loaded (null)', () => {
      setOriginRegistryResolver(() => null);
      process.env.CORS_ALLOWED_ORIGINS = 'https://boot.example.com';

      expect(isOriginAllowed('https://boot.example.com', 'production')).toBe(true);
      expect(isOriginAllowed('https://not-listed.example.com', 'production')).toBe(false);
    });

    /**
     * A non-null registry is AUTHORITATIVE here — a miss is a refusal and the
     * env list is not consulted. "The registry is empty/unreadable" is not
     * expressed as an empty index at this layer: `PlatformKnobsBinder`
     * collapses an empty index to `null` (asserted in
     * `platform-knobs.binder.task610.test.ts`) so that case lands on the
     * fallback above instead. Without that split, one stale resolver would
     * silently re-open the env list on every registry miss.
     */
    it('does NOT fall back once the registry has answered — a miss is a refusal', () => {
      setOriginRegistryResolver(() => fakeRegistry({ 'https://registered.example.com': SYSTEM_TENANT }));
      process.env.CORS_ALLOWED_ORIGINS = 'https://boot.example.com';

      expect(isOriginAllowed('https://boot.example.com', 'production')).toBe(false);
      expect(isOriginAllowed('https://registered.example.com', 'production')).toBe(true);
    });

    it('refuses everything when neither a registry nor CORS_ALLOWED_ORIGINS is available', () => {
      expect(isOriginAllowed('https://anything.example.com', 'production')).toBe(false);
    });
  });

  describe('development loopback allowance', () => {
    it.each([
      'http://localhost',
      'http://localhost:5173',
      'https://localhost:8868',
      'http://127.0.0.1',
      'http://127.0.0.1:5173',
      'https://127.0.0.1:5174',
      'http://[::1]:5173',
    ])('admits %s with an empty registry', (origin) => {
      setOriginRegistryResolver(() => fakeRegistry({}));
      expect(isOriginAllowed(origin, 'development')).toBe(true);
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
  });

  describe('a broken registry never takes the gateway down', () => {
    it('does not throw when the resolver itself throws, and falls back to the env allow-list', () => {
      setOriginRegistryResolver(() => {
        throw new Error('registry exploded');
      });
      process.env.CORS_ALLOWED_ORIGINS = 'https://boot.example.com';

      expect(() => isOriginAllowed('https://boot.example.com', 'production')).not.toThrow();
      expect(isOriginAllowed('https://boot.example.com', 'production')).toBe(true);
      expect(isOriginAllowed('https://evil.example.com', 'production')).toBe(false);
    });

    it('does not throw when has() throws', () => {
      setOriginRegistryResolver(() => ({
        has: () => {
          throw new Error('lookup exploded');
        },
        ownerOf: () => null,
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
