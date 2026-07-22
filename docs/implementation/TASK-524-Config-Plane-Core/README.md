# TASK-524 — Config-Plane Core: Provider Connections, Runtime Profiles & the Settings Write-Lane

- **Status**: Completed (implementation) — **owner-side runtime verification outstanding**: no runtime boot, no live-DB integration/e2e run, no Vault-live round-trip, and the migration is not yet applied to the test DB (§9.8). The owner has taken these gates. Every static gate is green (§9.1).
- **Type**: feature
- **Program**: Phase 1 of [Agentic Platform Program Plan](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) (§3 AD-1/AD-2, §4 P1); findings basis [2026-07-20 review](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) (GAP-C1/C2/C5/C7, §3-E2)
- **Ticket number**: Suggested number — confirm at open time (highest allocated is TASK-523 per program plan §Numbering)
- **Size**: L · **Lanes**: A (database/domains) + B (applications/api)
- **Dependencies**: TASK-523 (P0 defect clearance) done · OD-7 (owner commits the current ~330-file tree) resolved. No other blocking owner decision — OD-1…OD-6 gate sibling tickets, not this one.
- **Closes**: GAP-C1, GAP-C2 (backend), GAP-C5, GAP-C7 (write-lane part). Service adoption of the new plane is **TASK-525**; tenant BYO endpoints + console are **TASK-526**.

---

## 1. Requirement Analysis

Owner expectations mapped (findings §0 E-list):

| Expectation | This ticket's slice | Gap IDs |
|---|---|---|
| **E2** — models/providers runtime-configurable in DB, avoid env, global-admin control | The two missing registries (`AiProviderConnection`, `AiRuntimeProfile`) + the single settings write-lane so registered keys are actually writable at runtime | GAP-C1, C2, C5, C7 |
| **E5** — cloud providers: endpoint+key configurable by global (and later tenant) admins; hyperparameters/context/concurrency global-admin-only | SYSTEM-scope connection rows + global-only runtime profiles; the tenant BYO **lane rules** are encoded now (service-layer 403 for self-host providers), tenant **endpoints** land in TASK-526 | GAP-C1, C2 |
| **E2 residue** — two parallel settings mechanisms, orphaned keys, dead clamp | Effective-facade DB-override lane; boot-time kill-switch guard; registration of `rate-limit.enabled`, `audit-retention.*`, `agentic.trajectory.*`; first production caller of `assertWithinMaxScope` | GAP-C5, C7; D-19, D-21 |

In scope: (a) `AiProviderConnection` + `AiRuntimeProfile` tables → domain trios → application services → admin controllers with OCC; (b) `GET/PUT admin/settings/registry/:key` write-lane with descriptor-driven enforcement; (c) gateway injection of resolved profile params alongside `{provider, model}`; (d) SYSTEM seed rows + seed-test updates.

Out of scope (explicitly): Python service consumption of connections/profiles/effective-config (**TASK-525**); tenant BYO credential endpoints, gateway BYO override injection, and any console screen (**TASK-526**); S3 model sources (**TASK-527**); retention keys `models.retention.*` (**TASK-529**, which uses the write-lane built here); `agentic.context.*` live consumption (**TASK-533-B**).

## 2. Current State Evaluation (code-verified 2026-07-20; the uncommitted working tree IS the state)

**What exists (build on, do not re-invent):**

- `AiModel` registry — `packages/database/src/prisma/db_main/stt.prisma:101-168`: house template fields, `provider String?` (`:130`), `localPath`/`checksum`/`downloadStatus` (`:137-142`), `@@unique([tenantId, slug])` (`:159`). Provider vocabulary `AI_MODEL_PROVIDERS` (8 values incl. `vllm`, `llama-cpp`) at `packages/database/src/prisma/db_main/seed/ai-models/shared.ts:73-85` — a validated string column, deliberately NOT a Prisma enum.
- `AiTaskDefault` — `packages/database/src/prisma/db_main/ai-task-default.prisma:17-47`; cascade tenant → SYSTEM → env in `AiTaskDefaultService.getEffective`; global-admin write guard at `packages/applications/src/services/ai-task-default/ai-task-default.service.ts:98-100` (`GLOBAL_ADMIN_ONLY_TASK_PREFIXES` from `constants.ts:64`, all four prefixes). **Note**: the schema comment `ai-task-default.prisma:12-14` and seed comment `seed/16-ai-task-default.ts:22` still carry the stale "nlp.* tenant-editable" text (D-16 — fixed by TASK-523; verify before extending, do not re-introduce).
- The BYO exemplar — `TenantTtsProviderCredential` (`tenant-tts-config.prisma:62-94`): `encryptedApiKey Bytes?` + `keyVersion`, `@@unique([tenantId, provider])`; encrypted via `encryptSecretField` (`packages/applications/src/services/tenant-tts-config/tenant-tts-config.service.ts:355`), masked read DTO `TtsCredentialResponse` exposing only `hasKey!: boolean` (`dto/tts-credential.response.ts:14-15` — "NEVER carries the key", `:3`); gateway-only decrypt fail-open per credential (`tenant-tts-config.service.ts:402-416`).
- Secret util — `packages/applications/src/services/baseServices/_meta/secrets/secret-field.util.ts:1-74`; header (`:5`) still says "TenantTtsProviderCredential today, future SSO/SMTP/webhook secrets" — gains this ticket as a consumer.
- Settings registry — `packages/applications/src/services/settings-registry/`: descriptor vocabulary (`registry.types.ts:41-65`, incl. `globalOnly`, `editableBy`, `maxScope`, `killSwitch`); `SettingsRegistry.assertWithinMaxScope` (`settings-registry.ts:78-83`) — **zero production callers** (grep-verified; pipeline-policy re-implements the clamp by hand); `killSwitches()` invariant (`settings-registry.ts:63-70`) runs **only in unit tests**, no boot path calls it; assembled catalog `registry.ts:16-24` (26 keys / 5 descriptor files); barrel `index.ts:8-11` omits `agentic-context.descriptors` (D-21 — TASK-523 fixes; this ticket depends on the export).
- Effective facade — `effective-settings.service.ts:39-71`: resolves `pipeline.*` (ConfigResolver) and `models.*` (AiTaskDefaultService); `agentic.context.*` returns `descriptor.default` with the literal comment "A global override lane … lands here later" (`:63-65`); everything else throws 400 (`:70`). **There is no write route for any registry key anywhere in `apps/api`** — the only settings writes are the pre-TASK-504 `GlobalSettingController` row CRUD (`apps/api/src/modules/global-setting/global-setting.controller.ts:46`, class-level `manage:GlobalSetting`, `:id/reveal` + `:id/rotate` step-up routes).
- Catalog read surface — `apps/api/src/modules/settings-catalog/settings-catalog.controller.ts:24-79`: mounted at `admin/settings`, static segments (`catalog`, `effective`) win over the global-setting `:id` param route because `SettingsCatalogModule` registers first (`:18-20` route note) — the new `registry/:key` routes ride the same mechanism.
- Orphaned keys (to register): `rate-limit.enabled` — `RATE_LIMIT_GLOBAL_ENABLED_DEFAULT = true` (`packages/applications/src/services/rate-limit/rate-limit.constants.ts:48` — **default-ON**, opposite polarity to the registry kill-switch rule); `audit-retention.*` (`services/audit-retention/audit-retention.service.ts`); `agentic.trajectory.enabled/cron/retentionDays` (`services/agent-trajectory-retention/agent-trajectory-retention.service.ts:38-40,68-77`, read via `IAppSettingsService.getValueWithDefault`).
- Gateway injection points: `SmrProxyController.applySmrModelSelection` (`apps/api/src/modules/streaming/smr-proxy.controller.ts:170-178`) sets `target.provider`/`target.model` from `harnessPolicyService.resolveSmrSelection(tenantId)`; `AiInferenceController` injects `model_name` from `AiTaskDefault.sourceUri` fail-closed (`apps/api/src/modules/ai-inference/ai-inference.controller.ts:68,84-90,135-155`). **Neither injects any hyperparameter today.**
- Allow-lists: `TENANT_SCOPED_MODELS` (`packages/database/src/extensions/tenant-scope.ts:55-159`), `SYSTEM_SHARED_READ_MODELS` (`:203-229`), `MODELS_WITHOUT_SOFT_DELETE` (`packages/database/src/client.ts:102`).
- Exemplars: Department trio (`packages/domains/src/{entities,factories,mappers,models,repositories}/generated/core/Department*`); hand-authored trio precedent `AiTaskDefaultRepository.ts` / `TenantTtsProviderCredentialRepository.ts` (same folder); OCC controller chain `apps/api/src/modules/department/department.controller.ts:126-157` (`@RequiresIfMatch()` + `@ExpectedVersion()` → `updateWithVersion`).
- Seed-count precedent: `packages/database/src/prisma/db_main/seed/__tests__/ai-model-consolidation-seed.test.ts:225-240` (locks catalog length 37, SYSTEM ownership, slug uniqueness) — seed changes MUST update these in the same MR.

