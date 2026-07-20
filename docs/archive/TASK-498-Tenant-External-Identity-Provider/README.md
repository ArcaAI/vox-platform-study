# TASK-498 — Tenant-Scoped External Identity Provider (OIDC) — Config, User Sync & Federated Auth

| | |
|---|---|
| **Status** | `Review` — §1 Decisions (D1–D7) approved 2026-07-12; P0–P4 complete (flags, DB schema, OIDC end-to-end, directory pull, admin-console UI). P4 built against code-level best practices per explicit user direction, skipping the Figma design gate (see §9 Change History). |
| **Type** | `feature` — full-stack (DB → domain → application → API gateway → admin-console BFF/UI) |
| **Created** | 2026-07-12 |
| **Scope** | **OIDC only.** SAML 2.0 is split into [TASK-499](../TASK-499-Tenant-External-IdP-SAML/README.md) to de-risk OIDC; this ticket lays the tenant-scoped identity foundation SAML builds on. |
| **Parent / Related** | [TASK-496 Tenant-TTS-Config](../TASK-496-Tenant-TTS-Config/README.md) (per-tenant config + BYO encrypted creds pattern) · [TASK-499 SAML](../TASK-499-Tenant-External-IdP-SAML/README.md) (sibling, depends on this) · [TASK-401 User-Impersonation](../../archive/TASK-401-User-Impersonation/README.md) · [BUG-005 Impersonation Effective Identity](../BUG-005-Impersonation-Effective-Identity-And-Scope/README.md) |
| **Branch (suggested)** | `feature/498-tenant-external-idp-oidc` |
| **Reported** | 2026-07-12 by the user |

---

## 1. Requirement Analysis

A **tenant admin** must be able to configure an **external identity provider (IdP)** so that:

1. **User sync** — the tenant admin syncs user data from the external IdP into HOPE (bulk directory pull + just-in-time on login).
2. **Identity verification** — HOPE verifies a user's identity against that tenant's external IdP at login, then mints HOPE's own session (JWT) for the verified, tenant-scoped user.

This is greenfield: HOPE has a **single, global, unreachable OIDC stub**, and the `User` table links to exactly **one** external subject platform-wide (`externalId @unique`) — insufficient for per-tenant, per-provider federation. This ticket builds a **per-tenant OIDC** identity-federation layer and the authn/authz flow around it, and delivers the **detailed flow document** in §3. **SAML is out of scope here** and delivered by TASK-499 on the same foundation.

### Decisions (owner: product owner, confirmed 2026-07-12)

