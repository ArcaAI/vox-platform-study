# TASK-506 — AI Model Registry Consolidation & Centralized Task-Model Configuration

| | |
|---|---|
| **Status** | `Review` (implemented + adversarially reviewed 2026-07-17; guardrail configuration is GLOBAL-ADMIN-ONLY per owner directive) |
| **Type** | `refactor` (seed/catalog consolidation) + `feature` (centralized model config for Guardrail / NLP / TTS) |
| **Branch** | `fix/2605-review` (builds on uncommitted TASK-504/505/496 work) |
| **Ticket number** | TASK-506 (provisional — highest existing is TASK-505; confirm) |
| **Author** | Claude (plan), 2026-07-17 |

---

## 1. Requirement Analysis

Two coupled requirements from the owner (2026-07-17):

### R1 — Clean up and consolidate `DEFAULT_AI_MODELS` (seed `06-stt.ts`)

1. **Audio / STT**: keep only the models the 8-pipeline product matrix (TASK-505) actually references.
2. **Summarization / Guardrail / Text generation**: replace the current 31 LLM+guardrail rows with exactly:

   | Provider | Identifier | Arch | Format | Role |
   |---|---|---|---|---|
   | `ollama` | `gemma4:12b-mlx` | gemma4 | MLX | |
   | `ollama` | `gemma4:e2b-it-qat` | gemma4 | GGUF | |
   | `ollama` | `qwen3.5:2b` | qwen3.5 | GGUF | |
   | `lm-studio` | `granite-guardian-4.1-8b` | granite | GGUF | **default — Guardrail** |
   | `lm-studio` | `gemma-4-e2b-it-qat` | gemma4 | GGUF | **default — text/summarization** |
   | `lm-studio` | `gemma-4-e4b-it-qat` | gemma4 | GGUF | |
   | `lm-studio` | `gemma-4-medical-icd10` | gemma4 | GGUF | |
   | `lm-studio` | `google/gemma-4-12b-qat` | gemma4 | GGUF | |
   | `lm-studio` | `medgemma-1.5-4b-it` | gemma3 | GGUF | |
   | `azure` | `gpt-5.4-mini` | — | cloud | endpoint/key/deployment supplied by admins |

   > Normalization note: the owner wrote `lmstudio`; the codebase-canonical provider string is **`lm-studio`** (`HarnessPolicy` seed `13-harness-policy.ts:29`, guardrail `Settings.provider` allowed values `lm-studio|ollama|azure|bedrock`, GlobalSetting seed `11-global-setting.ts:405-415`). This plan uses `lm-studio` everywhere.

3. **NLP (NER + classification)**: two `built-in` (transformers-library) models: `blaze999/Medical-NER` (SAFETENSOR, NER) and `shanover/symps_disease_bert_v3_c41` (SAFETENSOR, classification / diagnosis suggestion).
4. **TTS**: five engines with admin-selectable voice bindings:
   - `azure` — Azure neural voices (`en-IN-NeerjaNeural`, `en-IN-PrabhatNeural`, `ml-IN-SobhanaNeural`, `ml-IN-MidhunNeural`)
   - `built-in` — `kokoro` (ONNX; `af_heart`, `am_adam`)
   - `sarvam` — Bulbul (`ishita`, `shubh`)
   - `built-in` — `ai4bharat/indic-parler-tts` (SAFETENSOR; `Anjali`)
   - `built-in` — `ai4bharat/IndicF5` (SAFETENSOR; `ml-ref-1`) — experimental, prod NO-GO (TASK-494), seeded DISABLED

### R2 — Centralized, configurable model registration for **Guardrail, NLP, TTS**

Align these three services with the platform pattern already used by STT (pipeline registry) and SMR (HarnessPolicy defaults): model choices come from the DB control plane, not env vars; **global admins** set platform defaults (SYSTEM-tenant rows) and **tenant admins** override for their tenant.

---

## 2. Current State Evaluation (verified 2026-07-17, four parallel exploration agents + spot checks)

### 2.1 The `AiModel` registry

