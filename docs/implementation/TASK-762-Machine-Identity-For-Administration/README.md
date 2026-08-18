# TASK-762 — Machine Identity for Administration

| | |
|---|---|
| **Status** | **Pending** — owner decision recorded 2026-08-18: **Option 2, platform-issued service account. Build now.** |
| **Type** | Decision + design (no code in this ticket) |
| **Owner** | Platform / Architecture — owner decision required before any implementation |
| **Date** | 2026-08-18 |
| **Size** | Decision: S · Implementation (Option 2): L |
| **Source** | [api-design-conformance-review.md](../../architecture/api-design-conformance-review.md) §2.3 and §3.1 step 3 |
| **Related** | TASK-708 (Completed — §6 owner ruling on `/admin/*` vs `/internal/*`); TASK-742 (API-key surface audit, referenced in `main.ts` and `apikey-scopes.registry.ts`); TASK-756 (privilege ceiling on API-key minting — review §3.1 step 1); TASK-757 (`@ForbidApiKey()` across the admin plane — review §3.1 step 2); TASK-761 (boot audit: admin prefix ⇒ no `@RequiredScopes`) |
| **Note on related tickets** | TASK-754…761 were authored concurrently with this ticket from the same review; the numbering follows the review's sequencing table (§4). Direct links: [TASK-756](../TASK-756-Apikey-Minting-Privilege-Ceiling/README.md), [TASK-757](../TASK-757-Admin-Plane-Jwt-Only/README.md), [TASK-761](../TASK-761-Api-Plane-Conformance-Gates/README.md). |

> **Blocking relationship, stated plainly.** This ticket does **not** block TASK-757 today. Pre-launch there is **zero** live admin automation on the API-key path (verified — §2.5), so removing the key path from `/admin/*` breaks nothing that exists. What this ticket blocks is **shipping TASK-757 into any environment that has acquired live admin automation**. Once an integrator or an operational script depends on headless administration, TASK-757 becomes a breaking change with no migration target, because there is no third credential class to migrate to. Resolve this ticket before that day, not after.

---

## 1. Requirement Analysis

### 1.1 The problem

Policy rule **A2** (review §0) makes `/api/v1/admin/*` **JWT only**. TASK-757 implements it by applying `@ForbidApiKey()` across the admin plane. A JWT is issued to a **human** through an interactive login; there is no non-interactive way to obtain one.

Today the platform has exactly **two** machine credential paths, and A2 closes or excludes both:

| Path | Reaches admin today? | After TASK-757 |
|---|---|---|
| Tenant API key (`X-API-Key`) | Yes — 67 `admin/*` controllers | **Removed** by `@ForbidApiKey()` |
| `X-Service-Token` (peer services) | **No** — structurally confined to `/internal/*` | Unchanged; still `/internal/*` only |

There is no OAuth2 client-credentials issuer and no machine JWT (§2.4). The only reserved internal scope is `internal:stt:worker` (§2.3).

**Net effect: after TASK-757 there is ZERO machine path to administration — not a narrowed one.** That is a design decision that deserves to be made deliberately, which is what this ticket is for. The review states the same conclusion at §2.3 and defers the answer to §3.1 step 3.

### 1.2 The constraint that rules out both cheap fixes

TASK-708 §6, owner answer (`docs/implementation/TASK-708-Apikey-Scope-Verification/README.md:330`):

> *"Lets review, suggest best practices. We cannot mix the `/admin/*` and `/internal/*` routes as they was design for different purposes."*

This forbids the two shortcuts that would otherwise close the gap in an afternoon:

- **Do NOT extend `X-Service-Token` to admin routes.** That is precisely the mixing the ruling prohibits, and it is bad security independently: the service token is one shared devops-set secret (per the standing decision recorded in memory, *"one shared internal service token"*) with no per-caller identity, no per-caller scope, and no revocation granularity. Granting it admin reach makes every Python peer service a platform administrator.
- **Do NOT re-admit tenant API keys to `/admin/*`.** That is TASK-757 reversed, and the underlying defect (tenant-admin self-service minting of `admin:*` keys — §2.6) is exactly what TASK-756 exists to fix.

**Therefore any solution must be a THIRD credential class**, with its own issuance path, its own scope namespace, and its own guard — sharing neither mechanism.

### 1.3 What is in scope

