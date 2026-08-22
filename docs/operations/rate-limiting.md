# Rate Limiting — Operator Guide

How a request's rate limit is decided, who can change it, and how to answer
*"why is this tenant getting 429s?"*.

Implemented by TASK-785. Code: `packages/applications/src/services/rate-limit/`,
`apps/api/src/modules/throttle/`, `apps/admin-console/src/features/rate-limits/`.

---

## 1. The precedence chain

Five levels. **The first one with an opinion wins** — resolution stops there.

| Rank | Level | Where it lives | Who writes it |
|---|---|---|---|
| 1 | **Tenant × route** | `RateLimitRule`, `tenantId = <customer>`, `routeMatch` names a route | Super admin |
| 2 | **Tenant** | `RateLimitRule`, `tenantId = <customer>`, `routeMatch = '*'` | Super admin |
| 2 | **Tenant (self-service)** | `rateLimit.maxRequests` / `rateLimit.windowMs` settings row | The tenant — **tighten-only** |
| 3 | **Subscription plan** | `PlanEntitlement` / `TenantEntitlement` | Super admin |
| 4 | **Platform route** | `RateLimitRule`, `tenantId = SYSTEM` | Super admin |
| 5 | **Platform base** | the route's `@Throttle` value, else `rate-limit.tier.<t>.*` | Super admin (code seeds it) |

Two properties that surprise people, both deliberate:

- **Tenant specificity outranks route specificity.** A tenant's broad
  `*:/api/v1/*` rule beats a SYSTEM rule naming the exact route. Pattern
  precision only breaks ties *within* one level.
- **A route's `@Throttle` decorator is rank 5's seed, not an override.** It is
  the default a route falls back to, and any DB level above it wins. Before
  TASK-785 the decorator beat both the tenant and the plan, which meant an
  ENTERPRISE tenant could not be granted more than `auth/login`'s hardcoded
  5/min without a redeploy.

**An inactive rule EXEMPTS its scope.** `active: false` is not "no opinion" —
a matching rule always terminates resolution, so it turns throttling *off* for
that scope rather than deferring to the next rank.

### Matching within a level

`EXACT` beats `PREFIX`; among prefixes, the longest wins; ties break
deterministically on the pattern then the row id.

```
EXACT   POST:/api/v1/auth/login        the whole route key must match
PREFIX  *:/api/v1/admin/*              any method, that subtree
PREFIX  *                              every route (rank 2; tenant-scoped only)
```

A trailing `/*` is compared **including the slash**, so `/api/v1/admin/*` matches
`/api/v1/admin/x` but never `/api/v1/admin-tools/x`.

A **platform-scoped rule may not use `*`**. Rank 5 is the single platform-wide
knob; a second one would silently outrank the tiers screen an admin just edited.

---

## 2. How the counter is bucketed

The limit answers *how many*; the bucket answers *shared by whom*. They are
separate decisions and both matter.

| Resolved level | Counted per |
|---|---|
| Tenant × route | tenant + route |
| Tenant, Plan | **tenant** — one bucket across all of that tenant's traffic |
| Platform route, Platform base | source IP, per route (unchanged from before) |

Before TASK-785 **every** limit was per-IP, so "500/min for tenant A" actually
meant "500/min per source IP": a tenant behind ten egress IPs got 5000, and two
different tenants behind one NAT shared a bucket and could throttle each other.

Consequences worth knowing:

- A tenant-wide (rank 2) or plan (rank 3) limit is **one budget across every
  route**. Two endpoints do not get independent allowances.
- Changing which level governs a tenant also changes which counter it is measured
  against, so **the window restarts**. That is the safe direction: a scope change
  grants a fresh window rather than retroactively 429-ing traffic that was within
  its limit when it was served.

### Tenant identity is proven, per credential class

The throttler runs FIRST in the guard chain, before authentication, so the tenant
comes from the credential itself. All three classes are handled, and **none of
them touches the database**:

| Credential | How the tenant is proven | Cost |
|---|---|---|
| **JWT** (bearer, or SSE `?token=`) | HS256 signature verified against the warm `JWT_SECRET_KEY`, algorithm pinned | ~95 µs CPU |
| **Service-account token** (`X-Service-Account-Token`) | one Redis `GET` of the token blob minted at exchange → its bound `workingTenantId` | one Redis GET |
| **API key** (`X-API-Key`) | one Redis `GET` of a hint published by `ApiKeyService` on the previous successful authentication | one Redis GET |

Anything unprovable — a forged token, a cold hint, no credential — resolves no
tenant, rides ranks 4–5, and is IP-keyed.

That is load-bearing, not ceremony. An unproven claim is fine for choosing a
*tier*, but it decides which tenant's **counter** a request spends, so it would
otherwise let anyone drain, or borrow, any tenant's budget.

**The API-key hint is a cache, not an oracle.** The FIRST request from a given key
in each 5-minute window resolves no tenant and rides the platform lane. That is
the correct direction to be wrong: it under-attributes one request rather than
attributing it to the wrong tenant, and it keeps an unauthenticated caller from
forcing a database read on the pre-auth path.

All three lanes deliberately skip revocation and ability checks. `UnifiedAuthGuard`
runs immediately after and is authoritative, so a credential that has just lost
its authority can only spend the budget it already owned.

---

## 3. Answering "why is this tenant being throttled?"

Use `explain`. With five levels and two match kinds this is not answerable by
reading the rules list.

```bash
curl -s "$GATEWAY/api/v1/admin/rate-limit/explain?method=POST&path=/api/v1/auth/login&tenantId=$TENANT" \
  -H "Authorization: Bearer $SUPER_ADMIN_JWT" | jq
```

