# TASK-356 — Admin-Managed Models & Workflows (Review / Audit + Design Addendum)

| | |
|---|---|
| **Ticket** | TASK-356 |
| **Title** | Admin-managed AI models & workflows + per-tenant default models |
| **Created** | 2026-06-14 |
| **Updated** | 2026-06-14 |
| **Status** | **In Progress** — Phase 1 (Catalog plane) + Phase 4 (Audio console) **implemented & integration-verified** (2026-06-14). Phases 2, 3, 5, 6 still outstanding. Cloud-provider model **activation** (Phase 2/3) remains **gated on TASK-357** (PHI egress guard). The full 6-phase ticket is not complete. |
| **Type** | feature (admin platform + configuration) |
| **Builds on** | TASK-233 (Administration Section), TASK-302 (System Config / Vault), TASK-328/331/336 (AsrPipeline admin + GLOBAL_ADMIN + shared-read), TASK-338 (admin-configurable SMR/Guardrail engine), TASK-330/355 (HarnessPolicy + optimistic delivery), TASK-294 (prompt-template scopes), TASK-299 (DNA writing style), TASK-332 (local raw capture) |

> Review/audit + design addendum — **now also the implementation record for Phases 1 & 4.** It documents the current state across architecture → data model → API → UI, performs a gap analysis against the requested capability, and proposes an implementation design. The **Decisions** in §7 were taken collaboratively and are **resolved**. Phase 1 (Catalog plane) and Phase 4 (Audio console) have since been **implemented in parallel and integration-verified together** (see **§8 Implementation Summary**); Phases 2, 3, 5, 6 remain outstanding. Plan-gate artifacts: [`phase-1-catalog-plane-plan.md`](./phase-1-catalog-plane-plan.md) · [`phase-4-audio-console-plan.md`](./phase-4-audio-console-plan.md).

---

## 1. Requirement Analysis

### 1.1 What was requested

1. **Let global/super administrators and tenant administrators fully manage (create / configure / update) models *and* workflows.**
2. **Set per-tenant default models** — applied when a new tenant is created and as the fallback for all tenants:
   - **Medical summarization (SMR):** `mlx-community/medgemma-1.5-4b-it`
   - **Guardrails:** `granite-guardian-4.1-8b`
   - **Transcription (STT):** engine **faster-whisper**, model **`whisper-large-v3-turbo` self-converted to CTranslate2 (CT2), quantized int8**

### 1.2 What "workflows" means (clarified)

"Workflows" = **two pillars**, each configurable by admins with a layered scope:

- **Pillar A — Audio-processing pipeline** (real-time or batch transcription):
  - tenant default **local-based vs backend-based** transcription, with a **lock** flag (doctor may override only when unlocked);
  - feature toggles: **diarization (VAD + voice recognition)**, noise cancel;
  - **audio capture & storage**: `raw+processed | raw only | processed only | none`, with **bucket configuration**.
- **Pillar B — Real-time harness** (the documentation pipeline):
  - **summarization prompt/instruction templates by rule** (tenant → department → doctor);
  - **on/off real-time summarization**, **on/off real-time NER**, **gating**;
  - **doctor self-service**: create/update/manage **personal prompt templates**, and **on/off DNA writing style** (style learned from historical data — which requires **capturing & storing every manual change made to approved clinical notes**).

### 1.3 Cross-cutting requirements

- A **model registry/repository** that services pull from. Engineers/developers own model conversion/publishing (e.g., the CT2 int8 conversion); services resolve a model by slug and load the artifact.
- **SMR acts as a stateless gateway** to an LLM provider for text generation (summarization). It has **no default model** — the caller always passes the model resolved from the workflow configuration.
- Catalog is **cloned per tenant** when a global/super admin creates the tenant.

### 1.4 Acceptance criteria (proposed)

- **AC-1** — SUPER/GLOBAL admin manages the **global model catalog** and **global defaults**; TENANT admin manages **their tenant's catalog clone, model selections and both workflows**, within allowed bounds.
- **AC-2** — All model/workflow changes are **audited** (who/when/before-after) with **optimistic concurrency** (If-Match), consistent with existing admin surfaces.
- **AC-3** — A **newly created tenant** inherits the cloned catalog + the three target defaults; existing tenants resolve to the same defaults via the cascade.
- **AC-4** — Config resolves via a **single layered cascade** (`platform → tenant → department → doctor`), with each setting declaring its **maximum scope**; safety/gating never weakened below the tenant level.
- **AC-5** — The three defaults are **registered and effective** on the primary clinical-workspace path with conservative fallback if a model is unavailable.
- **AC-6** — A doctor can **author/manage personal prompt templates** and **toggle their own DNA style**; every manual edit to an approved note is **captured as a draft↔approved delta** feeding DNA.
- **AC-7** — Server-side authorization: tenant admins cannot touch other tenants; platform-locked rows remain SUPER-only; doctors cannot weaken tenant safety/gating.

---

## 2. Current-State Evaluation (Audit + deep-dive)

### 2.1 Architecture & service topology (relevant slice)

```
apps/api (NestJS, 8868)
  ├─ admin controllers  ─►  packages/applications (services) ─► packages/domains ─► packages/database (Prisma, core schema)
  └─ internal controllers (harness/stt callbacks)
apps/ui-playground (React 19, 5175)  ── adminClient (fetch + JWT + X-Tenant-Id + If-Match) ──► apps/api /admin/*
Python model services (env-first pydantic-settings):
  ├─ apps/smr (8862)        — summarization gateway (LM Studio / Ollama / Azure / Bedrock)
  ├─ apps/guardrail (8863)  — safety (Granite Guardian); optional DB-driven per-tenant config
  ├─ apps/stt-v2 (8861)     — transcription; model selected by AsrPipeline (DB) via "pipeline_id"
  └─ apps/harness (8866)    — Temporal workflow; fetches HarnessPolicy from apps/api at run start
```

