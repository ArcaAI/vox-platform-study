# AI Provider Configuration — Backend Data Model & Resolution Audit

Repo: `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2`, branch `dev-2.2`, audited 2026-09-01.
READ-ONLY. No file edited, no migration or db command run.

Purpose: design input for a consolidation redesign toward the product owner's target
(one screen, task-scoped provider configurations, exactly one platform default per task,
tenant BYOK over a SYSTEM fallback, platform-admin-only self-host engines, cross-tenant
promotion, masked JSON export/import, one provider config per agent node).

Paths are absolute-from-repo-root. Every claim carries `file:line`. Anything not verified is
marked **UNKNOWN**.

---

## A. MODEL CATALOGUE

Schema is multi-file under `packages/database/src/prisma/db_main/*.prisma`. Allow-lists:
`TENANT_SCOPED_MODELS` / `SYSTEM_SHARED_READ_MODELS` in
`packages/database/src/extensions/tenant-scope.ts:52` / `:372`;
`MODELS_WITHOUT_SOFT_DELETE` in `packages/database/src/client.ts:95`.

**None of the AI config models appear in `MODELS_WITHOUT_SOFT_DELETE`** (verified against the
full list at `packages/database/src/client.ts:95-230`) — every one of them soft-deletes.

### A1. `AiProviderConnection` — WHERE a provider lives + HOW to authenticate
`packages/database/src/prisma/db_main/ai-provider-connection.prisma:51-89`

| Field | Notes |
|---|---|
| `metaData` Json? (`_metadata`) | :53 |
| `version` Int (`_version`) | :54 — OCC counter |
| `id` String uuid(7) | :55 |
| `tenantId` String | :58 — SYSTEM row = platform default |
| `service` String `@default("llm")` | :61 — capability discriminator, **plain TEXT, no DB CHECK** (schema header :28-30) |
| `provider` String | :62 — capability-scoped provider id |
| `baseUrl` String? | :63 |
| `region` String? | :64 |
| `apiVersion` String? | :65 |
| `deploymentName` String? | :66 |
| `encryptedApiKey` Bytes? | :67 — Vault-Transit ciphertext |
| `keyVersion` Int? | :68 |
| `enabled` Boolean `@default(false)` | :69 — three-state semantics (no row / enabled+keyed / disabled=veto) |
| `extraJson` Json? | :70 |
| resourceStatus / …UpdatedAt / …UpdatedBy | :73-75 |
| createdBy/updatedBy/createdAt/updatedAt | :78-81 |

Constraints: `@@unique([tenantId, service, provider])` :84 · indexes `[tenantId, service]` :85,
`[service, provider]` :86, `[provider]` :87.

Scoping: `TENANT_SCOPED_MODELS` (`tenant-scope.ts:155`) **and** `SYSTEM_SHARED_READ_MODELS`
(`tenant-scope.ts:437`) — reads widen to `[caller, SYSTEM]`, writes never widen. It is the
**first and only secret-bearing model in the shared-read list** (caveat at `tenant-scope.ts:428-436`).
Soft-delete: YES.

**There is NO `taskKey` column and no `isDefault` column.** The natural key is
`(tenant, service, provider)` — i.e. one row per provider per capability, *not* per task.

### A2. `AiTaskDefault` — ONE default model per (tenant, task)
`packages/database/src/prisma/db_main/ai-task-default.prisma:23-53`

| Field | Notes |
|---|---|
| meta trio (`metaData`/`version`/`id`) | :25-27 |
| `tenantId` | :30 |
| `taskKey` String | :33 |
| `modelSlug` String | :34 — references `AiModel.slug`, **no FK** (house convention) |
| `configJson` Json? | :35 |
| resourceStatus trio, audit quad | :38-46 |

Constraints: `@@unique([tenantId, taskKey])` :49 · indexes `[tenantId]` :50, `[taskKey]` :51.
Scoping: `TENANT_SCOPED_MODELS` (`tenant-scope.ts:143`) + `SYSTEM_SHARED_READ_MODELS`
(`tenant-scope.ts:421`). Soft-delete: YES.

**This is the only model that today expresses "the default for a task", and its cardinality is
one row per (tenant, task) — not "many candidates, one flagged default".**

### A3. `AiModel` — model registry (lives in `stt.prisma`, historically)
`packages/database/src/prisma/db_main/stt.prisma:114-201`

| Field | Notes |
|---|---|
| meta trio | :116-118 |
| `tenantId` | :121 |
| `name` / `slug` / `description` | :124-126 |
| `category` ModelCategory | :129 |
| `taskType` ModelTaskType | :130 |
| `modelType` ModelType | :131 |
| `source` AiModelSource | :144 — HUGGINGFACE, GITHUB, **MLFLOW**, LOCAL, S3 (`enums.prisma:348-356`) |
| `sourceUri` String | :145 — the provider-native model id actually sent downstream |
| `sourceRevision` String? | :146 |
| `format` AiModelFormat | :149 |
| `provider` String? | :153 — `ollama \| lm-studio \| azure \| bedrock \| built-in \| sarvam` (+ free string) |
| `architecture` String? | :154 |
| `memorySizeMb` / `computeType` | :157-158 |
| `downloadStatus` / `localPath` / `downloadedAt` / `fileSizeMb` / `checksum` | :163-175 |
| resourceStatus trio, audit quad, `tags` | :178-187 |

Constraints: `@@unique([tenantId, slug])` :192 · indexes on tenantId/category/taskType/source/
format/provider/resourceStatus :193-199.
Scoping: `TENANT_SCOPED_MODELS` (`tenant-scope.ts:90`) + `SYSTEM_SHARED_READ_MODELS`
(`tenant-scope.ts:374`). Soft-delete: YES.

`provider` here is a **free string with no FK to `AiProviderConnection.provider`** — the join
between "which model" and "which connection" is by string equality only.

### A4. `AiRuntimeProfile` — hyperparameters / concurrency
`packages/database/src/prisma/db_main/ai-runtime-profile.prisma:16-55`

Fields: meta trio :18-20; `tenantId` :23; `provider` :26; `modelSlug` `@default("")` :27
(**empty-string sentinel** = provider-level default, deliberately not NULL, :8-11);
`temperature` :28, `topP` :29, `maxTokens` :30, `contextLength` :31, `maxConcurrent` :32,
`tpmLimit` :33, `rpmLimit` :34, `timeoutS` :35, `keepAliveSeconds` :36, `extraJson` :37;
resourceStatus trio :40-42; audit quad :45-48.
Constraints: `@@unique([tenantId, provider, modelSlug])` :51 · `[tenantId]` :52, `[provider]` :53.
Scoping: `TENANT_SCOPED_MODELS` (`tenant-scope.ts:160`) + `SYSTEM_SHARED_READ_MODELS`
(`tenant-scope.ts:441`). Soft-delete: YES. Rows are SYSTEM-only by service enforcement
(header :6-7).

### A5. `AiRoutingPolicy` — ordered N-way candidate chain (TASK-818, SHIPPED but ORPHANED)
`packages/database/src/prisma/db_main/ai-routing-policy.prisma:42-122`

Fields: meta trio :44-46; `tenantId` :49; `taskKey` :52; `policyVersion` Int `@default(1)` :61
(authored revision, distinct from `_version`); `status` AiRoutingPolicyStatus :63;
`strategy` AiRoutingStrategy :64; `explicitProviderMode` :65; `priority` :69;
`killSwitch` Boolean `@default(false)` :72; `matchJson` :76; **`candidatesJson` Json (required)** :77
(`[{rank, weight, connectionRef, model, residency, baaCovered, maxTtftMs}]`); `fallbackJson` :78;
`healthJson` :79; `maxConcurrentStreams` :85, `requestsPerMinute` :86, `tokensPerMinute` :87;
`affinityJson` :91; `supersedesVersion` :95, `activatedAt` :96; resourceStatus trio :99-101;
audit quad :104-107.
Constraints: `@@unique([tenantId, taskKey, policyVersion], map: "AiRoutingPolicy_tenantId_taskKey_policyVersion_unique")` :119 ·
`@@index([tenantId, taskKey])` :120.
Scoping: `TENANT_SCOPED_MODELS` (`tenant-scope.ts:168`) + `SYSTEM_SHARED_READ_MODELS`
(`tenant-scope.ts:451`). Soft-delete: YES. Migration `20260830103000_task_818_ai_routing_policy`.

**Critical: this model has NO runtime consumer.** `IAiRoutingPolicyService` is injected only by
`apps/api/src/modules/ai-routing-policy/ai-routing-policy-admin.controller.ts:85` — nothing in
`apps/text`, `apps/harness` or the consultation services reads it.

### A6. Adjacent models that also carry provider/model selection

