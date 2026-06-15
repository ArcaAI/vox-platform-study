# TASK-356 — Phase 2 (Defaults wiring) — TDD Implementation Plan

| Field | Value |
|---|---|
| **Ticket** | TASK-356 — Admin-Managed Models & Workflows |
| **Phase** | Phase 2 — Defaults wiring (the three target default models) |
| **Status** | **Implemented — Phase 2 complete** (decisions resolved; see [`README.md`](./README.md) §8B for the as-built summary) |
| **Date** | 2026-06-14 (planned) · 2026-06-15 (reconciled + implemented) |
| **Author** | Planner (subagent) · reconciled from two parallel planning runs |
| **Scope of this doc** | Historical planning artifact. The authoritative record of what shipped is README §8B + Change History. One factual correction applied post-hoc (§3.1, SYSTEM `HarnessPolicy` row); open questions resolved in §12. |

---

## 1. Purpose

Point the platform's **default model selections** at the three target models from §1.1 / §4.8 of the
ticket [`README.md`](./README.md), **without** changing any gating/thresholds, any cloud provider
activation, or the SMR runtime. Concretely:

1. **(a) SMR → `mlx-community/medgemma-1.5-4b-it`** — set the **SYSTEM-tenant `HarnessPolicy`
   global-default** `smrProvider='lm-studio'` + `smrModel='mlx-community/medgemma-1.5-4b-it'` (today this
   resolves to `null`), and update the `GlobalSetting smr/default-smr-model` value for UI consistency.
2. **(b) Guardrails → `granite-guardian-4.1-8b`** — **confirm/verify only**. Already the default
   everywhere and already cataloged (Phase 1). No value change.
3. **(c) STT → faster-whisper, whisper-large-v3-turbo CT2 int8** — register a new `AiModel`
   (`faster-whisper-large-v3-turbo-int8`), add a new `AsrPipeline`
   (`production-faster-whisper-turbo-int8`), and switch the per-tenant default + the default-pipeline
   `GlobalSetting` keys to it. The CT2 conversion artifact is an **external prerequisite (D-4,
   engineer-owned)** — this plan registers + wires it, it does **not** run the conversion.
4. **Clone propagation** — confirm how the new defaults reach existing + new tenants.

**This phase is seed + config only.** No schema/migration (§5), no service/DTO change (§4), no
`apps/harness/**` / `apps/smr/**` / sensor change (§10).

---

## 2. Scope & decisions applied

### In scope
- **Seed:** a new SYSTEM `HarnessPolicy` global-default row; `GlobalSetting smr/default-smr-model`
  value flip; one new `AiModel` catalog row; one new `AsrPipeline` (per tenant) + `isDefault` switch;
  `GlobalSetting` default-pipeline-slug switches; an idempotent existing-tenant default-switch backfill.
- **Tests:** seed assertions (TS, `@arcaai/database`) + one STT YAML-validity unit test (Python,
  `apps/stt-v2`).

### Out of scope (drawn as hard boundaries in §10)
- **Phase 3 (D-7) SMR gateway refactor** — "no SMR default; pass the resolved model on EVERY call incl.
  legacy + DNA." Phase 2 only **sets** the value the harness path already consumes.
- **TASK-357 (PHI egress / cloud activation)** — medgemma + granite + faster-whisper are **all
  local** (`lm-studio` / MLX / GGUF / CT2-on-disk), so Phase 2 activates **no** cloud provider and is
  **not** gated by TASK-357. (The README §8 gating note applies to *cloud* provider activation only.)
- **TASK-358/359 gating & thresholds**, and the audio-console runtime (Phase 4, already shipped).

### Decisions applied
- **D-4 (self-convert / model-repo).** The CT2 int8 turbo artifact is produced + published by
  engineers; this plan treats `AiModel.sourceUri` / the pipeline `hf_model_id` as the pull contract and
  needs a real repo path (Q-1).
- **D-5 (clone-per-tenant).** The new `AiModel` row propagates to tenants via the **existing** Phase-1
  clone machinery (runtime `provisionTenantModelCatalog` + seed `backfillCustomerTenantAiModels`) — no
  new clone code (§6).
- **D-7 boundary.** Acknowledged but **not** implemented here.

### Gaps addressed
- **G-3** — SMR default ≠ requested (`HarnessPolicy.smrModel` null) → §4.A.
- **G-4** — STT default ≠ requested (no CT2-int8 pipeline/`AiModel`) → §4.C.
- **G-1/G-2/G-5** — already closed by Phase 1 (catalog + enum + granite/medgemma). Not re-planned.

---

## 3. Current state (grounded — every claim cited `path:line`)

### 3.1 SMR default (a)