Choosing between the three options in §3, and — for whichever is chosen — specifying issuance gating, credential storage, rotation/revocation, audit attribution, the tenant→SYSTEM config-cascade interaction, and the boot-audit assertions TASK-761 must carry. Writing the code is **not** in scope until the owner decides.

### 1.4 What is out of scope

Anything on the `/internal/*` plane (peer-service auth is settled: `@Public()` + service-token guard). The `SttInternalController` deviation (§2.7) belongs to review §3.2, not here. Re-litigating A2 itself.

---

## 2. Current State Evaluation

All evidence below was re-verified against the working tree (branch `feat/loop`, 2026-08-18). Line numbers are from that read.

### 2.1 No admin controller uses a service-token guard — **confirmed by exhaustive grep**

This is the load-bearing claim of the whole ticket, so it was verified two ways.

There are exactly three service-token guard classes in the tree:

| Guard | File |
|---|---|
| `InternalServiceTokenGuard` | `apps/api/src/modules/internal/internal-service-token.guard.ts:22` |
| `HarnessServiceTokenGuard` | `apps/api/src/modules/consultation/harness-service-token.guard.ts:16` |
| `ServiceReleaseTokenGuard` | `apps/api/src/modules/service-release/service-release-token.guard.ts:24` |

Every `@UseGuards(...)` referencing any of them, across all of `apps/api/src` (excluding tests), lands on an `internal/`-prefixed controller:

| Controller | Prefix | Decorators |
|---|---|---|
| `HarnessInternalController` | `internal/harness` (`harness-internal.controller.ts:207`) | `@Public()` `:205` + `@UseGuards(HarnessServiceTokenGuard)` `:206` |
| `ConsentInternalController` | `internal/consent` (`consent-internal.controller.ts:91`) | `@Public()` `:89` + `@UseGuards(HarnessServiceTokenGuard)` `:90` |
| `EffectiveConfigController` | `internal/effective-config` (`effective-config.controller.ts:29`) | `@Public()` `:27` + `@UseGuards(InternalServiceTokenGuard)` `:28` |
| `ServiceReleaseInternalController` | `internal/service-releases` (`service-release-internal.controller.ts:20`) | `@Public()` `:17` + `@UseGuards(ServiceReleaseTokenGuard)` `:18` |
| `SttInternalController` | `internal/stt` (`stt-internal.controller.ts:52`) | **no `@UseGuards`** — `@Authorize()` + `@RequiredScopes('internal:stt:worker')` `:51` |

Second check, from the opposite direction: **67 controllers** declare `@Controller('admin…')`, and **not one of them declares `@UseGuards` at all** (`grep -ln '@UseGuards'` over that file set returns nothing). The admin plane and the service-token mechanism are disjoint today. The non-mixing ruling is currently satisfied by accident of implementation rather than by an enforced invariant — see §5.4.

### 2.2 The service token itself is not an identity

`InternalServiceTokenGuard` matches a presented header against a small set of named platform secrets (`internal-service-token.guard.ts:59,104`); `ServiceReleaseTokenGuard` does the same over its own `KNOWN_SECRETS` list (`service-release-token.guard.ts:27,53`). A successful match yields *"a trusted peer service called us"* — no principal, no CASL ability, no tenant, no audit subject. Nothing in these guards could carry an admin authorization decision even if the ruling permitted it.

### 2.3 The reserved internal scope is exactly one

`packages/applications/src/services/apiKey/apikey-scopes.registry.ts:69` — `internal:stt:worker`, the only entry in category `Internal`. Confirmed by grep for `'internal:` across the registry: one hit.

### 2.4 There is no OAuth2 client-credentials issuer and no machine JWT

`grep -i` for `client_credentials` / `clientCredentials` / `grant_type` across `apps/api/src` and `packages/applications/src` returns only **outbound** uses — HOPE acting as a *client* against third-party IdPs:

- `packages/applications/src/services/directory-sync/ms-graph-directory.provider.ts:85` — `grant_type: 'client_credentials'` against the tenant's own Azure AD app registration.
- `packages/applications/src/services/directory-sync/google-directory.provider.ts:104` — `urn:ietf:params:oauth:grant-type:jwt-bearer`.

Nothing issues a token to a machine caller. Worth noting for §3 option 3: the platform already knows how to *consume* this grant, so the shape is familiar — but consuming and issuing are different builds.

### 2.5 No first-party consumer of the admin key path exists

