/**
 * Seed canonicalization guard (TASK-610 §4A.2, lane W5-E — second deliverable).
 *
 * `packages/database` CANNOT import `@arcaai/applications` (see
 * `02-database-prisma.md` — the domain/application layers depend on the
 * database package, not the other way around), so
 * `packages/database/src/prisma/db_main/seed/11b-tenant-allowed-origins.ts`
 * hard-codes its origin/pattern strings by hand — the same "mirrored by hand"
 * pattern `seed/11a-platform-knob-settings.ts` already uses for its
 * descriptor keys. Nothing on the database side proves those hand-typed
 * strings are actually canonical: a non-canonical value would sit in the DB
 * row unchanged and then silently never match anything at CORS-decision
 * time, because the registry only ever compares against
 * `normalizeOrigin`/`normalizeOriginPattern` OUTPUT, never the raw seed text.
 *
 * This test hard-codes the exact eight seed strings from that file (see its
 * header comment "HAND-MIRRORED, LIKE 11a" for the seed-side half of this
 * link) and asserts each one is classified correctly by `isOriginPattern`
 * AND round-trips UNCHANGED through the normalizer its shape routes to —
 * i.e. each is already in canonical form. If a future edit to either file
 * drifts the strings apart, this test is what catches it.
 */
import { describe, expect, it } from 'vitest';
import { isOriginPattern, normalizeOriginPattern } from '../../origin-registry/origin-pattern';
import { normalizeOrigin } from '../../origin-registry/origin-normalizer';

// Verbatim copy of `ORIGINS[].origin` from
// `packages/database/src/prisma/db_main/seed/11b-tenant-allowed-origins.ts`,
// in seed order. Keep this list in lockstep with that file by hand — that
// duplication IS the point (see file header).
const SEED_ORIGINS = [
  '*',
  'http://localhost:*',
  'https://arcaai-u2204.bcmch.org',
  'https://arcaai-staging.bcmch.org',
  'https://mi-preproduction.bcmch.org:4433',
  'https://*.bcmch.org:*',
  'https://*.taphuynh.dev:*',
  'https://*.4bits.vn:*',
] as const;

describe('seed/11b-tenant-allowed-origins.ts strings are canonical', () => {
  it.each(SEED_ORIGINS)('classifies %s by shape and round-trips unchanged through its normalizer (idempotent)', (raw) => {
    if (isOriginPattern(raw)) {
      // Wildcard pattern OR the bare allow-all token — both are
      // `isOriginPattern` true (§4A.2: "a stored value is a pattern iff it
      // contains `*`"), and both route through `normalizeOriginPattern`.
      expect(normalizeOriginPattern(raw)).toBe(raw);
    } else {
      expect(normalizeOrigin(raw).origin).toBe(raw);
    }
  });

  it('classifies exactly the three EXACT (non-wildcard) seed origins as NOT patterns', () => {
    const exact = SEED_ORIGINS.filter((origin) => !isOriginPattern(origin));
    expect(exact).toEqual(['https://arcaai-u2204.bcmch.org', 'https://arcaai-staging.bcmch.org', 'https://mi-preproduction.bcmch.org:4433']);
  });

  it('classifies exactly the five wildcard/allow-all seed origins as patterns', () => {
    const patterns = SEED_ORIGINS.filter((origin) => isOriginPattern(origin));
    expect(patterns).toEqual(['*', 'http://localhost:*', 'https://*.bcmch.org:*', 'https://*.taphuynh.dev:*', 'https://*.4bits.vn:*']);
  });
});