**Key boundary:** Python services read config from **process env at startup**, with three runtime-DB-aware seams: **Harness** (`fetch_policy` reads `HarnessPolicy` per run), **Guardrail** (reads `GlobalSetting` only if `GUARDRAIL_DB_CONFIG_ENABLED=true`, default off), **STT** (implicitly DB-driven — the caller passes a DB-backed `pipeline_id`). **SMR is env-only** and accepts a per-request `model`.

### 2.2 Tenancy & admin authorization

- **Tenant** (`tenant.prisma`): UUIDv7 root aggregate, unique `key`. No `tenantId` on users; membership via `UserRoleAssignment` + `UserDepartment`.
- **Roles** (`seed/03-role.ts`, `seed/00-constants.ts`): `SUPER_ADMIN` / `GLOBAL_ADMIN` are platform/cross-tenant (under `SYSTEM_TENANT_ID`; `GLOBAL_ADMIN ≡ SUPER_ADMIN` via `ELEVATED_ROLES`); `TENANT_ADMIN` is tenant-scoped (`tenant-full-access`).
- **Enforcement**: CASL (`@CanManage`/`@CanAny`/`@Authorize`) + `UnifiedAuthGuard` + `PolicyEngine.buildAbility()`; tenant scoping via `@TenantOwnedResource` + `isSuperAdmin()`.
- **UI gating**: `RequireAdmin` (SUPER ∪ TENANT), `RequireGlobalScope` (SUPER), header `ScopeSwitcher` (sets `X-Tenant-Id`).
- **Tenant creation** (`tenant.service.ts → create()`): provisions system buckets, **clones all `GlobalSetting` rows from `__GLOBAL__`**, creates a default "GEN" department. **This clone-on-create is the hook for cloning the model catalog + workflow defaults (D-5).**

### 2.3 Model selection — per service (today)

| Service | Config source | Default (today) | Per-tenant override | Admin-manageable today? |
|---|---|---|---|---|
| **SMR** | env `SMR_V2_*` | `google/gemma-4-e4b` (lm-studio); `gpt-5-mini` (azure) | **Via `HarnessPolicy.smrModel`** on harness path | Indirect (HarnessPolicy); SMR env not DB-driven |
| **Guardrail** | env `GUARDRAIL_*` | `granite-guardian-4.1-8b` | **Opt-in** (`GUARDRAIL_DB_CONFIG_ENABLED`) | `GuardrailConfigSection` (effective only when DB path on) |
| **STT** | `AsrPipeline.configYaml` (DB) via `pipeline_id` | `openai/whisper-large-v3-turbo`, **`engine: safetensor`** | **Yes** (`@@unique([tenantId, slug])`, `isDefault`) | **Yes (gold standard)** — `admin/audio/pipelines` UI |
| **Harness safety** | `HarnessPolicy.safetyModel` (cascade) | `granite-guardian-4.1-8b` | **Yes** | Yes — `admin/harness/policy` |
| **Harness judge** | env `HARNESS_JUDGE_*` | `google/gemma-4-e4b` | No | No (process-global) |

### 2.4 Configuration data model

- **`GlobalSetting`** — per-tenant key/value (`smr`,`guardrail`,`stt`,`ux-constants`,`feature-flags`…); `locked`=SUPER-only; OCC `version`. **No automatic cascade** — each tenant holds a cloned copy.
- **`HarnessPolicy`** (`harness.prisma`) — the **only proper global-default → tenant-override resolver** (`getEffectivePolicy()`). Holds `smrModel/smrProvider`, `safetyModel/safetyProvider`, sensor thresholds, gate SLA/escalation, `maxRegen`, `safetyEnabled/phiEnabled`. WORM `HarnessPolicyChange` + OCC + live `fetch_policy`. **This is the gold-standard layered pattern and already the harness "bindings" table.**
- **`AsrPipeline` + `AsrPipelineVersion`** — admin-managed STT pipeline (YAML referencing models by slug), per-tenant `isDefault`, immutable version history. **Reference pattern for "admin-managed workflow".**
- **`AiModel`** — model **registry** (`name/slug/category/taskType/modelType/source/sourceUri/format/computeType/downloadStatus/localPath/checksum`), tenant-scoped (`@@unique([tenantId, slug])`). **Seeded only under `SYSTEM_TENANT_ID`** → customer tenants have **zero** rows today.
- **`PromptTemplate` / `PromptVersion`** — three scopes (`TENANT_DEFAULT/DEPARTMENT_DEFAULT/USER_PERSONAL`), versioned.
- **`DnaWritingStyleReport` / …Version** — **per-doctor** writing style + version history.

### 2.5 Deep-dive findings (the part that changes the design)

**Pillar A — Audio:**
- **`TenantFrontendConfig` is mostly inert.** The per-tenant audio defaults (`asrModel`, `vad`, `noiseCancel`, `voiceEnrollment`, `diarization`) are **stored but never read by the runtime SDK**; only `captureRawAudio` reaches the pipeline (as `platformCapability AND tenantToggle` via a synthetic `enable-local-raw-capture` row in `GET /tenant/me/config`). `apps/.../audio-pipelines/frontend-pipeline-tab.tsx` is wired to nothing on the runtime side.
- **Local vs backend** is decided in the SDK by `TranscriptionPipeline.resolveSTTRuntimeProvider()` from `stt.provider`/`stt.location`, fed by per-user `UserPreferences.workflowMode`. **The clinical workspace is hard-wired to BACKEND** (`useRealtimeTranscription` requires a `pipelineId`).
- **Diarization** is a real `AsrPipeline` YAML block parsed by `PipelineYamlParser`, **but the admin editor form does not expose it** (YAML tab only). **Voice enrollment is per-doctor** (`UserVoiceProfile`, 256-d pgvector) used by STT-v2 `preseed_speaker`.