`grep -rn 'X-API-Key\|x-api-key'` over `apps/admin-console/src`, `scripts/`, and `.gitlab/` returns **nothing**. The admin console's BFF proxy sends `Authorization: Bearer` only (review §2.2, `hope-proxy.ts:20-35`). There is no CI job, deployment script, or operational tool that administers the platform with a key. This is what makes "do nothing" (§3 option 1) genuinely viable pre-launch, and it is also why TASK-757 is safe to ship today.

### 2.6 The minting defect this ticket must not reproduce

`ApiKeyService.create()` persists `request.scopes` verbatim — `packages/applications/src/services/apiKey/apikey.service.ts:326` (`scopes: request.scopes ?? null`) — with no check that the caller holds the ability each scope implies. The issuing route is `@Controller('admin/api-keys')` + `@CanManage('ApiKey')` (`apps/api/src/modules/api-key/api-key.controller.ts:22-23`) — a **tenant-admin-reachable ability**, not SUPER_ADMIN. A tenant admin can therefore mint a key carrying `admin:*` (registry `:152`) or the bare `'*'` (`:155`).

Partial mitigation, stated precisely so the residual risk is not overstated: `enforceApiKeyAbilities` (`unified-auth.guard.ts:450-511`) rebuilds CASL for the key's **bound user** on every request and denies if that user lacks the route's ability; an unbound key is refused outright (`:465-474`). Scope and ability are a conjunction. So over-granting creates no raw privilege delta — it creates a **long-lived static credential with an admin's blast radius**, minus MFA, session expiry, and revoke-on-logout.

**This is the exact failure mode a service-account credential must not inherit.** TASK-756 fixes it for API keys; §5.2 below specifies the stronger posture for the new class (SUPER_ADMIN-only issuance, no tenant-admin self-service at all).

### 2.7 Two facts that complicate the picture (see §7 for the contradictions they raise)

- **`SttInternalController` is still on the API-key path.** `stt-internal.controller.ts:51` carries `@RequiredScopes('internal:stt:worker')` and no service-token guard, and the registry comment at `:56-68` explains why (the STT worker presents an *API key* as `X-Internal-Service-Key`, per BUG-013). TASK-708's Change History claims this was reverted to a dedicated `SttInternalServiceTokenGuard` with the scope "removed entirely" — **the tree does not match that claim**. The review's §2.5 description ("lone internal surface on the API-key path") is the accurate one.
- **The API-key principal carries no roles.** `handleApiKeyAuth` sets CLS `user` to `{ id, tenantId }` only (`unified-auth.guard.ts:340-344`), while `isSuperAdmin` reads `user.roles` (`packages/applications/src/common/tenant-guards.ts:55-59`). Every imperative super-admin check in the codebase therefore returns **false** for an API-key caller — an accidental but real defence. A service-account principal that fails to populate `roles` would inherit that behaviour and silently fail on every super-admin-gated route; one that populates it carelessly would silently gain super-admin. §5.5 makes this an explicit test.

### 2.8 Audit has nowhere to record a machine actor

`AuditLog` carries `responsibleUserId String?` and `responsibleIp String?` and nothing else actor-shaped (`packages/database/src/prisma/db_main/audit.prisma:11-12`). `BaseService.broadcastSysEvent` stamps `responsibleEntityId: this.requestUser?.id` (`packages/applications/src/common/base.service.ts:91`), which `SysEventService` writes to `responsibleUserId` (`sysEvent.service.ts:138`). On the API-key path that resolves to the key's **bound human user** — so a machine's admin action is today attributed to a person, with no record of which credential performed it. Any new machine identity must fix this rather than deepen it (§5.6).

---

## 3. Options Analysis

None of these is obviously right. The honest summary is that option 1 is correct **if and only if** the demand assumption holds, and the cost of being wrong about that assumption is what option 2 buys down.

### Option 1 — Do nothing pre-launch; declare headless administration unsupported

Ship TASK-757, document in the public API surface that `/api/v1/admin/*` requires an interactive session JWT, and revisit when an integrator asks.

