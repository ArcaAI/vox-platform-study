# TASK-785 — Tiered Rate-Limit Governance (tenant × route → tenant → plan → platform)

| | |
|---|---|
| **Status** | Review |
| **Type** | feature |
| **Branch** | `dev-2.2` |
| **Surfaces** | `packages/database` · `packages/domains` · `packages/applications` · `apps/api` · `apps/admin-console` · `packages/vox-node` |
| **Requested** | Super-admin control of rate limits per tenant, per route/path, and per subscription plan, with a declared precedence order |
| **Depends on** | TASK-771 (rate-limit admin writes), TASK-763 (SYSTEM as the sole platform config tier), TASK-776 (route manifest / authz matrix) |

---

## 1. Requirement Analysis

### 1.1 User stories

| # | Story | Precedence rank |
|---|---|---|
| US-1 | As a super admin, I want to override a rate limit **for a specific tenant on a specific route/path**. | 1 (highest) |
| US-2 | As a super admin, I want to override a rate limit **for a specific tenant** (all routes). | 2 |
| US-3 | As a super admin, I want to manage the rate limit **of each subscription plan** — applied to every tenant subscribing to that plan. | 3 |
| US-4 | As a super admin, I want to override a rate limit **for a specific route**, applied platform-wide. | 4 |
| US-5 | As a super admin, I want to manage the **global/shared rate limit for the whole platform**. | 5 (lowest) |

### 1.2 Declared precedence (owner decision OD-1)

```
1. Tenant × route override        (this tenant, this route)
2. Tenant override                (this tenant, all routes)
3. Subscription plan              (this tenant's plan)
4. Platform route override        (all tenants, this route)
5. Platform base tier             (all tenants, all routes)
```

**First non-null wins.** Each level yields either a `{ limit, ttl }` pair or "no opinion"; resolution
stops at the first level with an opinion. This is *tenant specificity outranks route specificity* —
a documented, deliberate consequence is that **a tenant-scoped prefix rule beats a platform-scoped
exact rule**. Rank 1 vs rank 4 is decided by *whose* rule it is, not by how precise the pattern is;
pattern precision only breaks ties **within** a single level (§3.4).

This is a **reversal of shipped behaviour**. Today the platform-wide route override sits at the top
and the tenant sits below the `@Throttle` decorator (§2.3).

### 1.3 Acceptance criteria

| Id | Criterion |
|---|---|
| AC-1 | A super admin can create, list, update and delete a rate-limit rule scoped to `(tenant, route)`, `(tenant, *)`, `(platform, route)`. |
| AC-2 | A super admin can set an absolute `limit` + `window` on a subscription plan; every tenant on that plan inherits it with no per-tenant row. |
| AC-3 | A super admin can retune the platform base tiers (already shipped — must keep working). |
| AC-4 | Resolution follows §1.2 exactly, proven by a test per adjacent pair (1 beats 2, 2 beats 3, 3 beats 4, 4 beats 5). |
| AC-5 | A limit that resolves from the tenant or plan lane is **counted per tenant**, not per source IP (OD-3). |
| AC-6 | Route rules accept an exact route id **and** a path-prefix pattern; exact wins, then longest prefix (OD-4). |
| AC-7 | Every rule change takes effect **live**, with no redeploy, on every gateway instance. |
| AC-8 | `GET /admin/rate-limit/explain` returns the full resolution trace for a `(tenant, method, path)` triple — which level won, and what every other level offered. |
| AC-9 | Throttled and non-throttled responses carry `RateLimit` / `RateLimit-Policy` headers; 429 carries `Retry-After`. |
| AC-10 | Cross-tenant reads/writes of another tenant's rules return **404**, not 403. |
| AC-11 | The config plane fails **open** (traffic flows on the platform base tier) when the rule store is unreachable — never fails closed on a config read error. |

### 1.4 Out of scope

- Per-plan × per-route rules (the schema below leaves room; no admin surface in this ticket).
- Tenant *self-service* rate-limit editing. The existing tighten-only self-service lane
  (`rateLimit.maxRequests`, §2.5) is preserved unchanged; this ticket adds only super-admin lanes.
- Usage-based billing/overage on rate limits (that is `TenantUsageMeter` territory).
- Rate limiting inside the Python services — this is gateway-plane only.

---

## 2. Current State Evaluation

Everything below was read from source on 2026-08-22. **More exists than the stories assume**:
US-3, US-4 and US-5 are partly shipped; US-1 does not exist at all; and the shipped precedence is
the reverse of §1.2.

### 2.1 What is already live

| Story | Status | Where |
|---|---|---|
| US-5 platform base | ✅ Shipped | 4 named tiers (`default/strict/heavy/relaxed`), DB-backed `GlobalSetting` rows, live-tunable, super-admin API + UI |
| US-4 platform route | ⚠️ Partial | Works — but only for **5 hardcoded routes** in a hand-maintained array |
| US-3 plan | ✅ Shipped (indirect) | `PlanEntitlement.rateLimitTier` maps each `TenantPlan` to a named tier |
| US-2 tenant | ✅ Shipped (two lanes) | `TenantEntitlement.rateLimitPerMinute` (super-admin, may loosen) + `rateLimit.maxRequests` (tenant self-service, tighten-only) |
| US-1 tenant × route | ❌ **Absent** | No model, no service, no API, no UI |

### 2.2 Runtime map

| Component | File | Role |
|---|---|---|
| Guard | `apps/api/src/modules/throttle/tiered-throttler.guard.ts` | Extends `ThrottlerGuard`; overrides `handleRequest`; **registered first in the `APP_GUARD` chain** (`apps/api/src/app.module.ts`, ahead of `ClsGuard` and `UnifiedAuthGuard`) |
| Static baseline | `apps/api/src/modules/throttle/rate-limit-config.service.ts` | env-only (`RATE_LIMIT_ENABLED`, `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_MS`); registers the 4 throttlers |
| Storage | `apps/api/src/modules/throttle/throttle.module.ts` | `@nest-lab/throttler-storage-redis` when `REDIS_URL`/`REDIS_HOST` resolves and not under test; in-memory otherwise |
| DB read accessor | `packages/applications/src/services/rate-limit/rate-limit-settings.service.ts` | `isEnabledForTenant`, `getTier`, `getTierForTenant`, `getRouteOverride` — all O(1) against the `AppSettingsService` in-memory cache |
| Admin write | `packages/applications/src/services/rate-limit/rate-limit-admin.service.ts` | Writes `GlobalSetting` rows in a CLS scope pinned to `RATE_LIMIT_TENANT_ID` (TASK-771 fix) |
| Key registry | `packages/applications/src/services/rate-limit/rate-limit.constants.ts` | Key builders, `RATE_LIMIT_TIER_DEFAULTS`, `KNOWN_THROTTLED_ROUTES`, `resolveRouteId` |
| Plan composition | `packages/applications/src/services/entitlements/rate-limit-plan.ts` | `resolvePlanRateLimit(tier, perMinute, baseline)` |
| Admin API | `apps/api/src/modules/admin-rate-limit/rate-limit-admin.controller.ts` | `GET /admin/rate-limit`, `PUT .../enabled`, `PUT .../tiers/:tier`, `PUT .../routes/:routeId` |
| Admin UI | `apps/admin-console/src/app/(console)/(global)/rate-limits/page.tsx` | Frame 16, tier 10–19, gated `[['manage','all']]` |
| SDK | `packages/vox-node/src/resources/admin/rate-limit.ts` | Generated 1:1 wrapper, `svc:admin:rate-limit:manage` |

Config plane storage: `GlobalSetting` rows under `SYSTEM_TENANT_ID` (`00000000-…`), namespace
`rate-limit`, seeded by `packages/database/src/prisma/db_main/seed/12-rate-limit-settings.ts`.
Propagation is the Redis `app-settings:invalidate` channel plus an in-request `refreshCache()`;
the 45 s cron is the backstop, not the mechanism.

### 2.3 F-01 — the shipped precedence is inverted

`tiered-throttler.guard.ts` composes the effective limit as:

```ts
const limit = override?.limit ?? decoratorLimit ?? tenantLimit ?? plan?.limit ?? tier.limit;
const ttl   = override?.ttl   ?? decoratorTtl   ?? tenantTtl   ?? plan?.ttl   ?? tier.ttl;
```

Shipped order: **platform route override → `@Throttle` decorator → tenant row → plan → platform tier.**

Two inversions against §1.2:

1. The **platform route override outranks the tenant's own override** — the exact opposite of
   ranks 1–2 vs rank 4. A super admin who raises Tenant A's limit is silently ignored on any of
   the five routes that carry a platform override.
2. A **hardcoded `@Throttle` decorator value outranks both the tenant and the plan**. An
   ENTERPRISE tenant cannot be granted more than 5 logins/min without a code change and a
   redeploy — which defeats the runtime-tunable premise of the whole surface.

A unit test currently *pins* inversion 2 as intended behaviour
(`throttle-guard.test.ts`, "decorator beats plan tier"). That test must be rewritten, not deleted —
see §5.2 T-12.

### 2.4 F-02 — per-tenant and per-plan limits are counted per IP (**the most serious finding**)

`TieredThrottlerGuard` never overrides `getTracker()`; the file says so explicitly at line 45
("IP-based tracker is intentionally left untouched"). The underlying `ThrottlerGuard` therefore
keys every bucket on `request.ip`.

Consequences today:

- "500 req/min for tenant A" is really "500 req/min **per source IP** for anyone presenting a
  tenant-A JWT". A tenant behind two egress IPs gets 1000; behind ten, 5000.
- Two *different* tenants behind one corporate NAT **share** a single bucket — one tenant's traffic
  throttles another's. That is a cross-tenant availability coupling.
- A pinned test (`throttle-guard.test.ts`, credential-class parity) asserts JWT + API-key +
  service-account calls to one route **share one bucket**.

So the plan and tenant lanes are, as counters, cosmetic. AC-5 exists to fix this.

### 2.5 F-03 — two lanes and two key grammars for the same concept

| Grammar | Keys | Scope | Written by |
|---|---|---|---|
| `rate-limit.*` (hyphen) | `rate-limit.enabled`, `rate-limit.tier.<t>.{limit,ttl}`, `rate-limit.route.<id>.{limit,ttl,enabled}` | SYSTEM only | `RateLimitAdminService` (bypasses the settings registry) |
| `rateLimit.*` (camel) | `rateLimit.enabled`, `rateLimit.maxRequests`, `rateLimit.windowMs` | tenant-overridable (`maxScope: 'tenant'`) | generic settings-registry write path |

Both are live and both feed the same guard. The camel lane is the tenant self-service lane and is
**clamped tighten-only** (`tenant-clamp.ts`: a tenant may throttle itself harder than its plan,
never softer). The hyphen lane has no settings-registry descriptor for `rate-limit.enabled` or the
`rate-limit.route.*` keys at all.

This ticket keeps both lanes but makes their roles explicit (§3.2) and documents the split in
`docs/operations/`.

### 2.6 F-04 — the tunable-route set is a hand-maintained array of 5

`KNOWN_THROTTLED_ROUTES` (`rate-limit.constants.ts`) lists `auth.login`, `auth.impersonate`,
`auth.refresh`, `health`, `monitoring`. Meanwhile:

- **16 routes** carry a `@Throttle` decorator (auth ×3, auth-sso ×4, register ×2, admin-impersonation,
  forgot-password, service-token, health, admin-health-services, monitoring, workflows).
- **657 routes** exist in `apps/api/route-manifest.json` (CI-gated by `pnpm api:route-manifest`).

So 11 decorated routes are *not* tunable at runtime, and 641 routes have no per-route lane at all.
The array is also a **mirror**, not a derivation — its `limit`/`ttl` columns duplicate the decorator
values and will drift silently the moment a decorator changes.

### 2.7 F-05 — tenant identity on the hot path is an unverified JWT decode

`extractTenantIdPreAuth(context)` base64url-decodes the JWT payload and reads `tenantId`
**without verifying the signature**, because the throttler runs before `ClsGuard`/`UnifiedAuthGuard`.
The code correctly calls this "a rate-limit tiering hint only… never an authorization decision".

That is defensible for *tiering*. It is **not** defensible as the counter key (AC-5), because a
forged unsigned token could then name any tenant and consume that tenant's budget, or claim a
generous tenant's budget for free. §3.5 addresses this.

### 2.8 F-06 — API-key and service-account traffic never reaches the tenant lane

`extractTenantIdPreAuth` only reads a bearer JWT (or the SSE `?token=` param). API-key and
service-account requests resolve `tenantId = null` and therefore skip ranks 1–3 entirely, landing on
the platform lane. For a machine-to-machine platform where the SDK's admin plane is
service-account-only, that means **the entire `@arcaai/vox-node` surface is ungoverned by tenant or
plan limits**.

### 2.9 F-07 — the plan lane is off by default

`entitlements.enabled` ships **OFF** (`ENTITLEMENTS_GLOBAL_ENABLED_DEFAULT = false`). Where it is
off, `getTenantRateLimitPolicy` yields nothing and rank 3 is inert. Also note a `null`-plan tenant
resolves to `UNGATED_ENTITLEMENTS` with `rateLimitTier: 'relaxed'` (300/min) — i.e. *more* generous
than the 100/min default. Any tenant with `Tenant.plan = NULL` is currently on the loosest tier.

### 2.10 Subscription-plan model as it stands

