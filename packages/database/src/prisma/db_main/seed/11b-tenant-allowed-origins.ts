/**
 * Tenant Allowed Origin Seed (TASK-610)
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
 *   SYSTEM  — `localhost`. A developer must be able to work against ANY tenant
 *             from their machine; binding loopback to one tenant would 404 all
 *             the others.
 *   ARCAAI  — every deployed host. ArcaAI is the single retained customer
 *             tenant, so its consoles bind to it.
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
 *   `http://localhost:*`     → any port on loopback (http permitted ONLY here).
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
import { SEED_CUSTOMER_TENANT_IDS, SEED_TENANT_ID, SEED_USER_IDS, SYSTEM_TENANT_ID } from './00-constants';

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

const ORIGINS: OriginSeed[] = [
  // ── Global tenant — ANY ORIGIN (owner-directed, all environments) ─────────
  //
  // ⚠️ READ BEFORE COPYING THIS ROW TO ANOTHER TENANT.
  //
  // `*` admits every origin. Because the gateway sets `credentials: true` and
  // runs `express-session`, this means any website a Global-tenant user visits
  // can issue credentialed requests to the API AND READ THE RESPONSES — a
  // cross-origin read primitive, not merely a write one. For any other tenant
  // that would be an unacceptable exposure.
  //
  // What confines it: `OriginTenantBindingGuard`. `*` carries the LOWEST
  // possible pattern specificity, so it only ever wins a lookup that nothing
  // else matches. A request from `evil.example` therefore resolves owner=Global,
  // and if it carries an ArcaAI token the tenants disagree → 404. Every other
  // tenant stays protected; the blast radius is exactly the Global tenant's own
  // data. That containment is the ONLY reason this row is defensible, and it
  // evaporates the moment the binding guard is bypassed or reordered.
  //
  // Precedence this row depends on (asserted in the registry's tests):
  //   https://arcaai-u2204.bcmch.org → ArcaAI  (exact beats every pattern)
  //   https://anything.bcmch.org     → ArcaAI  (*.bcmch.org outranks `*`)
  //   https://random.example.com     → Global  (only `*` matches)
  //
  // Revoking is a single soft delete of this row — no deploy, no restart.
  {
    origin: '*',
    tenantId: SEED_TENANT_ID,
    label: 'Global — any origin',
    description:
      'Owner-directed: the Global tenant accepts requests from any origin in every environment (dev, staging, production). Lowest precedence, so it never shadows a tenant-owned origin. Confined to Global-tenant data by OriginTenantBindingGuard.',
  },

  // ── Platform-wide (SYSTEM) ────────────────────────────────────────────────
  {
    origin: 'http://localhost:*',
    tenantId: SYSTEM_TENANT_ID,
    label: 'Local development (any port)',
    description:
      'Loopback for SDK/playground/admin-console development. SYSTEM-owned so a developer can work against any tenant. `http` is permitted here and ONLY here — browsers treat loopback as a secure context.',
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
];

export const seedTenantAllowedOrigins = async (client: CorePrismaClient): Promise<void> => {
  console.log(`Seeding Tenant Allowed Origins (${ORIGINS.length} rows)...`);

  for (const originRow of ORIGINS) {
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
    const owner = originRow.tenantId === SYSTEM_TENANT_ID ? 'SYSTEM' : originRow.tenantId === SEED_TENANT_ID ? 'Global' : 'ArcaAI';
    console.log(`  ${originRow.origin.padEnd(40)} [${owner}] ${originRow.label}`);
  }

  console.log(`Seeded ${ORIGINS.length} Tenant Allowed Origins`);
};