**Pillar A — Capture & storage:**
- **Two independent dual-capture mechanisms**: server pipeline YAML (`preprocessing.dual_capture.capture_raw` + `postprocessing.dual_capture.capture_processed` — two booleans that can already express all four modes, but **only per-pipeline**) and the local path (`captureRawAudio` — boolean only).
- **Raw and processed share ONE `AUDIO` bucket** (object-key prefixes differ); there is no raw-vs-processed bucket purpose. `TenantStorageConfig` already supports provider/topology/credentials + per-bucket override + default-bucket mapping (AUDIO/ATTACHMENTS/MISC), all tenant-scoped.

**Pillar B — Harness realtime:**
- **`ConsultationPipelineConfig`** (`autoSummaryEnabled`/`autoNerEnabled`/`harnessEnabled`) is documented to cascade tenant→department→consultation, but **`resolvePipelineConfig()` only reads the consultation's own metadata** then system defaults. `harnessEnabled` is hard-coded `true` in the UI launch panel. The "during-recording" live-documentation engine has only a **global Redis kill-switch** (super-admin).
- **`PromptTemplate` resolution works** (doctor-preferred id → department columns → system default) on the harness path; the legacy BullMQ path doesn't thread the doctor-preferred id.
- **Gating is the gold standard** (`HarnessPolicy`, tenant overrides global default, live-injected).
- **Doctor personal prompt authoring is backend-ready but unrouted** — `PromptManagementService.createPersonal()` + owner-scoped `assertCanMutate()` exist, but **no controller route / UI**; doctors can only *select* a preferred template (via an admin route) and *read* available ones.

**DNA writing style + edit capture:**
- DNA is **per-doctor**, generated by SMR from approved-summary **final text** (not deltas); toggle = tenant feature flag `enable-dna-style`.
- **Edit-delta is NOT captured.** Full-text version snapshots (`ContextItemVersion`) and an attested WORM `SIGNED_NOTE` exist, **but** `contentDiff`/`fieldChanges` are left null, the AI draft is **not** snapshotted at generation, the type isn't flipped to `MODIFIED_SUMMARY`, and the DNA learner ingests only final text. So "capture & store ALL manual changes" is **only partially** met today.

### 2.6 Admin APIs & UI (today)

| Surface | API | UI | Status |
|---|---|---|---|
| STT pipelines + models | `admin/audio/pipelines` | `features/admin/audio-pipelines` | ✅ complete (diarization form missing) |
| Harness policy (models/thresholds/gating) | `admin/harness/policy`, `/global` | `features/admin/harness` | ✅ complete |
| Tenant frontend (audio) config | `admin/tenant-frontend-config` | `features/admin/audio-pipelines/frontend-pipeline-tab` | ⚠️ stored, runtime-inert |
| Storage provider/buckets/keys | `admin/tenants/storage/*` | `features/admin/storage` | ✅ (single AUDIO bucket) |
| Prompts (tenant defaults) | `admin/prompt-templates` | `features/admin/prompts` | ✅ admin only; doctor authoring ❌ |
| DNA reports (dashboard) | (dna endpoints) | `features/admin/dna-reports` | ✅ read; edit-delta capture ❌ |
| **AI Model registry** | **none** ❌ | **none** ❌ | `AiModelService` CRUD exists, unexposed |

---

## 3. Gap Analysis

| # | Gap | Pillar | Severity |
|---|---|---|---|
| G-1 | **No admin AI-Model catalog** (controller + UI); `AiModelService` CRUD unexposed. | registry | High |
| G-2 | **`AiModel` not visible to tenants** (system-tenant only). | registry | High |
| G-3 | **SMR default ≠ requested** (`gemma-4-e4b`; `HarnessPolicy.smrModel` null). | B | High |
| G-4 | **STT default ≠ requested** (safetensor turbo; no CT2-int8 pipeline/`AiModel`). | A | High |
| G-5 | **`AiModelFormat` lacks `CTRANSLATE2`/`FASTER_WHISPER`/`MLX`/`GGUF`**; medgemma mislabeled `SAFETENSOR`. | registry | Med |
| G-6 | **`TenantFrontendConfig` runtime-inert** — tenant audio defaults not consumed by the SDK. | A | High |
| G-7 | **No tenant default + lock for local-vs-backend transcription**; clinical workspace backend-only; choice is per-user only. | A | High |
| G-8 | **Diarization not in the pipeline admin form** (YAML-only). | A | Med |
| G-9 | **No tenant-level "capture mode" enum** (raw+processed/raw/processed/none); only per-pipeline booleans + local boolean. | A | Med |
| G-10 | **Realtime toggles don't cascade** — `autoSummary`/`autoNer`/`harnessEnabled` resolve at consultation scope only; `harnessEnabled` hard-coded in UI. | B | High |
| G-11 | **Doctor personal-prompt authoring unrouted** (`createPersonal` has no controller/UI); preferred-template set on an admin route. | B | High |
| G-12 | **DNA edit-delta not captured** — no AI-draft baseline at generation, `contentDiff`/`fieldChanges` null, learner uses final text only. | B / DNA | High |
| G-13 | **SMR is env-only** at runtime (legacy non-harness path ignores DB selection) and carries an implicit default. | B | Med |
| G-14 | **Guardrail DB-config opt-in** (`GUARDRAIL_DB_CONFIG_ENABLED=false`). | B | Med |
| G-15 | **No per-doctor DNA on/off** (only a tenant feature flag). | DNA | Low |

