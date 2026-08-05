import { describe, expect, it } from 'vitest';

import { getCorsOrigins } from '../cors.config';

/**
 * Dev CORS pins to a localhost-only RegExp.
 *
 * The dev branch of `getCorsOrigins` must NOT return `true`: combined
 * with `credentials: true` that's a config the browser rejects anyway
 * (cookies + wildcard is illegal), so the intent is "localhost only in
 * dev" and this test pins that intent as code.
 */
describe('getCorsOrigins', () => {
  describe('development', () => {
    it('returns the localhost + compat-playground allowlist RegExp', () => {
      const origin = getCorsOrigins('development');

      expect(origin).toBeInstanceOf(RegExp);
      expect((origin as RegExp).source).toBe(
        '^(?:https?:\\/\\/(?:localhost|127\\.0\\.0\\.1)(?::\\d+)?|https:\\/\\/compat-playground\\.taphuynh\\.dev)$',
      );
    });

    it.each([
      ['http://localhost', true],
      ['http://localhost:3000', true],
      ['https://localhost', true],
      ['https://localhost:8868', true],
      ['http://127.0.0.1', true],
      ['http://127.0.0.1:5173', true],
      ['https://127.0.0.1:5174', true],
      // The explicitly allowed compatibility playground (https only).
      ['https://compat-playground.taphuynh.dev', true],
    ])('matches %s -> %s', (candidate, expected) => {
      const origin = getCorsOrigins('development') as RegExp;
      expect(origin.test(candidate)).toBe(expected);
    });

    it.each([
      ['http://evil.com'],
      ['https://app.arcaai.com'],
      ['http://localhost.evil.com'],
      ['http://127.0.0.1.evil.com'],
      ['http://0.0.0.0'],
      ['ftp://localhost:8080'],
      ['ws://localhost:3000'],
      ['file:///etc/passwd'],
    ])('rejects %s', (candidate) => {
      const origin = getCorsOrigins('development') as RegExp;
      expect(origin.test(candidate)).toBe(false);
    });
  });

  describe('production', () => {
    it('returns a callback function (unchanged behaviour)', () => {
      const origin = getCorsOrigins('production');
      expect(typeof origin).toBe('function');
    });
  });

  describe('staging', () => {
    it('returns a callback function (unchanged behaviour)', () => {
      const origin = getCorsOrigins('staging');
      expect(typeof origin).toBe('function');
    });
  });
});