| | |
|---|---|
| **Cost** | Near zero. One documentation change and one line in the SDK README. |
| **Correct when** | No integrator, no customer, and no internal operational tool needs headless administration before GA. §2.5 shows that is true **today**. |
| **Risk** | Discovered late — by a customer, mid-integration, at which point the answer is "wait a quarter". Also silently pushes integrators toward the two things we do not want: asking for the service token, or scripting a human login and scraping the JWT (which works, is unrevocable per-automation, and is worse than any credential we would have designed). |
| **Hidden cost** | The 56 `admin:*` scope strings (registry `:39-134` plus the `admin:*` wildcard at `:152`) sit in reserve indefinitely. Review §3.1 step 2 is explicit that they must **not** be deleted; carrying a dead-but-reserved vocabulary has a maintenance drag and invites someone to "clean it up". |

**This option is not "no decision" — it is a decision with an owner attached.** It requires the owner to assert that no headless administration is needed pre-GA. If nobody will assert that, this option is not available.

### Option 2 — Platform-issued service account (`svc:*` namespace, short-lived tokens)

A new credential class: a `ServiceAccount` row issued **only** by a SUPER_ADMIN, holding a `svc:*` scope set, exchanging a long-lived client secret (stored in Vault) for a short-lived bearer token that authenticates as a first-class principal with its own CASL ability.

| | |
|---|---|
| **Cost** | Large but bounded — new model + domain trio, an issuance surface, a token-exchange endpoint, a guard branch, a principal shape, audit columns, boot audits. Realistically a full sprint. |
| **Fit** | Highest. It reuses the `admin:*` scope vocabulary TASK-757 puts in reserve (renamespaced `svc:admin:*` or mapped 1:1), reuses `SecretsService`/Vault (§2.4 shows the plumbing exists), and reuses the CASL principal machinery already in `enforceApiKeyAbilities`. |
| **Risk** | We design an auth mechanism ourselves. Every self-rolled credential class is a place to get token lifetime, replay, revocation, or clock skew wrong. Mitigated by keeping the token opaque and server-side-validated rather than inventing a JWT claim set. |
| **Interop** | Poor-to-fair. Integrators must implement a HOPE-specific exchange. Fine for a handful of partners; poor for a self-serve developer platform. |
| **Reversibility** | Good. Option 2 is a strict subset of option 3's data model — a `ServiceAccount` with a client id and a Vault-held secret **is** an OAuth2 client. Adding a standards-compliant `/oauth2/token` endpoint on top later is additive, not a rewrite. |

### Option 3 — OAuth2 client-credentials (RFC 6749 §4.4 / RFC 9068)

A standards-compliant token endpoint issuing scoped access tokens to registered clients.

| | |
|---|---|
| **Cost** | Largest. Client registration, token endpoint, discovery metadata, JWKS or introspection, scope-to-audience mapping, token revocation (RFC 7009), plus the conformance surface that "we do OAuth2" implies. |
| **Fit** | Best long-term. Every integrator's HTTP stack already speaks it; nothing to document beyond scopes and the token URL. |
| **Risk** | Building the *appearance* of OAuth2 without the whole of it is worse than not claiming it — partial implementations (no revocation, no rotation, no discovery) fail integrator security review precisely because the standard sets the expectation. |
| **When it wins** | If the platform will have a public developer program with self-serve integrations. If the realistic ceiling is a dozen named partners, this is over-built. |

---

## 4. Recommendation

**Recommend Option 2 (platform-issued service account), implemented only when a concrete consumer exists — and Option 1 as the standing position until then.**

The two are not alternatives in sequence-terms; they are the same decision at two moments. Ship TASK-757 now on the strength of §2.5 (nothing to break), state the unsupported position publicly, and hold this ticket's implementation plan (§5) ready to execute the moment a first consumer is named.

Reasoning:

1. **Building option 2 with no consumer means designing scopes for imagined use.** The `svc:*` namespace should be derived from what the first consumer actually administers, not from all 56 admin areas defensively. Premature construction here produces a wide credential nobody needs — the same shape of mistake as the original 7-scope admin taxonomy that had to be rebuilt in TASK-708.
2. **Option 3's interop advantage is real but currently unpaid-for.** A public developer program does not exist. Option 2's data model is a proper subset of option 3's, so choosing 2 does not foreclose 3.
3. **Option 1 alone is insufficient as a permanent answer** because the failure mode is not "an integrator is blocked" — it is "an integrator improvises", and every improvisation available to them (scripted human login, requesting the service token, a tenant key that TASK-757 no longer honours) is worse than any credential we would design.

### What would change this recommendation