| Model | File:line | Role | Scoping / soft-delete |
|---|---|---|---|
| `AsrPipeline` | `stt.prisma:12-67` | STT engine selection **by YAML** (`configYaml` :28 references model slugs); `isDefault` :31; `@@unique([tenantId, slug])` :61; `sourceTemplateSlug`/`templateLocked` :41-42 | TENANT_SCOPED (`tenant-scope.ts:88`) + SYSTEM_SHARED_READ (`:373`); soft-delete YES |
| `AsrPipelineVersion` | `stt.prisma:74-106` | immutable config history | TENANT_SCOPED (`:89`); **in MODELS_WITHOUT_SOFT_DELETE** (`client.ts:104`) |
| `TenantSttConfig` | `tenant-stt-config.prisma:28-61` | one row per tenant (`tenantId @unique` :35); `fallbackPipelineId` :43, `autoSwitchEnabled` :44, `configJson` :45 | TENANT_SCOPED (`:141`) + SYSTEM_SHARED_READ (`:415`); soft-delete YES |
| `TenantTtsConfig` | `tenant-tts-config.prisma:24-62` | one row per tenant (`tenantId @unique` :31); `routingEn`/`routingMl` :38-39 (ordered provider chains), `allowedProviders` :40, voices/format/speed/sampleRate :36-44, `configJson` :46 | TENANT_SCOPED (`:136`) + SYSTEM_SHARED_READ (`:408`); soft-delete YES |
| `HarnessPolicy` | `harness.prisma` | **legacy** `textProvider` :367 / `textModel` :368 — still the precedence-2 fallback of the text resolver; `judgeModel` :151/:208 | (in TENANT_SCOPED + SYSTEM_SHARED_READ as `HarnessPolicy`, `tenant-scope.ts:396`) |
| `WorkflowDefinition` node config | no column — JSON key `llmBinding.modelSlug` (`packages/applications/src/services/workflow-definition/node-llm-binding.ts:33-35`) | per-node model binding | n/a |
| `AiUsageEvent` / `AiPriceBook` / `AiUsageRollup*` | `usage-ledger.prisma:51,196,273,324` | metering, funding label BYOK vs CLOUD | in `MODELS_WITHOUT_SOFT_DELETE` (`client.ts` list) |

Retired predecessors (documented in schema headers, tables dropped):
`TenantTtsProviderCredential` (`tenant-tts-config.prisma:16-21`) and
`TenantSttProviderCredential` (`tenant-stt-config.prisma:18-23`) — both folded into
`AiProviderConnection` with `service='tts'` / `'stt'`.

---

## B. RESOLUTION CASCADE

### B1. The relationship graph (text form)

```
                      (string equality only — NO FK anywhere in this graph)

  taskKey  ──1:1──▶  AiTaskDefault(tenantId, taskKey)
   e.g.                    │ .modelSlug
  "text.finalize"          ▼
                     AiModel(tenantId, slug)  ── .provider (string) ──┐
                           │ .sourceUri  = provider-native model id   │
                           │ .taskType   = compatibility gate         │
                           ▼                                          ▼
              {provider, model} pair sent to apps/text     AiProviderConnection(tenantId, service, provider)
                                                                      │ .encryptedApiKey / .baseUrl / …
                                                                      ▼
                                                          provider_overrides[provider] on the wire

  AiRuntimeProfile(tenantId, provider, modelSlug|"")  ── merged into request hyperparameters
  AiRoutingPolicy(tenantId, taskKey, policyVersion)   ── candidatesJson[].connectionRef → AiProviderConnection.provider   (NO RUNTIME READER)
  WorkflowGraph node.config.llmBinding.modelSlug      ── precedence-0 override of the taskKey tier
```

So today a task is bound to a *model*, and the *provider* is derived from that model row
(`AiModel.provider`); the *credential* is then a second, independent lookup keyed by
`(service, provider)`. There is no single row that is "a provider configuration for a task".

### B2. Exact runtime order — LLM / text generation

The one fail-closed seam every TypeScript `/generate` caller funnels through is
`HarnessPolicyService.resolveTextSelection`
(`packages/applications/src/services/harness-policy/harness-policy.service.ts:593-616`):

| # | Step | file:line |
|---|---|---|
| 0 | **Node binding.** If the executing workflow node carries `config.llmBinding.modelSlug`, it wins outright and **fails closed** | `harness-policy.service.ts:602` → `resolveBoundNodeSelection` `:549-573`; reader `workflow-definition/node-llm-binding.ts:57-63` |
| 1 | **`AiTaskDefault` for the task key** (`text.live` / `text.finalize` / `text.test`) | `harness-policy.service.ts:605` → `resolveTextSelectionForKey` `:506-522` |
| 1a | inside it: `AiTaskDefaultService.getEffective` — tenant row, then SYSTEM row | `ai-task-default.service.ts:65-93`; the two reads at `:74-79`; winner at `:81` |
| 1b | slug → `AiModel`: tenant-owned ENABLED row first, else SYSTEM row | `ai-task-default.service.ts:287-293` |
| 1c | `{provider: model.provider, model: model.sourceUri}`, with the runtime alias `azure → azure-openai` | `harness-policy.service.ts:513` |
| 2 | **Legacy `HarnessPolicy.textProvider/textModel`** cascade (tenant row → SYSTEM default → code default) | `harness-policy.service.ts:609-612` |
| 3 | Neither resolved ⇒ `BadRequestException` (**fail closed**) | `harness-policy.service.ts:611-614` |
| 4 | **Credential injection.** `TextRequestEnrichmentService.applyTenantProviderOverrides` resolves `AiProviderConnection` for `service='llm'` and folds ONLY the selected provider's entry into `provider_overrides` | `text-request-enrichment.service.ts:78-132`; invoked from `apps/api/src/modules/streaming/text-proxy.controller.ts:320-368` |
| 5 | **Hyperparameters.** `applyTextRuntimeProfile` merges `AiRuntimeProfile` (caller params win) | `text-request-enrichment.service.ts:219-256` |
| 6 | **Fallback tier** (opt-in, fail-OPEN): `text.<task>.fallback` `AiTaskDefault` key; no SYSTEM default by design | `harness-policy.service.ts:634-636` |

The credential cascade itself (`AiProviderConnectionService`,
`packages/applications/src/services/ai-provider-connection/ai-provider-connection.service.ts`):

| # | Step | file:line |
|---|---|---|
| a | read the tenant tier for `(service, provider?)` | `:454` `cascadeRows` → `readTier` `:545-552` |
| b | build the **veto set**: tenant row that is `enabled=false` AND cloud-BYO ⇒ this provider is blocked entirely, including the platform key | `:480` (`vetoed` construction; the tenant-tier read is at `:471`) |
| c | caller **is** SYSTEM ⇒ no tier above; return | `:485-486` |
| d | entitlement gate `featurePlatformDefaultCredential` — applies only to cloud providers; **denies when no entitlements service is wired** | `mayConsumePlatformDefault` `:566-570`; descriptor `settings-registry/descriptors/entitlements.descriptors.ts:67` |
| e | read the SYSTEM tier | `:530` |
| f | fold: SYSTEM first, then tenant rows **over** it, per provider key; skip `!enabled \|\| !encryptedApiKey`; tenant tier may only carry cloud-BYO providers | `resolveTenantCloudOverrides` `:321-379` |
| g | decrypt via Vault Transit; `funding` **derived** from `row.tenantId === SYSTEM_TENANT_ID` | `toOverrideEntry` `:588-...`; `fundingOf` `:734-736` |
| h | single-credential projection for Python pull consumers, four outcomes `resolved / absent / denied / unavailable` | `resolveCredential` `:651-711` |
| i | by-provider direct read (no decrypt) | `resolveConnection` `:287-302` — veto at `:293`, tenant at `:297`, SYSTEM at `:299`, else `null` |

### B3. Exact runtime order — STT

STT does **not** use `AiTaskDefault`. Selection is by `AsrPipeline.configYaml`
(`stt.prisma:26-28`), with the tenant default pipeline flagged by `AsrPipeline.isDefault`
(`stt.prisma:31`) and a tenant-level fallback pointer `TenantSttConfig.fallbackPipelineId`
(`tenant-stt-config.prisma:43`). Credentials are pulled by the worker:

- `apps/stt/src/stt/core/effective_config.py:151-198` → `GET /internal/stt/provider-overrides`
  (**fails open** to `{}` on error, `:156-158`),
- gateway side `apps/api/src/modules/internal/stt-internal.controller.ts:357-370` →
  `TenantSttConfigService.resolveProviderOverrides`
  (`packages/applications/src/services/tenant-stt-config/tenant-stt-config.service.ts:522-536`)
  → `resolveTenantCloudOverrides('stt', tenantId)`,
- weight-fetch credentials pulled separately and **fail closed**:
  `apps/stt/src/stt/core/model_credentials.py:88-198` →
  `GET /internal/stt/model-registry-credential` (`stt-internal.controller.ts:308-347`).

### B4. Exact runtime order — TTS

