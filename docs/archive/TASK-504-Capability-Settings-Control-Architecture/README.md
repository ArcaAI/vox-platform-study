# TASK-504 — Capability & Settings Control Architecture (Vault vs Database)

> **Status:** In Progress (Phases 1, 2, 3a, 3b, 3c, 4-TTS-UI, 5-framework ✅ shipped & green; §6.5 for the summary. Remaining: deferred facade/API items + infra-gated verification.)
> **Type:** infrastructure / refactor / feature
> **Owner:** TBD · **Author:** exploration + plan pass, 2026-07-12
> **Depends on / builds from:** TASK-330 (HarnessPolicy), TASK-356 (PipelinePolicy `ConfigResolver`), TASK-392 (Entitlements), TASK-415 (Admin Console), TASK-417 (GLOBAL_ADMIN consolidation), TASK-496 (Tenant TTS config + BYO Vault-encrypted keys).

This document is written to be executed by another agent with **minimal prior context**. Every claim carries a `file:line` anchor so the executing agent can verify before changing. Read `.claude/rules/00`, `01`, `02`, `03`, `04`, `05`, `13` before touching code in the corresponding layer.

---

## 0. TL;DR — the decision the ticket exists to standardize

> **"Store settings in Vault OR the database depending on security and ease."**

The answer, distilled from the current codebase, is a single rule the whole platform should follow:

- **Database is the control plane.** Everything a human admin toggles — capabilities, features, functionality, behavioral config, quotas, kill-switches — lives in Postgres, because the DB is where we already have optimistic-concurrency (`_version`/If-Match), per-row audit, tenant scoping, cascade resolution, and admin UI ergonomics. Vault has none of those.
- **Vault is the crypto substrate, never the control plane.** Vault holds (a) shared platform secrets set by operators/IaC (JWT key, service tokens, DB creds) and (b) the *encryption* of secret fields that must live in a DB row (per-tenant BYO API keys). A secret that a tenant admin sets is stored as **Vault-Transit ciphertext inside a DB column** — DB for the control plane, Vault for the confidentiality. This is exactly the TASK-496 pattern; the ticket generalizes it.
- **Never** put admin-editable non-secrets in Vault (no OCC, no audit UI, no cascade, adds latency + kv-version churn). **Never** put secrets in a DB plaintext column (reject the write if Vault is unavailable).

Everything below is the framework, the current-state gaps, and the phased plan to make this uniform.

---

## 1. Requirement Analysis

Global admins and tenant admins must be able to control **capabilities, features, functionalities, configuration, and settings** as variables/settings, with each variable routed to Vault **or** the database according to its **security** class and the **ease** of administering it. The deliverable is best-practice guidance plus a concrete, buildable plan.

Concretely the platform needs:

1. A **classification framework** that, given any controllable variable, deterministically says: which storage tier, whether/how it is encrypted, who may edit it, at what scope, and how it is audited. (§3)
2. A **uniform control model** splitting global-admin vs tenant-admin authority, with a single enforcement path (RBAC subject + scope clamp + working-tenant). (§4)
3. Consolidation of the **three coexisting mechanisms** already in production into one registry-driven control plane, rather than inventing a fourth. (§5)
4. Closure of the **gaps** the current implementation leaves (no TTS admin UI, duplicated cross-tenant helpers, no canonical secret-crypto util, client-side categorization, missing version-history API). (§2.4, §6)

Out of scope (name explicitly so the executing agent does not scope-creep): rewriting RBAC/CASL, changing the Vault deployment topology, building the guardrail/NLP Python admin surfaces (that is the still-open TASK-419 follow-up — reference only).

---

## 2. Current-State Evaluation (verified inventory)

### 2.1 Secrets / Vault layer

`packages/applications/src/services/baseServices/_meta/secrets/`:

- `SecretsService.ts` — consumer-facing wrapper: LRU+TTL cache (`:32-62`), sync cache-only `getSecretSync` for hot paths (`:84-88`), Redis pub/sub cache invalidation (`:165-196`), **capability-checked Vault Transit** `encrypt/decrypt/decryptBatch` (`:259-297`), Vault DB dynamic creds `requestDbCredential(role)` (`:331-351`).
- Provider abstraction `ISecretsProvider.ts` — `SecretsProviderName = 'env' | 'vault' | 'aws' | 'azure' | 'in-memory'`. Selected by `SECRETS_PROVIDER` env in `secrets.module.ts:49-57`, **defaults to `env`** (dev; `.env.example:596`).
- `providers/vault-secrets.provider.ts` — kv-v2 reads at `<kvMount>/data/<kvPrefix>/<KEY>` (`:252-254`), AppRole login + response-unwrap (`:144-173`), self-renewing token loop (`:183-235`), Transit `encrypt/decrypt/decryptBatch` (`:421-470`), DB secrets engine `issueDbCredential` (`:473-495`).
- **In Vault today** (`infrastructure/docker/configs/vault/dev-init.sh`): `JWT_SECRET_KEY`, `SESSION_SECRET_KEY`, `API_KEY_PEPPER`, `OIDC_CLIENT_SECRET`, MinIO/S3 keys, `SMR_SERVICE_TOKEN`, `HARNESS_SERVICE_TOKEN`, `MQTT_PASS`, `REDIS_PASS`. Two **Transit keys**: `hope-globalsetting` (general field encryption) and `hope-phi` (dedicated PHI/WORM-snapshot key — separate so rotation/blast-radius is independent). DB secrets engine issues short-lived PG creds (`database/creds/hope-app-role`), consumed by `packages/database/src/vault-client.ts`.

### 2.2 Runtime config service — **env-only, not DB-backed**

`IConfigService` (`packages/applications/src/services/baseServices/_meta/config/IConfigService.ts:7-69`) → `config.service.ts` reads `process.env` with defaults for downstream URLs (`STT_URL`, `SMR_URL`, `NLP_URL`, `GUARDRAIL_URL`, `HARNESS_URL`, `TTS_URL`, `:144-154`) and overlays only `MQTT_PASS`/`REDIS_PASS` from Vault. Direct `process.env.<URL>` reads in `apps/api/src/modules/**` are lint-banned; controllers must resolve via `getConfigValue`. **This layer stays env-only** — it is deployment infra, not admin-controllable.

### 2.3 The three coexisting admin-toggle mechanisms (the crux)