| Signal | New recommendation |
|---|---|
| A named consumer appears **before** TASK-757 ships | Option 2, built in the same change as TASK-757 — exactly what review §3.1 ("ship the machine identity in the same change") calls for. |
| A public/self-serve developer program is committed to the roadmap | Option 3 directly. Do not build option 2 first and migrate; issue a standards token from day one. |
| The owner asserts headless administration will never be supported (admin is human-only, forever) | Option 1 permanently. Then **delete** the reserved `admin:*` scopes rather than reserving them, and record the deletion rationale so the vocabulary is not re-derived. |
| Regulatory/compliance review requires per-automation attribution for admin actions | Option 2 becomes urgent regardless of demand — §2.8 shows the platform currently cannot attribute a machine admin action to anything but a human. |

Everything below in §5–§6 specifies **Option 2**. It is a design, not an approval to build.

---

## 5. Implementation Plan (Option 2 — on owner approval only)

Ordered. Each step lists its TDD tests; every test is written to fail first.

### 5.0 Prerequisites

TASK-756 (privilege ceiling) and TASK-757 (`@ForbidApiKey()` across admin) land first. This ticket must not be used as a reason to delay either — it is downstream of both.

### 5.1 Step 1 — `ServiceAccount` model and domain trio

New Prisma model in `packages/database/src/prisma/db_main/` (own file, `service-account.prisma`), standard field template per `02-database-prisma.md`: `metaData`/`version`/`id` (uuid7), `tenantId` (NOT NULL — see §5.3 for what value), business fields `clientId` (unique, non-secret), `displayName`, `scopes Json`, `credentialsRef String` (Vault path — **never a secret value**), `allowedIps Json?`, `tokenTtlSeconds Int`, `lastUsedAt`, `rotatedAt`, `previousCredentialsRef String?`, `previousCredentialExpiresAt DateTime?`, then the standard resource-status / audit blocks.

Follow `03-domain-layer.md` exactly: `pnpm gen:model` only, then **hand-author** entity/factory/mapper/repository (`gen:mapper` is destructive). Mapper carries `FIELDS_NOT_WRITABLE = ['version']` (this model is OCC-written). Add `ServiceAccount` to `ResourceType` in **both** `audit.prisma` (+ `ALTER TYPE … ADD VALUE` migration) and `packages/domains/src/enums/generated/ResourceType.ts` — omitting this is the TASK-366 failure mode. Register the repository in `CoreDatabaseModule`. Add to `TENANT_SCOPED_MODELS`.

**Tests (RED first)**
1. `ServiceAccountFactory.CreateServiceAccount` assigns a uuid7 id and defaults `resourceStatus: ENABLED`.
2. Entity `validate()` rejects an empty `scopes` array (a credential that can do nothing is a configuration error, not a valid row).
3. Entity `validate()` rejects any scope string not in the `svc:*` namespace.
4. Mapper strips `version` from update payloads.
5. `resourceType.enum-parity.test.ts` passes with the new member (existing guard).

### 5.2 Step 2 — Issuance, gated at SUPER_ADMIN

`ServiceAccountController` at `@Controller('admin/service-accounts')`, class-level `@CanManage('ServiceAccount')` **plus** an imperative `isSuperAdmin` check in the service, carrying the standardized `// AUTH-NOTE:` marker per `05-nestjs-api.md` §"Imperative Privilege Checks". The decorator alone understates the gate deliberately — this is the sanctioned "super-admin-only action on a resource whose ability tenant admins could otherwise hold" pattern.

**This is the single most important gate in the design.** §2.6 shows what happens without it: `@CanManage('ApiKey')` is tenant-admin-reachable, and that is the whole of the TASK-756 defect. A tenant admin must **never** be able to mint a service account, not even one scoped to their own tenant, because scope-to-ability verification at mint time is a weaker guarantee than never letting the mint happen.

Also: the controller carries `@ForbidApiKey()` **and** must reject service-account principals — a service account may not mint another service account. No self-replication, no privilege loop.

**Tests (RED first)**
6. `POST admin/service-accounts` as a tenant admin holding `manage:ServiceAccount` → **403** (privilege boundary, not the 404-over-403 posture).
7. Same as SUPER_ADMIN → 201, and the response body contains the client secret **exactly once**.
8. A `GET`/re-read of the account never returns the secret.
9. `POST` authenticated by a service-account token → 403 regardless of scopes held (including a `svc:*` wildcard).
10. Cross-tenant `GET admin/service-accounts/:id` → **404** (cross-tenant posture preserved).
11. Creating an account with a scope the SUPER_ADMIN principal does not hold → 403 (the privilege ceiling TASK-756 establishes, applied to this class from day one rather than retrofitted).