**The quantified gap this ticket opens the door on** (findings §3-E2, verbatim): across the six Python services, **517 pydantic config fields; 307 are model/provider/hyperparameter/endpoint/credential/retention-related; only 40 (13 %) have a functioning DB override; 19 more (6 %) are gateway-injected per-request; 248 are env-only. SMR has zero override mechanism of any kind — all 55 of its non-infra fields are env-only.** No `TenantLlmProviderConfig`-class model exists (exhaustive negative search); `encryptSecretField` has exactly one consumer (TTS).

## 3. Architecture, Patterns & Best Practices

### 3.1 Final Prisma schemas (AD-2 refined to the house template of rule 02)

NEW file `packages/database/src/prisma/db_main/ai-provider-connection.prisma`:

```prisma
// ============================================================================
// AI Provider Connections (TASK-524 — config-plane core, GAP-C1)
//
// WHERE a serving provider lives and HOW to authenticate. One row per
// (tenant, provider); the reserved SYSTEM tenant row is the platform default.
// Generalizes TenantTtsProviderCredential (TASK-496) to all LLM providers.
// `provider` is a validated string (AI_MODEL_PROVIDERS — no Prisma enum, per
// the AiModel.provider convention). Tenant rows are allowed ONLY for cloud API
// providers (azure, bedrock — service-layer 403 otherwise, mirroring
// GLOBAL_ADMIN_ONLY_TASK_PREFIXES); self-host engines are SYSTEM-only.
// `encryptedApiKey` is Vault-Transit ciphertext via secret-field.util —
// NEVER returned by any read DTO (hasKey boolean only).
// Resolution: tenant row (enabled) → SYSTEM row → service env fallback.
// ============================================================================

model AiProviderConnection {
  // meta fields
  metaData Json?  @map("_metadata") @db.JsonB
  version  Int    @default(1) @map("_version")
  id       String @id @default(uuid(7))

  // multi tenant fields (SYSTEM row = platform default; tenant row = BYO cloud)
  tenantId String

  // core fields
  provider        String // ollama | lm-studio | azure | bedrock | built-in | sarvam | vllm | llama-cpp
  baseUrl         String? // ollama/lm-studio/vllm/llama-cpp/azure endpoint
  region          String? // bedrock
  apiVersion      String? // azure
  deploymentName  String? // azure (absorbs the GlobalSetting 'smr-azure-deployment' key — migrated in TASK-525)
  encryptedApiKey Bytes? // Vault-Transit ciphertext (secret-field.util); plaintext never stored
  keyVersion      Int?
  enabled         Boolean @default(false)
  extraJson       Json?   @db.JsonB // provider-specific extras (validated per-provider in the DTO)

  // resource status fields
  resourceStatus          ResourceStatusType @default(ENABLED)
  resourceStatusUpdatedAt DateTime?
  resourceStatusUpdatedBy String?

  // audit fields
  createdBy String?  @default("60000000-0000-0000-0000-000000000000")
  updatedBy String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // indexing — one connection per (tenant, provider)
  @@unique([tenantId, provider], name: "AiProviderConnection_tenant_provider_unique")
  @@index([tenantId], name: "AiProviderConnection_tenantId_idx")
  @@index([provider], name: "AiProviderConnection_provider_idx")
  @@schema("core")
}
```

NEW file `packages/database/src/prisma/db_main/ai-runtime-profile.prisma`:

```prisma
// ============================================================================
// AI Runtime Profiles (TASK-524 — config-plane core, GAP-C2)
//
// Hyperparameters / context / concurrency per provider (modelSlug = "") or per
// model (modelSlug = AiModel.slug — no FK, house slug-reference convention).
// GLOBAL-ADMIN-ONLY and SYSTEM-tenant-only in this program (E5: "hyperparameters
// global-admin-only"); tenantId is kept for the house template + forward compat.
// `modelSlug` uses the EMPTY-STRING sentinel for "provider-level default"
// (NOT null): Postgres treats NULLs as distinct in unique indexes, which would
// allow duplicate provider-default rows and break compound-unique upserts.
// Cascade at injection time: explicit request params → AiTaskDefault.configJson
// → profile(modelSlug) → profile(provider default, "") → service env default.
// All numeric fields nullable = "no opinion, fall through the cascade".
// ============================================================================

model AiRuntimeProfile {
  // meta fields
  metaData Json?  @map("_metadata") @db.JsonB
  version  Int    @default(1) @map("_version")
  id       String @id @default(uuid(7))

  // multi tenant fields (SYSTEM-only rows in this program — service-enforced)
  tenantId String

  // core fields
  provider         String
  modelSlug        String @default("") // "" = provider-level default; else AiModel.slug
  temperature      Float?
  topP             Float?
  maxTokens        Int?
  contextLength    Int? // n_ctx for GGUF engines; request ctx budget for API engines
  maxConcurrent    Int?
  tpmLimit         Int?
  rpmLimit         Int?
  timeoutS         Int?
  keepAliveSeconds Int? // retention hint forwarded to server-managed engines (AD-4 / TASK-529)
  extraJson        Json?  @db.JsonB // engine-specific (n_threads, n_gpu_layers, num_predict, …)

  // resource status fields
  resourceStatus          ResourceStatusType @default(ENABLED)
  resourceStatusUpdatedAt DateTime?
  resourceStatusUpdatedBy String?

  // audit fields
  createdBy String?  @default("60000000-0000-0000-0000-000000000000")
  updatedBy String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // indexing — one profile per (tenant, provider, modelSlug)
  @@unique([tenantId, provider, modelSlug], name: "AiRuntimeProfile_tenant_provider_model_unique")
  @@index([tenantId], name: "AiRuntimeProfile_tenantId_idx")
  @@index([provider], name: "AiRuntimeProfile_provider_idx")
  @@schema("core")
}
```

Design decisions and WHY:

| Decision | Rationale |
|---|---|
| `provider` as validated string, not enum | Matches `AiModel.provider` (`stt.prisma:130`) and `HarnessPolicy.smrProvider`; new engines (the `vllm`/`llama-cpp` addition) needed no migration. DTOs validate with `@IsIn(AI_MODEL_PROVIDERS)` (`seed/ai-models/shared.ts:70-72` documents exactly this contract). |
| `modelSlug` empty-string sentinel | Postgres `NULLS DISTINCT` default breaks the "one provider-default row" invariant and Prisma compound-unique `upsert` cannot target a NULL member. Sentinel keeps the invariant in the DB, portable, no hand-edited index SQL. |
| Secrets: `encryptedApiKey Bytes` + `keyVersion`, `encryptSecretField` only | Exact `TenantTtsProviderCredential` shape (`tenant-tts-config.prisma:75-76`); one audited crypto path (`secret-field.util.ts:5-8`); no plaintext-at-rest fallback (write rejected when Vault absent, per `tenant-tts-config.service.ts:351-352`). Read DTOs expose `hasKey: boolean` only (`tts-credential.response.ts:14-15` precedent). No reveal route for provider keys (program risk table: "Configured/None only"). |
| Tenant-lane rule in the service, 403 not 404 | Rejecting a tenant row for `ollama` is a **privilege boundary** on the caller's own tenant, not a cross-tenant probe — same reasoning as `GLOBAL_ADMIN_ONLY_TASK_PREFIXES` → `ForbiddenException` (`ai-task-default.service.ts:98-100`, comment at `constants.ts:55-58`). Cross-tenant by-id access stays 404 (rule 04). |
| Soft delete kept on both models | Standard admin-config rows (disable/re-enable lifecycle, audit trail); NOT added to `MODELS_WITHOUT_SOFT_DELETE`. |
| Both models → `TENANT_SCOPED_MODELS` | Non-negotiable: every `tenantId` model registers (`tenant-scope.ts:55`). |

**`SYSTEM_SHARED_READ_MODELS` membership — analysis & recommendation:**

