# TASK-445 — Secret Rotation: Gateway Endpoint + Rotate Flow

- **Status**: Review
- **Type**: feature (full-stack — application → api → admin-console)
- **Owner**: apps/api (gateway) + `@arcaai/applications` + admin-console (`features/settings`)
- **Related**: **follow-up from TASK-439** (Settings & Secrets redesign — Rotate shipped as a client-side "guided replace" only, with a real endpoint filed as an API gap); TASK-437 (redesign foundation); TASK-396 (secret reveal + convention); TASK-302 (Vault-Transit encryption-at-rest scaffolding).

## Requirement Analysis

TASK-439 shipped the **Rotate** affordance on a secret setting as a UX-only "guided replace": the button focuses the write-only value field and swaps the helper copy; entering a new value replaces the stored secret on the next OCC `PATCH`. There is **no server-side rotation** — nothing regenerates, re-wraps, or explicitly invalidates the old secret, and rotation is not distinctly audited (it looks like an ordinary update).

This ticket adds a real server-side rotation endpoint for secret settings and replaces the guided-replace affordance with a call to it:

1. `POST /admin/settings/:id/rotate` — mirror of the audited, gated `reveal` endpoint; performs the rotation atomically (replace the stored secret value / re-wrap ciphertext), bumps `_version`, and emits a distinctly-tagged, force-audited event.
2. Rewire the `features/settings` Rotate affordance to call it (replacing the guided-replace).

### Acceptance criteria

- [ ] `POST /admin/settings/:id/rotate` rotates ONE secret setting atomically under optimistic concurrency, is GLOBAL-ADMIN gated + step-up-audited like reveal, and never returns the plaintext.
- [ ] The old value is invalidated as part of the same versioned write (no window where both old and new are valid in the row).
- [ ] The rotation is distinctly audited (an `AuditLog` row tagged as a rotation, plaintext excluded).
- [ ] `locked` platform-owned rows stay GLOBAL-ADMIN-only (same guard as update/reveal).
- [ ] admin-console Rotate calls the endpoint (guided-replace retired); success/error toasts; both themes.
- [ ] Unit + e2e coverage incl. cross-tenant (404) and the non-secret / locked cases.

## Current State Evaluation

Verified 2026-07-08.

### The pattern to mirror — `reveal` (controller + service)

- **Controller** `apps/api/src/modules/global-setting/global-setting.controller.ts`: `@Controller('admin/settings')` + class `@CanManage('GlobalSetting')` (42-43). The reveal route `POST :id/reveal` (182-207): `@Post(':id/reveal')` (182), `@HttpCode(200)` (183), **`@Authorize(['manage','all'])`** (184) which **overrides** the class guard so only `manage:all` (GLOBAL_ADMIN) passes (tenant admins 403; documented 166-181). Signature `reveal(@Param('id') id, @Body() request: RevealGlobalSettingRequest)` (199) → delegates to `globalSettingService.revealSecret(id, request.password)` (200). The `update` route (108-149) is the OCC template: `@RequiresIfMatch()` + `@ExpectedVersion()` + If-Match header, `@CanUpdate('GlobalSetting')`.
- **Service** `packages/applications/src/services/globalSetting/globalSetting.service.ts`: `revealSecret` (260-313) — fail-closed order: `isSuperAdmin(this.requestUser)` → 403 (261-263); step-up re-auth `cryptoService.verify(password, user.password)` (bcrypt) → 401 (272-276); decrypt via `globalSettingRepository.findByIdWithDecryptedValue(id, this.secretsService)` (278); audit via a **direct** `eventEmitter.emit(SysEventType.ResourceViewed, { forceAuditLog: true, data.action: GLOBAL_SETTING_SECRET_REVEALED, … })` with **plaintext excluded** (296-310). `update` (195-233) does OCC via `updateWithVersion` + a `locked`-row guard and emits `ResourceUpdated` with `{ ...changes, previousVersion, newVersion }` (224-230). Interface `IGlobalSettingService.ts` (revealSecret at 26).

### How secrets are stored — and the wiring gap that shapes this ticket

