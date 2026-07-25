# TASK-496 — Per-Tenant TTS Configuration (DB-backed, runtime-resolved)

| | |
|---|---|
| **Status** | `Review` — all 7 phases ✅ (DB, Domain, App service, Admin API, Runtime injection, BYO creds, Docs). Env-gated only: live-DB integration/e2e, Vault-live BYO round-trip, browser-WS + running-tts end-to-end. Uncommitted on `fix/2605-review`. |
| **Type** | `feature` — full-stack (DB → domain → application → API gateway → tts) |
| **Created** | 2026-07-11 |
| **Parent** | [TASK-488](../TASK-488-Realtime-TTS-Service/README.md) — the TTS service (env-only config today) |
| **Branch (suggested)** | `feature/496-tenant-tts-config` |

## 1. Requirement Analysis

Tenant admins must be able to configure their tenant's TTS "specs", stored in Postgres and applied at runtime. Today `apps/tts` is stateless and reads a single, process-wide config from env (`pydantic-settings`); nothing is per-tenant and the service has no DB access (HOPE keeps Postgres behind the `apps/api` gateway).

**Decisions (owner, 2026-07-11):**
- **D1 — Credential scope: platform-global creds + per-tenant BYO keys.** Tenants configure a curated spec; a tenant MAY additionally supply its own Azure/Sarvam API key + endpoint, **encrypted at rest via Vault** (the `GlobalSetting.encryptedValue` pattern). Secrets are never returned by read APIs and never logged.
- **D2 — Runtime delivery: gateway resolves + injects.** `apps/api` resolves the tenant's effective config from DB and injects resolved parameters into each tts request. **tts stays stateless** (no DB), honoring per-request overrides. Mirrors the SMR proxy's `applySmrModelSelection`.
- **D3 — Granularity: per-tenant row + SYSTEM default.** One config row per tenant, layered over a SYSTEM-tenant (`00000000-…`) platform-default row (2-layer precedence, like `TenantFrontendConfig` / `EntitlementsService`). No department/doctor cascade.

**Tenant-editable spec (curated, clamped to platform limits):**
- default voice per locale (`en`, `ml`) — internal catalog voice ids
- per-locale routing preference (ordered provider chain), and an allowed-provider whitelist
- default output format (`pcm|wav|mp3`), default speed, default sample rate, max input chars
- `sarvamPublicApiAllowed` PHI-safety toggle (the public Sarvam API is not PHI-safe — TASK-493 §5)
- (BYO) per-provider API key + endpoint, encrypted

**NOT tenant-editable (stay platform/env/Vault):** host/port/log/CORS, the shared service token, which providers are physically provisioned + their model paths / GPU device, and the platform ceilings that clamp tenant values.

**Guardrail principle:** every tenant value is validated at the DTO and **clamped** in the resolver against a `PLATFORM_TTS_LIMITS` descriptor (allowed-provider universe, max-input-chars ceiling, speed range, allowed formats/sample-rates) — mirrors `PIPELINE_SETTING_DESCRIPTORS` / entitlements resolution. A tenant cannot enable a provider the platform hasn't provisioned or exceed a ceiling.

## 2. Current State Evaluation

- **tts**: `core/config.py` — `pydantic-settings`, env only, one process-wide set; static `routing_en`/`routing_ml`; `VoiceCatalog` global; `TTSRouter.synthesize/stream` resolve the chain from settings. No per-request override, no DB, no tenant context.
- **Gateway**: `speech-proxy.controller.ts` (`POST /speech/synthesize`, `GET /speech/voices`) and `tts-ws.gateway.ts` (`/ws/tts/stream`) forward verbatim with only `X-Service-Token`; **no tenant context forwarded today.**
- **Precedents to mirror**: `TenantFrontendConfig` (one typed row per tenant, `tenantId @unique` + `configJson` escape hatch); `PipelinePolicy` (tenant-scoped, `_version` OCC, WORM change log, SYSTEM default + `ConfigResolver` cascade); `EntitlementsService.resolveForTenant` + pure `resolveEntitlements` (default matrix → DB → override, `null` = inherit); `GlobalSetting.encryptedValue`/`keyVersion` + `SecretsService`/Vault Transit for encrypted-secret-in-DB; the SMR proxy `applySmrModelSelection` for resolve-and-inject; `pipeline-policy-admin.controller.ts` for the tenant-scoped admin surface (route `admin/…`, `@Authorize(['manage', …])`, `@RequiresIfMatch()`+`@ExpectedVersion()` OCC, `resolveTenantId()` pinning tenant admins to CLS + super-admin `?tenantId=`).
- Internal callback precedent (if ever needed): `harness-service-token.guard.ts` (`X-Service-Token`, constant-time). Not needed for D2 (inject), but noted.

