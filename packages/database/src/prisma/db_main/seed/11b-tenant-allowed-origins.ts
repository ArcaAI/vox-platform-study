/**
 * Tenant Allowed Origin Seed (TASK-610, corrected by TASK-641 §3.1 step 2)
 *
 * The day-1 CORS allow-list. Since TASK-610 §4A.1 there is NO env-var control
 * of CORS at all — `CORS_ALLOWED_ORIGINS` is gone — so these rows (plus whatever
 * an admin adds through `admin/allowed-origins`) are the ONLY thing that lets a
 * browser call the gateway. An empty table means every browser origin is
 * refused.
 *
 * ── OWNERSHIP: SYSTEM vs ArcaAI, and why it matters ─────────────────────────
 * `tenantId` is not bookkeeping — it is the isolation control. `OriginTenantBindingGuard`
 * admits a SYSTEM-owned origin for EVERY tenant, but binds a tenant-owned origin
 * to that tenant alone (anything else is a 404).
 *
 *   SYSTEM  — the SIX loopback spellings: `localhost`, `127.0.0.1` and `[::1]`,
 *             each on http AND https (see B-8 and the parity note below — one
 *             row per spelling, because the grammar matches host and scheme
 *             exactly). A developer must be able to work against ANY tenant
 *             from their machine; binding loopback to one tenant would 404 all
 *             the others.
 *   ARCAAI  — every deployed host. ArcaAI is the single retained customer
 *             tenant, so its consoles bind to it.
 *
 * ── THE SIX LOOPBACK ROWS ARE ALSO BOOTSTRAP MIGRATION DATA (H-2) ───────────
 * They are duplicated, deliberately, in
 * `migrations/20260808160000_task_641_bootstrap_loopback_origins/migration.sql`.
 * Since TASK-616 made seeding opt-in (`RUN_SEED`, default `none`) and TASK-641
 * turned enforcement on with no code fallback left, an environment that skips
 * the seed would refuse EVERY browser origin. The migration GUARANTEES those
 * six rows exist everywhere; this seed RECONCILES their `label`/`description`
 * on re-run. Keep the two byte-identical for `origin`, `tenantId`, `label` and
 * `description` — only `id` legitimately differs (Prisma mints a UUIDv7 here;
 * the migration uses hand-allocated `C0000000-…` literals).
 *
 * If a SECOND customer tenant is ever served from a `bcmch.org` host, that host
 * must move to SYSTEM or gain its own per-tenant row — leaving it ArcaAI-owned
 * would 404 the new tenant with no obvious cause.
 *
 * ── WILDCARD PATTERNS ───────────────────────────────────────────────────────
 * Canonical grammar is frozen in the ticket README §4A.2. A value is a PATTERN
 * iff it contains `*`; patterns share the `origin` column with exact origins and
 * the same global-uniqueness guarantee.
 *
 *   `https://*.bcmch.org:*`  → any https subdomain of bcmch.org, any port.
 *                              NOT the apex, NOT `evilbcmch.org`, NOT http.
 *   `http://localhost:*`     → any port on loopback (http permitted ONLY here
 *                              and on the other loopback rows).
 *   `http://127.0.0.1:*`     → the loopback IP literal — a SEPARATE row, because
 *                              `http://localhost:*` has a CONCRETE host pattern
 *                              (`localhost` contains no `*`) and does not match
 *                              `127.0.0.1` (TASK-641 B-8). The same reasoning
 *                              gives `[::1]` its own row, and the exact scheme
 *                              comparison gives each of the three hosts an
 *                              https twin.
 *
 * A wildcard trusts every subdomain that exists now OR LATER, including one with
 * a dangling DNS record — a subdomain takeover under `*.bcmch.org` becomes
 * credentialed CORS access for ArcaAI. That is an accepted owner trade, not an
 * oversight. The three explicit `bcmch.org` rows below are therefore kept even
 * though `https://*.bcmch.org:*` already subsumes them: they are the documented
 * guarantee, and they survive if the wildcard is ever withdrawn.
 *
 * ── HAND-MIRRORED, LIKE 11a ─────────────────────────────────────────────────
 * These strings must already be in canonical form: this package cannot import
 * `@arcaai/applications`, so `normalizeOrigin` / `normalizeOriginPattern` cannot
 * validate them here. A test in `@arcaai/applications` round-trips these exact
 * strings through both, so a non-canonical value cannot land silently.
 *
 * IDEMPOTENT and CREATE-ONLY for `origin` / `tenantId`: a re-seed refreshes
 * `label` / `description` but never clobbers an operator-managed row, never
 * changes ownership, and never resurrects one an operator removed. That is what
 * makes `pnpm db:seed` safe against a live database.
 */
