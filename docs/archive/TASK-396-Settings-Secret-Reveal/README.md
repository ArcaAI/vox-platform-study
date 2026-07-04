# TASK-396 — Global Settings Secret Reveal (audit-logged, super-admin, step-up)

- **Ticket**: TASK-396
- **Short name**: Settings-Secret-Reveal
- **Created**: 2026-07-02
- **Updated**: 2026-07-02
- **Status**: Completed
- **Type**: feature
- **Owner scope**: settings + auth(step-up) API modules, global-setting/auth application services, the SDK settings hook, `apps/admin/src/features/settings/**`, `task-396-*` specs, this doc.

---

## 1. Requirement Analysis

### Description
The Global Settings surface (TASK-391 / TASK-395) renders secret settings (Vault-backed
`encryptedValue`) **masked** with a **disabled "Reveal"** button, because no
reveal/decrypt endpoint exists yet (TASK-395 §3 FLAG). Build an **audit-logged,
super-admin-only, step-up (re-auth) reveal endpoint** and wire the FE so a
super-admin can transiently reveal one secret's plaintext.

### Business context
Platform operators occasionally need to read a stored secret (e.g. to confirm a
value during an incident). This must be: (a) **super-admin only**, (b) protected
by a **step-up re-auth** (a compromised/borrowed session cannot exfiltrate secrets
with one click), (c) **audit-logged** on every attempt (HIPAA §164.312(b)), and
(d) **single-item** (never a bulk export).

### Acceptance criteria
- `POST /api/v1/admin/settings/:id/reveal` returns the decrypted plaintext of ONE
  setting's value. **Super-admin only** (CASL `manage all`). Never bulk.
- The call requires a **step-up re-auth**: the caller's current password, verified
  server-side against the stored bcrypt hash.
- Every reveal writes an **audit / SysEvent** entry (actor, setting id + key,
  timestamp). The **plaintext is NEVER logged** and never appears in the audit row.
- Decryption uses the **same crypto the app uses to write `encryptedValue`** (the
  `GlobalSettingRepository` encrypt/decrypt pair via `SecretsService`).
- SDK: `useGlobalSettings().revealSecret(id, { password })`.
- FE: the Reveal affordance is **enabled** for secret rows; clicking prompts a
  password re-entry modal, calls reveal, and shows the plaintext **transiently**
  (hide / re-mask + copy), never persisted. The `locked` affordance is kept and the
  TASK-394 `requireSuperAdmin` route guard is **not** altered.

---

## 2. Current State Evaluation

### Backend
- `apps/api/src/modules/global-setting/global-setting.controller.ts` — `@Controller('admin/settings')`,
  class-level `@CanManage('GlobalSetting')` (super-admin **and** tenant admins).
  CRUD only; no reveal route.
- `packages/applications/src/services/globalSetting/globalSetting.service.ts` —
  CRUD over `GlobalSettingRepository`; broadcasts `SysEvent`s via `broadcastSysEvent`.
  **It does not encrypt/decrypt** `encryptedValue`.
- **Encrypt/decrypt path** (the canonical one): `GlobalSettingRepository.encryptValueIntoEntity` /
  `decryptValueFromEntity` / `findByIdWithDecryptedValue` (declaration-merged in
  `…/repositories/generated/core/GlobalSettingRepository.encryption.ts`), which call
  `SecretsService.encrypt/decrypt` (Vault Transit). `decryptValueFromEntity` **falls
  back to `entity.value`** (legacy plaintext) when `encryptedValue` is null.
- **Super-admin-only gate** prior art: `EntitlementsAdminController` /
  `RateLimitAdminController` use `@Authorize(['manage','all'])` — granted ONLY by the
  `system-full-access` policy, never to tenant admins. The `UnifiedAuthGuard` resolves
  method-level permission metadata via `getAllAndOverride([handler, class])`, so a
  method-level `@Authorize(['manage','all'])` **overrides** the class `@CanManage`.
- **No step-up / re-auth mechanism exists** in `apps/api/src/modules/auth/**` (login,
  logout, me, refresh, impersonate, stream-ticket, revoke-impersonation only). Login
  verifies the password with `bcrypt.compare` (== `ICryptoService.verify`, bcrypt).
