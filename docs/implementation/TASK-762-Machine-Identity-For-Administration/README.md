# TASK-762 — Machine Identity for Administration

| | |
|---|---|
| **Status** | **Review** — Option 2 built (2026-08-18). All layers land: audit attribution, `ServiceAccount` model + domain trio, `svc:*` namespace, SUPER_ADMIN-only issuance, token exchange/rotation/revocation, the third `UnifiedAuthGuard` branch, and six boot audits. Two deviations from §5 are recorded in §7 and need an owner call. |
| **Type** | Decision + design + implementation |
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

Option 2 is **built**. 45 files changed. Every layer of the dependency chain
(`Database → Domain → Services → API`) landed in order, TDD, with the RED
observed before each GREEN.

### 7.1 Step 0 (prerequisite) — audit attribution

`AuditLog` could name only a person, so a machine's admin action was recorded
against the human its credential was bound to (§2.8). Fixed FIRST, because the
credential is not usable for attributable admin actions until it is.

| Change | Location |
|---|---|
| `responsibleServiceAccountId String?` + index | `packages/database/src/prisma/db_main/audit.prisma:22,83` |
| Entity field + **mutual-exclusion** invariant (a row naming both actors is unattributable and is refused) | `packages/domains/src/entities/generated/core/AuditLogEntity.ts` |
| Factory: machine path leaves `responsibleUserId` **null** instead of the `''` placeholder every human row uses | `packages/domains/src/factories/generated/core/AuditLogFactory.ts` |
| `SysEvent.responsibleServiceAccountId` | `packages/domains/src/common/events/arcaai.event.ts:18,47,67` |
| `AuditLogJob.responsibleServiceAccountId` | `packages/domains/src/interfaces/jobTypes.ts:36` |
| `BaseService.broadcastSysEvent` stamps **exactly one** actor; new `requestServiceAccount` getter | `packages/applications/src/common/base.service.ts` |
| `SysEventService` passes it through; a machine actor now counts as a present actor for the "missing author" warning | `packages/applications/src/services/sysEvent/sysEvent.service.ts:124,143` |
| `AuditLogProcessor` threads it to the factory | `packages/applications/src/services/auditLog/auditLog.processor.ts:27,58` |

### 7.2 Steps 1–7

| Step | What landed |
|---|---|
| **1 — model + trio** | `service-account.prisma` (new); hand-authored `ServiceAccountEntity` / `Factory` / `EntityMapper` (carries the `FIELDS_NOT_WRITABLE=['version']` OCC strip) / `Repository`; `ResourceType.ServiceAccount` in both `audit.prisma` and the domain enum; repository registered in `CoreDatabaseModule`; mapper + repository barrel lines added by hand. `gen:model`/`gen:entity`/`gen:factory` run; `gen:mapper`/`gen:repository` NOT run. |
| **2 — issuance** | `ServiceAccountController` at `admin/service-accounts`, class-level `@CanManage('ServiceAccount')` **plus** an imperative SUPER_ADMIN check in the service, marked `AUTH-NOTE`. Also carries **both** `@ForbidApiKey()` and `@ForbidServiceAccount()`. |
| **3 — tenant binding** | Two shapes only: tenant-bound (`tenantId` = customer) and platform (`tenantId` = SYSTEM + an `allowedTenantIds` working-tenant allow-list). No ambient default; a platform account with no `X-Tenant-Id` resolves **SYSTEM only**, and `50000000-…` is refused explicitly at both issuance and working-tenant resolution. |
| **4 — credential lifecycle** | 64-hex CSPRNG secret returned **exactly once**; peppered HMAC verifier persisted; two-slot rotation with a bounded overlap; revocation = soft-delete **plus** an immediate Redis token purge. Opaque, server-validated tokens (never a JWT) keyed in Redis by token hash. |
| **5 — guard branch** | Third `UnifiedAuthGuard` branch on `X-Service-Account-Token`, ordered after `@Public()` and before the API-key branch. New `@RequiredSvcScopes()` / `@ForbidServiceAccount()` decorators with their OWN metadata keys. Ability built for the **account itself** via new `PolicyEngine.buildAbilityFromRules`. Principal published on its own CLS key (`serviceAccount`), never on `user`, with an explicit `roles` array. |
| **6 — audit attribution** | §7.1 above. |
| **7 — boot audits** | `apps/api/src/bootstrap/service-account-surface-audit.ts`, wired at `main.ts:342`. Implements B, C, D, E, F, G. |

