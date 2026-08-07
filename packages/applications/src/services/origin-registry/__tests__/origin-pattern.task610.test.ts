// TASK-610 lane W5-A — wildcard origin PATTERN tests.
//
// Written FIRST per `01-development-workflow.md` TDD gate: this file is run and
// observed RED before `../origin-pattern.ts` exists.
//
// The contract under test is the FROZEN grammar of README §4A.2:
//
//   pattern     := <scheme>://<hostPattern>:<portPattern>
//     scheme      := 'http' | 'https'   http ONLY when hostPattern is loopback
//     hostPattern := '*.' <suffix> | <host>
//     portPattern := '*' | <digits>     ALWAYS explicit in canonical form
//
// plus the five frozen match rules (exact scheme · `*` port matches any port ·
// subdomains at any depth but NEVER the apex · label-boundary match · `*.`
// suffix must carry >= 2 labels).

import { ArgumentInvalidException } from '@arcaai/exceptions';
import { describe, expect, it } from 'vitest';
import { ALLOW_ALL_ORIGIN_PATTERN, isOriginPattern, matchesOriginPattern, normalizeOriginPattern, patternSpecificity } from '../origin-pattern';

describe('isOriginPattern', () => {
  it.each([
    'https://*.bcmch.org:*',
    'https://*.taphuynh.dev:*',
    'https://*.4bits.vn:*',
    'http://localhost:*',
    'https://*.bcmch.org:4433',
    // the allow-all token
    '*',
    // Classification is purely "contains a `*`" (§4A.2). It deliberately does
    // NOT imply the value is a VALID pattern — that is normalizeOriginPattern's
    // job at write time. A stored row can only be one or the other.
    'https://**.evil.com:*',
  ])('classifies %s as a pattern', (value) => {
    expect(isOriginPattern(value)).toBe(true);
  });

  it.each(['https://arcaai-u2204.bcmch.org', 'http://localhost:5173', 'https://mi-preproduction.bcmch.org:4433', '', '   '])(
    'classifies %s as NOT a pattern',
    (value) => {
      expect(isOriginPattern(value)).toBe(false);
    },
  );

  it('never throws on non-string input', () => {
    for (const hostile of [null, undefined, 42, {}, [], true, Symbol('x')]) {
      expect(isOriginPattern(hostile as unknown as string)).toBe(false);
    }
  });
});

describe('normalizeOriginPattern — accepts + canonicalizes', () => {
  it.each([
    // the four canonical seed forms are already canonical (idempotent)
    ['https://*.bcmch.org:*', 'https://*.bcmch.org:*'],
    ['https://*.taphuynh.dev:*', 'https://*.taphuynh.dev:*'],
    ['https://*.4bits.vn:*', 'https://*.4bits.vn:*'],
    ['http://localhost:*', 'http://localhost:*'],
    // scheme + host are case-insensitive; canonical output is lowercase
    ['HTTPS://*.BCMCH.ORG:*', 'https://*.bcmch.org:*'],
    ['HtTp://LocalHost:*', 'http://localhost:*'],
    // an explicit numeric port is preserved verbatim...
    ['https://*.bcmch.org:4433', 'https://*.bcmch.org:4433'],
    // ...including a scheme-DEFAULT port, which stays explicit because the
    // frozen grammar requires the port segment in every canonical pattern.
    ['https://*.bcmch.org:443', 'https://*.bcmch.org:443'],
    // wildcard suffix may itself be deep
    ['https://*.a.b.bcmch.org:*', 'https://*.a.b.bcmch.org:*'],
    // http is permitted for loopback host patterns only
    ['http://127.0.0.1:*', 'http://127.0.0.1:*'],
    ['http://[::1]:*', 'http://[::1]:*'],
    // https over a loopback host is fine too (scheme rule only gates http)
    ['https://localhost:*', 'https://localhost:*'],
  ])('normalizes %s -> %s', (raw, expected) => {
    expect(normalizeOriginPattern(raw)).toBe(expected);
  });

  it('punycodes an IDN suffix with the same IDNA algorithm as normalizeOrigin', () => {
    // normalizeOrigin() converts an exact origin host to punycode via WHATWG
    // URL, and a browser only ever sends the ASCII serialization in `Origin`.
    // A pattern must therefore be punycoded too, or a legitimate IDN subdomain
    // would silently fail to match.
    expect(normalizeOriginPattern('https://*.ärger.de:*')).toBe('https://*.xn--rger-koa.de:*');
    // already-punycoded input is idempotent
    expect(normalizeOriginPattern('https://*.xn--rger-koa.de:*')).toBe('https://*.xn--rger-koa.de:*');
  });

  it('output of normalizeOriginPattern is always classified as a pattern', () => {
    for (const raw of ['https://*.bcmch.org:*', 'http://localhost:*', 'https://*.4bits.vn:4433']) {
      expect(isOriginPattern(normalizeOriginPattern(raw))).toBe(true);
    }
  });
});