## 3. Design

### 3.1 Data model (new — `packages/database/src/prisma/db_main/tenant-tts-config.prisma`)

`TenantTtsConfig` — one row per tenant (`@@unique([tenantId])`), SYSTEM tenant row = platform default. Standard field template (`_metadata`, `_version`, `id uuid(7)`, `tenantId`, resource-status, audit). Business columns (all nullable = "inherit from SYSTEM default / code default"):
- `defaultVoiceEn String?`, `defaultVoiceMl String?`
- `routingEn String[]`, `routingMl String[]`, `allowedProviders String[]`
- `defaultFormat String?` (validated `pcm|wav|mp3`), `defaultSpeed Float?`, `sampleRate Int?`, `maxInputChars Int?`
- `sarvamPublicApiAllowed Boolean @default(false)`
- `configJson Json?` (forward-compat escape hatch, mirrors `TenantFrontendConfig`)

`TenantTtsProviderCredential` (BYO, D1) — `@@unique([tenantId, provider])`, standard template + `provider String` (`azure|sarvam`), `endpoint String?`, `encryptedApiKey Bytes?`, `keyVersion Int?`, `enabled Boolean @default(false)`. Ciphertext only (Vault Transit); plaintext never stored.

Allow-lists: add both to `TENANT_SCOPED_MODELS` (`extensions/tenant-scope.ts`); add **only** `TenantTtsConfig` to `SYSTEM_SHARED_READ_MODELS` (SYSTEM default readable cross-tenant; credentials are never shared). Both keep `resourceStatus` (soft-delete applies — not added to `MODELS_WITHOUT_SOFT_DELETE`).

### 3.2 Resolved-config contract (gateway → tts)

`resolveForTenant(tenantId)` → effective spec = SYSTEM-default row merged under the tenant row, clamped to `PLATFORM_TTS_LIMITS`. Injected per request:
```
{ routing: {en:[…], ml:[…]}, allowedProviders:[…],
  defaults: { voiceEn, voiceMl, format, speed, sampleRate, maxInputChars },
  providerOverrides: { azure?: {apiKey, region}, sarvam?: {apiKey, baseUrl} } }  // BYO, decrypted, Phase 6
```
- Batch (`POST /speech/synthesize`): fill omitted `voice`/`format`/`speed`/`sample_rate` from `defaults`; always pass `routing`/`allowed_providers` (+ `provider_overrides` when BYO set).
- WS (`/ws/tts/stream`): the gateway resolves at handshake and passes the resolved spec to tts via upstream handshake headers (`X-Tts-Routing`, …) / an injected first control frame; the browser's `init` still chooses the voice.

### 3.3 tts (stateless per-request overrides)

- `SpeechRequest` + WS `init` gain optional `routing: list[str]`, `allowed_providers: list[str]`, and (Phase 6) `provider_overrides`.
- `TTSRouter.synthesize/stream` accept an optional `routing_override` (filtered by `allowed_providers`) used instead of `settings.routing_*`.
- (Phase 6) BYO: a small `PerTenantProviderCache` keyed by `(provider, hash(creds))` builds an `AzureSpeechProvider`/`SarvamProvider` from the injected creds (LRU + TTL); creds never logged. Local engines (no creds) unaffected.

### 3.4 API admin surface

`apps/api/src/modules/tenant-tts-config/tenant-tts-config-admin.controller.ts` — `@Controller('admin/tts-config')`, class `@Authorize()`:
- `GET ''` → effective (resolved) config; `GET 'row'` → raw row (+ `version:0` placeholder if none), `@CanRead('TenantTtsConfig')`.
- `PUT 'row'` → upsert spec, `@CanManage('TenantTtsConfig')` + `@RequiresIfMatch()` + `@ExpectedVersion()` (OCC).
- `PUT 'credentials/:provider'` → set/rotate BYO key (write-only; response masks to last-4 / presence), `DELETE 'credentials/:provider'` → remove.
- `resolveTenantId()`: tenant admins pinned to CLS tenant; `isSuperAdmin` may target `?tenantId=` (incl. the SYSTEM default). Register a `TenantTtsConfig` CASL subject.