- `AiProviderConnection`: **YES, add it.** The SYSTEM row is exactly the "platform default every tenant's resolver must read" pattern of `HarnessPolicy`/`PipelinePolicy`/`TenantTtsConfig` (`tenant-scope.ts:206-223`) — resolution (tenant row → SYSTEM row) runs under tenant CLS at request time and would otherwise return nothing. The counter-precedent (`TenantTtsProviderCredential` is deliberately NOT shared, `:221-222` "Credentials are NEVER shared") does not apply: that model has **no SYSTEM row at all** (platform TTS keys live in env/Vault), whereas here the SYSTEM row IS the catalog entry. Risk containment: the widening exposes only `[caller, SYSTEM]` reads (never another tenant's BYO row); the ciphertext is inert without gateway-side Vault-Transit decrypt; and no read DTO ever carries `encryptedApiKey`. The rejected alternative — reading SYSTEM rows via the unscoped `getPlatformAdminPrismaClient_Unscoped` — is lint-banned outside seeds/fixtures (rule 02) and bypasses soft-delete filtering. Document the secret-bearing caveat in the allow-list comment.
- `AiRuntimeProfile`: **YES, add it.** SYSTEM-only rows in this program; every tenant request resolution reads them. No secrets on the model at all.

### 3.2 Resolution cascade (frozen contract, AD-2)

```
request params (explicit)                       — caller wins, never clobbered
  → AiTaskDefault.configJson (per-task tweaks)  — exists today
    → AiRuntimeProfile (tenantId=SYSTEM, provider, modelSlug=<slug>)
      → AiRuntimeProfile (tenantId=SYSTEM, provider, modelSlug="")
        → service env/pydantic default          — bootstrap fallback (TASK-525 annotates)
```

Connections resolve independently: tenant row (enabled, cloud-only) → SYSTEM row (enabled) → service env. This ticket implements resolution + gateway injection for profiles; connection *consumption* (SMR/guardrail pulling endpoint/key) is TASK-525/526.

### 3.3 The settings write-lane (AD-1 — single enforcement point)

`GET/PUT admin/settings/registry/:key` on a new controller inside `SettingsCatalogModule` (rides the existing "static route registered before `GlobalSettingModule`'s `:id` param route" mechanism, `settings-catalog.controller.ts:18-20`). PUT flow, in order:

1. `HOPE_SETTINGS_REGISTRY.getOrThrow(key)` — unknown key → 400.
2. `descriptor.sensitivity === 'secret'` → 400 (secrets never flow through this lane — mirrors `effective-settings.service.ts:41-43`).
3. `descriptor.globalOnly && !isSuperAdmin(requestUser)` → 403 — **driven by descriptor metadata, not a hand-rolled per-surface list**.
4. `HOPE_SETTINGS_REGISTRY.assertWithinMaxScope(key, requestedScope)` — the clamp's **first production caller** (`settings-registry.ts:78-83`); scope defaults to `system` for `global-kv` keys in this ticket.
5. Tier dispatch: `global-kv` → upsert the backing `GlobalSetting` row (namespace `registry`, key = descriptor key, dataType from descriptor) through the existing repository path; every other tier → 400 `"tier '<t>' is not writable through the registry lane (yet)"` — deliberate: `db-config` writes keep their dedicated services (pipeline-policy, tts-config) until those adopt the enforcement point (TASK-532).
6. Value validation against `descriptor.dataType` (boolean/number/string/enum/json parse + range where the descriptor declares one).
7. `broadcastSysEvent(SysEventType.ResourceUpdated, …)` + `AppSettingsService.forceRefresh()` (the cache the consumers read, `IAppSettingsService`).

`EffectiveSettingsService.resolveEffective` gains the missing override lane for `global-kv` keys (including `agentic.context.*`): AppSettings/GlobalSetting value → `descriptor.default`, `sourceScope: 'global-kv' | 'code-default'` — replacing the `:63-68` stub. (Live-doc/harness *consumption* of the resolved value is TASK-533-B; this ticket makes the read surface truthful.)

**Boot-time kill-switch guard**: `EffectiveSettingsModule` (or the registry module) gains `onModuleInit` calling `HOPE_SETTINGS_REGISTRY.killSwitches()` — a default-ON kill-switch now refuses boot, not just a unit test (GAP-C5).

**Orphan-key registration** (new descriptor file `platform-ops.descriptors.ts`, all `tier: 'global-kv'`, `globalOnly: true`, `maxScope: 'system'`):
`rate-limit.enabled` (default `true`, **`killSwitch` NOT set** — it defaults ON by design as a protection-enable flag, opposite polarity to enforcement kill-switches; documented in the descriptor description so the invariant stays honest) · `audit-retention.enabled` (default `false`, `killSwitch: true`) · `audit-retention.*` knobs (mirror the service's read keys) · `agentic.trajectory.enabled` (default `false`, `killSwitch: true`), `agentic.trajectory.cron` (default `0 4 * * *`), `agentic.trajectory.retentionDays` (default `30`) — values copied from `agent-trajectory-retention.service.ts:68-77` so registration changes **zero runtime behavior** (consumers already read these keys via AppSettings; the lane only makes them cataloged + writable).

### 3.4 Gateway injection (scope item c)

- `smr-proxy.controller.ts` — `applySmrModelSelection` (`:170-178`) additionally resolves the profile cascade for the effective `{provider, model}` and attaches a `params` object (`temperature/top_p/max_tokens/timeout_s/keep_alive_seconds/context_length/extra`) to the forwarded body **only for fields the caller did not set** (caller-wins, cascade above). SMR ignores unknown body fields today — additive and inert until TASK-525 consumes them (stateless-gateway contract preserved, `apps/smr/src/smr_v2/core/config.py:1-9` docstring).
- `ai-inference.controller.ts` — NER/diagnosis calls (`:68,84`) gain the same profile resolution keyed on the resolved model's provider, injected as optional upstream fields alongside `model_name`. Fail-OPEN for profiles (missing profile ⇒ inject nothing — env defaults keep working), in contrast to the model-identity fail-closed path (`:135-155`) which is unchanged.

### 3.5 Patterns compliance (rules 02/03/04/05)

Rule 02: house field template exact-order, named indexes, migration `task_524_*`, allow-lists updated. Rule 03: `gen:model`/`gen:entity`/`gen:factory` scaffolding; **mappers + repositories hand-authored** (`gen:mapper`/`gen:repository` crash pre-existingly — follow `AiTaskDefaultRepository.ts`); repos registered in `CoreDatabaseModule` (`packages/domains/src/common/databaseServices/core/core.database.module.ts`) providers AND exports; mapper strips `version` (`FIELDS_NOT_WRITABLE`). Rule 04: `BaseService`, symbol-token DI, factory-created entities, DTO mappers, `broadcastSysEvent` on every mutation, `updateWithVersion` OCC, tenant guards, class-validator on every accepted field (global pipe is `whitelist+forbidNonWhitelisted`). Rule 05: `@CanManage`-gated admin controllers, `@RequiresIfMatch()`/`@ExpectedVersion()` chain per `department.controller.ts:126-157`, 404-over-403 for cross-tenant by-id.

## 4. Implementation Plan (layer order: database → domains → applications → api; TDD per §5 at each layer)

**Ownership manifest (exclusive)**: `packages/database/src/prisma/db_main/{ai-provider-connection.prisma,ai-runtime-profile.prisma,migrations/*task_524*,seed/17-ai-provider-connection.ts,seed/18-ai-runtime-profile.ts,seed/index.ts,seed/__tests__/task-524-*.test.ts}` · `packages/database/src/{extensions/tenant-scope.ts,client.ts}` (allow-list lines only) · `packages/domains/src/{models,entities,factories,mappers,repositories}/generated/core/AiProviderConnection*,AiRuntimeProfile*` + barrels + `core.database.module.ts` · `packages/applications/src/services/{ai-provider-connection/**,ai-runtime-profile/**,settings-registry/**}` + `services/index.ts` (append-only) + `baseServices/_meta/secrets/secret-field.util.ts` (header comment) · `apps/api/src/modules/{ai-provider-connection/**,ai-runtime-profile/**,settings-catalog/**,streaming/smr-proxy.controller.ts,ai-inference/ai-inference.controller.ts}` + `app.module.ts` (module registration).

### Step 1 — Database

| File | NEW/UPDATE | Change |
|---|---|---|
| `packages/database/src/prisma/db_main/ai-provider-connection.prisma` | NEW | §3.1 model |
| `packages/database/src/prisma/db_main/ai-runtime-profile.prisma` | NEW | §3.1 model |
| `packages/database/src/prisma/db_main/migrations/<ts>_task_524_ai_provider_connections_runtime_profiles/migration.sql` | NEW | `pnpm db:migrate:create`; review every statement; **apply locally via psql/`db push`** (dev DB is db-push-managed and behind migration history — NEVER `migrate reset`); commit schema + SQL together |
| `packages/database/src/extensions/tenant-scope.ts` | UPDATE | Add both models to `TENANT_SCOPED_MODELS` (`:55`) and `SYSTEM_SHARED_READ_MODELS` (`:203`) with the §3.1 justification comments (incl. the secret-bearing caveat on connections) |
| `packages/database/src/client.ts` | UPDATE | No change to `MODELS_WITHOUT_SOFT_DELETE` (`:102`) — assert in the drift-guard test that both models are soft-deleting |
| `packages/database/src/prisma/db_main/seed/17-ai-provider-connection.ts` | NEW | SYSTEM rows for the 8 providers: `enabled: false`, no keys, `baseUrl`/`region` placeholders derived from today's `.env.production` values **as data** (marked placeholder in `metaData`) — defaults reproduce today's env-driven behavior because disabled rows resolve to env fallback |
| `packages/database/src/prisma/db_main/seed/18-ai-runtime-profile.ts` | NEW | Empty-by-default scaffold (no SYSTEM profile rows — absence = env defaults; the §7 silent-change rule) exporting the typed seed array for tests |
| `packages/database/src/prisma/db_main/seed/index.ts` | UPDATE | Register both phases (FK order after `16-ai-task-default`) |
| `packages/database/src/prisma/db_main/seed/__tests__/config-plane-seed.test.ts` | NEW | Locks seed shape (see §5) |
| `packages/database/src/prisma/db_main/seed/__tests__/ai-model-consolidation-seed.test.ts` | UPDATE | Only if any shared constant/count drifts — update knowingly in the same MR (program §5.7 rule) |

Gate: `pnpm db:generate` → rebuild `@arcaai/database` (vitest reads dist) → `pnpm --filter @arcaai/database test`.

### Step 2 — Domains

| File | NEW/UPDATE | Change |
|---|---|---|
| `packages/domains/src/models/generated/core/{AiProviderConnectionModel,AiRuntimeProfileModel}.ts` | NEW | `pnpm gen:model` |
| `packages/domains/src/entities/generated/core/{AiProviderConnectionEntity,AiRuntimeProfileEntity}.ts` | NEW | **HAND-AUTHORED** — `gen:entity` is a barrel reconciler, it never creates files (see the correction note below). Extends `BaseTenantEntity` |
| `packages/domains/src/factories/generated/core/{AiProviderConnectionFactory,AiRuntimeProfileFactory}.ts` | NEW | **HAND-AUTHORED** — same reason |
| `packages/domains/src/mappers/generated/core/{AiProviderConnectionEntityMapper,AiRuntimeProfileEntityMapper}.ts` | NEW | **HAND-AUTHORED** — follow `AiTaskDefaultEntityMapper`; strip `version` |
| `packages/domains/src/repositories/generated/core/{AiProviderConnectionRepository,AiRuntimeProfileRepository}.ts` | NEW | **HAND-AUTHORED** — follow `AiTaskDefaultRepository` (tx dual-path + narrow `DataNotFoundException` catch) |
| `packages/database/src/prisma/db_main/audit.prisma` + `packages/domains/src/enums/generated/ResourceType.ts` | UPDATE | Add `AiProviderConnection` + `AiRuntimeProfile` to BOTH enums (+ `ALTER TYPE … ADD VALUE` in the migration) — without this every `broadcastSysEvent` fails the AuditLog INSERT and 500s the mutation |
| `packages/domains/src/common/databaseServices/core/core.database.module.ts` | UPDATE | Register both repositories in providers AND exports |
| barrels at each level | UPDATE | `gen:entity`/`gen:factory` reconcile the entity/factory barrels; hand-add the model/mapper/repo lines |

> **Correction (applied 2026-07-20 during implementation).** The original plan said `pnpm gen:entity` / `gen:factory` would scaffold these files. They do not — both are barrel RECONCILERS + schema-coverage checkers that reproduce committed files verbatim ("the committed files on disk — not the DMMF — are the source of truth"), so they never create a new artifact. Only `gen:model` scaffolds. **`gen:mapper` must never be run**: it crashes partway and its partial output STRIPS the `FIELDS_NOT_WRITABLE = ['version']` OCC guard (one run clobbered 24 mappers, stripping the guard from 18). `gen:repository` fails on a bad CLI argument. The canonical behaviour table now lives in `.claude/rules/03-domain-layer.md` §Generated Code Discipline.

Gate: `pnpm --filter @arcaai/domains build test`; the three working drift gates (`gen:model`/`gen:entity`/`gen:factory` `:check`) must report "no drift" AND "schema coverage OK" — note the coverage check DOES cover hand-authored entities/factories (it fails if a persisted column is unsurfaced), while mappers/repos have no gate, so cover them with unit tests. Rebuild `@arcaai/domains` dist.

### Step 3 — Applications

| File | NEW/UPDATE | Change |
|---|---|---|
| `packages/applications/src/services/ai-provider-connection/{IAiProviderConnectionService.ts,ai-provider-connection.service.ts,ai-provider-connection.service.module.ts,ai-provider-connection.dto.mapper.ts,dto/*,index.ts}` | NEW | Rule-04 folder pattern. Service: CRUD + `resolveConnection(provider, tenantId)` cascade; tenant-row guard (`CLOUD_BYO_PROVIDERS = ['azure','bedrock'] as const`; other providers + non-SYSTEM tenantId → `ForbiddenException`); SYSTEM-row writes require `isSuperAdmin`; `encryptSecretField` on key set; `updateWithVersion` OCC; `broadcastSysEvent` on all mutations; response DTO carries `hasKey: boolean`, never `encryptedApiKey` |
| `packages/applications/src/services/ai-runtime-profile/{IAiRuntimeProfileService.ts,ai-runtime-profile.service.ts,ai-runtime-profile.service.module.ts,ai-runtime-profile.dto.mapper.ts,dto/*,index.ts}` | NEW | Global-admin-only writes (SYSTEM tenantId enforced service-side); `resolveProfile(provider, modelSlug)` implementing the §3.2 cascade (model-override merged over provider-default, null = fall through); DTO range validation (`temperature` 0–2, `topP` 0–1, positive ints) |
| `packages/applications/src/services/settings-registry/settings-registry-write.service.ts` (+ module wiring) | NEW | The §3.3 PUT flow (descriptor-driven enforcement, tier dispatch, sys-event, cache refresh) |
| `packages/applications/src/services/settings-registry/effective-settings.service.ts` | UPDATE | `global-kv` override lane (AppSettings → default) replacing the `:63-68` agentic-context stub; header comment "override lane lands later" → done |
| `packages/applications/src/services/settings-registry/descriptors/platform-ops.descriptors.ts` | NEW | Orphan keys per §3.3 |
| `packages/applications/src/services/settings-registry/{registry.ts,index.ts}` | UPDATE | Register + export the new descriptor file; boot guard `killSwitches()` call in `effective-settings.module.ts` `onModuleInit` |
| `packages/applications/src/services/baseServices/_meta/secrets/secret-field.util.ts` | UPDATE | Header comment (`:5`): add `AiProviderConnection` to the consumer list |
| `packages/applications/src/services/index.ts` | UPDATE | Append-only barrel lines (program §7 collision rule) |

Gate: `pnpm --filter @arcaai/applications build test`.

### Step 4 — API

| File | NEW/UPDATE | Change |
|---|---|---|
| `apps/api/src/modules/ai-provider-connection/{ai-provider-connection.controller.ts,ai-provider-connection.module.ts,__tests__/}` | NEW | `@Controller('admin/ai-providers')`, class-level `@CanManage('GlobalSetting')`-style gating via a dedicated resource decision: use `@Authorize(['manage','all'])` for SYSTEM rows per program AD text; PATCH carries `@RequiresIfMatch()` + `@ExpectedVersion()` (department exemplar); cross-tenant by-id → 404. Tenant-lane routes deferred to TASK-526 (leave a route-map comment) |
| `apps/api/src/modules/ai-runtime-profile/{ai-runtime-profile.controller.ts,ai-runtime-profile.module.ts,__tests__/}` | NEW | `@Controller('admin/ai-runtime-profiles')`, global-admin-only, OCC chain, list/get/put/patch/delete + `GET resolve?provider=&modelSlug=` debug read |
| `apps/api/src/modules/settings-catalog/settings-registry-write.controller.ts` (+ module UPDATE, dto/) | NEW | `GET/PUT admin/settings/registry/:key` (§3.3); registered in `SettingsCatalogModule` so static `registry/` wins over global-setting `:id` |
| `apps/api/src/modules/streaming/smr-proxy.controller.ts` | UPDATE | §3.4 profile-param injection in `applySmrModelSelection` (`:170-178`) — caller-wins, additive |
| `apps/api/src/modules/ai-inference/ai-inference.controller.ts` | UPDATE | §3.4 fail-open profile injection next to `model_name` (`:68,84`) |
| `apps/api/src/app.module.ts` | UPDATE | Register the two new modules (before `GlobalSettingModule` where route ordering matters) |

Gate: `pnpm build:api` + `pnpm test:unit`; boot-time route audit passes (every route decorated).

### Comment/doc deltas (binding DoD rows)

- `secret-field.util.ts:5` consumer list (Step 3).
- `effective-settings.service.ts:1-7,63-68` headers → override lane real.
- `ai-task-default.prisma` cascade comment gains a pointer to `AiRuntimeProfile` for hyperparameters (do NOT touch the D-16 fix TASK-523 made).
- `tenant-scope.ts` allow-list comments (Step 1).
- `docs/development-patterns-and-standards.md` — new "settings write-lane" + "provider connection/runtime profile" pattern rows (program §6).

**Out of scope** (re-stated): Python adoption/effective-config endpoint = TASK-525; tenant BYO endpoints + console screens = TASK-526; retention keys = TASK-529; `agentic.context.*` consumers = TASK-533-B.

## 5. TDD Plan (RED first — paste failing output in §9 before implementing)

| # | Test file | Assertion (one line each) |
|---|---|---|
| 1 | `packages/applications/src/services/ai-provider-connection/__tests__/ai-provider-connection.service.test.ts` | Tenant-scoped create for `ollama` (self-host) → `ForbiddenException` (403, not 404) |
| 2 | (same file) | Tenant-scoped create for `azure` → allowed; entity built via `AiProviderConnectionFactory` (no `new`) |
| 3 | (same file) | `toResponse` snapshot: `hasKey: true`, and `encryptedApiKey`/`keyVersion` ciphertext **absent from every read DTO** (deep-key scan) |
| 4 | (same file) | SYSTEM-row write by non-super-admin → 403; `broadcastSysEvent(ResourceUpdated)` asserted on every mutation |
| 5 | (same file) | `resolveConnection`: enabled tenant row beats SYSTEM row; disabled tenant row falls through to SYSTEM; nothing → null (env fallback signal) |
| 6 | `packages/applications/src/services/ai-runtime-profile/__tests__/ai-runtime-profile.service.test.ts` | Cascade order: model-override (`modelSlug`) beats provider-default (`""`) beats absent; null fields fall through per-field |
| 7 | (same file) | Clamp/range validation: `temperature: 3` and `topP: 1.5` → `ArgumentInvalidException`/400; negative ints rejected by DTO |
| 8 | (same file) | Non-SYSTEM `tenantId` on any write → 403 (hyperparameters are global-only per E5) |
| 9 | `packages/applications/src/services/settings-registry/__tests__/settings-registry-write.service.test.ts` | `globalOnly` key + tenant-admin caller → 403 **derived from descriptor metadata** (no hard-coded key list in the service) |
| 10 | (same file) | Deeper-than-`maxScope` write → 400 via `assertWithinMaxScope` (spy proves the registry method is the enforcement point — its first production caller) |
| 11 | (same file) | Secret-sensitivity key → 400; unknown key → 400; unwritable tier → 400; successful PUT persists GlobalSetting row + sys-event + `forceRefresh` |
| 12 | `packages/applications/src/services/settings-registry/__tests__/effective-settings.service.test.ts` (UPDATE) | `agentic.context.liveDelta.maxChars` with a DB override → `{value: <db>, sourceScope: 'global-kv'}`; without → `'code-default'` (replaces the stub assertions) |
| 13 | (same file / registry test) | Boot guard: module init with a default-ON `killSwitch` descriptor throws (registry `killSwitches()` invariant now boot-enforced) |
| 14 | `apps/api/tests/e2e/{ai-provider-connections,ai-runtime-profiles,settings-registry-write}.spec.ts` (controller OCC folded into the authored e2e specs — no standalone controller unit test) | PATCH without `If-Match` → 428; version drift → 412 (`OptimisticConcurrencyException` mapped); by-id from another tenant → 404 |
| 15 | (same e2e specs) | Same OCC 428/412 chain; undeclared DTO field → 400 (`forbidNonWhitelisted`) |
| 16 | `apps/api/src/modules/streaming/__tests__/` (extend existing smr-proxy tests) | Body with caller-set `temperature` keeps it; absent → resolved profile value injected; no profile → body unchanged |
| 17 | `apps/api/src/modules/ai-inference/__tests__/` (extend) | Profile injection fail-open: resolver throwing ⇒ request still forwarded with `model_name` only |
| 18 | `packages/database/src/prisma/db_main/seed/__tests__/config-plane-seed.test.ts` | Seed rows: 8 SYSTEM connections, all `enabled: false`, no `encryptedApiKey`, provider set matches `AI_MODEL_PROVIDERS`; profile seed empty; SYSTEM ownership |
| 19 | `packages/database/src/__tests__/` (extend drift-guard) | Both models in `TENANT_SCOPED_MODELS` + `SYSTEM_SHARED_READ_MODELS`; NOT in `MODELS_WITHOUT_SOFT_DELETE` |
| 20 | seed-count updates | `ai-model-consolidation-seed.test.ts` untouched OR updated knowingly in this MR if shared constants drift (program §5.7) |

E2E specs (`apps/api/tests/e2e/{ai-provider-connections,ai-runtime-profiles,settings-registry-write}.spec.ts`, incl. `*-cross-tenant.spec.ts`) are **authored** here, **executed in TASK-534/P7** (program §2.2).

Gate commands: `pnpm db:generate && pnpm --filter @arcaai/database build test` → `pnpm --filter @arcaai/domains build test` → `pnpm --filter @arcaai/applications build test` → `pnpm build:api && pnpm test:unit` → `pnpm lint` (only-warn warnings in `packages/*` treated as errors).

## 6. Acceptance Criteria & DoD

- [ ] Both tables exist with house-template fields; migration SQL reviewed + committed; applied locally via psql/`db push` (no `migrate reset`); allow-lists updated with justification comments.
- [ ] Hand-authored mappers/repositories match the trio conventions; repositories in `CoreDatabaseModule` providers AND exports; all barrels updated; `@arcaai/database` + `@arcaai/domains` dists rebuilt before dependent test runs.
- [ ] `admin/ai-providers` + `admin/ai-runtime-profiles` CRUD live with the full OCC chain; tenant rows only for `azure`/`bedrock` (403 otherwise); profiles SYSTEM/global-only; cross-tenant by-id → 404.
- [ ] No response DTO anywhere carries `encryptedApiKey` (snapshot-tested); key writes rejected without Vault; no reveal route.
- [ ] `GET/PUT admin/settings/registry/:key` enforces `globalOnly`/`editableBy`/`maxScope` from descriptor metadata; `assertWithinMaxScope` has ≥ 1 production caller; kill-switch invariant runs at boot; `rate-limit.enabled`, `audit-retention.*`, `agentic.trajectory.*` appear in `GET admin/settings/catalog`; effective facade resolves DB overrides for `global-kv` keys.
- [ ] Gateway injects resolved profile params (caller-wins) in `smr-proxy` + `ai-inference`; with zero profile rows seeded, forwarded requests are **byte-identical to today** (silent-change rule).
- [ ] Seeds land with `enabled: false` connections; seed-count tests updated in the same MR; `broadcastSysEvent` asserted on every mutation path; every accepted field on a class-validator DTO.
- [ ] All §5 RED runs pasted, then green; all gate commands green with output pasted in §9; comment/doc deltas applied.

## 7. Risks & Rollback

| Risk | Mitigation |
|---|---|
| **Silent behavior change** (the program's D-07 lesson: wiring a dead field flips real defaults) | Hard rule: with the shipped seeds (disabled connections, zero profiles, orphan keys registered at their current runtime defaults), every request path resolves exactly today's effective values — asserted by tests 16/17/18. Any deviation is its own reviewed decision row. |
| Registry write-lane collides with legacy `GlobalSetting` row CRUD (same table, two write paths) | Lane writes use the reserved `registry` namespace + descriptor key; legacy controller untouched; a follow-up reconciliation (GAP-C5 remainder) belongs to TASK-532 — documented in both controllers' comments. |
| `rate-limit.enabled` registration trips the kill-switch boot guard | It is registered WITHOUT the `killSwitch` marker (default-ON protection-enable, polarity documented) — test 13 covers the guard, a dedicated test asserts this key's descriptor shape. |
| Secret handling regression | Only `encryptSecretField`/`decryptSecretField`; DTO deep-key snapshot tests; decrypt stays gateway-resolution-only (no decrypt in this ticket at all — consumption is TASK-525/526). |
| `SYSTEM_SHARED_READ_MODELS` widening leaks a tenant's BYO row | Structurally impossible — widening is `[caller, SYSTEM]` only (`tenant-scope.ts:196-199`); cross-tenant e2e spec authored for P7. |
| Migration rollback | **Roll-forward only** (rule 02: never edit a committed migration). The tables are additive and consumer-free until TASK-525 — reverting behavior = disable seeds/rows, not schema surgery. |
| Barrel/module merge conflicts with parallel lanes | Append-only barrel edits; this ticket's manifest (§4) is exclusive per program §2.3. |

## 8. References

- Program: `docs/implementation/SOTA-Track/2026-07-20-agentic-platform-program-plan.md` §3 AD-1/AD-2, §4 P1, §8 OD-7 · Findings: `docs/implementation/SOTA-Track/2026-07-20-agentic-platform-review-findings.md` §3-E2/E5, §7 GAP-C1/C2/C5/C7
- Rules: `.claude/rules/02-database-prisma.md` (field template, migrations, allow-lists) · `03-domain-layer.md` (trio, hand-authored extensions, `CoreDatabaseModule`) · `04-application-services.md` (BaseService, DI, DTO, sys-events, tenant guards) · `05-nestjs-api.md` (OCC chain, decorators, 404-over-403)
- Exemplars: `packages/domains/**/Department*` (trio) · `apps/api/src/modules/department/department.controller.ts:126-157` (OCC) · `packages/applications/src/services/tenant-tts-config/` (BYO secrets) · `packages/applications/src/services/ai-task-default/` (cascade + global-only guard) · `packages/applications/src/services/settings-registry/` (descriptors/registry/facade)
- Prior tickets: TASK-504 (settings framework), TASK-496 (TTS BYO), TASK-506 (model registry consolidation + seed-count-test precedent `ai-model-consolidation-seed.test.ts:225-240`)

## 9. Implementation Summary

**Status: Review** — all four layers implemented TDD (RED → GREEN), all gate commands green with output below.

### 9.1 Gate evidence (2026-07-20)

| Gate | Command | Result |
|---|---|---|
| Database | `pnpm --filter @arcaai/database test` | **24 files / 819 tests passed** (baseline 806 → +13 new) |
| Database build | `pnpm --filter @arcaai/database build` | clean |
| Domains | `pnpm --filter @arcaai/domains build test` | **116 files / 1368 passed**, 2 skipped, 9 todo |
| Applications | `pnpm --filter @arcaai/applications build test` | **313 files / 6493 passed** (baseline 6444 → +49 new) |
| API build | `pnpm build:api` | 8/8 turbo tasks successful |
| Full unit suite | `pnpm test:unit` | **939 files / 16609 passed**, 2 skipped, 9 todo |
| Lint | `pnpm lint` | 29/29 tasks successful; `@arcaai/api` **0 problems**; all TASK-524 files in `packages/*` warning-free |

Migration applied to the dev DB via `psql` (never `migrate reset` — the dev DB is `db push`-managed and behind migration history); `\d core."AiProviderConnection"` verified all 20 columns, the compound unique and both indexes. The test DB (port 5433) was **not** running, so the migration was not applied there — it must be applied before the integration/e2e run in TASK-534.

### 9.2 What landed, by layer

**Database** — `ai-provider-connection.prisma` + `ai-runtime-profile.prisma` (house field template, named indexes, `@@schema("core")`); migration `20260720000000_task_524_ai_provider_connections_runtime_profiles` (additive + idempotent, every CREATE guarded); both models added to `TENANT_SCOPED_MODELS` and `SYSTEM_SHARED_READ_MODELS` with the §3.1 justification (incl. the secret-bearing caveat on connections); seeds `17-` (8 SYSTEM rows, all `enabled: false`, no key material) and `18-` (deliberately empty) registered in `seed/index.ts`.

**Domains** — `AiProviderConnection*` / `AiRuntimeProfile*` model + entity + factory + mapper + repository, all barrels, both repositories registered in `CoreDatabaseModule`. Both mappers strip `version` (both models are OCC-written). Repositories follow the corrected `AiTaskDefaultRepository` form: `tx` dual-path for the cross-tenant lane and a **narrow `DataNotFoundException` catch** (not the older blanket `catch { return null }`, which would mask a tenant-scope mismatch as an empty read).

**Applications** — `ai-provider-connection/` and `ai-runtime-profile/` service folders per rule 04; `settings-registry-write.service.ts` (the AD-1 single enforcement point); the `global-kv` override lane in `effective-settings.service.ts`; `platform-ops.descriptors.ts`; boot-time `killSwitches()` guard on `EffectiveSettingsModule.onModuleInit`.

**API** — `admin/ai-providers` + `admin/ai-runtime-profiles` controllers with the full OCC chain; `GET/PUT admin/settings/registry/:key` in `SettingsCatalogModule`; caller-wins/fail-open profile injection in `smr-proxy.controller.ts` and `ai-inference.controller.ts`; modules registered in `app.module.ts`. E2E specs authored in `apps/api/tests/e2e/{ai-provider-connections,ai-runtime-profiles,settings-registry-write}.spec.ts` (**executed in TASK-534/P7**, not here).

### 9.3 Deviations from the plan (decision rows)

| # | Plan said | Reality | Resolution |
|---|---|---|---|
| D-1 | Step 2 scaffolds entities/factories with `pnpm gen:entity` / `gen:factory` | **Only `gen:model` scaffolds from the DMMF.** The entity and factory generators are barrel *reconcilers* — their own headers state "the committed files on disk, not the DMMF, are the source of truth" and they reproduce existing files verbatim. They create nothing. | Entities, factories, mappers **and** repositories were all hand-authored. `gen:model` was still run (it produced both models). All three drift gates re-verified. |
| D-2 | Not mentioned | `ResourceType` needed both new members, or every `broadcastSysEvent` would fail the AuditLog INSERT and roll the originating mutation into a 500 (the TASK-366 failure mode). | Added to `audit.prisma` **and** `packages/domains/src/enums/generated/ResourceType.ts`, plus a guarded `ALTER TYPE ... ADD VALUE IF NOT EXISTS` appended to the migration and applied to the dev DB. Parity test green. |
| D-3 | §3.3 step 7 calls `AppSettingsService.forceRefresh()` | **No such method exists.** The force-refresh method is `refreshCache()`. | Used `refreshCache()`. |
| D-4 | §5 test 12 keeps the effective-facade stub assertions | The existing test `'throws for a non-secret key with no registered resolver'` used `entitlements.enabled`, which is tier `global-kv` — so the new lane correctly resolves it. That test encoded the very gap GAP-C5 describes. | Updated knowingly: the negative case now uses `entitlements.featureDnaReports` (tier `entitlement`, genuinely resolver-less), and a new `global-kv override lane` describe block covers §5 test 12. |
| D-5 | §5 test 19 extends the drift guard | The existing `tenant-scope.test.ts` locks both allow-list sets exactly, so it failed as designed. | Updated knowingly (count 54 → 56, both sets extended) with justification comments — the program §5.7 "update in the same MR" rule. |
| D-6 | §4 Step 1 seeds `baseUrl`/`region` from `.env.production` | `.env.production` carries no ollama/lm-studio/bedrock/sarvam values (only vLLM/llama.cpp); the rest are blank or live in `.env.dev`. | Seeded only the values that genuinely exist, each flagged `metaData.placeholder: true`; the others seed `null` rather than inventing a value. |
| D-7 | Tenant BYO endpoints deferred to the follow-up ticket | Unchanged — but the controller now carries an explicit ROUTE MAP NOTE saying so, so the omission reads as deliberate. | No action. |

### 9.4 Pre-existing issues found — ALL NOW FIXED (owner-authorised follow-on, 2026-07-20)

These were found during implementation, reported as out-of-manifest, then fixed on owner instruction.

1. **`generate-data-entity:check` / `generate-factory:check` were RED at HEAD.** `HarnessPolicy.mcpToolsEnabled` existed in `harness.prisma` but was surfaced by neither `HarnessPolicyEntity` nor `HarnessPolicyFactory`; `SummaryMetaFactory` lacked `stopReason` / `ttftMs` / `tokensPerSecond` (the entity and mapper already had them, and a mapper test already asserted the round-trip — only the factory was missing). **FIXED**: all four columns surfaced following the neighbouring-knob conventions. Both gates now report *"no drift"* + *"schema coverage OK"* (68 artifacts covering 72 models).
2. **`generate-data-model:check` was also RED at HEAD** (`ContextItemModel`, `HarnessPolicyModel`, `TranscriptSegmentModel` stale). The mandatory `gen:model` run regenerated them → **GREEN**. Those three files appear in the diff as incidental generator output.
3. **D-16 residue FIXED.** `seed/16-ai-task-default.ts` carried the stale `nlp.* keys are tenant-admin editable` claim. Root cause: TASK-523's D-16 enumerated **four** sites (`.prisma`, controller Swagger, `seed/01-policy.ts` CASL comment, admin-screen copy) and this seed file was an unlisted **fifth**. The other four were verified correctly fixed. The seed comment now mirrors the corrected `.prisma` wording verbatim.
4. **Generator documentation corrected repo-wide** (see §9.6).

### 9.5 ⚠️ `pnpm gen:mapper` is DESTRUCTIVE — discovered 2026-07-20

While verifying generator behaviour for §9.6, running `pnpm gen:mapper` **crashed partway through, but only after rewriting the mappers it had already processed** — and its output **drops the `FIELDS_NOT_WRITABLE = ['version']` constant and its `stripNonWritableFields` helper**.

That strip is the only thing preventing `_version` from leaking into Prisma updates. Losing it silently breaks optimistic concurrency on every OCC-written model — the exact class of corruption the TASK-302 Stream D work introduced it to prevent.

Observed blast radius from ONE invocation: **24 mappers rewritten, the `_version` guard stripped from 18 of them.** Fully reverted via `git checkout -- packages/domains/src/mappers/generated/core/ packages/domains/src/repositories/generated/core/`, barrel lines re-added, and all 1368 domain tests plus the three drift gates re-verified green.

Historical note: `docs/archive/TASK-413-.../README.md:352` recorded this crash but characterised the fallout as *"formatting side-effects"* — an understatement that likely explains why the danger was never escalated. It is now documented as destructive in `.claude/rules/03-domain-layer.md` with a do-not-run warning.

`pnpm gen:repository` is separately broken (fails immediately on `--overwrite true` → *"too many arguments"*), but harmlessly — it writes nothing.

### 9.6 Generator documentation corrected (7 files)

The repo-wide claim that `gen:entity`/`gen:factory` scaffold new artifacts was wrong and had propagated into the always-loaded rules. Verified behaviour and corrected:

| File | Correction |
|---|---|
| `.claude/rules/03-domain-layer.md` | Full per-command behaviour table, the `gen:mapper` do-not-run warning, and an 8-step new-model checklist (incl. the `ResourceType` dual-enum step) |
| `.claude/rules/02-database-prisma.md` | "do not hand-write the trio" → hand-authoring IS the workflow; pointer to the table |
| `docs/development-patterns-and-standards.md` | Same correction in the primary reference |
| `docs/development-guide.md` | Generator caveat added |
| `SOTA-Track/2026-07-20-agentic-platform-program-plan.md` | §DB rules corrected — this is what sibling tickets 525–534 inherit |
| `TASK-531-Pipeline-Template-Governance/README.md` | Step corrected |
| `TASK-527-Model-Source-Resolution/README.md` | Parenthetical corrected |

TASK-524's own §4 Step 2 table was corrected in place with an inline correction note.

### 9.7 ResourceType parity audit (clean)

Prompted by the latent-500 finding (§9.3 D-2), a scripted audit compared the domain enum, the Prisma enum, and every `ResourceType.X` reference in `packages/applications`: **47 domain members = 47 Prisma members**, and all 41 referenced members exist in both. The one apparent gap (`ResourceType.Policy`) is a false positive — it appears only inside a comment explaining that `ResourceType.Permission` is used *instead*. No other model has this bug.

### 9.8 Not verified (honest gaps)

- **No runtime boot verification.** The API was never started, so the boot-time route audit and the new `onModuleInit` kill-switch guard were not observed firing. Every new route carries a permission decorator and every gate compiles, but "compiles" ≠ "boots".
- **No live-DB integration or e2e run.** The test DB (5433) was down; the e2e specs are authored but unexecuted, per §5 (executed in TASK-534/P7).
- **No Vault-live round-trip.** `encryptSecretField` is exercised only against a mocked `SecretsService`.
- **The migration is not applied to the test DB.** Apply it before the TASK-534 run.

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket README authored (execution-ready plan; code-verified current state; frozen AD-1/AD-2 contracts refined into final schemas; TDD plan; awaiting owner approval per rule 01 Phase 3 gate). |
| 2026-07-20 | **Implemented, all four layers, TDD.** Status Pending → Review. RED-first per layer (seed/allow-list suite, both service suites, the write-lane suite, and both gateway-injection suites each observed failing before implementation). Gates: database 819, domains 1368, applications 6493, full unit suite **16609 passed**, `pnpm build:api` 8/8, `pnpm lint` 29/29 (api 0 problems). Seven plan deviations recorded as decision rows in §9.3 — most consequential: `gen:entity`/`gen:factory` are barrel RECONCILERS, not scaffolders, so the entity/factory/mapper/repository layers were all hand-authored; and `ResourceType` required new members in both the Prisma enum and the domain enum (with an `ADD VALUE` migration) or every sys-event broadcast would have failed the AuditLog INSERT. Three pre-existing issues found and deliberately NOT fixed (§9.4): the entity/factory drift gates are red at HEAD on `HarnessPolicy.mcpToolsEnabled` + `SummaryMeta` fields, and the D-16 stale comment survives at `seed/16-ai-task-default.ts:22`. Not verified (§9.5): runtime boot, live-DB integration/e2e, Vault-live round-trip, and the migration is not yet applied to the test DB. |
| 2026-07-20 | **Owner-authorised follow-on: the four out-of-scope items closed.** (1) Both red drift gates fixed properly — `HarnessPolicy.mcpToolsEnabled` surfaced on entity + factory, `SummaryMeta.{stopReason,ttftMs,tokensPerSecond}` surfaced on the factory; all three generator gates now report "no drift" + "schema coverage OK". (2) `ResourceType` parity audited repo-wide by script: 47 = 47, all 41 referenced members present in both enums, no other latent-500. (3) D-16 residue fixed in `seed/16-ai-task-default.ts`; root cause identified — TASK-523 enumerated four sites and this was an unlisted fifth (the other four verified correct). (4) Generator documentation corrected across 7 files incl. both always-loaded rules. **NEW CRITICAL FINDING (§9.5): `pnpm gen:mapper` is DESTRUCTIVE** — it crashes partway but rewrites already-processed mappers WITHOUT the `FIELDS_NOT_WRITABLE = ['version']` OCC guard; one run clobbered 24 mappers and stripped the guard from 18, which would silently break optimistic concurrency platform-wide. Fully reverted and verified; now documented as do-not-run. Gates after all changes: domains 1368, full unit suite **16609 passed**, `pnpm build:api` 8/8, `pnpm lint` 29/29. |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING for this ticket (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end (or explicitly retired); redundant implementations are converged and deleted. Reviewer enforces the §2.5 classification table, plan-conformance (deviations = recorded decision rows), full-closure traceability of the claimed GAP/D/M IDs, and the performance gates. |
| 2026-07-22 | **TASK-536 de-ticketing (R5 reference update).** The former `apps/api/tests/e2e/task-524-config-plane.spec.ts` was split (per the TASK-534 e2e manifest) into `ai-provider-connections.spec.ts`, `ai-runtime-profiles.spec.ts`, and `settings-registry-write.spec.ts`. References in §5 and §9.4 above updated to the new filenames; the seed unit test `seed/__tests__/task-524-config-plane.test.ts` was left as-is at the time (unit-test filenames were out of that rename's scope). |
| 2026-07-22 | **De-ticketing Directive v2 (rule 5 exclusion lifted) — unit-test filenames now in scope too.** The former `seed/__tests__/task-524-config-plane.test.ts` renamed to `seed/__tests__/config-plane-seed.test.ts`; the former `seed/__tests__/task-506-ai-model-consolidation.test.ts` renamed to `seed/__tests__/ai-model-consolidation-seed.test.ts`. All in-repo references (this README, `TASK-527-Model-Source-Resolution/README.md`, the SOTA-Track program plan) updated to the new filenames. |
