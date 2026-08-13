// OriginNormalizer tests (T-1).
//
// Written FIRST per `01-development-workflow.md` TDD gate: this file must be
// run and observed RED against the frozen contract stub
// (`../origin-normalizer.ts`, which throws `new Error('not implemented —
// W1-A')` for every call) before any implementation code is written.

import { ArgumentInvalidException } from '@arcaai/exceptions';
import { describe, expect, it } from 'vitest';
import { isLoopbackHost, normalizeOrigin } from '../origin-normalizer';

describe('normalizeOrigin', () => {
  describe('accepts', () => {
    it.each([
      // [raw, expected origin, expected scheme, expected host, expected port]
      ['http://localhost:5173', 'http://localhost:5173', 'http', 'localhost', 5173],
      ['https://arcaai-u2204.bcmch.org', 'https://arcaai-u2204.bcmch.org', 'https', 'arcaai-u2204.bcmch.org', null],
      [
        'https://arcaai-staging.bcmch.org',
        'https://arcaai-staging.bcmch.org',
        'https',
        'arcaai-staging.bcmch.org',
        null,
      ],
      [
        'https://mi-preproduction.bcmch.org:4433',
        'https://mi-preproduction.bcmch.org:4433',
        'https',
        'mi-preproduction.bcmch.org',
        4433,
      ],
      // default https port stripped
      ['https://x.org:443', 'https://x.org', 'https', 'x.org', null],
      // default http port stripped (loopback, so http is allowed)
      ['http://127.0.0.1:80', 'http://127.0.0.1', 'http', '127.0.0.1', null],
      // scheme + host lowercased
      ['HTTPS://X.ORG', 'https://x.org', 'https', 'x.org', null],
      // bare trailing slash is treated as "no path"
      ['https://x.org/', 'https://x.org', 'https', 'x.org', null],
      // non-default port on loopback survives verbatim
      ['http://127.0.0.1:5173', 'http://127.0.0.1:5173', 'http', '127.0.0.1', 5173],
      // IPv6 loopback, non-default port
      ['http://[::1]:3000', 'http://[::1]:3000', 'http', '[::1]', 3000],
      // ── Browser-extension schemes  — exact `<scheme>://<id>` ──────
      // Chrome/Edge/Brave id ([a-p]{32}). No port, single opaque label.
      [
        'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        'chrome-extension',
        'abcdefghijklmnopabcdefghijklmnop',
        null,
      ],
      // Firefox per-install UUID.
      [
        'moz-extension://a279f5e6-1b2c-4d3e-8f90-1234567890ab',
        'moz-extension://a279f5e6-1b2c-4d3e-8f90-1234567890ab',
        'moz-extension',
        'a279f5e6-1b2c-4d3e-8f90-1234567890ab',
        null,
      ],
      // Safari sends an UPPERCASE UUID — canonicalized lowercased so the store
      // and lookup sides always agree.
      [
        'safari-web-extension://A1B2C3D4-1234-5678-9ABC-DEF012345678',
        'safari-web-extension://a1b2c3d4-1234-5678-9abc-def012345678',
        'safari-web-extension',
        'a1b2c3d4-1234-5678-9abc-def012345678',
        null,
      ],
    ])('normalizes %s', (raw, expectedOrigin, expectedScheme, expectedHost, expectedPort) => {
      const result = normalizeOrigin(raw);
      expect(result).toEqual({
        origin: expectedOrigin,
        scheme: expectedScheme,
        host: expectedHost,
        port: expectedPort,
      });
    });

    it('normalizes an IDN homograph host to its punycode (ASCII) form', () => {
      // Cyrillic 'а' (U+0430) look-alike for Latin 'a' in "arcaai".
      const raw = 'https://аrcaai.com';
      const result = normalizeOrigin(raw);
      // WHATWG URL's built-in IDNA/punycode conversion is authoritative here:
      // it is exactly what a browser serializes into the `Origin` header for
      // a non-ASCII host, so normalizing (not rejecting) keeps this function
      // aligned with what will actually arrive on the wire. Homograph *policy*
      // (should this domain be allowed to register at all) is a registration
      // concern, not an origin-syntax concern — out of scope here.
      expect(result.host).toBe('xn--rcaai-3ve.com');
      expect(result.origin).toBe('https://xn--rcaai-3ve.com');
      expect(result.scheme).toBe('https');
      expect(result.port).toBeNull();
    });
  });

  describe('rejects', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['unparseable garbage', 'not a url'],
      ['ftp scheme', 'ftp://x.org'],
      ['ws scheme', 'ws://x.org'],
      ['wss scheme', 'wss://x.org'],
      ['file scheme', 'file:///etc/passwd'],
      ['data scheme', 'data:text/plain;base64,SGVsbG8='],
      ['javascript scheme', 'javascript:alert(1)'],
      ['path present', 'https://x.org/foo'],
      ['query present', 'https://x.org?a=1'],
      ['fragment present', 'https://x.org#frag'],
      ['userinfo present', 'https://user:pass@x.org'],
      ['bare wildcard', '*'],
      ['scheme + bare wildcard host', 'https://*'],
      ['wildcard subdomain', 'https://*.x.org'],
      ['plain http on a non-loopback host', 'http://x.org'],
      ['plain http on a non-loopback host with port', 'http://x.org:8080'],
      // known substring-matching bypass attempts (also exercised against
      // isLoopbackHost below) — these must NOT be treated as loopback.
      ['http on localhost-lookalike domain', 'http://localhost.evil.com'],
      ['http on 127.0.0.1-lookalike domain', 'http://127.0.0.1.evil.com'],
      // ── Browser-extension schemes  — malformed exact ids ─────────
      // A port is forbidden on an extension origin (browsers never send one).
      ['extension origin with a port', 'chrome-extension://abcdef:80'],
      // Empty host — `<scheme>://` alone.
      ['extension origin with an empty host', 'chrome-extension://'],
      // A path is a real path here, not "no path".
      ['extension origin with a path', 'chrome-extension://abcdef/popup.html'],
      // The id must be a SINGLE opaque label — a dot splits it into two.
      ['extension id containing a dot', 'chrome-extension://abc.def'],
      // Non-LDH characters in the id.
      ['extension id with an underscore', 'chrome-extension://ab_cd'],
      // The wildcard form is a PATTERN (normalizeOriginPattern), never an exact origin.
      ['extension wildcard is not an exact origin', 'chrome-extension://*'],
    ])('rejects %s (%s)', (_label, raw) => {
      expect(() => normalizeOrigin(raw)).toThrow(ArgumentInvalidException);
    });
  });
});

describe('isLoopbackHost', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['127.0.0.1', true],
    ['127.0.0.1'.toUpperCase(), true],
    ['127.5.6.7', true],
    ['127.255.255.255', true],
    ['::1', true],
    ['[::1]', true],
  ])('%s -> %s (loopback)', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });

  it.each([
    ['localhost.evil.com', false],
    ['127.0.0.1.evil.com', false],
    ['evil-localhost', false],
    ['example.com', false],
    ['128.0.0.1', false],
    ['126.255.255.255', false],
    ['0.0.0.0', false],
  ])('%s -> %s (not loopback)', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});