- **Audit**: services call `broadcastSysEvent(SysEventType.*)` (→ SysEventService →
  Redis queue → AuditLog). `AuditLogService.recordSystemAction` also exists for
  synchronous privileged-action rows.

### Secrets provider / test stack reality (drives the design)
- The shared TEST stack runs `dev:api:test` (loads `.env.test`): **`SECRETS_PROVIDER` is
  unset ⇒ env mode (no Vault)**; `RATE_LIMIT_ENABLED=false`; entitlements default is
  `false` (`ENTITLEMENTS_GLOBAL_ENABLED_DEFAULT`).
- In env mode `SecretsService.encrypt/decrypt` throw (Vault-only). So the app **never
  populates `encryptedValue`** at runtime (the writer is Vault-only and is only invoked
  in unit tests), and the seed has **no** secret rows. `decryptValueFromEntity` therefore
  returns `entity.value` (the plaintext), which is exactly the "reveal" payload.
- The current `GlobalSettingResponse` **does not expose any secret marker**, so the FE
  helper `isSecretSetting` (which checks `encryptedValue`) is currently never true —
  the masked/Reveal affordance is effectively unreachable end to end.

### Frontend
- `apps/admin/src/features/settings/sectioned-settings.tsx` renders secret rows masked
  with a **disabled** Reveal button; `global-settings.ts#isSecretSetting` gates it.
- `apps/admin/src/routes/_authenticated/settings.tsx` — `beforeLoad: requireSuperAdmin`
  (TASK-394 guard — must NOT change).

### SDK
- `packages/agentic-sdk-v2/src/hooks/useGlobalSettings.ts` (+ `types/settings.ts`,
  `core/constants.ts#GLOBAL_SETTINGS_ENDPOINTS`).

---

## 3. Design Decisions (choices + rationale)

### D1 — Step-up mechanism: **password in the reveal call** (server-verified)
No re-auth mechanism exists in the auth module. The **simplest robust** option that
fits is to carry the caller's current password in the reveal request and verify it
server-side against the stored bcrypt hash (`ICryptoService.verify`, the same primitive
used at login). Rationale:
- No new auth endpoint, no short-lived-token issuance/verification/storage, no extra
  round-trip. One sensitive action ⇒ one gated call.
- Password travels over TLS, is **never logged**, and is **never persisted**.
- A short-lived step-up token (`POST /auth/step-up`) was considered and is documented as
  the future upgrade path if reveal frequency grows; it adds moving parts without extra
  security for a single action, so it is intentionally out of scope here.
- Impersonated sessions cannot reveal: super-admin targets can never be impersonated, so
  an impersonated session is never super-admin and is rejected by the `manage all` gate.

### D2 — Decrypt via the canonical repository path
Reveal calls `GlobalSettingRepository.decryptValueFromEntity(entity, secretsService)` —
the **same** helper that mirrors the `encryptValueIntoEntity` writer. In Vault mode it
Transit-decrypts `encryptedValue`; in env mode (no `encryptedValue`) it returns
`entity.value`. This is faithful to "the same crypto the app uses to write
`encryptedValue`" and degrades correctly across providers.

### D3 — Secret detection + masking is **server-authoritative** (`isSecret`)
To make the feature reachable end to end (the response carried no secret marker), add
`isSecret: boolean` to `GlobalSettingResponse`, computed in the DTO mapper as:
`encryptedValue != null` **OR** a narrow **key/namespace convention**
(`namespace === 'secrets'`, or a key containing `secret|password|token|credential|api-key|apikey|private-key`).
When `isSecret`, the mapper **masks `value` → `''`** in list/get responses (plaintext is
only ever returned by the gated reveal). The convention matches **no seeded key**, so
existing rows are unaffected (zero behavior change for current data); it also lets the
env-mode live E2E create a demonstrable secret row without Vault or a seed change. The
FE `isSecretSetting` prefers the server `isSecret` marker (falls back to `encryptedValue`).

