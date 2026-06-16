# TASK-356 — Admin-Managed Models & Workflows (Review / Audit + Design Addendum)

| | |
|---|---|
| **Ticket** | TASK-356 |
| **Title** | Admin-managed AI models & workflows + per-tenant default models |
| **Created** | 2026-06-14 |
| **Updated** | 2026-06-15 |
| **Status** | **Phases 1–6 implemented** — Phase 1 (Catalog plane) + Phase 4 (Audio console) **implemented & integration-verified** (2026-06-14); Phase 2 (Defaults wiring) **implemented & verified** (2026-06-14); Phase 3 (SMR gateway refactor / D-7) **implemented & verified** (2026-06-15); Phase 5 (Realtime cascade / Pillar B) **implemented & verified** (2026-06-15); **Phase 6 (doctor self-service prompt CRUD/UI + per-doctor DNA toggle + DNA edit-capture) implemented & verified** (2026-06-15) — all via strict TDD. Cloud-provider model **activation** is **no longer blocked**: the **TASK-357** PHI-egress-guard gate is now **satisfied (TASK-357 Completed)**. The seeded defaults remain **local-only**, so no cloud provider is active by default. |
| **Commit status** | Phases 1–6 are **committed** on branch `fix/2605-review` across `f154ce04` + `f58788d2` (on top of TASK-355 base `04cb3b8b`) — this doc is a record of committed work, not pending/uncommitted changes. |
| **Open follow-ups** | **Phase 4 Hotfix H-1** (Vox SDK barrel export gap — §8F); **TASK-361** (STT default placeholder artifact); **TASK-362** (preferred-prompt threading completeness) — **Completed 2026-06-16**; all generation paths now thread the doctor-preferred id. |
| **Type** | feature (admin platform + configuration) |
| **Builds on** | TASK-233 (Administration Section), TASK-302 (System Config / Vault), TASK-328/331/336 (AsrPipeline admin + GLOBAL_ADMIN + shared-read), TASK-338 (admin-configurable SMR/Guardrail engine), TASK-330/355 (HarnessPolicy + optimistic delivery), TASK-294 (prompt-template scopes), TASK-299 (DNA writing style), TASK-332 (local raw capture) |

> Review/audit + design addendum — **now also the implementation record for Phases 1 & 4.** It documents the current state across architecture → data model → API → UI, performs a gap analysis against the requested capability, and proposes an implementation design. The **Decisions** in §7 were taken collaboratively and are **resolved**. Phase 1 (Catalog plane) and Phase 4 (Audio console) were **implemented in parallel and integration-verified together** (see **§8 Implementation Summary**). **All of Phases 1–6 have since been implemented, verified, and committed** (branch `fix/2605-review`, commits `f154ce04` + `f58788d2`); see the per-phase summaries §8B–§8E, the open follow-ups (§8F / TASK-361 / TASK-362), and the §9 Change History. Plan-gate artifacts: [`phase-1-catalog-plane-plan.md`](./phase-1-catalog-plane-plan.md) · [`phase-4-audio-console-plan.md`](./phase-4-audio-console-plan.md).

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
- **`ConsultationPipelineConfig`** (`autoSummaryEnabled`/`autoNerEnabled`/`harnessEnabled`) is documented to cascade tenant→department→consultation, but **`resolvePipelineConfig()` only reads the consultation's own metadata** then system defaults. `harnessEnabled` is hard-coded `true` in the UI launch panel. The "during-recording" live-documentation engine has only a **global Redis kill-switch** (super-admin). **→ Resolved in Phase 5 (§8D):** `resolvePipelineConfig()` now resolves the toggles through the realtime **`PipelinePolicy`** cascade (doctor→department→tenant→SYSTEM-default→code-default; `harnessEnabled` capped at tenant+dept) via `ConfigResolver`, with the per-consultation `metadata.pipelineConfig` retained as the **top overlay** for back-compat; the UI hard-coded `harnessEnabled` is removed (the demo is preserved by a seeded demo-tenant policy row).
- **`PromptTemplate` resolution works** (doctor-preferred id → department columns → system default). **At audit time only the harness path threaded the doctor-preferred id; the legacy BullMQ path did not.** **→ Phase 5 (§8D) threaded `UserProfile.preferredPromptTemplateId` (read-only) on the primary generation paths** — the sync REST path (already threaded since TASK-329), the BullMQ **`summary.processor`**, and the harness assemble path, resolved via `ConfigResolver.resolvePreferredPromptTemplateId`. **Scope correction (2026-06-15 audit):** at Phase-5 ship time this was **not** literally *every* path — the **`pre-summary`** and **`comprehensive-summary`** processors resolved via department/system default only. **→ Closed by TASK-362 (Completed 2026-06-16):** the `pre-summary`, `comprehensive-summary`, and sync `chain-summary` paths now all thread the requesting doctor's preferred id (keyed off the requesting `consultation.doctorId`), so the claim now holds for **every** generation path.
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

> **Implemented & integration-verified 2026-06-14.** The two phases were planned separately, share a **single additive DB migration**, were implemented **in parallel**, and then **verified together** in one integrated working tree. _(Historical note: Phases 2, 3, 5, 6 were outstanding at the time of this summary; they have since all been implemented & verified — see §8B–§8E.)_ Cloud-provider model **activation** (Phase 2/3 default wiring + SMR gateway) was gated on **TASK-357** (PHI egress guard); that gate is now **satisfied (TASK-357 Completed)**, and the seeded defaults remain **local-only** so no cloud provider is active by default.
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

## 8B. Implementation Summary — Phase 2 (Defaults wiring)

> **Implemented & verified 2026-06-14**, via strict TDD (RED → GREEN → REFACTOR) on top of the Phase 1 + Phase 4 working tree. **Rows/config only — no schema change** (the `HarnessPolicyChange` table and the audio/catalog enums already exist from the Phase 1 foundation migration). The cloud-provider **activation** gate (**TASK-357** PHI egress guard) is now **satisfied (TASK-357 Completed)**; this phase only sets **local** defaults and does **not** enable any cloud provider, touch gating/thresholds/safety logic (TASK-358/359), or refactor SMR / its call sites (Phase 3 / D-7).
>
> Plan-gate artifact: [`phase-2-defaults-wiring-plan.md`](./phase-2-defaults-wiring-plan.md)

### 8B.1 What shipped

