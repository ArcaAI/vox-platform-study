/**
 * `prisma.config.ts` MUST prefer `DIRECT_URL` over `DATABASE_URL` for
 * Prisma Migrate operations. In production, `DATABASE_URL` points at
 * the pgbouncer pool (port 6432, transaction mode) and Prisma Migrate's
 * advisory locks do not survive backend swaps — migrations must use a
 * direct connection.
 *
 * The selection logic lives in `src/migration-url.ts` as a pure
 * function so it can be unit-tested. `prisma.config.ts` re-exports the
 * decision into its `defineConfig({ datasource: { url } })` call.
 */

import { describe, expect, it } from 'vitest';

import { resolveMigrationUrl } from '../migration-url.js';

const POOLED = 'postgresql://hope_app:****@pgbouncer-vip:6432/hope?sslmode=require&schema=core';
const DIRECT = 'postgresql://hope_app:****@pg-primary-vip:5000/hope?sslmode=require&schema=core';

describe('resolveMigrationUrl — DATABASE_URL / DIRECT_URL routing (Task 2A.3.2)', () => {
  it('when DIRECT_URL is set, returns DIRECT_URL (bypasses pgbouncer)', () => {
    expect(resolveMigrationUrl({ DATABASE_URL: POOLED, DIRECT_URL: DIRECT })).toBe(DIRECT);
  });

  it('when DIRECT_URL is unset, returns DATABASE_URL (back-compat for dev)', () => {
    expect(resolveMigrationUrl({ DATABASE_URL: POOLED })).toBe(POOLED);
  });

  it('when both URLs are unset, throws an error that mentions both', () => {
    expect(() => resolveMigrationUrl({})).toThrowError(/DATABASE_URL.*or.*DIRECT_URL/i);
  });

  it('when DIRECT_URL is the empty string, falls back to DATABASE_URL', () => {
    // Empty-string env vars are a common docker-compose pitfall — Prisma
    // Migrate should not try to use "" as a connection string.
    expect(resolveMigrationUrl({ DATABASE_URL: POOLED, DIRECT_URL: '' })).toBe(POOLED);
  });

  it('when both are empty, throws (does not silently produce undefined)', () => {
    expect(() => resolveMigrationUrl({ DATABASE_URL: '', DIRECT_URL: '' })).toThrowError(
      /DATABASE_URL.*or.*DIRECT_URL/i,
    );
  });

  it('when DIRECT_URL targets the pooler port (6432), emits a console warning', () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
    try {
      const suspect = 'postgresql://hope_app:****@pgbouncer-vip:6432/hope?sslmode=require';
      const result = resolveMigrationUrl({ DATABASE_URL: POOLED, DIRECT_URL: suspect });
      expect(result).toBe(suspect);
      expect(warnings.some((w) => /DIRECT_URL.*pooler|pooler.*DIRECT_URL/i.test(w))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('when DIRECT_URL targets port 5432 (direct), does NOT warn', () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
    try {
      resolveMigrationUrl({ DATABASE_URL: POOLED, DIRECT_URL: DIRECT });
      expect(warnings).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }
  });
});
