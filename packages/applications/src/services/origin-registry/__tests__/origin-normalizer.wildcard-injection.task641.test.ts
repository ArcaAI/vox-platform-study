/**
 * Wildcard-injection through `new URL()` decoding (TASK-641 lane J, task 1).
 *
 * `normalizeOrigin` guards `raw.includes('*')` BEFORE it calls `new URL(raw)`.
 * That ordering is the bug: WHATWG URL parsing percent-decodes `%2A`/`%2a` and
 * NFKC/IDNA-folds fullwidth `＊` (U+FF0A) into an ASCII `*` in the HOST, so a
 * value that passed the "no wildcard" guard can still COME BACK OUT of the
 * function carrying one.
 *
 * Why that is a privilege escalation and not a cosmetic bug: nothing downstream
 * re-reads the raw input. `origin-registry.service.ts` dispatches a STORED row
 * with `isOriginPattern(storedOrigin)` — "a value is a pattern iff it contains
 * `*`" — so a row that was admitted as an EXACT origin is later evaluated as a
 * genuine wildcard by `matchesOriginPattern`, admitting every subdomain of the
 * attacker's apex with `credentials: true`.
 *
 * `TenantAllowedOriginService` (lane E) also judges the canonical value, but
 * that is one caller's defence. The invariant belongs here: `normalizeOrigin`
 * must NEVER return an origin containing `*`.
 */
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { describe, expect, it } from 'vitest';

import { normalizeOrigin } from '../origin-normalizer';
import { isOriginPattern, matchesOriginPattern, normalizeOriginPattern } from '../origin-pattern';

describe('normalizeOrigin — wildcard injection via URL decoding (TASK-641 lane J)', () => {
  // Both spellings decode to the SAME canonical host `*.evil.com`, which is a
  // grammatically valid `*.<suffix>` pattern — the escalating shape, not a
  // harmless one.
  const INJECTIONS = [
    ['percent-encoded uppercase', 'https://%2A.evil.com'],
    ['percent-encoded lowercase', 'https://%2a.evil.com'],
    ['fullwidth asterisk U+FF0A', 'https://＊.evil.com'],
    ['percent-encoded, with an explicit port', 'https://%2A.evil.com:8443'],
    // Not leftmost, so it cannot become a MATCHING pattern — but it still
    // escapes the guard, and the invariant is "never return a `*`", not
    // "never return an exploitable `*`".
    ['percent-encoded in a non-leftmost label', 'https://a.%2A.evil.com'],
  ] as const;

  it.each(INJECTIONS)('rejects %s (%s)', (_label, raw) => {
    expect(() => normalizeOrigin(raw)).toThrow(ArgumentInvalidException);
  });

  it('never returns an origin containing `*` for any of the injection spellings', () => {
    for (const [, raw] of INJECTIONS) {
      let returned: string | null = null;
      try {
        returned = normalizeOrigin(raw).origin;
      } catch {
        continue; // Rejected — the correct outcome.
      }
      expect.soft(returned, `normalizeOrigin(${raw}) returned a value`).toBeNull();
      expect(returned).not.toContain('*');
    }
  });

  it('the injected value would otherwise be dispatched as a real wildcard pattern at CORS admission', () => {
    // Documents the impact the fix removes. `origin-registry.service.ts`
    // classifies a stored row purely by `isOriginPattern`, so the canonical
    // string below — had it been allowed to be stored as an "exact" origin —
    // admits every https subdomain of evil.com.
    const injected = 'https://*.evil.com';

    expect(isOriginPattern(injected)).toBe(true);
    expect(matchesOriginPattern(normalizeOriginPattern(`${injected}:*`), 'https://login.evil.com')).toBe(true);

    // ...and that string is exactly what the decode produced.
    expect(new URL('https://%2A.evil.com').hostname).toBe('*.evil.com');
  });
});