### D4 — Audit via a **direct `ResourceViewed` emit** (`forceAuditLog` + resource-tenant) + no plaintext
Reveal emits `SysEventType.ResourceViewed` with `data: { action:
'GLOBAL_SETTING_SECRET_REVEALED', key, namespace, revealedAt }`, actor
(`responsibleEntityId`), correlation id, and `resourceId`. **The plaintext is never
included.** Two constraints made the usual `broadcastSysEvent` helper unsuitable, so the
service emits directly on `EventEmitter2`:

1. **`forceAuditLog: true`** — `SysEventService.handleResourceViewedEvent` deliberately
   drops READ events from the `AuditLog` (volume control) **unless** this flag is set (the
   "sensitive/compliance read" case — a secret reveal is exactly that). `broadcastSysEvent`
   cannot set it.
2. **Tenant attribution** — reveal is SUPER-ADMIN-only and super-admins carry a **null CLS
   `tenantId`**. `broadcastSysEvent` always overwrites the event tenant with the CLS value
   (a HIPAA boundary), so the row would be `tenantId: null` and `AuditLogProcessor`
   fail-closes on a null tenant → the row is silently dropped. The direct emit attributes
   the audit to the **revealed resource's own tenant** (`entity.tenantId`, a persisted DB
   value — never caller-supplied), falling back to the CLS tenant when present. This is
   correct attribution: the row is tagged with the tenant that actually owns the secret.

Verified live: the reveal writes exactly one `AuditLog` row (action
`GLOBAL_SETTING_SECRET_REVEALED`, actor, key) and the row contains **no plaintext**.

---

## 4. Implementation Plan (TDD)

### Layer order & files
1. **Application service (settings)** — `packages/applications/src/services/globalSetting/`
   - `dto/revealGlobalSetting.request.ts` (`password`), `dto/revealGlobalSetting.response.ts`
     (`id`, `key`, `value`, `revealedAt`); export from `dto/index.ts`.
   - `IGlobalSettingService.revealSecret(id, password)`.
   - `globalSetting.service.ts`: inject `UserRepository`, `SecretsService`, `ICryptoService`;
     implement `revealSecret` (super-admin re-check → step-up verify → decrypt → audit).
   - `globalSetting.service.module.ts`: import `CryptoServiceModule` (for `ICryptoService`).
   - `globalSetting.dto.mapper.ts`: `isSecret` + mask `value`; add `isSecret` to `GlobalSettingResponse`.
2. **API controller** — `global-setting.controller.ts`: `@Post(':id/reveal')` +
   `@Authorize(['manage','all'])` (super-admin) → `service.revealSecret`.
3. **SDK** — `types/settings.ts` (`isSecret?`, `RevealSecretResult`), `core/constants.ts`
   (`REVEAL` endpoint), `hooks/useGlobalSettings.ts` (`revealSecret`); rebuild dist.
4. **FE** — `global-settings.ts#isSecretSetting` (prefer `isSecret`); `sectioned-settings.tsx`
   (enable Reveal → step-up modal → transient plaintext + copy + re-mask); pass a
   `revealSecret` callback from `settings.tsx`.

### Tests to write
- **Service unit** (`globalSetting.service.test.ts` additions): super-admin gate (non-super-admin → Forbidden),
  step-up required + wrong password → Unauthorized, correct password → returns plaintext,
  audit `broadcastSysEvent` emitted **without** plaintext.
- **Controller unit**: `revealSecret` delegates to the service; the method carries
  `@Authorize(['manage','all'])` metadata (reflected).
- **Mapper unit**: `isSecret` true for convention/`encryptedValue`; `value` masked when secret; non-secret unchanged.
- **SDK hook unit**: `revealSecret` POSTs to the reveal endpoint with the password and returns the payload.
- **FE helper unit**: `isSecretSetting` prefers `isSecret`.
- **Live Playwright** `apps/admin/e2e/task-396-*.spec.ts` (personas per `e2e/README.md`,
  `SKIP_DB_PRECHECK=true`, non-destructive): super-admin reveals with correct password;
  wrong password rejected; non-super-admin blocked. Across desktop/tablet/mobile.