There is **no first-class `Plan` table**. `TenantPlan` is a Prisma **enum**
(`ENTERPRISE | PRO | TRIAL | STARTER`); `Tenant.plan` is a nullable enum column with no relation;
`PlanEntitlement` is a platform-wide default matrix keyed `plan TenantPlan @unique`.
Effective-dated history lives in `TenantPlanHistory` (append-only, not the resolver's authority).

Seeded rate-limit tiers per plan: `STARTER → strict` (10/min), `TRIAL → default`,
`PRO → default` (100/min), `ENTERPRISE → relaxed` (300/min).

Entitlement resolution is already a 3-layer cascade in `resolve-entitlements.ts`:
seeded in-code matrix → `PlanEntitlement` row → `TenantEntitlement` row (field-by-field, `null` =
inherit). US-2 and US-3 map onto this cleanly.

---

## 3. Design

### 3.1 Owner decisions

| Id | Decision | Rationale |
|---|---|---|
| **OD-1** | Precedence is `tenant×route > tenant > plan > platform-route > platform-base`. | §1.2. Reverses F-01. |
| **OD-2** | A `@Throttle` decorator becomes the **platform-route default only** (rank 4/5 seed), fully overridable by any DB level above it. | Restores runtime tunability. Accepted risk in §6 R-1. |
| **OD-3** | Bucket key is **tier-dependent**: tenant-keyed when the limit resolves from ranks 1–3, IP-keyed when it resolves from ranks 4–5 with no trusted tenant. | Makes a tenant limit an actual tenant limit (F-02) without weakening brute-force defence on anonymous endpoints. |
| **OD-4** | Route identity is an **exact route id plus optional path-prefix patterns**; exact wins, then longest prefix. | Covers all 657 routes and allows broad strokes (`*:/api/v1/admin/*`) without one row per route. |
| **OD-5** | A plan-less **customer** tenant resolves **STARTER**, not ungated. Reserved platform tenants (SYSTEM, Global) stay ungated. | Resolves O-3. "No plan" was granting `relaxed` (300/min) — looser than a paying PRO tenant and looser than the platform default. **Shipped**, see §7.1. |
| **OD-6** | Entitlements enforcement defaults **ON**, including local dev. CI/test stay OFF. | Resolves O-3. Deployed environments were already ON; local dev was the one place quota behaviour was never exercised. **Shipped**, see §7.1. |

### 3.2 Where each level lives

One new table; everything else reuses shipped storage.

| Rank | Level | Storage | New? |
|---|---|---|---|
| 1 | tenant × route | `RateLimitRule` where `tenantId = <customer>` and `routeMatch` set | **new** |
| 2 | tenant | `RateLimitRule` where `tenantId = <customer>` and `routeMatch IS NULL` (super-admin lane, may loosen) — plus the existing tighten-only `rateLimit.maxRequests` self-service row | **new** (+ existing) |
| 3 | plan | `PlanEntitlement.rateLimitPerMinute` / `.rateLimitWindowMs` (new columns) falling back to the existing `rateLimitTier` baseline | extend |
| 4 | platform route | `RateLimitRule` where `tenantId = SYSTEM` and `routeMatch` set — seeded from the 16 `@Throttle` decorators | **new** |
| 5 | platform base | `rate-limit.tier.<t>.{limit,ttl}` `GlobalSetting` rows | unchanged |

Ranks 1, 2 and 4 are one table distinguished by `tenantId` (SYSTEM vs customer) and by
`routeMatch IS NULL`. That is deliberate: it makes the **tenant → SYSTEM cascade the same query**
the rest of the platform uses, and keeps `50000000-…` ("Global", a *customer* tenant) out of the
resolution path entirely, per `00-project-context.md`.

### 3.3 New model — `RateLimitRule`

```prisma
model RateLimitRule {
  // meta fields
  metaData Json?  @map("_metadata") @db.JsonB
  version  Int    @default(1) @map("_version")
  id       String @id @default(uuid(7))

  // multi tenant fields
  // SYSTEM (00000000-…) = a PLATFORM rule (rank 4). A customer tenant = a TENANT rule (rank 1/2).
  tenantId String

  // core (business) fields
  // NULL  => applies to every route for this scope (rank 2 when tenant-scoped)
  // set   => a route rule (rank 1 when tenant-scoped, rank 4 when SYSTEM-scoped)
  routeMatch String?
  matchKind  RateLimitMatchKind @default(EXACT)
  // Precomputed longest-prefix ordering key = routeMatch.length; EXACT sorts above every PREFIX.
  specificity Int @default(0)

  limitValue Int
  windowMs   Int
  // false => this scope is EXEMPT from throttling (a deliberate allow-list, not "no opinion")
  active     Boolean @default(true)

  description String?

  // resource status fields
  resourceStatus          ResourceStatusType @default(ENABLED)
  resourceStatusUpdatedAt DateTime?
  resourceStatusUpdatedBy String?

  // audit fields
  createdBy String?  @default("60000000-0000-0000-0000-000000000000")
  updatedBy String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([tenantId, routeMatch, matchKind], map: "RateLimitRule_scope_unique")
  @@index([tenantId], name: "RateLimitRule_tenantId_idx")
  @@index([tenantId, specificity], name: "RateLimitRule_tenantId_specificity_idx")
  @@schema("core")
}

enum RateLimitMatchKind {
  EXACT
  PREFIX

  @@schema("core")
}
```

Notes:
- `limitValue` / `windowMs`, not `limit` / `ttl` — `limit` collides with Prisma query args and
  `ttl` is ambiguous against the cache TTLs elsewhere in the stack.
- `@@unique` uses `map:` for the DB index name, **not** `name:` — `02-database-prisma.md` records
  this exact trap (TASK-648 ledger drift).
- `active: false` means **exempt** (skip throttling for this scope), matching today's
  `rate-limit.route.<id>.enabled = false` semantics. It is *not* "fall through to the next level" —
  a rule that matches always terminates resolution.
- `plan TenantPlan?` is deliberately **omitted** for now; adding it later is an additive nullable
  column plus a widened unique index, so plan×route stays reachable without a redesign.

Allow-list updates (`02-database-prisma.md`):
- `TENANT_SCOPED_MODELS` (`packages/database/src/extensions/tenant-scope.ts`) — **add** `RateLimitRule`.
- `SYSTEM_SHARED_READ_MODELS` — **add** `RateLimitRule`, so a tenant-scoped read still sees the
  SYSTEM (rank-4) rows without a CLS pin.
- `MODELS_WITHOUT_SOFT_DELETE` — do **not** add; rules soft-delete normally.

Audit: add `RateLimitRule` to `ResourceType` in **both** `packages/database/src/prisma/db_main/audit.prisma`
(with an `ALTER TYPE … ADD VALUE` migration) **and** `packages/domains/src/enums/generated/ResourceType.ts`.
`resourceType.enum-parity.test.ts` is the guard; skipping this makes every `AuditLog` INSERT throw and
turns the originating mutation into a 500 (the TASK-366 failure mode).

### 3.4 Resolution algorithm

```
resolve(tenantId | null, method, routePath, throttlerName) -> { limitValue, windowMs, level, ruleId? }

  0. if !settings.isEnabledForTenant(tenantId)            -> SKIP (kill-switch, unchanged)
  1. if throttlerName !== 'default'                       -> decorator value ?? platform tier
                                                             (strict/heavy/relaxed stay platform-only)

  routeKey := `${method}:${routePath}`      // route PATTERN, e.g. "GET:/api/v1/admin/tenants/:id"

  L1. tenantId && bestMatch(rules[tenantId], routeKey, routeScoped: true)   -> hit
  L2. tenantId && rules[tenantId] where routeMatch IS NULL                  -> hit
      (then, if still no hit, the tighten-only self-service row — clamped)
  L3. tenantId && planPolicy(tenantId)                                      -> hit
  L4. bestMatch(rules[SYSTEM], routeKey, routeScoped: true)                 -> hit
  L5. platform base tier for `throttlerName`                               -> always a hit

  bestMatch(rules, routeKey):
    exact   := rules.find(r => r.matchKind === EXACT  && r.routeMatch === routeKey)
    if exact: return exact
    return rules.filter(r => r.matchKind === PREFIX && matches(r.routeMatch, routeKey))
                .sort(byDescending(specificity))[0]

  any level whose matching rule has active === false     -> SKIP throttling entirely
```

`matches()` for a `PREFIX` rule supports a leading `*:` method wildcard and a trailing `/*` path
wildcard: `*:/api/v1/admin/*` matches any method whose path starts with `/api/v1/admin/`.
A `METHOD:` prefix without a wildcard is an exact method constraint.

**Route pattern, not raw URL.** `req.route?.path` (Express) yields the registered *pattern*
(`/api/v1/admin/tenants/:id`), so `/tenants/abc` and `/tenants/def` share a rule instead of
generating unbounded distinct keys. Falling back to `req.url` would make the bucket key
cardinality-unbounded and is explicitly forbidden — if the pattern is unavailable, resolution
degrades to rank 5 and emits a `rate_limit_route_pattern_missing_total` counter.

**Fail-open (AC-11).** Every level is wrapped so that a store/cache error yields "no opinion" and
resolution falls through to rank 5. No config error may ever produce a 429.

### 3.5 Bucket keying (OD-3)

`@nestjs/throttler@6.5.0`'s `ThrottlerRequest` carries injectable `getTracker` and `generateKey`
functions (verified against the installed `throttler.guard.interface.d.ts`), so the guard supplies
per-request keying by spreading `requestProps` — no fork, no patched dependency:

```ts
return super.handleRequest({
  ...requestProps,
  limit: resolved.limitValue,
  ttl: resolved.windowMs,
  getTracker: async () => tracker,           // computed below
  generateKey: (_ctx, trk, name) => `${name}:${bucketScope}:${trk}`,
});
```

| Resolved level | `bucketScope` | `tracker` |
|---|---|---|
| L1 (tenant × route) | `t:<tenantId>:r:<routeKey>` | `<tenantId>` |
| L2 (tenant) | `t:<tenantId>` | `<tenantId>` |
| L3 (plan) | `t:<tenantId>` | `<tenantId>` |
| L4 (platform route) | `r:<routeKey>` | `<ip>` |
| L5 (platform base) | `g` | `<ip>` |

Two invariants that make this safe:

1. **Tenant-keyed buckets require a *trusted* tenant id.** F-02 is only fixable if the id is
   trustworthy, and F-07 says the pre-auth decode is not. Therefore the guard verifies the JWT
   signature before using the claim as a bucket key — reusing the already-warm `SecretsService`
   JWT key material, verify-only (no DB, no revocation check, no CLS). If verification fails or
   is unavailable, the request is treated as **untrusted**: it resolves on ranks 4–5 and is
   IP-keyed. An unsigned or forged token can therefore never spend, or borrow, a tenant's budget.
2. **Anonymous abuse surfaces stay IP-keyed.** `auth/login`, `register`, `forgot-password` and the
   SSO entry points carry no verifiable tenant, so they land on L4/L5 and keep today's per-IP
   brute-force semantics.

API-key and service-account traffic (F-06) gains a tenant lane in the same pass: the API-key id and
the service-account token both already resolve a tenant server-side, so the guard extracts
`X-API-Key` / `X-Service-Account-Token` and resolves the owning tenant from the existing cache.
Where that lookup is unavailable on the hot path, the request is untrusted and rides L4/L5 —
identical to today's behaviour, never worse.

### 3.6 Route catalog (OD-4)

The admin UI needs a searchable list of all 657 routes; the resolver needs none (it matches on the
live `req.route.path`). Build the catalog at boot from the Nest router explorer — the *same*
enumeration `pnpm api:route-manifest` already performs — and expose it read-only:

```
GET /api/v1/admin/rate-limit/routes
  -> [{ routeId: "POST:/api/v1/auth/login", controller, handler, method, path,
        isPublic, decoratorLimit?, decoratorWindowMs? }]
```

Extract the enumeration into a shared `RouteCatalogService` consumed by both the manifest generator
and the runtime, so the two can never disagree. `KNOWN_THROTTLED_ROUTES` and `resolveRouteId` are
then **deleted** (F-04, F-06 drift risk removed) — the 5 legacy `routeId` slugs are migrated to
their `METHOD:/path` equivalents by the migration in §5.1 P1.

### 3.7 Admin API surface

All under `@Controller('admin/rate-limit')`, class-gated `@Authorize(['manage','all'])` +
`@ForbidApiKey()` + `@RequiredSvcScopes('svc:admin:rate-limit:manage')` — identical to the shipped
controller, so no new privilege boundary is introduced.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `admin/rate-limit` | Existing policy snapshot — **unchanged shape**, extended with a `rules` array |
| `PUT` | `admin/rate-limit/enabled` | Existing kill-switch |
| `PUT` | `admin/rate-limit/tiers/:tier` | Existing platform base (rank 5) |
| `GET` | `admin/rate-limit/routes` | Route catalog (§3.6) |
| `GET` | `admin/rate-limit/rules` | List rules; filters `?tenantId=&scope=platform\|tenant` |
| `POST` | `admin/rate-limit/rules` | Create a rule (ranks 1, 2 or 4 by payload) |
| `PATCH` | `admin/rate-limit/rules/:id` | Update — **OCC**: `@RequiresIfMatch()` + `@ExpectedVersion()` |
| `DELETE` | `admin/rate-limit/rules/:id` | Soft-delete |
| `GET` | `admin/rate-limit/plans` | Per-plan limits (rank 3) |
| `PATCH` | `admin/rate-limit/plans/:plan` | Set a plan's absolute limit/window — OCC |
| `GET` | `admin/rate-limit/explain` | **AC-8** resolution trace for `?tenantId=&method=&path=` |

`PUT admin/rate-limit/routes/:routeId` (the legacy 5-route write) is **kept for one release** as a
shim that writes the equivalent rank-4 rule, with a comment naming the release in which it is
deleted — matching the retired-route policy in `13-nextjs-apps.md`.

The `explain` endpoint is the single highest-value operability item here: with five levels and two
match kinds, "why is this tenant getting 429s?" is otherwise unanswerable without a debugger.

### 3.8 Response headers (AC-9)

Adopt the IETF `draft-ietf-httpapi-ratelimit-headers` shape (`RateLimit` + `RateLimit-Policy`;
the three-header `RateLimit-Limit`/`-Remaining`/`-Reset` form is the superseded draft). Emit from a
small interceptor fed by the guard's resolution, plus `Retry-After` on 429.
**Do not** name the winning tenant, plan or rule id in a header — that leaks platform topology to
the caller; it belongs in `explain`, which is super-admin-gated.

### 3.9 Caching & invalidation

Rules are read on **every request**, pre-auth, so the hot path must not touch the DB.

- Load all rules into an in-memory `Map<tenantId, SortedRule[]>` at boot, pre-sorted by
  `matchKind` then `specificity DESC` so `bestMatch` is a short linear scan.
- Invalidate via the existing Redis pub/sub pattern — a **new** channel
  `rate-limit-rules:invalidate` (not `app-settings:invalidate`; these rows are not `GlobalSetting`
  rows and must not ride that lane), plus an in-request refresh on the writing instance, plus a
  cron backstop on the same 45 s cadence.
- **Bound the hot path**: cap rules at 200 per tenant and 500 platform-wide; reject the create
  beyond that with a 409 rather than degrading every request. Log the cap — a silent truncation
  would read as "all rules applied" when they were not.
- Keep the existing 30 s `rateLimitPolicyCache` for the plan lane as-is.

---

## 4. Best Practices Applied

| Practice | Source | How it lands here |
|---|---|---|
| Split control plane from data plane | multi-tenant SaaS rate-limit guidance | Admin API + rule table = control plane; guard + Redis counters = data plane. The guard never writes config. |
| Most-specific-match wins, with exact above wildcard | Envoy / Azure App Gateway / Kubernetes Gateway API path-matching convention | `bestMatch` (§3.4): EXACT before PREFIX, longest prefix among PREFIX. |
| Never silently grant access when the counter store is unavailable | SaaS rate-limit playbook | Redis-down behaviour is a **separate** decision from config-down: config errors fail open (AC-11); a counter-store outage falls back to the in-memory store, which is per-instance and therefore *stricter*, not unlimited. Documented in §6 R-4. |
| Advertise quota to clients | `draft-ietf-httpapi-ratelimit-headers` | §3.8. |
| Atomic check-and-update in the counter | Redis rate-limiter guidance (Lua `EVAL`, not `WATCH/MULTI`) | Already satisfied — `@nest-lab/throttler-storage-redis` uses a Lua script. **No change**, and explicitly do not hand-roll a second limiter. |
| Different limits for cheap reads vs expensive operations | multi-tenant API guidance | The `heavy` tier already exists (used by workflow run-start); rank-4 prefix rules make it reachable for whole route families (`*:/api/v1/admin/*`). |
| Config is never a code literal; resolution is tenant → platform | `00-project-context.md` §Configuration Principles | Every level is DB-backed; `@Throttle` demoted to a seed (OD-2); SYSTEM is the widening target and `50000000-…` never appears. |
| Invalidation is the propagation path, TTL is the safety net | `09-infrastructure-devops.md` §Config caches | §3.9. |

---

## 5. Implementation Plan

Layer order per `01-development-workflow.md`: **Database → Domain → Services → API → UI**.
Every phase is TDD (RED → GREEN → refactor) and must be seen failing first.

### 5.1 Phases

**P0 — Contract lock (no production code)**
1. Write the resolution table as an executable fixture: 5 levels × {hit, miss} × {exact, prefix} —
   the single source of truth every later test asserts against.
2. Add the `explain` response DTO shape.

**P1 — Database**
1. Edit `packages/database/src/prisma/db_main/rate-limit.prisma` (new file): `RateLimitRule`,
   `RateLimitMatchKind`. Add `rateLimitPerMinute Int?` + `rateLimitWindowMs Int?` to
   `PlanEntitlement`; add `rateLimitWindowMs Int?` to `TenantEntitlement`.
2. Add `RateLimitRule` to `ResourceType` in `audit.prisma` **and** the domains enum.
3. Author the migration against a **throwaway shadow DB** (`02-database-prisma.md` recipe — the dev
   DB has no `_prisma_migrations` ledger and `db:all` would wipe one). Name it
   `task_785_rate_limit_rules`. Include the `ALTER TYPE … ADD VALUE` for `ResourceType`.
4. Prove no drift: `npx prisma migrate diff --from-config-datasource --to-schema … --script` must
   print `-- This is an empty migration.`
5. Update `TENANT_SCOPED_MODELS` + `SYSTEM_SHARED_READ_MODELS`.
6. Seed: extend `seed/12-rate-limit-settings.ts` with the 16 rank-4 rules derived from the current
   `@Throttle` decorators, idempotent create-only. Migrate the 5 legacy `rate-limit.route.*` rows.
   → Gate: `pnpm db:migrate:deploy` on the shadow DB, `pnpm db:push`, `pnpm --filter @arcaai/database test`.

**P2 — Domain**
1. `pnpm gen:model` (the ONLY scaffolding step).
2. **Hand-author** `RateLimitRuleEntity`, `RateLimitRuleFactory`, `RateLimitRuleEntityMapper`
   (with `FIELDS_NOT_WRITABLE = ['version']` + `stripNonWritableFields` — this model is OCC-written),
   `RateLimitRuleRepository`. Exemplars: `AiTaskDefault*`, `AiProviderConnection*`.
   **Never run `pnpm gen:mapper`** — it strips the `_version` guard from every mapper it touches
   before crashing.
3. Register the repository in `CoreDatabaseModule` (providers **and** exports); add mapper +
   repository barrel lines by hand.
4. `pnpm gen:entity` + `pnpm gen:factory` to reconcile barrels and prove schema coverage.
   → Gate: `pnpm --filter @arcaai/domains build test`, all three `gen:*:check` report no drift.

**P3 — Services (`packages/applications`)**
1. `rate-limit-rule.service.ts` — CRUD + the in-memory cache + the new invalidation channel.
2. `rate-limit-resolver.ts` — the pure `resolve()` function of §3.4. **Pure and dependency-free**, so
   the whole precedence table is unit-testable with no Nest, no DB, no Redis.
3. Extend `resolvePlanRateLimit` for the new absolute per-plan columns.
4. Extend `IRateLimitAdminService` with rules CRUD, the plan lane, and `explain`.
5. Sys-events on every mutation (`broadcastSysEvent`), DTO mappers, tenant guards
   (cross-tenant → `NotFoundException`, never `ForbiddenException`).
   → Gate: `pnpm --filter @arcaai/applications build test`.

**P4 — API (`apps/api`)**
1. Rewrite `TieredThrottlerGuard.handleRequest` to call the resolver, and inject
   `getTracker`/`generateKey` per §3.5. Add trusted-tenant verification.
2. `RouteCatalogService` + the shared enumeration used by the manifest generator.
3. New controller routes (§3.7) with DTOs, `@RequiresIfMatch()`/`@ExpectedVersion()` on PATCH,
   `@ApiTags` from `apps/api/src/openapi/tags.ts` (add the tag there first — an undeclared tag fails
   `tags.test.ts`), summary + description + a 4xx response per route.
4. `RateLimitHeadersInterceptor` (§3.8).
5. Delete `KNOWN_THROTTLED_ROUTES` / `resolveRouteId`; keep the legacy `PUT routes/:routeId` shim.
6. Regenerate all four artifacts together:
   `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal`.
   → Gate: `pnpm test:unit`, then `pnpm test:e2e`; `pnpm api:openapi:check` + `pnpm api:portal:check`.

**P5 — SDK + Admin console**
1. Regenerate `packages/vox-node/src/resources/admin/rate-limit.ts` (never hand-edit;
   `generate-vox-node-admin-check` gates it).
2. Extend the `/rate-limits` screen (Frame 16, tier 10–19): a **Rules** tab (data grid + route
   picker + tenant picker), a **Plans** tab, and an **Explain** panel. Use `ScreenTemplate` with
   `contentMode="fill"`, `AdminDataGrid`, `DetailDrawer` for rule edit, `<Skeleton />` loading,
   `TabsList variant="line"`. New shared components go to `packages/ui`, never forked into the app.
   → Gate: `pnpm --filter @arcaai/admin-console build lint test`, both themes, axe 0 violations.

**P6 — Docs**
`docs/operations/rate-limiting.md`: the precedence table, the two key grammars (F-03), the bucket
keying rules, the rule caps, and a "why is this tenant 429ing?" runbook driven by `explain`.

### 5.2 TDD test list (write these RED first)

| Id | Level | Test |
|---|---|---|
| T-01 | resolver unit | L1 beats L2 — tenant×route rule wins over tenant rule |
| T-02 | resolver unit | L2 beats L3 — tenant rule wins over plan |
| T-03 | resolver unit | L3 beats L4 — plan wins over platform route rule |
| T-04 | resolver unit | L4 beats L5 — platform route rule wins over base tier |
| T-05 | resolver unit | EXACT beats PREFIX within a level |
| T-06 | resolver unit | Longest PREFIX wins among competing prefixes |
| T-07 | resolver unit | **Tenant PREFIX beats platform EXACT** (the counterintuitive OD-1 consequence) |
| T-08 | resolver unit | `active: false` at any level ⇒ exempt, and does *not* fall through |
| T-09 | resolver unit | Store error at L1–L4 ⇒ falls through to L5, never throws (AC-11) |
| T-10 | resolver unit | `tenantId = null` skips L1–L3 entirely |
| T-11 | resolver unit | Non-`default` throttler names resolve decorator ?? base tier only |
| T-12 | guard | **Rewrite** of the existing "decorator beats plan tier" test — decorator now loses to tenant and plan (OD-2). The old assertion is retired *with a comment naming this ticket*, not silently deleted. |
| T-13 | guard | Tenant-resolved limit ⇒ two different IPs on the same tenant **share** one bucket (AC-5) |
| T-14 | guard | Platform-resolved limit ⇒ two IPs get **separate** buckets |
| T-15 | guard | Two tenants behind one IP get **separate** buckets (fixes the F-02 cross-tenant coupling) |
| T-16 | guard | An **unsigned/forged** JWT naming tenant X is untrusted ⇒ IP-keyed, never spends X's budget |
| T-17 | guard | Missing `req.route.path` ⇒ degrade to L5 + counter increments; never key on a raw URL |
| T-18 | guard | Rule changes take effect live with no restart (AC-7) |
| T-19 | service | Rule cap exceeded ⇒ 409, and the cap is logged |
| T-20 | service | `explain` returns every level's offer plus the winner (AC-8) |
| T-21 | service | Cross-tenant rule read/write ⇒ 404 (AC-10) |
| T-22 | service | Every mutation broadcasts a sys-event; `RateLimitRule` `ResourceType` parity holds |
| T-23 | api e2e | PATCH without `If-Match` ⇒ 428; stale version ⇒ 412 |
| T-24 | api e2e | API key and unscoped service-account token ⇒ 403 on every rules route |
| T-25 | api e2e | 429 carries `Retry-After`; 200 carries `RateLimit` + `RateLimit-Policy` (AC-9) |
| T-26 | ui | Rules grid, route picker, and explain panel render; axe 0 violations, both themes |

### 5.3 Verification criteria

- `pnpm --filter @arcaai/database test` · `pnpm --filter @arcaai/domains build test` ·
  `pnpm --filter @arcaai/applications build test` · `pnpm test:unit` · `pnpm test:e2e` ·
  `pnpm --filter @arcaai/admin-console build lint test` — all green, **output pasted** into §6.
- `pnpm gen:model:check`, `gen:entity:check`, `gen:factory:check` — no drift, schema coverage OK.
- `pnpm api:openapi:check`, `pnpm api:portal:check`, `generate-vox-node-admin-check` — green.
- `prisma migrate diff` prints `-- This is an empty migration.`
- `pnpm lint:all`, `pnpm typecheck:all` — no new errors (only-warn warnings in `packages/*` treated
  as errors).
- Per `01-development-workflow.md` §Test Scope Exclusions, failures from `apps/compat-playground`,
  `apps/quick-compat-app` and `packages/ui` are **out of scope** unless the change is inside them —
  P5 touches `packages/ui`, so that suite **is** in scope for P5 only.
- Manual: with a live gateway, set a tenant×route rule and prove the 429 boundary moves; then
  `GET explain` and confirm the trace names that rule.

---

## 6. Risks & Open Items

| Id | Risk | Mitigation |
|---|---|---|
| **R-1** | OD-2 lets a tenant/plan value **loosen** an abuse-bound route (`auth/login` 5/min → 5000/min). | Ranks 1–3 are **super-admin-written only**; the tenant self-service lane stays tighten-only (F-03). `explain` makes the effective value auditable, and every rule write emits a sys-event. If this proves too loose in practice, the `min(resolved, securityCeiling[route])` clamp — considered and not chosen — is an additive follow-up. |
| **R-2** | Signature verification on the pre-auth hot path adds latency. | Verify-only against already-warm key material; no DB, no revocation check, no CLS. Measure before/after; if p99 regresses, cache the verification result keyed by token hash for the token's remaining lifetime. |
| **R-3** | Prefix rules make "which rule applied?" hard for support. | `explain` (AC-8) is a hard requirement, not a nice-to-have. |
| **R-4** | Redis counter-store outage. | Falls back to the per-instance in-memory store, which is *stricter* than intended (each instance keeps its own count), never unlimited. This is a data-plane failure and is deliberately handled differently from AC-11's config-plane fail-open. Document both in §P6. |
| ~~**R-5**~~ | F-07 — the plan lane (rank 3) was inert wherever `entitlements.enabled` is off, and a `NULL`-plan tenant resolved the loosest tier (`relaxed`, 300/min). | **CLOSED** by OD-5 + OD-6 (§7.1). |
| **R-8** | *New.* With enforcement ON in local dev, the TASK-646 fail-closed gap in `resolveForTenant` (a failed read of the billing-only entitlement tables raises instead of falling back, surfacing as a 500 on the clinical path) is now reachable locally. | This is a net GOOD — the gap was previously only reachable in deployed environments, where it is a clinical-path 500. Local reachability is how it gets found. TASK-646 remains the fix. |
| **R-6** | Rewriting `handleRequest` touches the first guard in the chain — a regression here affects every one of the 657 routes. | The resolver is a pure function tested exhaustively (T-01…T-11) independently of the guard; the guard's own tests cover only wiring and bucket keying. |
| **R-7** | The `rate-limit.*` / `rateLimit.*` grammar split (F-03) survives this ticket. | Documented in P6 rather than unified — unifying them is a separate migration with its own blast radius. |

### Open questions

| Id | Question |
|---|---|
| **O-1** | Should `RateLimitRule` carry `plan TenantPlan?` now (enabling plan×route later as pure data) or stay out until asked? The schema above omits it; adding it later is additive. |
| **O-2** | Should a rate-limit *window* be settable per rule, or fixed at 60 s platform-wide? The design allows per-rule `windowMs`; a mixed-window estate is harder to reason about and to display. |
| ~~**O-3**~~ | **RESOLVED 2026-08-22 → OD-5 + OD-6, implemented (§7.1).** |
| **O-5** | *New, raised by the OD-5 work.* `effectivePlan` is applied to the ENTITLEMENTS path only, **not** to billing (`resolveBillingAllowances` in `billing.service.ts` / `usage-analytics.service.ts`). Applying it there would start invoicing a STARTER plan fee to tenants that never subscribed. Consequence: a plan-less tenant is `gated: true` for quotas and `gated: false` for billing. Confirm that split is intended. |
| **O-6** | *New.* CI/test remain enforcement-OFF because the e2e baseline provisions well past STARTER's caps (5 users, 2 departments, 2 API keys). Turning CI ON needs the seeded e2e tenants put on an explicit plan first — own ticket, or fold into this one? |
| **O-7** | *New.* `pnpm test:e2e` needs `prisma db push --force-reset` against the **isolated test DB** (port 5433, `.env.test`), which Prisma gates behind explicit consent. Run it, or accept the unit + gate coverage above for now? |
| **O-4** | Should F-06's API-key/service-account tenant resolution be in this ticket, or split? It is required for the `@arcaai/vox-node` admin plane to be governed at all, but it adds a second identity path to the hot guard. |

---

## 7. Implementation Summary

### 7.1 OD-5 + OD-6 — plan-less tenants and the enforcement default (shipped 2026-08-22)

Delivered ahead of the rest of the ticket because it is self-contained and unblocks rank 3.
**No migration, no schema change, no API change.**

| File | Change |
|---|---|
| `packages/applications/src/services/entitlements/entitlements.constants.ts` | Added `ENTITLEMENTS_GLOBAL_TENANT_ID`, `RESERVED_UNGATED_TENANT_IDS`, `DEFAULT_TENANT_PLAN` (= `STARTER`). Flipped `ENTITLEMENTS_GLOBAL_ENABLED_DEFAULT` `false` → `true`. |
| `packages/applications/src/services/entitlements/resolve-entitlements.ts` | New pure `effectivePlan(tenantId, plan)`: explicit plan wins → reserved tenant with no plan stays `null` → everyone else gets `DEFAULT_TENANT_PLAN`. `resolveEntitlements` itself is **unchanged** and still treats `null` as ungated. |
| `packages/applications/src/services/entitlements/entitlements.service.ts` | `resolveForTenant` and `getCapabilities` now route `tenant.plan` through `effectivePlan`. |
| `packages/database/src/prisma/db_main/seed/15-entitlements.ts` | `resolveKillSwitchSeedDefault` takes its fallback as a parameter. Enforcement uses the new `seedsEnforcementOn()` (ON everywhere except CI/test); metering reconcile keeps `isDeployedEnvironment()` unchanged. |
| tests (4 files) | `resolve-entitlements.test.ts` +8 cases for `effectivePlan`; `entitlements.service.test.ts` — the six "kill-switch OFF" cases now set the row to `false` explicitly instead of relying on the default, the four ungated cases now use the reserved SYSTEM id, and the default-value case is inverted; `entitlements-seed.test.ts` — the developer-laptop case now asserts the enforcement/metering split. |

**Why the reserved-tenant carve-out was necessary.** `seed/05-tenant.ts` gives a plan to exactly one
tenant (ArcaAI → `ENTERPRISE`); SYSTEM and Global are deliberately plan-less (TASK-766 OD-2). A
blanket NULL→STARTER would therefore have put the **Global platform-admin playground** on
`rateLimitTier: 'strict'` (10 req/min) with `featureAgenticLoop: false`, `modelTier: 'base'`,
5 users and 2 departments — i.e. it would have broken the surface platform admins use to trial
configuration. `RESERVED_UNGATED_TENANT_IDS` carries TASK-766 OD-2's intent forward explicitly
instead of leaving it implicit in the absence of a plan, so it no longer leaks to unknown customers.

**What is deliberately NOT changed:** billing (see O-5), CI/test enforcement posture (see O-6),
and the metering-reconcile switch (still deployed-only — the reconcile sweep is a snapshot job that
`assertMeterQuota` does not depend on).

**Operational note.** The kill-switch seed's `update` branch omits `value`, so a re-seed never
clobbers a live toggle. An **already-seeded local dev database keeps `false`** — pick up the new
default with `pnpm db:all` (destructive reset + reseed) or flip it in place:

```bash
curl -X PUT localhost:8868/api/v1/admin/entitlements/enabled -H 'Content-Type: application/json' -d '{"enabled":true}'
```

### 7.2 Verification (actual output)

```
pnpm --filter @arcaai/applications test
  Test Files  528 passed | 1 skipped (529)
       Tests  9707 passed | 4 skipped (9711)

pnpm --filter @arcaai/database test
  Test Files  62 passed (62)
       Tests  1586 passed (1586)

pnpm --filter @arcaai/applications build      -> clean (tsc)
pnpm --filter @arcaai/database   build        -> clean (tsc)
pnpm --filter @arcaai/applications typecheck  -> clean (tsc --noEmit)
pnpm --filter @arcaai/applications lint       -> 181 problems (0 errors, 181 warnings)
                                                 was 182 before formatting; all remaining
                                                 warnings are pre-existing and in untouched files
```

### 7.3 Phases P0–P6 — the rule plane (shipped 2026-08-22)

| Layer | Files |
|---|---|
| **Database** | `db_main/rate-limit.prisma` (new `RateLimitRule`), `enums.prisma` (`RateLimitMatchKind`), `entitlement.prisma` (`PlanEntitlement.rateLimit{PerMinute,WindowMs}`, `TenantEntitlement.rateLimitWindowMs`), `audit.prisma` (`ResourceType.RateLimitRule`), migration `20260822051931_task_785_rate_limit_rules`, `extensions/tenant-scope.ts` |
| **Domain** | Hand-authored `RateLimitRule{Entity,Factory,EntityMapper,Repository}` + barrels + `CoreDatabaseModule`; `ResourceType` parity in `packages/domains` |
| **Services** | `rate-limit-resolver.ts` (pure cascade), `rate-limit-rule.{cache,service,constants}.ts`, `IRateLimitRuleService`, extended `resolvePlanRateLimit` / `resolve-entitlements` / `TenantRateLimitPolicy` |
| **API** | `TieredThrottlerGuard` rewritten (resolver + bucket keying + verified tenant), `route-catalog.service.ts`, `rate-limit-headers.interceptor.ts`, 9 new controller routes + DTOs |
| **SDK** | `packages/vox-node/src/resources/admin/rate-limit.ts` regenerated; `admin-resource.ts` private helper renamed (see D-4) |
| **UI** | `rate-limit-rules-panel.tsx`, `rate-limit-explain-panel.tsx`, screen wrapped in `Tabs` (Policy / Rules / Explain), api layer extended |
| **Docs** | `docs/operations/rate-limiting.md` |

#### Deviations from the §3 design, and why

| Id | Deviation |
|---|---|
| **D-1** | **`routeMatch` is NOT nullable**; the reserved pattern `*` expresses "all routes". Postgres treats NULLs as distinct in a unique index, so a nullable column would have silently permitted unlimited duplicate tenant-wide rules. It also collapses ranks 1 and 2 into ONE lookup: `*` is simply the least specific tenant pattern, so "most specific wins" yields rank 1 > rank 2 with no discriminator column. |
| **D-2** | **`specificity` column dropped.** Pattern length is computed in memory at cache-build time. Storing it added a denormalised field that could drift from `routeMatch`, and nothing queries by it — the resolver reads the whole scope from memory anyway. |
| **D-3** | **`RateLimitRule` is NOT in `SYSTEM_SHARED_READ_MODELS`.** Nothing resolves these rows under a tenant's CLS: the cache loads inside `clsService.exit(...)` and every rule route is `manage all`. Widening reads would buy no consumer anything. |
| **D-4** | **`AdminResource.explain()` renamed to `explainPermissionError()`.** The generated `admin.rateLimit.explain()` collided with the base's private helper — a subclass cannot widen a private member, so the resource would not compile. Every generated method is named after its route, so any short verb on that base is a name a future route can take. |
| **D-5** | **No rules are seeded.** Under OD-2 a route's `@Throttle` already seeds rank 5, so a platform rule mirroring it would add no behaviour — only a second copy of a number that lives in code, which drifts the moment the decorator changes. `GET /admin/rate-limit/routes` surfaces the decorator value instead. |
| **D-6** | **The legacy 5-slug route lane is KEPT, wired, and deprecated** rather than deleted. It still feeds the guard just above the decorator. A lane the shipped admin screen and SDK still display as effective must still BE effective; deleting it would have made the UI lie. Marked `deprecated: true` in OpenAPI with the replacement named. |
| **D-7** | **The tenant self-service settings row is a first-class resolver input** (`tenantSetting`), not folded into rank 5. Discovered while updating the guard tests: folding it into the baseline would have demoted a tenant's own tighten-only row BELOW its plan, silently reversing the M2 clamp. |

#### Defects found and fixed during implementation

- **Bucket-key collapse (self-inflicted, caught by the existing suite).** The first cut keyed
  platform-lane buckets on a constant `'g'`, collapsing all 666 routes into ONE shared counter.
  Platform lanes now keep the library's own per-handler key; only tenant-resolved limits get a
  custom key.
- **Forged-token trust.** The guard's tenant came from an UNVERIFIED decode. Fine for choosing a
  tier, not for choosing a counter — a forged `alg:none` token could spend or borrow any tenant's
  budget. Now signature-verified; `throttle-guard.test.ts` case (f) pins it.

#### Behaviour changes worth knowing

1. **A tenant-wide or plan limit is ONE bucket across every route.** Two endpoints no longer get
   independent allowances under a rank-2/3 limit. Surfaced by the Lane-I tests, which had to be
   given per-case tenants.
2. **Changing which level governs a tenant restarts its window**, because the counter it is
   measured against changes with it. The safe direction: a scope change grants a fresh window
   rather than retroactively 429-ing traffic that was within its limit when served.
3. **The `@Throttle` decorator no longer beats the tenant or the plan** (OD-2). The test that
   asserted the opposite was rewritten, not deleted, with a comment naming this ticket.

### 7.4 Verification (actual output)

```
# Re-run in full after the console completeness pass (§7.5).
pnpm typecheck:all                      -> exit 0
pnpm lint:all                           -> exit 0
pnpm test:unit                          -> exit 0; 1177 files passed, 2 skipped
pnpm --filter @arcaai/database test      -> 62 files, 1586 passed
pnpm --filter @arcaai/domains  test      -> 152 files, 1841 passed
pnpm --filter @arcaai/applications test  -> 535 files, 9760 passed
pnpm --filter @arcaai/admin-console test -> 214 files, 1702 passed
pnpm --filter @arcaai/vox-node test      -> 18 files, 233 passed
pnpm --filter @arcaai/admin-console build/lint/typecheck -> clean

gen:model:check    -> no drift (174 files)
gen:entity:check   -> no drift (101 files) + schema coverage OK (103 models)
gen:factory:check  -> no drift (101 files) + schema coverage OK (103 models)
prisma migrate diff (shadow DB) -> "-- This is an empty migration."

pnpm api:openapi:check -> OK (description debt 411/596, was max 412 — ratchet TIGHTENED to 411/289)
pnpm api:portal:check  -> no drift (admin 596 ops, business 178 ops)
gen:admin:check        -> no drift (52 areas, 400 routes, 365 schemas)
pnpm api:route-manifest -> 666 routes (was 657); all 11 RateLimitAdminController routes carry
                           manage:all + apiKeyForbidden + svc:admin:rate-limit:manage,
                           PATCH rules/:id carries requiresIfMatch
```

New tests: 18 resolver cases (the full precedence contract), 19 rule-service cases, 26 UI cases
(rules, plans, explain, tab wiring), plus 3 new guard cases (forged token, cross-tenant bucket
isolation, plan-beats-decorator).

Post-console-pass re-run: `typecheck:all` exit 0 · `lint:all` exit 0 · `test:unit` exit 0
(1177 files) · admin-console 214 files / 1702 tests + 26 rate-limit cases · `api:openapi:check`,
`api:portal:check` (598 admin ops) and `gen:admin:check` (402 routes) all clean · route manifest
668 routes.

### 7.5 Console completeness pass (2026-08-22, follow-up)

The first pass left **US-3 with no surface at all** — `SetRateLimitPlanRequest` was written as a
DTO and never given a route, so the plan lane was reachable only by editing an entitlement on a
different screen. Two smaller gaps went with it: a rule's limit could not be EDITED (only toggled
or deleted), and the tenant field on a new rule was a raw UUID text box.