describe('normalizeOriginPattern — rejects (security floors)', () => {
  const rejects = (label: string, cases: string[]) => {
    describe(label, () => {
      it.each(cases)('rejects %s', (raw) => {
        expect(() => normalizeOriginPattern(raw)).toThrow(ArgumentInvalidException);
      });
    });
  };

  // FLOOR 1 — `*` only as the leftmost host label, and it must be followed by `.`
  // (`'*'` alone is the allow-all token — covered in its own describe block.)
  rejects('wildcard placement', [
    '*.',
    'ht*ps://x',
    'https://*',
    'https://*.',
    'https://*:*',
    'https://a.*.b:*',
    'https://*b.example.com:*',
    'https://**.example.com:*',
    'https://*.*.com:*',
    'https://x.*:*',
    'https://*.bcmch.*:*',
    'https://*.bcmch.org*:*',
    'https://sub.*.bcmch.org:*',
  ]);

  // FLOOR 2 — the `*.` suffix must carry >= 2 labels
  rejects('suffix shorter than 2 labels', [
    'https://*.vn:*',
    'https://*.com:*',
    'https://*.org:*',
    'https://*.dev:*',
    'https://*.localhost:*',
    'https://*.localhost:5173',
  ]);

  // FLOOR 2b — >= 2 labels is necessary but NOT sufficient: `co.uk` is two
  // labels AND a public suffix. Rejected by a documented, deliberately PARTIAL
  // heuristic (see origin-pattern.ts) — the complete fix needs a public-suffix
  // list. Everything here must stay rejected.
  rejects('two-label public suffixes', [
    'https://*.co.uk:*',
    'https://*.org.uk:*',
    'https://*.ac.uk:*',
    'https://*.com.au:*',
    'https://*.co.jp:*',
    'https://*.com.br:*',
    'https://*.co.in:*',
    'https://*.com.vn:*',
    'https://*.co.za:*',
    // shared-hosting suffixes: a wildcard here delegates trust to every
    // customer of that platform
    'https://*.github.io:*',
    'https://*.vercel.app:*',
    'https://*.pages.dev:*',
  ]);

  // FLOOR 3 — scheme must be http/https, and http only for loopback
  rejects('scheme', [
    'http://*.bcmch.org:*',
    'http://*.taphuynh.dev:4433',
    'http://example.com:*',
    'ftp://*.bcmch.org:*',
    'ws://*.bcmch.org:*',
    'wss://*.bcmch.org:*',
    'file://*.bcmch.org:*',
    'data:*',
    '//*.bcmch.org:*',
    '*.bcmch.org:*',
  ]);

  // FLOOR 4 — the port segment is mandatory and is either `*` or plain digits
  rejects('port', [
    'https://*.bcmch.org', // missing the mandatory port segment
    'https://*.bcmch.org:', // empty port
    'https://*.bcmch.org:abc',
    'https://*.bcmch.org:44*33',
    'https://*.bcmch.org:*4433',
    'https://*.bcmch.org:4433*',
    'https://*.bcmch.org:**',
    'https://*.bcmch.org:0',
    'https://*.bcmch.org:65536',
    'https://*.bcmch.org:99999',
    'https://*.bcmch.org:04433', // leading zero => two spellings of one port
    'https://*.bcmch.org:-1',
    'https://*.bcmch.org:4433:4433',
  ]);

  // FLOOR 5 — no path, query, fragment, userinfo or trailing slash
  rejects('path / query / fragment / userinfo', [
    'https://*.bcmch.org:*/',
    'https://*.bcmch.org:*/path',
    'https://*.bcmch.org:*?q=1',
    'https://*.bcmch.org:*#frag',
    'https://user:pw@*.bcmch.org:*',
    'https://user@*.bcmch.org:*',
    'https://*.bcmch.org:*\\evil.com',
  ]);

  // A `*`-free value is an EXACT origin; it belongs to normalizeOrigin. Keeping
  // it out preserves the invariant isOriginPattern(normalizeOriginPattern(x)).
  // The grammar's `<host>` + `<digits>` combination degenerates to an exact
  // origin. Routing it back to normalizeOrigin keeps ONE writer per form and
  // preserves the invariant isOriginPattern(normalizeOriginPattern(x)).
  rejects('values with no wildcard at all', [
    'https://arcaai-u2204.bcmch.org',
    'https://arcaai-u2204.bcmch.org:443',
    'http://localhost:5173',
    'http://localhost:5173/',
  ]);

  rejects('malformed hosts', [
    '',
    '   ',
    'https://*. bcmch.org:*',
    'https://*.bcmch..org:*',
    'https://*.-bad.org:*',
    'https://*.bad-.org:*',
    'https://*.bcmch.org.:*', // trailing-dot FQDN
    'https://*.bcmch_org.com:*',
    'https://*.bcmch.org\n:*',
    'https://*.bcmch.org\t:*',
    'https://*.bcmch.org :*',
    'https://*.1.2.3.4:*', // all-numeric TLD label (IPv4-ish)
    'https://*.bcmch.org%2eevil.com:*',
    `https://*.${'a'.repeat(300)}.org:*`,
    `https://*.${'a'.repeat(64)}.bcmch.org:*`, // label > 63 chars
  ]);

  it('rejects non-string input', () => {
    for (const hostile of [null, undefined, 42, {}, [], true]) {
      expect(() => normalizeOriginPattern(hostile as unknown as string)).toThrow(ArgumentInvalidException);
    }
  });
});