### What already works in our favor

- ✅ **STT path is already the target architecture** (admin-managed model + per-tenant pipeline). We add a CT2-int8 variant + default switch.
- ✅ **`HarnessPolicy`** already gives global→tenant cascade + WORM + OCC + live injection for `smrModel`/`safetyModel`/gating — it is the harness "bindings" table.
- ✅ **Guardrail default already = `granite-guardian-4.1-8b`** everywhere; req #2.2 is essentially met.
- ✅ **`AiModelService` CRUD exists**; **medgemma is already registered** (`AiModel` slug `lms-medgemma-1.5-4b-mlx`) and in the SMR catalog.
- ✅ **PromptTemplate scopes + resolver**, **storage provider/bucket config**, **per-doctor voice profiles** all exist — building blocks for the cascade.

---

## 4. Proposed Design (decisions applied)

### 4.1 Architecture — 3 planes + 1 resolver + 2 workflow consoles (D-2 = hybrid)

Rather than a new monolithic bindings table (which would duplicate `HarnessPolicy`), **harden the proven domain stores** and unify them behind **one resolution contract**. Separate three concerns that are tangled today:

```
┌──────────────── CATALOG PLANE ────────────────┐   what models/options exist
│  AiModel registry (cross-service: STT/SMR/GR)  │   cloned per tenant (D-5)
└───────────────────────┬────────────────────────┘
                         │ referenced by slug
┌──────────── SELECTION / POLICY PLANE ──────────┐   what is chosen + the rules
│  Workflow A (Audio):  AsrPipeline + TenantAudioConfig (hardened)         │
│  Workflow B (Harness): HarnessPolicy + PipelineConfig(cascade) + Prompts │
│  resolved by ONE cascade: platform → tenant → department → doctor        │
│  each setting declares its MAX scope (safety/gating stop at tenant)      │
└───────────────────────┬────────────────────────┘
                         │ resolves slug → artifact
┌──────────────── ARTIFACT PLANE ────────────────┐   the model files
│  model repo/registry (self-convert, D-4)        │   AiModel.sourceUri/localPath/checksum
│  SMR = stateless gateway, NO default (D-7)      │   services pull by slug
└─────────────────────────────────────────────────┘
```

**Resolution contract** (generalize `HarnessPolicyService.getEffectivePolicy()` + `PromptResolutionService`): a `ConfigResolver` returns the effective value for `(setting, tenant, department?, doctor?)` with a **resolution trace** for audit, falling through `doctor → department → tenant → platform/code-default`. Each setting registers a **max scope** so safety/gating cannot be overridden below tenant level (cascade decision = `safety_tenant`).

### 4.2 Config scope map (the contract)

| Setting | Plane | Max scope | Store (hardened) | Work |
|---|---|---|---|---|
| Model catalog | Catalog | platform-curated → cloned/tenant | `AiModel` | expose API/UI; clone-on-create |
| ASR pipeline (backend) | Selection | tenant default | `AsrPipeline` | add CT2 pipeline; expose diarization in form |
| Local vs backend mode + **lock** | Selection | tenant default → doctor (if unlocked) | `TenantAudioConfig` + `UserPreferences.workflowMode` | wire runtime + clinical workspace |
| VAD / noise / diarization | Selection | tenant | `AsrPipeline` YAML + `TenantAudioConfig` | wire `TenantAudioConfig` (kill inert state) |
| Voice enrollment | Selection | per-doctor | `UserVoiceProfile` | already works |
| Capture mode + buckets | Selection | tenant | `CaptureMode` enum → YAML booleans + storage | new enum + translation layer |
| Summarization model | Selection | tenant (+global) | `HarnessPolicy.smrModel` | set medgemma default; passed to SMR gateway |
| Safety/guardrail model | Selection | **tenant (+global) only** | `HarnessPolicy.safetyModel` | already granite; catalog it |
| Prompt template | Selection | tenant → dept → doctor | `PromptTemplate`/`Department`/`UserProfile` | route doctor authoring |
| Realtime summarization on/off | Policy | tenant → dept → doctor | `PipelineConfig` cascade | implement cascade |
| Realtime NER on/off | Policy | tenant → dept → doctor | `PipelineConfig` cascade | implement cascade |
| Gating / thresholds / regen | Policy | **tenant (+global) only** | `HarnessPolicy` | already works |
| DNA on/off | Policy | tenant + doctor | `enable-dna-style` + per-doctor | add doctor toggle |
| DNA style from edits | Data capture | per-doctor | `ContextItemVersion` + delta | **new edit-capture pipeline** |
| Doctor personal prompt | Selection | doctor (self-service) | `createPersonal()` | route + UI |

### 4.3 Catalog plane — the model registry (G-1/G-2/G-5, D-4, D-5)

- **Expose `AiModelService`** via `admin/ai-models` (controllers mirror `AudioPipelineController`: `@CanAny(['manage','AiModel'],['update','AiModel'])`, `@RequiresIfMatch()`, `broadcastSysEvent`). New CASL subject `AiModel` in seed policies. New `features/admin/ai-models` UI (`AdminDataTable` + RHF/zod dialogs). SUPER manages the global catalog; TENANT manages the tenant clone.
- **Clone-per-tenant (D-5):** extend `tenant.service.create()` (which already clones `GlobalSetting`) to **clone the SYSTEM `AiModel` catalog** into the new tenant. Add a backfill for existing tenants.
- **Enum extension (additive migration):** `AiModelFormat += CTRANSLATE2, FASTER_WHISPER, MLX, GGUF`; optionally `ModelTaskType += GUARDRAIL`. Fix medgemma `format → MLX`.
- **Artifact resolution (D-4):** `AiModel.sourceUri` (HF or model-repo URI) + `localPath` + `checksum` + `downloadStatus` are the pull contract. **Self-convert is owned by engineers/devs**, who publish converted artifacts (e.g., CT2 int8 turbo) to the model repo and register the `AiModel` row; services resolve slug → artifact and load.