- **`HarnessPolicy` is the wired source of truth** for the harness summarization model. Columns
  `smrProvider String?` / `smrModel String?` have **no DB default** (null) —
  `packages/database/src/prisma/db_main/harness.prisma:284-285`. `safetyProvider`/`safetyModel` default
  to `lm-studio` / `granite-guardian-4.1-8b` — `harness.prisma:279-280`.
- **Code defaults** `HARNESS_POLICY_DEFAULTS` — `packages/domains/src/factories/generated/core/HarnessPolicyFactory.ts:18-35`:
  `smrProvider: null`, `smrModel: null` (lines 29-30); `safetyModel: 'granite-guardian-4.1-8b'` (line 28).
- **Resolution** `getEffectivePolicy()` —
  `packages/applications/src/services/harness-policy/harness-policy.service.ts:127-138`: tenant own row →
  `findSystemDefault()` → else `codeDefaultResponse()` (code defaults). `findSystemDefault()` =
  `findForExactTenant(SYSTEM_TENANT_ID)` — `packages/domains/src/repositories/generated/core/HarnessPolicyRepository.ts:38-41`.
- **A SYSTEM `HarnessPolicy` data row DOES exist** — it is bootstrapped by the migration
  `20260607120000_task_330_phase6_harness_policy/migration.sql:103-109` (`INSERT … ON CONFLICT
  ("tenantId") DO NOTHING`) with `smrProvider`/`smrModel` left **NULL**. The `seed/**` TS files only add
  **CASL policy** grants (`seed/01-policy.ts:120,367,384`), not a data row — which is why a `seed/**`
  grep finds nothing, even though the row is present on any migrated DB. → **Today every tenant's
  effective `smrModel` resolves to that row's NULL value** (effective null, but the row exists). ⇒ Phase
  2 **UPDATEs the two SMR columns on the existing SYSTEM row** (idempotent upsert, A1) — it does not
  create a missing row.
  > **Correction (2026-06-15):** an earlier draft stated "no SYSTEM row is seeded" and inferred a
  > code-default fallthrough; that missed the migration's raw `INSERT`. Ground truth: the row exists with
  > NULL SMR. The A1 upsert is correct either way; this note records the fix.
- **Harness consumes it (read-only confirmation, no change here):** the internal policy endpoint maps
  `smrProvider`/`smrModel` (`apps/harness/src/harness/api/endpoints/internal.py:94-95,157-158`); the
  workflow uses `smr_model = inp.smr_model or policy.smr_model` and passes `model=smr_model` to the
  generate activity (`apps/harness/src/harness/temporal/workflows.py:293-294,415-416,594-595`); the
  model maps it nullable, "None ⇒ SMR default" (`apps/harness/src/harness/temporal/models.py:160-198`).
  **So setting the SYSTEM `HarnessPolicy.smrModel` is sufficient for the harness path to send medgemma —
  no harness change.**
- **`GlobalSetting smr/default-smr-model`** value today is `google/gemma-4-e4b`, `locked: true` —
  `packages/database/src/prisma/db_main/seed/11-global-setting.ts:371-381` (seeded per-tenant ×4).
  `default-smr-provider = 'lm-studio'` — `11-global-setting.ts:359-369`. medgemma is already in the
  SMR catalog dropdown (`smr-provider-models`) — `11-global-setting.ts:99`.
- **No test pins `default-smr-model === google/gemma-4-e4b`.** `seed-smr-provider-models.test.ts:111`
  asserts the *catalog* contains `google/gemma-4-e4b` (membership, unaffected). `tenant.service.test.ts:1365-1374`
  uses `granite4:latest` as a *validation* fixture (unaffected). `tenant.service.ts:861-862` reads
  `default-smr-model` as a **key** for catalog validation — no hardcoded gemma value.

### 3.2 Guardrail default (b)

- **`HarnessPolicy.safetyModel` default = `granite-guardian-4.1-8b`** (`harness.prisma:280`,
  `HarnessPolicyFactory.ts:28`). **`GlobalSetting guardrail/default-guardrail-model` = `granite-guardian-4.1-8b`,
  locked** (`11-global-setting.ts:411-422`). **Cataloged in Phase 1**: `AiModel`
  `granite-guardian-4.1-8b`, `taskType=GUARDRAIL`, `format=GGUF`, under SYSTEM
  (`seed/06-stt.ts:909-925`; asserted `seed.test.ts:989-996`). **⇒ Nothing to change for (b).**
- **`GUARDRAIL_DB_CONFIG_ENABLED` defaults `false`** (env-only) — `apps/guardrail/.env.example:112`;
  the harness already passes `safetyModel` to the guardrail call, so DB-config is not required (Q-2).

### 3.3 STT default (c)