describe("matchesOriginPattern — owner's acceptance table", () => {
  it.each([
    // ---- https://*.bcmch.org:* -------------------------------------------
    ['https://*.bcmch.org:*', 'https://arcaai-u2204.bcmch.org', true],
    ['https://*.bcmch.org:*', 'https://arcaai-staging.bcmch.org', true],
    ['https://*.bcmch.org:*', 'https://mi-preproduction.bcmch.org:4433', true],
    ['https://*.bcmch.org:*', 'https://a.b.bcmch.org', true],
    ['https://*.bcmch.org:*', 'https://bcmch.org', false], // apex
    ['https://*.bcmch.org:*', 'https://evilbcmch.org', false], // no label boundary
    ['https://*.bcmch.org:*', 'http://x.bcmch.org', false], // scheme differs
    ['https://*.bcmch.org:*', 'https://bcmch.org.evil.com', false], // suffix not at the end
    // ---- http://localhost:* ----------------------------------------------
    ['http://localhost:*', 'http://localhost:5173', true],
    ['http://localhost:*', 'http://localhost', true], // default/absent port
    ['http://localhost:*', 'http://localhost:9999', true],
    ['http://localhost:*', 'http://localhost.evil.com', false],
    // Frozen rule "Scheme must match exactly" implies https://localhost is a
    // DIFFERENT origin and is not covered by an http pattern.
    ['http://localhost:*', 'https://localhost', false],
    ['http://localhost:*', 'http://sub.localhost:5173', false], // no wildcard => exact host
    // ---- https://*.taphuynh.dev:* ----------------------------------------
    ['https://*.taphuynh.dev:*', 'https://mail.taphuynh.dev', true],
    ['https://*.taphuynh.dev:*', 'https://a.b.c.taphuynh.dev:8443', true],
    ['https://*.taphuynh.dev:*', 'https://taphuynh.dev', false],
    ['https://*.taphuynh.dev:*', 'https://eviltaphuynh.dev', false],
    ['https://*.taphuynh.dev:*', 'https://taphuynh.dev.evil.com', false],
    // ---- https://*.4bits.vn:* --------------------------------------------
    ['https://*.4bits.vn:*', 'https://app.4bits.vn', true],
    ['https://*.4bits.vn:*', 'https://app.4bits.vn:4433', true],
    ['https://*.4bits.vn:*', 'https://4bits.vn', false],
    ['https://*.4bits.vn:*', 'https://my4bits.vn', false],
    ['https://*.4bits.vn:*', 'https://4bits.vn.evil.com', false],
  ])('%s vs %s -> %s', (pattern, origin, expected) => {
    expect(matchesOriginPattern(pattern, origin)).toBe(expected);
  });
});

