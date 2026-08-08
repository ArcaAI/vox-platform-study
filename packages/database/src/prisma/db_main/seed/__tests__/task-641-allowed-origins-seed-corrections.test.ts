/**
 * TASK-641 Lane A — three seed corrections to `11b-tenant-allowed-origins.ts`.
 *
 * 1. The Global `*` row is removed (H-1). `OriginRegistryService.has(origin)` is
 *    `tenantsFor(origin).size > 0`, and a `*` row matches every origin, so while
 *    it exists CORS admits everything regardless of `origin.enforcementEnabled`
 *    — enforcement becomes a no-op at the CORS layer. TASK-610 §4A.3 seeded it
 *    when Global was assumed to be scratch data; it is not (21 users, 9
 *    consultations, 18 departments).
 *
 * 2. `http://127.0.0.1:*` is added as a SYSTEM-tenant row (B-8). Verified against
 *    `parseHostPattern` in `origin-pattern.ts`: `http://localhost:*` has hostPattern
 *    `localhost`, which does NOT contain `*`, so it parses as a CONCRETE host
 *    (`wildcard: false, matchHost: 'localhost'`) and `matchesOriginPattern` requires
 *    `parsedOrigin.host === parsed.matchHost` exactly — `127.0.0.1` never matches
 *    `localhost`. The two loopback forms need two separate rows.
 *
 * 3. Idempotency (create-only for `origin`/`tenantId`) is preserved — a re-seed
 *    refreshes `label`/`description` but never re-parents a row and never
 *    duplicates one.
 *
 * Static assertions over the EXPORTED seed data (no live DB) for #1/#2, following
 * the conventions of `config-plane-seed.test.ts` in this directory. #3 exercises
 * `seedTenantAllowedOrigins` against an in-memory fake Prisma client that mimics
 * `upsert` semantics — this repo's seed tests never touch a live database.
 */

import { describe, expect, it } from 'vitest';