| File | Change |
|---|---|
| `entitlements/dto/plan-entitlement.dto.ts` | `rateLimitPerMinute` / `rateLimitWindowMs` on the response AND the update request |
| `entitlements/entitlements.service.ts` | carries both through `updatePlanEntitlement` and `toPlanResponse`; `!== undefined` guards, because `null` MEANS "clear it and fall back to the tier" |
| `admin-rate-limit/rate-limit-admin.controller.ts` | `GET plans`, `PATCH plans/:plan` — a read-through PROJECTION of `IEntitlementsService`, not a second store |
| `admin-rate-limit/rate-limit-admin.module.ts` | imports `EntitlementsServiceModule` (`RateLimitServiceModule` imports it but does not re-export its token — a compile-clean, runtime-fatal miss, caught by booting the app) |
| `rate-limit-plans-panel.tsx` | **new** Plans tab |
| `rate-limit-rules-panel.tsx` | edit dialog for an existing rule; tenant `<select>` fed by a feature-local tenant read; scope-qualified aria-labels |
| `rate-limits-screen.tsx` | Plans tab wired in |

Two further decisions:

- **The tenant picker does NOT import `features/tenants`.** Features never import each other
  (`13-nextjs-apps.md` §Structure), so the rate-limits feature carries its own two-field
  `TenantOption` read against `admin/tenants`. A small projection is cheaper than the coupling.