- **Catalog (`AiModel`)** seeded under SYSTEM in `seed/06-stt.ts`; the local enum mirror (lines 39-48)
  has `SAFETENSOR/ONNX/NEMO/PYTORCH` + Phase-1 `MLX`,`GGUF` — but **not `CTRANSLATE2`/`FASTER_WHISPER`**
  (they exist in the Prisma enum + domain enum, just not yet mirrored in this seed file). `ModelType`
  includes `QUANTIZED_MODEL` (`06-stt.ts:68`). Existing slug `faster-whisper-large-v3` is a **different**
  model (Systran, `format=ONNX`, `06-stt.ts:147-163`; asserted `seed.test.ts:969-972`) — **no slug
  collision** with the new `faster-whisper-large-v3-turbo-int8`.
- **`backfillCustomerTenantAiModels`** (`06-stt.ts:2095-2120`) clones **all** `DEFAULT_AI_MODELS` into
  the 4 customer tenants idempotently (skip-if-slug-exists, strips `id`/`tenantId`). Called from
  `seedStt` after `seedAiModels` (`06-stt.ts:2212-2217`). **⇒ a new `DEFAULT_AI_MODELS` row auto-clones
  to existing tenants on re-seed.**
- **Pipelines (`AsrPipeline`)** seeded by `seedAsrPipelines` (`06-stt.ts:2122-2167`) from three arrays:
  `DEFAULT_ASR_PIPELINES` (SYSTEM, `06-stt.ts:1541-1643`), `GLOBAL_TENANT_ASR_PIPELINES`
  (`SEED_TENANT_ID`, `06-stt.ts:1753-1774`), `CUSTOMER_TENANT_ASR_PIPELINES` (ArcaAI/4bits/Mumbai,
  `06-stt.ts:1664-1728`). The current default per tenant is `production-whisper-large-v3` (`isDefault: true`).
  **No `AsrPipelineVersion` is seeded** (grep `seed/**` = none) — only `AsrPipeline` rows.
- **Idempotent re-seed deliberately does NOT clobber `isDefault` on update** (`06-stt.ts:2141-2156`) —
  it only refreshes `name/description/configYaml/tags`. **⇒ flipping `isDefault` in seed source affects
  only NEWLY-created rows; existing rows keep their default.** This is the crux of the existing-tenant
  switch (Q-3 / §6.3).
- **`GlobalSetting` default-pipeline knobs:**
  - SYSTEM `stt.config/defaults`: `batch_pipeline_slug = 'production-whisper-large-v3'`
    (`06-stt.ts:2003-2013`), `streaming_pipeline_slug = 'turbo-whisper-large-v3'` (`06-stt.ts:2014-2024`).
  - Global-tenant `default-stt-pipeline` → pipeline **id** `81000000-…-0401`
    (`seed/91-user.ts:1028-1051`).
  - `GlobalSetting stt/default-stt-model = 'whisper-large-v3'`, locked (`11-global-setting.ts:332-343`) —
    a *model* slug, not a pipeline (left unchanged; see Q-4 note).
- **Resolution precedence** (`UserPreferencesService.resolveRemoteConfig`,
  `packages/applications/src/services/user/userPreferences/userPreferences.service.ts:263-315`):
  per-user admin `assigned-pipeline` → **tenant `AsrPipeline.isDefault`** → `GlobalSetting
  default-stt-pipeline`. **⇒ the tenant `isDefault` row wins over the GlobalSetting**, so switching the
  default genuinely requires flipping `isDefault` (not just the GlobalSetting).
- **YAML parser supports the target shape** (`apps/stt-v2/src/stt_v2/pipeline/yaml_parser.py`):
  inline `engine: faster_whisper` (or `faster-whisper`) → `AiModelFormat.FASTER_WHISPER`
  (test `tests/unit/test_yaml_parser_faster_whisper.py:37-67`); model `compute_type` validated against
  `VALID_CT2_COMPUTE_TYPES` which **includes `int8`** (`pipeline/dto.py:208-211`); `inference.compute_type`
  accepts `int8` (`yaml_parser.py:241-245`); `diarization` is a recognised top-level section with
  `enabled` + `max_speakers` (`yaml_parser.py:49-58,610-621`).
- **`FasterWhisperLoader` supports `compute_type=int8` + local/HF paths** —
  `apps/stt-v2/src/stt_v2/models/faster_whisper_loader.py:31-36,53-60` (uses `local_path` if it exists,
  else `source_uri`). **Confirms the README claim.**

### 3.4 Clone host (new tenants)

- `tenant.service.create()` provisions buckets → `provisionTenantConfigs` (GlobalSetting clone from
  `__GLOBAL__`) → default department → **Phase-1 `provisionTenantModelCatalog`** (AiModel clone)
  (`packages/applications/src/services/tenant/tenant.service.ts:95-128,155`). It **does NOT** provision
  `AsrPipeline` rows for new tenants (the repo is injected at `:55` but only `count(...)` is used at
  `:822`). → pipeline propagation to **new** tenants is a pre-existing characteristic (§6.2 / R-3).