| # | Pattern | Storage | Scope model | OCC / Audit | Used for |
|---|---|---|---|---|---|
| **A** | Generic KV | `GlobalSetting` (`globalSetting.prisma:1-47`): `tenantId+name+key` rows, `value` plaintext **+** `encryptedValue Bytes?`/`keyVersion` (Vault Transit `hope-globalsetting`). `AppSettingsService` in-memory cache, ~45s refresh, force-refresh on write. Platform singletons use reserved tenant IDs (`ENTITLEMENTS_TENANT_ID`, `RATE_LIMIT_TENANT_ID=50000000-…`). | per-tenant row; platform via reserved tenant | If-Match on `:id`; reveal/rotate step-up + `forceAuditLog` | entitlements kill-switch, rate-limit numbers |
| **B** | Dedicated table + cascade + WORM | `HarnessPolicy`/`HarnessPolicyChange` (`harness.prisma:300-390`), `PipelinePolicy`/`PipelinePolicyChange` (`pipeline-policy.prisma`). Strongly-typed columns; nullable = "inherit". WORM change-log tables carry Vault-Transit-encrypted before/after JSON and have `REVOKE UPDATE, DELETE` at the DB role. | tenant→SYSTEM→code (Harness); **doctor→dept→tenant→SYSTEM→code** with per-setting **max-scope clamp** (Pipeline) | full `_version` OCC + WORM immutable log | safety/PHI toggles, provider selection, auto-summary/NER routing, DNA style |
| **C** | Entitlements matrix | `PlanEntitlement` (`entitlement.prisma:29-77`, one row per `TenantPlan`, **not** tenant-scoped) + `TenantEntitlement` (`:85-133`, per-tenant nullable override) + `TenantUsageMeter`. Single global kill-switch `entitlements.enabled` (a `GlobalSetting`, default OFF). | plan default ← per-tenant override | override CRUD audited; kill-switch via AppSettingsService | feature toggles (`featureDnaReports`, `featureVoiceEnrollment`, `featureMonitoringAccess`), quotas, model tier, rate-limit tier |

**The single most reusable asset** is the Pipeline resolver: `packages/applications/src/services/config-resolver/config-resolver.service.ts` — `resolvePipelineToggles()` walks doctor→dept→tenant→SYSTEM→code, short-circuits at first non-null, and enforces a per-setting **max-scope clamp** (`PIPELINE_SETTING_DESCRIPTORS`, `:72`; `assertWithinMaxScope`, service `:404`). This is the template for a general effective-config engine.

Other purpose-built toggle tables: `TenantFrontendConfig` (`tenant.prisma:46-88`, audio-pipeline SDK defaults; note the "effective flag = platformCapability(GlobalSetting) **AND** this column" composition), `TenantTtsConfig` + `TenantTtsProviderCredential` (TASK-496), `TenantStorageConfig` (`tenant-bucket.prisma:122-175`, with `credentialsRef` pointer into SecretsService), `AiModel.tags` tier convention (`tier:<base|full|full_custom>`). **A live-doc-engine kill-switch is Redis-backed** (`HarnessAdminController.getLiveConfig/updateLiveConfig`, `harness-admin.controller.ts:399-412`) — survives restart, fans out to all API instances instantly, **not** versioned.

There is **no** generic `FeatureFlag` table and no `maintenance mode` flag. Every toggle is one of the three patterns above.

### 2.4 The BYO-secret-in-DB exemplar (TASK-496 — copy this, don't reinvent)

`packages/database/src/prisma/db_main/tenant-tts-config.prisma`:

```prisma
model TenantTtsProviderCredential {
  tenantId String
  provider String            // azure | sarvam
  endpoint String?
  encryptedApiKey Bytes?      // Vault Transit ciphertext ONLY — plaintext never stored
  keyVersion Int?
  enabled Boolean @default(false)
  @@unique([tenantId, provider])
}
```

