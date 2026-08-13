/**
 * T-6 (D-5) — the two header lists the SDK's OCC round trip
 * depends on.
 *
 * Both defects were invisible from the server's side: the routes, the guard and
 * `ETagInterceptor` were all correct, and every same-origin test passed. Only a
 * CROSS-ORIGIN browser call failed, and it failed in the preflight — before any
 * gateway code ran — so nothing in the API's own suite could see it.
 *
 * These assertions are deliberately about MEMBERSHIP, not the exact array: the
 * list is appended to routinely, and pinning its full contents would make every
 * unrelated header addition a test failure (the mistake `cors.config.test.ts`
 * made by pinning a RegExp source, which is why it went red in `7703e40f`).
 */
import { describe, expect, it } from 'vitest';

import { CORS_ALLOWED_HEADERS, CORS_EXPOSED_HEADERS } from '../cors.headers';

/** RFC 7230: field names are case-insensitive, so compare case-folded. */
const includesHeader = (list: readonly string[], name: string): boolean =>
  list.some((h) => h.toLowerCase() === name.toLowerCase());

describe('CORS header lists', () => {
  describe('D-4 — allowed request headers', () => {
    it('permits If-Match, without which every versioned PATCH fails preflight', () => {
      expect(includesHeader(CORS_ALLOWED_HEADERS, 'If-Match')).toBe(true);
    });

    it.each(['Authorization', 'Content-Type', 'X-API-Key', 'X-Tenant-Id'])('still permits %s', (header) => {
      expect(includesHeader(CORS_ALLOWED_HEADERS, header)).toBe(true);
    });

    it('does not use a wildcard, which is illegal alongside credentials: true', () => {
      expect(CORS_ALLOWED_HEADERS).not.toContain('*');
    });
  });

  describe('D-5 — exposed response headers', () => {
    it('exposes ETag, without which getWithEtag reads undefined and the PATCH 428s', () => {
      expect(includesHeader(CORS_EXPOSED_HEADERS, 'ETag')).toBe(true);
    });

    it('does not use a wildcard, which is illegal alongside credentials: true', () => {
      expect(CORS_EXPOSED_HEADERS).not.toContain('*');
    });
  });
});