- Encryption helpers exist: `packages/domains/src/repositories/generated/core/GlobalSettingRepository.encryption.ts` — `encryptValueIntoEntity(entity, secrets)` (94-103) writes Vault-Transit ciphertext into `encryptedValue` and parses `keyVersion` from the `vault:vN:<b64>` form (85-92); `decryptValueFromEntity` (105-121) decrypts or falls back to legacy plaintext `value`; `findByIdWithDecryptedValue` (123-131, used by reveal). Backend = Vault Transit via `SecretsService.encrypt/decrypt` (`packages/applications/src/services/baseServices/_meta/secrets/SecretsService.ts:250-267`, `SECRETS_PROVIDER=vault` gated).
- **Critical gap:** `encryptValueIntoEntity` is **never called in production** (only tests). `create`/`update` store `value` as **plaintext** and leave `encryptedValue`/`keyVersion` NULL; `isSecret` is derived purely by naming convention (`isSecretEntity`, `globalSetting.dto.mapper.ts:26-31` — `encryptedValue` present OR `namespace==='secrets'` OR `key` matches the secret pattern). Encryption-at-rest is scaffolded (schema + helpers) but the write path is unwired — comments call it the Phase 4C/4D migration. **Consequence for rotation:** for the settings in the DB today, the secret is just a plaintext `value`, so "regenerate" has no server-generatable material (unlike an API key token) — see Open-item 1.
- Prisma `GlobalSetting` (`packages/database/src/prisma/db_main/globalSetting.prisma`): `version` `@map("_version")` (4), `value String` (required, 16), `encryptedValue Bytes?` (21), `keyVersion Int?` (22), `dataType`/`namespace` (23-24), `locked` (11). No `isSecret` column.

### Precedent — the api-key rotate endpoint

- `apps/api/src/modules/api-key/api-key.controller.ts` — `POST /:id/rotate`, `@CanUpdate('ApiKey')` (131-155). Service `packages/applications/src/services/apiKey/apikey.service.ts` — `rotateKey(apiKeyId)` (600-670): mints a new key inheriting config, links `rotatedFromKeyId`/`rotatedToKeyId`, sets a 24h `rotationExpiresAt` grace, emits `SysEventType.ResourceUpdated` with `data.action: 'rotate'` (655-662), tenant/owner guard via `assertKeyAccess` (610). Interface `IApiKeyService.ts:70`. This is the closest in-repo template — but note api-keys can *generate* their own new secret material, which a free-form GlobalSetting secret cannot.
- Infra-level rotation (not per-setting): `ISecretsProvider.rotateSecret` — the **Vault provider explicitly does NOT support it** (`providers/vault-secrets.provider.ts:372`, throws; uses kv-v2 versioning + a background worker: `vault-rotation-worker.ts`). Not a fit for rotating a single GlobalSetting row.

### Audit / sys-events

- `SysEventType` (`packages/domains/src/enums/sysEventType.enum.ts`) has **only** `ResourceCreated`/`ResourceViewed`/`ResourceUpdated`/`ResourceDeleted` — **no `SecretRotated`**. Convention (matching api-key rotate + reveal): reuse `ResourceUpdated` with a distinguishing `data.action` tag (e.g. `GLOBAL_SETTING_SECRET_ROTATED`, a new constant beside `GLOBAL_SETTING_SECRET_REVEALED` at `globalSetting.service.ts:25`) and `forceAuditLog: true` so an `AuditLog` row always persists.

### admin-console — Rotate is guided-replace only

- Per TASK-439: the Rotate button (GLOBAL-ADMIN gated) in `apps/admin-console/src/features/settings/components/setting-drawer.tsx` focuses the write-only "New value" field and shows rotate helper copy; the actual change rides the OCC `PATCH` (`features/settings/api/client.ts:29` `updateGlobalSetting`). Reveal already models the audited step-up call (`client.ts:38` `revealGlobalSetting` → `POST :id/reveal`; deliberately NOT cached, `hooks.ts:55-57`). No `rotateGlobalSetting` client/hook exists.