It returns the winning level, the rule that decided, **how the counter is
bucketed**, and what every other level offered. The admin console exposes the
same thing on **Rate Limits → Explain**.

`path` must be the router's registered PATTERN (`/api/v1/tenants/:id`), not a
resolved URL. `GET /admin/rate-limit/routes` lists all of them.

---

## 4. Admin surface

All under `/api/v1/admin/rate-limit`, SUPER_ADMIN-only (`manage all` +
`@ForbidApiKey` + `svc:admin:rate-limit:manage`).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `` | Kill-switch + tier baselines + legacy route overrides |
| `PUT` | `enabled` | Global kill-switch |
| `PUT` | `tiers/:tier` | Rank 5 baselines |
| `GET` | `routes` | The route catalog (every gateway route) |
| `GET`/`POST` | `rules` | List / create rules (ranks 1, 2, 4) |
| `GET`/`PATCH`/`DELETE` | `rules/:id` | One rule — PATCH is OCC (`If-Match`) |
| `GET`/`PATCH` | `plans` / `plans/:plan` | Rank 3 — each subscription plan's limit (OCC) |
| `GET` | `explain` | Resolution trace |
| `PUT` | `routes/:routeId` | **Deprecated** — the legacy 5-slug lane, see §6 |

Changes are live immediately: every write refreshes this node's cache in-request
and publishes on `rate-limit-rules:invalidate` for its peers. The 45 s cron is
the backstop, not the mechanism.

**Rule caps:** 200 per tenant, 500 platform-wide. `bestMatch` scans one scope per
request, so the count is a latency input. Exceeding a cap is a 409 at write time,
never a silent truncation.

---

## 5. Failure posture

| Failure | Behaviour |
|---|---|
| Rule store unreachable | **Fail open** — the cache keeps its previous snapshot; resolution falls through to rank 5. A config error never produces a 429. |
| Entitlements unavailable | Rank 3 has no opinion; the chain continues. |
| Redis counter store down | Falls back to the per-instance in-memory store, which counts per node and is therefore **stricter**, never unlimited. |
| No route pattern available | Route-scoped rules do not apply; resolution degrades to rank 5. Never keyed on a raw URL — that would make bucket cardinality unbounded. |

Note the asymmetry: the **config** plane fails open, the **data** plane fails
strict. Losing the ability to read a limit must not block traffic; losing the
ability to share a counter must not grant unlimited traffic.

---

## 6. The two key grammars (historical debt)

Two `GlobalSetting` grammars for related things. Both are live:

| Grammar | Keys | Scope | Written by |
|---|---|---|---|
| `rate-limit.*` (hyphen) | `enabled`, `tier.<t>.{limit,ttl}`, `route.<slug>.{limit,ttl,enabled}` | SYSTEM only | `RateLimitAdminService` |
| `rateLimit.*` (camel) | `enabled`, `maxRequests`, `windowMs` | tenant-overridable | settings registry |

The camel lane is the tenant **self-service** lane and is clamped tighten-only.
The hyphen lane is the platform admin lane.

`route.<slug>.*` covers five hand-registered slugs (`auth.login`,
`auth.impersonate`, `auth.refresh`, `health`, `monitoring`) and is **superseded by
`RateLimitRule`**, which governs any of the gateway's routes for any tenant. It
is kept wired — and still honoured by the guard, just above the decorator — only
so the shipped admin screen and SDK keep telling the truth: a lane still
displayed as effective must still BE effective. Delete it once the console's
Rules tab is the only writer.

---

## 7. Plan caps vs. what a tenant is provisioned

A plan's **structural** caps (`maxDepartments`, `maxAsrPipelines`) are sized to
what tenant creation actually provisions — 8 golden departments and the 14 SYSTEM
ASR pipelines cloned into every new tenant. They are NOT commercial levers.

This matters because provisioning writes through the repository and so bypasses
quota enforcement: a tenant whose structural caps sat below the provisioned
catalog would be created successfully and then be unable to add anything, showing
`exceeded` on its own capability snapshot from day one. STARTER was in exactly
that state (2 departments, 1 pipeline) until TASK-785 raised it.

**If you change what provisioning creates, re-check the STARTER row** in
`seed/15-entitlements.ts` AND `entitlements.constants.ts` (the two are parity-
guarded). The commercial caps — consultations, users, storage — are independent
and were deliberately left alone.

---

## 8. Turning enforcement on in an existing database

The seed's kill-switch upsert omits `value` on its `update` branch, so a re-seed
never clobbers a live operator toggle — which also means **an already-seeded
database does not pick up a change to the seed default.** To turn entitlements
enforcement on where it is currently off:

```bash
curl -X PUT "$GATEWAY/api/v1/admin/entitlements/enabled" \
  -H "Authorization: Bearer $SUPER_ADMIN_JWT" \
  -H 'Content-Type: application/json' -d '{"enabled":true}'
```

Before flipping it on an environment with real tenants, check their headroom
(`GET /api/v1/admin/entitlements/tenants/:id`): enforcement is immediate, and a
tenant already over a cap starts getting 409s on the next create. The reserved
SYSTEM and Global tenants are unaffected — they resolve ungated by design.

---

## 9. Related

- `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers — where a setting belongs
- `docs/implementation/TASK-785-Tiered-Rate-Limit-Governance/README.md` — design and decisions
- `packages/applications/src/services/rate-limit/rate-limit-resolver.ts` — the cascade, as pure code