describe('matchesOriginPattern — port rules', () => {
  it.each([
    // `*` matches any port, including default/absent
    ['https://*.bcmch.org:*', 'https://x.bcmch.org', true],
    ['https://*.bcmch.org:*', 'https://x.bcmch.org:443', true],
    ['https://*.bcmch.org:*', 'https://x.bcmch.org:1', true],
    ['https://*.bcmch.org:*', 'https://x.bcmch.org:65535', true],
    // a numeric port must match exactly
    ['https://*.bcmch.org:4433', 'https://x.bcmch.org:4433', true],
    ['https://*.bcmch.org:4433', 'https://x.bcmch.org:4434', false],
    ['https://*.bcmch.org:4433', 'https://x.bcmch.org', false],
    // an absent port on the origin means the scheme default, so a pattern
    // pinned to :443 still matches the canonical (port-stripped) https origin
    ['https://*.bcmch.org:443', 'https://x.bcmch.org', true],
    ['https://*.bcmch.org:443', 'https://x.bcmch.org:443', true],
    ['https://*.bcmch.org:443', 'https://x.bcmch.org:4433', false],
    ['http://localhost:80', 'http://localhost', true],
    ['http://localhost:80', 'http://localhost:8080', false],
  ])('%s vs %s -> %s', (pattern, origin, expected) => {
    expect(matchesOriginPattern(pattern, origin)).toBe(expected);
  });
});

describe('matchesOriginPattern — case and IDN', () => {
  it('is case-insensitive on scheme and host', () => {
    expect(matchesOriginPattern('HTTPS://*.BCMCH.ORG:*', 'HTTPS://SUB.BCMCH.ORG')).toBe(true);
  });

  it('matches an IDN subdomain through punycode on both sides', () => {
    // The pattern is punycoded at parse time; the browser always sends the
    // ASCII serialization, so both sides meet in punycode space.
    expect(matchesOriginPattern('https://*.ärger.de:*', 'https://sub.xn--rger-koa.de')).toBe(true);
    expect(matchesOriginPattern('https://*.xn--rger-koa.de:*', 'https://sub.xn--rger-koa.de')).toBe(true);
  });

  it('does NOT match a non-ASCII origin (browsers never send one)', () => {
    // Fail closed: a raw unicode host in the `Origin` header is not a browser,
    // and running it through WHATWG URL here would also strip tabs/newlines.
    expect(matchesOriginPattern('https://*.xn--rger-koa.de:*', 'https://sub.ärger.de')).toBe(false);
  });
});

describe('matchesOriginPattern — hostile input never throws', () => {
  const hostilePatterns = ['https://*.bcmch.org:*', 'not a pattern', '', 'https://*', '*', 'https://*.co.uk:*'];

  const hostileOrigins = [
    '',
    '   ',
    'null',
    'null ',
    '*',
    'https://*.bcmch.org',
    'https://sub.bcmch.org\t',
    'https://sub.bcmch.org\n',
    'https://sub.bcmch.org/',
    'https://sub.bcmch.org/../',
    'https://sub.bcmch.org?x=1',
    'https://sub.bcmch.org#f',
    'https://user@sub.bcmch.org',
    'https://sub.bcmch.org.',
    'https://sub.bcmch.org%2e',
    'https://sub.bcmch.org:99999999',
    'https://sub.bcmch.org:-1',
    'https://sub.bcmch.org:',
    'https://[::1',
    'javascript:alert(1)',
    'https://sub.bcmch.org:443:443',
    `https://${'a'.repeat(5000)}.bcmch.org`,
    `https://${'a.'.repeat(2000)}bcmch.org`,
  ];

  it.each(hostileOrigins)('returns a boolean for origin %s', (origin) => {
    for (const pattern of hostilePatterns) {
      const result = matchesOriginPattern(pattern, origin);
      expect(typeof result).toBe('boolean');
    }
  });

  it('returns false (never throws) for non-string arguments', () => {
    for (const hostile of [null, undefined, 42, {}, [], true]) {
      expect(matchesOriginPattern('https://*.bcmch.org:*', hostile as unknown as string)).toBe(false);
      expect(matchesOriginPattern(hostile as unknown as string, 'https://x.bcmch.org')).toBe(false);
    }
  });

  it('an origin that is itself a pattern never matches', () => {
    // Defence in depth: if a `*` ever reached the Origin header path, it must
    // not be able to satisfy a pattern.
    expect(matchesOriginPattern('https://*.bcmch.org:*', 'https://*.bcmch.org')).toBe(false);
    expect(matchesOriginPattern('https://*.bcmch.org:*', 'https://*.bcmch.org:*')).toBe(false);
  });

  it('an invalid pattern matches nothing', () => {
    expect(matchesOriginPattern('https://*.com:*', 'https://evil.com')).toBe(false);
    expect(matchesOriginPattern('https://**.bcmch.org:*', 'https://sub.bcmch.org')).toBe(false);
    expect(matchesOriginPattern('http://*.bcmch.org:*', 'http://sub.bcmch.org')).toBe(false);
  });
});

