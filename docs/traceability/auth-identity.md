# Traceability — Authentication & Identity

Sessions, credentials, authorization, password recovery, token revocation + HIPAA
auth-event auditing, and tenant-scoped federated identity (OIDC + SAML SSO, directory
sync). Migrates and extends legacy matrix rows **1, 2, 3, 8**, and adds the two surfaces
that had no legacy home: **SSO/SAML** (TASK-498/499) and **auth token revocation & HIPAA
auth-event audit** (TASK-541).

Route paths are relative to the global prefix `/api/v1`. Test shorthand is defined in
[`index.md`](./index.md#test-location-shorthand). `—` means verified-absent.

## Core authentication & authorization

### A1 — Authentication & sessions (JWT, refresh, impersonation, stream tickets) — legacy row 1

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/auth` (`auth.controller.ts`, `register.controller.ts`, `admin-impersonation.controller.ts`, `stream-ticket.service.ts`); `packages/applications/src/services/auth` (`auth.service.ts`, `jwt.strategy.ts`, `createJwt.ts`, `oidc.strategy.ts`); guards `UnifiedAuthGuard` → `JwtAuthGuard` → `JwtStrategy` |
| Prisma models | `User`, `PasswordResetToken` (refresh-token family + revocation state in Redis) |
| Key API endpoints | `@Controller('auth')`: `POST /auth/login`, `/auth/logout`, `/auth/refresh`, `/auth/impersonate`, `/auth/revoke-impersonation`, `/auth/stream-ticket`, `GET /auth/me`; `POST /auth/register`, `/auth/register/verify`; `@Controller('admin/users')` → `POST /admin/users/:id/impersonate` |
| Console | `apps/admin-console` feature `auth` (`login-form`, `register-form`, `verify-email-screen`); BFF session under `src/app/api/auth/*` |
| Tests | e2e: `auth.spec.ts`, `auth-advanced.spec.ts`, `auth-refresh.spec.ts`, `auth-guard-behavior.spec.ts`, `user-impersonation.spec.ts`; unit(api): `auth/__tests__/*` (login, stream-ticket, task295, task307, task401, task541); unit(app): auth service suite; unit(console): `auth/__tests__/{login-form,register-form,verify-email-screen}.test.tsx` |

### A2 — API keys (service-to-service auth) — legacy row 2

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/api-key`; `packages/applications/src/services/apiKey` |
| Prisma models | `ApiKey` (`db_main/apikey.prisma`) |
| Key API endpoints | `@Controller('admin/api-keys')` — CRUD |
| Console | `apps/admin-console` feature `api-keys`; route `/api-keys` (tier 20–29, shared) |
| Tests | e2e: `api-key-auth.spec.ts`, `api-key-owner-scope.spec.ts`; unit(app); unit(console): `api-keys/**/__tests__/*` |

### A3 — RBAC / policy authorization — legacy row 3

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/rbac` (`roles.controller.ts`, `policies.controller.ts`, `permission-check.controller.ts`); `packages/applications/src/authorization` (PolicyEngine), `packages/applications/src/services/rbac` |
| Prisma models | `Role`, `Policy`, `RolePolicy` (`db_main/rbac.prisma`); `UserRoleAssignment` (`db_main/user.prisma`) |
| Key API endpoints | `@Controller('admin/rbac/roles')` (+ `:id`, `:id/members`), `@Controller('admin/rbac/policies')` (+ `:id`, `POST validate`), `@Controller('rbac/check')` → `POST /rbac/check`, `POST /rbac/check/bulk`, `POST /rbac/check/my-permissions` |
| Console | `apps/admin-console` feature `rbac` (`roles-screen`, `policies-screen`, `permission-matrix`); routes `/rbac/roles`, `/rbac/policies` (tier 20–29, shared) |
| Tests | e2e: `rbac.spec.ts`, `authorization.spec.ts`, `tenant-access-control.spec.ts`; unit(app); unit(console): `rbac/**/__tests__/*` |

### A4 — Password reset (forgot-password email flow) — legacy row 8

| Field | Value |
|---|---|
| App / service | `apps/api` (MS-Graph mail transport) |
| Key modules | `apps/api/src/modules/user` (forgot-password / password-reset controllers) |
| Prisma models | `PasswordResetToken` (`db_main/password-reset-token.prisma`) |
| Key API endpoints | `POST /auth/forgot-password` (public request; `forgot-password.controller.ts`), `POST /users/password-reset/complete` (`password-reset.controller.ts`) |
| Tests | e2e: `password-security-hardening.spec.ts`, `password-hash-settings.spec.ts` |

### A5 — Auth token revocation & HIPAA auth-event audit (TASK-541) — NEW

Closes two live security/compliance TODOs in `auth.service.ts` (revocation stub always
returned `false`; no persisted failed-auth trail). Status: **Review** on `fix/2605-review`.

| Field | Value |
|---|---|
| App / service | `apps/api` + Redis (revocation store) + `AuditLog` table |
| Key modules | `packages/applications/src/services/auth` (`jwt-revocation.service.ts` — Redis set `jwt-revoked:<jti>` + per-user not-before `auth:user-nbf:<userId>`; `jwt-revocation.module.ts`; `jwt.strategy.ts` applies the fail-open/fail-closed posture; `auth.service.ts` delegates `isTokenRevoked` → `IJwtRevocationService`); `packages/applications/src/services/user/user/user.service.ts` stamps the per-user not-before on any transition away from `ENABLED` and on soft-delete; `packages/applications/src/services/auditLog/auditLog.service.ts` handles the new `UserAuthenticationFailed` event |
| Prisma models | `AuditLog` (`db_main/audit.prisma`) — envelope-encrypted LOGIN/AUTHENTICATION rows; **no new model** (revocation state is Redis-only, no schema change) |
| Key API endpoints | enforced on every authenticated request via `UnifiedAuthGuard`; triggered by `POST /auth/logout` (access jti + refresh family), `POST /auth/revoke-impersonation`, and user deactivate/suspend/soft-delete. Failed-auth rows emitted from the `POST /auth/login` and `POST /auth/refresh` rejection paths |
| Owner decisions | fail **OPEN** for ordinary tokens / fail **CLOSED** for impersonation on a Redis outage (A3); per-user not-before TTL 24 h, deny-on-tie `iat <= notBefore` (A4-TTL) |
| Notable fixes | `GatewayJwtStrategy`/`GatewayAuthGuard`/`gateway-decorators` RETIRED (A2 — dead path, `UnifiedAuthGuard` is the single enforcement point); username-enumeration oracle (`findFirst` throws vs returns null) closed; a throwing audit emitter no longer escalates a 401 into a 500; `BaseEntity.suspend()` + exhaustive status switch (SUSPENDED was a silent no-op) |
| Tests | unit(app): `auth/__tests__/jwt-revocation.service.test.ts`, `auth/__tests__/jwt.strategy.test.ts`, `user/user/__tests__/user.service.task541.test.ts`, `auditLog/__tests__/auditLog.service.task541.test.ts`; plus `packages/applications/src/common/__tests__/applyChangesToEntity.test.ts` (not under `services/`); unit(dom): `common/baseEntity/__tests__/base.entity.test.ts`; unit(api): `auth/__tests__/auth.controller.task541.test.ts`; e2e: `auth-revocation-audit.spec.ts` (logout→replay 401; deactivate→live token 401; failed login writes a queryable `success:false` row that never contains the attempted password) |

## Federated identity (tenant SSO)

Per-tenant external identity providers. Non-secret config in a JSON column; OIDC client
secret + directory-API credentials sealed with Vault Transit (plaintext never stored). The
model plane ships both OIDC and SAML; v1 (TASK-498) validated OIDC, SAML landed via
TASK-499.

### I1 — Tenant identity-provider configuration (OIDC/SAML) — NEW

| Field | Value |
|---|---|
| App / service | `apps/api` + Vault + BullMQ (directory-sync jobs) |
| Key modules | `apps/api/src/modules/tenant-idp-config` (`tenant-idp-config-admin.controller.ts`); `packages/applications/src/services/tenant-idp-config` (`tenant-idp-config.service.ts`, `saml-sp-key.util.ts`); directory sync in `packages/applications/src/services/directory-sync` (`directory-sync.service.ts`, `directory-sync.processor.ts`, `google-directory.provider.ts`, `ms-graph-directory.provider.ts`) — no gateway controller of its own; run via the `:id/sync` route + BullMQ |
| Prisma models | `TenantIdentityProvider`, `FederatedIdentity`, `TenantIdentityProviderDomain` (`db_main/identity-provider.prisma`). `IdpProtocol` / `IdpStatus` enums |
| Key API endpoints | `@Controller('admin/tenant-idp-config')` (`@Authorize()` class-level): `GET ''` / `GET :id` (`read TenantIdentityProvider`), `POST ''` / `PUT :id` / `DELETE :id` (`manage`), `POST :id/test` (test connection — flips DRAFT→ENABLED), `PUT :id/directory-credentials` (BYO directory API key, Vault-encrypted), `POST :id/sync` (trigger directory sync) |
| Console | `apps/admin-console` feature `identity-providers` (`identity-providers-screen`, `identity-provider-form`, `identity-provider-detail`, `test-connection-section`, `directory-sync-panel`); route `/identity-providers` (tier 30–49, tenant-scoped) |
| Tests | unit(app): `tenant-idp-config/__tests__/tenant-idp-config.service.test.ts`, `tenant-idp-config/dto/__tests__/create-tenant-idp-config.request.test.ts`, `directory-sync/__tests__/{directory-sync.service,directory-sync.processor,google-directory.provider,ms-graph-directory.provider}.test.ts`; unit(api): `tenant-idp-config/__tests__/tenant-idp-config-admin.controller.test.ts`; unit(console): `identity-providers/components/__tests__/identity-providers-screen.test.tsx`, `identity-providers/api/__tests__/identity-providers-api.test.ts` |

### I2 — Federated SSO login (OIDC + SAML ACS) — NEW

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/auth` (`auth-sso.controller.ts` — all legs pre-session `@Public()`, throttled like `/auth/login`); `packages/applications/src/services/federated-auth` (`FederatedAuthService`), `packages/applications/src/services/idp-resolver` (`idp-resolver.service.ts`, `saml-redis-cache-provider.ts` — home-realm discovery + SAML replay cache) |
| Prisma models | `TenantIdentityProvider`, `FederatedIdentity`, `TenantIdentityProviderDomain` |
| Key API endpoints | `@Controller('auth/sso')`: `POST /auth/sso/start`, `GET /auth/sso/callback` (OIDC); SAML: `GET /auth/sso/saml/:tenantKey/metadata`, `POST /auth/sso/saml/:tenantKey/start`, `POST /auth/sso/saml/:tenantKey/acs` |
| Console | BFF SSO handlers under `apps/admin-console/src/app/api/auth/sso/{start,callback}` |
| Tests | unit(app): `federated-auth/__tests__/federated-auth.service.test.ts`, `idp-resolver/__tests__/idp-resolver.service.test.ts`, `idp-resolver/__tests__/saml-redis-cache-provider.test.ts`; unit(api): `auth/__tests__/auth-sso.controller.test.ts`; **e2e: `—`** |

## Honest notes / gaps

- **SAML assertion-security e2e is an OPEN gate.** I2 has unit coverage (mocked SAML client) but **no** end-to-end matrix exercising real signed assertions against tampering / expiry / replay / XML-signature-wrapping (XSW). Per the TASK-499 status this is the documented hard gate — do not read the unit coverage as assertion-hardening evidence.
- **Directory sync has no dedicated gateway controller.** It is invoked through `admin/tenant-idp-config/:id/sync` and executed by a BullMQ processor; there is no standalone `/admin/directory-sync` surface.
- **A5 (TASK-541) is uncommitted** on `fix/2605-review` (status Review, staged) — treat as landed-but-unmerged.
- Users, profiles & departments (legacy row 7) remain in the legacy matrix under the tenancy/provisioning domain, not here.

Last verified: 2026-07-22