- **A rule's SCOPE is not editable.** Tenant + pattern + match kind is the rule's identity — the
  unique index is keyed on it — so changing it is a delete-and-recreate, and the dialog says so
  rather than pretending otherwise.

**A11y defect found and fixed:** two rules naming the same route in different scopes produced
byte-identical accessible names on their Edit/Delete/toggle controls — indistinguishable to a
screen reader. Every control's label is now scope-qualified. Found by a test that could not tell
the two buttons apart either.

### 7.6 User-story coverage (final)

| Story | Gateway | Console |
|---|---|---|
| US-1 tenant × route | `POST/PATCH/DELETE admin/rate-limit/rules` | **Rules** tab — create (tenant + route pickers), edit limit/window, exempt, delete |
| US-2 tenant, all routes | same, `routeMatch: '*'` | **Rules** tab |
| US-3 subscription plan | `GET/PATCH admin/rate-limit/plans` | **Plans** tab — named tier or absolute limit, OCC-guarded |
| US-4 platform route | same rules API, no `tenantId` | **Rules** tab — "Platform-wide (all tenants)" |
| US-5 platform base | `PUT admin/rate-limit/tiers/:tier` | **Policy** tab |
| — why am I throttled? | `GET admin/rate-limit/explain` | **Explain** tab |