### 3.5 No migration needed

- The foundation migration `20260614120000_task_356_catalog_audio_foundation/migration.sql` already
  added `AiModelFormat += CTRANSLATE2/FASTER_WHISPER/MLX/GGUF` (lines 25-28) and `ModelTaskType +=
  GUARDRAIL` (line 32). The domain enum already lists them
  (`packages/domains/src/enums/generated/AiModelFormat.ts:10-11`). **⇒ Phase 2 requires no schema
  change** (§5).

---

## 4. File-by-file change plan (layer order: Seed/config-heavy; no DB/Domain/App/API code)

> Order: DB → Domain → Applications → API → **Seed/config**. Phase 2 touches **only Seed + one Python
> test**. Each item lists its covering test.

### 4.A — SMR default → medgemma (G-3)

| # | File | N/M | Change | Covering test |
|---|---|---|---|---|
| A1 | `packages/database/src/prisma/db_main/seed/13-harness-policy.ts` | **N** | New seed step `seedHarnessPolicy(client)`: idempotent **upsert** of ONE SYSTEM-tenant `HarnessPolicy` row (key = `tenantId = SYSTEM_TENANT_ID`, the `@@unique([tenantId])`). `create` sets `smrProvider='lm-studio'`, `smrModel='mlx-community/medgemma-1.5-4b-it'`; all other knobs **omitted** so DB `@default`s apply (thresholds/safety/gate — a faithful snapshot of code defaults). `update` block **does NOT touch `smrProvider`/`smrModel`** so an admin-tuned SYSTEM default survives `db:seed` (mirrors the `enable-local-raw-capture` non-clobber pattern, `11-global-setting.ts:716-718`). | `seed.test.ts` (S-test 1) |
| A2 | `packages/database/src/prisma/db_main/seed/index.ts` | **M** | Import `seedHarnessPolicy`; call it in **Phase 4** right after `seedGlobalSetting(client)` (`index.ts:110`) — no FK deps; SYSTEM tenant exists by Phase 1. | seed runs clean |
| A3 | `packages/database/src/prisma/db_main/seed/11-global-setting.ts` | **M** | Change the `smrModel` setting `value` **and** `defaultValue` from `'google/gemma-4-e4b'` → `'mlx-community/medgemma-1.5-4b-it'` (the single `tenantSettings(...)` definition at `:371-381` flows to all 4 tenants). **UI-consistency only** — the harness authority is `HarnessPolicy` (A1). | `seed.test.ts` (S-test 2) |