### 5.3 Step 3 — Tenant binding and the config cascade

The rule from `00-project-context.md` §Configuration Principles is **request tenant → SYSTEM, two tiers, no third**, and `50000000-…` ("Global") is a customer tenant that must never appear in a cascade. A machine principal makes it easy to violate this by accident, so the binding is specified rather than left to the call site:

- **Tenant-bound service account** (the default and strongly preferred shape): `tenantId` = the customer tenant. The guard sets CLS `tenantId` to that value. Config then resolves tenant-first → SYSTEM exactly as for a human in that tenant. Metering funding derives correctly because `AiProviderConnection` resolution sees the real tenant (`row.tenantId === SYSTEM_TENANT_ID` ⇒ `CLOUD`, else `BYOK`) — a call site that stamps funding rather than deriving it mis-bills silently.
- **Platform service account** (`tenantId` = SYSTEM, SUPER_ADMIN issuance only): must supply an explicit `X-Tenant-Id` working tenant on every tenant-scoped request, validated against an allow-list stored on the account. With no header, config resolves **SYSTEM only** — never a customer tenant, never `50000000-…`. This mirrors the admin console's working-tenant pattern and the mandatory-`X-Tenant-Id` directive from TASK-737.
- There is **no** ambient-default tenant for a machine principal. A `default_tenant_id`-shaped knob here is the exact smell `00-project-context.md` names.

**Tests (RED first)**
12. Tenant-bound account: CLS `tenantId` equals the account's tenant; a config read resolves the tenant row and only widens to SYSTEM on absence.
13. Tenant-bound account presenting an `X-Tenant-Id` for a different tenant → 404 (not 403 — cross-tenant posture).
14. Platform account with no `X-Tenant-Id` on a tenant-scoped route → 400 with an explicit "tenant context required" error; **assert it does not resolve `50000000-…`**.
15. Platform account with an `X-Tenant-Id` outside its allow-list → 403.
16. Metering funding derived from the resolved connection row, not stamped by the caller — tenant-bound + tenant-owned connection ⇒ `BYOK`; tenant-bound + SYSTEM fallback ⇒ `CLOUD`.

### 5.4 Step 4 — Credential storage, token exchange, rotation, revocation

**Storage.** Per `09-infrastructure-devops.md` §Configuration Tiers: the client secret is a **`vault-kv`/`db-secret`-tier value and never a plaintext DB column**. `ServiceAccount.credentialsRef` holds the Vault path; `SecretsService` resolves it. This follows the `TenantStorageConfig.credentialsRef` precedent exactly. Register a `SettingDescriptor` for the Vault key family so `scripts/vault-seed-secrets.sh` derives it rather than hand-maintaining a list.

Note for the reviewer: the API key path stores an **HMAC-SHA256 hash** peppered from `API_KEY_PEPPER` (`apikey.service.ts:160-165,174-177`), not the secret. That is acceptable for a *verifier*, but a service-account secret must also survive rotation windows and be operator-retrievable for provisioning, so Vault-held (not merely hashed) is the right tier here.

**Exchange.** `POST /api/v1/auth/service-token` — `@Public()`, its own guard, rate-limited, constant-time comparison. Accepts `clientId` + secret, returns an **opaque, short-lived** bearer token (default TTL 15 min, per-account overridable within a platform ceiling) recorded in Redis keyed by token hash. Opaque and server-validated deliberately: no JWT claim set to get wrong, and revocation is a Redis delete rather than a blocklist. Never accept the secret on any route other than this one; never put a token in a URL.

**Rotation.** Two-slot rotation with an overlap window (`credentialsRef` + `previousCredentialsRef` + `previousCredentialExpiresAt`), so a consumer rotates without downtime. Rotation publishes on the existing `arca:secrets:invalidate` channel — invalidation is the propagation path, TTL is only the backstop.

**Revocation.** `softDelete` on the account plus an immediate purge of that account's live tokens from Redis. Revocation must be effective within one request, not one TTL.