import type { CorePrismaClient } from '../../../client';
import { SEED_CUSTOMER_TENANT_IDS, SEED_USER_IDS, SYSTEM_TENANT_ID } from './00-constants';

const CREATED_BY = SEED_USER_IDS.SYSTEM;

interface OriginSeed {
  /**
   * Canonical exact origin (`scheme://host[:port]`) OR canonical pattern
   * (`scheme://*.suffix:*`). Lowercase, no path, no trailing slash.
   */
  origin: string;
  /** Owning tenant — SYSTEM = valid for every tenant. See the header. */
  tenantId: string;
  /** Human-readable name shown in the admin origin list. */
  label: string;
  /** Operator note. */
  description: string;
}

/** Exported for the TASK-641 seed-correctness test — see the `__tests__` sibling. */
export const TENANT_ALLOWED_ORIGIN_SEEDS: OriginSeed[] = [
  // ── Platform-wide (SYSTEM) ────────────────────────────────────────────────
  //
  // ⚠️ DO NOT RE-ADD A GLOBAL `*` ROW. (TASK-641 H-1 — read before "fixing" this.)
  //
  // A Global-tenant `origin: '*'` row used to live here (TASK-610 §4A.3). It
  // was removed on owner confirmation because `OriginRegistryService.has(origin)`
  // is `tenantsFor(origin).size > 0`, and a `*` row matches EVERY origin — so
  // for as long as it exists, `tenantsFor()` is never empty and CORS admits
  // every origin NO MATTER WHAT `origin.enforcementEnabled` says. Flipping
  // enforcement on (TASK-641 FR-6) buys nothing at the CORS layer while this
  // row is present; only `OriginTenantBindingGuard` would still be doing real
  // work, and the Global tenant itself would stay wide open regardless.
  // TASK-610 §4A.3 seeded it under the assumption Global was scratch/demo
  // data. It is not: Global holds 21 users, 9 consultations, 18 departments —
  // more than the ArcaAI customer tenant. A wildcard grant that broad belongs
  // to a specific tenant admin's deliberate choice (FR-2 still gates it
  // GLOBAL_ADMIN-only), never to platform bootstrap data.
  {
    origin: 'http://localhost:*',
    tenantId: SYSTEM_TENANT_ID,
    label: 'Local development (any port)',
    description:
      'Loopback for SDK/playground/admin-console development. SYSTEM-owned so a developer can work against any tenant. `http` is permitted here and ONLY here — browsers treat loopback as a secure context.',
  },
  // `http://localhost:*` does NOT also cover `127.0.0.1` (TASK-641 B-8/FR-7).
  // Verified against `parseHostPattern` in origin-pattern.ts: the `localhost`
  // host segment contains no `*`, so it parses as a CONCRETE host
  // (`wildcard: false, matchHost: 'localhost'`), and `matchesOriginPattern`
  // then requires `parsedOrigin.host === parsed.matchHost` exactly — there is
  // no suffix/wildcard match that would let `127.0.0.1` satisfy it. The two
  // loopback spellings need two separate rows.
  {
    origin: 'http://127.0.0.1:*',
    tenantId: SYSTEM_TENANT_ID,
    label: 'Local development — loopback IP (any port)',
    description:
      'Loopback for SDK/playground/admin-console development via the literal 127.0.0.1 address (does not match the localhost hostname pattern above). SYSTEM-owned so a developer can work against any tenant. `http` is permitted here and ONLY here — browsers treat loopback as a secure context.',
  },
  // The remaining FOUR loopback spellings (TASK-641 lane G, task 2 — the parity
  // gap lane D found). The deleted `development_loopback` branch called
  // `isLoopbackHost()`, which admits `localhost` ∪ `127.0.0.0/8` ∪ `::1` on
  // EITHER scheme; two http rows are narrower than that in two ways that both
  // bite locally:
  //   • https — a stack fronted by mkcert/self-signed TLS sends
  //     `Origin: https://localhost:<port>`, and `parsePattern` compares the
  //     scheme EXACTLY, so no http row can match it.
  //   • ::1 — a browser resolving `localhost` to the IPv6 loopback sends
  //     `Origin: http://[::1]:<port>`, which matches neither of the rows above
  //     (both have CONCRETE hosts, compared with `===`).
  // All four round-trip UNCHANGED through `normalizeOriginPattern`, i.e. the
  // strings below are already canonical — verified before they were added, and
  // re-verified by `seed-origin-canonicalization.task610.test.ts`.
  //
  // RESIDUAL GAP: `127.0.0.2`-`127.0.0.255` stay uncovered. The grammar cannot
  // express them (`*` must be the leftmost label with a >= 2-label, non-IP
  // suffix), so `http://127.0.0.*` and `http://*.127.0.0.1:*` are both rejected
  // by design. Bind to an alternate loopback address and you must register that
  // exact origin as a row.
  {
    origin: 'https://localhost:*',
    tenantId: SYSTEM_TENANT_ID,
    label: 'Local development — local TLS (any port)',
    description:
      'Loopback served over local TLS (mkcert/self-signed). The pattern grammar matches the scheme EXACTLY, so the http row does not cover an https local stack. Restores the https half of the loopback coverage the deleted NODE_ENV development_loopback branch had via isLoopbackHost.',
  },
  {
    origin: 'https://127.0.0.1:*',
    tenantId: SYSTEM_TENANT_ID,
    label: 'Local development — loopback IP over local TLS (any port)',
    description:
      'Loopback IP literal served over local TLS (mkcert/self-signed). Scheme is matched exactly and 127.0.0.1 is a distinct host from localhost, so this needs its own row.',
  },
  {
    origin: 'http://[::1]:*',
    tenantId: SYSTEM_TENANT_ID,
    label: 'Local development — IPv6 loopback (any port)',
    description:
      'IPv6 loopback literal. A browser that resolves localhost to ::1 sends Origin: http://[::1]:<port>, which matches NEITHER http://localhost:* (concrete host localhost) NOR http://127.0.0.1:*. SYSTEM-owned so a developer can work against any tenant.',
  },
  {
    origin: 'https://[::1]:*',
    tenantId: SYSTEM_TENANT_ID,
    label: 'Local development — IPv6 loopback over local TLS (any port)',
    description: 'IPv6 loopback literal served over local TLS (mkcert/self-signed). Scheme is matched exactly, so the http row above does not cover it.',
  },

  // ── ArcaAI deployed hosts (exact) ─────────────────────────────────────────
  {
    origin: 'https://arcaai-u2204.bcmch.org',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    label: 'BCMCH production',
    description: 'Production deployment for BCMCH. Explicit row: the documented guarantee, independent of the *.bcmch.org wildcard.',
  },
  {
    origin: 'https://arcaai-staging.bcmch.org',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    label: 'BCMCH staging',
    description: 'Staging environment for pre-production testing and QA at BCMCH.',
  },
  {
    origin: 'https://mi-preproduction.bcmch.org:4433',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    label: 'BCMCH pre-production',
    description: 'Pre-production endpoint on non-default port 4433. Exact origins carry their port; 4433 is part of the identity, not a detail.',
  },

  // ── ArcaAI wildcard patterns ──────────────────────────────────────────────
  {
    origin: 'https://*.bcmch.org:*',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    label: 'BCMCH — any subdomain (https, any port)',
    description: 'Subdomains at any depth, never the apex. Trusts every current AND future bcmch.org subdomain — see the wildcard note in this file header.',
  },
  {
    origin: 'https://*.taphuynh.dev:*',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    label: 'taphuynh.dev — any subdomain (https, any port)',
    description: 'Developer preview/compatibility hosts. Replaces the hardcoded compat-playground literal TASK-610 D-2 removed from the gateway source.',
  },
  {
    origin: 'https://*.4bits.vn:*',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    label: '4bits.vn — any subdomain (https, any port)',
    description: 'Developer preview hosts.',
  },

  // ── ArcaAI browser-extension origins (TASK-653) ───────────────────────────
  // `<scheme>://*` is the "any extension of that scheme" pattern: it admits any
  // installed extension's origin for the ArcaAI tenant. Chrome ids are stable
  // and could be pinned to exact `chrome-extension://<id>` rows later; Firefox
  // and Safari mint a per-INSTALL id, so the wildcard is the only practical form
  // there. This is an ORIGIN gate only — the post-auth OriginTenantBindingGuard
  // and the WS handshake still require a valid session/token, and HTTP CORS runs
  // credentials:false. Strings are already canonical (no port segment).
  {
    origin: 'chrome-extension://*',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    label: 'Chromium extensions — any id (Chrome/Edge/Brave)',
    description: 'Any chrome-extension:// origin. Admits any installed Chromium extension for ArcaAI; pin specific ids as exact chrome-extension://<id> rows once known.',
  },
  {
    origin: 'moz-extension://*',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    label: 'Firefox extensions — any id',
    description: 'Any moz-extension:// origin. Firefox mints a per-install UUID, so the wildcard is the only practical form.',
  },
  {
    origin: 'safari-web-extension://*',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    label: 'Safari web extensions — any id',
    description: 'Any safari-web-extension:// origin. Safari mints a per-install UUID (sent uppercase; matched case-insensitively).',
  },
];