### Verification
- `build:api` clean (stop `dev:api:test` first, restart after, poll `:8868/api/v1/health`→200).
- `type-check` + `build` clean for the SDK, applications, and admin.
- Leave `:8868` healthy with **entitlements enforcement OFF** and **rate-limiting OFF**.

---

## 5. Implementation Summary

### Endpoint + step-up mechanism (and why)
- **`POST /api/v1/admin/settings/:id/reveal`** returns `{ id, key, value, revealedAt }` for
  **one** setting (never bulk). Gated **super-admin-only** by a method-level
  `@Authorize(['manage','all'])` on `GlobalSettingController.reveal`, which overrides the
  class `@CanManage('GlobalSetting')` (the `UnifiedAuthGuard` resolves permission metadata
  via `getAllAndOverride([handler, class])`). `manage all` is granted only by the
  `system-full-access` policy, so tenant admins are 403.
- **Step-up = current password in the reveal body** (D1). No re-auth/recent-login primitive
  exists in the auth module, so the simplest robust fit is to carry the caller's current
  password and verify it server-side with `ICryptoService.verify` (the same bcrypt compare
  used at login). It is verified against the **caller's own** stored hash
  (`UserRepository.findById(requestUser.id)`), never logged, never persisted. A
  short-lived `POST /auth/step-up` token was considered and documented as the future
  upgrade path; it adds moving parts without extra security for a single action.

### Decryption
- Reveal calls `GlobalSettingRepository.findByIdWithDecryptedValue(id, secretsService)` —
  the canonical mirror of the `encryptValueIntoEntity` **writer**. In Vault mode it
  Transit-decrypts `encryptedValue`; in env mode (the TEST stack, no Vault) it returns the
  stored `entity.value`. Faithful to "the same crypto the app uses to write
  `encryptedValue`" and degrades correctly across providers.

### Audit (never the plaintext)
- Direct `ResourceViewed` emit with `forceAuditLog: true` and resource-tenant attribution
  (see **D4**). Verified live: one `AuditLog` row per reveal (action
  `GLOBAL_SETTING_SECRET_REVEALED`, actor id, setting key/id, timestamp), **no plaintext**.

### Server-authoritative secret detection + masking (D3)
- `GlobalSettingResponse.isSecret` (computed in `GlobalSettingDtoMapper`): true when
  `encryptedValue != null` **or** a narrow key/namespace convention matches. When secret,
  the mapper masks `value → ''` in list/get; plaintext is only ever returned by the gated
  reveal. The convention matches **no seeded key**, so existing data is unchanged; it also
  lets the env-mode live E2E exercise a real secret row (`S3_SECRET_KEY`) without Vault.

### SDK (`@arcaai/vox`)
- `useGlobalSettings().revealSecret(id, { password })` → `POST` to
  `GLOBAL_SETTINGS_ENDPOINTS.REVEAL(id)` with `{ password }`, returns `RevealSecretResult`
  (`{ id, key, value, revealedAt }`). The plaintext is **not** written into `settings`
  state (transient). `GlobalSetting.isSecret?` added. Dist rebuilt (present in `dist/*.mjs`).

### FE (`apps/admin/src/features/settings`)
- `isSecretSetting` prefers the server `isSecret` marker (falls back to `encryptedValue`).
- Secret rows render masked (`••••`, `aria-label="Secret value hidden"`) with an **enabled**
  Reveal. Reveal → `RevealSecretDialog` (step-up password re-entry) → SDK `revealSecret` →
  transient plaintext (`data-testid="revealed-secret"`) with **Copy** + **Hide (re-mask)**.
  Nothing is persisted. The TASK-394 `requireSuperAdmin` route guard is **unchanged**;
  `settings.tsx` loads with `list({ limit: 500 })` so platform secrets in any namespace are
  reachable.