**Delta summary**: new application method `rotateSecret` (mirror `revealSecret`'s gating/audit, do the write under OCC like `update`) + a `GLOBAL_SETTING_SECRET_ROTATED` audit tag → new gateway route `POST /admin/settings/:id/rotate` → admin-console `rotateGlobalSetting` client/hook + rewire the drawer's Rotate affordance. The reveal/update guards, OCC, and audit plumbing are all reusable.

### Open items to resolve during the plan

1. **What "rotate" means given the encryption gap.** A GlobalSetting secret is operator-supplied (no server-generatable material), and encryption-at-rest is unwired today. Recommended framing: rotation accepts the **new secret value** in the request and atomically replaces `value` (and, when encryption is wired, writes a fresh `encryptedValue` + new `keyVersion` via `encryptValueIntoEntity`), bumping `_version` and invalidating the old value in the same write — plus the distinct audit tag. This is stronger than guided-replace (atomic, distinctly audited, gated like reveal) without pretending to auto-generate a secret the server doesn't own. A pure "re-wrap under a new Transit key version, same plaintext" envelope-rotation variant is only meaningful once Phase 4C wiring lands — confirm scope with the product owner; if envelope-only rotation is wanted, this ticket **depends on** the Phase 4C encryption-write wiring.
2. **Auth + step-up.** Match reveal exactly: `@Authorize(['manage','all'])` (GLOBAL-ADMIN), and require step-up re-auth (password in the body, `cryptoService.verify`) since rotation is destructive to the old secret. Decide whether rotation also carries OCC via `If-Match` (recommended — it's a versioned write) in addition to step-up.
3. **Response.** Return the masked, versioned setting (new `_version`/ETag) — never the new plaintext (parity with reveal's plaintext-exclusion on all non-reveal surfaces).

## Implementation Plan

TDD; layer order per rule 01: Application → API → admin-console (no schema change — the columns already exist).

### 1. Application (`packages/applications`)
- Add `rotateSecret(id, { password, newValue, expectedVersion })` to `globalSettingService`, composed from existing pieces: super-admin/`manage:all` re-check + `cryptoService.verify` step-up (from `revealSecret`); `locked`-row guard + `updateWithVersion` OCC write (from `update`); write the new secret (plaintext `value` today; `encryptValueIntoEntity` + new `keyVersion` when encryption is wired — Open-item 1); emit `ResourceUpdated` with `data.action: GLOBAL_SETTING_SECRET_ROTATED` + `forceAuditLog: true`, **plaintext excluded**. Add the DTOs under `services/globalSetting/dto/` (`rotateGlobalSetting.request.ts` — `password`, `newValue`, `expectedVersion`; response = the masked `GlobalSettingResponse`) and the interface method. Tests: gating (tenant admin 403, wrong password 401), OCC 412 on drift, locked-row guard, old value invalidated, audit tag emitted, non-secret target rejected/allowed decision, plaintext never in the event.

### 2. API (`apps/api`)
- Add `POST /admin/settings/:id/rotate` to `global-setting.controller.ts`, mirroring reveal: `@Post(':id/rotate')`, `@HttpCode(200)`, `@Authorize(['manage','all'])`, `@RequiresIfMatch()` + `@ExpectedVersion()` per Open-item 2; body = `RotateGlobalSettingRequest`; returns the masked response (new ETag via the `ETagInterceptor`). Swagger 200/401/403/404/412/428. Tests: unit (mock service) + e2e — happy path, missing If-Match (428), version drift (412), tenant-admin 403, cross-tenant 404, plaintext never returned.

### 3. admin-console (`features/settings`)
- `api/client.ts` + `types.ts`: `rotateGlobalSetting(id, { password, newValue }, etag)` → `POST :id/rotate` (If-Match), NOT cached. `api/hooks.ts`: `useRotateGlobalSetting` invalidating the settings keys. Rewire the drawer's Rotate affordance (`setting-drawer.tsx`): replace guided-replace with a rotate action that collects the new value + step-up password (reuse the reveal re-auth dialog pattern), calls the endpoint, toasts success/error, and reflects the new version/ETag in place; keep the affordance GLOBAL-ADMIN gated. Tests: rotate posts the right body; 412 handled without data loss; gated by permission; success invalidates + toasts.

### 4. Verification & evidence
- [ ] `pnpm --filter @arcaai/applications build test` green
- [ ] `pnpm build:api` + `pnpm test:unit` + rotate e2e (incl. cross-tenant, 412/428) green
- [ ] `pnpm --filter @arcaai/admin-console build lint test` green; rotate flow tested; axe 0 violations; both themes
- [ ] AC checklist all checked with pasted evidence

## Implementation Summary

Implemented 2026-07-08 (TDD red→green per layer; all changes ADDITIVE to the shared settings files — TASK-443 worked the list path in the same files concurrently).

### Rotation semantics shipped (Open-item 1 resolved as recommended)

Rotation = an **atomic, step-up-gated, distinctly-audited replace-with-new-value under OCC**. The caller supplies the replacement secret; `updateWithVersion` compare-and-sets `_version`, so the old value is invalidated in the SAME versioned write (no dual-validity window). **No envelope re-wrap** — encryption-at-rest is still unwired (Phase 4C); when `encryptValueIntoEntity` is wired into the write path, `rotateSecret` is the single place to add the fresh-`keyVersion` re-wrap (noted in code). No schema change was needed.

- **Gating** (mirrors `reveal`): route-level `@Authorize(['manage','all'])` (GLOBAL_ADMIN only, overrides the class `@CanManage('GlobalSetting')`) + in-service super-admin re-check + step-up re-auth (`cryptoService.verify` against the stored bcrypt hash; 401 on wrong/missing password). The `locked`-row guard is subsumed — every caller reaching the write IS a GLOBAL_ADMIN (tested: locked rows rotate fine for global admins). Non-secret rows, empty replacements, and same-value replacements are rejected **400** — via NestJS `BadRequestException`, NOT `ArgumentInvalidException`: the `ExceptionInterceptor` maps `BaseException` subclasses to a generic 500, which the live smoke caught (non-secret initially rendered 500). 404-over-403 posture inherited from the tenant-scoped read.
- **OCC** (mirrors `update`): `@RequiresIfMatch()` → 428 when the `If-Match` header is missing; `@ExpectedVersion()` header overrides the body `expectedVersion`; drift → `OptimisticConcurrencyException` → 412.
- **Audit**: direct emit of `SysEventType.ResourceUpdated` with `forceAuditLog: true` and `data.action: GLOBAL_SETTING_SECRET_ROTATED` (new constant beside `GLOBAL_SETTING_SECRET_REVEALED`), carrying key/namespace/previousVersion/newVersion/rotatedAt. Unlike `update`, the event deliberately EXCLUDES `changes` and `previousData` — both would leak the new/old plaintext. Tenant attribution falls back to the rotated row's own persisted tenant (same null-CLS-tenant rationale as the reveal audit).
- **Response**: the masked `GlobalSettingResponse` (mapper blanks secret values) + fresh `ETag` from the global `ETagInterceptor`. The plaintext (old or new) never appears in the response, logs, audit event, or query cache.

### Files changed

| Layer | File | Change |
|---|---|---|
| applications | `services/globalSetting/globalSetting.service.ts` | + `GLOBAL_SETTING_SECRET_ROTATED` const, + `rotateSecret(id, request)` |
| applications | `services/globalSetting/IGlobalSettingService.ts` | + interface method |
| applications | `services/globalSetting/dto/rotateGlobalSetting.request.ts` | NEW — `password`/`newValue` (required), `expectedVersion` (optional, header-first) |
| applications | `services/globalSetting/dto/index.ts` | + barrel line |
| applications | `services/globalSetting/__tests__/globalSetting.service.rotate.test.ts` | NEW — 12 tests (gating, step-up, empty/non-secret/same-value 400, 404, OCC 412, locked-row allow, audit tag, no-plaintext, tenant fallback) |
| api | `modules/global-setting/global-setting.controller.ts` | + `POST :id/rotate` (`@HttpCode(200)`, `@Authorize(['manage','all'])`, `@RequiresIfMatch()`, `@ExpectedVersion()`, Swagger 200/400/401/403/404/412/428) |
| api | `modules/global-setting/__tests__/global-setting.controller.rotate.test.ts` | NEW — 5 tests (delegation, header-over-body OCC, masked response, manage:all metadata, requiresIfMatch metadata) |
| admin-console | `features/settings/api/types.ts` | + `RotateGlobalSettingRequest` |
| admin-console | `features/settings/api/client.ts` | + `rotateGlobalSetting(id, body, etag)` — POST with If-Match + `expectedVersion` from the read ETag |
| admin-console | `features/settings/api/hooks.ts` | + `useRotateGlobalSetting` (invalidates settings keys; response is masked, so caching-by-invalidation is safe — the reveal not-cached rule is preserved) |
| admin-console | `features/settings/api/__tests__/settings-api-rotate.test.ts` | NEW — client contract test |
| admin-console | `features/settings/components/setting-drawer.tsx` | Guided-replace Rotate RETIRED: new `RotateSecretDialog` (new value + password, in-dialog `role="alert"` errors per the break-glass style, success toast, Spinner pending state); `SecretValuePane` keeps the write-only PATCH replace field but loses the focus-rotate plumbing |
| admin-console | `features/settings/components/__tests__/setting-drawer.test.tsx` | Rotate tests rewritten against the endpoint (POST body + If-Match, in-dialog 401 error, permission gating now asserts Rotate hidden too) |
| admin-console | `tests/e2e/settings-rotate.spec.ts` | NEW — happy path (dialog → toast → v2 → no plaintext) + wrong-password in-dialog rejection; fixture secret created/cleaned through the BFF (skip-gated on the stack) |

### Evidence (2026-07-08)

- `pnpm --filter @arcaai/applications build` — clean; `pnpm --filter @arcaai/applications test` — **5874 tests passed, 4 skipped** (incl. the 12 new rotate tests; watched RED first: 11 failed with `rotateSecret is not a function`, then 3 RED again for the 500→400 exception fix).
- `pnpm build:api` — `Tasks: 8 successful, 8 total`; controller suite **2 files / 15 tests passed** (rotate tests watched RED first: 5 failed). `eslint src/modules/global-setting/` — 0 problems.
- `pnpm --filter @arcaai/admin-console lint` — clean (`--max-warnings 0`); settings feature suite **5 files / 30 tests passed** (rotate drawer tests watched RED first). Full app suite: 796 passed; 6 failures confined to `departments`/`storage-browser` — other in-flight working-tree changes, untouched by this ticket. `check-types`: 12 pre-existing errors, all in rbac/detail-drawer test files (parallel TASK work), none in settings/rotate files.
- **Live gateway smoke** (dev stack, curl against `POST /api/v1/admin/settings/:id/rotate`): create secret → read ETag `"1"` → missing If-Match **428** → wrong password **401** → rotate **200** (`value: ''`, `version: 2`, fresh `ETag: "2"`, no plaintext in body) → stale If-Match **412** → reveal returns the NEW value (old invalidated) → audit row tagged `GLOBAL_SETTING_SECRET_ROTATED` with no plaintext → non-secret target **400** (after the BadRequestException fix; initially 500 — caught by this smoke). (Full browser e2e is skip-gated; the console login flow was intermittently broken by concurrent in-flight edits during verification — the pre-existing `auth-smoke.spec.ts` failed identically.)

### Deferred

- Envelope re-wrap under a fresh Transit `keyVersion` — blocked on the Phase 4C encryption-write wiring (TASK-302); `rotateSecret` is annotated as the insertion point.
- Axe/theme pass on the rotate dialog rides the standard settings-screen a11y e2e (`settings.spec.ts`, owned by TASK-443's train slot); the dialog reuses the exact reveal/break-glass primitives already covered.

## Change History

| Date | Change |
|---|---|
| 2026-07-08 | **Implemented full-stack (TDD)** — applications `rotateSecret` (+`RotateGlobalSettingRequest` DTO, `GLOBAL_SETTING_SECRET_ROTATED` audit tag), gateway `POST /admin/settings/:id/rotate` (`manage:all` + step-up + `@RequiresIfMatch()`/`@ExpectedVersion()` OCC, masked response), admin-console `rotateGlobalSetting` client/`useRotateGlobalSetting` hook + `RotateSecretDialog` replacing the guided-replace affordance, new `settings-rotate.spec.ts` e2e. Open-items resolved: rotation = atomic replace-with-new-value (envelope re-wrap deferred to Phase 4C), OCC required in addition to step-up, response = masked setting + fresh ETag. Live-smoke fix: rotate's client-input guards use NestJS `BadRequestException` (the interceptor renders `ArgumentInvalidException` as 500). All layer gates green — see Implementation Summary. Status → Review. |
| 2026-07-08 | Ticket created as follow-up from TASK-439; the guided-replace Rotate is replaced with a real server-side endpoint scoped here full-stack. Current-state map captured: mirror the audited GLOBAL-ADMIN `reveal` endpoint (`POST :id/reveal`) for gating + audit and the OCC `update` path for the write; api-key `rotateKey` is the in-repo precedent; audit reuses `ResourceUpdated` + a new `GLOBAL_SETTING_SECRET_ROTATED` action tag (no `SecretRotated` enum). **Notable finding:** settings encryption-at-rest is scaffolded but UNWIRED (`encryptValueIntoEntity` never called in prod; secrets stored as plaintext `value`), so rotation is framed as an atomic, audited, gated **replace-with-new-value** rather than a server-side regenerate; a pure envelope re-wrap variant would depend on the Phase 4C encryption-write wiring. Status: Pending (awaiting plan approval). |
</content>