### 7.7 Open-item closeout (2026-08-22)

E2E was run by the owner and passed, closing **O-7**. The rest were then worked to
completion.

| Item | Resolution |
|---|---|
| **O-1** — `plan` column on `RateLimitRule`? | **No.** Plan × route is not a story anyone has asked for, and the column is a purely additive change later (nullable column + widened unique index). Adding it now would ship an always-null column and a second way to express rank 3. |
| **O-2** — per-rule window, or a fixed 60 s? | **Per-rule**, as built. A window is half of what a limit MEANS; forcing 60 s everywhere would make "100 per minute" the only expressible sentence. The Explain trace renders every level's window, so a mixed estate stays legible. |
| **O-4 / F-06** — machine credentials | **Implemented** — see below. |
| **O-5** — billing | **Keep the split** (owner decision). `resolveBillingAllowances` still treats a null plan as ungated, so a plan-less tenant gets STARTER's caps but no plan fee. Nobody is invoiced for a subscription they never bought. Documented at the call site. |
| **O-6** — CI enforcement | **Leave OFF** (owner decision). Enforcement is ON in local dev, deployed dev, staging and prod; only CI/test stay off so the e2e baseline is not coupled to quota tuning. |
| **R-2** — JWT verify cost | **Measured, accepted.** ~95 µs/verify (~0.1 ms/request; ~9.5% of one core at 1000 rps). A hand-rolled HMAC path benchmarks ~10.7 µs, and is deliberately NOT used: re-implementing JWT verification to save 85 µs on a request that also does Redis I/O trades a real security surface for an unmeasurable win. Recorded at the call site so the next person has the number, not a guess. |

