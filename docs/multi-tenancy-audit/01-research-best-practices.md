# Multi-Tenancy SaaS Best Practices — Research Report (2025–2026)

**Target system**: HOPE (Healthcare AI Services)
**Stack**: Turborepo + pnpm monorepo · NestJS 11 API Gateway · FastAPI Python services (TTS/SMR/NLP/STT) · PostgreSQL 14+ via Prisma 7 · Redis 7+ · React 19 + Vite 7 · `@arcaai/vox` SDK · Docker Compose + systemd + PgBouncer
**Compliance context**: HIPAA, GDPR, SOC 2, ISO 27001 (healthcare PHI)
**Author**: Researcher subagent
**Date**: 2026-05-25
**Status**: Research / advisory

---

## Executive Summary — 2025–2026 Industry Consensus

The multi-tenant SaaS architecture conversation has shifted significantly between 2023 and 2026. The current consensus is:

1. **Shared DB + Row-Level Security (RLS) is the new default** for new multi-tenant SaaS in 2026, replacing "trust the app filter" as the baseline. Supabase made RLS table-stakes; Drizzle and Prisma shipped first-class RLS helpers in 2025; auditors (SOC 2, HIPAA) now flag pure application-layer filtering as control-failure risk. ([datasofttechnologies.com](https://datasofttechnologies.com/blog/why-postgres-row-level-security-is-quietly-becoming-the-default-for-multi-tenant-saas-in-2026), 2026; [cadence.withremote.ai/blog/multi-tenancy-saas](https://cadence.withremote.ai/blog/multi-tenancy-saas), 2026)
2. **Defense-in-depth, not silver bullets**. Production-grade isolation requires (a) JWT-bound tenant context, (b) middleware/CLS context propagation, (c) RLS at the DB, (d) tenant-prefixed cache & queue keys, (e) tenant-tagged telemetry, (f) per-tenant rate limits — **all at once**.
3. **AWS SaaS Lens (Silo / Bridge / Pool)** is still the canonical taxonomy. Most teams default to Pool (shared everything + RLS) and reserve Silo (DB-per-tenant) for regulated/enterprise contracts. ([docs.aws.amazon.com/wellarchitected/latest/saas-lens/bridge-model.html](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/bridge-model.html))
4. **PgBouncer + `SET LOCAL` (transaction-scoped GUC)** is the standardised pattern for combining RLS with connection pooling — `SET` (session-scoped) is now considered an outright bug. ([pgbouncer.org/config.html](https://pgbouncer.org/config.html); [mvpfactory.io](https://mvpfactory.io/blog/row-level-security-in-postgresql-multi-tenant-data-isolation-for-your-saas/), 2025)
5. **Prisma 6.14 removed `$use` middleware**; Prisma 7 mandates `$extends` (client extensions) for tenant scoping. ([github.com/prisma/prisma/issues/27891](https://github.com/prisma/prisma/issues/27891), 2025; [prisma.io/docs](https://www.prisma.io/docs/orm/prisma-client/client-extensions))
6. **AsyncLocalStorage (NestJS via `nestjs-cls`)** beats `Scope.REQUEST` for tenant context because REQUEST-scoped DI degrades performance and doesn't reach passport strategies, cron jobs, BullMQ consumers, or WebSocket gateways. ([github.com/Papooch/nestjs-cls](https://github.com/Papooch/nestjs-cls/); [pas7.com.ua/blog](https://pas7.com.ua/blog/en/nestjs-request-context-als-2026), 2026)
7. **ReBAC engines (OpenFGA, AuthZed/SpiceDB)** are mature and adopted, but **most healthcare SaaS still chooses RBAC + tenant_id + RLS** for clarity and auditability. ReBAC layered on top is appropriate when document/record sharing graphs become complex. ([authzed.com/learn](https://authzed.com/learn/rebac-key-components); [osohq.com/learn](https://www.osohq.com/learn/spicedb-alternatives-authorization-tools-comparison))
8. **HIPAA-grade multi-tenant** requires *per-tenant envelope-encryption keys (KMS CMK), TLS 1.2+ everywhere, immutable per-tenant audit logging, and minimum-necessary IAM*. Compute isolation (Firecracker microVMs / dedicated containers) is increasingly available as a hardening layer for premium tenants. ([nitrix-reloaded.com](https://nitrix-reloaded.com/2026/02/28/aws-lambda-tenant-isolation-mode-multi-tenant-saas-2/), 2026; [thecorporate.cloud](https://thecorporate.cloud/architecting-hipaa-ready-multi-tenant-ehrs-patterns-for-clou))
9. **Crypto-shredding** (destroy per-tenant/per-subject keys) is the 2026 answer to GDPR Right-to-Erasure when data has spread to backups, warehouses, search indices, and embeddings. Hard delete + cascade still required in the primary DB. ([oneuptime.com](https://oneuptime.com/blog/post/2026-02-17-how-to-set-up-crypto-shredding-for-gdpr-right-to-erasure-compliance-in-google-cloud/view), 2026; [wolf-tech.io](https://wolf-tech.io/blog/gdpr-right-to-erasure-engineering-deleting-users-from-complex-saas-systems))
10. **OpenTelemetry baggage carries `tenant.id` end-to-end** but never PII; Prometheus tenant labels are paired with cardinality limits or pushed into Mimir/Cortex tenants. ([oneuptime.com](https://oneuptime.com/blog/post/2026-02-06-instrument-saas-multi-tenant-application-opentelemetry/view), 2026; [mylinux.work/guides/prometheus-multi-tenancy](https://mylinux.work/guides/prometheus-multi-tenancy/))

---

## 1. Tenant Isolation Models (2025–2026)

### 1.1 Three models, one taxonomy

AWS SaaS Lens terminology has won — Silo / Bridge / Pool is now the lingua franca. ([docs.aws.amazon.com/solutions/multi-tenant-architectures-on-aws](https://docs.aws.amazon.com/solutions/multi-tenant-architectures-on-aws/))

| Model | Database layout | Isolation | Cost | When to use |
| --- | --- | --- | --- | --- |
| **Silo** | DB instance per tenant | Strongest (physical) | Highest | Regulated tenants (HIPAA BAA enterprise), >10–20% load tenants |
| **Bridge** | Shared instance, schema per tenant | Strong (logical) | Medium | Mid-market enterprise, data residency per tenant |
| **Pool** | Shared schema, `tenant_id` column + RLS | Logical, DB-enforced | Lowest | Default for new SaaS; the standard 2026 baseline |

**Current consensus (2026)**: Default to Pool with RLS for 90–95% of tenants; promote 1–5% of high-load or contractually-required tenants to Silo. Bridge is rarely chosen new in 2026 — it has the operational cost of Silo without much of Pool's economics. ([aws.amazon.com/blogs/database/choose-the-right-postgresql-data-access-pattern-for-your-saas-application](https://aws.amazon.com/blogs/database/choose-the-right-postgresql-data-access-pattern-for-your-saas-application/); [cadence.withremote.ai/blog/multi-tenancy-saas](https://cadence.withremote.ai/blog/multi-tenancy-saas), 2026)

**For HOPE**: Pool + RLS for standard hospital/clinic tenants. Reserve Silo for: (a) tenants signing a BAA that explicitly requires physical isolation, (b) tenants whose PHI volume exceeds 10% of cluster load, (c) tenants in jurisdictions requiring data residency (EU, Singapore).

### 1.2 PostgreSQL Row-Level Security — the 2026 canonical pattern

Pattern that every authoritative source agrees on ([rivestack.io](https://rivestack.io/blog/postgresql-row-level-security); [cadence.withremote.ai/blog/postgres-rls-saas](https://cadence.withremote.ai/blog/postgres-rls-saas), 2026; [mvpfactory.io](https://mvpfactory.io/blog/row-level-security-in-postgresql-multi-tenant-data-isolation-for-your-saas/)):

```sql
-- Step 1: Add tenant_id to EVERY tenant-scoped table (denormalised; do not hop joins for tenant_id)
ALTER TABLE consultations ADD COLUMN tenant_id UUID NOT NULL;
CREATE INDEX idx_consultations_tenant ON consultations(tenant_id, created_at DESC);

-- Step 2: Create a non-owner, non-superuser, non-BYPASSRLS application role
CREATE ROLE hope_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '...';
GRANT USAGE ON SCHEMA public TO hope_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hope_app;

-- Step 3: Enable AND FORCE RLS on every tenant table
ALTER TABLE consultations ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultations FORCE ROW LEVEL SECURITY;  -- critical: covers the owner role too

-- Step 4: Four policies per table (SELECT/INSERT/UPDATE/DELETE)
CREATE POLICY tenant_select ON consultations
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_insert ON consultations
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_update ON consultations
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);  -- BOTH required

CREATE POLICY tenant_delete ON consultations
  FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

**Critical correctness details everyone gets wrong**:

- `FORCE ROW LEVEL SECURITY` — without it, the table-owner role (often the migration user) silently bypasses policies. ([cadence.withremote.ai/blog/postgres-rls-saas](https://cadence.withremote.ai/blog/postgres-rls-saas))
- `current_setting('app.tenant_id', true)` — the `true` second arg returns NULL when unset rather than throwing, but means **missing context returns zero rows** (silent isolation). Pair with an application-side `if (!tenantId) throw` guard.
- `WITH CHECK` on UPDATE — without it, a tenant can `UPDATE x SET tenant_id = 'other'` and hand a row to another tenant.
- Index `tenant_id` first on every composite index. Policies are evaluated as filters; without a leading `tenant_id` index, every query becomes a seq scan.

### 1.3 PgBouncer + RLS — the `SET LOCAL` rule

| Pooling mode | `set_config(..., false)` (session) | `set_config(..., true)` / `SET LOCAL` (transaction) |
| --- | --- | --- |
| Session | ✅ Safe | ✅ Safe |
| **Transaction (recommended)** | ❌ **DATA LEAK** — next request inherits previous tenant's context | ✅ Safe |
| Statement | ❌ Cannot use `set_config` reliably | ❌ |

([pgbouncer.org/config.html](https://pgbouncer.org/config.html); [dev.to/planetscale/rls-sounds-great-until-it-isnt](https://dev.to/planetscale/rls-sounds-great-until-it-isnt-4d5p); [mvpfactory.io](https://mvpfactory.io/blog/row-level-security-in-postgresql-multi-tenant-data-isolation-for-your-saas/))

**The 2026 standard**: PgBouncer transaction mode + `SET LOCAL app.tenant_id = '...'` inside an explicit `BEGIN/COMMIT`, set as the **first statement in every request transaction**.

```sql
BEGIN;
SET LOCAL app.tenant_id = '01HXY...';
-- queries here
COMMIT;
```

**Defense-in-depth bypass risks to audit**:

1. App user has `BYPASSRLS` → policies become decorative.
2. Migration scripts running as superuser → bypass RLS by design (intentional, but document and isolate).
3. Background jobs forgetting to `SET LOCAL` → return zero rows OR (worse) leak with `SET` not `SET LOCAL`.
4. `NOT VALID` constraints → can leave orphan/cross-tenant rows that pass the foreign-key check but violate RLS.
5. Any tooling connecting as the table-owner without `FORCE` → policies silently disabled.

---

## 2. Tenant Context Propagation

### 2.1 Tenant resolution — subdomain vs path vs header vs JWT

| Strategy | Pros | Cons | 2026 verdict |
| --- | --- | --- | --- |
| **JWT claim (`tid` / `tenant_id`)** | Cryptographically verified; works for APIs | Switching tenants requires re-issuing token | **Primary source-of-truth** |
| **Subdomain (`acme.hope.health`)** | Clean UX; cookies scope naturally | Wildcard cert; DNS overhead per tenant | Good for browser apps as secondary indicator |
| **Path (`/tenants/:tid/...`)** | URL-debuggable; multi-tenant from one host | Verbose; client must inject everywhere | Good for admin/back-office APIs |
| **Header (`X-Tenant-Id`)** | Easy to add | **Trust boundary** — proxies strip/inject headers | **Never trust client-supplied** for authz |

Best practice: **JWT claim is the authoritative source**; subdomain (if used) must agree with JWT or return 403. Never accept `X-Tenant-Id` from external clients. ([harborsoftware.com](https://harborsoftware.com/2025/01/10/authentication-patterns-multi-tenant-saas-applications/), 2025; [multi-tenant-saas.com](https://www.multi-tenant-saas.com/auth-isolation-cross-tenant-access-control/tenant-aware-jwt-token-management/jwt-claims-for-tenant-scoping-best-practices/))

### 2.2 NestJS — AsyncLocalStorage with `nestjs-cls`

The 2026 NestJS community consensus has moved decisively to `nestjs-cls` over `Scope.REQUEST` providers. Reasons:

- `Scope.REQUEST` re-instantiates a large chunk of the DI graph per request (measurable perf hit; `nestjs-pino` recommends avoiding it). ([pas7.com.ua/blog](https://pas7.com.ua/blog/en/nestjs-request-context-als-2026), 2026)
- REQUEST scope doesn't reach: Passport strategies, cron controllers, WebSocket gateways, BullMQ consumers. ([github.com/Papooch/nestjs-cls](https://github.com/Papooch/nestjs-cls/))
- ALS via Node's stable `AsyncLocalStorage` survives any number of `await` hops.

Recommended pattern for HOPE:

```typescript
ClsModule.forRoot({
  global: true,
  middleware: {
    mount: true,
    setup: (cls, req) => {
      // Tenant is set after JWT auth guard runs (see ordering note)
      const claims = req.user;  // populated by JWT strategy
      cls.set('tenantId', claims.tid);
      cls.set('userId',   claims.sub);
      cls.set('requestId', req.headers['x-request-id'] ?? randomUUID());
      cls.set('correlationId', req.headers['x-correlation-id'] ?? cls.get('requestId'));
    },
  },
  plugins: [new ClsPluginTransactional({ /* per-request DB transaction with SET LOCAL */ })],
});
```

Order of operations per request:
`Incoming HTTP → CORS → Helmet → CLS middleware → JWT AuthGuard (sets req.user) → CLS setup (reads req.user) → TenantGuard (asserts cls.get('tenantId')) → DB transaction starts → SET LOCAL app.tenant_id → Controller → Service → Repository → COMMIT`

### 2.3 Propagating across queues, WebSockets, background jobs

| Mechanism | How to propagate `tenantId` |
| --- | --- |
| **BullMQ** | Embed in `job.data.tenantId` (factory pattern, never let consumers build job payloads); worker re-enters CLS with `cls.run({ tenantId: job.data.tenantId }, () => handler(job))` ([dev.to/grommash9](https://dev.to/grommash9/37-alembic-migrations-zero-downtime-how-we-moved-a-live-saas-from-single-tenant-to-multi-tenant-4i6n)) |
| **WebSocket / SSE** | JWT in handshake (`auth.token` for socket.io) or `?token=` for SSE; gateway extracts `tid` and enters CLS context for the connection lifetime ([medium.com/@Quaxel](https://medium.com/@Quaxel/nestjs-multi-tenancy-data-isolation-guardrails-30cb6bfe151c)) |
| **OpenTelemetry baggage** | Set `tenant.id` baggage in API gateway; downstream services read on extract and re-tag spans ([oneuptime.com](https://oneuptime.com/blog/post/2026-01-07-opentelemetry-baggage-propagation/view), 2026) |
| **REST inter-service** | Service-to-service JWT (mTLS-protected) carrying the tenant claim; never re-derive from headers |
| **Message broker (NATS/Kafka)** | Add `tenant_id` to message headers AND payload schema; consumer validates both match |

**Anti-pattern**: Inferring tenant_id from a domain model lookup in worker code (e.g., `loadUser(userId).tenantId`). This re-reads stale data, and any bug in `userId→tenantId` mapping leaks data. **Always propagate the resolved `tenant_id` directly**.

---

## 3. Authentication & Authorization

### 3.1 JWT claims structure (2026)

Standard claim layout for multi-tenant SaaS ([multi-tenant-saas.com](https://www.multi-tenant-saas.com/auth-isolation-cross-tenant-access-control/tenant-aware-jwt-token-management/jwt-claims-for-tenant-scoping-best-practices/); [securitysandman.com](https://securitysandman.com/2026/04/02/building-enterprise-sso-for-my-multi-tenant-saas-ai-agent-platform/), 2026):

```json
{
  "iss": "https://auth.hope.health",
  "sub": "01HXY...",           // user UUID (NOT tenant)
  "aud": "hope-api",            // optionally per-tenant client_id for stronger isolation
  "tid": "01HZX...",           // tenant UUID (custom claim; standardised name)
  "scope": "consult:read consult:write",
  "roles": ["clinician"],       // RBAC roles scoped to THIS tenant
  "claim_ver": 3,              // bump on policy/role change to invalidate cached perms
  "session_id": "sess_...",   // for revocation / impersonation tracking
  "iat": 1748140000,
  "nbf": 1748140000,
  "exp": 1748141200             // ≤ 15 minutes for access tokens
}
```

**Rules of thumb**:

- **Never put tenant in `sub`**. `sub` is the user identity. Conflating breaks audit and re-authentication.
- **`tid` is per-token**, not per-user. A user who belongs to 3 tenants gets 3 different tokens (or uses a token-exchange endpoint to swap `tid`). This prevents "logged in as tenant A, accidentally queries tenant B" bugs.
- **Short-lived access tokens** (5–15 min); rotating refresh tokens with reuse detection (a refresh token used twice → revoke the family).
- **Validate `iss`, `aud`, `exp`, `nbf` on EVERY request**. A single missed audience check has caused 7-figure breaches.
- **`claim_ver` versioning**: store the user's current claim version in DB. On JWT validation, compare `payload.claim_ver` to DB; if stale, force token refresh. This lets you revoke permissions in <15 min without per-request DB lookups.

### 3.2 RBAC vs ABAC vs ReBAC (2026 adoption)

| Model | Engines | When to use | Healthcare fit |
| --- | --- | --- | --- |
| **RBAC** | Built-in | Most use cases; clear "clinician/admin/billing" roles | ✅ Primary model |
| **ABAC** | OPA, Cerbos | Policies need attributes (time, IP, department, MFA-state) | ✅ For dynamic policies |
| **ReBAC** | OpenFGA, AuthZed/SpiceDB | Graph sharing: consultations shared between teams, referrals, care groups | ⚠️ Reserve for complex graphs |

**For HOPE specifically**:
- Primary: **RBAC scoped to tenant** (clinician, nurse, billing-admin, tenant-admin)
- Secondary: **ABAC** for context (e.g., "only same-department clinicians can read PHI", "MFA required for export").
- ReBAC: **defer** until referral/sharing flows demand it. SpiceDB or OpenFGA can be layered later. ([osohq.com/learn](https://www.osohq.com/learn/spicedb-alternatives-authorization-tools-comparison); [authzed.com/learn/rebac-key-components](https://authzed.com/learn/rebac-key-components))

### 3.3 Support impersonation / "break glass"

Pattern from Pigment's engineering blog ([engineering.pigment.com](https://engineering.pigment.com/2026/04/08/safe-user-impersonation/), 2026) and Oracle break-glass spec ([docs.oracle.com](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/autonomous-break-glass.html)):

- Impersonation token has TWO identities:
  - `sub` = impersonated user (used for RLS and permissions)
  - `impersonator_sub` = real human (used for audit attribution)
  - `read_only: true` flag enforced at API gateway by default
- All actions during impersonation are logged with **both** identities.
- Time-limited (≤ 1 hour); auto-rotates secrets on expiry.
- Requires MFA + ticketed reason (`support_ticket_id`).
- "Support sessions" (engineer accesses customer environment for fixes) are distinct from user impersonation and require a separate, audited security pipeline.

For HOPE: critical for HIPAA "minimum necessary" and SOC 2 audit requirements. Build this in from day one, not retrofitted.

---

## 4. Data Layer Patterns with Prisma 7

### 4.1 Middleware (`$use`) is REMOVED — use `$extends`

Prisma 6.14 removed `prisma.$use()` entirely (it had been deprecated since v4.16). Prisma 7 mandates `$extends` (Client Extensions) for tenant scoping. ([github.com/prisma/prisma/issues/27891](https://github.com/prisma/prisma/issues/27891), 2025)

**Two viable patterns**:

#### Pattern A — RLS-only (HOPE's recommended path)

Let RLS do the filtering. The Prisma extension only sets `SET LOCAL app.tenant_id` at the start of each transaction. App code writes "normal" Prisma queries without injecting `where: { tenantId }`.

```typescript
// prisma/tenant-extension.ts
import { Prisma, PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';

export function tenantExtension(cls: ClsService) {
  return Prisma.defineExtension((client) =>
    client.$extends({
      query: {
        $allModels: {
          async $allOperations({ args, query }) {
            const tenantId = cls.get('tenantId');
            if (!tenantId) {
              throw new Error('Missing tenant context — refuse to query');
            }
            // Use a transaction so SET LOCAL is scoped correctly
            return client.$transaction(async (tx) => {
              await tx.$executeRawUnsafe(
                `SET LOCAL app.tenant_id = '${tenantId.replace(/'/g, "''")}'`,
              );
              return query(args);
            });
          },
        },
      },
    }),
  );
}
```

**Caveats**:
- `$transaction` per query is overhead — for read-heavy paths, batch related queries inside a single `prisma.$transaction(async tx => ...)` block at the service layer, and set `SET LOCAL` once.
- Sanitise UUID before interpolation OR use a parameterised `set_config` call: `await tx.$executeRaw\`SELECT set_config('app.tenant_id', ${tenantId}, true)\`` (safer).

#### Pattern B — Automatic `where: { tenantId }` injection

Use `baileywickham/prisma-tenant-extension` (Prisma 7.0+ compatible) for automatic tenant-filter injection at the query layer. Useful when RLS isn't available (e.g., raw Postgres without superuser access during migration).

```typescript
import { tenantExtension } from 'prisma-tenant-extension';
export const prisma = new PrismaClient().$extends(
  tenantExtension({
    tenantField: 'tenantId',
    skipModels: ['Tenant', 'AuditLog'],  // models that legitimately span tenants
    contextProvider: () => cls.get('tenantId'),
  })
);
```

**HOPE recommendation**: Use Pattern A (RLS) as the primary defence. Layer Pattern B on top for defence-in-depth (catches bugs before they hit DB). This is the "two-belt" approach the 2026 healthcare SaaS community recommends. ([emergen.io](https://emergen.io/blog/ensuring-data-isolation-in-multi-tenant-saas-2025-guide))

### 4.2 Connection pooling — Accelerate vs Supavisor vs RDS Proxy vs self-hosted PgBouncer

| Pooler | Managed | Multi-tenant aware | Notes |
| --- | --- | --- | --- |
| **PgBouncer (self-hosted)** | No | No | Standard; HOPE already uses; transaction mode required for serverless app instances |
| **Supavisor** (Supabase) | Yes | Yes (cloud-native multi-tenant) | Designed for proxying millions of clients into stateful pool ([github.com/supabase/supavisor](https://github.com/supabase/supavisor)) |
| **Prisma Accelerate** | Yes | Per-Prisma-project | Globally distributed, ORM-integrated; ties you to Prisma cloud ([prisma.io/docs/accelerate](https://www.prisma.io/docs/accelerate)) |
| **AWS RDS Proxy** | Yes | No | IAM-aware, supports failover; transaction-aware |
| **PgCat** | No | Yes | Rust-based; query routing, sharding |

**For HOPE**: Stay with self-hosted PgBouncer for now (already deployed via Docker Compose / systemd). Migrate to Supavisor if/when tenant count grows >1000 and self-hosting overhead becomes painful. Avoid Accelerate unless willing to depend on Prisma's cloud.

**Critical config for HOPE's PgBouncer**:

```ini
[pgbouncer]
pool_mode = transaction
max_client_conn = 5000        ; per-process
default_pool_size = 25         ; server connections per (user, db) pair
max_db_connections = 200       ; cap total to Postgres
max_user_connections = 50      ; per-tenant cap (if using per-tenant DB users)
server_reset_query =           ; empty for transaction mode
query_timeout = 60             ; reject long queries
query_wait_timeout = 30        ; how long client waits
```

### 4.3 Soft delete, audit, encrypted PII columns

- **Soft delete pattern**: `deleted_at` column + `WHERE deleted_at IS NULL` in RLS policies (chain into the policy USING clause). Critical: even soft-deleted rows must respect tenant_id.
- **Audit columns**: `created_by`, `created_at`, `updated_by`, `updated_at`, `tenant_id` on every PHI-bearing table. Populate via Prisma extension (`query` hook on create/update).
- **Encrypted PII columns**: pgcrypto `pgp_sym_encrypt(...)` with per-tenant data key, key wrapped by KMS CMK. Index a salted HMAC of the plaintext for searchable encryption. ([thecorporate.cloud](https://thecorporate.cloud/architecting-hipaa-ready-multi-tenant-ehrs-patterns-for-clou); [beneficial.cloud](https://beneficial.cloud/designing-hipaa-ready-cloud-ehr-platforms-security-patterns-))

---

## 5. Caching & Redis

### 5.1 Three approaches, ranked

| Approach | Isolation | Scale | Operational cost | When to use |
| --- | --- | --- | --- | --- |
| **Key prefix `tenant:{id}:...`** | App-enforced (logical) | Unlimited tenants | Low | Default |
| **Redis ACL per tenant** (Redis 6+) | Server-enforced | Unlimited; works in cluster | Medium | Compliance / sensitive workloads |
| **Database 0–15** | Logical | Max 16 tenants | Low | **Don't** — doesn't scale |
| **Separate Redis instance** | Physical | Unlimited | High | Premium/enterprise tier |

**For HOPE**: Combine prefix + ACL. Free-tier and standard hospital tenants share a Redis with `~tenant:{id}:* &tenant:{id}:*` ACL per tenant. Enterprise tenants get a dedicated Redis instance. ([oneuptime.com](https://oneuptime.com/blog/post/2026-03-31-redis-how-to-implement-tenant-isolation-in-redis/view), 2026; [redis.io/docs](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/))

### 5.2 Tenant-aware Redis client (mandatory abstraction)

```typescript
class TenantRedis {
  constructor(private redis: Redis, private cls: ClsService) {}

  private k(key: string): string {
    const tid = this.cls.get('tenantId');
    if (!tid) throw new Error('Missing tenant context for Redis');
    return `t:${tid}:${key}`;
  }

  get(key: string)  { return this.redis.get(this.k(key)); }
  set(key: string, val: string, opts?: SetOptions) { return this.redis.set(this.k(key), val, opts); }
  // ... scan, hget, etc. — ALL go through this.k()
}
```

**Never** expose the raw Redis client to services. Centralising key construction prevents "I forgot the prefix" bugs that are the #1 source of cache cross-tenant leaks. ([metaeye.co.uk](https://www.metaeye.co.uk/multi-tenant-saas-isolation-patterns-for-data))

### 5.3 Key namespace hierarchy

Standard 2026 schema: `t:{tenant}:{service}:{entity}:{id}:{attribute}`

```
t:acme:sessions:u-001:profile
t:acme:consults:c-100:transcript
t:acme:vox:audio-buffer:c-100
t:acme:ratelimit:api:user-001
```

The leading `t:` makes tenant-scoped keys grep-able and bulk-cleanable (`SCAN MATCH t:acme:*` for tenant offboarding).

### 5.4 Cache invalidation

- **Tenant-scoped invalidation events** via Redis Pub/Sub: `PUBLISH t:{tid}:invalidate "users"`.
- For inter-service propagation, attach `tenant_id` to the message.
- Always include tenant in the lock key for distributed locks (`SET t:{tid}:lock:{resource} ...`).

---

## 6. Domain-Driven Design (DDD) for Multi-Tenant

### 6.1 Where does tenant context belong?

The 2026 community consensus, drawing from Vaughn Vernon and Greg Young:

| Choice | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **`TenantId` on every aggregate root** | Explicit, type-safe, can't forget | Boilerplate | ✅ **Preferred** |
| **Ambient context (CLS)** | Less boilerplate | Hard to test; "spooky action at a distance" | ⚠️ Use for cross-cutting (logs, repos) but not for domain invariants |
| **Implicit (no field; DB enforces)** | Cleanest domain model | Breaks if DB layer changes; can't reason about cross-tenant ops | ❌ Avoid |

**Recommended hybrid for HOPE**:
- Aggregate roots carry an immutable `TenantId` value object as a first-class field.
- Factories require `TenantId` as a constructor parameter.
- Repositories use ambient CLS to scope queries (and DB RLS as backstop).
- Domain events include `tenantId` as a top-level field (for routing in event bus / outbox).

### 6.2 Repository pattern

```typescript
interface IConsultationRepository {
  // No tenantId param — repository reads from CLS + DB RLS enforces
  findById(id: ConsultationId): Promise<Consultation | null>;
  save(c: Consultation): Promise<void>;
  findByPatient(patientId: PatientId): Promise<Consultation[]>;
}

// Cross-tenant variant for platform/admin operations — DIFFERENT INTERFACE, DIFFERENT TYPE
interface IPlatformConsultationRepository {
  findByIdAcrossTenants(id: ConsultationId, requestingAdmin: AdminId): Promise<Consultation | null>;
  // Every method requires explicit AdminId for audit; bypasses tenant filter using a separately-permissioned DB role
}
```

Splitting the interfaces makes cross-tenant operations grep-able. Code reviews can flag any service that imports `IPlatformConsultationRepository` for extra scrutiny. ([medium.com/@Quaxel](https://medium.com/@Quaxel/nestjs-multi-tenancy-data-isolation-guardrails-30cb6bfe151c))

### 6.3 Domain events + outbox

- Outbox pattern: domain events written to an `outbox` table in the SAME transaction as the aggregate. A separate worker dispatches.
- The outbox row carries `tenant_id` and the event payload also embeds it. Consumers receive `(tenant_id, event)` and enter CLS context before handling.
- For tenant-deletion safety: outbox writes are RLS-protected too; if a delete cascades, in-flight events are deleted with the rest.

---

## 7. API Design for Multi-Tenant

### 7.1 URL conventions

| Style | Example | Verdict for HOPE |
| --- | --- | --- |
| Subdomain | `acme.hope.health/api/v1/consults` | ✅ For browser app login flow |
| Path | `/api/v1/tenants/{tid}/consults` | ✅ For admin/back-office / SDK |
| Header-only | `GET /api/v1/consults` with JWT | ✅ For internal services |

Often you'll use all three. Cross-check tenant in path against tenant in JWT — mismatches return 403 generically. ([harborsoftware.com](https://harborsoftware.com/2025/01/10/authentication-patterns-multi-tenant-saas-applications/), 2025)

### 7.2 Rate limiting per tenant

Stripe-style Redis token bucket with tenant dimension ([stripe.com/blog/rate-limiters](https://stripe.com/blog/rate-limiters); [redis.io/docs](https://redis.io/docs/latest/develop/use-cases/rate-limiter/)):

```lua
-- KEYS[1] = rate:tenant:{tid}:{rule}
-- ARGV[1] = capacity, ARGV[2] = refill_rate, ARGV[3] = now_ms, ARGV[4] = cost
-- Returns {allowed, remaining, retry_after_ms}
```

Three-tier limits typical for healthcare SaaS:
- Global (per-tenant): `1000 req/s` for enterprise, `100 req/s` standard.
- Per-endpoint within tenant: `/api/v1/consults` heavier than `/api/v1/lookups`.
- Per-user within tenant: `60 req/min` for human-facing endpoints; bypass for service-to-service.

### 7.3 Webhooks

- Sign with HMAC-SHA256 using a **per-tenant signing key** (not a global key). Rotate via "active + pending" key window.
- Include `X-Tenant-Id` and `X-Event-Id` in headers.
- Idempotency: dedupe on `event_id` for 24h in Redis (`SET t:{tid}:webhook-evt:{id} 1 NX EX 86400`).

### 7.4 WebSocket / SSE auth

- Pass JWT in handshake (`auth: { token }` for socket.io). For SSE, accept token via `?token=` query param since EventSource can't set headers. ([medium.com/@odenigbo67](https://medium.com/@odenigbo67/a-guide-to-using-server-sent-events-sse-with-nestjs-5e28de80617a))
- Connection-level: on handshake, verify JWT, extract `tid`, store in socket data, refuse any cross-tenant room joins.
- Disconnect on token expiry (track `exp`); require re-auth.

### 7.5 OpenAPI documentation

- Document tenant resolution explicitly in `info.description` and per-tag overviews.
- Use OpenAPI `securitySchemes.bearerAuth` plus a `tenantId` request-context note.
- For per-tenant feature flags affecting API surface, generate the spec dynamically (or document optional endpoints clearly).

---

## 8. Frontend SDK Multi-Tenancy (`@arcaai/vox`)

### 8.1 SDK tenant context

```typescript
const vox = new Vox({
  tenantId: 'acme',         // immutable for the SDK instance
  apiKey: '...',             // tenant-scoped
  region: 'eu-west-1',       // for data residency
});
```

- **Do not** support runtime tenant switching on the same SDK instance. Force `vox.dispose()` + `new Vox()` for tenant changes. This prevents state leaks between tenants in long-lived browser sessions.
- The SDK's audio pipeline (VAD, STT, noise filter) holds buffers in `AudioWorklet` — disposal must explicitly clear those.

### 8.2 Browser storage isolation

- **Cookies**: scope to `tenant.hope.health` subdomain. Avoid `*.hope.health` cookies for tenant-bound data.
- **localStorage**: prefix every key (`hope:t:{tid}:...`). Provide an SDK utility (`vox.storage.set/get`) that auto-prefixes.
- **IndexedDB**: name databases `hope-{tid}` (one IDB per tenant) — IDB is origin-scoped, but isolation within origin is your responsibility.
- **SharedWorker / ServiceWorker**: SWs are origin-scoped and can leak across tenants. Either avoid for tenant data, or include `tenantId` in every postMessage and verify.

### 8.3 WebRTC / TURN credentials per tenant

Use RFC 8489 ephemeral TURN credentials. ([callsphere.ai/blog](https://callsphere.ai/blog/vw8e-webrtc-signaling-jwt-vs-ephemeral-tokens-2026), 2026; [coturn README](https://github.com/coturn/coturn/blob/master/README.turnserver))

```
POST /api/v1/turn-credentials
  Authorization: Bearer <JWT with tenant claim>
  → { iceServers: [{ urls: [...], username: "1748143000:tenant_acme", credential: "<HMAC-SHA1>" }], ttl: 1800 }
```

- coturn: `use-auth-secret`, `static-auth-secret` shared with the backend; backend computes `username = exp_ts:tenant_id`, `password = base64(HMAC-SHA1(secret, username))`.
- TTL: 5–30 minutes for short sessions; refresh ahead of expiry.
- Per-tenant rate limiting on the credentials endpoint.
- Optionally a separate coturn pool per high-volume tenant for capacity isolation.

### 8.4 Per-tenant feature flags

LaunchDarkly **multi-context** model is the 2026 standard ([launchdarkly.com/docs](https://launchdarkly.com/docs/home/flags/multi-contexts); [launchdarkly.com/blog](https://launchdarkly.com/blog/managing-entitlements-in-launchdarkly/)):

```typescript
const context = {
  kind: 'multi',
  user: { key: userId, role: 'clinician' },
  tenant: { key: tenantId, plan: 'enterprise', region: 'eu' },
};
const enabled = await ldClient.variation('vox.ml-noise-filter-v2', context, false);
```

GrowthBook supports a similar pattern via attributes (`user.id`, `org.id`). Open-source-friendly alternative.

For HOPE's healthcare-specific flags (e.g., "EHR integration X enabled for tenant"), keep flags in the DB as the source of truth and sync to the flag service to avoid drift between billing/entitlements and runtime behaviour.

---

## 9. Observability & Compliance

### 9.1 Per-tenant metrics

- **Prometheus label**: `tenant_id="..."` on tenant-relevant metrics ONLY. Do not add to high-cardinality counters or you get cardinality explosion. ([oneuptime.com](https://oneuptime.com/blog/post/2026-02-09-prometheus-relabeling-high-cardinality/view), 2026)
- **Drop high-cardinality labels at scrape**:
  ```yaml
  metricRelabelings:
    - regex: '(user_id|session_id|request_id|consult_id|trace_id|span_id)'
      action: labeldrop
  ```
- **Per-tenant rate limits in Mimir / Cortex** (if you outgrow single Prometheus):
  - `ingestion_rate`, `max_global_series_per_user`, `max_label_value_length` per tenant. ([mylinux.work/guides/prometheus-multi-tenancy](https://mylinux.work/guides/prometheus-multi-tenancy/))
- **Query-time isolation**: `prom-label-proxy` enforces `namespace=tenantX` on all PromQL queries.

### 9.2 Logging

- Pino structured logs with `tenantId` and `userId` as top-level fields.
- **Redact PII**: configure Pino's `redact` paths for `req.body.email`, `req.body.ssn`, etc. Be aggressive — better to over-redact for HIPAA than to leak.
- Ship logs to a per-tenant index OR a shared index with strict ACL by `tenantId`.

### 9.3 Distributed tracing

W3C Baggage `tenant.id` propagation (and `tenant.tier`, `tenant.region` if useful). ([oneuptime.com](https://oneuptime.com/blog/post/2026-01-07-opentelemetry-baggage-propagation/view), 2026)

Rules:
- **Set baggage at the API gateway**, the earliest entry point.
- **Validate / allowlist baggage on ingress** — never trust external baggage from untrusted sources.
- **Never put PII in baggage** — only IDs and references.
- **Copy baggage to span attributes** at every service boundary so spans are searchable per tenant.

### 9.4 Audit trails (HIPAA / SOC 2)

- **Append-only audit log**: a dedicated table or service. No UPDATE, no DELETE — enforce via Postgres triggers or service ACL.
- **Hash chain** for tamper-evidence: `curr_hash = SHA-256(prev_hash || canonical_event_json)`. Verify chain on demand. ([dev.to/beck_moulton](https://dev.to/beck_moulton/immutable-by-design-building-tamper-proof-audit-logs-for-health-saas-22dc); [github.com/xraph/chronicle](https://github.com/xraph/chronicle))
- **Per-tenant chain**: separate hash chain per `tenant_id` so cross-tenant queries are structurally impossible.
- **External anchoring**: periodically publish the chain head hash to an append-only external store (Git, S3 Object Lock) to make rewrites detectable even if the DB is compromised. ([github.com/Ashish-Barmaiya/attest](https://github.com/Ashish-Barmaiya/attest))
- **WORM storage** for archived logs: S3 Object Lock in compliance mode (cannot be deleted even by root). ([pub.towardsai.net](https://pub.towardsai.net/the-builders-notes-building-hipaa-compliant-audit-logging-from-scratch-968cafd16faa))

### 9.5 HIPAA / SOC 2 / ISO 27001 considerations

- **BAA boundary**: every sub-processor (Sentry, Datadog, OpenAI, Anthropic, ElevenLabs) handling PHI must be under BAA. If not, route around them or scrub.
- **Encryption at rest**: KMS CMK per tenant (or per-tenant-group for cost reasons). Envelope encryption (DEK wrapped by KEK).
- **Encryption in transit**: TLS 1.2+ end-to-end, mTLS for inter-service.
- **IAM "minimum necessary"**: clinicians see only their patients; tenant-admins don't see PHI by default.
- **Incident response**: tested runbooks; per-tenant impact reporting.

---

## 10. Operational Concerns

### 10.1 Migration: adding `tenant_id` to existing tables

Use the **expand-migrate-contract** pattern. ([dev.to/grommash9](https://dev.to/grommash9/37-alembic-migrations-zero-downtime-how-we-moved-a-live-saas-from-single-tenant-to-multi-tenant-4i6n); [michal-drozd.com](https://www.michal-drozd.com/en/blog/zero-downtime-postgresql-migrations/))

**Phase 1 — Expand (zero downtime)**
```sql
ALTER TABLE consultations ADD COLUMN tenant_id UUID NULL;  -- nullable, no default
CREATE INDEX CONCURRENTLY idx_consultations_tenant ON consultations(tenant_id);
```

**Phase 2 — Backfill (batched)**
```sql
-- Loop with batches; use SKIP LOCKED for concurrency safety
WITH batch AS (
  SELECT id FROM consultations WHERE tenant_id IS NULL LIMIT 10000 FOR UPDATE SKIP LOCKED
)
UPDATE consultations c SET tenant_id = u.tenant_id
FROM batch b JOIN users u ON u.id = c.user_id WHERE c.id = b.id;
```
Schedule via `pg_cron` every 15min until backfill complete.

**Phase 3 — Dual write (app deploy)**
- App writes `tenant_id` on all new rows.
- Reads still tolerate NULL during this window.

**Phase 4 — Constrain & enable RLS**
```sql
ALTER TABLE consultations ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE consultations ADD CONSTRAINT consultations_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) NOT VALID;  -- avoid lock; validate later
ALTER TABLE consultations VALIDATE CONSTRAINT consultations_tenant_fk;
ALTER TABLE consultations ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultations FORCE ROW LEVEL SECURITY;
CREATE POLICY ... ;
```

**Phase 5 — Contract (drop legacy code)**

For HOPE: many tables likely lack `tenant_id` today. Plan this as a multi-week roadmap with one table at a time, with integration tests that prove cross-tenant queries return zero rows.

### 10.2 Tenant deletion (GDPR right-to-erasure)

- **Soft delete + 30-day grace period** ([cadence.withremote.ai/blog/data-deletion-gdpr](https://cadence.withremote.ai/blog/data-deletion-gdpr); [wolf-tech.io](https://wolf-tech.io/blog/gdpr-right-to-erasure-engineering-deleting-users-from-complex-saas-systems)):
  1. Mark tenant deleted, revoke all sessions, stop billing.
  2. Hold for 30 days (CCPA: 45). Allow recovery.
  3. Hard delete with CASCADE.
  4. Fan-out delete to all sub-processors (Stripe, Sentry, Datadog, OpenAI logs, vector DBs).
  5. Write tombstone audit record (hashed, no PII).
- **Backups**: cannot literally rewrite snapshots. Use **crypto-shredding**: when key per tenant is destroyed in KMS, data in backups becomes unreadable. Combine with delete-on-restore (an "erasure ledger" replays the delete if a backup is restored). ([oneuptime.com](https://oneuptime.com/blog/post/2026-02-17-how-to-set-up-crypto-shredding-for-gdpr-right-to-erasure-compliance-in-google-cloud/view), 2026)
- **Audit logs**: do NOT delete. Anonymise actor identifiers (replace `user_id` with a destroyed-key pseudonym). Article 17(3)(b) exempts retention for legal claims.
- **Vector DBs / embeddings**: must delete embeddings derived from PHI. Maintain a `tenant_id` metadata field; bulk delete by namespace (Pinecone) or by RLS filter (pgvector). ([aws.amazon.com/blogs/database](https://aws.amazon.com/blogs/database/self-managed-multi-tenant-vector-search-with-amazon-aurora-postgresql/); [docs.pinecone.io](https://docs.pinecone.io/guides/index-data/implement-multitenancy))

### 10.3 Tenant export (data portability)

- Provide JSON/CSV export endpoint with rate limiting.
- Include all entities owned by the tenant — consultations, transcripts, audio recordings (or signed URLs with expiry), audit log.
- Use streaming export to avoid OOM on large tenants.
- Cryptographically sign the export bundle so it's tamper-evident on receipt.

### 10.4 Tenant onboarding / offboarding automation

- Idempotent provisioning: a `provisionTenant(tenantId, plan)` script that creates DB rows, KMS keys, Redis ACL user, OTel tenant config, feature flag context, billing customer.
- Same for deprovisioning, with explicit checklist of every resource to clean.

### 10.5 Noisy-neighbour mitigations

| Layer | Mitigation |
| --- | --- |
| DB connections | PgBouncer `max_user_connections` per tenant; per-tier pool sizes |
| DB queries | `statement_timeout` per tenant tier (Enterprise 60s, Standard 15s); kill long-running queries |
| API rate limits | Token bucket per tenant (Stripe pattern); weighted fair queuing for free-tier |
| Background jobs | Dedicated BullMQ queues for enterprise tenants OR fair-share scheduler |
| Storage | Per-tenant quota at object store with alerting |
| Network | Per-tenant egress quotas (especially for STT/TTS bandwidth-heavy services) |

([neon.com/blog/noisy-neighbor-multitenant](https://neon.com/blog/noisy-neighbor-multitenant); [pingcap.com/playbook-noisy-neighbor-multi-tenant-mysql](https://www.pingcap.com/playbook-noisy-neighbor-multi-tenant-mysql/))

### 10.6 Backup / restore — tenant-aware

- Per-tenant logical backups (`pg_dump --table` filtered by `tenant_id` via `COPY ... WHERE`) for selective restore.
- Tenant-restore: drop tenant rows, restore from backup, replay outbox events since backup point.
- Test restore monthly; capture timing for SLA reporting.

---

## 11. Common Anti-Patterns to Flag in 2025–2026

Cross-referenced from multiple 2025–2026 sources ([emergen.io](https://emergen.io/blog/ensuring-data-isolation-in-multi-tenant-saas-2025-guide); [metaeye.co.uk](https://www.metaeye.co.uk/multi-tenant-saas-isolation-patterns-for-data); [clerk.com](https://clerk.com/blog/what-are-the-risks-and-challenges-of-multi-tenancy); [borabastab.medium.com](https://borabastab.medium.com/six-shades-of-multi-tenant-mayhem-the-invisible-vulnerabilities-hiding-in-plain-sight-182e9ad538b5); [dev.to/bilelsalemdev](https://dev.to/bilelsalemdev/multi-tenancy-layer-by-layer-from-row-level-security-to-whole-cluster-isolation-4650)):

| # | Anti-pattern | Why it fails | Right answer |
| --- | --- | --- | --- |
| 1 | "We'll add `WHERE tenant_id` in services later" | Refactors, new joins, raw queries, and AI-generated CRUD always miss filters | RLS at DB; treat app filter as defence-in-depth |
| 2 | Trust `tenant_id` from query string / body | Trivially forgeable; classic IDOR vulnerability | Read `tenant_id` from JWT only |
| 3 | Trust `X-Tenant-Id` from external client | Headers are stripped/injected by proxies | Same — JWT only |
| 4 | Admin "god mode" connection with `BYPASSRLS` reused for background jobs | One mis-routed job leaks across tenants | Separate connection / role per use; gate with permissions |
| 5 | `SET app.tenant_id = ...` (no `LOCAL`) with PgBouncer transaction mode | Next request inherits previous tenant | `SET LOCAL` (or `set_config(_, _, true)`) inside transaction |
| 6 | `tenant_id` as plain integer | Enumeration attacks; IDOR | UUIDv7 / ULID; never expose internal IDs in URLs |
| 7 | Cache key without tenant prefix | Cache poisoning / wrong-tenant reads | Mandatory tenant-aware Redis client |
| 8 | Background job reads tenant from associated user instead of carrying explicit `tenantId` | Stale data; bugs in user→tenant map leak | Job payload always carries `tenantId`; worker re-enters CLS |
| 9 | Cross-tenant joins in admin tools using a privileged DB connection | Reports run as superuser bypass RLS, no audit trail | Separate platform-admin role with audit logging; never re-use |
| 10 | High-cardinality tenant labels in Prometheus on every metric | Cardinality bomb; OOM | Label only on per-tenant-relevant metrics; relabel drop in scrape config |
| 11 | Vector DB / RAG context bleed | Embeddings shared across tenants surface other tenant's PHI in completions | Namespace / RLS per tenant on embeddings table; never share retrieval indexes |
| 12 | LLM context window contamination | Concatenating system prompt + few-shot examples drawn from other tenants | Strict tenant-scoped retrieval; never cache LLM responses across tenants |
| 13 | "Soft delete" treated as GDPR erasure | `deleted_at` is not erasure; data still readable | Hard delete + crypto-shred + sub-processor fan-out |
| 14 | One shared TURN credential | Leaked credential = anyone's TURN | RFC 8489 ephemeral creds per tenant per session |
| 15 | Single global rate limit | One tenant exhausts capacity for all | Per-tenant limit + tier-aware quotas |

---

## Quick-Win Recommendations (Bare-Minimum, High-Impact for HOPE)

These are the things HOPE should implement in the next 4–8 weeks. They are cheap, fast, and dramatically reduce blast radius.

### QW1. Enable RLS on the top 5 PHI-bearing tables
- Add `tenant_id UUID NOT NULL` if missing (expand/migrate/contract).
- `FORCE ROW LEVEL SECURITY` + four policies per table.
- Create a `hope_app` role with `NOSUPERUSER NOBYPASSRLS`; route app traffic through it.
- Verify with 3 integration tests per table: cross-tenant `SELECT` returns 0 rows; cross-tenant `INSERT` raises; `UPDATE tenant_id` raises.

### QW2. Adopt `nestjs-cls` for tenant context propagation
- Replace any `Scope.REQUEST` tenant providers with CLS.
- Middleware order: JWT guard → CLS setup → TenantGuard.
- `TenantGuard` refuses (403) if `cls.get('tenantId')` is undefined.

### QW3. Tenant-aware Redis client wrapper
- All Redis access goes through `TenantRedis` with mandatory `t:{tid}:` prefix.
- Static-analysis rule (custom ESLint or grep CI check) banning raw `redis.set(...)` outside the wrapper.

### QW4. BullMQ job-factory pattern with tenantId in payload
- A `JobDispatcher` service that requires `cls.get('tenantId')` and injects it.
- Workers re-enter CLS context from `job.data.tenantId`.
- Fail-closed: missing `tenantId` → dead-letter queue with alert.

### QW5. OpenTelemetry `tenant.id` baggage + Pino tag
- Add `tenant.id` to baggage in API gateway middleware.
- Add `tenant_id` and `user_id` as Pino base fields.
- Drop / redact PII fields in Pino `redact` config.

### QW6. Per-tenant Stripe rate-limiter (Redis Lua)
- Token-bucket keyed by `rate:t:{tid}:{endpoint}`.
- Tier-aware capacity (look up tenant plan once at JWT validation, cache 5 min).
- Default deny for missing tenant context.

### QW7. JWT hardening
- Audit JWT issuance code: ensure `tid` claim exists, `iss`/`aud`/`exp` validated.
- Implement `claim_ver` versioning to support sub-15-min revocation.
- Cut access-token TTL to 15 min; rotate refresh tokens with reuse detection.

### QW8. Audit log table + hash chain
- Create `audit_events` table with `tenant_id`, `actor_user_id`, `actor_impersonator_id`, `prev_hash`, `curr_hash`, `payload_json`.
- Insert from a trigger on every PHI table OR from a NestJS interceptor.
- Verify chain integrity nightly; alert on mismatch.

### QW9. Per-tenant ACL on Redis
- Enable Redis ACL; per-tenant user `~t:{tid}:* &t:{tid}:*` (Redis 6.2+).
- Eliminates "missing prefix" as a security risk; demotes it to availability.

### QW10. Cross-tenant integration tests in CI
- A `tests/multi-tenancy/` suite that creates 2 tenants, exercises every endpoint, asserts each tenant sees only own data.
- Run on every PR; block merges on failure.

---

## Strategic Recommendations (Deeper Investments)

For the 6–18 month roadmap.

### S1. Per-tenant KMS CMK (envelope encryption for PHI)
- Per-tenant key in AWS KMS / GCP KMS / Azure Key Vault.
- Encrypt PHI columns with a per-row DEK wrapped by tenant KEK.
- Crypto-shredding becomes one-line: destroy KEK → all backups & archives unreadable.
- Significant cost ($1/month/key in AWS) — consider per-tenant-tier grouping.

### S2. Hybrid Pool + Silo for enterprise tenants
- Add a `tenant_tier` column; enterprise tenants are routed to dedicated DB instance via per-tenant DB connection string in tenant config.
- Operational tooling: shared schema migrations applied to all instances; per-tenant migration runner.

### S3. Cross-service mTLS + service mesh
- mTLS for API ↔ NLP/TTS/SMR/STT.
- Embed tenant claim in service-to-service JWTs; pin `aud`.
- Consider Linkerd / Istio for HOPE Docker Compose deployment; or Nginx with client certs.

### S4. ReBAC engine for sharing graphs
- Adopt OpenFGA (or SpiceDB) for: cross-team consultation sharing, referrals, multi-clinic care groups.
- Layer on top of RBAC; tenant_id still gates ALL queries first.

### S5. WORM audit storage with external anchoring
- Daily snapshot of audit log hash chain head to S3 Object Lock (compliance mode) AND a tamper-evident Git repo.
- Quarterly external audit verifies anchors match DB state.

### S6. Multi-region data residency
- EU / Singapore deployment with per-region API endpoints.
- Tenant config: `region` field; route to regional cluster; LLM/STT/TTS calls pinned to regional providers (Azure OpenAI EU, ElevenLabs EU).
- Required for many EU healthcare contracts post-Schrems II.

### S7. Tenant-aware Prometheus / Mimir
- Migrate from single Prometheus to Mimir or Cortex with `X-Scope-OrgID` per tenant.
- Per-tenant ingestion limits and retention.
- Grafana org-per-tenant for self-service dashboards.

### S8. Vector DB tenant isolation (`@arcaai/vox` retrieval)
- If using pgvector: `tenant_id` column + RLS on embeddings table.
- If using Pinecone: namespace-per-tenant.
- For RAG pipelines: tenant ID is a non-negotiable filter at retrieval time AND a check on every retrieved chunk in the LLM prompt assembly.

### S9. SDK telemetry / SDK auto-redaction
- `@arcaai/vox` should never send audio buffers or transcripts to telemetry by default.
- Opt-in instrumentation with explicit user consent (HIPAA).
- All telemetry includes `tenant_id` for per-customer dashboards.

### S10. Continuous compliance automation
- Drata / Vanta integration for SOC 2 evidence collection.
- IaC scanners (Checkov, tfsec) in CI.
- Continuous BAA inventory of sub-processors.

---

## Consolidated References

### Authoritative — PostgreSQL & RLS
- [PgBouncer Configuration](https://pgbouncer.org/config.html)
- [PostgreSQL RLS — A Complete Guide (rivestack.io)](https://rivestack.io/blog/postgresql-row-level-security)
- [Postgres RLS for SaaS — Cadence (2026)](https://cadence.withremote.ai/blog/postgres-rls-saas)
- [Postgres RLS — 2026 SaaS Default](https://datasofttechnologies.com/blog/why-postgres-row-level-security-is-quietly-becoming-the-default-for-multi-tenant-saas-in-2026)
- [RLS in PostgreSQL: SaaS tenant isolation — MVP Factory](https://mvpfactory.io/blog/row-level-security-in-postgresql-multi-tenant-data-isolation-for-your-saas/)
- [RLS sounds great until it isn't — PlanetScale](https://dev.to/planetscale/rls-sounds-great-until-it-isnt-4d5p)

### Prisma 7
- [Prisma Client extensions — official docs](https://www.prisma.io/docs/orm/prisma-client/client-extensions)
- [Prisma Client extensions: query component](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query)
- [Removal of `$use` in Prisma 6.14 (Issue #27891)](https://github.com/prisma/prisma/issues/27891)
- [prisma-tenant-extension (baileywickham)](https://github.com/baileywickham/prisma-tenant-extension)
- [Prisma Accelerate connection pooling](https://www.prisma.io/docs/accelerate)
- [Comparing Accelerate to other connection pools](https://www.prisma.io/docs/v6/accelerate/compare)
- [Prisma Postgres connection pooling](https://www.prisma.io/docs/postgres/database/connection-pooling)

### NestJS & AsyncLocalStorage
- [nestjs-cls (Papooch)](https://github.com/Papooch/nestjs-cls/)
- [NestJS Request Context Problem (2026 Production Blueprint)](https://pas7.com.ua/blog/en/nestjs-request-context-als-2026)
- [Multi-tenant RLS with AsyncLocalStorage in NestJS — Martin Frič](https://martinfric.dev/blog/posts/multi-tenant-rls-als-nestjs)
- [Per-Request DB Transactions with NestJS](https://aaronboman.com/programming/2024/07/12/per-request-database-transactions-with-nestjs/)
- [NestJS Multi-Tenancy: Data Isolation Guardrails (Quaxel)](https://medium.com/@Quaxel/nestjs-multi-tenancy-data-isolation-guardrails-30cb6bfe151c)

### AWS SaaS architecture
- [AWS Multi-Tenant Architectures Guidance](https://docs.aws.amazon.com/solutions/multi-tenant-architectures-on-aws/)
- [Choose the right PostgreSQL data access pattern for your SaaS application — AWS](https://aws.amazon.com/blogs/database/choose-the-right-postgresql-data-access-pattern-for-your-saas-application/)
- [AWS SaaS Lens — Bridge Model](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/bridge-model.html)
- [SaaS Multi-Tenancy on AWS: Silo vs Pool vs Bridge](https://www.factualminds.com/blog/saas-multi-tenancy-on-aws-silo-vs-pool-vs-bridge-model/)
- [AWS Lambda Tenant Isolation Mode (2026)](https://nitrix-reloaded.com/2026/02/28/aws-lambda-tenant-isolation-mode-multi-tenant-saas-2/)

### Authorization (RBAC / ABAC / ReBAC)
- [AuthZed/SpiceDB consistency model](https://authzed.com/docs/spicedb/concepts/consistency)
- [OpenFGA query consistency modes](https://openfga.dev/docs/interacting/consistency)
- [ReBAC components — AuthZed](https://authzed.com/learn/rebac-key-components)
- [Top Alternatives to SpiceDB — Oso](https://www.osohq.com/learn/spicedb-alternatives-authorization-tools-comparison)

### Authentication / JWT
- [JWT Claims for Tenant Scoping](https://www.multi-tenant-saas.com/auth-isolation-cross-tenant-access-control/tenant-aware-jwt-token-management/jwt-claims-for-tenant-scoping-best-practices/)
- [Authentication Patterns for Multi-Tenant SaaS — Harbor Software](https://harborsoftware.com/2025/01/10/authentication-patterns-multi-tenant-saas-applications/)
- [Multi-Tenant Auth with Cognito & RLS](https://dev.to/josh_blair/multi-tenant-auth-with-cognito-and-postgresql-row-level-security-part-2-5d30)
- [Enterprise SSO for Multi-Tenant SaaS AI Platform (2026)](https://securitysandman.com/2026/04/02/building-enterprise-sso-for-my-multi-tenant-saas-ai-agent-platform/)
- [Impersonation Done Right — Pigment Engineering (2026)](https://engineering.pigment.com/2026/04/08/safe-user-impersonation/)
- [Oracle Break Glass Access for SaaS](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/autonomous-break-glass.html)

### Redis multi-tenancy
- [Redis tenant isolation strategies](https://oneuptime.com/blog/post/2026-03-31-redis-how-to-implement-tenant-isolation-in-redis/view)
- [Redis ACL multi-tenancy](https://oneuptime.com/blog/post/2026-03-31-redis-multi-tenancy-with-redis-acls/view)
- [Redis key namespace design for multi-tenant](https://oneuptime.com/blog/post/2026-03-31-redis-key-namespaces-multi-tenant/view)
- [Redis ACL — official docs](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/)

### Observability
- [Instrumenting SaaS Multi-Tenant with OpenTelemetry (2026)](https://oneuptime.com/blog/post/2026-02-06-instrument-saas-multi-tenant-application-opentelemetry/view)
- [OpenTelemetry Baggage Propagation (2026)](https://oneuptime.com/blog/post/2026-01-07-opentelemetry-baggage-propagation/view)
- [Tenant-Aware Telemetry Routing](https://oneuptime.com/blog/post/2026-02-06-tenant-aware-telemetry-routing-multi-tenant/view)
- [Multi-tenant Prometheus on Kubernetes](https://konst.fish/blog/multi-tenant-prometheus-on-kubernetes)
- [prom-label-proxy](https://github.com/prometheus-community/prom-label-proxy)
- [Multi-Tenancy in Prometheus & Mimir](https://mylinux.work/guides/prometheus-multi-tenancy/)
- [Drop High-Cardinality Labels — Prometheus](https://oneuptime.com/blog/post/2026-02-09-prometheus-relabeling-high-cardinality/view)

### HIPAA / Compliance
- [HIPAA-Ready Multi-Tenant EHR Architecture](https://thecorporate.cloud/architecting-hipaa-ready-multi-tenant-ehrs-patterns-for-clou)
- [HIPAA-Ready Cloud EHR Security Patterns](https://beneficial.cloud/designing-hipaa-ready-cloud-ehr-platforms-security-patterns-)
- [Multi-Tenant Isolation Patterns for Allscripts Hosting](https://allscripts.cloud/network-and-tenant-isolation-patterns-for-multi-tenant-allsc)
- [Building HIPAA-Compliant Audit Logging from Scratch](https://pub.towardsai.net/the-builders-notes-building-hipaa-compliant-audit-logging-from-scratch-968cafd16faa)
- [Immutable by Design — Tamper-Proof Audit Logs](https://dev.to/beck_moulton/immutable-by-design-building-tamper-proof-audit-logs-for-health-saas-22dc)
- [Multi-Tenant AI Agent Architectures (Omnithium)](https://dev.to/omnithium/multi-tenant-ai-agent-architectures-isolation-routing-and-data-safety-272k)

### GDPR / Erasure
- [GDPR Right-to-Erasure Engineering — Wolf Tech](https://wolf-tech.io/blog/gdpr-right-to-erasure-engineering-deleting-users-from-complex-saas-systems)
- [How to handle data deletion — Cadence](https://cadence.withremote.ai/blog/data-deletion-gdpr)
- [Crypto-Shredding for GDPR (Google Cloud)](https://oneuptime.com/blog/post/2026-02-17-how-to-set-up-crypto-shredding-for-gdpr-right-to-erasure-compliance-in-google-cloud/view)
- [GDPR Erasure Without Breaking Your System](https://gdprscorecheck.com/blog/gdpr-erasure-requests-guide)
- [SaaS GDPR Engineering](https://viprasol.com/blog/saas-gdpr-engineering/)

### Audit logging
- [Chronicle (xraph) — SHA-256 hash chain audit](https://github.com/xraph/chronicle)
- [Attest — multi-tenant append-only audit](https://github.com/Ashish-Barmaiya/attest)
- [TenantAudit — append-only with hash chain](https://github.com/0745vipno-png/tenantaudit)

### Queues / BullMQ
- [Node.js Job Queues in Production: BullMQ](https://dev.to/axiom_agent/nodejs-job-queues-in-production-bullmq-bull-and-worker-threads-3c35)
- [Dispatching Jobs, Flows, and Schedules with BullMQ (auxx.Ai)](https://auxx.ai/blog/bullmq-job-queue-architecture-part-2)

### Rate limiting
- [Stripe — Scaling your API with rate limiters](https://stripe.com/blog/rate-limiters)
- [Redis rate limiter docs](https://redis.io/docs/latest/develop/use-cases/rate-limiter/)
- [Token bucket rate limiter with Redis (Rust example)](https://redis.io/docs/latest/develop/use-cases/rate-limiter/rust/)
- [Distributed rate limiter — system design walkthrough](https://semicolony.dev/codex/system-design/playbook/rate-limiter/)
- [Distributed Rate Limiter Case Study (2025)](https://umamahesh.net/system-design-case-study-designing-a-distributed-rate-limiter/)

### Vector DBs / RAG
- [Self-managed multi-tenant vector search with Amazon Aurora PostgreSQL](https://aws.amazon.com/blogs/database/self-managed-multi-tenant-vector-search-with-amazon-aurora-postgresql/)
- [Supabase RAG with Permissions](https://supabase.com/docs/guides/ai/rag-with-permissions)
- [Pinecone — Implement multitenancy](https://docs.pinecone.io/guides/index-data/implement-multitenancy)
- [pgvector vs Pinecone (2026)](https://rivestack.io/blog/pgvector-vs-pinecone)
- [Multi-Tenancy in Vector Databases — Pinecone](https://www.pinecone.io/learn/series/vector-databases-in-production-for-busy-engineers/vector-database-multi-tenancy/)

### Migrations
- [37 Alembic Migrations, Zero Downtime — single→multi-tenant](https://dev.to/grommash9/37-alembic-migrations-zero-downtime-how-we-moved-a-live-saas-from-single-tenant-to-multi-tenant-4i6n)
- [Zero-Downtime PostgreSQL Migrations](https://www.michal-drozd.com/en/blog/zero-downtime-postgresql-migrations/)
- [Zero-Downtime Database Migrations (2026)](https://www.codercops.com/blog/zero-downtime-database-migrations-production-2026)
- [Citus migration to multi-tenant schema](https://github.com/citusdata/citus_docs/blob/v10.0/develop/migration_mt_schema.rst)

### Anti-patterns / Lessons learned
- [Data Isolation in Multi-Tenant SaaS (Emergen)](https://emergen.io/blog/ensuring-data-isolation-in-multi-tenant-saas-2025-guide)
- [Multi-tenant SaaS Isolation: Patterns (Metaeye)](https://www.metaeye.co.uk/multi-tenant-saas-isolation-patterns-for-data)
- [Risks and Challenges of Multi-tenancy (Clerk)](https://clerk.com/blog/what-are-the-risks-and-challenges-of-multi-tenancy)
- [Isolation in Multi-Tenancy — Lessons Learned the Hard Way](https://medium.com/@systemdesignwithsage/isolation-in-multi-tenancy-and-the-lessons-we-learned-the-hard-way-3335801aa754)
- [Six Shades of Multi-Tenant Mayhem](https://borabastab.medium.com/six-shades-of-multi-tenant-mayhem-the-invisible-vulnerabilities-hiding-in-plain-sight-182e9ad538b5)
- [Multi-Tenancy Layer by Layer (Bilel Salem)](https://dev.to/bilelsalemdev/multi-tenancy-layer-by-layer-from-row-level-security-to-whole-cluster-isolation-4650)

### Noisy neighbours
- [Neon — Noisy Neighbor in Multitenant Architectures](https://neon.com/blog/noisy-neighbor-multitenant)
- [TiDB — Stop Noisy Neighbors (Multi-Tenant SQL)](https://www.pingcap.com/playbook-noisy-neighbor-multi-tenant-mysql/)
- [Designing for Noisy Neighbors](https://systemdr.systemdrd.com/p/designing-for-noisy-neighbors-multi)

### WebRTC / TURN
- [WebRTC Signaling Auth: JWT vs Ephemeral TURN (2026)](https://callsphere.ai/blog/vw8e-webrtc-signaling-jwt-vs-ephemeral-tokens-2026)
- [coturn — TURN REST API documentation](https://github.com/coturn/coturn/blob/master/README.turnserver)
- [ReadyTalk/turnrest](https://github.com/ReadyTalk/turnrest)
- [express-turn-credentials-rest-api](https://github.com/jofr/express-turn-credentials-rest-api)

### Feature flags
- [LaunchDarkly Multi-Contexts](https://launchdarkly.com/docs/home/flags/multi-contexts)
- [LaunchDarkly Context Instances](https://docs.launchdarkly.com/home/flags/context-instances)
- [Managing Entitlements in LaunchDarkly](https://launchdarkly.com/blog/managing-entitlements-in-launchdarkly/)

### Connection pooling (additional)
- [Supavisor — cloud-native multi-tenant Postgres connection pooler](https://github.com/supabase/supavisor)

---

*End of report.*