### Files changed / added
**Application service** (`packages/applications/src/services/globalSetting/`):
`dto/revealGlobalSetting.request.ts` (+), `dto/revealGlobalSetting.response.ts` (+),
`dto/index.ts`, `dto/globalSetting.response.ts` (`isSecret`), `globalSetting.dto.mapper.ts`
(`isSecretEntity` + mask), `IGlobalSettingService.ts`, `globalSetting.service.ts`
(`revealSecret`: super-admin re-check → step-up verify → decrypt → audit),
`globalSetting.service.module.ts` (`CryptoServiceModule`). **API**:
`apps/api/src/modules/global-setting/global-setting.controller.ts` (`@Post(':id/reveal')`).
**SDK**: `core/constants.ts` (`REVEAL`), `types/settings.ts` (`isSecret?`,
`RevealSecretInput`, `RevealSecretResult`), `types/index.ts`, `hooks/useGlobalSettings.ts`.
**FE**: `features/settings/global-settings.ts`, `features/settings/reveal-secret-dialog.tsx`
(+), `features/settings/sectioned-settings.tsx`,
`routes/_authenticated/settings.tsx`. **Tests**:
`…/globalSetting/__tests__/globalSetting.service.test.ts`,
`…/globalSetting/__tests__/globalSetting.dto.mapper.test.ts`,
`…/services/__tests__/audit-correlation.test.ts` (constructor fix),
`apps/api/.../__tests__/global-setting.controller.test.ts`,
`packages/agentic-sdk-v2/src/hooks/__tests__/useGlobalSettings.test.ts` (revealSecret),
`apps/admin/src/features/settings/__tests__/global-settings.test.ts`,
`apps/admin/e2e/task-396-secret-reveal.spec.ts` (+).

### Verification evidence
- **`build:api`**: clean (server stopped → built → restarted; the running `:8868` build
  serves the reveal endpoint — confirmed by the live smoke below).
- **Unit tests** (fresh):
  - `@arcaai/applications` — **78 passed** (service super-admin gate; step-up required +
    wrong-password → Unauthorized; correct password → plaintext; audit emitted with
    `forceAuditLog: true` and **no plaintext**; resource-tenant fallback; mapper masking).
  - `apps/api` global-setting controller — **10 passed** (reveal delegates;
    `@Authorize(['manage','all'])` metadata reflected).
  - `@arcaai/vox` `useGlobalSettings` — **24 passed** (incl. 3 new: reveal POSTs
    `{ password }` to `REVEAL(id)`; plaintext not persisted; 401 surfaced).
  - `apps/admin` `global-settings` — **15 passed** (`isSecretSetting` prefers `isSecret`).
- **Live API smoke** (running `:8868`, `S3_SECRET_KEY`): super-admin + correct pw → **200**
  `value:"testpassword"`; super-admin + wrong pw → **401**; `arcaai_admin` → **403**.
- **FE**: `type-check` clean; `build` clean (`✓ built`, only the pre-existing chunk-size
  warning).
- **Live Playwright** `task-396-secret-reveal.spec.ts` — **9/9 passed** across
  desktop / tablet / mobile: super-admin reveals with correct pw then re-masks; wrong pw
  rejected inline (plaintext never shows); non-super-admin bounced by `requireSuperAdmin`.
- **Shared stack left healthy**: `:8868/api/v1/health` → **200**; entitlements enforcement
  **OFF** (`{"enabled":false}`); rate-limiting **OFF** (`enabled:false`, db-sourced —
  flipped off via `PUT /admin/rate-limit/enabled` as it was found ON).

## 6. Change History

- 2026-07-02 — Ticket created; plan authored (this document).
- 2026-07-02 — Feature implemented (backend endpoint, step-up, audit, decrypt), SDK
  `revealSecret`, FE reveal affordance with step-up modal + transient plaintext. Unit +
  live E2E green; `:8868` left healthy with entitlements + rate-limiting OFF. Status →
  Completed.
- 2026-07-02 — Audit hardening: switched the reveal SysEvent from `broadcastSysEvent` to a
  direct `ResourceViewed` emit with `forceAuditLog: true` and resource-tenant attribution
  (super-admins carry a null CLS tenant, which the helper would have dropped). Verified a
  single plaintext-free `AuditLog` row is written (see D4).