TTS does **not** use `AiTaskDefault` either. Selection is an ordered *provider chain per locale*:
`TenantTtsConfig.routingEn` / `routingMl` / `allowedProviders`
(`tenant-tts-config.prisma:38-40`), merged over the SYSTEM row and clamped to a **code constant**
`PLATFORM_TTS_LIMITS` (`packages/applications/src/services/tenant-tts-config/platform-limits.ts:66-76`
— `routingEn: ['azure','kokoro']`, `routingMl: ['azure','sarvam','indic_parler']`).
Injection: `apps/api/src/modules/speech/speech-proxy.controller.ts:107-143` (REST) and
`apps/api/src/modules/speech/tts-ws.gateway.ts:328,462` (WS) push
`routing_en / routing_ml / allowed_providers / provider_overrides / voice_bindings`
into `apps/tts/src/tts/api/endpoints/speech.py:37-53`.

### B5. Exact runtime order — TRANSLATION

There is **no task key and no `AiTaskDefault` tier for translation.** The provider name is
supplied by the CALLER in the request body and looked up in an in-process registry:
`apps/text/src/text/api/endpoints/translate.py:44-51`. Only one provider is registered —
`sarvam` (`apps/text/src/text/main.py:186-189`). The gateway resolves the Sarvam key by
**reusing the `service='stt'` Sarvam row** (`apps/api/src/modules/text-compat/text-compat.controller.ts:207-215`,
`maybeTranslateBody` `:201-...`), and the whole path is **fail-open**.

### B6. VERDICT on rule compliance ("request tenant → SYSTEM, two tiers, never `50000000-…`")

**PASS — no violation found in any resolver.**

- Repo-wide grep for `50000000-0000-0000-0000-000000000000` returns **zero hits in resolution
  code**. The only production occurrences are `entitlements.constants.ts:37`
  (`ENTITLEMENTS_GLOBAL_TENANT_ID`) and `serviceAccount/service-account.service.ts:43`
  (`GLOBAL_PLAYGROUND_TENANT_ID`) — neither is an AI-provider resolver. Everything else is
  seeds, one-off scripts, CLI defaults, DTO examples.
- `AiTaskDefaultService.getEffective` reads exactly `[scopedTenantId, SYSTEM_TENANT_ID]`
  (`ai-task-default.service.ts:74-79`) and widens **on absence** (`:81`).
- `AiProviderConnectionService.cascadeRows` reads exactly two tiers
  (`ai-provider-connection.service.ts:454-541`); SYSTEM caller short-circuits at `:485`.
- `AiRoutingPolicyService.getEffective` is handed exactly two ids and cannot be handed a third
  (`ai-routing-policy.service.ts:153`), and widens only when the tenant tier is empty (`:158-160`).