## 4. Implementation Plan (phased, TDD)

1. **Database** — the two models + migration `<ts>_task_496_tenant_tts_config` (review SQL), allow-list edits, `pnpm db:migrate` + `db:generate`. *Verify:* migration SQL reviewed; `@arcaai/database` test.
2. **Domain** — `pnpm gen:*` trios for both models; hand-written repo helpers `findForTenant`/`findSystemDefault`/`findForTenantProvider`; register in `CoreDatabaseModule`; barrels. *Verify:* `@arcaai/domains` build+test; generator drift clean.
3. **Application (curated spec)** — `TenantTtsConfigService` (BaseService): get/upsert row, DTOs (class-validator + clamps), sys-events, tenant guards (404-cross-tenant), `resolveForTenant` (SYSTEM-merge + `PLATFORM_TTS_LIMITS` clamp), module/token/barrels. TDD: factory-on-create, sys-event-on-mutation, clamp, inherit-from-SYSTEM, cross-tenant 404. *Verify:* `@arcaai/applications` build+test.
4. **API admin controller** — routes above + `TenantTtsConfig` CASL subject; unit tests (guards/OCC) + cross-tenant e2e (mirror `task-307-*-cross-tenant.spec.ts`). *Verify:* `build:api`, `test:unit`, `test:e2e`.
5. **Runtime injection (curated spec)** — resolve + inject in `speech-proxy.controller.ts` and `tts-ws.gateway.ts`; tts `SpeechRequest`/WS `init` + `TTSRouter` honor `routing`/`allowed_providers`. Tests both sides. *Verify:* `build:api`; `py:tts:test`.
6. **BYO credentials (encrypted)** — credential DTOs + Vault-Transit encrypt/decrypt (via `SecretsService`, mirror `GlobalSetting`/`PipelinePolicyChange.encryption`); credential routes (write-only/masked); gateway injects decrypted `provider_overrides`; tts `PerTenantProviderCache` builds per-tenant Azure/Sarvam providers. Tests (encrypt round-trip, masked reads, per-tenant provider build, never-logged). *Verify:* applications + api + `py:tts:test`.
7. **Docs** — ticket §Implementation Summary + evidence; touch rules 02/03/04/05/06 as needed; memory. *Verify:* lint clean across touched packages.

**Global verification:** `pnpm lint` clean (treat `packages/*` only-warn as errors); every phase's gate green with pasted evidence before the next.

## 5. Risks / Notes
- **Secret handling (D1+D2):** decrypted BYO keys transit the internal gateway→tts hop per request. Mitigations: `X-Service-Token`-authed hop, TLS in prod, never log creds (PHI/secret redaction like the existing proxy), tts caches the built provider by a non-reversible cred-hash. Rotation = re-PUT the credential (bumps `keyVersion`).
- **Clamping is load-bearing:** the allowed-provider universe the resolver clamps to must stay in sync with what tts actually has provisioned; tts still rejects unknown/uncredentialed providers as a backstop (defense-in-depth, like the server-side tenant boundary).
- **WS injection** is the fiddliest surface (handshake-time resolve vs per-frame); Phase 5 pins the mechanism (handshake headers) with a test.
- **Scope guard:** the tenant-admin **UI** is out of scope (admin-console is design-gated, not yet built) — this ticket ships the DB + API + runtime path; a UI is a separate design-gated ticket.

## 6. Implementation Summary — ✅ (2026-07-11, all 7 phases)

**Data (`packages/database`)** — `tenant-tts-config.prisma`: `TenantTtsConfig` (one row/tenant, `tenantId @unique`, typed spec + `configJson`) + `TenantTtsProviderCredential` (`@@unique[tenantId,provider]`, `encryptedApiKey Bytes` + `keyVersion`, ciphertext only). Migration `20260711120000_task_496_tenant_tts_config` (2 tables + 4 indexes + `ALTER TYPE ResourceType ADD VALUE 'TenantTtsConfig'`). Allow-lists: both → `TENANT_SCOPED_MODELS`; `TenantTtsConfig` → `SYSTEM_SHARED_READ_MODELS` (creds never shared). `ResourceType.TenantTtsConfig` added to audit.prisma + domain enum (parity green).

**Domain (`packages/domains`)** — hand-authored entity/factory/mapper/repository for both models (repo helpers `findByTenantId`, `findByTenantAndProvider`), registered in `CoreDatabaseModule`, 5 barrels updated.