- **Write** (`tenant-tts-config.service.ts:158-210`): `secretsService` is `@Optional()`-injected; if Vault absent the write **rejects** — no plaintext fallback (stricter than `GlobalSetting`, which keeps a legacy plaintext column). `encrypt(Buffer.from(apiKey))` → Vault `POST transit/encrypt/<key>` → `vault:vN:<b64>` stored as `Bytes`; `keyVersion` parsed from the ciphertext.
- **Read** = **masked** (`maskCredential`, `:256-265`): DTO `TtsCredentialResponse` has **no `apiKey` field**, only `hasKey: boolean`, `keyVersion`, `endpoint`, `enabled`. Write DTO `apiKey` is **write-only** (`@MinLength(1) @MaxLength(512)`, never echoed). No reveal endpoint at all (stricter than GlobalSetting's step-up reveal).
- **Runtime** (`speech-proxy.controller.ts:61-85`; `tts-ws.gateway.ts:119-257`): gateway resolves effective config + `resolveProviderOverrides(tenantId)` (decrypts per credential, **fails open** per-credential on decrypt error), injects `provider_overrides` into the request body / first WS `init` frame. `apps/tts` stays **stateless** — no DB/Vault, receives creds per request, caches an engine keyed by `sha256(cred)`. Every error log redacts the body ("may contain PHI"); the decrypted key never appears in a log line.
- **Divergence to fix**: TASK-496 re-implemented `parseKeyVersionFromCiphertext` (`:30-36`) privately instead of reusing `GlobalSettingRepository.encryption.ts`. Two copies of the secret-crypto logic now exist. → Phase 1 hoists a single canonical util.

### 2.5 RBAC / delegation / admin surfaces

- CASL policy engine (`rbac.prisma`): `Role` (hierarchical, `isSystemRole`), `Policy` (`rules: Json` CASL array, `scope: GLOBAL|TENANT`, `isProtected`), `RolePolicy` (priority). Actions: `PermissionAction` enum `MANAGE/CREATE/READ/LIST/UPDATE/DELETE/ARCHIVE/EXPORT` (`enums.prisma:55`). Subjects are free-form strings agreed between `@Authorize(...)` and seeded `Policy.rules[].subject` (e.g. `'HarnessPolicy'`, `'PipelinePolicy'`, `'GlobalSetting'`, `'TenantTtsConfig'`, `'all'`) — **no DB-enumerated subject catalog**.
- `GLOBAL_ADMIN` (`seed/03-role.ts:84-97`: `manage:all`, `global-settings-manage`, `rbac-system-manage`, `prisma-studio-manage`) vs `TENANT_ADMIN` (`tenant-full-access`). `ELEVATED_ROLES=['GLOBAL_ADMIN']`; `isSuperAdmin(user)` (`tenant-guards.ts:61`) is the platform-vs-tenant branch every controller uses.
- **Working-tenant round trip**: session cookie carries `workingTenantId` (elevated only, `session.ts:45-54`) → `POST/DELETE /api/auth/working-tenant` (403 if not elevated) → BFF attaches `X-Tenant-Id` for elevated+picked, **never while impersonating** (`hope-proxy.ts:28-37`) → gateway `context.interceptor.ts:65-104` + `resolve-active-tenant.ts:29-44` elevates CLS `tenantId` from the header for a global-admin whose JWT tenant is empty; rejects a diverging header for tenant-bound callers (400). 404-over-403 posture throughout.
- **Admin-console tiers**: route groups `(global)` 10–19 (404 unless `isElevated`), `(shared)` 20–29, `(tenant)` 30–49 (`isElevated` OR `TENANT_ADMIN`, plus `<WorkingTenantGate>` for elevated). `WorkingTenantBanner`, `TenantScopeBanner` ("Acting on «Tenant»"), `ImpersonationBanner`.
- **OCC on every versioned config route**: `@RequiresIfMatch()` (missing → 428) + `@ExpectedVersion()` (`If-Match` overrides body) → `repository.updateWithVersion` → `OptimisticConcurrencyException` → 412. First-edit rows use a placeholder `FIRST_EDIT_ETAG='"1"'` client-side. Bulk tenant-config PATCH does per-row sequential PATCH to keep row versions authoritative.
- **Audit**: `BaseService.broadcastSysEvent` → `EventEmitter2` → `SysEventService` → BullMQ (`AuditLog` table, envelope-encrypted JSONB; `UserActivity`; webhooks). `ResourceViewed` audited only with `forceAuditLog`. Policies B use their **own WORM change-log tables** instead of the generic AuditLog for DB-privilege-enforced immutability.

### 2.6 Gaps (each becomes a plan item)

1. **TTS-config admin UI missing** — backend fully shipped (`admin/tts-config`), no `features/*tts*` screen, not in `nav-config.ts`. (§6, Phase 4)
2. **Webhooks & notifications** admin controllers exist (`admin/webhooks`, `admin/notifications`), no console screens; `capabilities-matrix.md` gap table is stale. (§6, Phase 4 — optional)
3. **No canonical secret-crypto util** — `parseKeyVersionFromCiphertext` + encrypt/decrypt-into-entity duplicated across GlobalSetting and TTS. (Phase 1)
4. **Cross-tenant resolution duplicated** — `resolveTenantId/resolveReadTenantId/assertTenantInScope` re-implemented near-identically in `tenant.controller.ts`, `harness-admin.controller.ts`, `pipeline-policy-admin.controller.ts`, `tenant-tts-config-admin.controller.ts`. (Phase 2)
5. **No dedicated settings version-history API** — History tab reprojects the generic audit log. (Phase 4)
6. **Client-side-only categorization** — `config-categories.ts` keyword heuristic silently buckets unknown keys into `general`; no server taxonomy. (Phase 3)
7. **No registry** — the three patterns are chosen ad hoc per feature; nothing declares "this variable → this tier → this scope → this editor". (Phase 3, the centerpiece)
8. **Unbounded per-tenant engine cache** in tts (`_tenant_engines` dict, no LRU/TTL) — note only; owned by TASK-496 follow-up.

---

## 3. The classification framework (best practice — the heart of the ask)

Every controllable variable is assigned exactly one **data class**. The class fixes storage, encryption, editor, scope, and audit. This table is the normative rule; Phase 3 encodes it as a code registry.

| Data class | Examples | Storage tier | Encryption | Who edits | Scope | Audit |
|---|---|---|---|---|---|---|
| **1. Platform infra secret** (shared) | `JWT_SECRET_KEY`, `*_SERVICE_TOKEN`, DB creds, MinIO/S3 keys, `OIDC_CLIENT_SECRET` | **Vault kv-v2** (+ DB secrets engine for DB creds) | Vault-native at rest | Operator / IaC only — **never** an admin UI | platform | Vault audit device |
| **2. Tenant BYO secret** | provider API keys (Azure/Sarvam/LLM), SSO/IdP client secret, SMTP creds, webhook signing secret, external-storage creds | **DB column, ciphertext via Vault Transit** (`encrypted* Bytes` + `keyVersion`); reject write if Vault absent | Vault Transit (`hope-globalsetting`, or a dedicated key for high-sensitivity) | tenant-admin (BYO) + global-admin (platform default row) | tenant + SYSTEM default | SysEvent + WORM; write-only DTO, masked read, step-up on reveal/rotate |
| **3. Behavioral config, cascading** | pipeline toggles, harness thresholds/providers, ASR/TTS defaults, voice/routing spec, frontend SDK flags | **DB dedicated table + `ConfigResolver` cascade + OCC** | none (plaintext) | tiered by max-scope (system→tenant→dept→doctor) | multi-tier | `_version` OCC + WORM change-log |
| **4. Global KV / kill-switch / op flag** | `entitlements.enabled`, rate-limit numbers, live-doc engine on/off, maintenance mode | **DB `GlobalSetting` + AppSettingsService cache**; **Redis** for instant-fan-out kill-switches | optional (Transit if secret) | global-admin | platform (or per-tenant row) | SysEvent audit |
| **5. Plan capability & quota** | `featureDnaReports`, `maxUsers`, `monthlyConsultations`, `modelTier` | **DB entitlements matrix** (`PlanEntitlement` + `TenantEntitlement`) | none | global-admin (plan matrix); per-tenant override | plan → tenant override | override CRUD audited; kill-switch gated |
| **6. Deployment/runtime env** | downstream `*_URL`, ports, build flags | **env → `turbo.json#globalEnv` → `IConfigService`** | none | operator only | platform / per-deploy | — |

### 3.1 The decision procedure (how "security and ease" resolve)

Apply top-down; first match wins:

1. **Is it secret material** (leak ⇒ credential/data compromise)?
   - **Shared platform-wide and operator-set** → **Class 1, Vault kv-v2**. Rationale: no admin ever edits it; Vault gives rotation + audit + no-at-rest-in-app-DB. *Security dominates; ease is irrelevant (operators, not admins).*
   - **Per-tenant and admin-set** → **Class 2, DB ciphertext column via Vault Transit**. Rationale: you need per-tenant rows, SYSTEM-default resolution, OCC, and an admin UI (all DB strengths) **and** confidentiality (Vault strength). The synthesis is ciphertext-in-DB. **Never plaintext-in-DB; never a raw kv-v2 write per tenant** (kv-v2 has no OCC/cascade and explodes into per-tenant paths). *This is the security-vs-ease sweet spot and the reason the ticket exists.*
2. **Non-secret but admin-tunable?** → **Database.** Pick the sub-pattern by shape:
   - Needs multi-tier cascade, strong typing, or immutable audit → **Class 3** (dedicated table + resolver).
   - Simple global on/off or a number, low churn → **Class 4** (`GlobalSetting` KV). Use **Redis** only when the flip must fan out instantly to every instance (kill-switch).
   - Commercial plan capability/quota → **Class 5** (entitlements matrix).
3. **Deploy-time infra, never runtime-toggled by a human?** → **Class 6, env var.**

### 3.2 Anti-patterns (enforce in review)

- ❌ Admin-editable **non-secret** in Vault → wrong tool (no OCC/audit-UI/cascade, latency, kv-version churn). Put it in the DB.
- ❌ **Secret** in a DB plaintext column → always Vault-Transit ciphertext; **reject the write when `SECRETS_PROVIDER≠vault`** (follow TASK-496, not GlobalSetting's legacy plaintext fallback).
- ❌ Secret field **echoed** in a read DTO → write-only DTO + masked read (`hasKey`); reveal only behind step-up + audit; never logged.
- ❌ Mutation **without OCC** (If-Match/updateWithVersion) or **without a SysEvent** → 428/412 + audit are mandatory on every config write.
- ❌ A **fourth** bespoke toggle table when Class 3/4/5 already fits → register it, don't reinvent.
- ❌ **Enforcing** kill-switch defaulting **ON** → default OFF (fail-safe rollout), like `entitlements.enabled`.
- ❌ Per-controller **re-implementation** of cross-tenant resolution → one shared helper/decorator (Phase 2).

---

## 4. Control model — global admin vs tenant admin

Single enforcement path: **RBAC CASL subject** (who) × **`PolicyScope` GLOBAL/TENANT** (where) × **per-setting max-scope clamp** (how deep) × **working-tenant CLS** (which tenant), all under **404-over-403**.

| Authority | **Global admin** (`GLOBAL_ADMIN`, elevated) | **Tenant admin** (`TENANT_ADMIN`, tenant-bound) |
|---|---|---|
| Platform SYSTEM-tenant **defaults** (all Class-3 cascades) | ✅ set/override (`policy/global`, SYSTEM row) | ❌ (reads effective only) |
| **Plan** entitlement matrix (Class 5) | ✅ | ❌ |
| Per-tenant **entitlement override** | ✅ | ❌ (reads own capabilities via `entitlements/me`) |
| Global **kill-switches** (Class 4) | ✅ | ❌ |
| `GlobalSetting` platform rows / secrets | ✅ (reveal/rotate = step-up) | ❌ |
| AI model catalog + tiers, rate-limit tiers/routes | ✅ | ❌ |
| Own-tenant **Class-3 config** (within max-scope) | ✅ via working-tenant | ✅ (own tenant only) |
| Own-tenant **BYO secrets** (Class 2, write-only) | ✅ via working-tenant | ✅ |
| Tenant profile / frontend / storage / SSO / TTS config | ✅ via working-tenant | ✅ |
| Act on **another tenant** | ✅ (pick working tenant; every mutation banners "Acting on «Tenant»") | ❌ (foreign `?tenantId=` → 403; cross-tenant read → 404) |

**Max-scope clamp** (Class 3) is the delegation dial: e.g. `harnessEnabled` capped at DEPARTMENT (rollout knob, not a clinician preference), `dnaStyleEnabled` DOCTOR-only, `autoSummaryEnabled`/`autoNerEnabled` down to DOCTOR (`PIPELINE_SETTING_DESCRIPTORS`, `config-resolver.service.ts:72`). The registry (§5) makes this declarative for **every** setting, not just pipeline ones.

---

## 5. Target architecture — registry-driven control plane (do **not** invent a 4th storage)

Consolidate the three mechanisms behind one declarative catalog and one resolver. Four building blocks:

### 5.1 Capability & Settings Registry (new, code-defined)

A typed catalog — the single source of truth mapping each controllable variable to its policy. Location: `packages/applications/src/services/settings-registry/` (new module).

```ts
// settings-registry/registry.types.ts
export type StorageTier =
  | 'vault-kv'        // Class 1 — operator secret, not admin-editable (documented, not written here)
  | 'db-secret'       // Class 2 — ciphertext column via Vault Transit
  | 'db-config'       // Class 3 — dedicated table + cascade
  | 'global-kv'       // Class 4 — GlobalSetting/AppSettings
  | 'redis-flag'      // Class 4 — instant-fan-out kill-switch
  | 'entitlement'     // Class 5 — plan/tenant matrix
  | 'env';            // Class 6 — deploy infra (documented, resolved by IConfigService)

export type SettingScope = 'system' | 'tenant' | 'department' | 'doctor';

export interface SettingDescriptor {
  key: string;                    // canonical dotted key, e.g. 'pipeline.autoSummaryEnabled'
  tier: StorageTier;
  dataType: 'boolean' | 'number' | 'string' | 'enum' | 'json' | 'secret';
  sensitivity: 'public' | 'internal' | 'secret';
  maxScope: SettingScope;         // deepest tier a tenant admin may set (clamp)
  editableBy: string;             // CASL subject, e.g. 'PipelinePolicy' | 'GlobalSetting'
  globalOnly?: boolean;           // true = GLOBAL_ADMIN only (SYSTEM default / plan / kill-switch)
  category: string;               // SERVER-SIDE taxonomy (replaces client heuristic)
  default: unknown;               // code default (the last cascade fallback)
  transitKey?: 'hope-globalsetting' | 'hope-phi'; // Class 2 only
  validate?: (v: unknown) => void;
}
```

The registry is **assembled from each feature module** (pipeline, harness, tts, entitlements, frontend-config register their descriptors) so ownership stays with the feature, but the catalog is queryable centrally. It powers: server-driven categorization (gap #6), scope clamps (uniformly, not just pipeline), the admin UI's field metadata, and a machine-readable capability inventory that supersedes the hand-maintained `capabilities-matrix.md`.

### 5.2 Effective-config resolver (generalize the existing one)

Promote `config-resolver.service.ts` into a general `EffectiveSettingsService` that, given `(key, {tenantId, departmentId?, doctorId?})`, walks the cascade for that key's `maxScope`, short-circuits at first non-null, applies the clamp, and returns `{value, sourceScope, trace}`. Class 5 entitlements resolution (`resolveEntitlements`, `resolve-entitlements.ts`) plugs in as the resolver for `tier:'entitlement'` keys. One resolver, one trace format, used by both gateway runtime paths and admin "effective" reads.

### 5.3 Canonical secret-field crypto util (Phase 1, DRY)

`packages/applications/src/services/baseServices/_meta/secrets/secret-field.util.ts` (new): hoist `parseKeyVersionFromCiphertext`, `encryptFieldIntoEntity(entity, field, plaintext)`, `decryptFieldFromEntity(entity, field)` (the shape in `GlobalSettingRepository.encryption.ts:94-121`), plus a `requireTransit()` guard that throws the fail-fast "requires Vault" error. `GlobalSetting`, `TenantTtsProviderCredential`, and every future Class-2 field call this — one code path, one place to audit the crypto.

### 5.4 Shared cross-tenant resolution decorator (Phase 2)

`apps/api/src/decorators/resolveTenant.ts` (or an interceptor): centralize `resolveTenantId(caller, queryTenantId)` / `resolveReadTenantId` / `assertTenantInScope` so the four controllers stop diverging. Global-admin → `?tenantId=` (or CLS working tenant), `BadRequest` if absent; tenant-bound → pinned CLS tenant, `Forbidden` on foreign `?tenantId=`. Emits the SYSTEM-row special case for `policy/global` writes.

### 5.5 Uniform write path (already the house pattern — enforce for all new surfaces)

`findById` → tenant-ownership check (mismatch → **404**) → `updateEntity`/CAS → `hasChanges` guard → `updateWithVersion(id, entity, expectedVersion)` → `broadcastSysEvent(ResourceUpdated, {previousVersion,newVersion})` → for Class 3 sensitive policies, append a WORM change-log row in the **same `$transaction`**. Secret fields: write-only DTO, masked response, reveal/rotate behind `isSuperAdmin` + step-up password + `forceAuditLog`.

---

## 6. Implementation Plan (phased, TDD, each phase independently shippable)

> Layer order per `.claude/rules/01`: Database → Domain → Applications → API → Admin-console. Gates: `pnpm --filter <pkg> build test`, `pnpm lint` (treat `packages/*` only-warn as errors), affected E2E.

### Phase 0 — Foundations & decision record (docs only)
- Write this framework (§3) into `docs/development-patterns-and-standards.md` as the normative "Settings storage decision" section, and cross-link from `.claude/rules/04` (application services) and `05` (API).
- Correct the stale `capabilities-matrix.md` gap table (webhooks/notifications controllers now exist; TTS config shipped).
- **Gate:** doc review. No code.

### Phase 1 — Canonical secret-field crypto util (refactor, low risk, high leverage) — ✅ DONE (2026-07-12)

**Shipped:** `packages/applications/src/services/baseServices/_meta/secrets/secret-field.util.ts` — `parseKeyVersionFromCiphertext`, `encryptSecretField(secrets, plaintext, keyName?) → {ciphertext: Buffer, keyVersion}`, `decryptSecretField(secrets, ciphertext: Uint8Array, keyName?) → string`, structural `TransitCrypto` interface. Exported from the secrets barrel. `tenant-tts-config.service.ts` refactored to call the util (its private `parseKeyVersionFromCiphertext` + inline encrypt/decrypt deleted). Tests: `secret-field.util.test.ts` (12 cases) + existing `tenant-tts-config.service.test.ts` (7) = **19 passing**; `pnpm --filter @arcaai/applications build` clean; eslint clean on touched files.

**Layering decision (deviation from the original plan text):** the plan said "refactor **both** GlobalSetting and TTS." Only TTS was migrated. The GlobalSetting encrypt helper lives in `packages/domains` (`GlobalSettingRepository.encryption.ts`), and the domains package **cannot** import the applications-layer util without creating the cycle `applications → domains → applications`. No leaf package is a shared dependency of both layers (`@arcaai/utils` drags browser/ML code; `@arcaai/types` is type-only and not even a domains dep). Forcing a new cross-layer dependency edge to dedupe a 5-line pure function is over-engineering (`_karpathy` §2). Resolution: the applications-layer util is canonical for every **applications-layer** Class-2 secret field (TTS today, future SSO/SMTP/webhook secrets); the domains-layer `parseKeyVersionFromCiphertext` twin stays in place and is **documented in both files as behaviour-locked** — the two must not drift. This still delivers Phase 1's real goal (prevent a *third* copy; one audited applications-layer crypto path).

**Original plan for reference:**

- **Red:** unit tests for `secret-field.util.ts` — `encryptFieldIntoEntity`/`decryptFieldFromEntity` round-trip against the in-memory/mock Transit provider; `requireTransit()` throws when provider lacks `encrypt`; `parseKeyVersionFromCiphertext('vault:v3:..')===3`.
- **Green:** implement util (§5.3). Refactor `GlobalSettingRepository.encryption.ts` and `tenant-tts-config.service.ts:159-210,230-254` to call it. **Behavior-preserving** — existing suites for both must stay green.
- **Files:** new `.../secrets/secret-field.util.ts` (+ `__tests__`); edit the two callers.
- **Gate:** `pnpm --filter @arcaai/applications test` + `@arcaai/domains test` green; no behavior change in TTS/GlobalSetting e2e.

### Phase 2 — Shared cross-tenant resolution helper (refactor) — ✅ DONE (2026-07-12)

**Shipped:** `apps/api/src/shared/tenant-scope.ts` — pure `resolveScopedTenantId(user, callerTenantId, queryTenantId)`, `resolveScopedTenantIdOptional(...)` (list variant, admin may omit → `undefined`), `assertTenantInScope(user, targetTenantId, onForeign?)` (`'forbidden'` 403 default / `'notfound'` 404 for no-existence-leak surfaces). Style mirrors `interceptors/resolve-active-tenant.ts` (explicit inputs, no Nest DI). Migrated all four controllers to thin one-line private wrappers that delegate (call sites unchanged): `pipeline-policy-admin` + `tenant-tts-config-admin` (`resolveTenantId`), `harness-admin` (`resolveReadTenantId` + `resolveWorkflowListTenant`), `tenant` (`assertTenantInScope`, imported aliased to avoid the private-method name clash). Deleted the four duplicated bodies and the now-orphaned `isSuperAdmin`/`BadRequestException`/`ForbiddenException` imports they left behind. `tenant.controller.assertConfigInScope` kept bespoke — genuinely different logic (UUID-conditional + code-name deferral to the service's own 404 guard).

**Evidence:** new `tenant-scope.test.ts` (16 cases: 400/403/404 boundaries for all three helpers) + the 5 existing touched-module controller suites = **102 passing** (16 + 86); `pnpm build:api` clean (api + domains + applications); eslint **0 errors** on all 5 touched files. Remaining gate: the `apps/api/tests/e2e/task-307-*-cross-tenant.spec.ts` contracts require a live API (`pnpm test:api:up`) — behaviour is byte-identical to the originals and is fully covered by the new unit boundaries, so run these in CI/with infra to close the gate formally.

**Original plan for reference:**

- **Red:** unit tests for the helper: global-admin+query → query tenant; global-admin+no-query+working-tenant → CLS; tenant-bound+foreign query → `ForbiddenException`; tenant-bound+own → CLS; missing everywhere → `BadRequestException`. Reuse `tests/cross-tenant/fixtures.ts`.
- **Green:** implement `resolveTenant` helper/decorator (§5.4); migrate `tenant.controller.ts`, `harness-admin.controller.ts`, `pipeline-policy-admin.controller.ts`, `tenant-tts-config-admin.controller.ts` to it, deleting the four local copies.
- **Gate:** unit + the `task-307-*-cross-tenant.spec.ts` e2e contracts still pass (they lock 404-over-403).

### Phase 3 — Settings registry + generalized resolver (the centerpiece) — 🟡 IN PROGRESS

**3a — Registry core ✅ DONE (2026-07-12).** New module `packages/applications/src/services/settings-registry/`: `registry.types.ts` (`StorageTier` = the 7 §3 data classes, `SettingScope` + `SCOPE_DEPTH`, `SettingSensitivity`, `SettingDataType`, `SettingDescriptor`), `settings-registry.ts` (`SettingsRegistry` container — `register`/`registerAll` with duplicate-key rejection, `get`/`getOrThrow`/`has`/`list`/`size`, `categoriesOf`, and the **uniform `assertWithinMaxScope`** clamp throwing `ArgumentInvalidException` → 400, generalizing the pipeline-only clamp to every setting), `descriptors/` (pipeline sourced FROM `PIPELINE_SETTING_DESCRIPTORS` so maxScope/default stay single-sourced — no behaviour change to `ConfigResolver`; TTS BYO `db-secret` credentials; entitlements kill-switch + feature flags), `registry.ts` (`HOPE_SETTINGS_REGISTRY` assembled singleton). Exported via the services barrel. Only **verified** settings registered (no speculative keys). Tests: `settings-registry.test.ts` **13 passing**; `pnpm --filter @arcaai/applications build` clean; eslint clean.

**3b — Generalized cascade primitive ✅ DONE (2026-07-12).** Rather than a speculative mega-resolver (each tier already has a working data-access resolver — pipeline `ConfigResolver`, entitlements `resolveEntitlements`, tts `resolveEffectiveTtsConfig`), extracted the shared *core*: `settings-registry/scope-cascade.ts` — pure `walkCascade(tiers, codeDefault)` (first-set-wins; `false`/`0`/`""` count as set; else `code-default`) with `CascadeTier`/`CascadeResult`. Refactored `ConfigResolver.resolveOne` to build the max-scope-honoring tier list then delegate to `walkCascade` — **behaviour-preserving** (all 18 config-resolver tests green). Dependency-free primitive → no intra-package import cycle. Tests: `scope-cascade.test.ts` 5 + registry 13 + resolver 18 = **36 passing**; build+lint clean. (A full multi-tier `EffectiveSettingsService` facade is deliberately deferred — the shared primitive + registry clamp are the reusable core; unifying data access behind one interface is a larger design not justified now, `_karpathy` §2.)

**3c — Catalog endpoint ✅ DONE (2026-07-12).** `apps/api/src/modules/settings-catalog/` — `GET /api/v1/admin/settings/catalog` serves the RBAC-filtered registry (metadata only, never a value): tenant admins do not see `globalOnly` entries, global-admins see all; response `{ items, categories(sorted, distinct) }`. Gated `@CanRead('GlobalSetting')`. **Route-collision handled:** `admin/settings/:id` (GlobalSetting, via `@ApiEndpoint path: ':id'`) would capture `catalog` — so `SettingsCatalogModule` is registered BEFORE `GlobalSettingModule` in `app.module` (comment documents the ordering constraint). Tests: `settings-catalog.controller.test.ts` **4 passing**; `build:api` clean; eslint clean.

**3c — client heuristic replacement: SCOPED DOWN (documented).** The admin-console `config-categories.ts` buckets *open-ended tenant KV keys* (`user/me/settings`, `tenant/me/config`) that are NOT in the registry — a wholesale swap to server categories would be incorrect for dynamic keys. The catalog endpoint is the deliverable; it will be consumed by the new TTS admin UI (Phase 4). Registering the full open-ended KV namespace taxonomy is a follow-up, not this ticket.

**Original plan for reference:**

- **Red:** tests for `SettingsRegistry.get(key)`, duplicate-key rejection, `maxScope` clamp enforced on write for a registered key, `category` returned server-side; `EffectiveSettingsService.resolve(key, ctx)` cascade + trace for a boolean and an enum key.
- **Green:**
  1. New module `settings-registry/` (§5.1); each feature module registers its descriptors (pipeline/harness/tts/entitlements/frontend-config). Start by **describing existing settings** — no new storage.
  2. Promote `config-resolver.service.ts` → `EffectiveSettingsService` (§5.2); keep `resolvePipelineToggles` as a thin adapter so no caller breaks.
  3. Expose `GET /api/v1/admin/settings/catalog` (registry inventory, RBAC-filtered to what the caller may edit) and use it to replace the client-side `config-categories.ts` heuristic with server categories (gap #6).
- **Gate:** applications + api unit green; admin-console `tenant-settings-tab` reads categories from the catalog endpoint (add a hook), no visual regression.

### Phase 4 — Admin surfaces & gap closure — 🟡 IN PROGRESS

**TTS-config admin UI ✅ DONE (2026-07-13)** — gap #1 closed, built to design-system best practices (rules 07/10/11/13) **without waiting on a Figma frame** (per explicit direction). New feature `apps/admin-console/src/features/tenant-tts-config/`:
- `api/` — `types.ts` (wire DTOs), `keys.ts`, `client.ts` (OCC row PUT with `If-Match`/`expectedVersion`, `FIRST_EDIT_ETAG='"0"'` for create; non-versioned credential set/remove), `hooks.ts` (TanStack Query), `index.ts`.
- `components/` — `tts-config-fields.ts` (declarative field metadata + sparse-patch builder, parses comma-lists, coerces empty→null), `tts-config-form.tsx` (OCC editor, `OccConflictAlert` reload-merge, Select for format), `tts-credentials-tab.tsx` (BYO write-only key cards — masked `hasKey`/`keyVersion` badges, password field, rotate/remove-with-confirm), `tenant-tts-config-screen.tsx` (`WorkingTenantGate` + `ScreenTemplate` + tabs Configuration/Credentials, effective resolve card, skeletons).
- Route `app/(console)/(tenant)/tts-config/{page,loading}.tsx`; nav entry `/tts-config` (tier 30-49, `IconVolume`, `[['read','TenantTtsConfig'],['manage','TenantTtsConfig']]`) — mirrors the controller's `@Authorize` pairs.
- **Evidence:** `tenant-tts-config-screen.test.tsx` **5 passing** (render, OCC save asserts `if-match:"7"` + body `{sampleRate,expectedVersion:7}`, 412 reload-merge keeps drafts, credential rotate asserts write-only `PUT credentials/azure`, error+retry); eslint clean; `tsc --noEmit` clean for the feature (pre-existing `toHaveNoViolations` typing errors in unrelated rbac/detail-drawer tests are untouched).
- **Remaining verification gate (infra):** live browser pass + per-screen axe scan on the running app — needs the authenticated dev stack (API+DB+Vault+session) past the BFF login; not bootable standalone here. The sibling harness-policy feature is tested the same way (axe is a separate screen gate, not colocated).

**Settings version-history API — DEFERRED (documented).** `GET /admin/settings/:id/versions` needs audit-service/WORM-projection integration on the global-setting module; lower priority than the best-practice framework (Phase 5) which is the ticket's core ask. Tracked as a follow-up. The Settings History tab keeps its audit-log reprojection meanwhile.

**Webhooks/Notifications UI — out of scope** (separate follow-up; backends exist, no screens).

**Original plan for reference:**

- **TTS-config admin UI** (gap #1): new `apps/admin-console/src/features/tenant-tts-config/` — effective view + row edit (OCC) + BYO credential management (write-only key input, `hasKey` badge, no reveal). Consumes existing `admin/tts-config` endpoints. Tier 30–49; nav entry; skeletons; both themes; axe 0. Follows `07/10/11/13` rules and the `DetailDrawer`/`ScreenTemplate` contracts.
- **Settings version-history API** (gap #5): first-class `GET /admin/settings/:id/versions` backed by the WORM change-log (Class 3) or audit projection (Class 4), replacing the History-tab reprojection.
- **(Optional, if in scope) Webhooks/Notifications UI** (gap #2) — backend exists; wire screens or explicitly defer with a follow-up ticket.
- **Gate:** `pnpm --filter @arcaai/admin-console build lint test`; Playwright E2E for the new TTS screen; designer build-review per `12-design-workflow`.

### Phase 5 — Governance & verification — 🟡 IN PROGRESS

**Framework recorded ✅ DONE (2026-07-13).** The §3 Vault-vs-DB decision framework (the ticket's core ask) is now normative in `docs/development-patterns-and-standards.md` §6.10 "Settings storage — Vault vs Database": the data-class → storage table, the anti-patterns, and pointers to the TASK-504 reusable primitives (`secret-field.util.ts`, `settings-registry/`, `tenant-scope.ts`). This is the authoritative reference every future settings PR is checked against.

**Kill-switch inventory ✅ DONE (2026-07-13).** `SettingsRegistry.killSwitches()` returns every descriptor marked `killSwitch: true` and **throws if any defaults ON** (fail-safe governance invariant, test-enforced); `entitlements.enabled` is marked. **Wider WORM coverage:** assessed as not needed (class-3 tables already WORM; class-4 `GlobalSetting` uses the envelope-encrypted AuditLog appropriately). Remaining = the live-infra verification gates only.

**Original plan for reference:**
- Extend WORM change-log coverage to any Class-3 table still on the generic AuditLog if it holds sensitive policy.
- Registry-drive the kill-switch inventory (one place lists every Class-4 flag + its default; assert enforcing flags default OFF).
- Full evidence capture (test/build/lint output) into this README's Implementation Summary; set status.
- **Gate:** all affected package gates + e2e green; docs updated; user confirms.

---

## 6.5 Implementation Summary (2026-07-13)

Shipped this pass — every unit TDD'd, built, lint-clean:

| Phase | What shipped | Tests | Notes |
|---|---|---|---|
| 1 | `secret-field.util.ts` canonical class-2 crypto; TTS refactored to it | 19 | domains GlobalSetting twin annotated behaviour-locked (cycle blocks cross-layer dedupe) |
| 2 | `apps/api/src/shared/tenant-scope.ts` (3 pure helpers); 4 admin controllers migrated | 102 (16 + 86 regressions) | orphaned imports removed; live task-307 e2e = infra gate |
| 3a | `settings-registry/` typed catalog + uniform `assertWithinMaxScope` clamp + `HOPE_SETTINGS_REGISTRY` | 13 | only verified settings registered |
| 3b | `scope-cascade.ts` `walkCascade`; `ConfigResolver.resolveOne` refactored behaviour-preserving | 36 (incl. 18 resolver regressions) | shared cascade core |
| 3b+ | `EffectiveSettingsService` facade (registry-key-addressed effective read + trace; refuses secret keys; delegates to `ConfigResolver`) + `EffectiveSettingsModule` | 4 | delegates to existing tier resolvers — no data-access rewrite |
| 3c | `GET /admin/settings/catalog` (RBAC-filtered, route-collision handled via module order) + `GET /admin/settings/effective` (consumes the facade; scoped + secret-refusing) | 7 | client KV-heuristic swap scoped down (open-ended keys ≠ registry) |
| 4 | `apps/admin-console/.../tenant-tts-config/` full feature (OCC editor + BYO write-only creds + nav + route) | 5 | best-practice build, no Figma wait; browser+axe = infra gate |
| 5 | §3 framework recorded normative in `development-patterns-and-standards.md` §6.10; **kill-switch inventory** (`SettingsRegistry.killSwitches()` asserts enforcing flags default OFF; `entitlements.enabled` marked) | 3 | governance invariant now test-enforced |

**Consolidated evidence (2026-07-13):** applications **62**, api **23**, admin-console **5** = **90 tests** — all green. `build:api` + `@arcaai/applications build` + admin-console `tsc --noEmit` clean; eslint 0 errors on all touched files.

**Closed as non-goals (with rationale), not gaps:**
- **Settings version-history API** — NOT built: the general `GET /api/v1/admin/audit-logs/resource/:resourceType/:resourceId` (`audit-log.controller.ts:218`) already IS the resource-history surface the Settings History tab consumes. A settings-specific `/versions` endpoint would re-wrap the same audit data (redundant).
- **Wholesale client `config-categories.ts` swap** — NOT done: it buckets open-ended tenant KV keys that are not in the registry; the catalog endpoint stands as the server-driven source for registry-known keys. A client `useSettingsCatalog` hook was left unbuilt (no strong consumer yet — would be speculative).
- **Wider WORM coverage** — not needed: class-3 policy tables already have WORM change-logs; class-4 `GlobalSetting` uses the (envelope-encrypted) generic AuditLog appropriately.
- **Webhooks/notifications admin UI** — separate follow-up ticket (backends exist, no screens).

**Infra-gated verification:**
- ✅ **Vault-live BYO secret round-trip — PASS (2026-07-13).** Drove the *built* `secret-field.util` (`encryptSecretField`/`decryptSecretField`/`parseKeyVersionFromCiphertext`) against the live dev Vault Transit key `hope-globalsetting`: ciphertext is `vault:v1:…`, key-version parse matches, decrypt === original, no plaintext in the ciphertext. Phase 1's class-2 crypto core validated end-to-end against real Vault (not the test fake).
- ⛔ **Live cross-tenant e2e (task-307)** and **browser + per-screen axe on the TTS screen** — blocked by a concurrent session holding the dev API on port 8868 (`test:api:up` refuses the port; won't kill the other process or pollute its dev DB). Behaviour is already covered by unit suites (Phase 2 exact 400/403/404 boundaries; Phase 4 jsdom suite driving real BFF request shapes). Run when 8868 is free: `pnpm test:api:up` then `pnpm test:e2e apps/api/tests/e2e/task-307-*`.

**Full regression (2026-07-13):** `pnpm lint` 29/29 tasks, 0 errors. Package suites: applications **6237 passed**, api **2157 passed** (+5 PRE-EXISTING `env-port-standardization` failures re `TTS_URL`/`TTS_PORT` from the uncommitted TTS branch work — `.env` files untouched by TASK-504), admin-console **923 passed**. Zero regressions from TASK-504.

---

## 7. Verification criteria (definition of done)

- [ ] §3 framework recorded in `docs/development-patterns-and-standards.md`; rules cross-linked.
- [ ] One canonical secret-field crypto util; GlobalSetting + TTS both call it; no plaintext-at-rest for Class-2 (write rejected without Vault).
- [ ] One cross-tenant resolution helper; four controllers migrated; `task-307-*-cross-tenant` e2e green.
- [ ] Settings registry describes every existing controllable variable; `maxScope` clamp enforced uniformly; server-side categories replace the client heuristic.
- [ ] One `EffectiveSettingsService` with trace; pipeline/entitlements plug in; runtime + admin reads share it.
- [ ] Every config write: 428/412 OCC + SysEvent audit; sensitive policies WORM-logged in-transaction; secrets write-only + masked + step-up-on-reveal.
- [ ] TTS-config admin UI shipped (gap #1); version-history API (gap #5).
- [ ] `pnpm lint` clean (only-warn treated as error); affected package builds + tests + e2e green with pasted evidence.
- [ ] Both themes + axe 0 on new screens; global-admin and tenant-admin authority table (§4) verified by e2e.

---

## 8. Risks & notes for the executing agent

- **Vault dependency for Class-2 writes**: dev defaults to `SECRETS_PROVIDER=env`, so BYO-secret write paths **reject** unless the dev has Vault up (`pnpm infra:up` with the `vault` profile + `refresh-vault-creds.sh`). Tests must mock/inject a Transit-capable provider; do not add a plaintext fallback to make tests pass.
- **Migrations**: per project memory, dev/test Postgres is `db push`-managed and behind migration history — new columns/tables go via additive SQL applied with psql, and `@arcaai/database`/`@arcaai/domains` must be rebuilt after client/enum changes (vitest reads dist). New domain models are hand-authored where `gen:mapper`/`gen:repository` crash. Confirm current state before any schema step.
- **Don't break OCC contracts**: the `FIRST_EDIT_ETAG='"1"'` create path and per-row bulk-PATCH behavior are load-bearing — preserve them.
- **Redis kill-switch** (live-doc engine) is deliberately un-versioned and instance-fan-out; don't force it into the OCC mold — it's the Class-4 `redis-flag` variant.
- **Scope discipline** (`_karpathy`): Phases 1–2 are pure refactors (behavior-preserving); Phase 3 adds description without moving storage; only Phase 4 adds surface. Keep them separable so each ships alone.

---

## 9. Change History

| Date | Author | Change |
|---|---|---|
| 2026-07-12 | plan pass | Initial plan authored from 4-scout exploration of secrets/config storage, feature-flag/entitlement gating, admin authorization tiers, and the TASK-496 BYO exemplar. Status Pending — awaiting ticket-number confirmation + scope approval. |
| 2026-07-12 | impl | Renamed TASK-500 → TASK-504, scope approved. Phase 1 (canonical secret-field crypto util) started. |
| 2026-07-12 | impl | Phase 1 ✅ (secret-field.util.ts; TTS refactored; 19 tests; build+lint clean; domains twin annotated). Phase 2 ✅ (shared tenant-scope.ts; 4 controllers migrated; 102 tests; build+lint clean; live e2e gate deferred to infra/CI). |
| 2026-07-12 | impl | Phase 3a ✅ (settings-registry module: types + container + uniform max-scope clamp + verified descriptors + HOPE_SETTINGS_REGISTRY; 13 tests; build+lint clean). 3b (resolver generalization) + 3c (catalog endpoint + client categories) pending. |
| 2026-07-13 | impl | Phase 3b ✅ (scope-cascade.ts walkCascade primitive; ConfigResolver refactored behaviour-preserving; 36 tests; full EffectiveSettingsService facade deliberately deferred). Phase 3c ✅ backend (settings-catalog module + GET /admin/settings/catalog RBAC-filtered, route-collision handled via module ordering; 4 tests; build+lint clean); client heuristic swap scoped down (open-ended KV ≠ registry keys — documented). Phase 4 (TTS admin UI best-practice, no Figma wait) + version-history API next. |
| 2026-07-13 | impl | Phase 4 ✅ TTS admin UI (feature `tenant-tts-config`: OCC row editor + BYO write-only credentials + nav + route; 5 tests; lint+typecheck clean; browser/axe = infra gate). Version-history API + webhooks UI deferred. Phase 5 ✅ framework recorded in development-patterns-and-standards.md §6.10. Consolidated: applications 55 / api 20 / admin-console 5 green. See §6.5 Implementation Summary. |
| 2026-07-13 | impl | Remaining-items pass: `EffectiveSettingsService` facade + `EffectiveSettingsModule` + `GET /admin/settings/effective` (registry-key effective read w/ trace, secret-refusing, tenant-scoped); kill-switch inventory (`killSwitches()` governance invariant). Reclassified version-history API (already covered by generic audit-resource endpoint) + client-catalog wiring (speculative) + wider WORM (not needed) as documented non-goals. Consolidated: applications 62 / api 23 / admin-console 5 = 90 green; build+lint clean. |