**Why a seed row, not a code-default change (recommended Option B; see Q-4):** seeding the SYSTEM row is
additive, requires no migration, matches the documented "SYSTEM tenant owns the GLOBAL-DEFAULT row"
design (`harness.prisma:243-249`), and leaves `HARNESS_POLICY_DEFAULTS` (a hand-maintained "lock-step
with Prisma column @default" constant) untouched. Changing the code default would also require flipping
the nullable `smrProvider/smrModel` column `@default`s to stay in lock-step → an unnecessary migration.

### 4.B — Guardrail default → granite (verify only)

| # | File | N/M | Change | Covering test |
|---|---|---|---|---|
| B1 | — | — | **No change.** Add/keep a verification assertion that `HarnessPolicy.safetyModel` default + `GlobalSetting default-guardrail-model` + the granite catalog row all = `granite-guardian-4.1-8b`. | `seed.test.ts` (S-test 3) |

> `GUARDRAIL_DB_CONFIG_ENABLED` stays `false` (Q-2 recommendation). No `.env`/k3s change.

### 4.C — STT default → faster-whisper CT2 int8 (G-4)

| # | File | N/M | Change | Covering test |
|---|---|---|---|---|
| C1 | `seed/06-stt.ts` — local `AiModelFormat` mirror (`:39-48`) | **M** | Add `CTRANSLATE2: 'CTRANSLATE2'` (the only new value a seed row uses; `FASTER_WHISPER` is the *pipeline engine* string, not the catalog `format`). | covered by C2 test |
| C2 | `seed/06-stt.ts` — `DEFAULT_AI_MODELS` | **M** | Append ASR row `id: '80000000-0000-0000-0001-000000000007'`, `tenantId: DEFAULT_TENANT_ID`, `name: 'Faster Whisper Large V3 Turbo (CT2 int8)'`, `slug: 'faster-whisper-large-v3-turbo-int8'`, `category: AUDIO`, `taskType: AUTOMATIC_SPEECH_RECOGNITION`, `modelType: QUANTIZED_MODEL`, `source: <LOCAL or HUGGINGFACE — Q-1>`, `sourceUri: '<repo path — Q-1>'`, `format: CTRANSLATE2`, `computeType: 'int8'`, `memorySizeMb: ~1700`, `tags: ['multilingual','fast','ct2','int8','production','recommended']`. | `seed.test.ts` (S-test 4) |
| C3 | `seed/06-stt.ts` — `PIPELINE_CONFIGS` | **M** | Add `faster_whisper_turbo_int8` YAML (see §4.C.YAML). `engine: faster_whisper`, model `compute_type: int8`, `inference.compute_type: int8`, `diarization.enabled: true`, **and the `dual_capture` blocks** (so it can be the SYSTEM `isDefault` without breaking the dual-capture invariant, §3.3 / S-test 7). | `test_yaml_parser` (Python, §8) |
| C4 | `seed/06-stt.ts` — `DEFAULT_ASR_PIPELINES` (SYSTEM) | **M** | Add row `id: '81000000-0000-0000-0001-000000000008'`, slug `production-faster-whisper-turbo-int8`, `isDefault: true`; **flip the existing `production-whisper-large-v3` row (`:1541-1555`) to `isDefault: false`** (keep exactly one default). | `seed.test.ts` (S-tests 5,6,7) |
| C5 | `seed/06-stt.ts` — `GLOBAL_TENANT_ASR_PIPELINES` (Global) | **M** | Add row `id: '81000000-0000-0000-0001-000000000403'`, slug `production-faster-whisper-turbo-int8`, `isDefault: true`; flip the Global production row (`:1755-1763`) to `isDefault: false`. | `seed.test.ts` (S-test 6) |
| C6 | `seed/06-stt.ts` — `CUSTOMER_TENANT_ASR_PIPELINES` (ArcaAI/4bits/Mumbai) | **M** | Add one CT2 row per tenant (ids `…0103/…0203/…0303`), slug `production-faster-whisper-turbo-int8`, `isDefault: true`; flip each tenant's existing production row (`…0101/…0201/…0301`) to `isDefault: false`. | `seed.test.ts` (S-test 6) |
| C7 | `seed/06-stt.ts` — `DEFAULT_STT_SETTINGS` (SYSTEM) | **M** | `batch_pipeline_slug` (`:2003-2013`) **and** `streaming_pipeline_slug` (`:2014-2024`) → `'production-faster-whisper-turbo-int8'` (value + defaultValue). | `seed.test.ts` (S-test 8) |
| C8 | `seed/91-user.ts` — Global `default-stt-pipeline` | **M** | Point `value`/`defaultValue` at the new Global CT2 pipeline **id** `'81000000-0000-0000-0001-000000000403'` (`:1037,1046-1047`). | covered by seed run |
| C9 | `seed/06-stt.ts` — `switchTenantDefaultPipelineBackfill(client)` | **N** | Idempotent existing-tenant **default switch** (see §6.3). Per customer tenant: if the current `isDefault` pipeline slug is still the untouched prior seed default (`production-whisper-large-v3`), flip it off and set the CT2 pipeline `isDefault: true` — in one transaction; **skip if an admin has already chosen a non-seed default** (no clobber). Call from `seedStt` after `seedAsrPipelines`. **Gated by Q-3.** | `seed.test.ts` (S-test 9) |

#### 4.C.YAML — `PIPELINE_CONFIGS.faster_whisper_turbo_int8`

```yaml
version: "1.1"

# Production CT2 pipeline: Whisper Large V3 Turbo converted to CTranslate2, int8.
# engine: faster_whisper selects FasterWhisperLoader; compute_type int8 is a
# valid CT2 quantization. dual_capture mirrors the prior production default so
# RAW+PROCESSED capture survives the default switch.
models:
  asr:
    hf_model_id: "<repo path — Q-1, mirrors AiModel.sourceUri>"
    engine: "faster_whisper"
    compute_type: "int8"
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: "onnx"
    version: "v6.0"
  denoise:
    hf_model_id: "nickolay/rnnoise"
    engine: "onnx"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 250
    min_silence_duration_ms: 1000
  denoise:
    enabled: true
    strength: 0.7
  dual_capture:
    enabled: true
    capture_raw: true

inference:
  batch_size: 1
  compute_type: int8
  device: auto
  language: null

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false
  dual_capture:
    enabled: true
    capture_processed: true

diarization:
  enabled: true
  max_speakers: 2
```

> The pipeline `models.asr.hf_model_id` **must equal** the C2 `AiModel.sourceUri` (single source of
> truth) — both are the engineer-owned repo path resolved by Q-1. The pipeline references the model
> **inline** (not by slug) because the slug-only form can't carry `engine`/`compute_type`.

### 4.D — Application / DTO / API

**No change.** Confirmed in §3: `getEffectivePolicy()` already resolves the SYSTEM default;
`resolveRemoteConfig()` already resolves `isDefault` + `default-stt-pipeline`; the Phase-1 `AiModel`
admin surface + clone already exist. Phase 2 adds no service, DTO, controller, or module.

---

## 5. Schema / migration assessment — **none required**

Confirmed (§3.5): the additive enum values the new rows need (`CTRANSLATE2`, and the pipeline-engine
`FASTER_WHISPER`) already exist in `enums.prisma:278-281`, the foundation migration
(`20260614120000_…/migration.sql:25-28`), and the domain enum. `HarnessPolicy.smrProvider/smrModel`
columns already exist (`harness.prisma:284-285`). **No `ALTER`, no `CREATE`, no new migration.** Per the
Prisma migration best-practices rule, an additive-only phase that needs no new column/enum value writes
no migration.

---

## 6. Clone-per-tenant propagation design

### 6.1 SMR default (HarnessPolicy)
**No per-tenant clone needed.** `getEffectivePolicy(tenant)` falls through to the SYSTEM global-default
row when the tenant has no own row (`harness-policy.service.ts:131-137`). Seeding the **one** SYSTEM
row (A1) makes medgemma the effective default for **every** tenant — existing, new, and not-yet-created
— with zero per-tenant rows. A tenant that later edits its own policy overrides it (unchanged behavior).

### 6.2 STT model (AiModel)
**Reuses Phase-1 machinery — no new clone code.** New tenants: the C2 row is included in
`provisionTenantModelCatalog` (it clones *all* SYSTEM `AiModel` rows, `tenant.service.ts:155`). Existing
tenants: `backfillCustomerTenantAiModels` (`06-stt.ts:2095-2120`) clones the new row on the next
`db:seed` (skip-if-exists). Download state resets to `NOT_DOWNLOADED` (factory/column default).

### 6.3 STT pipeline (AsrPipeline) — the one place that needs explicit care
The seeded `isDefault` flip (C4-C6) is **only honored for newly-created rows** because the idempotent
re-seed never clobbers `isDefault` (`06-stt.ts:2141-2156`). So:
- **Fresh DB / new tenants** → CT2 is created as the sole default. ✅ automatic.
- **Existing seeded tenants** → without C9, re-seed would leave the old `production-whisper-large-v3` as
  `isDefault: true` **and** create the CT2 row as `isDefault: true` → **two defaults** (invariant
  break). C9 fixes this with a per-tenant transaction that flips exactly one default — **but only when
  the current default is still the untouched prior seed default**, so an admin's chosen default is never
  silently overridden. **C9 is gated by Q-3** (switch existing tenants, or new-only).
- **New tenants created via `tenant.service`** get **no** `AsrPipeline` rows at all today (§3.4) — a
  pre-existing characteristic; out of scope to fix here (noted R-3). Their STT resolves via the
  `default-stt-pipeline` GlobalSetting cascade.

---

## 7. Authorization / safety posture

Unchanged. Phase 2 sets **model defaults** only. `safetyEnabled`/`phiEnabled`/`phiFailClosed`,
thresholds, gate SLA, `maxRegen`, and the safety/gating cascade max-scope are **untouched** (the seeded
SYSTEM `HarnessPolicy` row takes those columns' DB `@default`s, which mirror the current code defaults —
§3.1). No weakening of any guard. `default-smr-model` / `default-guardrail-model` remain `locked: true`
(SUPER-only).

---

## 8. TDD test list (RED-first), per layer

> Write each test first, watch it fail for the right reason, then implement.

### Seed (TS) — `pnpm --filter @arcaai/database test` (or the `seed.test.ts` suite)
`packages/database/src/__tests__/seed.test.ts` (**M**) + assertions importing from `seed/13-harness-policy.ts`:
1. **S-test 1** — `seedHarnessPolicy` source defines a SYSTEM row with `smrProvider==='lm-studio'` and
   `smrModel==='mlx-community/medgemma-1.5-4b-it'`; and its `update` block omits `smrProvider/smrModel`
   (non-clobber).
2. **S-test 2** — `default-smr-model` setting `value === 'mlx-community/medgemma-1.5-4b-it'` (and it is
   a member of the `smr-provider-models` lm-studio catalog).
3. **S-test 3 (verify)** — `safetyModel`/`default-guardrail-model`/granite catalog row all
   `'granite-guardian-4.1-8b'` (regression guard; mostly already at `seed.test.ts:989-996`).
4. **S-test 4** — `DEFAULT_AI_MODELS` has `faster-whisper-large-v3-turbo-int8` with
   `format===CTRANSLATE2`, `computeType==='int8'`, `taskType===AUTOMATIC_SPEECH_RECOGNITION`,
   `modelType===QUANTIZED_MODEL`, `tenantId===SYSTEM_TENANT_ID`.
5. **S-test 5** — `DEFAULT_ASR_PIPELINES` has `production-faster-whisper-turbo-int8` with `isDefault:true`;
   `production-whisper-large-v3.isDefault === false`.
6. **S-test 6 (update existing invariant tests)** — "exactly ONE isDefault per tenant" still holds across
   SYSTEM + Global + customer arrays (extends `seed.test.ts:1331-1380`); the SYSTEM/Global/customer
   default slug is now `production-faster-whisper-turbo-int8` (replaces the `…:1353-1360` production
   assertion).
7. **S-test 7 (update dual-capture test)** — the SYSTEM `isDefault` pipeline (`seed.test.ts:2225-2231`)
   is now `production-faster-whisper-turbo-int8` and its YAML drives dual capture
   (`capture_raw`/`capture_processed`).
8. **S-test 8 (update)** — `batch_pipeline_slug` and `streaming_pipeline_slug` both reference
   `production-faster-whisper-turbo-int8`, and the slug exists in `DEFAULT_ASR_PIPELINES` (extends
   `seed.test.ts:1220-1240`).
9. **S-test 9 (if Q-3 = yes)** — `switchTenantDefaultPipelineBackfill` is idempotent and only flips a
   tenant whose current default is the untouched prior seed default.

### STT (Python) — `pnpm py:stt-v2:test` (conda `arcaenv`)
`apps/stt-v2/tests/unit/test_yaml_parser_ct2_default_pipeline.py` (**N**):
- `it parses + validates the seeded CT2 default YAML` — inline `engine: faster_whisper`,
  `compute_type: int8` (model + inference), `diarization.enabled/max_speakers`, and dual_capture all
  pass `PipelineYamlParser.parse(...).validate(...)` with `valid is True`. (Mirrors the seeded YAML so we
  guard the exact artifact we ship; complements the generic `test_yaml_parser_faster_whisper.py`.)

### Harness / SMR flow — **no test added/changed here**
The harness already passes `HarnessPolicy.smrModel` (covered by
`apps/harness/.../test_policy_injection.py:79-100` + `test_doc_workflow.py:516-567`). Out of scope.

---

## 9. Verification criteria (layer gates)

Per `.cursor/rules/01-development-workflow.mdc`:

| Layer | Build / apply gate | Test gate |
|---|---|---|
| DB / migration | **N/A** (no schema change). `pnpm --filter @arcaai/database db:migrate:status` clean | — |
| Seed | `pnpm --filter @arcaai/database db:seed` runs clean **and is idempotent on re-run** (no duplicate defaults) | `seed.test.ts` green (S-tests 1-9) |
| STT (Python) | — | `pnpm py:stt-v2:test` green (new YAML test) + existing `test_yaml_parser*` |
| Domain/App/API/UI | unchanged — confirm no compile impact: `pnpm build --filter @arcaai/domains @arcaai/applications` + `pnpm build:api` still green | existing suites unaffected |

Completion also requires (workflow checklist): `ReadLints` clean on touched files; `seed/index.ts`
registration done (A2); ticket README §8/§9 updated with a Phase-2 Implementation Summary + Change
History entry (post-approval).

---

## 10. Overlap boundaries (CRITICAL)

This plan sets **MODEL DEFAULTS only**. It explicitly:
- **does NOT** change gating/thresholds/`maxRegen`/gate timing (TASK-358/359) — the seeded SYSTEM
  `HarnessPolicy` row takes the existing DB `@default`s for those columns (§3.1, §7);
- **does NOT** enable any cloud provider — all three targets are local (`lm-studio`/MLX/GGUF/CT2); TASK-357
  gates *cloud* activation, which is untouched;
- **does NOT** refactor SMR (Phase 3 / D-7) — it only sets the value the harness path already consumes;
- **touches NONE** of: `apps/harness/**` (workflows/activities/models/sensors incl.
  `entailment_batch.py`), `apps/smr/**`, `apps/guardrail/**` runtime,
  `packages/applications/**/consultation/summary/summary.service.ts`,
  `packages/applications/**/consultation/harness/harness-internal.service.ts`, or any harness gating /
  PHI-egress code.

**Files this plan modifies (complete list):** `seed/13-harness-policy.ts` (new), `seed/index.ts`,
`seed/11-global-setting.ts`, `seed/06-stt.ts`, `seed/91-user.ts`, `packages/database/src/__tests__/seed.test.ts`,
`apps/stt-v2/tests/unit/test_yaml_parser_ct2_default_pipeline.py` (new). **No other file.**

**Shared-file coordination:** `seed/06-stt.ts`, `seed/11-global-setting.ts`, `seed/index.ts`, and
`seed.test.ts` were also touched by Phase 1/Phase 4 (already merged) — Phase 2 appends additive rows /
new steps and does not revert their edits. `enums.prisma` is **not** touched by Phase 2 (already has the
values).

---

## 11. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-1 | **Model availability / fallback.** medgemma must be loaded in LM Studio; the CT2 int8 artifact must exist on disk / in the repo. A missing artifact fails the run. | Catalog `downloadStatus` + conservative fallback exist (README R-1). Phase 2 only registers refs; engineers publish the artifact (D-4, Q-1) before flipping in prod. The CT2 conversion is an external prerequisite, not run here. |
| R-2 | **Two-defaults invariant break on existing DBs** when the seeded `isDefault` flip meets the non-clobbering re-seed. | C9 reconciliation in a per-tenant transaction (set exactly one default); gated by Q-3; S-test 9 guards idempotency. |
| R-3 | **New `tenant.service` tenants get no `AsrPipeline` rows** (pre-existing, §3.4), so they rely on the GlobalSetting cascade and won't carry an `isDefault` CT2 row. | Out of scope for Phase 2 (no regression — same as today). Note for a future phase if per-tenant pipeline provisioning is wanted. |
| R-4 | **Accuracy↔speed tradeoff:** making turbo-int8 the *batch* default trades some accuracy for speed vs the prior full `whisper-large-v3` batch default. | Intentional per the ticket (CT2 turbo int8 is THE target default). If batch accuracy must be preserved, keep `batch_pipeline_slug` on a full-v3 pipeline (sub-decision; flag at review). |
| R-5 | **`default-smr-model` value flip clobbers admin override on re-seed** (the GlobalSetting seed `update` block writes `value`, `11-global-setting.ts:689-696`). | It's `locked` (SUPER-only) + "UI consistency"; the harness authority is `HarnessPolicy` (non-clobbered, A1). Acceptable; called out in Q-4. |
| R-6 | **Hard-coded references to the old default pipeline** elsewhere could assume `production-whisper-large-v3`. | Grep at implementation: refs found in `seed.test.ts`, `create-job.request.ts`, `backend-pipelines-tab.tsx`, stt-v2 e2e fixtures — review each; the slug still exists (only its `isDefault` changes), so most are unaffected. Update only the seed-test expectations (S-tests 6-8). |
| R-7 | **Seeding the SYSTEM `HarnessPolicy` row "freezes" the other knobs** at today's code defaults (future code-default changes won't propagate to the seeded row). | Acceptable + intended (a global-default row is meant to be authoritative). The `update` block can be limited to smr fields; other columns rely on DB `@default` at create time. |