### 4.4 Artifact plane — SMR as a stateless gateway (D-7, G-13)

- **SMR has no default model.** Refactor SMR so summarization is a pure text-generation gateway: provider + model are **always supplied per request** by the caller. Keep provider *connection* config + secrets in env/Vault (TASK-302/338 posture); remove model-selection defaulting from the selection path.
- **The API layer resolves the effective summarization model** from the cascade (`HarnessPolicy.smrModel` → system default) and passes it on **every** SMR call — both the harness path (already does this) and any retained legacy path and the DNA processor. No "SMR default" is relied upon anywhere.

### 4.5 Workflow A — Audio pipeline console (D-6 part 1, decisions: tenant default + lock; capture mode)

Re-home the **inert `TenantFrontendConfig`** into a real, runtime-consumed **`TenantAudioConfig`** (rename optional; minimally: make the columns actually drive the SDK + clinical workspace):

- **Transcription mode + lock (G-7):** add `transcriptionMode (LOCAL|BACKEND)` + `transcriptionModeLocked`. The SDK/clinical workspace reads the effective mode = tenant default, overridable by `UserPreferences.workflowMode` **only when unlocked**. Wire the clinical workspace (currently backend-only) to honor `LOCAL`.
- **Feature toggles (G-6/G-8):** make `diarization`/`vad`/`noiseCancel`/`voiceEnrollment` actually drive the resolved pipeline; **expose the diarization block in the backend pipeline editor form** (it's already parsed/validated).
- **Capture mode (G-9):** add `CaptureMode { RAW_AND_PROCESSED | RAW_ONLY | PROCESSED_ONLY | NONE }` at tenant scope; a translation layer maps it onto the two pipeline-YAML `dual_capture` booleans (backend) and the local capture flag (frontend).
- **Buckets:** reuse `TenantStorageConfig` (provider/topology/credentials + default AUDIO bucket). **Default: keep a single `AUDIO` bucket** (raw/processed by key prefix). *Optional later:* split `TenantBucketPurpose` into `AUDIO_RAW`/`AUDIO_PROCESSED` if a hard storage separation is required — not in the initial scope.

### 4.6 Workflow B — Realtime harness console (D-6 part 2, cascade = safety_tenant)

- **Models:** `HarnessPolicy.smrModel` (summarization, medgemma default) + `HarnessPolicy.safetyModel` (guardrail, granite default). Dropdowns sourced from the catalog (`/admin/ai-models/by-task/SUMMARIZATION` and `GUARDRAIL`).
- **Prompts (tenant → dept → doctor):** keep `PromptTemplate` + `PromptResolutionService`; ensure the legacy path also threads the doctor-preferred id.
- **Realtime toggles (G-10):** implement the documented cascade for `autoSummaryEnabled` / `autoNerEnabled` at **tenant → department → doctor**, backed by a small `PipelinePolicy` row per tenant (mirroring `HarnessPolicy`) + department/doctor overrides, resolved via the `ConfigResolver`. Replace the hard-coded `harnessEnabled` with a resolved value.
- **Gating / thresholds / safety (tenant + global only):** unchanged — stays in `HarnessPolicy`. No department/doctor override (doctors cannot weaken safety/gating).

### 4.7 Doctor self-service + DNA edit-capture (G-11/G-12/G-15, DNA = full_capture)

- **Personal prompt templates:** route the existing `createPersonal` + personal update + `listMyPersonalForCaller` to a **doctor-facing controller** (`read/create/update` on owned `USER_PERSONAL` rows) + a doctor UI; add a **self-service preferred-template** route (today it lives on the admin user controller).
- **Per-doctor DNA on/off:** add a per-doctor toggle (under the tenant feature flag).
- **Edit-capture pipeline (the prerequisite for "DNA from edits"):**
  1. **Snapshot the AI draft as `v1` `ContextItemVersion`** at generation — both legacy `SummaryService.generateSummary` and harness `persistDraft`.
  2. **Compute & store the delta** (`contentDiff` + structured `fieldChanges`) on each `updateSummary` edit and at sign-off; **mark edited notes** (flip to `MODIFIED_SUMMARY` or add an `edited` flag).
  3. **Feed draft↔approved pairs into DNA generation** — extend `DnaWritingStyleProcessor` to ingest the deltas (what the doctor changed), not just the final text.

### 4.8 The three default models — exact wiring

**(a) SMR → `mlx-community/medgemma-1.5-4b-it`** — `AiModel` already present; fix `format → MLX`; clone to tenants. Set `HarnessPolicy` **system-default** `smrProvider='lm-studio'`, `smrModel='mlx-community/medgemma-1.5-4b-it'`; the API resolves this and passes it to the SMR gateway on every call (D-7). Update `GlobalSetting smr/default-smr-model` + seed for UI consistency.

**(b) Guardrails → `granite-guardian-4.1-8b`** — already the default in `HarnessPolicy.safetyModel` (the wired source of truth) + guardrail env + `GlobalSetting`. **Register it in the catalog** (`taskType=GUARDRAIL`, `format=GGUF`/`SAFETENSOR`). Optionally flip `GUARDRAIL_DB_CONFIG_ENABLED=true`; the harness already passes `safetyModel` to the guardrail call, so no value change is required.

**(c) STT → faster-whisper, whisper-large-v3-turbo CT2 int8** — **engineers self-convert** (`ct2-transformers-converter --model openai/whisper-large-v3-turbo --quantization int8 --output_dir <repo path>`) and publish to the model repo; register `AiModel` slug `faster-whisper-large-v3-turbo-int8` (`taskType=AUTOMATIC_SPEECH_RECOGNITION`, `modelType=QUANTIZED_MODEL`, `format=CTRANSLATE2`, `computeType='int8'`, `sourceUri=<repo>`). Create a new `AsrPipeline` (slug `production-faster-whisper-turbo-int8`):

```yaml
models:
  asr: { hf_model_id: "<repo>/faster-whisper-large-v3-turbo-ct2", engine: "faster_whisper", compute_type: "int8" }
  vad: { hf_model_id: "snakers4/silero-vad", engine: "onnx", version: "v6.0" }
inference: { device: auto, compute_type: int8, language: null }
diarization: { enabled: true, max_speakers: 2 }
```

Set it as the tenant default (`isDefault` + `default-stt-pipeline`/`batch_pipeline_slug`/`streaming_pipeline_slug`); update the seed. `FasterWhisperLoader` already supports `compute_type=int8` + local/HF paths.

### 4.9 Authorization model

| Capability | SUPER/GLOBAL | TENANT_ADMIN | DOCTOR |
|---|---|---|---|
| Global model catalog / global defaults | ✅ | ❌ (read) | ❌ |
| Tenant catalog clone + model selections | ✅ (any tenant) | ✅ (own) | ❌ |
| Audio workflow (mode/lock/capture/pipeline/diarization) | ✅ | ✅ (own) | mode override if unlocked |
| Harness models / gating / safety / thresholds | ✅ | ✅ (own; safety/gating not below tenant) | ❌ |
| Realtime summary/NER toggles | ✅ | ✅ (tenant/dept) | ✅ (own) |
| Prompt templates | ✅ (tenant defaults) | ✅ (tenant/dept) | ✅ (personal) |
| DNA on/off | ✅ (tenant flag) | ✅ (tenant) | ✅ (own) |

---

## 5. Implementation Plan (phased; TDD per layer `DB → Domain → Applications → API → UI`)

- **Phase 1 — Catalog plane (fast win):** additive `AiModelFormat` enum migration; CASL `AiModel`; `admin/ai-models` controller over existing `AiModelService`; clone-per-tenant on create + backfill (D-5); `features/admin/ai-models` UI; register granite-guardian + fix medgemma `format`.
- **Phase 2 — Defaults wiring:** engineers self-convert CT2 int8 turbo → model repo; register `AiModel` + new `AsrPipeline`; set system-default `HarnessPolicy` (`smrModel=medgemma`, confirm `safetyModel=granite`); update `GlobalSetting`/seeds/clone; switch default STT pipeline.
- **Phase 3 — SMR gateway refactor (D-7):** remove SMR model defaulting; resolve effective model in the API and pass on every SMR call (harness + legacy + DNA); tests for "no default / caller-supplied model".
- **Phase 4 — Audio workflow console (Pillar A):** make `TenantAudioConfig` runtime-consumed; transcription mode + lock + clinical-workspace wiring; expose diarization in the form; `CaptureMode` enum + YAML/local translation.
- **Phase 5 — Realtime cascade (Pillar B):** `ConfigResolver` generalization; `PipelinePolicy` (tenant) + dept/doctor overrides for summary/NER; replace hard-coded `harnessEnabled`; legacy-path doctor-preferred prompt threading.
- **Phase 6 — Doctor self-service + DNA edit-capture:** doctor prompt routes + UI; per-doctor DNA toggle; AI-draft `v1` snapshot at generation; delta capture on edit/sign; DNA processor ingests draft↔approved pairs.

---

## 6. Risks

- **R-1 Model availability:** targets must be loaded (LM Studio) / present on disk (CT2 conversion). Mitigate via catalog `downloadStatus` + conservative fallback.
- **R-2 Replay safety:** do not alter the deterministic harness workflow body; "workflow config" stays in policy rows snapshotted at start.
- **R-3 Cascade safety:** enforce max-scope so doctors/departments cannot weaken safety/gating.
- **R-4 Secrets:** provider credentials stay in env/Vault; only non-secret model refs/deployment names are DB-driven.
- **R-5 Edit-capture cost:** snapshotting AI drafts + diffs adds writes on the clinical path; keep diffs compact and writes best-effort/non-blocking where safe.
- **R-6 Inert-surface migration:** wiring `TenantFrontendConfig` into runtime changes behavior for tenants that set values expecting no effect; migrate carefully + document.

---

## 7. Decisions (resolved)

| # | Decision | Resolution |
|---|---|---|
| **D-1** | Ticket placement | New **TASK-356** (this doc). |
| **D-2** | Model/workflow config architecture | **Hybrid** — harden existing stores (`AsrPipeline` + `HarnessPolicy` + `PromptTemplate`) + cross-service **model registry** + **two workflow consoles**; **no** unified `ServiceModelBinding` table. |
| **D-4** | CT2 turbo source | **Self-convert**, owned by engineers/devs; published to a **model repo/registry**; services pull by slug. |
| **D-5** | Tenant catalog visibility | **Clone-per-tenant** on tenant creation (+ backfill). |
| **D-6** | "Workflows" scope | **Two pillars**: (A) audio-processing pipeline (realtime/batch transcription) and (B) realtime harness (summarization, NER, gating). No step-level reordering of the deterministic harness body. |
| **D-7** | SMR default | **No SMR default** — SMR is a stateless gateway; the API passes the cascade-resolved model on every call. Refactor SMR accordingly. |
| **D-8** (new) | Transcription local/backend control | **Tenant default + lock**; doctor overrides only when unlocked; clinical workspace honors the resolved mode. |
| **D-9** (new) | Cascade depth | **tenant → dept → doctor** for prompts + realtime summary/NER; **tenant (+global) only** for gating + safety/guardrail. |
| **D-10** (new) | DNA from edits | **Full edit-capture**: snapshot AI draft, store draft↔approved delta, feed pairs into DNA. |

**Residual sub-decision (non-blocking, defaulted):** keep a single tenant `AUDIO` bucket (raw/processed by key prefix); add `AUDIO_RAW`/`AUDIO_PROCESSED` purposes only if hard storage separation is later required.

---

## 8. Implementation Summary — Phase 1 (Catalog plane) + Phase 4 (Audio console)

> **Implemented & integration-verified 2026-06-14.** The two phases were planned separately, share a **single additive DB migration**, were implemented **in parallel**, and then **verified together** in one integrated working tree. Phases 2, 3, 5, 6 are **not** implemented. Cloud-provider model **activation** (Phase 2/3 default wiring + SMR gateway) remains **gated on TASK-357** (PHI egress guard).
>
> Plan-gate artifacts: [`phase-1-catalog-plane-plan.md`](./phase-1-catalog-plane-plan.md) · [`phase-4-audio-console-plan.md`](./phase-4-audio-console-plan.md)

### 8.1 What shipped

- **Phase 1 — Catalog plane (admin-managed AI-model registry).** Exposes the pre-existing `AiModelService` CRUD through a new `admin/ai-models` surface with optimistic concurrency (`If-Match`), clones the SYSTEM catalog into every tenant (on-create + idempotent backfill), and corrects/extends the catalog seed. Closes G-1/G-2/G-5.
- **Phase 4 — Audio workflow console (Pillar A).** Re-homes the previously runtime-inert `TenantFrontendConfig` so it drives the runtime: tenant **transcription mode + lock** (resolved server-side), a tenant **`CaptureMode`** enum with a pure translation layer, and **diarization exposed in the backend pipeline editor form**. The clinical workspace now branches on a resolved `LOCAL`/`BACKEND` mode. Closes G-6/G-7/G-8/G-9.

### 8.2 Per-layer changes & key files

| Layer | Phase 1 — Catalog plane | Phase 4 — Audio console |
|---|---|---|
| **DB / migration** | `AiModelFormat += CTRANSLATE2, FASTER_WHISPER, MLX, GGUF`; `ModelTaskType += GUARDRAIL` (`enums.prisma`) | `enum TranscriptionMode {LOCAL,BACKEND}`, `enum CaptureMode {RAW_AND_PROCESSED,RAW_ONLY,PROCESSED_ONLY,NONE}` (`enums.prisma`); `TenantFrontendConfig += transcriptionMode (default BACKEND), transcriptionModeLocked (default false), captureMode (nullable)` (`tenant.prisma`) |
| **Domain (generated)** | `enums/generated/AiModelFormat.ts`, `ModelTaskType.ts` (+ `index.ts`) | `enums/generated/TranscriptionMode.ts`, `CaptureMode.ts` (+ `index.ts`); `TenantFrontendConfig{Entity,Factory,Model}.ts` |
| **Applications** | `stt/model/aiModel.service.ts` (adds OCC via `updateWithVersion` + **exact-`tenantId`** list filter), `dto/update-model.request.ts` (`expectedVersion`), `dto/model.response.ts` (`version`), `aiModel.dto.mapper.ts`, `IAiModelService.ts`; `tenant/tenant.service.ts` (`provisionTenantModelCatalog` clone-per-tenant, D-5) | `tenant-frontend-config/` (`dto/upsert-…request.ts`, `dto/…response.ts`, `…dto.mapper.ts`, `…service.ts`, **`capture-mode.translation.ts`**, `index.ts`); `user/userPreferences/userPreferences.service.ts` (**`resolveEffectiveTranscriptionMode`** server-side cascade) + `dto/user-preferences.response.ts` |
| **API** | `modules/ai-model/ai-model-admin.controller.ts` (`admin/ai-models`, class-level `@Authorize(['manage','AiModel'])`, `@RequiresIfMatch()` OCC), `ai-model.module.ts`, `app.module.ts` (register) | `modules/tenant-frontend-config/tenant-frontend-config-admin.controller.ts` (carries the 3 new fields), `modules/tenant/my-tenant.controller.ts` (raw-capture row derived from `captureMode`) |
| **UI (ui-playground)** | `features/admin/ai-models/index.tsx`, `features/admin/api/ai-models.ts` (+ `api/index.ts` re-export), `routes/_authenticated/admin/ai-models.tsx`, `components/layout/admin-nav-items.tsx` + `features/admin/hooks/use-admin-preferences.ts` (nav entry) | `features/admin/audio-pipelines/frontend-pipeline-tab.tsx` (mode + lock + capture selects), `pipeline-config-editor.tsx` (diarization form section), `features/clinical-workspace/components/capture-panel.tsx` (LOCAL/BACKEND branch) |
| **SDK (`@arcaai/vox`)** | — | `core/ConfigSchema.ts` (`stt.transcriptionMode`, **admin-owned** permission), `providers/AgenticProvider.tsx` (injects resolved mode), `types/{config,frontend-pipeline-config,pipeline,index}.ts` |
| **Seed** | `seed/06-stt.ts` (medgemma `format → MLX`; register **granite-guardian-4.1-8b** `taskType=GUARDRAIL`, `format=GGUF`; `backfillCustomerTenantAiModels`), `seed/01-policy.ts` (`tenant-full-access` grant `manage AiModel`) | (no Phase-4 seed change) |

**Single shared migration (additive):** `packages/database/src/prisma/db_main/migrations/20260614120000_task_356_catalog_audio_foundation/migration.sql` — contains only `CREATE TYPE`, `ALTER TYPE … ADD VALUE IF NOT EXISTS`, and `ALTER TABLE … ADD COLUMN`. **No `DROP` / `RENAME` / `DELETE` / column removal.**

### 8.3 Decisions applied

- **`ModelTaskType.GUARDRAIL` added** (Q-1 rec) — granite is typed precisely rather than reusing `TEXT_GENERATION`.
- **granite-guardian-4.1-8b `format = GGUF`** (Q-2 rec) — `format` is descriptive metadata (llama.cpp/GGUF); serving stays provider-based.
- **medgemma `lms-medgemma-1.5-4b-mlx` `format` corrected `SAFETENSOR → MLX`** (G-5).
- **Exact-`tenantId` catalog visibility** (Q-3 rec) — the tenant admin grid lists only the tenant's own rows (the clones); the SYSTEM master is not merged in via shared-read.
- **Kept the `TenantFrontendConfig` model name** (no rename) — additive columns only (Phase 4 §3).
- **Server-side effective transcription-mode resolver** in `UserPreferencesService` with the **lock authoritative server-side**; the SDK only surfaces it as the admin-owned `stt.transcriptionMode` so the user cascade cannot flip it (D-8 / Phase 4 §6).
- **Clone-per-tenant on creation + idempotent existing-tenant backfill** (D-5).
- **`captureMode` nullable** for back-compat (R-6): `null` = inherit today's per-surface capture behavior until an admin opts in.

### 8.4 Integration verification evidence (Step 1, captured 2026-06-14)

Per-package / filtered commands were used deliberately (not `turbo`) to isolate the pre-existing TASK-352 `@arcaai/database` typecheck error (see §8.5).

| Package | Command(s) | Result |
|---|---|---|
| `@arcaai/domains` | `build` (tsc) + `test` | build clean; **1186 passed / 2 skipped / 9 todo** (90 files) |
| `@arcaai/applications` | `tsc --noEmit -p tsconfig.json` + `test:unit` | typecheck clean; **5119 passed / 4 skipped** (217 files) — **key cross-lane integration point** |
| `apps/api` | vitest `ai-model-admin` + `tenant-frontend-config-admin` + `my-tenant` | **37 passed** (3 files) |
| `apps/ui-playground` | vitest `ai-models` + `audio-pipelines` + `admin-nav-items` + `capture-panel` | **56 passed** (9 files) |
| `@arcaai/vox` | `build` (tsup) + `test` | build clean; **3369 passed** (180 files) |
| `@arcaai/database` | `prisma migrate diff` (live dev DB → schema, read-only) + filtered seed vitest | **"No difference detected" (exit 0 — in-sync)**; migration additive; **295 seed tests passed** |
| (all changed source) | `ReadLints` | **no linter errors** |

**No integration fix was required** — the combined tree is green. Both lanes appended to shared barrels (`domains/src/enums/generated/index.ts`, `applications/.../tenant-frontend-config/index.ts`, `ui-playground/.../admin/api/index.ts`) and shared registrations (`app.module.ts`) without conflict.

### 8.5 Out-of-scope observations (NOT TASK-356; left untouched)

- **TASK-352** — `@arcaai/database` `tsc` `TS2493` in `seed/__tests__/api-key-pepper.test.ts:143` (`Tuple type '[]' … has no element at index '0'`). Pre-existing; this is exactly why per-package/filtered commands (not `turbo`) were used for verification. Not fixed.
- **TASK-351** — `@arcaai/vox` `tsc --noEmit` `TS2352` cast in `core/__tests__/SttV2WebSocketClient.test.ts:334` (`Int16Array`/`SharedArrayBuffer` lib typing). Pre-existing (file unmodified since Jun 11), test-only, and **not** surfaced by the SDK's actual gates (`build` = tsup, `test` = vitest, both green). Not fixed.

---

## 9. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-14 | Initial review/audit + design addendum created (no code changes). | `docs/implementation/TASK-356-Admin-Managed-Models-Workflows/README.md` |
| 2026-06-14 | Deep-dive across audio pipeline, capture/storage, prompts/realtime, DNA edit-capture; finalized architecture (3 planes + 1 resolver + 2 workflow consoles); resolved D-1/D-2/D-4/D-5/D-6/D-7 + added D-8/D-9/D-10; re-phased plan. | same |
| 2026-06-14 | **Planned → foundation → parallel implementation → integration verify.** Authored the Phase 1 (`phase-1-catalog-plane-plan.md`) and Phase 4 (`phase-4-audio-console-plan.md`) TDD plan-gate docs; landed a single additive shared DB foundation migration (`20260614120000_task_356_catalog_audio_foundation`); implemented Phase 1 (Catalog plane) and Phase 4 (Audio console) **in parallel**; then ran a combined integration verification (domains/applications/api/ui/SDK/database — all green, no fix needed, migration in-sync & additive) and recorded the **§8 Implementation Summary**. Status → Phase 1 + 4 implemented & verified; Phases 2/3/5/6 outstanding (Phase 2/3 activation gated on TASK-357). | `…/README.md`, `phase-1-catalog-plane-plan.md`, `phase-4-audio-console-plan.md` (+ DB/domain/applications/api/ui/SDK source per §8.2) |