#### O-4 — the machine plane is no longer ungoverned

Before this, `resolveTrustedTenantId` looked only at a bearer JWT, so **every
API-key and service-account request — including the entire `@arcaai/vox-node`
admin surface — resolved no tenant and could never reach ranks 1–3.** Three lanes
now, none of which touches the database:

| Credential | Lane | Cost |
|---|---|---|
| JWT | HS256 verify against the warm secret, **algorithms pinned** | ~95 µs CPU |
| `X-Service-Account-Token` | `ServiceAccountService.peekTenantForRateLimit` — one Redis GET of the token blob → its bound `workingTenantId` | one Redis GET |
| `X-API-Key` | `ApiKeyService.peekTenantForRateLimit` — one Redis GET of a hint published on the previous successful auth | one Redis GET |

Design notes:

- **The API-key lane is a hint, not a lookup.** It NEVER falls back to the
  database: letting an unauthenticated caller force a Postgres read on the
  pre-auth path is precisely what this guard exists to avoid. The cost is that
  the first request per key per 5-minute window rides the platform lane — the
  correct direction to be wrong, since it under-attributes rather than
  mis-attributes.
- **Both peeks skip revocation.** `UnifiedAuthGuard` runs immediately after and is
  authoritative, so a just-revoked credential can only spend the budget it
  already owned.