- Schema: [stt.prisma:101-162](../../../packages/database/src/prisma/db_main/stt.prisma) — per-tenant rows, `@@unique([tenantId, slug])`, **no relations** (pipelines reference models by slug inside `configYaml`). Fields include `category`, `taskType`, `modelType`, `source`, `sourceUri`, `format`, `memorySizeMb`, `computeType`, download-tracking, soft-delete. **No `provider` column, no `architecture` column** — provider identity is currently folded into `tags` (`'ollama'`, `'lm-studio'`, …) and `sourceUri`.
- `AiModelFormat` already contains `SAFETENSOR, ONNX, NEMO, PYTORCH, CTRANSLATE2, FASTER_WHISPER, MLX, GGUF, ONNX_OPTIMUM, AZURE_SPEECH, AZURE_FOUNDRY, PARAKEET_CPP` — **GGUF and MLX already exist**. `ModelTaskType` already contains `GUARDRAIL`, `TEXT_TO_SPEECH`, `TOKEN_CLASSIFICATION`, `TEXT_CLASSIFICATION`, `TEXT_GENERATION`, `SPEAKER_EMBEDDING`, … (52 members).
- Allow-lists: `AiModel` is in `TENANT_SCOPED_MODELS` **and** `SYSTEM_SHARED_READ_MODELS` (tenant reads widen to `[tenant, SYSTEM]`; writes never widen), and is **not** in `MODELS_WITHOUT_SOFT_DELETE` (soft delete active).
- Consumers: `AiModelService` CRUD behind `GET/POST/PATCH/DELETE /api/v1/admin/ai-models` (**global-admin-only**, TASK-419 Decision 6); tenant provisioning clones the SYSTEM catalog into new tenants (`tenant.service.ts:204-245`) gated by `tier:*` tags (`model-access.ts` — untagged rows clone to every tier, which is the current seed's behavior); admin-console feature `apps/admin-console/src/features/ai-models/` (screen + form sheet) already exists.
- **`apps/stt` reads `AiModel`/`AsrPipeline` directly via SQLAlchemy** (read-only mirrors in `core/database/models.py`; `pipeline/config_reader.py` resolves pipeline slugs → model rows). ⚠ Its `AiModelFormatType` ENUM mirror is drifted (missing all 8 post-TASK-356/505 values).
- **The browser SDK does NOT read the DB catalog.** `packages/agentic-sdk-v2` (ModelRegistry/PipelineRegistry) and `packages/utils/src/model-registry.ts` use hardcoded lists; the `/api/v1/ai-models` fetch was deliberately removed (regression-tested in `constants.task210.test.ts:764-768`). Retiring browser-local rows cannot break the SDK.

### 2.2 Seed reality (`06-stt.ts`)

- `DEFAULT_AI_MODELS` = **60 rows** (10 ASR, 4 VAD, 1 speaker-embedding, 3 noise, 4 server-side ONNX whisper, 11 Ollama LLM, 3 Azure LLM, 2 Bedrock LLM, 1 OpenAI-compat LLM, 13 LM Studio LLM, 1 guardrail, 7 browser-local whisper).
- Upsert is `{tenantId, slug}` match, update-or-create, **no pruning** — rows removed from the seed list become silent orphans in existing DBs. `backfillCustomerTenantAiModels` clones the catalog into `SEED_TENANT_ID` (Global) and `ARCAAI` (create-only), and `TenantService.provisionTenantModelCatalog` does the same for every newly created tenant — so retirement must sweep **all tenants' copies**, not just SYSTEM.
- Only **8 slugs are referenced by any seeded pipeline** `models:` block: `whisper-large-v3-turbo`, `silero-vad-v6`, `rnnoise`, `faster-whisper-large-v3-turbo-int8`, `whisper-small`, `azure-speech-stt`, `mai-transcribe-1.5`, `nemotron-3.5-asr-streaming-0.6b`. The ECAPA embedding is referenced **inline** (`hf_model_id: speechbrain/spkrec-ecapa-voxceleb`) by 4 configs — the `ecapa-tdnn-voxceleb` row itself is unreferenced by slug. The 3 legacy v1.1 template pipelines use inline `hf_model_id`s only. **The other 52 rows are referenced by nothing in the STT path.**
- **The 25 LLM rows + granite row are consumed by no runtime code path at all** (only tenant-provisioning clone + admin CRUD display). SMR/HarnessPolicy never query `AiModelRepository`.

### 2.3 Existing per-tenant model-default mechanisms (fragmented — four of them)

| # | Mechanism | Storage | Used by |
|---|---|---|---|
| 1 | STT backend pipeline default | `AsrPipeline.isDefault` + `GlobalSetting['default-stt-pipeline']` + per-user override | `UserPreferencesService.resolveRemoteConfig` (3-tier) |
| 2 | Frontend (browser) ASR default | `TenantFrontendConfig.asrModel` | SDK via `/tenant/me/config` |
| 3 | SMR generation default | `HarnessPolicy.smrProvider/smrModel` (tenant row → SYSTEM row → throw); SYSTEM seed = `lm-studio` / `gemma-4-e2b-it-sft-rlvr-medical` (`13-harness-policy.ts:29-30`); `safetyProvider/safetyModel` = `lm-studio`/`granite-guardian-4.1-8b` (`:49-50`, consumed by harness PHI-egress activities) | gateway `applySmrModelSelection` injects when caller omits `model` |
| 4 | Guardrail LLM default (dormant) | `GlobalSetting` namespace `guardrail`: `default-guardrail-provider`=`lm-studio` (locked), `default-guardrail-model`=`granite-guardian-4.1-8b` (locked), `guardrail-azure-deployment` (`11-global-setting.ts:404-440`) | guardrail's own `TenantConfigResolver` (`tenant_config.py`, TASK-338) — **but `GUARDRAIL_DB_CONFIG_ENABLED` defaults `False`**, so env wins today |

Plus the uncoordinated UI-listing keys `default-smr-provider` / `default-smr-model` / `smr-provider-models` (`11-global-setting.ts:359-…`) read by `GET /text/providers` & `/text/guardrail-providers` — unrelated to mechanism 3.

### 2.4 Guardrail service today (`apps/guardrail`)

- Two live inference paths: **Path A** `POST /api/guardrail/analyze` → GLiNER ONNX (`hivetrace/gliner-guard-uniencoder-onnx`), eager-loaded, no LLM, no tenant awareness (gateway `AiInferenceClient` sends no `X-Tenant-Id`); **Path B** `POST /api/medical/validate` → guardian LLM via `openai_compat` (`lm-studio` provider, `granite-guardian-4.1-8b` env default), the only tenant-aware path (SMR forwards `X-Tenant-Id`; guardrail resolves per-tenant provider/model from `GlobalSetting` when `db_config_enabled` — off by default).
- All model/provider selection is env-defaulted in `core/config.py` (prefixes `GUARDRAIL_OLLAMA_`, `GUARDRAIL_OPENAI_COMPAT_`, `GUARDRAIL_AZURE_`, `GUARDRAIL_BEDROCK_`, `GUARDRAIL_GLINER_`, `GUARDRAIL_V2_GROUNDEDNESS_`, root `GUARDRAIL_V2_PROVIDER`). The Granite BYOC `<guardian>/<score>` protocol (`_granite.py`) is dead in live routes — Path B uses a plain-JSON guardian prompt.

### 2.5 NLP service today (`apps/nlp`)

- Three model slots, all env-named, eager-loaded singletons, **no per-request model selection, no DB config of any kind**: doc-type classifier (`TEXT_CLASSIFIER_MODEL_NAME`, deliberately an `__UNCONFIGURED__` sentinel), Medical NER (`TOKEN_CLASSIFIER_MODEL_NAME` = `blaze999/Medical-NER`), diagnosis suggester (`MEDICAL_SUGGESTER_MODEL_NAME` = `shanover/symps_disease_bert_v3_c41`).
- ⚠ Root `.env.dev`/`.env.example`/`.env` set `TEXT_CLASSIFIER_MODEL_NAME=michellejieli/emotion_text_classifier`, **contradicting** the in-code retirement of that placeholder (`nlp/core/config.py:96-106`) — cleanup item.
- Gateway fronts exactly one route for product use: `POST /ai/nlp/entities` → `POST {NLP_URL}/api/v1/classify/tokens` (no tenant id, no model field). `/diagnosis/suggestions`, `/classify/text`, `/extract`, WS routes are not proxied by `apps/api`.

### 2.6 TTS today (`apps/tts` + TASK-496/504)

- tts is stateless; per-tenant config is resolved by the gateway (`TenantTtsConfigService.getEffective` — tenant row over SYSTEM row over `PLATFORM_TTS_LIMITS` code defaults) and injected per request (`speech-proxy.controller.ts:61-85` batch; `tts-ws.gateway.ts` init-frame enrichment). BYO Azure/Sarvam keys are Vault-Transit ciphertext in `TenantTtsProviderCredential` (the TASK-504 canonical Class-2 pattern).
- **The voice catalog is a hardcoded Python constant** `DEFAULT_VOICES` (`catalog/voices.py:29-34`) with exactly the voices R1 lists (internal ids `en-female-1`, `en-male-1`, `ml-female-1`, `ml-male-1` → per-provider bindings). The provider universe is a hardcoded TS constant (`platform-limits.ts:45-64`). Admins can pick default internal voice ids and reorder providers, but **cannot see or change bindings, add voices, or disable an engine platform-wide**.
- `ModelTaskType.TEXT_TO_SPEECH` and `AiModelEntity.isTTS` exist but are **dormant** — zero TTS rows seeded, zero queries.
- Admin UI: `apps/admin-console` `(tenant)/tts-config` screen (Configuration + Credentials tabs) shipped in TASK-504 Phase 4.

### 2.7 The alignment pattern to follow (TASK-504 §6.10 + shipped exemplars)

DB is the control plane; Vault only encrypts. Class-3 "cascading behavioral config" = dedicated table + resolver cascade (tenant → SYSTEM → code default) + OCC + WORM where sensitive; every admin-facing setting registers a `SettingDescriptor` in `packages/applications/src/services/settings-registry/descriptors/` and is assembled into `HOPE_SETTINGS_REGISTRY`. Cross-tenant admin routes use `resolveScopedTenantId` (`?tenantId=` for global admins, CLS-pinned for tenant admins). Gateway-resolved injection into stateless Python services is the shipped pattern for both SMR (`applySmrModelSelection`) and TTS (`applyTenantConfig`).

---

## 3. Target Design

### 3.1 Registry rows become machine-actionable

Add two nullable columns to `AiModel` (additive migration):

- `provider String?` — canonical lowercase ids: `ollama` | `lm-studio` | `azure` | `bedrock` | `built-in` | `sarvam`. String (not enum) to match the existing free-text `HarnessPolicy.smrProvider` / guardrail provider switch; DTO-validated with `@IsIn`.
- `architecture String?` — e.g. `gemma4`, `gemma3`, `qwen3.5`, `granite`, `whisper`, `conformer`.

Conventions (no schema change needed):
- `sourceUri` carries the **provider-native identifier** actually sent to the runtime (`gemma4:12b-mlx`, `google/gemma-4-12b-qat`, `blaze999/Medical-NER`, `azure://speech-to-text`, `bulbul:v3`). `slug` stays the stable registry key.
- `metaData` (JsonB) carries per-model extras: TTS `{ "voices": [{id, locale, gender?}] }`; Azure LLM `{ "azureDeployment": "<name>" }` (endpoint/key stay platform env or a future BYO credential row — never plaintext in metaData).
- One new `AiModelFormat` value: **`CLOUD_API`** (generic cloud engine; used by Sarvam TTS + `gpt-5.4-mini`; Azure Speech/Foundry rows keep their existing specific values). Alternative: per-vendor `SARVAM_API` — decided against to stop enum-per-vendor growth. **Owner may veto.**

### 3.2 One new Class-3 table: `AiTaskDefault`

The generalization of `HarnessPolicy.smrProvider/smrModel` for every non-pipeline task:

```prisma
model AiTaskDefault {
  // meta fields (house template)
  metaData Json?  @map("_metadata") @db.JsonB
  version  Int    @default(1) @map("_version")
  id       String @id @default(uuid(7))
  tenantId String
  // core
  taskKey    String   // 'guardrail.validate' | 'nlp.ner' | 'nlp.classification'  (extensible)
  modelSlug  String   // references AiModel.slug within [tenant, SYSTEM] scope (no FK, house style)
  configJson Json?    // task-specific extras (e.g. thresholds) — optional
  // resource status + audit fields (house template) …
  @@unique([tenantId, taskKey], name: "AiTaskDefault_tenant_task_unique")
  @@index([tenantId], name: "AiTaskDefault_tenantId_idx")
  @@schema("core")
}
```

- Resolution: **tenant row → SYSTEM row → service env fallback** (guardrail/NLP keep their env defaults as last-resort bootstrap, mirroring SMR's provider `default_model`s).
- Writes validate `modelSlug` against an ENABLED `AiModel` in `[tenant, SYSTEM]` with a compatible `taskType` (`guardrail.validate` → `GUARDRAIL`; `nlp.ner` → `TOKEN_CLASSIFICATION`; `nlp.classification` → `TEXT_CLASSIFICATION`).
- TTS gets **no** `AiTaskDefault` rows — `TenantTtsConfig` already is the tenant knob store; adding a second store would duplicate it (§3.4).
- SMR migration onto `AiTaskDefault` is explicitly **out of scope** (HarnessPolicy already satisfies the requirement); a follow-up ticket may unify later.
- Allow-lists: add to `TENANT_SCOPED_MODELS` **and** `SYSTEM_SHARED_READ_MODELS` (mirroring `HarnessPolicy`/`TenantTtsConfig`: tenant reads widen to `[tenant, SYSTEM]` so effective resolution sees the platform row; writes never widen; tenant rows shadow SYSTEM in the service merge).
- **Governance (owner, 2026-07-17): `guardrail.*` task keys are GLOBAL-ADMIN-ONLY.** Tenant admins may read the effective guardrail default, but every write to a `guardrail.*` key passes a service-level `isSuperAdmin` guard (`ForbiddenException` for tenant admins), and the descriptor's `editableBy` points at the global-admin resource. `nlp.*` keys remain tenant-editable via `manage:AiTaskDefault`.
- Rejected alternative: keep extending `GlobalSetting` KV keys (guardrail's TASK-338 path). Less new code, but it is exactly the "second, uncoordinated catalog" anti-pattern TASK-504 calls out, has no slug validation, and the seeded rows are `locked: true` (global-admin-only), which fails the tenant-admin requirement.

### 3.3 Guardrail & NLP runtime alignment

- **Guardrail** (smallest change that centralizes it): keep the shipped `TenantConfigResolver` direct-DB pattern, repoint its SQL from `GlobalSetting` keys to `AiTaskDefault ⋈ AiModel` (`taskKey='guardrail.validate'`, tenant → SYSTEM), returning `{provider, model=sourceUri, azure_deployment?=metaData}`. Flip `GUARDRAIL_DB_CONFIG_ENABLED` default to `True` (env still wins when the DB is unreachable — resolver already falls back to the env-built provider). Gateway `AiInferenceClient` starts forwarding `X-Tenant-Id` on guardrail calls so Path A can resolve later too (GLiNER itself stays env-pinned — auxiliary engine, not an admin-selectable model; same for groundedness/MiniCheck).
- **NLP** (gateway-injection, keeping the service DB-free like tts): request DTOs gain optional `model_name`; services move from fixed singletons to a **model-id-keyed lazy cache** (default models still eager-loaded at startup from env fallback); gateway `AiInferenceController` resolves `nlp.ner` (and `nlp.classification` when the diagnosis route gets fronted) via the new `AiTaskDefaultService` and injects `model_name` + `X-Tenant-Id` per request. Bound the cache (e.g. 2–3 pipelines, LRU-evict) to protect memory.
- **Providers-listing consolidation**: `GET /text/providers` and `GET /text/guardrail-providers` stop reading the ad-hoc `GlobalSetting` JSON keys and instead list ENABLED `AiModel` rows (`taskType IN (TEXT_GENERATION, SUMMARIZATION)` / `GUARDRAIL`) grouped by `provider` — the registry becomes the single UI catalog. The `smr-provider-models`/`default-guardrail-*` GlobalSetting seed rows are retired (soft-deleted) with a Change-History note.

### 3.4 TTS alignment (registry = platform catalog; TenantTtsConfig stays the tenant knob store)

1. Seed the 5 TTS engines as SYSTEM `AiModel` rows (`taskType=TEXT_TO_SPEECH`, `category=AUDIO`, voices in `metaData.voices`); IndicF5 seeded `resourceStatus=DISABLED` (prod NO-GO).
2. `platform-limits.ts` `providerUniverse` + voice option lists become **derived from the registry** (SYSTEM ENABLED TTS rows; code constants remain the fallback when the catalog is empty). Disabling a TTS `AiModel` row then disables that provider platform-wide (effective-config resolution filters `allowedProviders`/routing chains against ENABLED providers).
3. Admin-selectable **voice bindings**: `TenantTtsConfig.configJson.voiceBindings` (`{internalVoiceId: {provider: providerVoiceName}}`) validated against `metaData.voices`; SYSTEM row = global default bindings. Gateway enrichment (`applyTenantConfig` / `maybeEnrichInit`) additionally injects `voice_bindings`; tts accepts the override and falls back to its built-in `DEFAULT_VOICES`. tts stays stateless and boots fine with no DB anywhere.
4. Admin-console tts-config screen: voice fields become selects sourced from the registry catalog; a bindings editor appears under Configuration (design-gate note: TASK-504 precedent allowed building without a Figma frame on explicit owner direction — needs the same call here).

### 3.5 Settings-registry descriptors

New `descriptors/model-defaults.descriptors.ts` registering `models.guardrail.validate`, `models.nlp.ner`, `models.nlp.classification` (tier `db-config`, maxScope tenant; `editableBy` = the global-admin resource for `models.guardrail.validate`, `'AiTaskDefault'` for the two `nlp.*` keys) + a `tts.voiceBindings` descriptor; assembled into `HOPE_SETTINGS_REGISTRY`. `EffectiveSettingsService.resolveEffective` gains a `models.*` branch delegating to `AiTaskDefaultService`.

---

## 4. Seed Consolidation Detail (R1)

**60 rows → 26 rows** (10 kept, 50 retired, 16 added). Slug convention: provider-prefixed for LLMs (existing `ollama-*`/`lms-*` convention), bare for engines/task models.

### 4.1 KEEP (10)

| Slug | Why |
|---|---|
| `whisper-large-v3-turbo` | ASR of `production`, `turbo`, `no-postprocessing`, `no-preprocessing` pipelines |
| `whisper-small` | ASR of `lightweight` pipeline |
| `faster-whisper-large-v3-turbo-int8` | ASR of CT2 pipeline |
| `azure-speech-stt` | Azure Speech pipeline |
| `mai-transcribe-1.5` | Azure Foundry pipeline (D4 preview) |
| `nemotron-3.5-asr-streaming-0.6b` | parakeet.cpp pipeline |
| `silero-vad-v6` | VAD of all 4 whisper pipelines |
| `rnnoise` | denoise of `production` + `no-postprocessing` |
| `ecapa-tdnn-voxceleb` | diarization embedding (TASK-505 D1) — currently inline-referenced by 4 configs; row kept as the catalog record |
| `granite-guardian-4.1-8b` | slug continuity (referenced by `HarnessPolicy.safetyModel` + guardrail defaults); row **updated**: `provider='lm-studio'`, `architecture='granite'`, `format=GGUF`, `taskType=GUARDRAIL` |

All keep-rows get `provider`/`architecture` backfilled (`built-in` for local engines, `azure` for the two cloud rows).

### 4.2 RETIRE (50) — soft-delete, never hard-delete

ASR: `whisper-large-v3`, `whisper-medium`, `faster-whisper-large-v3`, `parakeet-ctc-1.1b` · VAD: `silero-vad-v4`, `silero-vad-v5`, `pyannote-vad` · Noise: `deepfilternet-v3`, `nvidia-cleanunet` · Server ONNX whisper: all 4 `whisper-*-onnx` · Browser-local: all 7 (`whisper-tiny/base/small-local/medium-local/tiny-en/base-en/small-en`) — safe: the SDK's lists are hardcoded and `TenantFrontendConfig.asrModel` is free-text · LLM: all 11 `ollama-*`, `gpt-4`, `gpt-4o`, `gpt-4o-mini`, both Bedrock Claude rows, `local-model-openai-compat`, all 13 `lms-*`.

Mechanism (new, the seed currently has none): a `RETIRED_AI_MODEL_SLUGS` list in the seed; for each slug, across **all tenants**, set `resourceStatus='DELETED'` + `resourceStatusUpdatedAt/By` + `version: {increment: 1}` (idempotent — skip already-DELETED). **Safety guard**: before retiring a slug, scan `AsrPipeline.configYaml LIKE '%<slug>%'` across all non-deleted pipelines; if referenced (a tenant built a custom pipeline on it), skip + log loudly instead of breaking `config_reader._to_model_config` resolution.

### 4.3 ADD (16)

LLM (9 new; `category=NLP`, `taskType=TEXT_GENERATION`, `modelType=QUANTIZED_MODEL` where QAT/GGUF):

| Slug | provider | sourceUri | arch | format |
|---|---|---|---|---|
| `ollama-gemma4-12b-mlx` | ollama | `gemma4:12b-mlx` | gemma4 | MLX |
| `ollama-gemma4-e2b-it-qat` | ollama | `gemma4:e2b-it-qat` | gemma4 | GGUF |
| `ollama-qwen3.5-2b` | ollama | `qwen3.5:2b` | qwen3.5 | GGUF |
| `lms-gemma-4-e2b-it-qat` | lm-studio | `gemma-4-e2b-it-qat` | gemma4 | GGUF — tags `['default','summarization']` |
| `lms-gemma-4-e4b-it-qat` | lm-studio | `gemma-4-e4b-it-qat` | gemma4 | GGUF |
| `lms-gemma-4-medical-icd10` | lm-studio | `gemma-4-medical-icd10` | gemma4 | GGUF |
| `lms-gemma-4-12b-qat` | lm-studio | `google/gemma-4-12b-qat` | gemma4 | GGUF |
| `lms-medgemma-1.5-4b-it` | lm-studio | `medgemma-1.5-4b-it` | gemma3 | GGUF |
| `azure-gpt-5.4-mini` | azure | `gpt-5.4-mini` | — | CLOUD_API — `metaData.azureDeployment` empty until admins configure |

NLP (2; `category=NLP`, `source=HUGGINGFACE`, `provider='built-in'`, format SAFETENSOR): `medical-ner` (`blaze999/Medical-NER`, `TOKEN_CLASSIFICATION`), `symps-disease-bert-v3-c41` (`shanover/symps_disease_bert_v3_c41`, `TEXT_CLASSIFICATION`).

TTS (5; `category=AUDIO`, `taskType=TEXT_TO_SPEECH`, voices in `metaData.voices`): `azure-neural-voices` (azure, AZURE_SPEECH, 4 voices), `kokoro` (built-in, ONNX, 2 voices), `sarvam-bulbul` (sarvam, CLOUD_API, `sourceUri=bulbul:v3`, 2 voices), `indic-parler-tts` (built-in, SAFETENSOR, `Anjali`), `indic-f5` (built-in, SAFETENSOR, `ml-ref-1`, **DISABLED**, tags `['experimental','no-prod']`).

### 4.4 Companion seed updates (consistency)

- `13-harness-policy.ts`: SYSTEM `smrModel` `gemma-4-e2b-it-sft-rlvr-medical` → **`gemma-4-e2b-it-qat`** (owner-declared platform default; provider stays `lm-studio`). `safetyProvider/safetyModel` unchanged.
- `11-global-setting.ts`: retire the `smr-provider-models` / `default-smr-*` / guardrail-namespace rows once §3.3's registry-backed listing + `AiTaskDefault` land (same ticket, later phase — keep both alive only within the migration window inside this ticket).
- New seed step: SYSTEM `AiTaskDefault` rows — `guardrail.validate → granite-guardian-4.1-8b`, `nlp.ner → medical-ner`, `nlp.classification → symps-disease-bert-v3-c41`.
- Seed-file split (acknowledged TASK-505 leftover): extract `DEFAULT_AI_MODELS` into per-domain modules (`seed/ai-models/{audio,llm,nlp,tts}.ts`) imported by `06-stt.ts` — orchestrator order unchanged.
- SMR env fallbacks aligned in `.env.example` comments only (`SMR_OPENAI_COMPAT_DEFAULT_MODEL` etc. remain last-resort).

---

## 5. Implementation Plan (phased; layer order per `01-development-workflow`)

> TDD throughout: every phase lists tests written **first**. Domain-layer note: `gen:model`/`gen:entity`/`gen:factory` are run (CI drift gates); `gen:mapper`/`gen:repository` crash pre-existingly → hand-author mapper/repository following the `TenantTtsConfig*` exemplars.

### Phase 1 — Database groundwork
1. `enums.prisma`: add `AiModelFormat.CLOUD_API`. `stt.prisma`: add `provider String?`, `architecture String?` (+ `@@index([provider])`). New `ai-task-default.prisma` per §3.2.
2. `pnpm db:migrate:create` → `task_506_model_registry_consolidation` (review SQL: 2 `ALTER TABLE ADD COLUMN`, 1 `ALTER TYPE ADD VALUE`, 1 `CREATE TABLE`). ⚠ Dev/test DBs are `db push`-managed and behind migration history — apply the enum/table SQL via `psql` additively (per DB-gotchas runbook), never reset.
3. Allow-lists: `AiTaskDefault` → `TENANT_SCOPED_MODELS` + `SYSTEM_SHARED_READ_MODELS`.
4. Sync `apps/stt/core/database/models.py` enum mirrors (add all 9 missing `AiModelFormat` values incl. `CLOUD_API`) — fixes the pre-existing drift this table-wide change would otherwise widen.
- **Tests first**: `packages/database` client tests for `AiTaskDefault` tenant-scope + soft-delete injection; stt unit test asserting the SQLAlchemy format mirror matches the Prisma enum member list.
- **Gate**: migration SQL reviewed; `pnpm db:generate`; `pnpm --filter @arcaai/database test`.

### Phase 2 — Seed consolidation (R1)
1. Split model arrays (§4.4), rewrite per §4.1–4.3, add `RETIRED_AI_MODEL_SLUGS` sweep with the pipeline-reference guard, update `13-harness-policy.ts`, add `AiTaskDefault` SYSTEM seeds.
2. `backfillCustomerTenantAiModels` unchanged (create-only, now clones 26).
- **Tests first**: seed unit tests — final catalog = expected 26 slugs per tenant; retired slugs DELETED across all tenants; a fabricated custom pipeline referencing `whisper-large-v3` blocks that slug's retirement; keep-set exactly covers every slug referenced by seeded pipeline YAML (regression lock).
- **Gate**: `pnpm db:seed` twice (idempotent) against dev DB; `pnpm py:stt:test` (pipeline resolution suites stay green).

### Phase 3 — Domain + applications
1. `AiTaskDefault` trio (hand-authored mapper/repo per memory) + `CoreDatabaseModule` registration + barrels.
2. `AiTaskDefaultService` (`getEffective(taskKey, tenantId)` tenant→SYSTEM merge; `upsertRow` with OCC + slug/taskType validation + `broadcastSysEvent`; 404-over-403).
3. `AiModel` DTOs/mapper/service: expose `provider`/`architecture`; `create/update` request validation (`@IsIn` providers).
4. Settings-registry descriptors (§3.5) + `EffectiveSettingsService` `models.*` branch.
5. TTS: `platform-limits`/`TenantTtsConfigService` derive provider universe + voice options + `voiceBindings` validation from registry rows (code-constant fallback).
- **Tests first**: effective-resolution matrix (tenant set / SYSTEM only / neither→null); upsert rejects unknown slug, wrong taskType, cross-tenant slug (404); DTO mapper round-trip with new columns; TTS voiceBindings validation against `metaData.voices`; registry duplicate-key assembly guard.
- **Gate**: `pnpm --filter @arcaai/domains build test`; `pnpm --filter @arcaai/applications build test`.

### Phase 4 — API gateway
1. `AiTaskDefaultAdminController` — `GET admin/ai-task-defaults/effective?taskKey=`, `GET/PUT admin/ai-task-defaults/row` (OCC `@RequiresIfMatch` + `@ExpectedVersion`), all with `?tenantId=` via `resolveScopedTenantId`; reads `@CanRead('AiTaskDefault')`, writes `@CanManage('AiTaskDefault')` (tenant-grantable for `nlp.*`) **plus the service-level global-admin guard for `guardrail.*` keys** (tenant-admin write → 403). Policy seed grants tenant admins read+manage on `AiTaskDefault`.
2. `AiInferenceClient/Controller`: forward `X-Tenant-Id` on guardrail + NLP calls; resolve + inject `model_name` for NLP entities.
3. Repoint `/text/providers` + `/text/guardrail-providers` to registry queries.
4. TTS enrichment: include resolved `voice_bindings`.
- **Tests first**: controller unit tests (OCC 428/412, tenant scoping 404-over-403, global-admin `?tenantId=`); inference-client tests asserting injected headers/fields; providers-listing tests against seeded registry; cross-tenant e2e spec for the new admin surface (task-307 pattern).
- **Gate**: `pnpm build:api`; `pnpm test:unit`; `pnpm test:e2e` (with `pnpm test:api:up`).

### Phase 5 — Python services
1. **Guardrail**: `tenant_config.py` resolver → `AiTaskDefault ⋈ AiModel` SQL; `db_config_enabled` default `True`; keep 60s TTL cache + env fallback; add `GUARDRAIL_DB_CONFIG_ENABLED`/`GUARDRAIL_DATABASE_URL` to `.env.dev` + `turbo.json#globalEnv`.
2. **NLP**: optional `model_name` on classify/diagnosis DTOs; model-keyed LRU (size 3) pipeline cache with startup preload of env defaults; remove the stray `TEXT_CLASSIFIER_MODEL_NAME=michellejieli/...` from root env files.
3. **tts**: accept `voice_bindings` override in `SpeechRequest` + WS init frame; `VoiceCatalog.get` consults override first.
- **Tests first** (pytest): guardrail resolver unit tests (tenant override, SYSTEM fallback, env fallback on DB error, TTL cache); NLP cache tests (per-model isolation, LRU bound, unknown-model 4xx, sentinel still 503s); tts binding-override routing tests.
- **Gate**: `pnpm py:guardrail:test`, `py:nlp:test`, `py:tts:test`, + `py:<svc>:lint`/`typecheck`.

### Phase 6 — Admin console (design-gated)
1. ai-models screen/form: `provider`, `architecture`, voices/metaData display; provider filter chip.
2. New "Task model defaults" surface — dropdowns fed by registry rows per taskKey. **The guardrail default lives on a global-tier (10–19) screen only** (invisible to tenant admins); NLP defaults render on a shared-tier surface (global admins cross-tenant via `?tenantId=`, tenant admins tenant-scoped).
3. tts-config: voice selects + bindings editor from catalog.
- Design gate: owner directed immediate implementation (2026-07-17) — built without Figma frames per the TASK-504 precedent; frames may be back-filled.
- **Gate**: `pnpm --filter @arcaai/admin-console build lint test`; axe 0 violations; both themes.

### Phase 7 — Verify & document
- Full evidence run: affected package tests/builds/lint, `pnpm db:seed` idempotency, guardrail+NLP+TTS happy-path through a running gateway (env-gated where live models are required).
- Update this README (Implementation Summary + Change History), `docs/development-patterns-and-standards.md` §6.10 cross-reference, service READMEs, `.env.example`, `turbo.json#globalEnv`.

---

## 6. Env-Var Deprecation Ledger (R2 "avoid environment variable declaration")

| Var | Fate |
|---|---|
| `GUARDRAIL_OPENAI_COMPAT_*_MODEL`, `GUARDRAIL_OLLAMA_*_MODEL`, `GUARDRAIL_V2_PROVIDER` | Demoted to bootstrap fallback (DB wins when reachable) |
| `GUARDRAIL_DB_CONFIG_ENABLED` | Default flips `True`; declared in `.env.dev`/`turbo.json` |
| `TOKEN_CLASSIFIER_MODEL_NAME`, `MEDICAL_SUGGESTER_MODEL_NAME` | Demoted to bootstrap fallback |
| `TEXT_CLASSIFIER_MODEL_NAME` (root env files) | **Removed** (contradicts sentinel design) |
| `TTS_AZURE_VOICE_EN/ML`, `TTS_KOKORO_VOICE`, `TTS_PARLER_SPEAKER_*`, `TTS_SARVAM_VOICE_*` | Demoted to fallback behind injected `voice_bindings` |
| `SMR_*_DEFAULT_MODEL` | Unchanged (already fallback-only behind HarnessPolicy) |
| GLiNER / groundedness vars | Unchanged (auxiliary engines, not admin-selectable) |

## 7. Out of Scope

SMR/HarnessPolicy storage rework · Bedrock provider removal from service configs · registry entries for GLiNER/MiniCheck/punctuation/`vad_model_path`-style auxiliary models · browser SDK hardcoded lists · switching pipeline embedding refs from inline to slug · per-tenant BYO Azure OpenAI credentials for SMR (candidate follow-up reusing the TTS credential pattern).

## 8. Decisions (resolved 2026-07-17 — owner approved implementation start)

1. **Ticket number** TASK-506 — confirmed by proceeding.
2. **Retire semantics**: soft-`DELETED` (hidden from reads, recoverable).
3. **Browser-local + `whisper-large-v3`/`whisper-medium` retirement** — proceed.
4. **`CLOUD_API`** generic format value — proceed.
5. **`gpt-5.4-mini` credentials**: platform env + `metaData.azureDeployment`; per-tenant BYO is a follow-up.
6. **NLP diagnosis route**: fronted through the gateway in this ticket (small controller addition) so the `nlp.classification` default takes real effect.
7. **Default summarization model** → `gemma-4-e2b-it-qat` (replaces SFT-RLVR-medical SYSTEM default).
8. **Phase 6 design gate**: build without Figma frames (owner directive, TASK-504 precedent).
9. **Guardrail governance (owner directive)**: guardrail model configuration is exclusively global-admin-managed — tenant admins cannot change any guardrail configuration; enforcement at service level (`isSuperAdmin` on `guardrail.*` writes) + descriptor `editableBy` + UI placement on the global tier.

## 9. Implementation Summary

Implemented 2026-07-17 (owner-approved same day) via one inline foundation phase + five parallel agents in disjoint file lanes, followed by an 11-agent adversarial review workflow (3 finder lenses → verifier per finding) and a fix round.

### What shipped (by lane)

1. **DB groundwork (inline)** — `AiModel.provider`/`architecture` columns (+`AiModel_provider_idx`), `AiModelFormat.CLOUD_API`, `ResourceType.AiTaskDefault`, new `AiTaskDefault` table (`ai-task-default.prisma`); migration `20260717120000_task_506_model_registry_consolidation` (applied to dev DB via psql per runbook, together with the previously-unapplied TASK-505 enum migration); allow-lists (`TENANT_SCOPED_MODELS` + `SYSTEM_SHARED_READ_MODELS`) + drift-guard test; stt SQLAlchemy enum mirrors synced (were 9+ values stale) with a new drift-guard pytest.
2. **Seeds** — `DEFAULT_AI_MODELS` 60 → 26 (split into `seed/ai-models/{shared,audio,llm,nlp,tts,retired}.ts`); 50-slug soft-retirement sweep across ALL tenants with a boundary-aware pipeline-reference guard; `backfillCustomerTenantAiModels` gains a `provider IS NULL` column-sync for pre-506 clones; `13-harness-policy.ts` SYSTEM `smrModel` → `gemma-4-e2b-it-qat`; 6 superseded GlobalSetting rows retired + `default-stt-model` → `whisper-large-v3-turbo`; new `16-ai-task-default.ts` (SYSTEM defaults: guardrail.validate→granite-guardian-4.1-8b, nlp.ner→medical-ner, nlp.classification→symps-disease-bert-v3-c41); `01-policy.ts` tenant-admin read/manage `AiTaskDefault` grants.
3. **Domain + applications** — `AiTaskDefault` trio (mapper/repo hand-authored per generator limitation) + `CoreDatabaseModule`; `AiTaskDefaultService` (tenant→SYSTEM effective resolution, slug/taskType validation, **`guardrail.*` writes gated by `isSuperAdmin` → 403**, sys-events, OCC); AiModel DTOs expose provider/architecture; settings-registry `model-defaults.descriptors.ts` + `EffectiveSettingsService` `models.*` branch; `TenantTtsConfigService` registry catalog (`getPlatformCatalog`), `voiceBindings` validation + effective merge.
4. **Gateway** — `/admin/ai-task-defaults` (`''` effective, `row` OCC GET/PUT, `options` tenant-accessible picker), `/admin/tts-config/catalog`; `X-Tenant-Id` + registry-resolved `model_name` injection on NLP calls; new `POST /ai/nlp/diagnosis` fronting; `/text/providers` + `/text/guardrail-providers` repointed from GlobalSetting keys to the registry; TTS enrichment injects `voice_bindings`; e2e cross-tenant spec authored.
5. **Python services** — guardrail `TenantConfigResolver` repointed to `AiTaskDefault ⋈ AiModel` (model = `sourceUri`, provider column, `azureDeployment` from metaData; `db_config_enabled` default **True**; fail-open + TTL preserved, DB errors negatively cached); NLP optional `model_name` on classify/diagnosis routes + LRU(3) model cache (default instances protected; stray `TEXT_CLASSIFIER_MODEL_NAME` removed from root env files); tts `voice_bindings` override (MERGE over catalog bindings — preserves failover).
6. **Admin console** — ai-models screen/form gains provider+architecture; new `/ai-task-defaults` (global tier 10-19, incl. the platform-controlled guardrail card) + `/ai-model-defaults` (tenant tier 30-49, **NLP keys only**); tts-config voice selects + voice-bindings editor fed by the catalog endpoint; nav + permission gating.

### Adversarial review round (same day)

3-lens find → adversarial-verify workflow: 12 findings → 8 verified, **8 confirmed / 0 refuted** (4 unverified by cap were duplicates/minors of confirmed ones). Deduped to 6 defects + 2 minors, all fixed: (A, critical) SYSTEM/cross-tenant `AiTaskDefault` writes went through the tenant-scoped client — global admin with a working tenant got eternal 412/500 on platform-default saves; fixed via the `HarnessPolicyService` base-client pattern + repository catch narrowing + e2e case with realistic `x-tenant-id`; (B, security) caller-supplied `modelName` reached NLP unvalidated (arbitrary HF model pull) — now validated against ENABLED `TOKEN_CLASSIFICATION` registry rows; (C) `provisionTenantModelCatalog` dropped provider/architecture/metaData on runtime tenant creation; (D) tts partial voice-binding override replaced (not merged) the binding map, breaking failover; (E) explicit tenant pinning defeated SYSTEM-shared-read widening on registry listings/options; (F) disabling a TTS registry row didn't disable the provider platform-wide; (+minors: guardrail DB-error negative caching, guardrail enum-mirror drift).

### Evidence (final gate runs)

| Suite | Result |
|---|---|
| `@arcaai/database` build + test | 786 passed (23 files) |
| `@arcaai/domains` build + test | 1358 passed (incl. 10 review-fix tests) |
| `@arcaai/applications` build + test | 6301 passed (incl. 19 review-fix tests) |
| apps/api build + vitest | **2245 passed, 0 failed** (the formerly-failing `env-port-standardization` suite was fixed by concurrent branch work and now passes 386/386) |
| apps/stt full unit | 2344 passed |
| apps/guardrail | 102 passed + **live dev-DB resolution smoke** (provider `lm-studio`, model `granite-guardian-4.1-8b` via SYSTEM row) |
| apps/nlp | 98 passed |
| apps/tts | 145 passed |
| admin-console | build 56/56 pages; lane tests 58 passed; full suite 945 passed + 4 pre-existing tenant-wizard failures (chip spawned) |
| `pnpm db:seed` (dev DB) | idempotent ×2; per tenant 25 ENABLED + 1 DISABLED (indic-f5) + 50 DELETED; `AiTaskDefault` ×3 SYSTEM rows; superseded GlobalSetting rows DELETED |

### Environment actions taken (local dev)

Dev Vault had been wiped since TASK-504: re-ran `dev-init.sh` in `hope-vault` (kv seeds incl. `API_KEY_PEPPER`, transit keys `hope-globalsetting`/`hope-phi`, approle) — required for `db:seed`'s PHI encryption. Applied both enum migrations via psql. Soft-deleted the 4 stale TASK-505 dev-DB pipelines (`best-practice-batch`, `best-practice-realtime`, `nemo-parakeet-english`, `optimized-faster-whisper`) so the retirement guard could release `parakeet-ctc-1.1b`/`deepfilternet-v3` (no jobs/user-overrides referenced them).

### Owner follow-ups

- Commit the branch (all TASK-506 work is uncommitted on `fix/2605-review`).
- Env-gated: live gateway e2e (`pnpm test:api:up` was blocked by a concurrent 8868 process), headed-browser pass on the two new screens, real LM Studio/ollama round-trips.
- Delete stale `TEXT_CLASSIFIER_MODEL_NAME` from the gitignored root `.env` (~line 256).
- Figma frames for `/ai-task-defaults` + `/ai-model-defaults` may be back-filled (built under the owner's no-frames directive).
- Pre-existing-issue task chips: playground-llm lint (3), tenant-wizard tests (4). (The env-port-standardization chip was withdrawn — fixed by concurrent branch work.)

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-17 | Plan created from 4-agent codebase exploration + spot verification (schema, seeds, guardrail/NLP/TTS config flows, TASK-504 framework). Status `Pending`. |
| 2026-07-17 | Owner approved; guardrail config restricted to global admins (no tenant-admin writes); open questions resolved (§8); status `In Progress`; implementation started (Phase 1 inline + parallel agents for seeds / domain+applications / Python services, then gateway, then admin console). |
| 2026-07-17 | All 6 lanes implemented + verified (see §9 evidence); dev DB seeded to target state; dev Vault re-initialized; adversarial review (11 agents) confirmed 8 findings — fix round applied (critical tenant-scope write fix, NLP model-id validation, clone column pass-through, shared-read registry listings, TTS registry-driven disable, tts binding merge, guardrail minors). Status → `Review`. |
