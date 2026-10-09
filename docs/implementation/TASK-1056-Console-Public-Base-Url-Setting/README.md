# TASK-1056 — Console public base URL is a tenant → platform setting

**Status:** Review · **Type:** bugfix · **Branch:** dev-2.2

## Requirement Analysis

On the cluster, an admin password reset returned
`http://localhost:5176/reset-password?token=…` instead of an `admin.taphuynh.dev` link. Owner rule:
the public domain must NOT be an environment variable — a tenant admin configures it in platform
settings, with the platform (SYSTEM) value as the fallback.

## Current State Evaluation

- `UserPasswordService.absolutize()` and `msgraph-mailer.ts` read `process.env.PASSWORD_RESET_BASE_URL`,
  falling back to the hardcoded `DEFAULT_PASSWORD_RESET_BASE_URL = 'http://localhost:5176'`.
- The cluster never set the env var → every link pointed at localhost.

## Owner decisions (2026-10-09)

| # | Decision |
|---|---|
| OD-1 | One general key, `console.publicBaseUrl` (later email links reuse it) |
| OD-2 | Admin reset resolves the tenant the admin acts in (the target user's in-scope tenant). `User` has no `tenantId` column, so self-service forgot-password (no tenant context) resolves the platform tier. The request `Host` is never trusted (reset-poisoning). |
| OD-3 | No seed value; set per environment in the console (SYSTEM tier) |
| OD-4 | Tenant-overridable (`maxScope: 'tenant'`) |

## Implementation Plan

1. Descriptor `console.publicBaseUrl` — `global-kv`, string, `maxScope: 'tenant'`, `failMode: 'closed'`,
   no default, `validate` = absolute http(s) origin with no path/query.
2. `UserPasswordService` resolves it via `TenantSettingsService` (tenant → SYSTEM). Unset ⇒ no
   absolute link and no email; the admin response carries the relative `resetPath` and the console
   prefixes its own origin. The reset itself always succeeds.
3. Mailer payload carries the absolute `resetUrl`; mailers no longer read env.
4. Remove `PASSWORD_RESET_BASE_URL` (env descriptor, `turbo.json`, `.env.sample`s) and the localhost constant.

TDD list: tenant value wins · SYSTEM fallback · unset ⇒ relative path + no email + reset succeeds ·
self-service uses the platform tier · descriptor refuses a non-origin value · mailer uses `resetUrl`.

## Implementation Summary

- New descriptor `console.publicBaseUrl` (`settings-registry/descriptors/console-public-url.descriptors.ts`):
  global-kv, tenant-overridable, fail-closed, no default, `validate` = bare http(s) origin.
- `user/userPassword/console-link.ts` — `absolutizeConsoleLink()` resolves it through
  `TenantSettingsService` (tenant → SYSTEM) and returns `null` when unset.
- `UserPasswordService`: admin reset uses the working tenant; self-service uses the platform tier.
  Unset ⇒ relative `resetPath`, no email, reset still succeeds.
- `RegistrationService` (verify-email) had the same localhost bug via the shared mailer — now the
  same key, platform tier; unset ⇒ no email.
- Mailer payload carries `resetUrl`; `msgraph-mailer` no longer reads env. Removed
  `PASSWORD_RESET_BASE_URL` + `DEFAULT_PASSWORD_RESET_BASE_URL` (env descriptor, `turbo.json`,
  `.env.sample`s via `pnpm env:sync`).
- Console reset dialog shows a relative path on its own `window.location.origin`.
- Artifacts regenerated: openapi, route manifest, portal, vox-node admin schemas.

**Operator step per environment:** set `console.publicBaseUrl` at the platform tier in the console
(e.g. `https://admin.taphuynh.dev` on the dev cluster). No deployment-repo change.

### Evidence (2026-10-09)

- `packages/applications`: `vitest run src/services/auth/registration src/services/user/userPassword src/services/settings-registry` → 67 files, 688 tests passed; `tsc --noEmit` clean; eslint clean on changed dirs.
- `apps/admin-console`: `vitest run src/features/users` → 5 files, 55 tests passed; `tsc` + eslint clean.
- `apps/api`: `vitest run src/modules/settings` → 6 files, 46 tests passed.
- Artifact chain (`applications build → api:build → api:route-manifest → api:openapi → api:portal → vox-node gen:admin`) exit 0.

## Change History

- 2026-10-09 — ticket opened; env-var approach rejected by owner, replaced by the setting.
- 2026-10-09 — implemented (OD-1..4 as recommended); verify-email folded in under OD-1.