export const seedTenantAllowedOrigins = async (client: CorePrismaClient): Promise<void> => {
  console.log(`Seeding Tenant Allowed Origins (${TENANT_ALLOWED_ORIGIN_SEEDS.length} rows)...`);

  for (const originRow of TENANT_ALLOWED_ORIGIN_SEEDS) {
    await client.tenantAllowedOrigin.upsert({
      // The GRANT key: (origin, tenantId). Since README §4B the same origin may
      // be granted to several tenants, so an origin alone no longer identifies
      // a row — upserting by `origin` would collide across tenants.
      //
      // A named MULTI-field `@@unique` generates this clean compound key. A
      // named SINGLE-field one does not: it emits an `AtLeast<>` discriminator
      // Prisma never generates into the shape, leaving the constraint
      // unaddressable — `tsc` and the whole unit suite stay green and the
      // upsert fails at RUNTIME. This seed hit exactly that. See
      // tenant-allowed-origin.prisma.
      where: {
        origin_tenantId: { origin: originRow.origin, tenantId: originRow.tenantId },
      },
      // Idempotent: refresh metadata but NEVER clobber an operator-modified row
      // on re-seed. `tenantId` is deliberately absent from `update` — ownership
      // is the isolation control, and a re-seed must not silently move an origin
      // between tenants.
      update: {
        label: originRow.label,
        description: originRow.description,
      },
      create: {
        tenantId: originRow.tenantId,
        origin: originRow.origin,
        label: originRow.label,
        description: originRow.description,
        createdBy: CREATED_BY,
      },
    });
    // No row is Global-owned any more (TASK-641 H-1 removed the `*` row) — the
    // only owners left are SYSTEM and the ArcaAI customer tenant.
    const owner = originRow.tenantId === SYSTEM_TENANT_ID ? 'SYSTEM' : 'ArcaAI';
    console.log(`  ${originRow.origin.padEnd(40)} [${owner}] ${originRow.label}`);
  }

  console.log(`Seeded ${TENANT_ALLOWED_ORIGIN_SEEDS.length} Tenant Allowed Origins`);
};