**Application (`packages/applications/src/services/tenant-tts-config`)** — pure `resolveEffectiveTtsConfig` (SYSTEM-default merge → clamp to `PLATFORM_TTS_LIMITS`; sarvam stripped from routing when the PHI toggle is off); `TenantTtsConfigService extends BaseService` — `getRow`/`getEffective`/`upsertRow` (factory-create + OCC compare-and-set + `ResourceCreated`/`ResourceUpdated` sys-events) + BYO credential methods (`getCredentials` masked, `setCredential`/`removeCredential`, `resolveProviderOverrides`). Vault-Transit encrypt on write / decrypt on resolve (`SecretsService`, ciphertext-as-Bytes + `keyVersion`); no Vault → credential writes reject (no plaintext-at-rest). DTOs (clamped class-validator + OCC token + write-only credential DTO), DI token + module.

**API gateway (`apps/api`)** — `TenantTtsConfigAdminController` at `/admin/tts-config`: `GET ''` (effective), `GET 'row'`, `PUT 'row'` (If-Match OCC), `GET/PUT/DELETE 'credentials/:provider'` (write-only, masked reads). `@Authorize(['read'|'manage','TenantTtsConfig'])`; tenant admins pinned to CLS, global-admins `?tenantId=`. RBAC: GLOBAL_ADMIN via `manage:all`; tenant-admin `manage TenantTtsConfig` grant added to `tenant-full-access` seed.

**Runtime injection (D2, stateless tts)** — `SpeechProxyController.applyTenantConfig` + `TtsWsGateway` (init-frame enrichment, tenant from the stream ticket) resolve `getEffective` + `resolveProviderOverrides` and inject `routing_en`/`routing_ml`/`allowed_providers`/defaults/`provider_overrides`. Both **fail open**. `apps/tts` `SpeechRequest` + WS `init` + `TTSRouter` (`resolve_chain`/`candidates`/`synthesize`/`stream`/`_ChainSynthesizer`) honor the overrides; BYO keys build a per-tenant provider instance (`_build_override_engine` via `config.model_copy`), cached by credential hash — a BYO key can use a provider the platform never registered.

**Evidence** (all local, non-infra):
```
@arcaai/database  tenant-scope + soft-delete       181 passed
@arcaai/domains   build + full suite              1300 passed
@arcaai/applications  build + tenant-tts-config     20 passed  (resolver + service + crypto)
apps/api          build:api                          8 tasks OK
apps/api          tenant-tts-config + speech         25 passed
apps/tts       full unit suite                   134 passed, 2 deselected
lint (eslint apps/api hard-errors) + ruff            clean
```

**Deferred (environment-gated, not code):** live-DB integration + API e2e (the dev/test DBs are `db push`-managed and behind migration history — see [[db-migrations-env-gotchas]]); Vault-live BYO encrypt/decrypt round-trip (`SECRETS_PROVIDER=vault`); browser-WS + running-tts end-to-end; a tenant-admin **UI** (separate design-gated ticket).

**Security posture (D1+D2):** decrypted BYO keys transit the internal gateway→tts hop per request — `X-Service-Token`-authed, TLS in prod, never logged (PHI-safe redaction on the existing proxy), tts caches the built provider by a non-reversible cred-hash. Rotation = re-PUT the credential.

