/**
 * Seed canonicalization guard (TASK-610 §4A.2 lane W5-E; re-pointed at the real
 * array by TASK-641 lane J, task 2).
 *
 * `packages/database` CANNOT import `@arcaai/applications` (see
 * `02-database-prisma.md` — the application layer depends on the database
 * package, never the reverse), so
 * `packages/database/src/prisma/db_main/seed/11b-tenant-allowed-origins.ts`
 * hard-codes its origin/pattern strings by hand. Nothing on the database side
 * proves those hand-typed strings are canonical, and a non-canonical value
 * would sit in the row unchanged and then silently never match anything at
 * CORS-decision time: the registry only ever compares against
 * `normalizeOrigin` / `normalizeOriginPattern` OUTPUT, never the raw seed text.
 *
 * ── WHY THIS FILE IMPORTS THE SEED ARRAY INSTEAD OF RE-DECLARING IT ─────────
 * It used to keep its own hand-typed copy of the list, and by TASK-641 that
 * copy had drifted THREE ways while still passing — it round-tripped only its
 * own array, so it could not observe the seed at all:
 *   • it still carried the global `'*'` row that TASK-641 H-1 deleted,
 *   • it never gained `http://127.0.0.1:*`,
 *   • it lacked the four loopback patterns lane G added
 *     (`https://localhost:*`, `https://127.0.0.1:*`, `http://[::1]:*`,
 *     `https://[::1]:*`).
 * A guard that mirrors its subject by hand is a guard that stops guarding. It
 * now reads `TENANT_ALLOWED_ORIGIN_SEEDS` directly, so the list cannot drift.
 *
 * The import is legitimate in this direction and at this layer: `applications`
 * already declares `@arcaai/database` as a dependency, the seed module is not
 * reachable through that package's `exports` map (only `.` and `./client`) so a
 * relative source path is the only way in, and at runtime it pulls nothing but
 * `00-constants.ts`, which is pure literals with zero imports of its own — no
 * Prisma client, no `env.js`, no connection. The rule-04 ban on importing
 * `@arcaai/database` RUNTIME code targets the coupling of application SERVICE
 * modules to Prisma; this is a test file, excluded from `tsc` and from ESLint
 * (both configs exclude the `__tests__` tree), so it adds nothing to the
 * shipped surface. If the seed file is ever moved or renamed, this test fails
 * loudly at import — which is the behaviour we want from a drift gate.
 *
 * SCOPE NOTE: the six loopback rows are hard-coded a THIRD time, in
 * `migrations/20260808160000_task_641_bootstrap_loopback_origins/migration.sql`
 * (SQL cannot call the normalizer). That copy is pinned separately by
 * `origin-registry/__tests__/loopback-bootstrap-origins.task641.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { isOriginPattern, normalizeOriginPattern } from '../../origin-registry/origin-pattern';
import { normalizeOrigin } from '../../origin-registry/origin-normalizer';
// Deep relative path by necessity — see "WHY THIS FILE IMPORTS THE SEED ARRAY" above.
// eslint-disable-next-line no-restricted-imports
import { TENANT_ALLOWED_ORIGIN_SEEDS } from '../../../../../database/src/prisma/db_main/seed/11b-tenant-allowed-origins';

const SEED_ORIGINS = TENANT_ALLOWED_ORIGIN_SEEDS.map((seed) => seed.origin);

describe('seed/11b-tenant-allowed-origins.ts strings are canonical', () => {
  it.each(SEED_ORIGINS)('classifies %s by shape and round-trips unchanged through its normalizer (idempotent)', (raw) => {
    if (isOriginPattern(raw)) {
      expect(normalizeOriginPattern(raw)).toBe(raw);
    } else {
      expect(normalizeOrigin(raw).origin).toBe(raw);
    }
  });

  it('seeds both shapes, so the round-trip above is not vacuously testing one branch', () => {
    expect(SEED_ORIGINS.filter((origin) => isOriginPattern(origin)).length).toBeGreaterThan(0);
    expect(SEED_ORIGINS.filter((origin) => !isOriginPattern(origin)).length).toBeGreaterThan(0);
  });

  it('never re-introduces the bare allow-all `*` row (TASK-641 H-1)', () => {
    // `OriginRegistryService.has(origin)` is `tenantsFor(origin).size > 0`, and
    // a `*` row matches EVERY origin — so while it exists, CORS admits every
    // origin no matter what `origin.enforcementEnabled` says. A grant that
    // broad is a tenant admin's deliberate choice, never bootstrap data.
    expect(SEED_ORIGINS).not.toContain('*');
  });

  it('grants plain http only to loopback hosts', () => {
    // Both normalizers reject `http://` for a non-loopback host, so this is a
    // direct restatement of the invariant rather than a second implementation.
    for (const origin of SEED_ORIGINS.filter((value) => value.startsWith('http://'))) {
      expect(() => (isOriginPattern(origin) ? normalizeOriginPattern(origin) : normalizeOrigin(origin))).not.toThrow();
    }
  });
});