- **D1 — Protocol scope: OIDC only (this ticket).** Reuse and make per-tenant the existing `openid-client` plumbing. SAML 2.0 is deferred to [TASK-499](../TASK-499-Tenant-External-IdP-SAML/README.md) so OIDC can ship independently. The data model + service seams built here are **protocol-neutral** (SAML slots in without a redesign): the `IdpProtocol` enum ships with both `OIDC` and `SAML` values now, but v1 accepts/validates only `OIDC`.
- **D2 — Identity model: per-tenant provider + per-provider federated identity.** New `TenantIdentityProvider` (config) and `FederatedIdentity` (link `userId ↔ (providerId, subject)`) tables. Legacy `User.externalId` is **retained but deprecated** (back-compat for the old global stub); new links go through `FederatedIdentity`, unique on `(providerId, subject)`, allowing one HOPE user to federate with multiple providers.
- **D3 — User provisioning: JIT + admin-triggered directory pull.** (a) **JIT** — on first successful IdP login, create/link the HOPE user, assign a **configurable default role + default department**, and (optionally) map IdP group claims → HOPE roles. (b) **Directory pull** — tenant admin triggers a bulk sync from the provider's directory API (Microsoft Graph / Google Directory) to pre-provision users/groups. No SCIM inbound in v1.
- **D4 — Config storage: dedicated encrypted table**, mirroring TASK-496's BYO-credentials pattern: non-secret config in columns; the OIDC client secret + directory-API credentials sealed with **Vault Transit** (`encryptedSecretRef` / `directoryCredentialsRef`). Per-tenant resolution does **NOT** use `AppSettingsService` (its cache is key-only and platform-tenant-wins — `appSettings.service.ts:246-251`); resolution is a tenant-scoped repository read + a per-provider client cache.
- **D5 — Home-realm discovery (HRD): email-domain → provider, with explicit tenant fallback.** A `TenantIdentityProviderDomain` allowlist maps verified email domains to a provider so the login UI can route a user to the right IdP from their email. When ambiguous/unmapped, the user selects a tenant/workspace (tenant `key`) explicitly (consistent with today's `tenantKey` login requirement, `auth.controller.ts:211`).
- **D6 — Authorization boundary is unchanged & authoritative.** External IdP verifies *identity only*; HOPE's CASL RBAC (`policy.engine.ts`) remains the sole authorization authority. Group/role claims map to HOPE roles via `Role.externalName`/`Role.externalId` (already on `rbac.prisma:29-31`) but never grant `GLOBAL_ADMIN` and never cross the tenant boundary. JIT users are tenant-scoped to the configuring tenant.
- **D7 — Break-glass local login stays.** Configuring an IdP does not disable local password login for that tenant's admins by default (avoids IdP-misconfig lockout). A tenant-level toggle `enforceSsoOnly` (default OFF) can later require SSO for non-admins.

**Guardrail principle:** the IdP is an **identity oracle**, not an authorization source. A federated login yields a HOPE JWT whose roles/permissions/tenant come exclusively from HOPE's own RBAC snapshot at login — identical to local login downstream. The entire existing guard/proxy/refresh stack is reused unchanged.

---

## 2. Current State Evaluation

**What exists (reused / extended):**

- **Auth guard pipeline** — `UnifiedAuthGuard` (`packages/applications/src/authorization/unified-auth.guard.ts`), the single global `APP_GUARD`: API-key → SSE-token → JWT paths. **No OIDC branch** — federation happens *before* the guard (login round-trip mints a normal HOPE JWT; the guard then treats the session identically). ✅ reuse unchanged.
- **Local login / JWT** — `apps/api/src/modules/auth/auth.controller.ts` (`POST /auth/login` L133, refresh L695, stream-ticket L778). JWT minted by `createJwt.ts` with `{id, username, email, roles[], permissions[], tenantId, jti, refreshFamily}`; validated by `jwt.strategy.ts` (forces CLS `tenantId` from the claim, L83). ✅ the federation callback reuses `createJwt` + `RefreshTokenService.issue`.
- **OIDC stub (global, unreachable)** — `auth.service.module.ts:35-81` builds ONE app-wide `openid-client` via `Issuer.discover(OIDC_DISCOVERY_URL)`; `oidc.strategy.ts` `validate()` → `authService.getOrCreateOidcUser({externalId: sub})` (`auth.service.ts:29-54`); `OidcAuthGuard` (`apps/api/src/guards/oidcauth.guard.ts`). **No controller mounts it and there is no `/auth/callback` route** → dead code. Doc `OIDC-CONFIGURATION.md`. ⚠️ refactor to per-tenant.
- **User ↔ external subject** — `User.externalId String? @unique` (`user.prisma:72`) — single global subject. `createExternalUser` (`user.service.ts:234-255`) sets `username=externalId`, empty password, and **no role/tenant/department** → a JIT user today cannot pass the login membership invariant. ⚠️ core gap D3 fixes.
- **RBAC / CASL** — `policy.engine.ts` `buildAbility` (Redis-cached), tenant-scoped `UserRoleAssignment` (`user.prisma:8-51`); `Role.externalName`/`externalId` for external-system linkage (`rbac.prisma:29-31`). ✅ reuse for group→role mapping (D6).
- **Per-tenant config precedent** — `tenant-tts-config` (TASK-496): dedicated table + SYSTEM default + resolver + **Vault-Transit BYO encrypted creds** + `admin/*` controller. ✅ the exact pattern for `TenantIdentityProvider`.
- **admin-console BFF** — `server/session.ts` (jose JWE cookie), `hope-proxy.ts`, `refresh.ts`, `proxy.ts`. ✅ add `/api/auth/sso/{start,callback}`; downstream proxy/refresh reused unchanged since they only care about the sealed `{accessToken, refreshToken}`.

**What must be built (this ticket):**

| Need | Fix (phase) |
|---|---|
| `TenantIdentityProvider` + `FederatedIdentity` + `TenantIdentityProviderDomain` tables + domain trio | P1 |
| Per-tenant OIDC client resolver + cache (replace global `AppSettingsService` path) | P2 |
| OIDC login round-trip: HRD → start → callback → JIT provisioning → mint HOPE JWT | P2 |
| JIT provisioning with default role + default department + group→role mapping | P2 |
| Directory pull (Microsoft Graph / Google) bulk user/group sync (admin-triggered) | P3 |
| Tenant-admin config surface (`admin/tenant-idp-config`) + admin-console screens | P4 |
| BFF SSO start/callback handlers | P4 |

_SAML SP (metadata, ACS, assertion validation, SAML config columns, SAML admin tab, BFF ACS route) → TASK-499._

---

## 3. Auth & Authz Flow Document — External Identity Provider (OIDC)

This is the requested detailed flow. Three flows: **(A) tenant admin configures the IdP**, **(B) tenant admin syncs users**, **(C) a user is verified against the IdP at login**. Terminology: **SP** = HOPE (service provider), **IdP** = the tenant's external provider (Entra/Okta/Google/Keycloak/…). The trust model and flows are written protocol-neutral where possible so TASK-499 (SAML) extends rather than rewrites them.

### 3.0 Trust model

The IdP asserts *who the user is*. HOPE trusts that assertion only for the tenant that configured the IdP, verifies it cryptographically (OIDC: `id_token` signature via JWKS + `nonce` + PKCE + `iss`/`aud`/`exp`), then **mints its own HOPE session** whose authorization (roles, permissions, tenant) comes 100% from HOPE RBAC. The IdP never sees HOPE's JWT and never authorizes anything.

### 3.A Flow A — Tenant admin configures the external IdP

```
Tenant admin (browser)        admin-console BFF            API gateway                    Vault
   |  fill OIDC config form       |                            |                             |
   |----------------------------->|  POST /api/hope/admin/tenant-idp-config                  |
   |                              |--------------------------->|  @CanManage('TenantIdentityProvider')
   |                              |                            |  validate discovery          |
   |                              |                            |  (fetch .well-known/openid-configuration)
   |                              |                            |  seal client secret          |
   |                              |                            |--------------------------->| Transit encrypt
   |                              |                            |<---------------------------| ciphertext
   |                              |                            |  persist TenantIdentityProvider (status=DRAFT)
   |                              |<---------------------------|  201 + SP callback URL (redirect_uri)
   |<-----------------------------|  show redirect_uri to register in the IdP                |
   |  click "Test connection"     |                            |                             |
   |----------------------------->|  POST .../tenant-idp-config/:id/test                     |
   |                              |--------------------------->|  real discovery + a canned auth probe
   |                              |<---------------------------|  ok → status=ENABLED         |
```

- OIDC config captured: `issuer`/`discoveryUrl`, `clientId`, `clientSecret` (sealed), `scopes` (default `openid profile email`), `claimMappings` (email/username/name/groups), `groupToRoleMap`, `defaultRoleId`, `defaultDepartmentId`, `jitEnabled`, `enforceSsoOnly`.
- `status`: `DRAFT` → `ENABLED` only after a successful **Test connection** (D7 — prevents self-lockout from a bad config).
- Config is **tenant-scoped**: the controller pins `tenantId` from CLS; no cross-tenant read.

### 3.B Flow B — Tenant admin syncs users (directory pull + JIT)

**B1 — Directory pull (admin-triggered bulk sync).**

```
Tenant admin                 API gateway                         Provider Directory API
   |  POST .../tenant-idp-config/:id/sync                        (MS Graph / Google Directory)
   |------------------------->|  @CanManage('TenantIdentityProvider')
   |                          |  decrypt directory creds (Vault) |
   |                          |--------------------------------->|  GET /users, /groups (paged)
   |                          |<---------------------------------|  users + group memberships
   |                          |  for each user (idempotent upsert):
   |                          |    - match by email / FederatedIdentity(subject)
   |                          |    - create/link HOPE user (createExternalUser + FederatedIdentity)
   |                          |    - assign default role + default department (tenant-scoped)
   |                          |    - map groups → HOPE roles (groupToRoleMap; never GLOBAL_ADMIN)
   |                          |    - respect seat quota (entitlements) — surplus staged/skipped
   |<-------------------------|  202 + sync job id; progress via sys-events / job status
```

- Background job (BullMQ, like sys-event fan-out) for large directories; returns a job id + progress. Idempotent upserts keyed on `(providerId, subject)` — re-sync is safe.
- **Authorization stays HOPE-owned:** the sync writes `UserRoleAssignment` rows using the tenant admin's authority; cannot grant roles above the admin's tier, cannot touch other tenants.

**B2 — JIT provisioning (on first login).** If a verified IdP user has no HOPE account/link yet, Flow C creates+links them inline using the same default-role/default-department/group-map rules. Directory pull is optional pre-provisioning; JIT guarantees a user lands even without a prior pull.

### 3.C Flow C — Identity verification at login (OIDC Authorization Code + PKCE)

```
User (browser)      admin-console BFF          API gateway (SP)             Tenant IdP
  | enter email / pick workspace                |                             |
  |------------------->| POST /api/auth/sso/start {email|tenantKey}           |
  |                    |----------------------->| HRD: email domain → provider (D5)
  |                    |                        | resolve per-tenant OIDC client (cache)
  |                    |                        | build authorize URL + state + nonce + PKCE
  |                    |<-----------------------| 302 authorize URL (+ set signed state cookie)
  |<-- 302 to IdP ----------------------------- |                             |
  |------------------------------------------------ authenticate at IdP ----->|
  |<----------------------------------------------- 302 redirect_uri?code&state
  | GET /api/auth/sso/callback?code&state        |                             |
  |------------------->| forward code+state ---->| verify state; exchange code (PKCE) for tokens
  |                    |                        |----------------------------->| token endpoint
  |                    |                        |<-----------------------------| id_token + access_token
  |                    |                        | verify id_token sig (JWKS) + nonce + aud/iss/exp
  |                    |                        | resolve subject (sub) → FederatedIdentity → HOPE user
  |                    |                        | JIT: create/link + default role + dept + group map
  |                    |                        | assert login membership invariant (role+dept in tenant)
  |                    |                        | mint HOPE JWT (createJwt) + refresh (RefreshTokenService)
  |                    |<-----------------------| { token, refreshToken, user }
  |                    | setSession() → sealed httpOnly JWE cookie                    (server/session.ts)
  |<-- 302 to app -----| (browser never sees tokens)                                  |
```

**Downstream is identical to local login:** every subsequent request carries the sealed cookie; `hope-proxy.ts` attaches `Authorization: Bearer` + `X-Tenant-Id`; `UnifiedAuthGuard` + `jwt.strategy` + `policy.engine` authorize exactly as for a password user. Refresh/logout/impersonation unchanged.

### 3.D Authorization mapping (identity → HOPE roles)

1. Federated subject → HOPE `User` (via `FederatedIdentity(providerId, subject)`; JIT-create if absent).
2. IdP group claims → HOPE roles via the provider's `groupToRoleMap` (matched against `Role.externalName`/`externalId`), constrained to the configuring tenant.
3. No mapping match → the provider's **default role** (config) + **default department** (config, defaults to GEN). Guarantees the login membership invariant holds.
4. `GLOBAL_ADMIN` is **never** assignable via IdP mapping (hard guard, mirrors `assertAssignableRoleTier`).
5. HOPE mints the JWT from the resulting RBAC snapshot — the IdP claims are discarded after mapping.

### 3.E Failure / edge handling

- Bad OIDC discovery → config stays `DRAFT`; login for that provider 400s with a tenant-admin-actionable error.
- Signature/nonce/audience/expiry failure → 401, no session, audit event.
- Unknown subject + JIT disabled → 403 "not provisioned"; with JIT on → provisioned per D3.
- Seat quota exceeded on JIT/sync → user staged `SUSPENDED` (or skipped), surfaced to the admin (entitlements precheck).
- IdP down → local break-glass login still works for admins (D7).
- Replay: one-time `state` + `nonce`.

---

## 4. Design — Data Model & Components

### 4.1 Prisma models (`packages/database/src/prisma/db_main/identity-provider.prisma`, `@@schema("core")`)

- **`TenantIdentityProvider`** — standard field template + : `tenantId`, `protocol IdpProtocol` (`OIDC|SAML`; v1 accepts OIDC only), `displayName`, `status ResourceStatusType`, `providerStatus IdpStatus` (`DRAFT|ENABLED|DISABLED`), plus a `Json config` (non-secret: issuer/clientId/scopes/claim mappings/`groupToRoleMap`/`defaultRoleId`/`defaultDepartmentId`/`jitEnabled`/`enforceSsoOnly`), `encryptedSecretRef` (Vault Transit ciphertext, OIDC client secret), `directoryCredentialsRef?` (Vault, for pull). Unique `[tenantId, protocol, displayName]`; index `tenantId`. **SAML-specific columns are added by TASK-499** — the `Json config` already absorbs SAML fields without a schema break; only the sealed SP private key needs a new column there.
- **`FederatedIdentity`** — `tenantId`, `userId` (FK), `providerId` (FK → TenantIdentityProvider), `subject` (OIDC `sub`; SAML `NameID` reuses this field), `lastLoginAt`. **Unique `[providerId, subject]`**; index `[userId]`, `[tenantId]`.
- **`TenantIdentityProviderDomain`** — `tenantId`, `providerId`, `domain` (verified email domain). Unique `[domain]` (global HRD map); index `providerId`. (DNS-TXT domain verification deferred/optional in v1.)
- Enums in `enums.prisma`: `IdpProtocol { OIDC, SAML }` (both defined now for forward-compat), `IdpStatus { DRAFT, ENABLED, DISABLED }`.
- Allow-lists: add all three to `TENANT_SCOPED_MODELS` (`tenant-scope.ts`); soft-delete applies (not in `MODELS_WITHOUT_SOFT_DELETE`).
- `User.externalId` retained + `@deprecated` comment; new code uses `FederatedIdentity`.

Migration folder: `<timestamp>_task_498_tenant_identity_provider`.

### 4.2 Domain + application layer

- Hand-author the domain trio for the three models (per `db-migrations-env-gotchas`: only model/entity/factory have CI drift gates; mapper/repository generators crash pre-existingly → hand-write). Register repos in `CoreDatabaseModule`.
- **`TenantIdpConfigService`** (`packages/applications/src/services/tenant-idp-config/…`, mirrors `tenant-tts-config`): CRUD, Vault seal/unseal of secrets, `test-connection`, `sync` trigger. Symbol-token DI, DTOs, sys-events, tenant guards, `__tests__`. Protocol-dispatch is a thin switch so TASK-499 adds a `SAML` branch, not a new service.
- **`IdpResolverService`** — tenant-scoped repo read + per-provider client cache (OIDC `Client` from `openid-client`). **Not** `AppSettingsService`. Cache keyed by `providerId`, invalidated on config update. TASK-499 adds a SAML-instance cache alongside.
- **`FederatedAuthService`** — `verifyOidcCallback` → subject → `resolveOrProvisionUser` (JIT: `UserService.createExternalUser` + `FederatedIdentity` + default role + default department + group→role map) → returns a `UserSession` for `createJwt`. Extends `AuthService.getOrCreateOidcUser` (which currently sets no membership — the key fix). `resolveOrProvisionUser` is protocol-neutral so SAML reuses it verbatim.
- **`DirectorySyncService`** — MS Graph / Google Directory clients behind an `IDirectoryProvider` interface; paged upsert as a BullMQ job.

### 4.3 API gateway (`apps/api`)

- **`auth-sso.controller.ts`** (`@Controller('auth/sso')`, mostly `@Public` on the round-trip, throttled):
  - `POST /auth/sso/start` — HRD (email→provider) or explicit `tenantKey`; returns authorize URL + signed state.
  - `GET /auth/sso/callback` (a.k.a. `/oidc/callback`) — code exchange, verify, provision, mint JWT.
- **`tenant-idp-config.controller.ts`** (`@Controller('admin/tenant-idp-config')`, class `@CanManage('TenantIdentityProvider')`): CRUD + `:id/test` + `:id/sync`. Versioned PATCH carries `If-Match`/`@RequiresIfMatch` per house OCC pattern.
- New CASL subject `TenantIdentityProvider` + policies added to `TENANT_ADMIN` (config own tenant) and `GLOBAL_ADMIN` (all).

### 4.4 admin-console (BFF + UI)

- BFF: `app/api/auth/sso/start/route.ts`, `.../sso/callback/route.ts` — proxy to gateway, `setSession` on success (reuse `server/session.ts`). Add an SSO button to `/login`; HRD by email.
- Feature `src/features/identity-providers/`: list/create/edit provider (OIDC form; a `protocol` selector present but SAML disabled/"coming soon" until TASK-499), Test-connection, redirect-URI copy block, group→role mapping editor, default-role/dept pickers, **Sync users** action with job progress. Encrypted secrets write-only (never rendered back). Skeleton loading, Field forms, toasts, both themes, axe 0 violations. Tier 30–49 (tenant-scoped) per `12-design-workflow`; **requires a Figma frame + approval gate before build**.

---

## 5. Implementation Plan (phased, TDD)

**P0 — Deps & flags.** Feature flag `TENANT_IDP_ENABLED` (default OFF) + provider directory-API env to `turbo.json#globalEnv`/`.env.*`. (No SAML dependency here — that's TASK-499 P0.)
*Verify:* `pnpm build:api`.

**P1 — DB + domain.** Schema + migration (all three models, `IdpProtocol` enum with both values); allow-list updates; hand-authored entity/factory/mapper/repository trios; register in `CoreDatabaseModule`.
*Verify:* migration SQL reviewed; `pnpm db:generate`; `pnpm --filter @arcaai/domains build test`; rebuild `@arcaai/database`/`@arcaai/domains` dist.

**P2 — OIDC per-tenant end-to-end.** `TenantIdpConfigService` (OIDC CRUD + Vault seal + test); `IdpResolverService` OIDC cache; `FederatedAuthService.verifyOidcCallback` + JIT provisioning (default role/dept + group map + membership invariant); `auth/sso` OIDC routes. TDD each with a mocked IdP (`openid-client` test issuer / nock).
*Verify:* `pnpm --filter @arcaai/applications test`; `pnpm test:unit`; e2e OIDC round-trip against a mock issuer; cross-tenant assertion (federated user lands only in the configuring tenant).

**P3 — Directory pull.** `IDirectoryProvider` + MS Graph + Google implementations; `DirectorySyncService` BullMQ job; idempotent upsert + seat-quota handling + group mapping; `:id/sync` endpoint + progress.
*Verify:* `pnpm --filter @arcaai/applications test` (paging, idempotency, quota, mapping); job integration test.

**P4 — admin-console.** (Design gate first.) BFF SSO routes + login SSO button + HRD; `identity-providers` feature screens (OIDC); sync UI. Colocated Vitest; axe 0; both themes; `next-dev-loop` runtime pass.
*Verify:* `pnpm --filter @arcaai/admin-console build lint test`; runtime OIDC login exercised in a running app.

**Global verification:** `pnpm lint` clean; affected builds; `pnpm test:unit` + `pnpm test:e2e` (auth/sso + `admin/tenant-idp-config` incl. cross-tenant); OIDC login round-trip + a directory sync exercised end-to-end; security review of token validation (§6).

---

## 6. Security Posture

- **Secrets never leave Vault in plaintext** — OIDC client secret + directory-API creds sealed with Vault Transit (`encryptedSecretRef`/`directoryCredentialsRef`); write-only in the UI. Follows TASK-496 BYO pattern.
- **Token validation is non-negotiable** — verify `id_token` signature via JWKS, `iss`/`aud`/`exp`, one-time `nonce`, PKCE. Reject on any failure; audit.
- **Authorization stays HOPE-owned (D6)** — IdP claims map to HOPE roles only within the configuring tenant; `GLOBAL_ADMIN` never IdP-grantable; tenant boundary (404-over-403) intact for federated users.
- **No lockout (D7)** — providers activate only after a successful test; local break-glass admin login remains unless `enforceSsoOnly` is explicitly set.
- **HRD privacy** — email-domain lookup returns only "which provider to redirect to", never whether a specific email exists (avoid user enumeration).
- **No JWTs in URLs** — SSO uses signed `state` and server-side code exchange; HOPE session stays in the sealed BFF cookie.

---

## 7. Risks / Notes

- **`AppSettingsService` trap** — its cache is key-only and platform-tenant-wins (`appSettings.service.ts:246-251`); per-tenant IdP config MUST resolve via the tenant-scoped repository, not this service. Documented in D4 to prevent a subtle "all tenants share one IdP" bug (the exact failure mode of the old global stub).
- **`createExternalUser` sets no membership** (`user.service.ts:234-255`) — the JIT path MUST add role + department or the user can't log in (`auth.controller.ts:211-229`). Single most likely regression; covered by P2 tests.
- **Retire vs. keep the old global OIDC stub** — decide in P2 whether to delete `auth.service.module.ts`'s global `OPENID_CLIENT` + `oidc.strategy.ts` or keep for back-compat. Recommendation: keep the `getOrCreateOidcUser` seam (extended) but remove the global single-client factory once per-tenant resolution lands, to avoid two competing OIDC paths.
- **Directory-API scopes** — MS Graph / Google Directory read scopes are sensitive; document the exact least-privilege scopes the tenant admin must grant, and store only refresh tokens/app creds (sealed).
- **Keep the foundation protocol-neutral** — TASK-499 (SAML) depends on `TenantIdentityProvider`, `FederatedIdentity`, `FederatedAuthService.resolveOrProvisionUser`, `IdpResolverService`, and the config service's protocol switch. Land those seams cleanly here so SAML is additive.
- **Design gate** — tenant-scoped screens (tier 30–49) need approved Figma frames before P4 build (`12-design-workflow`); non-visual P1–P3 work is not gated on design.

---

## 8. Implementation Summary

### P0 — Deps & flags (done)

- `TENANT_IDP_ENABLED` (master switch, default OFF) + `TENANT_IDP_MS_GRAPH_ENABLED` / `TENANT_IDP_GOOGLE_DIRECTORY_ENABLED` (per-provider directory-sync gates, P3) added to `turbo.json#globalEnv` and documented in `.env.example` (mirrors the `HARNESS_WARM_START_ENABLED` kill-switch style — absent from `.env.dev`/`.env.test`, falls back to OFF).

### P1 — DB + domain (done)

- `packages/database/src/prisma/db_main/identity-provider.prisma` — `TenantIdentityProvider` (config + Vault ciphertext refs, unique `[tenantId, protocol, displayName]`), `FederatedIdentity` (unique `[providerId, subject]`, `userId` is a loose ref — no Prisma relation to `User`, matching the audit-field convention), `TenantIdentityProviderDomain` (unique `domain`, HRD allowlist). `IdpProtocol`/`IdpStatus` enums added to `enums.prisma`.
- Allow-lists: all three added to `TENANT_SCOPED_MODELS` (`packages/database/src/extensions/tenant-scope.ts`); none in `MODELS_WITHOUT_SOFT_DELETE` (soft delete applies); none SYSTEM-shared (no platform-default IdP).
- Migration `20260712160000_task_498_tenant_identity_provider` (reviewed, additive-only) applied directly via `psql` to both the dev (5432) and test (5433) Postgres instances — the local DBs are `db push`-managed and behind migration history, so `prisma migrate dev` would want a destructive reset (see project memory `db-migrations-env-gotchas`).
- Domain trio (entity/factory/mapper/repository) hand-authored per model, mirroring TASK-496's `TenantTtsConfig`/`TenantTtsProviderCredential` pattern (mapper/repository generators are not scaffolders — they only reproduce committed files). Repositories registered in `CoreDatabaseModule`; barrels updated at all four layers.
- TDD: wrote failing factory/entity + repository tests first (RED — `Cannot find module`), then implemented to green.

**Evidence:**

```
$ pnpm --filter @arcaai/tools generate-data-model:check   → no drift — 110 files match
$ pnpm --filter @arcaai/tools generate-data-entity:check  → no drift; schema coverage OK (62/66 models, curated-projection allowlist)
$ pnpm --filter @arcaai/tools generate-factory:check      → no drift; schema coverage OK (62/66 models, curated-projection allowlist)
$ pnpm --filter @arcaai/domains build                     → tsc clean
$ pnpm --filter @arcaai/domains lint                       → 0 errors, 5 pre-existing warnings (unrelated files)
$ pnpm --filter @arcaai/domains exec vitest run             → 111 passed | 2 skipped (113 files), 1335 passed | 2 skipped | 9 todo
$ pnpm build:api                                            → 8/8 packages build clean (database → domains → applications → api)
```

### P2 — OIDC end-to-end (done)

- **`TenantIdpConfigService`** (`packages/applications/src/services/tenant-idp-config/`) — CRUD (create/list/getById/update/remove) + Vault-seal the client secret on write, rotate on update; `testConnection` (OIDC discovery + client construction — never a full browser login) flips `providerStatus` DRAFT → ENABLED on success (D7, no self-lockout), leaves it unchanged on failure. 404-over-403 tenant scoping throughout.
- **`IdpResolverService`** (`packages/applications/src/services/idp-resolver/`) — tenant-scoped repository read + per-provider `openid-client` (v5.7.1, class-based API) client cache, keyed by `providerId`. `resolveForTenant` (tenant+protocol, used by `/start`) and `resolveByProviderId` (used by `/callback` — does NOT assume the in-memory cache is warm, since `start`/`callback` can land on different pods) share one cache; `TenantIdpConfigService.update`/`remove`/`testConnection` call `invalidate(providerId)`.
- **`FederatedAuthService`** (`packages/applications/src/services/federated-auth/`) — `buildAuthorizeUrl` (D5 HRD by email domain → `TenantIdentityProviderDomainRepository`, falling back to an explicit `tenantKey`; PKCE S256 + nonce + a signed 5-minute JWT `state` carrying `{tenantId, providerId, nonce, codeVerifier}` — no server-side session/cookie needed) and `verifyOidcCallback` (state verify → `client.callback()` — PKCE/nonce/JWKS-signature/iss/aud/exp all verified by `openid-client` → `resolveOrProvisionUser`). JIT provisioning is one atomic transaction (User + UserRoleAssignment + UserDepartment + FederatedIdentity); the **`createExternalUser`-sets-no-membership gap** flagged in §7 Risks is closed here — JIT always creates both role and department rows, and a post-resolution membership re-check (mirroring `auth.controller.ts`'s local-login invariant) also covers a previously-JIT'd user whose access was later revoked. IdP group claims map to `Role.externalName` (D3/§3.D); `GLOBAL_ADMIN` is hard-guarded as never assignable via federation (D6) — enforced explicitly here since the CLS-gated `assertAssignableRoleTier` guard doesn't fire pre-session. Not a `BaseService` (runs pre-session, no CLS tenant to force onto `broadcastSysEvent`) — sys-events are emitted directly with the verified `provider.tenantId`. `resolveOrProvisionUser` is protocol-neutral (keyed on `providerId`+`subject`) for TASK-499 (SAML) to reuse verbatim.
- **`auth-sso.controller.ts`** (`apps/api/src/modules/auth/`, mounted in the existing `AuthModule`) — `POST /auth/sso/start` and `GET /auth/sso/callback`, both `@Public()` + throttled like `/auth/login`. The callback mints a HOPE JWT + refresh token via the exact same `createJwt`/`RefreshTokenService.issue` path as local login, returning the same `LoginResponse` shape — `UnifiedAuthGuard`/`jwt.strategy`/`policy.engine` authorize a federated session identically to a password session downstream.
- **`tenant-idp-config-admin.controller.ts`** (`admin/tenant-idp-config`, new `TenantIdpConfigModule` registered in `AppModule`) — CRUD + `:id/test`, `@Authorize`/`@RequiresIfMatch` mirroring `TenantTtsConfigAdminController` exactly.
- New `ResourceType` values `TenantIdentityProvider`/`FederatedIdentity` (domain enum + DB enum, migration `20260712170000_task_498_resource_type_identity_provider`, applied dev+test) so `broadcastSysEvent`/direct sys-event writes don't fail.
- New CASL subject `TenantIdentityProvider`: seeded into the `TENANT_ADMIN` tenant-scoped policy (`packages/database/src/prisma/db_main/seed/01-policy.ts`, mirrors the `TenantTtsConfig` entry) — `GLOBAL_ADMIN` already covers it via the wildcard `manage all` rule.
- **Design decisions not spelled out in §3–§4, made while implementing:** (a) `/auth/sso/start` returns `{authorizeUrl}` as JSON (200) rather than issuing its own 302 — the BFF (P4) owns the actual browser redirect, consistent with how `POST /auth/login` already returns tokens as JSON for the BFF to act on. (b) The "signed state cookie" in the §3.C sequence diagram is implemented as a **stateless signed JWT** carried through the `state` query parameter (not a cookie) — `apps/api` has no cookie-parser wired in, and a self-contained state avoids adding one; PKCE `code_verifier` and `nonce` round-trip inside it. Replay protection relies on: the IdP's own single-use-authorization-code enforcement (standard OAuth2), the state JWT's short (5 min) expiry, and a fresh `nonce` per flow (checked by `openid-client` against the ID token) — flagged in Risks below as a candidate for a stronger Redis-backed one-time-nonce store if ever needed.

**Evidence:**

```
$ pnpm --filter @arcaai/applications build                  → tsc clean
$ pnpm --filter @arcaai/applications exec vitest run          → 286 files / 6091 tests passed (0 failed) — full package, no regressions
$ pnpm build:api                                              → 8/8 packages build clean
$ pnpm --filter @arcaai/api lint                               → clean (no errors)
$ pnpm test:unit (full monorepo)                               → 890 files / 15964 tests passed; 1 pre-existing failing file
    (apps/api/src/__tests__/env-port-standardization.test.ts, unrelated IAppConfig/TTS_URL
    cleanup already dirty on this branch before this session — not touched by TASK-498)
```

New TDD test files (all RED→GREEN): `idp-resolver.service.test.ts` (11), `tenant-idp-config.service.test.ts` (19), `federated-auth.service.test.ts` (12), `tenant-idp-config-admin.controller.test.ts` (7), `auth-sso.controller.test.ts` (4).

Deferred to P4: admin-console UI (design-gated), a live e2e OIDC round-trip against a real mock-issuer HTTP server (current coverage is unit-level with `openid-client` mocked at the module boundary — every security-relevant branch is covered, but no live Playwright/API-server run was executed this session).

### P3 — Directory pull (done)

- **`IDirectoryProvider`** (`packages/applications/src/services/directory-sync/`) — a small pull interface (`fetchUsers(credentials, pageToken) → {users, nextPageToken}`); `DirectoryUser.groups` is a list of display names, matched against the SAME `groupToRoleMap`/`Role.externalName` key space `FederatedAuthService` uses at OIDC login time.
- **`MsGraphDirectoryProvider`** — app-only client-credentials OAuth2 grant against the tenant's own Azure AD app registration (`login.microsoftonline.com/{azureTenantId}/oauth2/v2.0/token`, scope `graph.microsoft.com/.default`), then paged `GET /v1.0/users` (`@odata.nextLink` cursor) + one `GET /users/{id}/memberOf` call per user for group names. Token cached in-memory with a 60s-early-refresh buffer.
- **`GoogleDirectoryProvider`** — domain-wide-delegated service-account JWT-bearer grant (RFC 7523: an RS256-signed assertion with `sub`=the delegated Workspace admin, exchanged at `oauth2.googleapis.com/token`), then paged Admin SDK `GET /admin/directory/v1/users` + one `GET .../groups?userKey=` call per user. Same token-caching approach.
- Both providers are individually kill-switched (`TENANT_IDP_MS_GRAPH_ENABLED` / `TENANT_IDP_GOOGLE_DIRECTORY_ENABLED`, P0 flags, default OFF) and read via `ConfigService` — `fetchUsers` throws `BadRequestException` when its flag is off. Credentials are tenant-supplied, JSON-stringified, then Vault-sealed into `TenantIdentityProvider.directoryCredentialsRef` (same BYO pattern as the OIDC client secret); `config.directoryProvider` (new `OidcProviderConfigDto` field, `'ms-graph' | 'google-directory'`) selects which one a sync run dispatches to.
- **`DirectorySyncService.enqueueSync`** — validates the provider row (tenant-owned, has `directoryProvider` + a sealed `directoryCredentialsRef`) and enqueues a `SyncTenantDirectoryUsers` BullMQ job (new `JobQueue` member; auto-registered by `apps/api/src/app.module.ts`'s existing `Object.values(JobQueue)` wiring — no extra queue plumbing needed). Idempotent (`attempts: 3` — a retried job just re-processes already-linked users as no-ops).
- **`DirectorySyncProcessor`** — mirrors `IngestKnowledgeDocumentProcessor`'s shape (fail-closed `tenantId` guard, CLS rebind via `createWorkerSession` — added `'directory-sync'` to the closed `WorkerSessionKind` union — `assertEqualTenants` defense-in-depth). Pages through `fetchUsers`, and for each directory user calls `FederatedAuthService.resolveOrProvisionUser` **verbatim** (now public — the exact same JIT transaction, group→role mapping, and GLOBAL_ADMIN hard-guard as OIDC login-time JIT, so directory-pull and live login can never diverge on "how a HOPE user gets created"). A per-user failure (seat quota via `IEntitlementsService.assertQuantityQuota`, kill-switch-gated; or any provisioning error) is caught and recorded in `skippedReasons` — **the batch continues**, it never aborts on one bad user. `job.updateProgress()` per page; result/progress polling reuses the existing `GET /admin/queues/SyncTenantDirectoryUsers/jobs/:jobId` surface (`queue-admin` module) rather than a new bespoke status endpoint.
- **`POST /admin/tenant-idp-config/:id/sync`** (202 + `{jobId}`) added to the existing admin controller, same `@Authorize`/tenant-scoping as the rest of that surface.
- **Known gap, flagged not hidden:** `queue-admin`'s job-status endpoint is gated `@Authorize(['manage','all'])` (platform-admin only) — a `TENANT_ADMIN` who triggers a sync today gets the `202 {jobId}` but cannot poll its progress/result themselves (a `GLOBAL_ADMIN` can, on their behalf). Widening `queue-admin`'s authorization to tenant-scoped read access is a candidate follow-up, intentionally left out of this ticket's scope (it's shared infra used by every BullMQ queue in the platform, not TASK-498-specific).

**Evidence:**

```
$ pnpm --filter @arcaai/applications build                  → tsc clean
$ pnpm --filter @arcaai/applications exec vitest run          → 294 files / 6160 tests passed (0 failed)
$ pnpm build:api                                              → 8/8 packages build clean
$ pnpm --filter @arcaai/applications lint / @arcaai/api lint  → 0 errors (pre-existing unrelated prettier warnings only)
$ pnpm test:unit (full monorepo)                               → 902 files / 16065 tests passed; 1 pre-existing failing file
    (apps/api/src/__tests__/env-port-standardization.test.ts, unrelated IAppConfig/TTS_URL
    cleanup already dirty on this branch before this session — not touched by TASK-498)
```

New TDD test files (RED→GREEN): `ms-graph-directory.provider.test.ts` (5), `google-directory.provider.test.ts` (4), `directory-sync.service.test.ts` (5), `directory-sync.processor.test.ts` (9) — 23 tests covering paging, idempotency (existing-link no-op), quota-skip-and-continue, group→role claim passthrough, and provider dispatch.

### P4 — admin-console (done)

Built directly against code-level best practices (the `07-react-ui`/`10-skeleton-loading`/`11-ux-ui-principles`/`13-nextjs-apps` rules), **skipping the Figma design gate** (`12-design-workflow`) on the user's explicit instruction ("go straight to UI things following best practices instead of waiting for designs") rather than waiting on a batch design train for a tier 30–49 admin screen.

- **BFF SSO routes** (`apps/admin-console/src/app/api/auth/sso/{start,callback}/route.ts`) — direct-fetch handlers (not the catch-all `hope-proxy.ts`, since these are pre-session) that call the gateway's `POST /auth/sso/start` / `GET /auth/sso/callback` and `setSession()` on a verified callback, identical to the existing password-login BFF route.
- **Login screen** (`apps/admin-console/src/features/auth/components/login-form.tsx`, `src/app/(auth)/login/page.tsx`) — an email input + "Continue" button below the password form that posts to the SSO start route (HRD by email); the page reads `?error=` to surface a failed-callback redirect.
- **`identity-providers` feature** (`apps/admin-console/src/features/identity-providers/`) — API layer (`api/{types,client,keys,hooks}.ts`: full CRUD + `testConnection`/`syncDirectory`/`setDirectoryCredentials`, plus local `listDepartments`/`listRoles` duplicates per the "features never import each other" convention) and components: `identity-providers-screen.tsx` (`ScreenTemplate` + `VirtualizedDataGrid`, `WorkingTenantGate` for the tier 30–49 boundary), `identity-provider-detail.tsx` (`DetailDrawer` with Overview/Directory-sync tabs, group→role mapping editor, redirect-URI copy block, Test-connection action), `identity-provider-form.tsx`, `test-connection-section.tsx`, `directory-sync-panel.tsx` (directory-API picker + MS Graph/Google credential forms + sync trigger — deliberately no live job-progress bar, since `queue-admin`'s job-status endpoint is platform-admin-only, per the P3 flagged gap).
- **Route + nav** — `src/app/(console)/(tenant)/identity-providers/page.tsx` (tier 30–49 route group) and a new `NavEntry` in `shared/navigation/nav-config.ts` gated on `['read', 'TenantIdentityProvider']`.
- A real backend gap surfaced by dogfooding the UI (full TDD cycle, not scope creep): `DirectorySyncService.enqueueSync` required `directoryCredentialsRef` but no endpoint existed to set it. Added `PUT /admin/tenant-idp-config/:id/directory-credentials`, `SetDirectoryCredentialsRequest` DTO, `ITenantIdpConfigService.setDirectoryCredentials()`, and `hasDirectoryCredentials` on the response DTO — built and merged into P2's service *before* the directory-sync panel that depends on it.

**Evidence — static:**

```
$ pnpm --filter @arcaai/admin-console build   → clean (Next.js 16.3 / Turbopack)
$ pnpm --filter @arcaai/admin-console lint    → 0 errors, 0 warnings
$ pnpm --filter @arcaai/admin-console exec vitest run
    → 124 files / 923 tests passed (0 failed), incl. identity-providers-screen.test.tsx (6)
      and identity-providers-api.test.ts (8)
```

**Evidence — live runtime verification** (`pnpm dev:api` + the `admin-console` dev server, both themes, logged in as the seeded `tenant_admin` / tenantKey `__GLOBAL__`):

- Login → `/identity-providers` → grid renders, empty state renders with a working "New provider" CTA.
- **Real bug found and fixed during this pass**: the screen 403'd with `Missing permissions: read:TenantIdentityProvider` even though the `TENANT_ADMIN` CASL policy row added in P2 (§8 P2) was correct in the seed source. Root cause: (a) the local dev Postgres had never been re-seeded since that seed-file change landed, and (b) `PolicyEngine` Redis-caches resolved abilities per `(userId, tenantId)` for 5 minutes (`policy.engine.ts` `CACHE_TTL`/`CACHE_PREFIX`), so even after `pnpm db:seed` the stale cached ability from an earlier login attempt kept returning the 403. Fixed by re-running `pnpm db:seed` (idempotent — `Policy.update` by name) and flushing the `policy:ability:*` Redis keys. This is a dev-environment staleness trap, not a code defect — flagging it here since a fresh `dev:setup` or a first login after a new tenant-scoped CASL subject ships will not hit it (no pre-existing stale cache to invalidate), but a long-running local API process picking up a new seed row without a cache-busting restart will.
- Create flow: opened the drawer, dropdowns populated from live `GET /admin/departments` / `GET /admin/rbac/roles` (not mocked), submitted → `POST /admin/tenant-idp-config` → 201 → grid updates to "1 providers" → detail drawer opens pre-filled, secret shown as "write-only — never shown", toast fired.
- Directory sync tab: selected "Microsoft Graph (Entra ID)" → `PUT .../directory-credentials`-adjacent config save (`PUT /admin/tenant-idp-config/:id`) → 200 → MS Graph credential form (Azure tenant ID / client ID / client secret) rendered with the "not configured" badge and the least-privilege-scopes helper text.
- Test connection: `POST /admin/tenant-idp-config/:id/test` performed a **real OIDC discovery HTTP call** to `https://acme.okta.com/.well-known/openid-configuration` (Okta's per-org wildcard subdomain responds to discovery even for an unprovisioned org name) and succeeded, flipping `DRAFT` → `ENABLED` live in both the drawer header and the grid row, with a confirming toast.
- Delete: type-to-confirm dialog required typing the exact display name, then `DELETE /admin/tenant-idp-config/:id` → 204 → grid returns to the empty state, toast fired.
- Both themes verified visually (dark default + light via the topbar theme toggle) — semantic tokens render correctly, no hardcoded-color regressions.
- Not run this session: an automated axe scan (0-violations gate) and a keyboard-only pass — flagged as outstanding for the Definition of Done, not silently skipped.

---

## 9. Change History

| Date | Change | Author |
|---|---|---|
| 2026-07-12 | Ticket created — OIDC + SAML in one plan. | Claude (Opus 4.8) + Tap Huynh |
| 2026-07-12 | **SAML split out to [TASK-499](../TASK-499-Tenant-External-IdP-SAML/README.md)** to de-risk OIDC. This ticket is now OIDC-only; data model + service seams kept protocol-neutral so SAML is additive. D1 rescoped; SAML phase/flows/columns removed and moved to TASK-499. | Claude (Opus 4.8) + Tap Huynh |
| 2026-07-12 | §1 Decisions (D1–D7) approved. **P0 done** (`TENANT_IDP_ENABLED` + directory-sync flags). **P1 done** (DB schema + migration applied dev/test; hand-authored domain trio; `CoreDatabaseModule` registration; drift gates + `@arcaai/domains` build/lint/test green). | Claude (Sonnet 5) + Tap Huynh |
| 2026-07-12 | **P2 done** — `TenantIdpConfigService`, `IdpResolverService`, `FederatedAuthService` (JIT provisioning, group→role mapping, GLOBAL_ADMIN hard guard), `auth/sso` controller (`start`/`callback`), `admin/tenant-idp-config` controller, `ResourceType` enum additions + migration, `TENANT_ADMIN` CASL policy seed entry. Full TDD (RED→GREEN), 6091 `@arcaai/applications` tests + 15964 monorepo `test:unit` tests green (1 pre-existing unrelated failure untouched), `build:api` + `apps/api` lint clean. E2E OIDC round-trip against a live mock issuer deferred (unit-level `openid-client` mocking covers every security branch). | Claude (Sonnet 5) + Tap Huynh |
| 2026-07-12 | **P3 done** — `IDirectoryProvider` + `MsGraphDirectoryProvider` (client-credentials) + `GoogleDirectoryProvider` (domain-wide-delegated JWT-bearer), `DirectorySyncService` (enqueue) + `DirectorySyncProcessor` (BullMQ, reuses `FederatedAuthService.resolveOrProvisionUser` verbatim — now public), new `SyncTenantDirectoryUsers` `JobQueue` member, `POST /admin/tenant-idp-config/:id/sync`. Seat-quota-aware, skip-and-continue per-user error handling. Full TDD, 23 new tests, 6160 `@arcaai/applications` tests + 16065 monorepo `test:unit` tests green (same 1 pre-existing unrelated failure), builds/lint clean. Flagged (not fixed, out of scope): `queue-admin` job-status polling is platform-admin-only today, so a tenant admin can't self-poll their own sync job's progress. | Claude (Sonnet 5) + Tap Huynh |
| 2026-07-13 | **P4 done** — user explicitly directed skipping the `12-design-workflow` Figma gate for this admin-console work ("go straight to UI things following best practices instead of waiting for designs"); built BFF SSO routes, login SSO button, the `identity-providers` feature (list/create/edit/delete, directory-sync tab, test-connection), and route/nav registration. Added a `PUT :id/directory-credentials` endpoint (found via dogfooding the UI — P3's sync flow needed it but nothing exposed it). Static verification green (`build`/`lint`/`test` — 124 files / 923 tests). Live runtime verification in a browser against a real `pnpm dev:api` + Postgres/Redis: full create/update/test-connection/delete lifecycle exercised, both themes checked. Found and fixed a real dev-environment staleness bug in the process — the P2 CASL policy seed row hadn't been applied to the local DB and `PolicyEngine`'s 5-minute Redis ability cache was serving a stale pre-policy 403 (`pnpm db:seed` + flushing `policy:ability:*` fixed it; not a code defect, documented in §8 P4 as a trap for anyone hitting a new tenant-scoped CASL subject on a long-running local API process). Outstanding: axe/keyboard accessibility pass not run this session. | Claude (Sonnet 5) + Tap Huynh |