- **Injected by INTERFACE token.** `ApiKeyServiceModule` exports only
  `IApiKeyService`; a class-token injection under `@Optional()` would have
  resolved to `undefined` and left the lane a silent no-op that still compiled
  and still passed every test.
- **Both modules registered at AppModule root.** The guard is constructed in
  AppModule's injector, so a module imported only by a feature module is
  invisible to it — the same failure mode. Verified by booting the app and
  asserting all six of the guard's dependencies resolve on the real `APP_GUARD`
  instance (not the standalone one `ThrottleConfigModule` provides).
- **`algorithms: ['HS256']` pinned** on the verify call. `jsonwebtoken@9` already
  infers HS* from a string secret, so this changes no behaviour — but a security
  boundary should state its own contract rather than inherit it from a library
  default.

#### STARTER's structural caps (owner decision)

Raising NULL→STARTER (OD-5) exposed an inconsistency that predates it: tenant
creation provisions **8 golden departments and 14 SYSTEM ASR pipelines**, while
STARTER capped them at **2 and 1**. Provisioning writes through the repository so
creation never failed — but every new tenant landed 4× and 14× over its own caps,
could add nothing, and read `exceeded` on its capability snapshot from day one.

`maxDepartments → 8` and `maxAsrPipelines → 14`, in BOTH the seed matrix and
`PLAN_ENTITLEMENT_DEFAULTS` (parity-guarded). Sized to exactly the provisioned
catalog: STARTER gets the standard set and no room to add its own, which is a
price-ladder statement rather than an accident. **The commercial caps — 50
consultations/month, 5 users, 5 GiB — are untouched**, so pricing is unchanged.

Two resolver tests that hard-coded `2` now derive from the matrix instead, so a
future change to the provisioned catalog does not break them spuriously.

### 7.8 Enforcement turned on in dev (2026-08-22, owner request)

OD-6 changed the SEED default, but the kill-switch upsert's `update` branch omits
`value` by design — so an already-seeded database keeps whatever it had. The dev
DB was therefore still reading `false`. Two changes, on request:

1. **The live dev row was forced ON** — `value` and `defaultValue` both `'true'`,
   `_version` bumped. Only `entitlements.enabled`; `metering.reconcile.enabled`
   is untouched and stays deployed-only.
2. **`defaultValue` now TRACKS the resolved enforcement default** in the seed
   rather than being pinned to `'false'`. `defaultValue` is the RESET target —
   the value an operator reverts to — and a reset that silently disables quota
   and feature enforcement platform-wide is not a "safe" default, it is the most
   dangerous button on the screen. Reverting should restore the POLICY.

Verified by booting the application context against the dev database:

```
isEnforcementEnabled() => true
ArcaAI            gated=true  plan=ENTERPRISE  maxDepartments=40
Global (reserved) gated=false plan=null
System (reserved) gated=false plan=null
```

The reserved-tenant carve-out (OD-5) is doing its job: only the customer tenant is
gated. ArcaAI's headroom against ENTERPRISE was checked before flipping — nothing
is over, and nothing is blocked:

| | used / cap |
|---|---|
| users | 9 / 100 |
| departments | 11 / 40 |
| ASR pipelines | **17 / 20** |
| API keys | 3 / 50 |
| prompt templates | 27 / 300 |

**Watch the pipelines.** At 85% ArcaAI reports `nearLimit`, and three more
creations will 409. That is enforcement working, not a defect — but it is the
first cap this environment will actually hit.

### 7.9 NOT done

- ~~`pnpm test:e2e`~~ — **run by the owner, passed** (2026-08-22). O-7 closed.
- **CI/test stay enforcement-OFF** (O-6, owner decision). Turning them on would need the six e2e
  specs that create tenants given explicit plans first.
- **Billing still treats a plan-less tenant as ungated** (O-5, owner decision) — gated for quotas,
  not invoiced.
- **No `plan` column on `RateLimitRule`** (O-1) — plan × route stays expressible-later, not built.

---

---

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-22 | Ticket created. Current state mapped across the gateway, applications and database layers (F-01…F-07). Owner decisions OD-1…OD-4 recorded. Design, phased plan and TDD list drafted. Status: Pending — awaiting plan approval and answers to O-1…O-4. |
| 2026-08-22 | Enforcement forced ON in the dev database on owner request (`value` + `defaultValue` = true); seed `defaultValue` now tracks the resolved default so a reset restores the policy rather than disabling enforcement. Verified by booting the app context: `isEnforcementEnabled() => true`, ArcaAI gated at ENTERPRISE, both reserved tenants ungated. |
| 2026-08-22 | Open-item closeout. O-7 closed (owner ran e2e, passed). O-4/F-06 implemented — API-key and service-account traffic now reaches the tenant/plan lanes via Redis-only lookups, closing the gap that left the whole machine plane ungoverned; both modules registered at AppModule root and DI verified by booting the app. O-1, O-2, R-2 decided and recorded (R-2 measured: 95 us/verify). O-5 and O-6 settled by owner decision. STARTER's structural caps raised to match what provisioning actually creates (8 departments, 14 pipelines); commercial caps untouched. Status → Review. |
| 2026-08-22 | Console completeness pass: US-3 given a real surface (plan routes + Plans tab) after the first pass left it as a dead DTO; rule editing and a tenant picker added; scope-qualified aria-labels fix an ambiguous-accessible-name defect. All five stories now reachable from the Rate Limits screen (§7.6). |
| 2026-08-22 | Phases P0–P6 implemented: `RateLimitRule` (schema, migration, domain trio, service, cache), the pure five-level resolver, the guard rewrite with OD-3 bucket keying and verified tenant identity, the route catalog, `explain`, the headers interceptor, 9 admin routes, SDK regeneration, the Rules/Explain console tabs, and `docs/operations/rate-limiting.md`. Deviations D-1…D-7 recorded. Two defects found and fixed in-flight (bucket-key collapse, forged-token trust). Status stays In Progress pending e2e (O-7). |
| 2026-08-22 | O-3 resolved as OD-5 (plan-less customer → STARTER; reserved tenants stay ungated) and OD-6 (enforcement defaults ON, CI/test excepted). Both **implemented and verified** (§7.1–7.2), test-first. Raised O-5 (billing deliberately excluded) and O-6 (CI posture) and R-8 (TASK-646 gap now locally reachable). Status → In Progress. |