- `resolveCredential` **refuses a tenant-less form** on purpose
  (`ai-provider-connection.service.ts:658-664`: "it could only mean read SYSTEM unconditionally,
  which is the widen-without-absence bug").
- Guardrail's Python resolver has the `default_tenant_id` knob explicitly removed
  (`apps/guardrail/src/guardrail/core/config.py:231-234`); `apps/stt/src/stt/core/config/constants.py:8`
  carries the same note.

Three things worth flagging **not** as rule violations but as design debt:

1. **Super-admin-only keys resolve SYSTEM-only, and this is deliberate** —
   `getEffective` short-circuits the tenant read for `nlp.*`, `harness.*`, `guardrail.pii*`
   (`ai-task-default.service.ts:72-77`, predicate `constants.ts:174-176`). Documented exception
   per `09-infrastructure-devops.md`.
2. **The entitlement gate DENIES when no entitlements service is wired**
   (`ai-provider-connection.service.ts:566-570`). Fail-closed, correct, but it means a
   composition without entitlements silently withholds every platform cloud credential.
3. **`applyTenantProviderOverrides` is fail-OPEN on resolver error**
   (`text-request-enrichment.service.ts:95-105`, "forwarding with platform credentials"), while
   the SELECTION seam above it is fail-closed. Same split exists in STT (session creds fail open,
   weight creds fail closed) and TTS.

---

## C. CREDENTIAL STORAGE

Storage of record: **`AiProviderConnection.encryptedApiKey`, Vault-Transit ciphertext**
(`ai-provider-connection.prisma:67`). Encryption is refused unless `SECRETS_PROVIDER=vault`
(`ai-provider-connection.service.ts:762-776`: *"There is no plaintext-at-rest fallback."*).
The key is **write-only** in the API: request DTO carries `apiKey`
(`packages/applications/src/services/ai-provider-connection/dto/upsert-ai-provider-connection.request.ts:102`,
documented write-only at `:49`), and the response DTO physically has **no** `apiKey` field — only
`hasKey: boolean` (`packages/applications/src/services/ai-provider-connection/dto/ai-provider-connection.response.ts:12,37`).

Delivery: decrypted at the gateway and pushed per-request as `provider_overrides` (text, tts) or
pulled through `/internal/*` endpoints (stt). Python services hold `SecretStr` and no store.

| Provider (service) | Where the key lives today | Env-var fallback? | Verdict |
|---|---|---|---|
| `llm:azure` (Azure OpenAI) | `AiProviderConnection`, Vault-Transit | NO — `apps/text` has no credential field anywhere (`test_task602_byok_credentials.py:104-136`) | OK |
| `llm:openai` | same | NO | OK |
| `llm:anthropic` | same | NO | OK |
| `llm:bedrock` | ambient AWS creds, no static key (schema header `ai-provider-connection.prisma:42-43`) | ambient chain removed in TASK-799 Phase 0 | OK |
| `llm:vertex` | ambient; `project`/`location` in `extraJson` | ambient chain removed | OK |
| `llm:lm-studio` | SYSTEM row only; `baseUrl` `http://hope-lmstudio:1234/v1` seeded `enabled:true`, key = non-secret placeholder `'not-needed'` (`seed/17-ai-provider-connection.ts:87,255-264`) | n/a | OK |
| `llm:vllm` | SYSTEM row, `http://hope-vllm:8000/v1`, `enabled:true`, placeholder key (`seed/17-…:356-365`) | n/a | OK |
| `llm:llama-cpp` | SYSTEM row, `http://hope-llama-cpp:8080`, `enabled:true`, placeholder (`seed/17-…:372-381`) | n/a | OK |
| `llm:ollama` | SYSTEM row, `http://localhost:11434`, `enabled:true`, placeholder (`seed/17-…:223-232`) | n/a | OK |
| `llm:built-in` | SYSTEM row, `enabled:true` (`seed/17-…:304-313`) | n/a | OK |
| `llm:sarvam` | SYSTEM row seeded `enabled:false` (`seed/17-…:321-330`) — but `sarvam` is **not** in `CLOUD_BYO_PROVIDERS.llm` (`constants.ts:76`), so a tenant cannot own an `llm:sarvam` row | NO | **Inconsistency, flagged** (see C-note 1) |
| `stt:azure-speech` | `AiProviderConnection` `service='stt'` | NO — loader fails closed (`apps/stt/src/stt/models/azure_speech_loader.py:131-136` "There is no env fallback for the key") | OK |
| `stt:sarvam` | same | NO (`apps/stt/src/stt/models/sarvam_loader.py:90-93`) | OK |
| `stt:openai` | same | NO (`apps/stt/src/stt/models/openai_loader.py:76-82`) | OK |
| Azure Foundry ASR | shares override key `azure-speech` (`apps/stt/src/stt/models/azure_foundry_loader.py:36`) | NO (`:80-84`) | OK |
| `tts:azure` | `AiProviderConnection` `service='tts'` | NO — `apps/tts/src/tts/core/config.py:67-70` binds `api_key` to a **dead alias** `TTS_AZURE_API_KEY__ENV_REMOVED_TASK_602` with `populate_by_name` off | OK (reference pattern) |
| `tts:sarvam` | same | NO — dead alias `TTS_SARVAM_API_KEY__ENV_REMOVED_TASK_602` (`config.py:253-259`) | OK |
| `model-registry:huggingface` | `AiProviderConnection` `service='model-registry'`, SYSTEM row only, seeded `enabled:false` (`seed/17-…:526-535`) | NO — `HUGGINGFACE_TOKEN__ENV_REMOVED_TASK_799` (`apps/stt/src/stt/core/config/settings.py:296`) | OK |
| `model-registry:s3` | `encryptedApiKey` = secret key, `extraJson.accessKeyId` = principal (`ai-provider-connection/constants.ts:42-46`); SYSTEM row (`seed/17-…:545-554`) | NO — `STT_MODEL_S3_*__ENV_REMOVED_TASK_799` (`settings.py:330-340`) | OK |
| `rerank:tei`, `vector:qdrant`, `embeddings:tei-embed` | storable but **deliberately not seeded**, no delivery path (`seed/17-…:66-77`); endpoints stay env-tier in harness | endpoints are env transport addresses | OK by declared decision |
| harness judge (Azure) | `AiProviderConnection` via `GET /internal/harness/provider-credential` | NO — `apps/harness/src/harness/eval/config.py:99-102` dead alias `HARNESS_JUDGE_AZURE_API_KEY__ENV_REMOVED_TASK_799` | OK |
| MLflow | **no credential plane at all.** MLflow is a read-only gateway proxy (`apps/api/src/modules/ai-service-admin/ai-service-admin.controller.ts:71-111`); its auth is **UNKNOWN** from this audit | — | **Gap** |

**No plaintext-in-DB credential found. No live `*_API_KEY` env fallback found for any inference
provider.** Every removed variable is pinned by a dead `validation_alias` plus a test.

C-notes (documentation/consistency defects, not credential leaks):

1. `llm:sarvam` is seeded as a connection row (`seed/17-…:321-330`) but Sarvam is absent from
   `CLOUD_BYO_PROVIDERS.llm` (`ai-provider-connection/constants.ts:76`) and `apps/text` registers
   no Sarvam *generation* provider (`apps/text/src/text/main.py:99-108`). Sarvam is
   translation-only there (`main.py:186-189`) and its key is read from the **`stt` service row**
   (`apps/api/src/modules/text-compat/text-compat.controller.ts:207-215`). A cross-service
   credential borrow with no model of its own.
2. Stale doc comment: `apps/api/src/modules/text-compat/text-compat.controller.ts:195` still says
   *"absent ⇒ TEXT uses its platform `TEXT_SARVAM_API_KEY`"* — contradicted twelve lines later at
   `:207-208` (*"Sarvam is BYOK-ONLY — never an env credential"*) and by the absence of that var
   from `apps/text`.
3. Stale doc comment: `apps/stt/src/stt/providers/…resolve_override_key` describes an env-credential
   fallback for cloud ASR; **verified false** — all four loaders fail closed (table above).
4. `OPENAI_API_KEY` is still declared in `turbo.json:467` with only one consumer, the promptfoo
   eval harness (`apps/harness/eval/promptfoo/provider.py:39`) — an offline eval tool, not a
   runtime inference path.

---

## D. CONSTRAINT AUDIT — "only one default per task"

**Answer: it exists, but for the WRONG cardinality. There is no constraint of the target shape.**

What EXISTS (a DB-level unique):

```prisma
// packages/database/src/prisma/db_main/ai-task-default.prisma:49
@@unique([tenantId, taskKey], name: "AiTaskDefault_tenant_task_unique")
```

This makes the SYSTEM-tenant row structurally "the one platform default for that task", and each
tenant's row "the one tenant override". That is **one row per (tenant, task)** — it forbids
*alternatives* rather than electing a default among many. The target requires *many configurations
per task with exactly one flagged default*, which this cannot express at all: there is nowhere to
put the second candidate.

What does NOT exist:

- No `isDefault` column on `AiProviderConnection`, `AiTaskDefault`, `AiRuntimeProfile` or
  `AiRoutingPolicy` (grep of `isDefault` across `db_main/*.prisma` returns only
  `ConsultationContextSchema:53`, `DocumentTemplate:58`, `AsrPipeline:31`, and a comment in
  `workflow-definition.prisma:111`).
- No partial unique index of the form `UNIQUE (tenantId, taskKey) WHERE isDefault` anywhere.
- No service-level guard enforcing single-default over a candidate set for providers.

The only "elect one default among many" precedent in the codebase is for STT pipelines, and it is
**service/repository level, not a DB constraint**:

```ts
// packages/domains/src/repositories/generated/core/AsrPipelineRepository.ts:139-150
async setDefaultForTenant(tenantId, pipelineId, updatedBy?) {
  await this.unitOfWorkService.runInTransaction(async (tx) => {
    await tx.asrPipeline.updateMany({ where: { tenantId, isDefault: true, id: { not: pipelineId } },
                                      data:  { isDefault: false, updatedBy: updatedBy ?? null } });
    await tx.asrPipeline.update({ where: { id: pipelineId }, data: { isDefault: true, … } });
  });
}
```
called from `packages/applications/src/services/stt/pipeline/pipeline.service.ts:346-370`
(*"Delegates the multi-row flip to the repository transaction so the 'exactly one default per
tenant' invariant is enforced atomically"*). Note the scope: **per tenant**, not per task, and
there is no supporting DB constraint — two concurrent writers on separate connections are only
serialised by the transaction, not by the schema.

`AiRoutingPolicy` gets closest to the target's "ordered candidates" idea
(`candidatesJson` `ai-routing-policy.prisma:77`, `@@unique([tenantId, taskKey, policyVersion])`
`:119`), but candidates live inside JSON, "default" is `rank`, and the whole model has **no
runtime reader** (§A5).

---

## E. TASK + PROVIDER TAXONOMY

### E1. Task keys — `AI_TASK_KEYS`
`packages/applications/src/services/ai-task-default/constants.ts:37-61`

```
guardrail.validate · guardrail.safety · guardrail.groundedness · guardrail.pii · guardrail.pii.spans
nlp.ner · nlp.classification · nlp.diagnosis · nlp.sentiment · nlp.toxicity
text.live · text.finalize · text.live.fallback · text.finalize.fallback · text.test
harness.judge
vlm.extract
```

Validated on every read and write by `assertKnownTaskKey`
(`ai-task-default.service.ts:248-252`) — an unknown key is a hard `ArgumentInvalidException`.
Each key is mapped to a required `AiModel.taskType` in `AI_TASK_MODEL_TASK_TYPES`
(`constants.ts:69-102`), and the upsert rejects a mismatch (`ai-task-default.service.ts:151-156`).
Each key also generates a `models.<taskKey>` settings descriptor
(`settings-registry/descriptors/model-defaults.descriptors.ts:129`).

Coverage against the four required tasks:

| Target task | Covered? | Evidence |
|---|---|---|
| Text generation | **YES** — `text.live`, `text.finalize` (+ `.fallback`, `.test`) | `constants.ts:54-58` |
| Translation | **NO** | no `translate.*` key exists; provider is caller-supplied at `apps/text/src/text/api/endpoints/translate.py:44-51` |
| Speech-to-text | **NO** | no `stt.*` key; selection is `AsrPipeline.configYaml` + `isDefault` (`stt.prisma:28,31`) |
| Text-to-speech | **NO** | no `tts.*` key; selection is `TenantTtsConfig.routingEn/routingMl` (`tenant-tts-config.prisma:38-39`) clamped to code constants (`platform-limits.ts:66-76`) |

The **model** taxonomy already supports all four — `ModelTaskType` has `TRANSLATION`
(`enums.prisma:129`), `AUTOMATIC_SPEECH_RECOGNITION` (`:141`), `TEXT_TO_SPEECH` (`:139`),
`TEXT_GENERATION` (`:132`). Only the *task-key* vocabulary is short.

### E2. `SUPER_ADMIN_ONLY_TASK_PREFIXES` — what it gates
`packages/applications/src/services/ai-task-default/constants.ts:133`

```ts
export const SUPER_ADMIN_ONLY_TASK_PREFIXES = ['nlp.', 'harness.'] as const;
export const SUPER_ADMIN_ONLY_TASK_KEYS = ['guardrail.pii', 'guardrail.pii.spans'] as const;  // :155
export function isSuperAdminOnlyTaskKey(taskKey)  // :174-176 — the single predicate
```

It gates **two distinct things**:

1. **WRITE** — `AiTaskDefaultService.upsertRow` throws `ForbiddenException` (403, a privilege
   boundary, *not* the 404-over-403 tenancy posture) for a non-super-admin
   (`ai-task-default.service.ts:127-129`).
2. **RUNTIME READ** — `getEffective` short-circuits the tenant read entirely for such a key, so an
   orphan tenant override row can exist but can never win (`ai-task-default.service.ts:72-77`).

`text.` is deliberately absent (tenant-configurable). `guardrail.` was **removed** from the list by
owner decision 2026-08-16 (`constants.ts:117-131`) but carries a separate tighten-only platform
floor: a tenant write must name a slug that resolves to a SYSTEM-tenant `AiModel`
(`assertGuardrailModelApproved`, `ai-task-default.service.ts:271-278`).

The same shape governs connections: `assertWriteAllowed`
(`ai-provider-connection.service.ts:746-760`) — SYSTEM rows are super-admin-only; a tenant row is
allowed only for a provider listed in `CLOUD_BYO_PROVIDERS[service]`, otherwise 403.

### E3. Provider taxonomy

Three separate, hand-synchronised vocabularies:

**(a) `PROVIDER_SERVICES`** — capability discriminator, `ai-provider-connection/constants.ts:55,58`:
`llm | stt | tts | embeddings | rerank | vector | model-registry`.
Mirrored (cannot be imported — package cycle) in `seed/17-ai-provider-connection.ts:144-160`, held
in lock-step by `tests/contracts/provider-connection-services.contract.test.ts`.

**(b) `CLOUD_BYO_PROVIDERS`** — who may own a row, `ai-provider-connection/constants.ts:75-108`:
```
llm:            azure, bedrock, openai, anthropic, vertex
stt:            azure-speech, sarvam, openai
tts:            azure, sarvam
embeddings:     azure, openai
rerank:         []            (TEI is platform infrastructure)
vector:         qdrant
model-registry: []            (owner ruling 2026-08-24 — platform-managed)
```
Anything **not** listed is SYSTEM-only.

**(c) `AI_MODEL_PROVIDERS`** — the `AiModel.provider` vocabulary,
`packages/database/src/prisma/db_main/seed/ai-models/shared.ts:90-111`:
`ollama, lm-studio, azure, bedrock, built-in, sarvam, openai, anthropic, vertex, vllm, llama-cpp`.

**(d) Seeded `AiProviderConnection` SYSTEM rows** (`seed/17-ai-provider-connection.ts`):

| service:provider | baseUrl | enabled | line |
|---|---|---|---|
| llm:ollama | `http://localhost:11434` | true | :223-232 |
| llm:lm-studio | `http://hope-lmstudio:1234/v1` | true | :255-264 |
| llm:azure | null | false | :272-281 |
| llm:bedrock | null | false | :288-297 |
| llm:built-in | null | true | :304-313 |
| llm:sarvam | null | false | :321-330 |
| llm:openai | null | false | :340-349 |
| llm:vllm | `http://hope-vllm:8000/v1` | true | :356-365 |
| llm:llama-cpp | `http://hope-llama-cpp:8080` | true | :372-381 |
| llm:anthropic | null | false | :392-401 |
| llm:vertex | null | false | :409-418 |
| stt:azure-speech / stt:sarvam / stt:openai | null | false | :427-468 |
| tts:azure / tts:sarvam | null | false | :477-502 |
| model-registry:huggingface | null | false | :526-535 |
| model-registry:s3 | null | false | :545-554 |

**(e) Text-service registry** (`apps/text/src/text/main.py:99-108`):
`lm-studio, openai_compat, ollama, bedrock, azure-openai (alias azure), openai, anthropic, vertex,
vllm, llama-cpp`; translate registry `sarvam` (`:186-189`); embeddings `tei-embed` (`:203-206`).

Coverage against the five in-scope providers:

| Target provider | Present? | Where |
|---|---|---|
| **LM Studio** (self-host) | YES, platform-only | `AI_MODEL_PROVIDERS` `shared.ts:92`; SYSTEM connection seeded enabled (`seed/17-…:255-264`); text adapter `apps/text/src/text/providers/lmstudio.py`; nav screen `nav-config.ts:328` |
| **vLLM** (self-host) | YES, platform-only | `shared.ts:107`; SYSTEM connection enabled (`seed/17-…:356-365`); text adapter registered (`main.py:99-108`); nav screen `nav-config.ts:337` |
| **MLflow** | PARTIAL — only as `AiModelSource.MLFLOW` (`enums.prisma:351`) and a **read-only gateway proxy** (`ai-service-admin.controller.ts:71-111`, nav `nav-config.ts:349`). **NOT a `provider`, no connection row, no credential plane, no serving adapter** | — |
| **Sarvam** | PARTIAL — present in `AI_MODEL_PROVIDERS` (`shared.ts:95`) and in `CLOUD_BYO_PROVIDERS.stt`/`.tts` (`constants.ts:77-78`), and an `llm:sarvam` SYSTEM row is seeded (`seed/17-…:321-330`) — but **absent from `CLOUD_BYO_PROVIDERS.llm`** and there is **no Sarvam generation adapter** in `apps/text`; it serves TTS, STT and translate only | — |
| **Azure OpenAI** | YES, tenant-BYO | `CLOUD_BYO_PROVIDERS.llm` (`constants.ts:76`); adapter `azure-openai` with `azure` alias (`main.py:99-108`); runtime alias applied at `harness-policy.service.ts:513` |
| **HuggingFace** | PARTIAL — a *model source* (`enums.prisma:349`) and a `model-registry` credential (`seed/17-…:526-535`), **never an inference provider**; `CLOUD_BYO_PROVIDERS['model-registry'] = []` by owner ruling (`constants.ts:93-107`) | — |

Additional providers already modelled but out of the target's scope: `ollama`, `llama-cpp`,
`built-in`, `bedrock`, `openai`, `anthropic`, `vertex`, `azure-speech`, `qdrant`, `tei`, `s3`.

---

## F. PYTHON CONTRACT

Rule reference: `.claude/rules/06-python-services.md` — gateway-resolved injection is the default,
provider/model SELECTION is fail-closed, BYOK-only with no `*_API_KEY` env fallback.
**Note the rule file is stale on one point**: its settings-prefix table (§Configuration) still
lists `TEXT_`, `TEXT_OLLAMA_`, `TEXT_AZURE_` as live per-provider prefixes; those eight env blocks
were deleted in TASK-799 (`apps/text/src/text/core/config.py:1-36`).

### F1. `apps/text` (8862) — the reference; PUSH channel

Settings carry **no provider, model or credential field at all**
(`apps/text/src/text/core/config.py:152-264`), locked by
`apps/text/src/text/tests/unit/test_task602_byok_credentials.py:104-136`.

Wire contract — `ProviderOverride` (`apps/text/src/text/models/requests.py:33-83`):

```
api_key: SecretStr            (required)
base_url, region, api_version, deployment_name, model: str | None
project, location: str | None                  # Vertex
funding: "tenant" | "platform" = "tenant"      # per entry, derived gateway-side
guardrail_id, guardrail_version: str | None    # Bedrock Guardrails
```
carried as `GenerateRequest.provider_overrides: dict[str, ProviderOverride] | None`
(`requests.py:193`), keyed by provider name. Only the entry matching `request.provider` is read
(`apps/text/src/text/core/connection.py:38-52`).

Absence ⇒ **fail closed**: `require_connection` / `require_api_key` / `require_base_url` raise
typed errors mapped to 503 — *"there is no platform or environment fallback"*
(`core/connection.py:55-105`, quote at `:89`). Enforced structurally per adapter by
`CredentialPosture` (`apps/text/src/text/providers/base.py:21-49`, `BYOK` vs `SELF_HOST`).

Gateway builder: `packages/applications/src/services/text-request/text-request-enrichment.service.ts:78-132`
(`applyTenantProviderOverrides`, minimal exposure — only the selected provider's entry),
`:171-205` (`applyTenantGuardrailPolicy`), `:219-256` (`applyTextRuntimeProfile`); invoked from
`apps/api/src/modules/streaming/text-proxy.controller.ts:320-368`.

Second channel (PULL, capacity/timeouts only, never provider selection):
`GET /internal/effective-config?service=text`.

**One known config-costume violation, tracked**: `GenerateRequest.provider` defaults to the
literal `"lm-studio"` (`apps/text/src/text/models/requests.py:142-180`,
`_HARDCODED_DEFAULT_PROVIDER`), documented as blocked on two callers that must always send
`provider` explicitly.

### F2. `apps/stt` (8861) — PULL channel, split fail posture

| Concern | Endpoint | Posture |
|---|---|---|
| ASR session credentials | `GET /internal/stt/provider-overrides?tenantId=` (`apps/stt/src/stt/core/effective_config.py:151-198`; gateway `apps/api/src/modules/internal/stt-internal.controller.ts:357-370`) | **fail OPEN** at the client (`:156-158,190-198`) — but every cloud loader then fails closed, so the effective posture is closed |
| Model-weight registry credentials | `GET /internal/stt/model-registry-credential?provider=&tenantId=` (`apps/stt/src/stt/core/model_credentials.py:88-198`; gateway `stt-internal.controller.ts:308-347`) | **fail CLOSED**, four outcomes `resolved/absent/denied/unavailable`; the credential spent is the **model row owner's**, never the caller's (`model_credentials.py:101-109`) |

Override keys: `openai` (`models/openai_loader.py:30`), `sarvam` (`models/sarvam_loader.py:34`),
`azure-speech` (`models/azure_speech_loader.py:82`, shared by
`models/azure_foundry_loader.py:36`). Session payload field
`provider_overrides` at `apps/stt/src/stt/streaming/api/schemas.py:50-58`.

Provider *selection* for STT arrives as a **pipeline id**, not a provider name — the
`AsrPipeline.configYaml` names model slugs. There is **no `AiTaskDefault` tier and no
`{provider, model}` injection** comparable to text's.

### F3. `apps/tts` (8865) — PUSH channel, injected routing chain

Request contract (`apps/tts/src/tts/api/endpoints/speech.py:37-53`):
```
routing_en, routing_ml: list[str] | None            # ordered provider chain per locale
allowed_providers:      list[str] | None
provider_overrides:     dict[str, dict[str, str]] | None   # {api_key, region?, base_url?, funding?}
voice_bindings:         dict[str, dict[str, str]] | None
```
WS equivalent at `apps/tts/src/tts/api/endpoints/stream_ws.py:66-174`.
Gateway builders: `apps/api/src/modules/speech/speech-proxy.controller.ts:33-53` (shape),
`:107-143` (`applyTenantConfig`, fail-open on resolver error);
`apps/api/src/modules/speech/tts-ws.gateway.ts:328,462`.
Credential structure is the F-01 reference pattern: dead `validation_alias` + `populate_by_name`
off (`apps/tts/src/tts/core/config.py:63-70`).
Providers: `azure_speech.py`, `sarvam.py` (cloud BYOK), `kokoro.py`, `indic_parler.py`,
`indic_f5.py` (self-host).

### F4. Comparison

| | text | stt | tts |
|---|---|---|---|
| Channel | PUSH per-request body | PULL by gateway internal endpoint, injected at session creation | PUSH per-request body (REST + WS) |
| `resolveTenantCloudOverrides` service key | `'llm'` | `'stt'` + `'model-registry'` | `'tts'` |
| Task-keyed selection tier | YES (`AiTaskDefault` + node `llmBinding`) | **NO** (pipeline YAML) | **NO** (routing chains) |
| Selection fail posture | closed | closed (loader level) | chain-based; falls through the chain |
| Env credential fallback | none | none | none |

---

## G. GAP TABLE — 8 business requirements vs current state

| # | Requirement | State | Missing piece (named) |
|---|---|---|---|
| 1 | **ONE screen** manages all AI inference provider configurations | **PARTIAL** | Config is split over at least six surfaces: `/ai-configuration` (tier 30-49, tabs Models·Speech·Voice·Providers, `nav-config.ts:795-807`), `/ai-services` + `/ai-services/{lm-studio,vllm,mlflow}` (tier 10-19, `nav-config.ts:311,328,337,349`), and four REST planes `admin/providers/:service/:provider` (`ai-provider-connection.controller.ts:62`), `admin/ai-providers` (legacy dup, `:175`), `admin/ai-task-defaults` (`ai-task-default-admin.controller.ts:59`), `admin/ai-runtime-profiles` (`ai-runtime-profile.controller.ts:35`), `admin/routing-policies` (`ai-routing-policy-admin.controller.ts:82`), `admin/ai-models` (`ai-model-admin.controller.ts:23`). No single aggregate read/write endpoint exists |
| 2 | Provider configuration **scoped to a TASK** | **ABSENT** | `AiProviderConnection` has no `taskKey` (`ai-provider-connection.prisma:51-89`); the natural key is `(tenant, service, provider)`. Task-scoping exists only one level up, on `AiTaskDefault`, which points at a **model**, not at a provider configuration |
| 2b | Tasks: text-gen / translation / STT / TTS | **PARTIAL (1 of 4)** | `AI_TASK_KEYS` (`ai-task-default/constants.ts:37-61`) has `text.*` only. **Missing: `translate.*`, `stt.*`, `tts.*`.** STT routes through `AsrPipeline.isDefault`, TTS through `TenantTtsConfig.routingEn/Ml`, translation through a caller-supplied provider string (`translate.py:44-51`) |
| 3 | **Many configs per task, exactly ONE platform default**, atomically enforced | **ABSENT** | `@@unique([tenantId, taskKey])` (`ai-task-default.prisma:49`) permits exactly one row *total* per task — there is nowhere to store a second candidate, and therefore no default to elect. No `isDefault` column, no partial unique index. The only atomic single-default precedent is `AsrPipelineRepository.setDefaultForTenant:139-150` (per tenant, not per task, service-level only). `AiRoutingPolicy.candidatesJson` (`:77`) models an ordered chain but has **no runtime reader** |
| 4a | Tenant admin BYO-key over a SYSTEM fallback | **SUPPORTED** | `CLOUD_BYO_PROVIDERS` (`constants.ts:75-108`) + three-state `enabled` (`constants.ts:120-125`) + two-tier cascade (`ai-provider-connection.service.ts:454-541`) + derived funding (`:734-736`) |
| 4b | LM Studio and MLflow/vLLM are **PLATFORM-ADMIN ONLY** (tenant may not configure or disable) | **SUPPORTED for LM Studio/vLLM; ABSENT for MLflow** | `assertWriteAllowed` 403s a tenant row for any provider outside `CLOUD_BYO_PROVIDERS[service]` (`ai-provider-connection.service.ts:746-760`), and `lm-studio`/`vllm` are not listed — so tenants can neither configure nor veto them (the veto set is scoped to cloud providers, `ai-provider-connection.service.ts:480`). **MLflow is not a provider at all** — no enum member, no connection row, no adapter; only `AiModelSource.MLFLOW` (`enums.prisma:351`) and a read-only proxy (`ai-service-admin.controller.ts:71-111`) |
| 5 | Admin can **PROMOTE** a configuration from one tenant to another they manage | **ABSENT for provider config** | Promotion exists only for workflow definitions: `AgentPromotionService.promote` (`packages/applications/src/services/agentPromotion/agentPromotion.service.ts:55-...`), gated by `assertManagesBothTenants`, running under an elevated tenant-less context, copying VALUES not REFERENCES. Nothing equivalent for `AiProviderConnection` / `AiTaskDefault` / `AiRuntimeProfile`. `AiTaskDefaultService.crossTenantLane` (`:241-246`) is a super-admin *write-to-one-tenant* lane, not a copy |
| 6 | **Export/import** selected configs as JSON, secrets MASKED, never exportable in full | **ABSENT** | No export/import route on any AI config controller. The only `/export` surfaces in `apps/api/src/modules` are audit-log and user. Masking primitive exists (`dto/ai-provider-connection.response.ts:37` `hasKey`, request-only `apiKey` at `dto/upsert-ai-provider-connection.request.ts:102`) but there is no bundle format, no importer, no round-trip identity for `extraJson`/`configJson` |
| 7 | Every **agent node** binds to exactly ONE provider configuration | **PARTIAL** | `node.config.llmBinding.modelSlug` (`node-llm-binding.ts:33-35`) binds a **model**, not a provider configuration; the provider is derived from `AiModel.provider` and the credential from a second `(service, provider)` lookup. The binding is **optional** (absent = tenant task default, `:24-29`) and single-field. It resolves fail-closed (`harness-policy.service.ts:549-573`). Per TASK-816's owner decision only 3 of 17 task keys got node-level successors |
| 8 | Providers in scope: LM Studio, MLflow-backed vLLM, Sarvam, Azure OpenAI, HuggingFace | **3 of 5** | LM Studio ✅, vLLM ✅ (but **not MLflow-backed** — no registry-driven serving path), Azure OpenAI ✅. **Sarvam** exists for stt/tts/translate but is **not an LLM provider** (absent from `CLOUD_BYO_PROVIDERS.llm:76`, no adapter in `main.py:99-108`) despite a seeded `llm:sarvam` row. **HuggingFace** is a model *source* + a `model-registry` credential only (`constants.ts:93-107`), never an inference provider |

---

## H. RECOMMENDED TARGET MODEL

Described as a design, not applied. Rule constraints assumed to hold: hand-authored
entity/factory/mapper/repository (`03-domain-layer.md` §Generated Code Discipline), a `ResourceType`
member in **both** `audit.prisma` and `packages/domains/src/enums/generated/ResourceType.ts`,
allow-list entries in `tenant-scope.ts` (TENANT_SCOPED + SYSTEM_SHARED_READ), and a migration
authored against a shadow DB.

### H1. The one structural insight

The target's unit — *"a provider configuration, scoped to a task, one of which is the default"* —
does not exist today because the codebase splits that single idea across three tables joined by
strings: `AiTaskDefault` (task → model slug), `AiModel` (slug → provider name + native id), and
`AiProviderConnection` (service + provider → endpoint + credential). The redesign should introduce
**exactly one new join model** and leave the three existing ones as the normalised facts they
already are.

### H2. NEW model — `AiTaskProviderBinding` (working name)

One row = one usable provider configuration for one task. Fields:

| Field | Type | Purpose |
|---|---|---|
| `metaData` / `version` / `id` | house meta trio | OCC via `_version` |
| `tenantId` | String | SYSTEM row = platform fallback; tenant row = BYO |
| `taskKey` | String | validated against a **widened** `AI_TASK_KEYS` (§H5) |
| `name` | String | operator-facing label — what the single screen lists |
| `connectionId` | String | reference to `AiProviderConnection.id` (**by id, not by `(service, provider)` string** — closes the string-join hazard). No FK, house convention, but validated on write |
| `modelSlug` | String | reference to `AiModel.slug`, resolved `[tenant, SYSTEM]`, `taskType` checked against the key's required type (reuse `AI_TASK_MODEL_TASK_TYPES`) |
| `isDefault` | Boolean `@default(false)` | exactly one true per `(tenantId, taskKey)` — see H3 |
| `priority` | Int `@default(0)` | order among the non-defaults; feeds the candidate chain |
| `enabled` | Boolean `@default(true)` | operator on/off, distinct from `resourceStatus` |
| `runtimeProfileId` | String? | optional pin to an `AiRuntimeProfile`; null = the existing provider/model cascade |
| `configJson` | Json? `@db.JsonB` | task-specific extras (absorbs today's `AiTaskDefault.configJson`) |
| `sourceTenantId` / `promotedFromId` / `promotedAt` / `promotedBy` | String?/DateTime? | promotion provenance, mirroring `AgentPromotion` |
| resourceStatus trio + audit quad | house template | soft delete, audit |

Constraints:
- `@@unique([tenantId, taskKey, connectionId, modelSlug], map: …)` — no duplicate candidate.
- **`@@index([tenantId, taskKey, isDefault])`** plus a hand-written **partial unique index** in the
  migration SQL: `CREATE UNIQUE INDEX … ON core."AiTaskProviderBinding" ("tenantId","taskKey") WHERE "isDefault" AND "resourceStatus" <> 'DELETED';`
  Prisma cannot express a partial unique in the schema, so it is raw SQL in the migration and the
  schema carries only the plain index — document that asymmetry in the model header, and note the
  `@@unique` `name:` vs `map:` trap (`02-database-prisma.md`).
- Service-level atomic flip mirroring `AsrPipelineRepository.setDefaultForTenant:139-150`
  (`updateMany` unset + `update` set inside `runInTransaction`), so the API returns a clean
  409/400 rather than a raw unique violation.

Registration: `TENANT_SCOPED_MODELS` **and** `SYSTEM_SHARED_READ_MODELS` (reads widen to
`[caller, SYSTEM]`, writes never widen) — the `AiTaskDefault` precedent exactly.

### H3. "Exactly one default per task" — the enforcement stack

Three layers, all required (the DB constraint is the only one that survives a concurrent writer):

1. Partial unique index (above) — the actual invariant.
2. Repository `setDefaultForTask(tenantId, taskKey, bindingId)` in one transaction — makes the
   *reassignment* case atomic rather than a constraint violation.
3. Service guard: a super-admin write to a SYSTEM row is the **platform** default; a tenant write
   is the **tenant** default; both scoped by `tenantId` so the two never collide.

### H4. What to MERGE, RETIRE and KEEP

| Model | Verdict | Reasoning |
|---|---|---|
| `AiProviderConnection` | **KEEP unchanged** | It is the correct normalised fact ("where a provider lives + how to auth") and the only Vault-Transit credential store. Do **not** add `taskKey` to it — that would multiply credentials per task and break the one-credential-per-vendor-account model, the veto set and derived funding |
| `AiModel` | **KEEP** | The model registry, already correct and already carries `TRANSLATION`/`TEXT_TO_SPEECH`/`AUTOMATIC_SPEECH_RECOGNITION` task types. Consider relocating it out of `stt.prisma` into `ai-model.prisma` — cosmetic, zero DDL |
| `AiTaskDefault` | **MERGE INTO the new model, then RETIRE** | Its whole content is `(tenantId, taskKey, modelSlug, configJson)` — the strict subset of one `AiTaskProviderBinding` row with `isDefault = true`. Migration: for each row, create a binding with `isDefault=true`, `connectionId` resolved from `AiModel.provider` → the `(service, provider)` row. **Blocked** on TASK-816's owner decision that `AiTaskDefault` survives — this needs an explicit reversal, not an assumption |
| `AiRuntimeProfile` | **KEEP** | Orthogonal axis (hyperparameters per provider/model). Reference it optionally from the binding rather than folding it in — a profile is legitimately shared across bindings |
| `AiRoutingPolicy` | **RETIRE, or absorb** | It has zero runtime readers (§A5) and its `candidatesJson[]` is exactly the ordered candidate set the new model expresses as rows. Either (a) delete it and let `priority` + `isDefault` carry the chain, or (b) keep it strictly as the *fallback contract* (`fallbackJson`, `healthJson`, `killSwitch`, ceilings) and drop `candidatesJson` in favour of the binding rows. Option (b) preserves TASK-818's §3A.4 STRICT explicit-provider ruling. **Owner decision required** — do not delete a shipped table silently |
| `HarnessPolicy.textProvider` / `.textModel` | **RETIRE** | Precedence-2 legacy fallback (`harness-policy.service.ts:609-612`). Once every tenant has a binding, this branch is dead. Column drop, same shape as TASK-816's `safetyProvider`/`safetyModel` drop |
| `TenantTtsConfig.routingEn` / `routingMl` / `allowedProviders` | **MERGE INTO bindings, then drop those columns** | An ordered provider chain per locale *is* the candidate list; `taskKey = 'tts.synthesize.en'` / `'tts.synthesize.ml'` (or one key plus a `locale` match field) with `priority` reproduces it. Keep the rest of `TenantTtsConfig` (voices, format, speed, sampleRate, limits) — those are not provider selection. Also retire the hardcoded `PLATFORM_TTS_LIMITS` provider universe (`platform-limits.ts:66-76`) — it is a configuration literal in code |
| `AsrPipeline` / `AsrPipelineVersion` | **KEEP; do not merge** | A pipeline is a multi-stage graph (ASR + VAD + denoise), not a provider choice. Instead, add `stt.transcribe` bindings and let the pipeline reference the binding, or scope the binding's `modelSlug` to the ASR stage. `AsrPipeline.isDefault` then becomes redundant with the binding default — **owner decision** on which one wins |
| `TenantSttConfig` | **KEEP** | `fallbackPipelineId` + `autoSwitchEnabled` are policy, not provider selection |
| `node.config.llmBinding` | **WIDEN** | Change `{ modelSlug }` to `{ bindingId }` (or keep `modelSlug` and add optional `bindingId`) so a node names one *provider configuration*, satisfying requirement 7 exactly. Keep the fail-closed resolution at `harness-policy.service.ts:549-573` |

### H5. Task-key vocabulary — additions required

Widen `AI_TASK_KEYS` (`ai-task-default/constants.ts:37-61`) and its two companions
(`AI_TASK_MODEL_TASK_TYPES` `:69-102`, and the generated `models.<taskKey>` descriptors
`model-defaults.descriptors.ts:129`):

| New key | Required `ModelTaskType` | Governance |
|---|---|---|
| `translate.text` | `TRANSLATION` (`enums.prisma:129`) | tenant-configurable (like `text.*`) |
| `stt.transcribe` | `AUTOMATIC_SPEECH_RECOGNITION` (`enums.prisma:141`) | tenant-configurable |
| `tts.synthesize` | `TEXT_TO_SPEECH` (`enums.prisma:139`) | tenant-configurable |

Each addition also needs the console's task-key mirror updated — TASK-799/816 record that mirror
drifting three separate times, so it is a known failure mode.

### H6. Promotion (requirement 5)

Add `AiTaskProviderBindingService.promote(sourceTenantId, targetTenantId, bindingIds[])` modelled
directly on `AgentPromotionService`
(`packages/applications/src/services/agentPromotion/agentPromotion.service.ts:55-...`):
- `assertManagesBothTenants` **before any read**, so a 403/404 difference is never an existence
  oracle;
- run under the **elevated tenant-less** context, passing `tenantId` explicitly on every
  repository call (the tenant-scope extension injects nothing in pass-through mode);
- copy VALUES, never REFERENCES — a `connectionId` is meaningful only inside its owning tenant, so
  promotion must either resolve to the target's own connection for the same `(service, provider)`
  or **block** with a named error, exactly as `documentTemplateId` blocks today;
- **never copy credential material**; a promoted binding that lands on a keyless target connection
  arrives DISABLED;
- land as `enabled=false, isDefault=false` (the DRAFT precedent) so promotion cannot silently
  repoint a live tenant's traffic;
- record `sourceTenantId` / `promotedFromId` / `promotedAt` / `promotedBy` on the row (or a
  separate immutable `AiBindingPromotion` model in `MODELS_WITHOUT_SOFT_DELETE`, mirroring
  `AgentPromotion`).

### H7. Export / import (requirement 6)

- Endpoints on the binding controller: `GET admin/ai-task-bindings/export?ids=…` and
  `POST admin/ai-task-bindings/import`.
- Bundle shape: `{ schemaVersion, exportedAt, exportedBy, sourceTenantId, bindings: [ …, connection: { service, provider, baseUrl, region, apiVersion, deploymentName, extraJson, hasKey: true, apiKey: null } ] }`.
- **Masking is structural, not a filter**: reuse `AiProviderConnectionResponse` (`dto/ai-provider-connection.response.ts:12,37` — physically
  no `apiKey` field, only `hasKey`) as the connection projection, so no code path can serialise
  the ciphertext or the plaintext. Do **not** add a `maskSecrets` boolean — a flag that could be
  set to `false` is the bug.
- Import re-creates bindings and, where the connection is absent in the target, creates it
  **disabled and keyless**, returning a per-row report naming which credentials the admin must
  supply. Never import a key, even one supplied in the file.
- Guard the whole surface with `@ForbidApiKey()` and a super-admin/`manage` check, plus the
  standard authz-matrix regeneration (`pnpm api:route-manifest`, `api:openapi`, `api:portal`,
  `--filter @arcaai/vox-node gen:admin`).

### H8. What must NOT change

- The two-tier cascade shape (request tenant → SYSTEM) and the refusal of a tenant-less resolve
  (`ai-provider-connection.service.ts:658-664`).
- Derived funding (`fundingOf`, `:734-736`) — never stamp it on the new binding row.
- The three-state `enabled` semantics including the tenant VETO (`constants.ts:120-125`).
- `assertWriteAllowed`'s 403 privilege boundary keeping self-host engines SYSTEM-only
  (`:746-760`) — this is what already satisfies requirement 4b for LM Studio and vLLM.
- Vault-Transit-only credential writes (`encryptKey`, `:762-776`).

### H9. Named blockers / owner decisions the redesign needs

1. **Reverse TASK-816's "`AiTaskDefault` survives" decision**, or the merge in H4 cannot proceed.
2. **Decide `AiRoutingPolicy`'s fate** — retire, or reduce to the fallback/health contract. It is
   a shipped, migrated, admin-exposed table with no runtime reader.
3. **Decide MLflow's status**: it is currently a read-only proxy and an `AiModelSource`, not a
   provider. "MLflow-backed vLLM" as a *provider* requires either a new provider id whose
   `baseUrl` points at a vLLM instance whose weights came from MLflow (no new plane), or a genuine
   registry-resolution step at serve time (new plane). TASK-836 recorded that MLflow's
   `--serve-artifacts` proxy is ~110x slower than direct S3, so any design must fetch weights via
   `MLFLOW_S3_ENDPOINT_URL` directly.
4. **Decide Sarvam's LLM status** — either add it to `CLOUD_BYO_PROVIDERS.llm` with a generation
   adapter in `apps/text`, or delete the seeded `llm:sarvam` row (`seed/17-…:321-330`) and keep it
   an stt/tts/translate provider. Also decide whether translate keeps borrowing the `stt` Sarvam
   row (`text-compat.controller.ts:207-215`) or gets its own `service='translate'`.
5. **Decide HuggingFace's status** — owner ruling 2026-08-24 made `model-registry` platform-managed
   with `CLOUD_BYO_PROVIDERS['model-registry'] = []` (`constants.ts:93-107`). Listing HuggingFace
   as an in-scope tenant-configurable *provider* contradicts that ruling and needs an explicit
   reversal.
6. **Decide `AsrPipeline.isDefault` vs the new binding default** — two defaults for one task is the
   exact ambiguity the redesign exists to remove.

---

## Appendix — ticket state (so settled work is not re-planned)

| Ticket | Status | Shipped | Not done / relevant |
|---|---|---|---|
| **TASK-818 Text LLM Router** | In Progress (re-verified 2026-08-31; *"the two headline deliverables are still UNBUILT"*) | SSE resumability + cancellation; LM Studio own provider identity; **`AiRoutingPolicy` schema + migration + domain trio + admin controller** | The OpenAI-standard `/v1/chat/completions` surface (D-2) never built; Lane D not started; **router-side `AiRoutingPolicy` consumer absent** — the table is orphaned; AC-3 TTFT target retracted. **D-5**: provider priority vLLM → LM Studio → Azure OpenAI/Foundry → Bedrock → OpenAI → Anthropic; all existing providers KEPT. **D-6**: super admin authors the SYSTEM default routing policy + failover chain; tenant enabled+keyed connection overrides. **§3A.4**: `explicitProvider.mode = STRICT` — a named-but-down provider returns 503, never silent substitution. The ticket names the "one default per task" gap explicitly: *"one primary + one fallback… no ordered N-way candidate chain"* |
| **TASK-831 Model Catalogue Alignment** | Review — **research + proposal only, nothing applied** | nothing | Finds TASK-818 D-5's engine priority **inverted** for GGUF (vLLM GGUF support deprecated; llama.cpp/LM Studio is the serving tier). 4 owner decisions outstanding |
| **TASK-816 Legacy Config Retirement** | Completed (all 4 phases) — **but the Phase 4 migration is authored and NOT applied to any shared DB** | `llmBinding: { modelSlug }` node field + shared resolver; live sensor-threshold defect fix; `HarnessPolicy.safetyProvider`/`safetyModel` dropped; two hardcoded literals (`lm-studio`, `granite-guardian-4.1-8b`) removed | **OWNER DECISION 2026-08-29: `AiTaskDefault` SURVIVES; the "drop the tables" goal is WITHDRAWN for it** — only `text.live`/`text.finalize`/`text.test` moved to `llmBinding`. `PipelinePolicy` and 22/24 `HarnessPolicy` columns must stay. Console task-key mirror still missing `guardrail.pii*` |
| **TASK-803 Deployment Config Plane Alignment** | Completed, live-verified 2026-08-31 | `smr`→`text` rename, `TEXT_URL` routing, 32 dead `SMR_*` vars deleted, CI env gate regenerated, seed-time `SECRETS_PROVIDER=vault` wired into `db-migrate.yaml` | The 4 self-hosted `AiProviderConnection` rows were never read back post-seed — *"structural proof, not row-level"*. No AI-provider-policy decisions minted |
| **TASK-799 Python Config Plane Consolidation** | Review — all phases implemented, 3 items need an owner decision | 5 credential-leak BLOCKERs closed; `ProviderService` widened to 7 values reusing the BYO contract (**D-2: never invent a third home**); text 121→12 env fields, stt 110→34, tts 53→22; harness judge/retrieval creds onto the BYO plane; Python drift gate | **D-6 (most load-bearing for this redesign)**: *"the built-in inference solutions are PLATFORM-MANAGED. LM Studio, Ollama, Transformers + HuggingFace, llama.cpp and (future) vLLM are built-in solutions, not tenant vendor accounts… `CLOUD_BYO_PROVIDERS['model-registry']` is now empty… Per-task model SELECTION is deliberately unchanged: `SUPER_ADMIN_ONLY_TASK_PREFIXES` stays `['nlp.','harness.']`, so `text.*`/`guardrail.*` remain tenant-overridable over a SYSTEM default."* **D-1**: anything varying by tenant is PUSHed; a service receiving no injected tenant config FAILS CLOSED. **D-4**: NLP models are platform-shared, no tenant BYO. Zero MLflow mentions |
| **TASK-835 S3-Mounted Model Store** | Review (infra spike, untracked) | nothing | LM Studio serves from a `mountpoint-s3` mount (PASS); downloading *into* the mount FAILS → read-only mount + out-of-band sync job. vLLM 0.28.0 has **no GGUF support at all**; arm64 image is CUDA-only. One bucket can serve both engines but not one artifact format |
| **TASK-836 MLflow Registry + vLLM Metal** | Review (infra spike, untracked) | nothing | MLflow + MinIO in k8s with `vllm-metal` (MLX plugin) on the macOS host; registered + served a 767MB Q8_0 GGUF end-to-end. **MLflow `--serve-artifacts` proxy is ~110x slower than direct S3** — clients must use `MLFLOW_S3_ENDPOINT_URL`. `vllm-metal` GGUF is legacy-quant-only (Q8_0/Q4_0/Q4_1) and text-only. Reverses TASK-835's "vLLM can't do GGUF" **only for the Metal/MLX path** |

## Appendix — REST surface inventory (today)

| Route | Controller | Governs |
|---|---|---|
| `admin/providers/:service` · `:service/:provider` (GET/PUT/DELETE) | `apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts:62,70,80,96,138` | `AiProviderConnection`, service-first |
| `admin/ai-providers` (GET/PUT/DELETE) | same file `:175,185,194,205,237` | **legacy duplicate**, assumes `service='llm'` |
| `admin/ai-task-defaults` | `apps/api/src/modules/ai-task-default/ai-task-default-admin.controller.ts:59` | `AiTaskDefault` |
| `admin/ai-runtime-profiles` | `apps/api/src/modules/ai-runtime-profile/ai-runtime-profile.controller.ts:35` | `AiRuntimeProfile` |
| `admin/routing-policies` | `apps/api/src/modules/ai-routing-policy/ai-routing-policy-admin.controller.ts:82` | `AiRoutingPolicy` (no runtime reader) |
| `admin/ai-models` | `apps/api/src/modules/ai-model/ai-model-admin.controller.ts:23` | `AiModel` |
| `admin/ai-models/discovery` · `discovery/register` | `apps/api/src/modules/ai-model/ai-model-discovery.controller.ts:28,42` | enumerate models on ollama / lm-studio / llama-cpp / vllm servers and register `AiModel` rows |
| `admin/ai-services/{guardrail,nlp}/…` · `mlflow/{status,experiments,registered-models,model-versions}` | `apps/api/src/modules/ai-service-admin/ai-service-admin.controller.ts:37,44-111` | read-only backend status; MLflow proxy |
| `/internal/stt/provider-overrides` · `/internal/stt/model-registry-credential` | `apps/api/src/modules/internal/stt-internal.controller.ts:357,308` | Python pull channel |