- **(a) SMR default → medgemma on LM Studio.** A new idempotent `seedHarnessPolicy` step sets the **SYSTEM** `HarnessPolicy` `smrProvider='lm-studio'` + `smrModel='mlx-community/medgemma-1.5-4b-it'` (writes **only** those two columns; all other policy knobs untouched). Per the **seed_worm** decision it **also records a WORM `HarnessPolicyChange` audit row** for the default-set (system/seed actor `SYSTEM_USER_ID`, `beforeJson=null` on first create / before+after snapshots on update), reusing the existing change-record mechanism. The `default-smr-model` GlobalSetting is updated to the same medgemma slug.
- **(b) Guardrail — regression guards only.** `granite-guardian-4.1-8b` is already the default (schema/env/GlobalSetting/catalog from Phase 1); Phase 2 adds **regression-guard tests** only and **leaves `GUARDRAIL_DB_CONFIG_ENABLED=false`** (no flip).
- **(c) STT → faster-whisper CT2 int8 as the new default.** Registers a new `AiModel` `faster-whisper-large-v3-turbo-int8` (`taskType=AUTOMATIC_SPEECH_RECOGNITION`, `modelType=QUANTIZED_MODEL`, `format=CTRANSLATE2`, `computeType='int8'`) with a **clearly-marked placeholder `sourceUri` = `MODEL_REPO_PLACEHOLDER/faster-whisper-large-v3-turbo-ct2`** + a TODO that engineers publish the real artifact (D-4) — it intentionally **won't resolve at runtime yet**. Adds a new `AsrPipeline` `production-faster-whisper-turbo-int8` (faster-whisper/int8 YAML from §4.8(c), **diarization + dual_capture carried over**). **Switches BOTH batch + streaming defaults**: flips `isDefault` (demotes the old `production-whisper-large-v3` across the SYSTEM, Global-tenant, and customer-tenant pipeline groups), repoints `batch_pipeline_slug` + `streaming_pipeline_slug`, and updates the `default-stt-pipeline` GlobalSetting. A new **`switchDefaultSttPipeline` backfill** reconciles existing DBs (since `seedAsrPipelines` won't clobber `isDefault` on update) so there is never a double-default — and it **respects an admin-chosen default** (only demotes the freshly-seeded CT2 when an operator already picked something else).
- **(d) Clone-per-tenant — extend_clone override.** `tenant.service.ts` `create()` now **also clones the SYSTEM default `AsrPipeline` (+ its current `AsrPipelineVersion`)** into each new tenant, tenant-scoped default via `setDefaultForTenant` (preserving the one-default-per-tenant invariant), **idempotently** (skips when the tenant already owns the slug) in its own try/catch alongside the existing AiModel clone — so it doubles as the existing-tenant backfill. (Chosen instead of the plan's GlobalSetting-fallback recommendation.)

### 8B.2 Per-file changes & key files

| Area | New / Modified | File(s) |
|---|---|---|
| **SMR default + WORM** | **New** | `packages/database/src/prisma/db_main/seed/13-harness-policy.ts` — `seedHarnessPolicy` (SYSTEM `HarnessPolicy` SMR columns + WORM `HarnessPolicyChange`, idempotent, non-clobbering) |
| **Seed registration** | Modified | `seed/index.ts` (calls `seedHarnessPolicy` after `seedStt` in Phase 2 platform config) |
| **SMR GlobalSetting** | Modified | `seed/11-global-setting.ts` (`default-smr-model` value+default → `mlx-community/medgemma-1.5-4b-it`) |
| **STT model + pipeline + both defaults + backfill** | Modified | `seed/06-stt.ts` (`CTRANSLATE2` enum mirror; CT2 `AiModel` w/ placeholder `sourceUri`+TODO; `faster_whisper_turbo_int8` YAML; `DEFAULT/GLOBAL/CUSTOMER` pipeline groups demote old + add CT2 `isDefault`; `DEFAULT_STT_SETTINGS` batch+streaming slugs; **`switchDefaultSttPipeline`** + constants, wired into `seedStt`) |
| **STT GlobalSetting** | Modified | `seed/91-user.ts` (`default-stt-pipeline` value+default → Global-tenant CT2 pipeline id) |
| **AsrPipeline clone-per-tenant** | Modified | `packages/applications/src/services/tenant/tenant.service.ts` (`provisionTenantPipelineCatalog` + `create()` step + appended `AsrPipelineVersionRepository` ctor param, append-only) |
| **Tests (TDD)** | Modified | `packages/database/src/__tests__/seed.test.ts` (Phase-2 seed-data + `seedHarnessPolicy`/WORM + `switchDefaultSttPipeline` blocks; **OLD-default guards at the pinned lines updated to the CT2 default**); `tenant/__tests__/tenant.service.test.ts` (pipeline-clone suite) + ctor-append in `_harness.ts`, `tenant.service.{locked-runtime,mass-assignment,audit-scrub,audit-scrub-encrypted}.test.ts` |

**No migration.** No `.prisma` file or `migrations/` directory was touched (git-verified); the read-only `prisma migrate diff` reports the datamodel **in-sync** (§8B.3).

### 8B.3 Verification evidence (captured 2026-06-14)

Filtered / direct commands (not `turbo`) to avoid the pre-existing TASK-352 `@arcaai/database` `tsc` `TS2493` error (§8.5) — seed tests run via `vitest` (esbuild, not `tsc`), so the blocker does not apply.

| Package | Command | Result |
|---|---|---|
| `@arcaai/database` | `vitest run src/__tests__/seed.test.ts` | **315 passed** (1 file) |
| `@arcaai/database` | `prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --exit-code` (read-only) | **"No difference detected" (exit 0 — in-sync)** |
| `@arcaai/applications` | `build` (rimraf + tsc) + `typecheck` (tsc --noEmit) | **clean** |
| `@arcaai/applications` | `test:unit` (full) | **5125 passed / 4 skipped** (218 files) |
| `@arcaai/applications` | `vitest tenant.service.test.ts` | **99 passed** (incl. 6 new pipeline-clone tests) |
| `@arcaai/applications` | `vitest` 4 sibling tenant suites (ctor append-only check) | **10 passed** (4 files) |
| (all changed source) | `ReadLints` | **no linter errors** |

`apps/api` and `@arcaai/domains` were **not** touched in Phase 2, so their gates were not re-run.

### 8B.4 Decisions applied

- **seed_worm (override):** the SMR default-set writes a WORM `HarnessPolicyChange` audit row (not just the two columns).
- **extend_clone (override):** the default `AsrPipeline` (+ current version) is cloned per-tenant in `tenant.service.ts` (not a GlobalSetting fallback).
- **Guardrail not flipped:** `GUARDRAIL_DB_CONFIG_ENABLED` stays `false`; granite remains default; regression guards only.
- **CT2 placeholder `sourceUri`:** intentionally non-resolving until engineers publish the real artifact (D-4).
- **Local-only:** no cloud provider enabled; no gating/threshold/safety changes; SMR call sites untouched (Phase 3 / D-7).

## 8C. Implementation Summary — Phase 3 (SMR gateway refactor / D-7)

> **Implemented & verified 2026-06-15**, via strict TDD (RED → GREEN → REFACTOR) on top of the Phase 1/2/4 working tree. **No schema change** (`migrate diff` in-sync). **No `apps/harness/**` edits.** This phase changes **who resolves and passes** the SMR model and **removes SMR's silent in-gateway default**; it enables **no** cloud provider (the **TASK-357** activation gate is now **satisfied — TASK-357 Completed**; defaults stay local-only) and touches **no** gating/thresholds/PHI/sensors (TASK-357/358/359). **Phases 5 & 6 remain outstanding** — Phase 3 deliberately leaves a single resolver seam (`resolveSmrSelection`) that Phase 5 can later fold onto its generalized `ConfigResolver`.
>
> Plan-gate artifact: [`phase-3-smr-gateway-refactor-plan.md`](./phase-3-smr-gateway-refactor-plan.md)

### 8C.1 What shipped

- **(Resolver seam — B1/B2) `HarnessPolicyService`.** `getEffectivePolicy()` now applies **field-level fallthrough for the two SMR fields only** (`smrModel`/`smrProvider`): when a tenant's own row has them null, they fill from the SYSTEM default, then code-default null (other knobs unchanged; pre-Phase-2 null rows simply fall through — no backfill migration). A new **`resolveSmrSelection(tenantId?)`** wrapper calls `getEffectivePolicy()` and **fails closed** — it throws when no `{provider, model}` can be resolved (no hidden last-resort model). This is the **one resolver every TypeScript caller uses**, and the seam left for Phase 5.
- **(SMR gateway — fail-closed 422, the "no default" half of D-7) `apps/smr`.** The `/api/v1/generate` endpoint now **rejects a missing/blank model with HTTP 422** (`"Field 'model' is required: SMR has no default model."`), evaluated **after** the guardrail check so guardrail rejection keeps precedence. The endpoint's `model = request_body.model or "default"` last-resort and the streaming mirror's `or "default"` are removed, and every provider's `_resolve_model` no longer falls back to `self._default_model` — it returns the caller-supplied `request.model` verbatim. The informational **`ProviderInfo.default_model` / config `default_model` fields are retained** (decision 3) — surfaced only by the providers listing / `get_info()`, never in the generation path.
- **(Callers pass `{provider, model}` on every call)** Each TypeScript `/api/v1/generate` caller resolves via `resolveSmrSelection` and passes both fields (the shared `buildSmrGeneratePayload` already accepts `provider`/`model`/`smrProvider`/`smrModel` in `options`). The durable **harness** path already resolves + passes the model and is **unchanged**; it benefits from B1 transparently because `harness-internal.controller` reads `getEffectivePolicy`.

### 8C.2 The three ambiguous call sites (decision 7)

- **(7a) Admin prompt-test** (`prompt-management.service.ts`) → resolves via the policy cascade (`resolveSmrSelection(this.tenantId)`) and posts `{provider, model}` — consistent with production.
- **(7b) Live-documentation** (`live-documentation.service.ts`) → resolves via policy (per the session's `tenantId`), **not env**; the legacy env values remain only as a fallback for the un-injected/optional path (test fixtures).
- **(7c) Playground/SDK proxy** (`smr-proxy.controller.ts` `generate` + `generateAssembled`) → **passes through** the caller-supplied `model` for SDK fidelity; **only when absent** does it policy-resolve via the tenant from CLS; if resolution still fails it **forwards the request to SMR without a model**, so SMR's fail-closed **422 is the single authority** (the proxy never masks it).

### 8C.3 Per-file changes & key files

| Area | New / Modified | File(s) |
|---|---|---|
| **Resolver seam (B1/B2)** | Modified | `packages/applications/src/services/harness-policy/harness-policy.service.ts` (SMR field-level fallthrough in `getEffectivePolicy` + new fail-closed `resolveSmrSelection`) |
| **Legacy summary callers (C1/C2)** | Modified | `consultation/summary/summary.service.ts`, `consultation/summary/chain-summary.service.ts` (+ `summary.service.module.ts`, `chain-summary.service.module.ts` `HarnessPolicyServiceModule` import) |
| **Job processors (C3–C5)** | Modified | `consultation/jobs/processors/{summary,pre-summary,comprehensive-summary}.processor.ts` (+ `consultation-job.service.module.ts` import) |
| **DNA caller (C6)** | Modified | `dna-writing-style/dna-writing-style.processor.ts` (+ `dna-writing-style.service.module.ts` import) |
| **Live-documentation (C7 / 7b)** | Modified | `consultation/live-documentation/live-documentation.service.ts` (+ `.service.module.ts` import) |
| **Admin prompt-test (C8 / 7a)** | Modified | `prompt-management/prompt-management.service.ts` (+ `.service.module.ts` import) |
| **SDK/playground proxy (D1 / 7c)** | Modified | `apps/api/src/modules/streaming/smr-proxy.controller.ts` (+ `streaming.module.ts` import) |
| **SMR gateway (E1/E3/E4)** | Modified | `apps/smr/src/smr_v2/api/endpoints/generate.py` (422 guard + drop `or "default"`); `providers/{ollama,openai_compat,azure_openai,bedrock}.py` (`_resolve_model` → `request.model`, drop `or self._default_model`) |
| **SMR — intentionally NOT changed** | — | `models/requests.py` (`model` stays `Optional`; see deviation §8C.5) and `core/config.py` (`default_model` retained — decision 3) |
| **Tests (TDD)** | New | `apps/smr/.../tests/unit/test_no_model_default_d7.py` (endpoint 422, provider no-fallback, `default_model` retained) |
| **Tests (TDD)** | Modified | applications: `harness-policy.service.test.ts`, `{summary,chain-summary}.service.test.ts`, `{summary,pre-summary,comprehensive-summary}.processor.test.ts`, `dna-writing-style.processor.test.ts`, `live-documentation.service.test.ts`, `prompt-management.service.test.ts`; api: `smr-proxy.controller.test.ts`; SMR: 14 endpoint/provider suites updated for the caller-supplied-model contract (the old `test_generate_uses_default_model_when_none` rewritten to assert the caller model is used) |

**No migration.** No `.prisma`/`migrations/` change; read-only `prisma migrate diff` reports **in-sync** (§8C.4).

### 8C.4 Verification evidence (captured 2026-06-15)

Filtered / direct commands (not `turbo`) to avoid the pre-existing TASK-352 `@arcaai/database` `tsc` `TS2493` blocker (§8.5). SMR Python tests run in the **`arcaenv`** conda env (the repo's `py:smr-v2:*` scripts; the SMR README's `hope-smr` name is stale).

| Package | Command | Result |
|---|---|---|
| `apps/smr` | `conda run -n arcaenv pytest src/smr_v2/tests/unit/` | **743 passed** |
| `apps/smr` | `pytest .../test_no_model_default_d7.py` | **17 passed** (8 confirmed RED before GREEN) |
| `@arcaai/applications` | `tsc --noEmit` + `build` (rimraf + tsc) | **clean** (both) |
| `@arcaai/applications` | `vitest run` (9 changed suites) | **387 passed** |
| `apps/api` | `vitest run smr-proxy.controller.test.ts` | **67 passed** |
| `apps/api` | `tsc --noEmit -p tsconfig.build.json` (prod config, excludes tests) | **0 errors** |
| `@arcaai/database` | `prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --exit-code` (read-only) | **"No difference detected" (exit 0 — in-sync)** |
| (all changed source) | `ReadLints` | **no linter errors** |

> Note: the full `apps/api` `tsc --noEmit -p tsconfig.json` (which **includes** test files) surfaces only **pre-existing, unrelated** test-file drift (constructor arg-count/type mismatches in `auth`, `audit-log`, `consultation`, `dna-writing-style-admin`, `harness-internal`, `transcription-job`, `stream-ticket` suites — none touched by Phase 3). The production build config excludes tests, so these do not affect the build.

### 8C.5 Decisions applied & deviation

- **Decision 1/2 (fail-closed 422, pass both):** missing/blank model ⇒ 422 at the SMR endpoint; every caller passes `{provider, model}`.
- **Decision 3 (informational `default_model`):** the field is **kept** (config + `ProviderInfo`/`get_info`), removed only from the generation path.
- **Decision 4 (reuse the cascade):** resolver = `HarnessPolicyService.getEffectivePolicy()` + `resolveSmrSelection` fail-closed wrapper; **Phase 3 does not depend on Phase 5's `ConfigResolver`** — the seam is left for Phase 5.
- **Decision 5/6:** no `apps/harness/**` edits; pre-Phase-2 null rows fall through (no backfill).
- **Deviation from plan §4.E E1 (flagged):** the plan suggested making `GenerateRequest.model` a **required Pydantic field**. Instead the fail-closed 422 is enforced at the **endpoint** while `model` stays `Optional` at the schema. The **external contract is identical** (a model-less request ⇒ 422), but this avoids churning ~140 unrelated TASK-338 unit constructions (`GenerateRequest(prompt=...)` in provider/hyperparameter/response-format/telemetry tests) — i.e., the safest equivalent with the smallest blast radius. Provider `_resolve_model` now returns `request.model` (typed `str | None`); in the live flow the endpoint guard guarantees it is non-null before any provider call.

## 8D. Implementation Summary — Phase 5 (Realtime cascade / Pillar B)

> **Implemented & verified 2026-06-15**, via strict TDD (RED → GREEN → REFACTOR) on top of the Phase 1/2/3/4 working tree. **Additive schema only** — one new enum + two new tables + a SYSTEM-default seed row; **NO column changes** to `Department`/`UserProfile`/`Consultation`, and `migrate diff` reports **in-sync**. This phase builds the realtime-toggle **cascade** (`autoSummaryEnabled`/`autoNerEnabled`/`harnessEnabled`) + the generalized **`ConfigResolver`**, threads the doctor-preferred prompt id through the **primary** generation paths (sync REST + `summary.processor` + harness assemble — at Phase-5 ship time **not** `pre-summary`/`comprehensive-summary`, **since closed by TASK-362** 2026-06-16; see §2.5), and creates the per-doctor **`dnaStyleEnabled`** column **reserved for Phase 6** (Phase 5 only CREATES + READS it — no write/application). **Phase 3 is not regressed** — its `resolveSmrSelection`/`getEffectivePolicy` SMR seam + fail-closed 422 are left **untouched** (the optional SMR fold-in was **skipped** — §8D.5). _(Historical note: Phase 6 was outstanding at the time of this summary; it has since been implemented & verified — see §8E.)_ The **TASK-357** activation gate is now **satisfied (TASK-357 Completed)**; defaults remain local-only.
>
> Plan-gate artifact: [`phase-5-realtime-cascade-plan.md`](./phase-5-realtime-cascade-plan.md)

### 8D.1 What shipped

- **(DB — additive polymorphic table) `PipelinePolicy` + WORM `PipelinePolicyChange` + enum `PipelinePolicyScope`.** Mirrors `HarnessPolicy`/`HarnessPolicyChange`: a polymorphic `(scope ∈ TENANT|DEPARTMENT|DOCTOR, scopeId)` row carrying **nullable** toggles `autoSummaryEnabled`/`autoNerEnabled`/`harnessEnabled`/`dnaStyleEnabled` (null = "inherit from next tier"), `_version` for OCC, and a unique `(tenantId, scope, scopeId)` index. The change table is append-only at the **DB-privilege layer** (role-guarded `REVOKE UPDATE, DELETE … FROM hope_app_template`/`hope_app`, mirroring the `HarnessPolicyChange` WORM block). The migration also bootstraps **one SYSTEM-tenant TENANT-scope default row** (`INSERT … ON CONFLICT ("id") DO NOTHING`): `autoSummary=autoNer=true`, **`harnessEnabled=false`** (legacy platform default), `dnaStyleEnabled=NULL`.
- **(Domain) entity/factory/mapper/model/repository ×2 + the enum** generated under `…/generated/core/` + the six generated barrels + `CoreDatabaseModule` registration (mirrors the harness-policy domain layout).
- **(Applications — generalized resolver) `ConfigResolver`.** Resolves each cascade knob `doctor → department → tenant → SYSTEM-default → code-default`, returns the effective value **with a resolution trace**, registers a **max-scope** per setting (`harnessEnabled` capped at **tenant+dept**, NOT doctor), and **fails open to code-defaults** on a DB error (logs a WARN). Also exposes `resolvePreferredPromptTemplateId(doctorId)` — the unified preferred-prompt read. Phase 3's SMR resolver is deliberately **not** folded in (§8D.5).
- **(Applications — policy store) `PipelinePolicyService`** (+ module/DTO/interface): `getEffective` (cascade + trace), `getRow` (raw editable row at a scope), `upsertRow` (OCC via `_version` + a **WORM `PipelinePolicyChange`** on every write). Max-scope is enforced on write (a doctor-scope `harnessEnabled` is rejected).
- **(Applications — rewire) `consultation-event.handler.ts` `resolvePipelineConfig()`** now resolves the toggles through `ConfigResolver` (cascade) instead of consultation-metadata-only, keeps the per-consultation `metadata.pipelineConfig` as the **top overlay** (back-compat), and gracefully falls back to the prior defaults when the resolver is unwired.
- **(Applications — primary-path preferred-prompt threading)** the BullMQ **`summary.processor.ts`** and the **harness assemble path** (`harness-internal.service.ts`, a surgical add that dodges the TASK-355 warm-start block) now resolve `UserProfile.preferredPromptTemplateId` via `ConfigResolver` and pass it into prompt resolution/assembly; the sync REST `summary.service.ts` already threaded it (TASK-329). **§2.5 corrected** to reflect the actual scope — at Phase-5 ship time the `pre-summary`/`comprehensive-summary` processors were **not** threaded; **TASK-362 (Completed 2026-06-16) has since threaded them plus the sync `chain-summary` path**, so the preferred id now reaches every generation path.
- **(API) `PipelinePolicyAdminController` + module** under `admin/harness/pipeline-policy`: `GET /` (effective cascade + trace), `GET /row` (raw row at a scope), `PUT /row` (OCC `If-Match`/`ExpectedVersion` + max-scope guard). New **`PipelinePolicy` CASL subject** (NOT a reuse of `HarnessPolicy`).
- **(Seed / UI) `14-pipeline-policy.ts`** idempotently ensures the SYSTEM default **and** a **demo-tenant** TENANT-scope row (`harnessEnabled=true`, with its WORM change row) so the clinical-workspace demo keeps routing through the harness after the UI hard-code is removed; **CASL grants** for `PipelinePolicy` added to `tenant-full-access` / `harness-platform-manage` / `harness-tenant-manage` in `seed/01-policy.ts`; the hard-coded `HARNESS_PIPELINE_METADATA`/`harnessEnabled` is removed from `launch-panel.tsx` + `constants.ts` (open routing is now server-resolved).

### 8D.2 Cascade & back-compat semantics

- **Knobs that cascade:** `autoSummaryEnabled`/`autoNerEnabled` (doctor→dept→tenant→SYSTEM→code-default) and `harnessEnabled` (**tenant→dept only** — doctor scope rejected). `dnaStyleEnabled` is **doctor-scope storage only** this phase (created + read; **written/applied in Phase 6**).
- **No-policy back-compat:** with zero override rows every tenant falls through to the SYSTEM default — `autoSummary/autoNer=true`, `harnessEnabled=false` — exactly today's platform behavior. The demo's harness is preserved by its **own** seeded demo-tenant row, NOT by the platform default, so removing the UI hard-code does **not** silently route every tenant into the harness.
- **Overlay precedence (top layer unchanged):** per-consultation `metadata.pipelineConfig` still wins over the cascade, so existing callers that pass explicit metadata are unaffected.

### 8D.3 Per-file changes & key files

| Area | New / Modified | File(s) |
|---|---|---|
| **DB schema** | New / Modified | `packages/database/src/prisma/db_main/pipeline-policy.prisma` (new — both models); `…/enums.prisma` (modified — `PipelinePolicyScope`) |
| **DB migration** | New | `…/migrations/20260615120000_task_356_phase5_pipeline_policy/migration.sql` (enum + 2 tables + 4 indexes + role-guarded WORM `REVOKE` + SYSTEM-default `INSERT … ON CONFLICT DO NOTHING`) |
| **Domain** | New | `domains/src/enums/generated/PipelinePolicyScope.ts`; `entities/generated/core/{PipelinePolicyEntity,PipelinePolicyChangeEntity}.ts`; `factories/generated/core/{PipelinePolicyFactory,PipelinePolicyChangeFactory}.ts`; `mappers/generated/core/{PipelinePolicyEntityMapper,PipelinePolicyChangeEntityMapper}.ts`; `models/generated/core/{PipelinePolicyModel,PipelinePolicyChangeModel}.ts`; `repositories/generated/core/{PipelinePolicyRepository,PipelinePolicyChangeRepository}.ts` |
| **Domain barrels/registration** | Modified | `entities`/`factories`/`mappers`/`models`/`repositories` `…/generated/core/index.ts`, `enums/generated/index.ts`, `common/databaseServices/core/core.database.module.ts` |
| **Applications — resolver** | New | `applications/src/services/config-resolver/{config-resolver.service,config-resolver.module,index}.ts` |
| **Applications — policy store** | New | `…/services/pipeline-policy/{pipeline-policy.service,pipeline-policy.service.module,index}.ts` + `dto/{pipeline-policy.response,update-pipeline-policy.request,index}.ts` |
| **Applications — rewire / threading** | Modified | `consultation/events/consultation-event.handler.ts`; `consultation/jobs/processors/summary.processor.ts` (+ `consultation-job.service.module.ts` — imports `ConfigResolverModule` for handler + processor); `consultation/harness/harness-internal.service.ts` (+ `harness-internal.service.module.ts`); `services/index.ts` (barrel) |
| **API** | New / Modified | `apps/api/src/modules/pipeline-policy-admin/{pipeline-policy-admin.controller,pipeline-policy-admin.module}.ts` (new); `apps/api/src/app.module.ts` (modified — register module) |
| **Seed / CASL** | New / Modified | `packages/database/src/prisma/db_main/seed/14-pipeline-policy.ts` (new); `seed/index.ts`, `seed/01-policy.ts` (modified) |
| **UI** | Modified | `apps/ui-playground/src/features/clinical-workspace/components/launch-panel.tsx`, `…/constants.ts` (remove hard-coded `harnessEnabled`) |
| **Tests (TDD)** | New | domains `__tests__/{PipelinePolicyEntity,PipelinePolicyFactory}.test.ts`; applications `config-resolver/__tests__/config-resolver.service.test.ts`, `pipeline-policy/__tests__/pipeline-policy.service.test.ts`; api `pipeline-policy-admin/__tests__/pipeline-policy-admin.controller.test.ts` |
| **Tests (TDD)** | Modified | applications `consultation/events/__tests__/consultation-event.handler.test.ts`, `consultation/jobs/__tests__/summary.processor.test.ts`, `consultation/harness/__tests__/harness-internal.service.test.ts`; database `src/__tests__/seed.test.ts` |

### 8D.4 Verification evidence (captured 2026-06-15)

Filtered / direct commands (not `turbo`) to avoid the pre-existing TASK-352 `@arcaai/database` `tsc` `TS2493` blocker (§8.5) — the DB suite is run via the targeted `vitest run src/__tests__/seed.test.ts` (it never compiles the offending `seed/__tests__/api-key-pepper.test.ts`). Phase 5 is TS-only — no conda.

| Package | Command | Result |
|---|---|---|
| `@arcaai/database` | `prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --exit-code` (read-only) | **"No difference detected" (exit 0 — in-sync)** |
| `@arcaai/database` | `vitest run src/__tests__/seed.test.ts` | **323 passed** |
| `@arcaai/domains` | `build` (tsc) | **clean** |
| `@arcaai/domains` | `vitest run -t "PipelinePolicy"` | **11 passed** (entity + factory suites) |
| `@arcaai/applications` | `build` (rimraf + tsc) | **clean** |
| `@arcaai/applications` | `vitest run config-resolver pipeline-policy` | **25 passed** |
| `@arcaai/applications` | `vitest run src/services/consultation` | **1049 passed** (36 suites — handler/processor/harness threading, no regression) |
| `apps/api` | `build` (nest build + tsc-alias) | **clean** |
| `apps/api` | `vitest run src/modules/pipeline-policy-admin` | **13 passed** |
| (all changed source) | `ReadLints` | **no linter errors** |

### 8D.5 Decisions applied & scope guards

- **Decision 1 (additive polymorphic table):** new `PipelinePolicy`/`PipelinePolicyChange` + `PipelinePolicyScope`; nullable toggles incl. `dnaStyleEnabled`; **no** column changes to `Department`/`UserProfile`/`Consultation`.
- **Decision 2 (primary paths):** preferred-prompt threading on sync REST (pre-existing) + `summary.processor` + harness assemble; **§2.5 corrected** — `pre-summary`/`comprehensive-summary` were unthreaded at ship time, **since completed in TASK-362 (2026-06-16)** along with the sync `chain-summary` path.
- **Decision 3 (`harnessEnabled` max-scope = tenant+dept):** enforced in `ConfigResolver` and on `PipelinePolicyService.upsertRow`; back-compat default preserved (`false`).
- **Decision 4 (new authz subject):** dedicated `PipelinePolicy` CASL subject (GLOBAL + TENANT grants); `HarnessPolicy` NOT reused.
- **Decision 5 (cascade knobs = toggles):** `dnaStyleEnabled` is doctor-scope storage only (Phase 6 applies it).
- **Decision 6 (SYSTEM-default cascade):** one bootstrapped SYSTEM row via migration `INSERT … ON CONFLICT DO NOTHING`; **zero per-tenant rows required**; `tenant.service.ts` clone NOT extended.
- **Decision 7 (resolver; optional SMR fold-in) — SKIPPED:** built the generalized `ConfigResolver` for the realtime toggles + preferred-prompt, but **left Phase 3's `resolveSmrSelection`/`getEffectivePolicy` SMR seam exactly as shipped**. Folding SMR onto `ConfigResolver` was optional and only allowed if it preserved Phase 3's 422 contract bit-for-bit; the conservative, no-regression choice is to leave the SMR seam independent (it can be folded later without touching the 422 behavior).
- **Scope guards:** no Phase 6 work (no doctor CRUD/UI, no DNA-style application, no viewer); no `apps/harness/**` Python or gating/threshold/PHI/sensor edits; no Phase 3 SMR-path edits; `apps/ui-playground/src/routeTree.gen.ts` untouched; **no git commit**.

## 8E. Implementation Summary — Phase 6 (Doctor self-service + DNA edit-capture)

> **Implemented & verified 2026-06-15**, via strict TDD (RED → GREEN → REFACTOR) on top of the Phase 1/2/3/4/5 working tree. **NO new schema** — the AI-draft `v1` snapshot + edit/sign deltas reuse the existing `ContextItemVersion` columns (`changeReason`/`contentDiff`/`fieldChanges`), and the per-doctor DNA toggle reuses Phase 5's `PipelinePolicy.dnaStyleEnabled`; `migrate diff` reports **in-sync**. This phase is **additive and opt-in** — with the tenant DNA flag off and no doctor opting in, behaviour is byte-identical to pre-Phase-6. **Phase 3 (SMR `resolveSmrSelection`/422 seam) and Phase 5 (`PipelinePolicy`/`ConfigResolver` internals) are consumed, not regressed.** The **TASK-357** activation gate is now **satisfied (TASK-357 Completed)**; defaults remain local-only.
>
> Plan-gate artifact: [`phase-6-doctor-selfservice-dna-plan.md`](./phase-6-doctor-selfservice-dna-plan.md)

### 8E.1 What shipped

- **(S1/S2 — Applications) Doctor self-service prompt CRUD + preferred.** `PromptManagementService` gained `updatePersonal`/`deletePersonal` (thin wrappers that **assert strict caller-ownership** of a `USER_PERSONAL` row, then delegate to the existing OCC update / soft-delete) and `setPreferredPromptTemplate` (validates the target is available to the caller, then writes `UserProfile.preferredPromptTemplateId` via the injected `IUserProfileService.upsertByUserId`; `null` clears). `UpdateUserProfileRequest.preferredPromptTemplateId` widened to `string | null`. `PromptTemplateResponse` + mapper now surface **`scope`** so the doctor UI can tell its OWN editable personals from read-only defaults (additive; admin surfaces ignore it).
- **(S3 — Applications) Per-doctor DNA toggle (stored on `PipelinePolicy.dnaStyleEnabled`).** `ConfigResolver.resolveEffectiveDnaStyleEnabled` computes **effective = tenant AND doctor** (`tenantEnabled && (doctorToggle ?? true)`). `PipelinePolicyService.getDnaSettings`/`setDnaStyleForDoctor` read/write the DOCTOR-scope row with **OCC + a WORM `PipelinePolicyChange`**. `DnaWritingStyleService.getDnaSettings`/`setDnaEnabled` are the doctor-facing API (delegate + tenant-context validation + `ResourceUpdated` SysEvent). DNA-style **application** is gated on the same effective flag across generation paths.
- **(S4 — Applications) AI-draft `v1` snapshot at generation.** Both the sync `summary.service.ts generateSummary` and the harness/async `harness-internal.service.ts persistDraft` boundaries capture a `ContextItemVersion` with `changeReason='ai_draft_v1'` (surgical appends in the TASK-355/Phase-3 shared methods).
- **(S5 — Applications) Delta capture on edit + sign.** New dependency-light `content-diff.util.ts` (`diffContent(old,new) → { contentDiff (unified text diff), fieldChanges ({section:{old,new}} by SOAP heading, whole-doc fallback) }`). `summary.service.ts updateSummary` (before the TASK-355 `signalEdit`) and `approveSummary` (append-only on sign) populate the existing `contentDiff`/`fieldChanges` columns.
- **(S6 — Applications) DNA processor ingests draft↔approved pairs (BATCH).** `dna-writing-style.processor.ts` builds the corpus from `ai_draft_v1`↔approved **pairs** (static `buildCorpus`), falls back to final-only for legacy consults with no `v1`, and **gates** on the effective DNA flag (fails the job when disabled). Capture-on-sign / process-offline — **no synchronous on-sign SMR enqueue**; the `callSmrV2` transport signature is **unchanged** (Phase 3 seam preserved).
- **(API) Doctor self-service routes.** `prompt-template.controller.ts` (end-user, NOT `/admin`): `POST /` create personal, `PATCH /:id` update (OCC `If-Match`), `DELETE /:id` delete, `PUT /preferred` set/clear — all `['read','PromptTemplate']` with real ownership enforced in the service (clinicians only hold `read`/`list`). `dna-writing-style.controller.ts`: `GET/PUT /settings` (OCC, `assertActingAsDoctor` guard). New DTOs + NestJS module wiring (`UserProfileServiceModule`, `PipelinePolicyServiceModule`, `ConfigResolverModule`).
- **(UI) "My Prompts" + DNA switch + draft↔final viewer.** New `features/prompts/**` page (route `routes/_authenticated/prompts.tsx` + sidebar "My Prompts"): lists the caller's personals (create/edit/delete dialogs + OCC) and read-only defaults, with a **preferred** picker (`PUT /prompt-templates/preferred`). The DNA page (`features/dna-writing-style/index.tsx`) now mounts a **per-doctor on/off `Switch`** (`DnaSettingsCard`) that disables + explains when the tenant flag is off (effective = tenant AND doctor). A reusable **read-only `DraftFinalDiffViewer`** (over the shared `VersionDiffPanel`) is surfaced on My Prompts as a "default → your version" comparison.

### 8E.2 Edit-capture & effective-flag semantics

- **No-migration edit-capture:** `v1` = `ContextItemVersion(changeReason='ai_draft_v1')`; the edit/sign delta = the existing `contentDiff`/`fieldChanges` columns (previously always `undefined`). The DNA processor already keys off `changeReason`, so pairing is a corpus-builder change only.
- **Effective DNA = tenant AND doctor:** a doctor may **opt out** any time; a doctor **cannot opt in** when the tenant flag is off (the UI switch is disabled + explained). `doctorToggle === null` ⇒ implicit opt-in (`?? true`).
- **Opt-in back-compat:** tenant flag off + no doctor override ⇒ no snapshot styling/learning differences vs pre-Phase-6 (the snapshot/delta rows are inert metadata until a doctor opts in and the processor runs).

### 8E.3 Per-file changes & key files

| Area | New / Modified | File(s) |
|---|---|---|
| **Applications — edit-capture (S4/S5)** | New | `consultation/summary/content-diff.util.ts` (+ `__tests__/content-diff.util.test.ts`, `__tests__/summary.service.edit-capture.test.ts`) |
| **Applications — edit-capture (S4/S5)** | Modified | `consultation/summary/summary.service.ts` (`generateSummary` v1 snapshot; `updateSummary`/`approveSummary` delta); `consultation/harness/harness-internal.service.ts` (`persistDraft` v1 snapshot) (+ their test suites) |
| **Applications — DNA toggle (S3)** | Modified (extends Phase-5 files) | `config-resolver/config-resolver.service.ts` (`resolveEffectiveDnaStyleEnabled`); `pipeline-policy/pipeline-policy.service.ts` (`getDnaSettings`/`setDnaStyleForDoctor`); `dna-writing-style/{dna-writing-style.service.ts,IDnaWritingStyleService.ts,dna-writing-style.service.module.ts,dto/index.ts}` (+ test suites) |
| **Applications — DNA toggle (S3) DTOs** | New | `dna-writing-style/dto/{dna-settings.response,update-dna-settings.request}.ts` |
| **Applications — DNA pairs (S6)** | Modified | `dna-writing-style/dna-writing-style.processor.ts` (pairs corpus + gating) (+ test) |
| **Applications — prompt CRUD/preferred (S1/S2)** | Modified | `prompt-management/{prompt-management.service.ts,IPromptManagementService.ts,prompt-management.service.module.ts,prompt-management.dto.mapper.ts,dto/index.ts,dto/prompt-template.response.ts}`; `user/userProfile/dto/updateUserProfile.request.ts` (+ service/mapper test suites) |
| **Applications — prompt DTOs (S2)** | New | `prompt-management/dto/{preferred-prompt-template.response,set-preferred-template.request}.ts` |
| **API** | Modified | `apps/api/src/modules/prompt-management/prompt-template.controller.ts` (personal CRUD + preferred); `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts` (settings) (+ both controller test suites) |
| **UI — new feature** | New | `apps/ui-playground/src/features/prompts/{api/prompts.ts,lib/partition.ts,components/draft-final-diff-viewer.tsx,components/prompt-form-dialog.tsx,index.tsx}` (+ `lib/__tests__/partition.test.ts`, `components/__tests__/draft-final-diff-viewer.test.tsx`, `__tests__/my-prompts.test.tsx`); `routes/_authenticated/prompts.tsx` |
| **UI — DNA switch** | New / Modified | `features/dna-writing-style/components/dna-settings-card.tsx` (new); `features/dna-writing-style/{index.tsx,api/dna-writing-styles.ts}` (mount card + settings hooks); `features/dna-writing-style/__tests__/dna-impersonation-guard.test.tsx` (stub the new card) |
| **UI — nav / generated** | Modified | `apps/ui-playground/src/components/layout/app-sidebar.tsx` ("My Prompts" entry); `apps/ui-playground/src/routeTree.gen.ts` (**auto-generated** via `tsr generate` — not hand-edited) |

### 8E.4 Verification evidence (captured 2026-06-15)

Filtered / direct commands (not `turbo`) to avoid the pre-existing TASK-352 `@arcaai/database` `tsc` `TS2493` blocker (§8.5). Phase 6 is TS-only — no conda.

| Package | Command | Result |
|---|---|---|
| `@arcaai/database` | `prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --exit-code` (read-only) | **"No difference detected" (exit 0 — in-sync; NO Phase-6 schema)** |
| `@arcaai/applications` | `test:unit` (full) | **5222 passed \| 4 skipped (222 files) — no regression** |
| `@arcaai/applications` | `vitest run` (summary/dna/pipeline-policy/prompt-management/config-resolver/harness) | **617 passed (28 suites)** |
| `apps/api` | `test` (full) | **1808 passed \| 4 skipped (104 files) — no regression** |
| `apps/api` | `vitest run` (prompt-management + dna-writing-style + pipeline-policy-admin) | **123 passed (5 suites)** |
| `apps/ui-playground` | `vitest run` (full) | **1345 passed (160 files)** |
| `apps/ui-playground` | `vitest run src/features/prompts` | **11 passed (3 files)** |
| (all changed source) | `ReadLints` | **no linter errors** |
| `apps/ui-playground` | `type-check` (tsc) | **0 errors in Phase-6 files** (only pre-existing, out-of-scope errors remain — see §8E.5 deviation) |

### 8E.5 Decisions applied, deviations & scope guards

- **BQ-1 (`v1` storage) / BQ-2 (delta format):** reuse `ContextItemVersion` (`changeReason='ai_draft_v1'`) + `contentDiff` (unified text diff) + `fieldChanges` (`{section:{old,new}}` by SOAP heading, whole-doc fallback). **No migration.**
- **BQ-3 (DNA trigger) = BATCH:** capture-on-sign, process-offline; **no** synchronous on-sign SMR enqueue and **no** new module coupling into `SummaryServiceModule`; `callSmrV2` transport unchanged.
- **BQ-4 (DNA toggle) = Phase-5 `PipelinePolicy.dnaStyleEnabled`** (zero new schema); semantics **tenant AND doctor**.
- **BQ-5 (auth scope):** personal routes on the **end-user** `prompt-template.controller.ts` gated `['read','PromptTemplate']` with **strict caller-ownership in the service**; preferred-template route writes the caller's profile only.
- **BQ-6 (draft↔final viewer) = IN, as a reusable read-only component.** Built `DraftFinalDiffViewer` and surfaced it on **My Prompts** (default → your-version diff) — a self-contained, testable data source. **Deviation (flagged):** the consultation `version-detail-panel.tsx` AI-draft↔signed surface (and its optional `GET …/draft-delta` endpoint) was **NOT** wired — it is SDK-coupled (`@arcaai/vox`, stubbed under test) and adjacent to TASK-355 review territory; the reusable viewer is generic enough to drop in there later without change.
- **Deviation (NOT introduced by Phase 6 — a TASK-356 Phase 4 regression, now tracked as Phase 4 Hotfix H-1 / §8F):** `apps/ui-playground` `vite build` + `tsc` are RED on the working tree because **committed** consumers `clinical-workspace/components/capture-panel.tsx` and `admin/audio-pipelines/frontend-pipeline-tab.tsx` import `useArcaAudio`/`CaptureMode`/`TranscriptionMode`, which the `@arcaai/vox` **public barrel** does not export (the SDK source defines them; the barrel/dist lag). **Root cause is TASK-356 Phase 4 (commit `f154ce04`)** — that commit added the `CaptureMode`/`TranscriptionMode` types **and** the consumer imports but did **not** update the `@arcaai/vox` `core.ts` barrel (git-confirmed via `git log -S` pickaxe — see §8F). _(An earlier draft labelled this "pre-existing / out-of-scope"; that was an attribution error — a clean `git status` only meant TASK-356 was already committed, not that the symbols predated it.)_ Both consumer files are out-of-scope for Phase 6 (`clinical-workspace`, SDK) and were left untouched; the fix is the additive barrel change tracked as **§8F (H-1)**. Phase-6 build-equivalence is evidenced instead by the **full vitest suite (1345 passed — esbuild-compiles every new file)**, **clean `ReadLints`**, and **`type-check` reporting zero errors in Phase-6 files**.
- **Scope guards honoured:** no new schema / migration (`migrate diff` in-sync); surgical appends only on `summary.service.ts`/`harness-internal.service.ts`; **did not touch** `clinical-workspace/review-*`, harness gating/thresholds/PHI/sensors, `apps/harness/**` Python, `/admin/prompt-templates`, Phase 3 SMR code, or Phase 5 `PipelinePolicy` internals (consumed only); `routeTree.gen.ts` regenerated via `tsr generate` (not hand-edited); **no git commit**.

## 8F. Phase 4 Hotfix H-1 — Vox SDK barrel export gap (ui-playground build)

> **Status: Pending (fix not yet implemented).** Surfaced during **Phase 6 verification**; root-caused to **TASK-356 Phase 4 (commit `f154ce04`)**. Briefly tracked as standalone **TASK-360** and **folded here as Phase 4 Hotfix H-1 per the 2026-06-15 review** (the standalone ticket was retired; ticket number 360 is not reused). The **DRAFT fix plan below requires approval before coding** (per `01-development-workflow.mdc`).

### 8F.1 Symptom

The `@arcaai/ui-playground` **production build (`vite build`)** and its **`type-check`** are **RED** (~9 errors across ~4 files) because committed UI files import symbols from the `@arcaai/vox` public package that the SDK's public barrels do not surface:

- `useArcaAudio` — the **hook value** is not surfaced (the `UseArcaAudio` *type* is exported, but not the runtime hook).
- `CaptureMode` / `TranscriptionMode` — config **types** defined in the SDK but not re-exported by the public barrel(s).

### 8F.2 Barrel root cause (with evidence)

- **Symbol definitions present in SDK source:** `packages/agentic-sdk-v2/src/types/frontend-pipeline-config.ts:35` (`TranscriptionMode`), `:41` (`CaptureMode`); `useArcaAudio` is an audio hook whose **type** (`UseArcaAudio`) is exported by `core.ts` but whose **value** is not surfaced by the public barrel.
- **Barrel gap:** `packages/agentic-sdk-v2/src/core.ts:386–391` re-exports from `frontend-pipeline-config.ts` only the **siblings** (`FrontendPipelineConfigJson`, `TenantFrontendConfig`, `UpsertTenantFrontendConfigInput`) and **omits `CaptureMode` / `TranscriptionMode`**; `index.ts` re-exports via `export *` and inherits the omission.
- **Consumers (added by `f154ce04`; import from the full `@arcaai/vox`):** `apps/ui-playground/src/features/admin/audio-pipelines/frontend-pipeline-tab.tsx` (imports `type CaptureMode`, `type TranscriptionMode`); `apps/ui-playground/src/features/clinical-workspace/components/capture-panel.tsx` (imports `useArcaAudio`).

### 8F.3 Why this is a Phase 4 regression (git-confirmed)

- `git log -S "CaptureMode" -- packages/agentic-sdk-v2/src/types/frontend-pipeline-config.ts` → **only `f154ce04`** (the types did not exist before this commit).
- `git log -S "useArcaAudio" -- apps/ui-playground/src/features/clinical-workspace/components/capture-panel.tsx` → **only `f154ce04`** (the consumer import was added there).
- The same Phase 4 commit landed the types **and** the consumers but did **not** update the `core.ts` barrel — types, consumers, and the gap shipped together. TASK-356's per-package gates were green because the breaking imports are only exercised by the `ui-playground` **vite/`type-check`** build, which the per-package verification did not run (it used filtered `vitest`/`tsc`). The gap stayed latent until a full build.

### 8F.4 Acceptance criteria

- [ ] `pnpm --filter @arcaai/ui-playground build` (vite) exits 0.
- [ ] `pnpm --filter @arcaai/ui-playground type-check` reports **0 errors** (currently ~9 across ~4 files).
- [ ] `useArcaAudio`, `CaptureMode`, `TranscriptionMode` resolve from the entry point(s) the committed consumers import them from (`@arcaai/vox`), without changing the SDK's intended core/plugins split semantics.
- [ ] `@arcaai/vox` builds (tsup) and its own `type-check`/tests stay green; the barrel change is **additive** (no behavior change to existing SDK consumers; core/plugins bundle-size contract preserved).

### 8F.5 Proposed fix plan (DRAFT — requires approval before coding)

1. **Reproduce & capture exact errors** — run `pnpm --filter @arcaai/ui-playground type-check` + `… build`; record the full failing-symbol list and the entry point each consumer uses.
2. **Decide the fix shape per symbol:**
   - `CaptureMode` / `TranscriptionMode`: add to the `frontend-pipeline-config` re-export block in `core.ts:386–391` (additive; flows through `index.ts`). These are config types (not plugin code) and belong alongside their siblings in `core`.
   - `useArcaAudio` (value): confirm it is surfaced by the full `@arcaai/vox` / `@arcaai/vox/plugins` barrel; per the SDK design (`08-vox-sdk.mdc`), `@arcaai/vox/core` intentionally excludes audio plugin code, so if a consumer imports the hook from a barrel that legitimately should not include audio, fix the **consumer import** instead of polluting `core`.
3. **Verify:** `@arcaai/vox` build (tsup) + `type-check` green (add/extend a barrel-surface test asserting the named exports); `pnpm --filter @arcaai/ui-playground type-check` → 0 errors; `… build` → exit 0; `… test` stays green.
4. **Guardrail:** keep the change additive; do not alter the core/plugins bundle-size contract.

### 8F.6 Change note

| Date | Description |
|---|---|
| 2026-06-15 | Surfaced during Phase 6 verification; root-caused to Phase 4 (`f154ce04`) via `git log -S` pickaxe. Briefly opened as standalone **TASK-360**, then **folded into TASK-356 as Phase 4 Hotfix H-1** per the 2026-06-15 review (TASK-360 retired, number not reused). Barrel analysis + DRAFT fix plan validated; no code changed yet (Pending). |

---

## 9. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-14 | Initial review/audit + design addendum created (no code changes). | `docs/implementation/TASK-356-Admin-Managed-Models-Workflows/README.md` |
| 2026-06-14 | Deep-dive across audio pipeline, capture/storage, prompts/realtime, DNA edit-capture; finalized architecture (3 planes + 1 resolver + 2 workflow consoles); resolved D-1/D-2/D-4/D-5/D-6/D-7 + added D-8/D-9/D-10; re-phased plan. | same |
| 2026-06-14 | **Planned → foundation → parallel implementation → integration verify.** Authored the Phase 1 (`phase-1-catalog-plane-plan.md`) and Phase 4 (`phase-4-audio-console-plan.md`) TDD plan-gate docs; landed a single additive shared DB foundation migration (`20260614120000_task_356_catalog_audio_foundation`); implemented Phase 1 (Catalog plane) and Phase 4 (Audio console) **in parallel**; then ran a combined integration verification (domains/applications/api/ui/SDK/database — all green, no fix needed, migration in-sync & additive) and recorded the **§8 Implementation Summary**. Status → Phase 1 + 4 implemented & verified; Phases 2/3/5/6 outstanding (Phase 2/3 activation gated on TASK-357). | `…/README.md`, `phase-1-catalog-plane-plan.md`, `phase-4-audio-console-plan.md` (+ DB/domain/applications/api/ui/SDK source per §8.2) |
| 2026-06-14 | **Phase 2 (Defaults wiring) implemented & verified (TDD).** Rows/config only — **no schema change** (`migrate diff` in-sync). (a) SMR default set on the SYSTEM `HarnessPolicy` (`lm-studio` / `mlx-community/medgemma-1.5-4b-it`) via new idempotent **`seedHarnessPolicy`** that also writes a **WORM `HarnessPolicyChange`** (seed_worm override) + `default-smr-model` GlobalSetting; (b) Guardrail regression guards only (`GUARDRAIL_DB_CONFIG_ENABLED` left `false`); (c) STT CT2 `AiModel` (placeholder `sourceUri`, D-4) + `production-faster-whisper-turbo-int8` `AsrPipeline`, **both batch+streaming defaults flipped** + `switchDefaultSttPipeline` backfill (no double-default); (d) **extend_clone override** — `tenant.service.ts` `create()` clones the SYSTEM default `AsrPipeline` (+ current version) per-tenant, tenant-scoped default, idempotent backfill. Verified: 315 seed tests, applications build + 5125 unit tests, tenant clone suite, lints clean. No cloud enabled (still gated on TASK-357); Phases 3/5/6 outstanding. | `…/README.md`, `packages/database/src/prisma/db_main/seed/{13-harness-policy.ts (new),06-stt.ts,11-global-setting.ts,91-user.ts,index.ts}`, `packages/database/src/__tests__/seed.test.ts`, `packages/applications/src/services/tenant/tenant.service.ts` (+ tenant test suites) |
| 2026-06-15 | **Phase 3 (SMR gateway refactor / D-7) implemented & verified (TDD).** **No schema change** (`migrate diff` in-sync) and **no `apps/harness/**` edits**. (B1/B2) `HarnessPolicyService.getEffectivePolicy()` now field-level-fallthroughs the two SMR fields (tenant→SYSTEM→null) + new **fail-closed `resolveSmrSelection`** = the single resolver seam left for Phase 5. (E1/E3/E4) `apps/smr` `/api/v1/generate` **fails closed with 422** on missing/blank model (after guardrail), the `or "default"` last-resort is removed, and every provider `_resolve_model` returns the caller-supplied model (no `_default_model` fallback); **informational `default_model` retained** (decision 3). (C1–C8/D1) every TS caller — legacy `summary`/`chain-summary`, the 3 job processors, DNA, **(7b) live-doc → policy not env**, **(7a) admin prompt-test → policy** — resolves via `resolveSmrSelection` and posts `{provider, model}`; **(7c) SDK proxy passes through** the caller model and only policy-resolves when absent, letting SMR's 422 be the sole authority. **Deviation (flagged):** 422 enforced at the endpoint with `GenerateRequest.model` kept `Optional` (identical external contract, avoids churning ~140 unrelated unit constructions). Verified in conda **`arcaenv`**: SMR 743 pytest + 17 new D-7 tests; applications tsc/build clean + 387 unit (9 Phase-3 suites); api `smr-proxy` 67 + prod-config tsc 0 errors; lints clean. No cloud enabled (still gated on TASK-357); Phases 5/6 outstanding. | `…/README.md`, `packages/applications/src/services/harness-policy/harness-policy.service.ts`, `consultation/summary/{summary,chain-summary}.service.ts`, `consultation/jobs/processors/{summary,pre-summary,comprehensive-summary}.processor.ts`, `consultation/live-documentation/live-documentation.service.ts`, `dna-writing-style/dna-writing-style.processor.ts`, `prompt-management/prompt-management.service.ts` (+ their `.service.module.ts`/`consultation-job.service.module.ts` imports + test suites), `apps/api/src/modules/streaming/{smr-proxy.controller.ts,streaming.module.ts}` (+ test), `apps/smr/src/smr_v2/api/endpoints/generate.py`, `apps/smr/src/smr_v2/providers/{ollama,openai_compat,azure_openai,bedrock}.py`, `apps/smr/.../tests/unit/test_no_model_default_d7.py` (new) + 14 SMR test suites |
| 2026-06-15 | **Phase 5 (Realtime cascade / Pillar B) implemented & verified (TDD).** **Additive schema only** (`migrate diff` in-sync) — new polymorphic **`PipelinePolicy`** + WORM **`PipelinePolicyChange`** + enum **`PipelinePolicyScope`** (nullable toggles `autoSummary`/`autoNer`/`harness`/**`dnaStyleEnabled`**, role-guarded WORM `REVOKE`, SYSTEM-default `INSERT … ON CONFLICT DO NOTHING` with `harnessEnabled=false`); no `Department`/`UserProfile`/`Consultation` column changes. New generalized **`ConfigResolver`** (doctor→dept→tenant→SYSTEM→code-default + trace; `harnessEnabled` capped at tenant+dept; fail-open to defaults) + **`PipelinePolicyService`** (OCC + WORM). `consultation-event.handler.resolvePipelineConfig()` rewired to the cascade (per-consultation `metadata.pipelineConfig` retained as top overlay); **preferred-prompt threading now on ALL paths** — processor + harness assemble added (sync REST pre-existing TASK-329) → **§2.5 corrected**. New `PipelinePolicyAdminController` (`admin/harness/pipeline-policy`, GET/GET row/PUT row + OCC) + dedicated **`PipelinePolicy` CASL subject**. `14-pipeline-policy.ts` seed (SYSTEM default + **demo-tenant `harnessEnabled=true`** row preserving the clinical-workspace demo) + CASL grants in `01-policy.ts`; UI hard-coded `harnessEnabled` removed (server-resolved). **`dnaStyleEnabled` column created + read only — Phase 6 writes/applies it.** **Phase 3 not regressed** — SMR `resolveSmrSelection`/422 seam left untouched (optional SMR fold-in **skipped**, §8D.5). Verified: DB seed **323**, domains build + **11** PipelinePolicy, applications build + **25** (resolver/policy) + **1049** (consultation, no regression), api build + **13** (admin controller), `migrate diff` in-sync, lints clean. No cloud enabled (gated on TASK-357); Phase 6 outstanding. | `…/README.md`, `packages/database/src/prisma/db_main/{pipeline-policy.prisma (new),enums.prisma,migrations/20260615120000_task_356_phase5_pipeline_policy/migration.sql (new),seed/14-pipeline-policy.ts (new),seed/index.ts,seed/01-policy.ts}`, `packages/database/src/__tests__/seed.test.ts`, `packages/domains/src/{enums,entities,factories,mappers,models,repositories}/generated/**` (PipelinePolicy[Change] + `PipelinePolicyScope` + barrels + `core.database.module.ts`), `packages/applications/src/services/{config-resolver/**(new),pipeline-policy/**(new),consultation/events/consultation-event.handler.ts,consultation/jobs/processors/summary.processor.ts,consultation/jobs/consultation-job.service.module.ts,consultation/harness/harness-internal.service.ts,consultation/harness/harness-internal.service.module.ts,index.ts}` (+ test suites), `apps/api/src/modules/pipeline-policy-admin/**` (new) + `apps/api/src/app.module.ts`, `apps/ui-playground/src/features/clinical-workspace/{components/launch-panel.tsx,constants.ts}` |
| 2026-06-15 | **Phase 6 (Doctor self-service + DNA edit-capture) implemented & verified (TDD) — ticket now Phases 1–6 implemented.** **NO new schema** (`migrate diff` in-sync) — AI-draft `v1` snapshot + edit/sign deltas reuse `ContextItemVersion` (`changeReason='ai_draft_v1'` + existing `contentDiff`/`fieldChanges`); per-doctor DNA toggle reuses Phase-5 `PipelinePolicy.dnaStyleEnabled`. **(S1/S2)** `PromptManagementService.updatePersonal`/`deletePersonal` (strict caller-ownership) + `setPreferredPromptTemplate` (writes `UserProfile.preferredPromptTemplateId` via `IUserProfileService`; `null` clears); `PromptTemplateResponse`+mapper expose `scope`; `UpdateUserProfileRequest.preferredPromptTemplateId` → `string\|null`. **(S3)** `ConfigResolver.resolveEffectiveDnaStyleEnabled` = **tenant AND doctor**; `PipelinePolicyService.getDnaSettings`/`setDnaStyleForDoctor` (OCC + WORM `PipelinePolicyChange`); `DnaWritingStyleService.getDnaSettings`/`setDnaEnabled` (delegate + tenant-ctx validation + `ResourceUpdated`). **(S4/S5)** `v1` snapshot at sync `summary.service.generateSummary` + harness `harness-internal.persistDraft`; new `content-diff.util.ts` populates `contentDiff`/`fieldChanges` on `updateSummary`+`approveSummary`. **(S6)** DNA processor ingests `ai_draft_v1`↔approved **pairs** (legacy final-only fallback) + effective-flag gating — **BATCH** (no synchronous on-sign enqueue; `callSmrV2` transport unchanged). **(API)** end-user `prompt-template.controller` personal CRUD (OCC) + `PUT /preferred`, `dna-writing-style.controller` `GET/PUT /settings` (`['read','PromptTemplate']` + service-enforced ownership) + module wiring. **(UI)** new `features/prompts/**` "My Prompts" CRUD + preferred + route + sidebar; per-doctor DNA `Switch` (`DnaSettingsCard`, disabled when tenant-off); reusable read-only `DraftFinalDiffViewer`. **Deviation:** consultation `version-detail-panel` draft↔signed wiring deferred (SDK-coupled, TASK-355 territory) — reusable viewer drops in later; pre-existing out-of-scope `ui-playground` `vite build`/`tsc` RED (committed `clinical-workspace`/`admin` consumers import `useArcaAudio`/`CaptureMode`/`TranscriptionMode` missing from `@arcaai/vox` barrel) — evidenced via full vitest + lints + Phase-6 type-check instead. **Phase 3/5 not regressed.** Verified: `migrate diff` in-sync; applications **5222** unit (617 targeted); api **1808** (123 targeted); ui-playground **1345** vitest (11 prompts); lints clean. No cloud enabled (gated on TASK-357). | `…/README.md`, `packages/applications/src/services/consultation/summary/{content-diff.util.ts (new),summary.service.ts}` (+ edit-capture/util tests), `consultation/harness/harness-internal.service.ts`, `config-resolver/config-resolver.service.ts`, `pipeline-policy/pipeline-policy.service.ts`, `dna-writing-style/{dna-writing-style.processor.ts,dna-writing-style.service.ts,IDnaWritingStyleService.ts,dna-writing-style.service.module.ts,dto/**(2 new)}`, `prompt-management/{prompt-management.service.ts,IPromptManagementService.ts,prompt-management.service.module.ts,prompt-management.dto.mapper.ts,dto/**(2 new + scope)}`, `user/userProfile/dto/updateUserProfile.request.ts` (+ test suites), `apps/api/src/modules/{prompt-management/prompt-template.controller.ts,dna-writing-style/dna-writing-style.controller.ts}` (+ tests), `apps/ui-playground/src/{features/prompts/**(new),routes/_authenticated/prompts.tsx (new),features/dna-writing-style/{components/dna-settings-card.tsx (new),index.tsx,api/dna-writing-styles.ts},components/layout/app-sidebar.tsx,routeTree.gen.ts (generated)}` |
| 2026-06-15 | **Docs reconciliation (audit follow-up; docs only — no code changed).** Corrected the **committed/git status**: Phases 1–6 are committed on `fix/2605-review` across `f154ce04` + `f58788d2` (TASK-355 base `04cb3b8b`) — added a **Commit status** header row + an **Open follow-ups** row. **Folded the former standalone TASK-360 into this ticket as Phase 4 Hotfix H-1 (new §8F)** — barrel root cause (`core.ts:386–391` omits `CaptureMode`/`TranscriptionMode`; `useArcaAudio` value not surfaced; consumers import from `@arcaai/vox`), git-confirmed Phase-4 attribution (`git log -S` pickaxe → only `f154ce04`), acceptance criteria + DRAFT fix plan; **TASK-360 folder deleted, number retired (not reused)**. **Spun off two follow-up tickets:** **TASK-361** (STT default points at a non-resolving placeholder artifact tagged `production`/`recommended` — High) and **TASK-362** (preferred-prompt threading missing on `pre-summary`/`comprehensive-summary` — Medium). Fixed the **"ALL paths" overstatement** (§2.5, §8D intro, §8D.1, §8D.5) — preferred-prompt threading is on the primary paths only (`pre-summary`/`comprehensive-summary` tracked as TASK-362). Re-attributed the **§8E.5 `ui-playground` build break** from "pre-existing/out-of-scope" to a **TASK-356 Phase 4 regression** tracked as §8F/H-1. Updated the **TASK-357 gate** wording (header + §8/§8B/§8C/§8D/§8E intros): the PHI-egress-guard gate is now **satisfied (TASK-357 Completed)**; seeded defaults remain local-only so no cloud provider is active by default. _(Note: the §8E.5 BQ-6 reference to the consultation `version-detail-panel.tsx` was **left as-is** — that file exists at `apps/ui-playground/src/features/consultation/components/version-detail-panel.tsx` and is distinct from the shared `version-diff-panel.tsx`; see the report flag.)_ | `…/README.md`, `docs/implementation/TASK-361-STT-Default-Placeholder-Artifact/README.md` (new), `docs/implementation/TASK-362-Preferred-Prompt-Threading-Completeness/README.md` (new), `docs/implementation/TASK-360-Vox-SDK-Barrel-Export-Gaps/` (deleted) |