**Tests (RED first)**
17. The secret is never persisted to any Prisma column — assert the created row's fields contain no substring of the issued secret.
18. Valid exchange returns a token; the same secret exchanged twice returns two distinct tokens (no token reuse coupling).
19. An expired token → 401; a token for a soft-deleted account → 401 **immediately**, without waiting for TTL.
20. During a rotation overlap both secrets exchange successfully; after `previousCredentialExpiresAt`, only the new one does.
21. Wrong secret → 401 with no distinguishing message between "unknown client" and "bad secret" (non-enumerable).
22. Exchange endpoint is rate-limited and the failure path uses `timingSafeEqual`.

### 5.5 Step 5 — Guard branch and principal shape

Extend `UnifiedAuthGuard` with a third branch, ordered **after** `@Public()` and **before** the API-key branch, keyed on the service-token header. It must:

- refuse on `@ForbidApiKey()` routes? **No** — `@ForbidApiKey()` is about *tenant API keys*. A service account is a distinct class and must have its own decorator, `@ForbidServiceAccount()`, so a route can exclude machines (e.g. `AuthController`, `ConsentGrantController`, `AdminImpersonationController`, and the service-account controller itself) independently. Reusing `@ForbidApiKey()` for both re-creates exactly the "one mechanism, two purposes" conflation the owner ruled against.
- enforce `svc:*` scopes (a conjunction with abilities, never a fallback — mirror `enforceApiKeyScopes` → `enforceApiKeyAbilities` ordering at `unified-auth.guard.ts:336,350`).
- build a CASL ability for the **service account itself**, not for a bound human. This is the point of the whole design: a machine's authority must be independently grantable and revocable.
- populate the CLS principal with an explicit `roles` array. §2.7 shows `isSuperAdmin` reads `user.roles` and the API-key path leaves it undefined; a service-account principal that omits it will silently fail every imperative super-admin check, and one that includes `SUPER_ADMIN` carelessly silently becomes one.

**Tests (RED first)**
23. Route with `@ForbidServiceAccount()` → 403 for a service-account token even holding `svc:*`, and unaffected for a JWT.
24. `@ForbidApiKey()` alone does **not** block a service-account token (the two decorators are independent) — and a route intended to block both declares both.
25. Missing `svc:*` scope → 403 even when the account's ability would allow the action.
26. Holding the scope but lacking the ability → 403 (conjunction, both directions).
27. `isSuperAdmin` returns the account's actual configured value — an explicit pair of tests, one for a platform account granted it and one for a tenant-bound account denied it.
28. Precedence: a request carrying both a service token and an `X-API-Key` is rejected outright, not silently resolved to one of them.

### 5.6 Step 6 — Audit attribution

§2.8 is a real gap: `AuditLog` can only name a user. Add nullable `responsibleServiceAccountId String?` (+ index) to `AuditLog`, thread it through `SysEventPayload` → `SysEventService` (`sysEvent.service.ts:138`) → `BaseService.broadcastSysEvent` (`base.service.ts:91`), and populate it from CLS on the service-account path. `responsibleUserId` stays **null** on that path — attributing a machine action to a human is worse than leaving it blank, because it is wrong in a way a reviewer cannot detect.

**Tests (RED first)**
29. An admin mutation by a service account writes `responsibleServiceAccountId` set and `responsibleUserId` null.
30. The same mutation by a human writes the inverse — no regression to existing attribution.
31. The audit row survives the envelope-encryption path unchanged (the existing `AuditLog` DEK path is untouched by a new scalar column).
32. `broadcastSysEvent` with neither actor id logs the existing "missing responsibleEntityId" warning (`sysEvent.service.ts:120-122`) — a machine path must not silently bypass that guard.

### 5.7 Step 7 — Boot audits (what TASK-761 must assert)

TASK-761 owns the admin-plane audit; these assertions extend it and must fail **boot**, not a lint pass. Existing precedent and wiring: `apps/api/src/bootstrap/api-key-scope-audit.ts` (recognised guard list at `:147-149`) and `admin-scope-audit.ts`, both invoked from `apps/api/src/main.ts:291-325`.