### 7.3 Three deliberate deviations from §5 — each needs an owner acknowledgement

**D1 — §5.1's "Add to `TENANT_SCOPED_MODELS`" is wrong and was NOT followed.**
`ServiceAccount` is registered as `INTENTIONALLY_UNSCOPED` instead, exactly as
`ApiKey` is. The token exchange reads the row by `clientId` **pre-auth**, where
CLS is active but empty (`tenantId === undefined` AND `isSuperAdmin() === false`)
— the precise combination the tenant-scope read handler throws on. Following §5.1
would have reproduced the documented `ApiKey` failure in which *every credential
on the platform authenticated as 401*. Isolation is enforced one layer up
instead: list reads scope to the caller's tenant, and every by-id load runs
`assertTenantOwnership` (404-over-403). Recorded with reasoning at
`packages/database/src/extensions/__tests__/tenant-scope.test.ts` and in the
repository's class doc.

**D2 — §5.4's Vault WRITE of the client secret is not implemented, because
there is no write path to implement it with.** `ISecretsProvider`
(`packages/applications/src/services/baseServices/_meta/secrets/ISecretsProvider.ts`)
exposes `getSecret*` and a backend-triggered `rotateSecret(key)` and **nothing
that writes caller-supplied material**, across all five providers. Adding one
changes the platform secrets contract, requires new Vault ACL policy for the
app's AppRole, and touches the out-of-repo deployment manifests — an owner
decision, not a side effect of this ticket.

What shipped instead is *stronger* on the rule §Configuration Tiers actually
states ("never put a credential in a DB column in plaintext") and weaker on one
convenience property:

- the secret is returned once and then **discarded by the platform** — never
  persisted in any recoverable form, anywhere;
- the row holds a peppered one-way HMAC verifier (the `ApiKey.keyHash` shape);
- `credentialsRef` records the Vault path where an operator provisions it, so
  "where does this live" is still answered on the row;
- "survives rotation windows" is met by the two-slot verifier design, not by
  re-reading stored material.

The property NOT met is operator **re-retrieval of a lost secret**; the remedy
is `POST :id/rotate`. If the owner wants true Vault-held secrets, that is a
follow-up ticket adding `writeSecret` to `ISecretsProvider` + Vault ACL.

**D3 — boot-audit assertion A is deliberately NOT implemented here.** A says no
`admin/`-prefixed controller declares `@RequiredScopes`. 67 admin controllers
legitimately still carry their `admin:*` scopes today, so asserting A now would
refuse the boot. A belongs with TASK-757's cutover, once `@ForbidApiKey()` has
actually been applied across the admin plane. Assertion G is likewise
implemented in its *consistency* form (a route may not both declare a `svc:*`
scope and forbid machines, and may not name an unregistered scope) rather than
its every-route form, for the same reason: no route declares `@RequiredSvcScopes`
yet, and the runtime already denies them all.

### 7.4 Design choices worth naming

- **`svc:*` is a separate registry, DERIVED from the admin vocabulary.** Every
  concrete `admin:<area>` scope is renamespaced to `svc:admin:<area>` at module
  load, carrying its `implies` verbatim, so boot-audit D holds by construction
  and adding an admin area extends both surfaces in one edit. The two registries
  are asserted **disjoint in both directions**.
- **A dedicated header, not `Authorization: Bearer`.** Sharing the JWT header
  would make branch selection a parsing heuristic on the auth hot path, and a
  heuristic that guesses wrong is an authentication bypass.
- **Ambiguous credentials are rejected outright.** A request presenting both an
  API key and a machine token is refused before either is validated — picking
  one would be a guess about intent that decides an authorization outcome.