---

## 12. Decisions (resolved 2026-06-14) & as-built deltas

All four blocking questions were resolved by the user; **two answers override** the recommendations above.

1. **CT2 `sourceUri` / repo path (Q-1)** → **placeholder** registered now (clearly-marked non-resolving
   value + TODO), `format=CTRANSLATE2`; engineers publish the real artifact before prod (D-4). It will
   not resolve at runtime until then (safe per R-1 fallback).
2. **`GUARDRAIL_DB_CONFIG_ENABLED` (Q-2)** → **left `false`** (recommendation accepted); guardrail is
   verify-only.
3. **Existing-tenant STT default + tenant propagation (Q-3)** → **OVERRIDE.** Instead of the
   backfill-only design in §6.3 / §3.4 / R-3 (which left new-tenant `AsrPipeline` provisioning out of
   scope), the user chose to **extend clone-per-tenant**: `tenant.service.ts create()` now clones the
   SYSTEM default `AsrPipeline` (+ its current `AsrPipelineVersion`, falling back to pipeline-level YAML
   when no version rows) into each new tenant with a tenant-scoped `isDefault`, idempotently (doubles as
   the existing-tenant backfill). The `switchDefaultSttPipeline` reconciliation (C9) still runs to
   preserve the one-default invariant. **Both batch AND streaming** defaults were switched to the CT2
   pipeline.
4. **SMR mechanism (Q-4)** → **Option B** (seed step, no migration) **+ OVERRIDE (seed_worm):** the new
   `seedHarnessPolicy` step writes only `smrProvider`/`smrModel` on the existing SYSTEM row **and**
   records a WORM `HarnessPolicyChange` audit entry for the default-set. `GlobalSetting
   default-smr-model` flipped to `mlx-community/medgemma-1.5-4b-it` (locked).

**As-built record:** see README §8B + Change History. Implemented with all layer gates green (315 seed
tests; `@arcaai/applications` build + 5125 unit tests incl. the tenant-clone suite + 6 new clone tests;
`prisma migrate diff` in-sync → no migration). No git commit was created.