import type { CorePrismaClient } from '../../../../client';
import { SEED_CUSTOMER_TENANT_IDS, SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../00-constants';
import { seedTenantAllowedOrigins, TENANT_ALLOWED_ORIGIN_SEEDS } from '../11b-tenant-allowed-origins';

// ---------------------------------------------------------------------------
// 1 & 2 — static shape of the seed data
// ---------------------------------------------------------------------------

describe('TenantAllowedOrigin seed — the `*` row is gone (H-1)', () => {
  it('no row has origin === "*"', () => {
    expect(TENANT_ALLOWED_ORIGIN_SEEDS.some((o) => o.origin === '*')).toBe(false);
  });

  it('no row is owned by the Global tenant', () => {
    // The `*` row was the ONLY Global-owned row. Asserting on tenantId (not just
    // on the literal `'*'`) protects against someone re-adding global access
    // under a different-looking pattern.
    expect(TENANT_ALLOWED_ORIGIN_SEEDS.some((o) => o.tenantId === SEED_TENANT_ID)).toBe(false);
  });
});

/**
 * Lane G extended this from the original two rows to SIX. The branch B-7 deleted
 * from `cors.config.ts` called `isLoopbackHost()`, which admits
 * `localhost` ∪ `127.0.0.0/8` ∪ `::1` on EITHER scheme; the two http rows Lane A
 * seeded were narrower than the branch they replaced, in two ways that both bite
 * locally (https-fronted dev stacks, and browsers resolving `localhost` to ::1).
 * Host comparison is `===` and scheme comparison is exact, so each spelling
 * genuinely needs its own row — pinned in
 * `packages/applications/src/services/origin-registry/__tests__/loopback-bootstrap-origins.task641.test.ts`,
 * which is also where the canonical form of each string is verified against the
 * real normalizer (this package cannot import `@arcaai/applications`).
 */
const EXPECTED_LOOPBACK_ORIGINS = [
  'http://localhost:*',
  'http://127.0.0.1:*',
  'https://localhost:*',
  'https://127.0.0.1:*',
  'http://[::1]:*',
  'https://[::1]:*',
] as const;

describe('TenantAllowedOrigin seed — all six loopback forms are SYSTEM rows (B-8 + lane G parity)', () => {
  it.each(EXPECTED_LOOPBACK_ORIGINS)('%s is present, owned by SYSTEM', (origin) => {
    const row = TENANT_ALLOWED_ORIGIN_SEEDS.find((o) => o.origin === origin);
    expect(row).toBeDefined();
    expect(row?.tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('the SYSTEM-owned rows are EXACTLY those six — nothing else is platform-wide', () => {
    // A SYSTEM row is valid for every tenant, so an accidental addition here is
    // a platform-wide grant. Asserting the exact set (not just membership) is
    // what makes that impossible to add quietly.
    const systemOrigins = TENANT_ALLOWED_ORIGIN_SEEDS.filter((o) => o.tenantId === SYSTEM_TENANT_ID).map((o) => o.origin);
    expect(systemOrigins.sort()).toEqual([...EXPECTED_LOOPBACK_ORIGINS].sort());
  });

  it('these six are the rows the bootstrap MIGRATION also guarantees (H-2)', () => {
    // `migrations/20260808160000_task_641_bootstrap_loopback_origins` inserts the
    // same six rows with `ON CONFLICT (origin, tenantId) DO NOTHING`, because
    // TASK-616 made seeding opt-in and enforcement now defaults ON with no code
    // fallback left. If a row is added or renamed here without being added
    // there, an unseeded environment loses it — this assertion is the reminder.
    expect(EXPECTED_LOOPBACK_ORIGINS).toHaveLength(6);
  });
});

describe('TenantAllowedOrigin seed — every remaining row has a valid owner', () => {
  it('every row is owned by SYSTEM or ArcaAI (never Global, never a stray id)', () => {
    const validOwners = new Set([SYSTEM_TENANT_ID, SEED_CUSTOMER_TENANT_IDS.ARCAAI]);
    for (const row of TENANT_ALLOWED_ORIGIN_SEEDS) {
      expect(validOwners.has(row.tenantId), `unexpected owner for ${row.origin}: ${row.tenantId}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3 — idempotency against an in-memory fake client
// ---------------------------------------------------------------------------

interface FakeRow {
  tenantId: string;
  origin: string;
  label: string;
  description: string;
  createdBy: string;
}

/**
 * Minimal fake of the `tenantAllowedOrigin` Prisma delegate: enough surface for
 * `seedTenantAllowedOrigins`'s single `upsert` call per row, backed by an
 * in-memory map keyed by the same compound `(origin, tenantId)` key the real
 * `@@unique` constraint uses. Mirrors real `upsert` semantics: create on miss,
 * apply ONLY the given `update` fields on hit (never touches `tenantId`).
 */
function createFakeClient(): { client: CorePrismaClient; rows: () => FakeRow[]; upsertCalls: Array<{ where: unknown; update: unknown }> } {
  const store = new Map<string, FakeRow>();
  const upsertCalls: Array<{ where: unknown; update: unknown }> = [];

  const client = {
    tenantAllowedOrigin: {
      upsert: async ({
        where,
        update,
        create,
      }: {
        where: { origin_tenantId: { origin: string; tenantId: string } };
        update: Partial<FakeRow>;
        create: FakeRow;
      }) => {
        upsertCalls.push({ where, update });
        const key = `${where.origin_tenantId.origin}::${where.origin_tenantId.tenantId}`;
        const existing = store.get(key);
        if (existing) {
          store.set(key, { ...existing, ...update });
        } else {
          store.set(key, create);
        }
      },
    },
  } as unknown as CorePrismaClient;

  return { client, rows: () => Array.from(store.values()), upsertCalls };
}

describe('seedTenantAllowedOrigins — idempotent on re-run', () => {
  it('re-running produces exactly one row per (origin, tenantId), no duplicates', async () => {
    const { client, rows } = createFakeClient();

    await seedTenantAllowedOrigins(client);
    await seedTenantAllowedOrigins(client);

    expect(rows()).toHaveLength(TENANT_ALLOWED_ORIGIN_SEEDS.length);
  });

  it('never writes tenantId in the update payload — ownership cannot drift on re-seed', async () => {
    const { client, upsertCalls } = createFakeClient();

    await seedTenantAllowedOrigins(client);
    await seedTenantAllowedOrigins(client);

    for (const call of upsertCalls) {
      expect(Object.keys(call.update as object)).not.toContain('tenantId');
    }
  });

  it('a second run leaves every row bound to its original tenant', async () => {
    const { client, rows } = createFakeClient();

    await seedTenantAllowedOrigins(client);
    await seedTenantAllowedOrigins(client);

    const byKey = new Map(rows().map((r) => [`${r.origin}::${r.tenantId}`, r]));
    for (const seed of TENANT_ALLOWED_ORIGIN_SEEDS) {
      expect(byKey.has(`${seed.origin}::${seed.tenantId}`)).toBe(true);
    }
  });
});