describe('patternSpecificity', () => {
  it('ranks a longer suffix above a shorter one (frozen precedence rule)', () => {
    expect(patternSpecificity('https://*.a.b.bcmch.org:*')).toBeGreaterThan(patternSpecificity('https://*.bcmch.org:*'));
    expect(patternSpecificity('https://*.staging.taphuynh.dev:*')).toBeGreaterThan(patternSpecificity('https://*.taphuynh.dev:*'));
  });

  it('ranks an exact host above a wildcard carrying the same host text', () => {
    // `https://localhost.io:*` names exactly one host; `https://*.localhost.io:*`
    // names every subdomain of it. Same matched text, strictly more specific.
    expect(patternSpecificity('https://localhost.io:*')).toBeGreaterThan(patternSpecificity('https://*.localhost.io:*'));
  });

  it('ranks a pinned port above a wildcard port for the same host pattern', () => {
    expect(patternSpecificity('https://*.bcmch.org:4433')).toBeGreaterThan(patternSpecificity('https://*.bcmch.org:*'));
  });

  it('host specificity dominates the port tie-breaker', () => {
    // A longer suffix with a wildcard port must still beat a shorter suffix
    // with a pinned port — otherwise precedence would not be "longest suffix
    // wins".
    expect(patternSpecificity('https://*.a.bcmch.org:*')).toBeGreaterThan(patternSpecificity('https://*.bcmch.org:4433'));
  });

  it('is stable (equal) for two spellings of the same pattern', () => {
    expect(patternSpecificity('HTTPS://*.BCMCH.ORG:*')).toBe(patternSpecificity('https://*.bcmch.org:*'));
  });

  it('scores an unparseable value 0 and never throws', () => {
    for (const hostile of ['', 'nonsense', 'https://*.com:*', 'https://**.x.org:*', null, 42, {}]) {
      expect(patternSpecificity(hostile as unknown as string)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Owner scope addition — the allow-all token `*` (Global tenant, all envs).
// ---------------------------------------------------------------------------

describe('ALLOW_ALL_ORIGIN_PATTERN', () => {
  it('is the bare single-character token', () => {
    expect(ALLOW_ALL_ORIGIN_PATTERN).toBe('*');
  });

  it('is classified as a pattern and canonicalizes to itself', () => {
    expect(isOriginPattern(ALLOW_ALL_ORIGIN_PATTERN)).toBe(true);
    expect(normalizeOriginPattern('*')).toBe(ALLOW_ALL_ORIGIN_PATTERN);
  });

  it.each([
    'https://arcaai-u2204.bcmch.org',
    'https://random.example.com',
    'https://random.example.com:8443',
    'http://localhost:5173',
    'https://a.b.c.d.example.co.uk',
    'http://127.0.0.1:9999',
    'http://[::1]:3000',
    // NOTE: `*` is a blanket. It also admits an origin that normalizeOrigin
    // would refuse to REGISTER (plain http on a non-loopback host). That is
    // what "any origin" means; it is the token's declared danger, not a leak
    // in the matcher.
    'http://plain-http.example.com',
  ])('matches every syntactically valid origin: %s', (origin) => {
    expect(matchesOriginPattern('*', origin)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'null',
    '*',
    'https://*.bcmch.org',
    'javascript:alert(1)',
    'ftp://example.com',
    'https://sub.bcmch.org/path',
    'https://sub.bcmch.org\t',
    'https://user@sub.bcmch.org',
    'https://sub.bcmch.org:99999999',
  ])('still refuses a syntactically INVALID origin: %s', (origin) => {
    expect(matchesOriginPattern('*', origin)).toBe(false);
  });

  it('never throws for hostile / non-string origins', () => {
    for (const hostile of [null, undefined, 42, {}, [], true]) {
      expect(matchesOriginPattern('*', hostile as unknown as string)).toBe(false);
    }
  });
});

describe('ALLOW_ALL_ORIGIN_PATTERN — near-misses must never become allow-all', () => {
  it.each([
    '*.',
    '**',
    '***',
    '* ',
    ' *',
    '\t*',
    '*\n',
    '"*"',
    "'*'",
    '*:*',
    '*://*',
    '*.*',
    '*/*',
    'https://*',
    'https://*:*',
    '://*',
    '*.*.*',
    '%2a',
    '＊', // U+FF0E-style fullwidth asterisk look-alike (U+FF0A)
  ])('rejects %s', (raw) => {
    expect(() => normalizeOriginPattern(raw)).toThrow(ArgumentInvalidException);
  });

  it('does not let the `*.` wildcard branch fall through to allow-all', () => {
    // `*.com` fails the >=2-label floor. It must THROW, not silently degrade
    // into the allow-all token.
    expect(() => normalizeOriginPattern('https://*.com:*')).toThrow(ArgumentInvalidException);
    expect(matchesOriginPattern('https://*.com:*', 'https://evil.com')).toBe(false);
    expect(matchesOriginPattern('*.', 'https://evil.com')).toBe(false);
    expect(matchesOriginPattern('**', 'https://evil.com')).toBe(false);
  });
});

describe('precedence — the allow-all token must rank strictly lowest', () => {
  // Why this is load-bearing: the registry resolves an origin to its OWNING
  // tenant, and ownership is the isolation control. If `*` (owned by Global)
  // ever outranked a more specific pattern, an ArcaAI origin would resolve to
  // Global and the binding guard would 404 legitimate ArcaAI traffic.
  const everyOtherPattern = [
    'https://*.bcmch.org:*',
    'https://*.taphuynh.dev:*',
    'https://*.4bits.vn:*',
    'http://localhost:*',
    'https://*.a.b.bcmch.org:4433',
    'https://a.io:*',
  ];

  it.each(everyOtherPattern)('%s outranks the allow-all token', (pattern) => {
    expect(patternSpecificity(pattern)).toBeGreaterThan(patternSpecificity(ALLOW_ALL_ORIGIN_PATTERN));
  });

  it('still ranks above an unparseable value, which ranks nothing', () => {
    expect(patternSpecificity(ALLOW_ALL_ORIGIN_PATTERN)).toBeGreaterThan(patternSpecificity('https://**.nonsense:*'));
  });

  // The owner's three-row resolution table.
  it('row 1 — an exact origin is not a pattern at all, so the registry can prefer it', () => {
    // "exact row beats every pattern" is enforced by the registry (lane W5-B)
    // looking up exact rows first; this module's contribution is that an exact
    // origin is never classified as a pattern.
    expect(isOriginPattern('https://arcaai-u2204.bcmch.org')).toBe(false);
    // ...while both patterns below would otherwise have matched it.
    expect(matchesOriginPattern('https://*.bcmch.org:*', 'https://arcaai-u2204.bcmch.org')).toBe(true);
    expect(matchesOriginPattern('*', 'https://arcaai-u2204.bcmch.org')).toBe(true);
  });

  it('row 2 — a subdomain matches both, and the specific pattern wins', () => {
    const origin = 'https://anything.bcmch.org';
    expect(matchesOriginPattern('https://*.bcmch.org:*', origin)).toBe(true);
    expect(matchesOriginPattern('*', origin)).toBe(true);
    expect(patternSpecificity('https://*.bcmch.org:*')).toBeGreaterThan(patternSpecificity(ALLOW_ALL_ORIGIN_PATTERN));
  });

  it('row 3 — an unrelated origin matches only the allow-all token', () => {
    const origin = 'https://random.example.com';
    expect(matchesOriginPattern('https://*.bcmch.org:*', origin)).toBe(false);
    expect(matchesOriginPattern('https://*.taphuynh.dev:*', origin)).toBe(false);
    expect(matchesOriginPattern('https://*.4bits.vn:*', origin)).toBe(false);
    expect(matchesOriginPattern('http://localhost:*', origin)).toBe(false);
    expect(matchesOriginPattern('*', origin)).toBe(true);
  });
});