- **`superAdmin` is a persisted column, not an inference.** §2.7's failure mode
  runs in both directions, so elevation is always an explicit, auditable
  decision and `roles` is always present (empty, never undefined).

### 7.5 Evidence

| Gate | Result |
|---|---|
| Migration | `20260818112802_task_762_service_account_machine_identity` authored against a THROWAWAY `hope_shadow` DB per rule 02, applied, follow-up diff printed `-- This is an empty migration.`, shadow dropped. Dev DB synced with plain `pnpm db:push` (additive only; no `--force-reset`, no `db:all`). |
| `pnpm --filter @arcaai/domains build test` | build clean; **1810 passed**, 2 skipped, 9 todo |
| `pnpm --filter @arcaai/applications build test` | build clean; **9315 passed** (was 9268 — +47), 2 pre-existing failures unchanged |
| `pnpm api:build` | 12/12 tasks successful |
| `pnpm test:unit` (workspace) | **18147 passed**, 3 failed — all 3 verified pre-existing on a clean `git stash` tree (`env-sync` key-count 149>148, `dna-writing-style.processor`, `fail-mode.governance`) |
| `pnpm lint` (domains / applications / api) | **13 / 183 / 65 warnings, 0 errors — byte-identical to the pre-change baseline.** Zero new warnings. |
| Real boot | `node --import ./dist/instrumentation.js dist/main.js` reached `Nest application successfully started` + `Application started { port=8868 }` with all six new audits wired. |
| Live route probes | `POST /auth/service-token` bad creds → 401 non-enumerable; secret in query string → 400; `GET /admin/service-accounts` unauthenticated → 401; API key + machine token together → 401 "Present exactly one credential"; unknown machine token → 401. |
| `pnpm test:e2e` | **NOT RUN** — see §7.6. |

### 7.6 What is NOT done

