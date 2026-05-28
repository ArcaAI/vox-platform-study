import { describe, expect, it } from 'vitest';

import { getCorsOrigins } from '../cors.config';

/**
 * TASK-310 E-2 (AC-4) — dev CORS pins to a localhost-only RegExp.
 *
 * Pre-W7 the dev branch of `getCorsOrigins` returned `true`, which
 * combined with `credentials: true` is a config the browser rejects
 * anyway (cookies + wildcard is illegal). The intent was always
 * "localhost only in dev"; this AC pins that intent as code.
 *
 * Production / staging CORS callback paths are untouched — only the
 * dev value changes from `true` to the RegExp.
 */
describe('getCorsOrigins (TASK-310 E-2 / AC-4)', () => {
  describe('development', () => {
    it('returns the exact AC-4 localhost-only RegExp', () => {
      const origin = getCorsOrigins('development');

      expect(origin).toBeInstanceOf(RegExp);
      expect((origin as RegExp).source).toBe('^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?$');
    });

    it.each([
      ['http://localhost', true],
      ['http://localhost:3000', true],
      ['https://localhost', true],
      ['https://localhost:8868', true],
      ['http://127.0.0.1', true],
      ['http://127.0.0.1:5173', true],
      ['https://127.0.0.1:5174', true],
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