| # | Assertion | Why |
|---|---|---|
| A | No `admin/`-prefixed controller declares `@RequiredScopes` | Tenant-key vocabulary must not regrow on the admin plane (review §3.1 step 2). |
| B | **No `admin/`-prefixed controller uses any recognised service-token guard** | Today this passes vacuously (§2.1). Pin it so the "just add the service token to admin" shortcut becomes a boot failure rather than a code-review argument. This is the owner's non-mixing ruling made mechanical. |
| C | No `internal/`-prefixed controller declares a `svc:*` scope | The mirror of B — the new class must not leak onto the peer-service plane either. |
| D | Every `svc:*` scope in the registry maps to at least one live admin controller area, and every admin controller area is covered by exactly one `svc:*` scope | Prevents both orphan scopes and ungated admin surfaces. Same shape as `ADMIN_SCOPED_CONTROLLERS`. |
| E | `admin/service-accounts` carries both `@ForbidApiKey()` and `@ForbidServiceAccount()` | No self-replication; no key-path escalation into machine issuance. |
| F | The token-exchange route is `@Public()` and carries its own guard | Same invariant the internal audit already enforces for `/internal/*`. |
| G | Every route reachable by a service-account token declares either a `svc:*` scope or `@ForbidServiceAccount()` | The deny-by-default posture, extended to the third class. Mirrors `auditEveryApiKeyReachableRouteDeclaresScopes` (`main.ts:318`). |

**Tests (RED first)**
33–39. One unit test per assertion A–G, each proving the audit **throws** on a synthetic violating module and passes on the real container.

---

## 6. Verification Criteria

- [x] Owner has recorded a decision among options 1 / 2 / 3. **Resolved 2026-08-18: Option 2 (platform-issued service account), build now — not deferred to a first named consumer.**
- [ ] If option 1: the unsupported position is documented in the SDK README and the OpenAPI description for `/admin/*`, and this ticket moves to a dated "revisit when" trigger rather than being closed.
- [ ] If option 2: every test 1–39 above written RED first, then green.
- [ ] `pnpm --filter @arcaai/database test`, `--filter @arcaai/domains build test`, `--filter @arcaai/applications build test`, `pnpm api:build`, `pnpm test:unit` all green with output pasted.
- [ ] `pnpm test:e2e` green, including new cross-tenant coverage for `admin/service-accounts` (`05-nestjs-api.md` DoD requires cross-tenant e2e for every new admin resource).
- [ ] Real boot proven — `node dist/main.js` reaches "Application started" with all seven new audits wired, not merely unit-tested.
- [ ] `pnpm lint` shows no new errors (and no new only-warn warnings in `packages/*`).
- [ ] gitleaks clean; no secret value in any migration, seed, or fixture.
- [ ] Migration folder named `<timestamp>_task_762_<desc>`, authored against a shadow DB per `02-database-prisma.md`, with a proven-empty follow-up diff.
- [ ] TASK-708's README gains an appended Change History entry pointing here — review §3.1 is explicit that TASK-708/742's record must be **appended to, not silently overwritten**.

---

## 7. Implementation Summary

**Pending.** No code has been written and none may be until the owner decision in §6 is recorded. This ticket currently delivers the decision framing, the verified current-state evidence in §2, and the §5 design.

---

## 8. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-18 | **Created.** Documented the machine-identity gap that policy A2 / TASK-757 opens: verified against the working tree that no `admin/`-prefixed controller uses any service-token guard (all three guards appear only on `internal/*` controllers), that the sole reserved internal scope is `internal:stt:worker`, and that no OAuth2 client-credentials issuer or machine JWT exists — so after TASK-757 there is zero machine path to administration. Laid out three options against the TASK-708 §6 non-mixing ruling (which forbids both extending `X-Service-Token` to admin and re-admitting tenant API keys), recommended Option 2 (platform-issued service account) built on first named consumer with Option 1 as the standing position until then, and specified issuance gating, tenant→SYSTEM cascade binding, Vault-tier credential storage, rotation/revocation, audit attribution, and the seven boot-audit assertions TASK-761 must carry. Status **Blocked — requires owner decision**. Recorded two tree/document contradictions found during verification (see §2.7). | Documentation agent |
| 2026-08-18 | **Owner decision recorded — UNBLOCKED.** Option 2 (platform-issued service account, `svc:*` namespace, SUPER_ADMIN-only issuance, Vault-tier storage) is selected and is to be **built now**, not held until a first named consumer as §Recommendation proposed. Status Blocked → Pending. Two consequences follow and are in scope: (1) **audit attribution is a schema prerequisite** — `AuditLog` carries only `responsibleUserId`/`responsibleIp` (`audit.prisma:11-12`), so a machine actor cannot currently be recorded and a migration must land before the credential is usable for attributable admin actions; (2) TASK-757 no longer needs to ship into a zero-machine-path world — sequence 762's credential ahead of, or alongside, 757's cutover. | Owner decision |