describe('normalizeOrigin — other decode-after-check vectors (ruled out, pinned)', () => {
  it('percent-encoded structural delimiters in the host are rejected by the parser itself', () => {
    // `%2F` `%3A` `%40` `%25` do NOT decode into the host: WHATWG URL fails the
    // parse outright, so the path/port/userinfo checks are never reached with a
    // smuggled delimiter.
    for (const raw of ['https://evil.com%2Fpath', 'https://evil.com%3A8080', 'https://user%40evil.com', 'https://%252A.evil.com']) {
      expect(() => normalizeOrigin(raw)).toThrow(ArgumentInvalidException);
    }
  });

  it('Unicode dot folding changes host LABEL structure but never the pattern/exact classification', () => {
    // U+FF0E, U+3002, U+FF61 and `%2E` all fold to `.`. That splits a label,
    // which is a canonicalization surprise — but it can only produce a host the
    // same registrant could have typed directly, and it can never introduce a
    // `*`, so it does not cross the exact→pattern boundary.
    for (const raw of ['https://a%2Eb.evil.com', 'https://sub．evil.com', 'https://sub。evil.com', 'https://sub｡evil.com']) {
      const { origin } = normalizeOrigin(raw);
      expect(origin).not.toContain('*');
      expect(isOriginPattern(origin)).toBe(false);
    }
    expect(normalizeOrigin('https://a%2Eb.evil.com').origin).toBe('https://a.b.evil.com');
    expect(normalizeOrigin('https://sub．evil.com').origin).toBe('https://sub.evil.com');
  });

  it('a trailing root dot stays a distinct host and does not satisfy the apex wildcard', () => {
    expect(normalizeOrigin('https://evil.com.').origin).toBe('https://evil.com.');
    expect(matchesOriginPattern('https://*.evil.com:*', 'https://evil.com.')).toBe(false);
    expect(matchesOriginPattern('https://*.evil.com:*', 'https://sub.evil.com.')).toBe(false);
  });

  it('tab/newline stripping inside a host cannot forge a loopback host for the http:// exemption', () => {
    // `new URL()` strips TAB, so the host becomes `127.0.0.1.evil.com`. The
    // anchored IPv4 loopback regex rejects it, so the http:// exemption holds.
    expect(() => normalizeOrigin('http://127.0.0.1\t.evil.com')).toThrow(/loopback/);
  });

  it('fullwidth digits folding to a loopback literal is correct, not a widening', () => {
    // The http:// exemption is decided on the CANONICAL host, so this resolves
    // to a genuine loopback address rather than sneaking past the check.
    expect(normalizeOrigin('http://１２７.0.0.1').origin).toBe('http://127.0.0.1');
  });
});

describe('normalizeOriginPattern — the same decode class is already closed', () => {
  it('rejects percent-encoding in the authority BEFORE any URL parsing', () => {
    // `parsePattern` puts `%` in FORBIDDEN_AUTHORITY_CHARS and checks the raw
    // authority, so `%2A` can never reach `canonicalizeHost`'s `new URL()`.
    expect(() => normalizeOriginPattern('https://%2A.evil.com:*')).toThrow(/percent-encoding/);
    expect(() => normalizeOriginPattern('https://a%2Eb.evil.com:*')).toThrow(/percent-encoding/);
  });

  it('rejects a fullwidth asterisk that folds into the canonical host', () => {
    // `＊` is not `*`, so the host parses down the CONCRETE branch and
    // `canonicalizeHost` folds it to `*.evil.com`. The LDH label validation
    // that runs on the canonicalized host is what closes it: `*` is not a legal
    // DNS label. (The literal `:*` port is only there to get past the
    // "must contain a wildcard" gate.)
    expect(() => normalizeOriginPattern('https://＊.evil.com:*')).toThrow(/invalid DNS label/);
  });

  it('rejects a fullwidth asterisk smuggled into a wildcard suffix', () => {
    expect(() => normalizeOriginPattern('https://*.＊.evil.com:*')).toThrow(ArgumentInvalidException);
  });

  it('applies the label-count and public-suffix floors to the CANONICALIZED suffix, so dot folding cannot evade them', () => {
    // Folding can only ADD dots, and both floors run after canonicalization.
    expect(() => normalizeOriginPattern('https://*.co．uk:*')).toThrow(/public suffix/);
    expect(() => normalizeOriginPattern('https://*.vercel．app:*')).toThrow(/public suffix/);
  });

  it('still round-trips every legitimate canonical pattern unchanged', () => {
    for (const pattern of ['https://*.bcmch.org:*', 'http://localhost:*', 'http://[::1]:*', 'https://127.0.0.1:*']) {
      expect(normalizeOriginPattern(pattern)).toBe(pattern);
    }
  });
});
