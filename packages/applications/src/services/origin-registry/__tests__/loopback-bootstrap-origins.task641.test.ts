/**
 * TASK-641 lane G — the six SYSTEM loopback rows are canonical, and cover what
 * the deleted `development_loopback` branch covered.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM
 * `tenant-allowed-origin/__tests__/seed-origin-canonicalization.task610.test.ts`
 * (which mirrors the WHOLE seed list by hand): these six strings are now also
 * hard-coded a THIRD time, in
 * `packages/database/src/prisma/db_main/migrations/20260808160000_task_641_bootstrap_loopback_origins/migration.sql`.
 * That migration is what guarantees the rows exist in an environment that never
 * runs the seed (H-2), and SQL cannot call the normalizer at all. A
 * non-canonical string there would sit in the row unchanged and then silently
 * never match anything at CORS-decision time — the registry only ever compares
 * against `normalizeOriginPattern` OUTPUT, never the stored text. This file is
 * the mechanical check that the migration's six literals are the canonical
 * forms, and that they actually admit the origins a local browser sends.
 *
 * The parity claim being pinned: the branch TASK-641 B-7 deleted from
 * `cors.config.ts` called `isLoopbackHost()`, which admits
 * `localhost` ∪ `127.0.0.0/8` ∪ `::1` on EITHER scheme. Two http rows were
 * narrower than that. Six rows close the gap for the three canonical loopback
 * spellings; `127.0.0.2`-`127.0.0.255` remain out of reach of the grammar and
 * are pinned as a KNOWN gap below rather than left to be rediscovered.
 */
import { describe, expect, it } from 'vitest';

import { matchesOriginPattern, normalizeOriginPattern } from '../origin-pattern';

/**
 * Verbatim copy of the `origin` column of the six SYSTEM rows in
 * `20260808160000_task_641_bootstrap_loopback_origins/migration.sql`, which are
 * in turn byte-identical to the six SYSTEM rows of
 * `seed/11b-tenant-allowed-origins.ts`. Keep all three in lockstep by hand —
 * that duplication is the point (SQL and `packages/database` can neither of
 * them import this module).
 */
const BOOTSTRAP_LOOPBACK_PATTERNS = [
  'http://localhost:*',
  'http://127.0.0.1:*',
  'https://localhost:*',
  'https://127.0.0.1:*',
  'http://[::1]:*',
  'https://[::1]:*',
] as const;

describe('TASK-641 bootstrap loopback origins are already canonical', () => {
  it.each(BOOTSTRAP_LOOPBACK_PATTERNS)('%s round-trips unchanged through normalizeOriginPattern', (pattern) => {
    expect(normalizeOriginPattern(pattern)).toBe(pattern);
  });

  it('accepts plain http for all three loopback hosts — the ONLY hosts the grammar exempts', () => {
    // `parsePattern` throws for `http://` on any non-loopback host, so this
    // passing is what proves `[::1]` is recognised as loopback by
    // `isLoopbackHost` in its BRACKETED form (it is — origin-normalizer.ts:102).
    expect(() => normalizeOriginPattern('http://[::1]:*')).not.toThrow();
    expect(() => normalizeOriginPattern('http://example.com:*')).toThrow();
  });
});

describe('TASK-641 bootstrap loopback origins admit what a local browser sends', () => {
  const admitted: Array<[string, string]> = [
    ['http://localhost:*', 'http://localhost:5176'],
    ['http://localhost:*', 'http://localhost'],
    ['http://127.0.0.1:*', 'http://127.0.0.1:5176'],
    ['https://localhost:*', 'https://localhost:5176'],
    ['https://127.0.0.1:*', 'https://127.0.0.1:8443'],
    ['http://[::1]:*', 'http://[::1]:5176'],
    ['https://[::1]:*', 'https://[::1]:8443'],
  ];

  it.each(admitted)('%s admits %s', (pattern, origin) => {
    expect(matchesOriginPattern(pattern, origin)).toBe(true);
  });

  it('needs all six rows — no loopback spelling is covered by another', () => {
    // Each of these is a row that would be redundant if the host/scheme
    // comparison were fuzzy. It is not: hosts compare with `===` and schemes
    // compare exactly, which is precisely why two rows were not enough.
    expect(matchesOriginPattern('http://localhost:*', 'http://127.0.0.1:5176')).toBe(false);
    expect(matchesOriginPattern('http://localhost:*', 'http://[::1]:5176')).toBe(false);
    expect(matchesOriginPattern('http://127.0.0.1:*', 'http://[::1]:5176')).toBe(false);
    expect(matchesOriginPattern('http://localhost:*', 'https://localhost:5176')).toBe(false);
    expect(matchesOriginPattern('http://127.0.0.1:*', 'https://127.0.0.1:5176')).toBe(false);
    expect(matchesOriginPattern('http://[::1]:*', 'https://[::1]:5176')).toBe(false);
  });
});

describe('TASK-641 KNOWN GAP — 127.0.0.2-127.0.0.255 are not expressible', () => {
  it('the deleted isLoopbackHost branch covered the whole of 127.0.0.0/8; the rows do not', () => {
    expect(matchesOriginPattern('http://127.0.0.1:*', 'http://127.0.0.2:5176')).toBe(false);
  });

  it('the grammar rejects every attempt to express the /8 as one pattern', () => {
    // `*` must be the LEFTMOST host label, so a trailing `*` is not a host
    // wildcard at all — it is read as the (mandatory) port segment being absent.
    expect(() => normalizeOriginPattern('http://127.0.0.*')).toThrow();
    // A `*.` suffix must carry >= 2 labels AND must not be IP-shaped.
    expect(() => normalizeOriginPattern('http://*.127.0.0.1:*')).toThrow();
    // A developer on an alternate loopback address must register that EXACT
    // origin as its own row. That is the documented remedy, not a bug to fix
    // by loosening the grammar.
    expect(normalizeOriginPattern('http://127.0.0.2:*')).toBe('http://127.0.0.2:*');
  });
});