- **`pnpm test:e2e` was not executed — deliberately, to avoid harming a
  concurrent session.** The spec is written and COMPILES
  (`apps/api/tests/e2e/task-762-service-account-cross-tenant.spec.ts`;
  `playwright test --list task-762` resolves all 11 tests, zero compile errors).
  It covers the 403 privilege boundary, the 404-over-403 tenancy posture,
  secret-returned-once, no-self-replication, non-enumerable exchange, credentials
  refused in the query string, and immediate revocation.

  Two blockers, both requiring a human:

  1. **The isolated test DB lacks the new schema.** Verified directly: it is
     seeded (32 `User` rows) but `to_regclass('core."ServiceAccount"')` is NULL,
     so every test would fail on a missing table.
  2. **A test API is ALREADY RUNNING on port 8968** (PID observed, `/health`
     200), started by one of the concurrent sessions (TASK-754 / TASK-755) that
     own `apps/api/src/modules/speech/**` and the STT streaming files. It is
     running pre-TASK-762 code, so it cannot serve these routes — but restarting
     it would tear down that session's server. TASK-708's own close-out entry
     records the damage a blanket `pkill` did last time this was not respected,
     so this session stopped here rather than repeat it.

  **A human must run**, once the concurrent sessions are finished with port 8968:
  ```
  pnpm --filter @arcaai/database db:push   # additive: adds ServiceAccount + the
                                           # AuditLog column to the TEST DB;
                                           # NODE_ENV=test, no --force-reset
  pnpm test:up:api                          # terminal 1 (RESET_DB=false is enough —
                                            # the test DB is already seeded)
  pnpm test:e2e task-762                    # terminal 2
  ```
  The equivalent probes WERE run live against the dev API on 8868 (§7.5 "Live
  route probes"), so the three guard branches, the non-enumerable 401, the
  query-string refusal and the two-credential rejection are confirmed working —
  what is unverified is the seeded-user, cross-tenant half.
- Tests 29–32 of §5.6 (audit rows written end-to-end through the BullMQ
  processor) are covered at the unit level for the factory/entity/`BaseService`
  hops but not as an integration test through a live queue.
- No admin controller yet declares `@RequiredSvcScopes(...)`, so no admin route
  is machine-reachable in practice. That wiring is TASK-757's cutover; the
  credential class, its guard branch and its audits are ready for it.
- No `SettingDescriptor` for a Vault key family was registered (§5.4) — moot
  under D2, since nothing is written to Vault.

---

## 8. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-18 | **Created.** Documented the machine-identity gap that policy A2 / TASK-757 opens: verified against the working tree that no `admin/`-prefixed controller uses any service-token guard (all three guards appear only on `internal/*` controllers), that the sole reserved internal scope is `internal:stt:worker`, and that no OAuth2 client-credentials issuer or machine JWT exists — so after TASK-757 there is zero machine path to administration. Laid out three options against the TASK-708 §6 non-mixing ruling (which forbids both extending `X-Service-Token` to admin and re-admitting tenant API keys), recommended Option 2 (platform-issued service account) built on first named consumer with Option 1 as the standing position until then, and specified issuance gating, tenant→SYSTEM cascade binding, Vault-tier credential storage, rotation/revocation, audit attribution, and the seven boot-audit assertions TASK-761 must carry. Status **Blocked — requires owner decision**. Recorded two tree/document contradictions found during verification (see §2.7). | Documentation agent |
| 2026-08-18 | **Implemented (Option 2).** All seven §5 steps built TDD across 45 files, RED observed before each GREEN. Landed the §5.6 audit-attribution prerequisite FIRST (`AuditLog.responsibleServiceAccountId` + a mutual-exclusion invariant, threaded through `SysEvent` → `SysEventService` → `AuditLogJob` → `AuditLogProcessor`, with `BaseService` stamping exactly one actor), then the `ServiceAccount` model + hand-authored domain trio, the `svc:*` scope namespace (a SEPARATE registry, derived from the `admin:*` vocabulary and asserted disjoint from it), SUPER_ADMIN-only issuance with a day-one privilege ceiling, opaque short-lived token exchange with two-slot rotation and immediate revocation, the third `UnifiedAuthGuard` branch with its own header/decorators/CASL principal, and six boot audits making the TASK-708 §6 non-mixing ruling mechanical. Evidence in §7.5: domains + applications + api build clean, 18147 unit tests pass (3 failures verified pre-existing), lint byte-identical to baseline, and a real boot reached "Application started" with live route probes confirming all three credential branches. THREE deviations from §5 need an owner call — §7.3: (D1) §5.1's `TENANT_SCOPED_MODELS` instruction was NOT followed because the token exchange is a pre-auth read and following it would have reproduced the documented `ApiKey` "every credential 401s" failure; (D2) §5.4's Vault WRITE is unimplementable — `ISecretsProvider` has no write path in any of its five providers — so the secret is shown once and never persisted recoverably, which is stronger on the no-plaintext-column rule but gives up operator re-retrieval; (D3) boot-audit A is deferred to TASK-757, since 67 admin controllers legitimately still carry `admin:*` scopes and asserting A now would refuse the boot. `pnpm test:e2e` was NOT run: the spec compiles (11 tests resolve) but the isolated test DB lacks the new table AND a concurrent session's test API is live on port 8968 — restarting it would tear down their server, which TASK-708's close-out entry records as real prior harm. Status Pending → **Review**. | Implementation agent |
| 2026-08-18 | **Owner decision recorded — UNBLOCKED.** Option 2 (platform-issued service account, `svc:*` namespace, SUPER_ADMIN-only issuance, Vault-tier storage) is selected and is to be **built now**, not held until a first named consumer as §Recommendation proposed. Status Blocked → Pending. Two consequences follow and are in scope: (1) **audit attribution is a schema prerequisite** — `AuditLog` carries only `responsibleUserId`/`responsibleIp` (`audit.prisma:11-12`), so a machine actor cannot currently be recorded and a migration must land before the credential is usable for attributable admin actions; (2) TASK-757 no longer needs to ship into a zero-machine-path world — sequence 762's credential ahead of, or alongside, 757's cutover. | Owner decision |