## 7. Change History
| Date | Change | Author |
|---|---|---|
| 2026-07-11 | Plan scaffolded after codebase exploration + owner decisions D1 (BYO keys), D2 (gateway resolves+injects), D3 (per-tenant + SYSTEM default). Awaiting plan approval before code | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | **Phase 6 (BYO credentials) done:** app service `setCredential`/`removeCredential`/`getCredentials` (masked) + `resolveProviderOverrides` — Vault-Transit encrypt/decrypt via `SecretsService` (ciphertext-as-Bytes + `keyVersion`; no-Vault → reject, no plaintext-at-rest); write-only credential DTO; admin `GET/PUT/DELETE /admin/tts-config/credentials/:provider`; gateway injects decrypted `provider_overrides` (batch body + WS init); tts `_build_override_engine` (per-tenant provider via `config.model_copy`) cached by cred-hash, usable even for platform-unregistered providers. Evidence: applications **20 tests** (+crypto), api **25 tests** (+credential routes), tts **134 tests** (+per-tenant engine), `build:api` clean, eslint+ruff clean. **Phase 7 (docs):** §6 + status `Review` + memory. | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | **Phase 5 (Runtime injection) done:** **tts** stays stateless but honors per-request overrides — `TTSRouter.resolve_chain`/`candidates`/`synthesize`/`stream` accept `routing_en`/`routing_ml`/`allowed_providers`; `SpeechRequest` + `/audio/speech` endpoint + WS `/audio/stream` init frame carry them. **Gateway** resolves the caller tenant's `getEffective` and injects: `SpeechProxyController.applyTenantConfig` folds routing/whitelist + omitted format/speed into the batch body; `TtsWsGateway` pre-resolves at handshake (tenant from the stream ticket) and enriches the first `init` frame. Both **fail open** (config error → tts settings). Evidence: tts **133 tests** (+2 router override tests) + ruff clean; `build:api` clean + **16 speech tests** + eslint clean. Live browser-WS/running-tts e2e is env-gated. | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | **Phase 4 (Admin API) done:** `apps/api/src/modules/tenant-tts-config/` — `TenantTtsConfigAdminController` at `/admin/tts-config` (`GET ''` effective, `GET 'row'` raw, `PUT 'row'` upsert), `@Authorize(['read'|'manage','TenantTtsConfig'])` + `@RequiresIfMatch()` + `@ExpectedVersion()` OCC, `resolveTenantId` (tenant admin pinned to CLS; global-admin `?tenantId=`). Module registered in `app.module.ts`. RBAC: GLOBAL_ADMIN via `manage:all`; added tenant-admin `manage TenantTtsConfig` grant to `tenant-full-access` (seed `01-policy.ts`) — applies on fresh seed. `build:api` clean + **6 controller tests pass**, eslint clean. Cross-tenant e2e is env-gated (DB drift) — deferred to a live-DB run. | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | **Phase 3 (Application service) done:** `services/tenant-tts-config/` — pure `resolveEffectiveTtsConfig` (SYSTEM-default merge + clamp to `PLATFORM_TTS_LIMITS`; sarvam stripped from routing when the PHI toggle is off), `TenantTtsConfigService` (BaseService: `getRow`/`getEffective`/`upsertRow` with factory-create + OCC compare-and-set + `ResourceCreated`/`ResourceUpdated` sys-events), DTOs (clamped class-validator + OCC token), DTO mapper, DI token + module, barrel exports. **Added `ResourceType.TenantTtsConfig`** to audit.prisma + domain enum + the task-496 migration (`ALTER TYPE ADD VALUE`, applied to dev DB) so config mutations audit properly (parity test green). `@arcaai/applications` build clean + **13 tests pass**, eslint clean. | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | **Phase 2 (Domain) done:** `gen:model` scaffolded the 2 models; the entity/factory/mapper/repository layers are hand-curated (the generators reproduce committed files, they don't scaffold new ones — mapper/repository generators additionally have a **pre-existing** crash in this env, unrelated to TASK-496, reproduced with my files removed). Hand-authored `TenantTtsConfig`/`TenantTtsProviderCredential` entity+factory+mapper+repository (repo helpers `findByTenantId`/`findByTenantAndProvider`), 5 barrels updated, both repos registered in `CoreDatabaseModule`. `@arcaai/domains` build clean + **1300 tests pass**; model/entity/factory drift-gated generators reproduce my files with no diff (barrels reconciled). | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | Plan **approved**. **Phase 1 (DB) done:** `tenant-tts-config.prisma` (2 models) + migration `20260711120000_task_496_tenant_tts_config`; allow-lists (both models → `TENANT_SCOPED_MODELS`; `TenantTtsConfig` → `SYSTEM_SHARED_READ_MODELS`) + drift-guard test updated (count 45→47, SYSTEM set +TenantTtsConfig) — 181 passed. Client regenerated. **Env note:** the local dev/test DBs are `db push`-managed and behind the migration history (`migrate dev`/`db push` want a reset over pre-existing unrelated drift — fedl has no migration; TASK-490 `UserVoiceProfile.tenantId` unapplied). My migration is purely additive and was applied to the dev DB directly via `psql` (2 tables + 4 indexes, validated); the committed migration folder is correct for CI/prod (`migrate deploy`). **Integration/e2e that need an in-sync live DB are environment-gated here** — verification leans on unit tests + build (like the TTS live-Azure/browser gates). | Claude (Fable 5) + Tap Huynh |
