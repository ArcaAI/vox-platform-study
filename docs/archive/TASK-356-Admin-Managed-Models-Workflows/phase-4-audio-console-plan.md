# TASK-356 — Phase 4: Audio Workflow Console (Pillar A) — Implementation Plan

| | |
|---|---|
| **Ticket** | TASK-356 |
| **Phase** | Phase 4 — Audio workflow console (Pillar A) |
| **Status** | Plan — awaiting approval |
| **Date** | 2026-06-14 |
| **Type** | feature (admin platform + configuration) |
| **Parent** | `docs/implementation/TASK-356-Admin-Managed-Models-Workflows/README.md` (§5 Phase 4; design §4.5, §2.5, §2.6, §4.2, §4.9; gaps G-6/G-7/G-8/G-9; decisions D-6/D-8) |

> This is the **Phase-3 plan-gate artifact** for Phase 4. **No code has been written.** It is grounded in live code (file:line cited throughout). It STOPS here for user approval before any code is written. The TDD layer order (`DB → Domain → Applications → API → UI → SDK`) follows `.cursor/rules/01-development-workflow.mdc`.

---

## 1. Scope & decisions applied

### 1.1 In scope (Pillar A — audio console)

Re-home the currently **runtime-inert** `TenantFrontendConfig` so it actually drives the runtime, covering four gaps:

- **G-7 / D-8 — Transcription mode + lock.** Add a tenant-scoped default transcription mode (`LOCAL | BACKEND`) plus a `transcriptionModeLocked` flag. The SDK + clinical workspace read the **effective mode = tenant default**, overridable by `UserPreferences.workflowMode` **only when unlocked**. Wire the clinical workspace (today hard-wired BACKEND) to honor `LOCAL`.
- **G-6 / G-8 — Feature toggles + diarization-in-form.** Make `diarization`/`vad`/`noiseCancel`/`voiceEnrollment` actually drive the resolved pipeline, and expose the **diarization block in the backend pipeline editor FORM** (already parsed/validated by the YAML parser; only editable via the YAML tab today).
- **G-9 — Capture mode.** Add a tenant-scoped `CaptureMode { RAW_AND_PROCESSED | RAW_ONLY | PROCESSED_ONLY | NONE }` enum + a **translation layer** mapping it onto the two backend pipeline-YAML `dual_capture` booleans and the local `captureRawAudio` flag.
- **Buckets.** Reuse `TenantStorageConfig` (provider/topology/credentials + default `AUDIO` bucket). **Keep a single `AUDIO` bucket** (raw/processed by key prefix). The optional later `AUDIO_RAW`/`AUDIO_PROCESSED` split is **explicitly out of scope**.

### 1.2 Decisions applied

- **D-6** — "Workflows" = two pillars; this plan is Pillar A only (audio). No step-level reordering of the deterministic harness body.
- **D-8** — Transcription local/backend = **tenant default + lock**; doctor overrides only when unlocked; clinical workspace honors the resolved mode.
- **Residual sub-decision (§7 README)** — keep a single tenant `AUDIO` bucket (raw/processed by key prefix); `AUDIO_RAW`/`AUDIO_PROCESSED` split deferred.

### 1.3 Out of scope (other phases / pillars)

Phase 1 catalog plane (`admin/ai-models`), Phase 2 default-model wiring (CT2-int8 STT, medgemma SMR), Phase 3 SMR gateway refactor, Phase 5 realtime cascade (Pillar B), Phase 6 doctor self-service + DNA edit-capture. The `AUDIO_RAW`/`AUDIO_PROCESSED` bucket-purpose split. Any harness/SMR code.

---

## 2. Current state (grounded in live code)

### 2.1 `TenantFrontendConfig` — what is stored vs what reaches the runtime

**Schema** (`packages/database/src/prisma/db_main/tenant.prisma:37-72`): one row per tenant (`tenantId @unique`), columns `asrModel`, `noiseCancel`, `vad`, `voiceEnrollment`, `diarization` (all `Boolean @default(false)`), `captureRawAudio Boolean @default(false)` (TASK-332), and a typed `configJson Json?`.

- **Admin write surface** is complete: controller `PUT/GET admin/tenant-frontend-config` (`apps/api/src/modules/tenant-frontend-config/tenant-frontend-config-admin.controller.ts:36-69`, gated `@CanAny(['manage','Tenant'],['update','Tenant'])` at `:25`), service `TenantFrontendConfigService` (`packages/applications/src/services/tenant-frontend-config/tenant-frontend-config.service.ts`), DTO `UpsertTenantFrontendConfigRequest` (`.../dto/upsert-tenant-frontend-config.request.ts:14-62`), and admin UI tab `apps/ui-playground/src/features/admin/audio-pipelines/frontend-pipeline-tab.tsx` (ASR model + four switches + advanced `configJson`).
- **What actually reaches the runtime: ONLY `captureRawAudio`.** It is surfaced as a synthetic, read-only `enable-local-raw-capture` config row appended in `GET /tenant/me/config` (`apps/api/src/modules/tenant/my-tenant.controller.ts:62-75` + `buildLocalRawCaptureRow` `:150-172`), computed server-side as `platformCapability AND tenantToggle` by `TenantFrontendConfigService.resolveEffectiveLocalRawCapture` (`tenant-frontend-config.service.ts:65-69`). The SDK maps that row into `resolvedConfig.audio.captureRawAudio` (admin-owned, `ConfigSchema.ts:108`).
- **`asrModel`, `vad`, `noiseCancel`, `voiceEnrollment`, `diarization` are INERT** — never read by the SDK runtime. The admin form `frontend-pipeline-tab.tsx` writes them, but nothing on the runtime side consumes them (confirmed: no SDK/`use-realtime-transcription` reference resolves these columns; the SDK reads per-user `UserPreferences.localConfig` instead — see §2.3).

### 2.2 Local-vs-backend transcription decision (today)

- **SDK pipeline** decides provider in `TranscriptionPipeline.resolveSTTRuntimeProvider()` (`packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts:584-601`) from `config.stt.provider` (`local|backend|auto`) then `config.stt.location` then presence of `sttSocket`.
- That `stt` config is built by `PluginManager.getTranscriptionPipelineConfig()` (`packages/agentic-sdk-v2/src/core/PluginManager.ts:532-603`): `location` is derived from `sttConfig.provider` at `:589`, and `provider` from `sttConfig.provider ?? DEFAULT_STT_CONFIG.provider` at `:590`.
- **The per-user choice** is `UserPreferences.workflowMode` (`'local' | 'remote'`, `packages/agentic-sdk-v2/src/types/config.ts:320,466,490`). `useArcaAudio.startFromPreferences()` reads it (`packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:293-313`): `isRemote = prefs.workflowMode === 'remote'` → forwards `remoteConfig.pipelineId`; local leaves `pipelineId` undefined. Server stores it as a `UserSettings` row (`packages/applications/src/services/user/userPreferences/userPreferences.service.ts:117-119,181-187`).
- **The clinical workspace is hard-wired to BACKEND.** `apps/ui-playground/src/features/clinical-workspace/components/capture-panel.tsx` always uses `useRealtimeTranscription()` (`:50`), which **requires a `pipelineId`** and opens an STT WebSocket (`apps/ui-playground/src/hooks/use-realtime-transcription.ts:45-57,144-170,335-336`). The panel resolves `resolvedPipelineId = pipelineId ?? resolvedConfig?.stt?.transcriptionPipelineId` (`capture-panel.tsx:65`) and **blocks Start when none resolves** (`:96-99`). There is no `LOCAL` branch — `workflowMode` is never consulted here.
- **Effective remote pipeline cascade** already exists server-side: `UserPreferencesService.resolveRemoteConfig()` (`userPreferences.service.ts:263-315`) resolves per-user admin override → tenant default `AsrPipeline.isDefault` → `GlobalSetting default-stt-pipeline`, surfaced as `remoteConfig.pipelineId`. The SDK injects that into `resolvedConfig.stt.transcriptionPipelineId` in `AgenticProvider` (`packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx:559-561` on mount, `:769-792` on user switch). `stt.transcriptionPipelineId` is admin-owned (`ConfigSchema.ts:51,116`).

> **This `remoteConfig` resolver is the precedent for where the effective transcription mode + lock should be resolved** (see §6).

### 2.3 Diarization in the backend pipeline (today)

- **Parsed + validated** by the STT YAML parser: top-level `diarization` block → `DiarizationConfig` (`apps/stt/src/stt/pipeline/dto.py:465-486`, parsed `yaml_parser.py:114-116,610-621`, validated `yaml_parser.py:363-389`, recognised top-level key `yaml_parser.py:49-59`). Fields: `enabled`, `high_threshold`, `low_threshold`, `max_speakers`, `min_segment_duration_s`, etc.
- **NOT exposed in the structured admin form.** `apps/ui-playground/src/features/admin/audio-pipelines/pipeline-config-editor.tsx` `VisualForm` (`:246-633`) renders General/Models/Preprocessing/Inference/Postprocessing only; the `PipelineConfig` interface (`:21-67`) and `DEFAULT_CONFIG` (`:81-103`) have **no `diarization` key**. Admins can only edit diarization via the raw YAML tab (`:730-750`).
- **Voice enrollment is per-doctor** (`UserVoiceProfile`, not part of this plan's tenant config).

### 2.4 Dual-capture mechanisms (today)

- **Backend (per-pipeline YAML):** two booleans — `preprocessing.dual_capture.capture_raw` and `postprocessing.dual_capture.capture_processed` (`apps/stt/src/stt/pipeline/dto.py:488-512,561-569`; parsed `yaml_parser.py:473-477,588-592`). Together they express all four capture modes, but **only per-pipeline**. The structured editor already exposes both booleans (`pipeline-config-editor.tsx:41-44,62-65,483-501,610-628`).
- **Local (frontend):** the `captureRawAudio` boolean path (TASK-332): tenant column → synthetic `enable-local-raw-capture` row → `resolvedConfig.audio.captureRawAudio`. In the SDK consultation path, raw capture additionally requires `dualCaptureEnabled` and `workflowMode !== 'remote'` (`useArcaAudio.ts:234-255`). In the clinical workspace, `capture-panel.tsx` runs `useDualCapture` unconditionally once streaming (`:51,84-87`), recording raw+processed locally and persisting on stop (`:109-124`).
- **There is no tenant-level "capture mode" enum** — only the per-pipeline booleans + the local boolean.

### 2.5 Storage / buckets (today)

- `TenantStorageConfig` (`packages/database/src/prisma/db_main/tenant-bucket.prisma:108-162`) carries provider/topology/credentials + per-bucket override + tenant-default row.
- `TenantBucketPurpose` (`packages/database/src/prisma/db_main/enums.prisma:177-184`) = `AUDIO | ATTACHMENTS | MISC | CUSTOM`. **Raw and processed share the single `AUDIO` bucket** (object-key prefixes differ). No raw-vs-processed purpose exists. **This plan keeps it that way** (residual sub-decision); no schema change to buckets.

### 2.6 Admin UI pattern + gating

- The Audio Pipelines page (`apps/ui-playground/src/features/admin/audio-pipelines/index.tsx`) is two tabs — Frontend Pipeline (`frontend-pipeline-tab.tsx`) and Backend Pipelines (`backend-pipelines-tab.tsx`).
- Tenant scoping: header ScopeSwitcher (store `tenantId`); global-scope admin with no tenant shows a "Select a tenant" prompt and fires no request (`frontend-pipeline-tab.tsx:84-98`, `backend-pipelines-tab.tsx:94,260-271`).
- Route guard: `apps/ui-playground/src/routes/_authenticated/admin/audio-pipelines.tsx` uses the `admin-route-guard` (`RequireAdmin`/`RequireGlobalScope` patterns, `apps/ui-playground/src/components/admin-route-guard.tsx`). Admin writes ride `adminClient` (JWT + `X-Tenant-Id` + `If-Match`).

### 2.7 ResourceType / domain-generated artifacts

- `ResourceType.TenantFrontendConfig = 'TenantFrontendConfig'` (`packages/domains/src/enums/generated/ResourceType.ts:39`).
- Generated domain artifacts: `TenantFrontendConfigModel`, `…Entity`, `…Factory`, `…EntityMapper`, `…Repository` under `packages/domains/src/{models,entities,factories,mappers,repositories}/generated/core/`. SDK mirror types in `packages/agentic-sdk-v2/src/types/frontend-pipeline-config.ts` + hook `…/src/hooks/useTenantFrontendConfig.ts`.

---

## 3. Naming decision — `TenantFrontendConfig` vs `TenantAudioConfig` (recommendation)

**Recommendation: KEEP the `TenantFrontendConfig` model name and ADD columns.** Rationale:

- A rename touches the Prisma model + a non-trivial migration `ALTER TABLE … RENAME`, the `ResourceType` enum (`ResourceType.ts:39`), ~6 generated domain files, the application service/DTOs/mapper, the API controller route token, the SDK type `TenantFrontendConfig`, the SDK hook, and every test referencing the symbol (the Grep in §investigation found ~25 references). That is a large, **non-additive** rename with churn unrelated to the four gaps.
- The Prisma migration best-practices skill requires **additive, non-destructive** changes; a table rename is neither.
- Per the Karpathy "surgical changes" rule, every changed line should trace to the request. The request is "make the columns drive the runtime," which is achieved by adding columns + wiring — not by renaming.

So this plan treats the rename as **optional / out of scope** and flags it as a non-blocking question (§13). Everything below assumes the model name stays `TenantFrontendConfig`. (If the user wants the rename, it becomes a separate prep task before Phase 4.)

---

## 4. File-by-file change plan (strict layer order: DB → Domain → Applications → API → UI → SDK)

> Legend: **(N)** new file, **(M)** modified file. Each entry names the change and the covering test.

### 4.1 Database — `packages/database`

| # | File | N/M | Change | Test |
|---|------|-----|--------|------|
| D1 | `src/prisma/db_main/enums.prisma` | M | Add `enum TranscriptionMode { LOCAL BACKEND @@schema("core") }` and `enum CaptureMode { RAW_AND_PROCESSED RAW_ONLY PROCESSED_ONLY NONE @@schema("core") }`. | Migration SQL review (gate) |
| D2 | `src/prisma/db_main/tenant.prisma` | M | On `TenantFrontendConfig` (after `captureRawAudio`): add `transcriptionMode TranscriptionMode @default(BACKEND)`, `transcriptionModeLocked Boolean @default(false)`, `captureMode CaptureMode?` (**nullable**, no default — null = "no tenant override; inherit current per-surface behavior"; see R-6 in §11). | Migration SQL review (gate) |
| D3 | `src/prisma/db_main/migrations/<ts>_task_356_tenant_audio_config/migration.sql` | N | Generated via `prisma migrate dev --create-only --name task_356_tenant_audio_config`. Must contain only `CREATE TYPE core."TranscriptionMode"`, `CREATE TYPE core."CaptureMode"`, and `ALTER TABLE core."TenantFrontendConfig" ADD COLUMN …` (3 columns, additive, defaults as above). **No DROP/RENAME/ALTER of existing columns.** Review SQL before apply. | Migration SQL review (gate) |

Defaults chosen to preserve current behavior (R-6): `transcriptionMode = BACKEND` matches the hard-wired clinical workspace; `transcriptionModeLocked = false` lets the doctor `workflowMode` override stand; `captureMode` nullable so existing tenants keep today's per-pipeline / per-surface capture behavior until an admin explicitly sets a mode.

Then: `pnpm db:generate` to regenerate the Prisma client (the engine-gate command).

### 4.2 Domain — `packages/domains`

These mirror the schema. Follow `.cursor/rules/02-database-prisma.mdc` "After Schema Changes — Required Downstream Work".

| # | File | N/M | Change | Test |
|---|------|-----|--------|------|
| Dom1 | `src/enums/generated/TranscriptionMode.ts` | N | `export enum TranscriptionMode { LOCAL='LOCAL', BACKEND='BACKEND' }`. | covered by Dom6 factory test |
| Dom2 | `src/enums/generated/CaptureMode.ts` | N | `export enum CaptureMode { RAW_AND_PROCESSED, RAW_ONLY, PROCESSED_ONLY, NONE }` (string-valued). | covered by Dom6 factory test |
| Dom3 | `src/enums/generated/index.ts` | M | Barrel-export the two new enums. | build |
| Dom4 | `src/models/generated/core/TenantFrontendConfigModel.ts` | M | Add `transcriptionMode`, `transcriptionModeLocked`, `captureMode` (`CaptureMode \| null`). | build |
| Dom5 | `src/entities/generated/core/TenantFrontendConfigEntity.ts` | M | Add the 3 props + getters/setters, mirroring existing `diarization`/`captureRawAudio`. | `__tests__/TenantFrontendConfigEntity.test.ts` (Dom-T1) |
| Dom6 | `src/factories/generated/core/TenantFrontendConfigFactory.ts` | M | Accept the 3 fields in `CreateTenantFrontendConfig({...})` with defaults (`transcriptionMode=BACKEND`, `transcriptionModeLocked=false`, `captureMode=null`). | `__tests__/TenantFrontendConfigFactory.test.ts` (Dom-T2) |
| Dom7 | `src/mappers/generated/core/TenantFrontendConfigEntityMapper.ts` | M | Map the 3 fields DB↔entity (both directions). | `__tests__/TenantFrontendConfigEntityMapper.test.ts` (Dom-T3) |
| Dom8 | `src/repositories/generated/core/TenantFrontendConfigRepository.ts` | M (likely none) | Generic repo; no change unless a typed `select` enumerates columns. Verify after regen. | build |

### 4.3 Applications — `packages/applications`

| # | File | N/M | Change | Test |
|---|------|-----|--------|------|
| A1 | `src/services/tenant-frontend-config/dto/upsert-tenant-frontend-config.request.ts` | M | Add optional `transcriptionMode?: TranscriptionMode` (`@IsEnum`), `transcriptionModeLocked?: boolean` (`@IsBoolean`), `captureMode?: CaptureMode \| null` (`@IsEnum`, `@IsOptional`). | A-T1 (DTO validation) |
| A2 | `src/services/tenant-frontend-config/dto/tenant-frontend-config.response.ts` | M | Add the 3 fields (`@Expose()`/`@ApiProperty()`). | A-T2 (mapper) |
| A3 | `src/services/tenant-frontend-config/tenant-frontend-config.dto.mapper.ts` | M | Map the 3 fields entity→response. | A-T2 |
| A4 | `src/services/tenant-frontend-config/tenant-frontend-config.service.ts` | M | `createNew` (`:97-111`) + `applyUpdate` (`:113-131`) handle the 3 fields; add them to the `broadcastSysEvent` payload (`:82-92`). | A-T3 (service create/update + events) |
| A5 | `src/services/tenant-frontend-config/capture-mode.translation.ts` | N | Pure functions: `captureModeToDualCapture(mode): { captureRaw, captureProcessed }` and `captureModeToLocalRawCapture(mode): boolean`. Mapping: `RAW_AND_PROCESSED→{T,T}`, `RAW_ONLY→{T,F}`, `PROCESSED_ONLY→{F,T}`, `NONE→{F,F}`; local raw = `captureRaw`. `null` mode → `null` (no override). | A-T4 (table-driven translation) |
| A6 | `src/services/tenant-frontend-config/index.ts` | M | Barrel-export the translation helper. | build |
| A7 | `src/services/tenant-frontend-config/tenant-frontend-config.service.ts` (`resolveEffectiveLocalRawCapture` `:65-69`) | M | Derive the local raw flag from `captureMode` via A5 when set; **fall back to the legacy `captureRawAudio` column when `captureMode` is null** (back-compat). Keep `platformCapability AND …` short-circuit. | A-T5 |
| A8 | `src/services/user/userPreferences/userPreferences.service.ts` | M | Inject `TenantFrontendConfigRepository`. In `getPreferences()` (`:99-174`) compute and attach `transcriptionMode` (**effective**) + `transcriptionModeLocked`: read tenant config; if `transcriptionModeLocked` → effective = tenant `transcriptionMode`; else effective = (`workflowMode==='local'`→LOCAL, `'remote'`→BACKEND) **falling back to** tenant `transcriptionMode` when the user has no `workflowMode`. New private `resolveEffectiveTranscriptionMode(userId)` mirroring `resolveRemoteConfig` (`:263-315`). | A-T6 (precedence matrix) |
| A9 | `src/services/user/userPreferences/dto/user-preferences.response.ts` | M | Add read-only `transcriptionMode: 'LOCAL'\|'BACKEND'` + `transcriptionModeLocked: boolean`. | A-T6 |
| A10 | `src/services/user/userPreferences/userPreferences.service.module.ts` | M | Register `TenantFrontendConfigRepository` (or its `CoreDatabaseModule` provider) so A8's injection resolves. | build |

> **Service stays the resolver of record** (server-authoritative, consistent with AC-4 & the safety posture). The lock is enforced in A8's resolver — a locked tenant ignores the user's `workflowMode`. We do **not** block the `workflowMode` write (the doctor may still set a preference that simply has no effect while locked), matching how `remoteConfig` is resolved read-side.

### 4.4 API — `apps/api`

| # | File | N/M | Change | Test |
|---|------|-----|--------|------|
| API1 | `src/modules/tenant-frontend-config/tenant-frontend-config-admin.controller.ts` | M (none to signature) | No signature change — `UpsertTenantFrontendConfigRequest` (A1) already carries the new fields; gating unchanged. Add Swagger note only. | API-T1 (controller unit) |
| API2 | `src/modules/tenant/my-tenant.controller.ts` | M (verify) | `GET /tenant/me/config` already surfaces the effective local raw flag via `resolveEffectiveLocalRawCapture` (`:67`); now backed by `captureMode` (A7). No new synthetic row needed for transcription mode — that rides the UserPreferences response (A8/A9), read by the SDK at mount. Confirm no double-source. | API-T2 (existing my-tenant test extended) |

### 4.5 UI — `apps/ui-playground`

| # | File | N/M | Change | Test |
|---|------|-----|--------|------|
| UI1 | `src/features/admin/audio-pipelines/frontend-pipeline-tab.tsx` | M | Add to `FormState`/`EMPTY_FORM` (`:48-66`): `transcriptionMode`, `transcriptionModeLocked`, `captureMode`. Add a "Transcription mode" `Select` (LOCAL/BACKEND) + a "Lock mode (doctors cannot override)" `Switch`, and a "Audio capture mode" `Select` (4 options). Hydrate from `config` (`:105-119`) and include in the `save` payload (`:130-152`). | UI-T1 (extends `__tests__/frontend-pipeline-tab.test.tsx`) |
| UI2 | `src/features/admin/audio-pipelines/pipeline-config-editor.tsx` | M | Add `diarization` to the `PipelineConfig` interface (`:21-67`), `DEFAULT_CONFIG` (`:81-103`: `{ enabled:false, max_speakers:2, high_threshold:0.7, low_threshold:0.4 }`), and a **Diarization section** in `VisualForm` (after Postprocessing) with a `ToggleRow` for `enabled` and gated numeric `FieldRow`s for `max_speakers`/thresholds, all via `onFieldChange(['diarization', …])`. Reuses the existing form→YAML round-trip (`handleFieldChange`/`configToYaml` `:682-692`); **no YAML semantics change** — the STT parser already reads `diarization` (§2.3). | UI-T2 (form↔YAML round-trip incl. diarization) |
| UI3 | `src/features/clinical-workspace/components/capture-panel.tsx` | M | Branch on the resolved transcription mode. Read effective mode from the SDK resolved config (UI4: `resolvedConfig.stt.transcriptionMode`). When `BACKEND` → existing `useRealtimeTranscription` path (unchanged). When `LOCAL` → drive the SDK **local** transcription pipeline (via `useArca`/`useArcaAudio` + the local `TranscriptionPipeline`) so capture runs browser-side with no `pipelineId` requirement. Keep dual-capture + `startRecording`/`stopRecording` wiring. **This file only — see §12 overlap boundaries.** | UI-T3 (extends `components/__tests__/capture-panel.test.tsx`: LOCAL vs BACKEND branch) |

> **UI3 is the highest-risk change** (a real behavior change in the clinical capture lane). It stays strictly in the transcription/recording path. See §12 for the exact files NOT touched.

### 4.6 SDK — `packages/agentic-sdk-v2`

| # | File | N/M | Change | Test |
|---|------|-----|--------|------|
| SDK1 | `src/core/ConfigSchema.ts` | M | Add `transcriptionMode: v.optional(v.picklist(['LOCAL','BACKEND']))` to `SttConfigSchema` (`:39-52`) and a `CONFIG_PERMISSIONS['stt.transcriptionMode'] = { permission:'admin', … }` entry (`:110-116`) so the user cascade cannot flip it. | SDK-T1 (extends `core/__tests__/ConfigSchema.test.ts`) |
| SDK2 | `src/providers/AgenticProvider.tsx` | M | Inject the resolved effective mode into `tenantOverrides.stt.transcriptionMode` alongside the existing `transcriptionPipelineId` injection (`:559-561` mount; `:769-792` user switch), reading it from `personalizationManager.getPreferences().transcriptionMode` (added by A8/A9). | SDK-T2 (extends `AgenticProvider.remotePipeline.task334.test.ts`) |
| SDK3 | `src/types/config.ts` | M | Add `transcriptionMode?: 'LOCAL'\|'BACKEND'` + `transcriptionModeLocked?: boolean` to `UserPreferences` (`:464-483`) (read-only; NOT in `UserPreferencesUpdate`). Export `TranscriptionMode`/`CaptureMode` TS unions if needed by hooks. | SDK-T3 |
| SDK4 | `src/types/frontend-pipeline-config.ts` | M | Add `transcriptionMode`, `transcriptionModeLocked`, `captureMode` to `TenantFrontendConfig` + `UpsertTenantFrontendConfigInput` (`:31-74`). | SDK-T4 |
| SDK5 | `src/hooks/useTenantFrontendConfig.ts` | M | Pass the 3 new fields through GET/save. | SDK-T5 (extends `hooks/__tests__/useTenantFrontendConfig.test.ts`) |

> `useArcaAudio.startFromPreferences` (`useArcaAudio.ts:293-313`) already honors `workflowMode`; no change required there for the SDK-only path. The clinical-workspace LOCAL wiring lives in UI3.

---

## 5. Additive schema plan

**New enums** (in `enums.prisma`, both `@@schema("core")`):

```prisma
enum TranscriptionMode {
  LOCAL
  BACKEND
  @@schema("core")
}

enum CaptureMode {
  RAW_AND_PROCESSED
  RAW_ONLY
  PROCESSED_ONLY
  NONE
  @@schema("core")
}
```

**New columns** on `TenantFrontendConfig` (additive; placed after `captureRawAudio`):

```prisma
transcriptionMode       TranscriptionMode @default(BACKEND)
transcriptionModeLocked Boolean           @default(false)
captureMode             CaptureMode?      // nullable: null = inherit current behavior
```

**Migration shape** (`task_356_tenant_audio_config`): only `CREATE TYPE` (×2) + `ALTER TABLE … ADD COLUMN` (×3) with the defaults above. Non-destructive, reversible by a forward migration dropping the additions if needed. Generated with `prisma migrate dev --create-only`, SQL reviewed before apply (Prisma migration best-practices skill).

**Domain regeneration steps** (after migrate + `pnpm db:generate`): hand-update the 6 generated `TenantFrontendConfig*` files (§4.2) — the repo's generators are regenerated from the Prisma client/schema; verify the generated output includes the 3 fields and the 2 new enums, then update barrels. Update `ResourceType`? **No** — the resource type stays `TenantFrontendConfig` (no rename).

---

## 6. Effective-mode + lock resolution design

**Precedence (read-side, server-authoritative):**

```
effectiveTranscriptionMode(user, tenant):
  tenantCfg = TenantFrontendConfig(tenant)            # transcriptionMode, transcriptionModeLocked
  if tenantCfg.transcriptionModeLocked:               # locked → tenant wins, user ignored
      return tenantCfg.transcriptionMode
  if user.workflowMode is set:                        # unlocked → doctor may override
      return user.workflowMode == 'local' ? LOCAL : BACKEND
  return tenantCfg.transcriptionMode                  # fallback to tenant default
```

**Where it is resolved — recommendation: server-side, in `UserPreferencesService.getPreferences()`** (A8), mirroring the existing `resolveRemoteConfig()` cascade (`userPreferences.service.ts:263-315`). Output `transcriptionMode` (the **effective** value) + `transcriptionModeLocked` on the `GET /user/me/preferences` response. Rationale:

- The server is already the resolver of record for the closely-related `remoteConfig.pipelineId`; co-locating keeps one cascade.
- It keeps the lock authoritative on the server (cannot be bypassed by a tampered client), consistent with AC-4/AC-7.
- The SDK then merely **surfaces** it: `AgenticProvider` injects it into `resolvedConfig.stt.transcriptionMode` (SDK2), an admin-owned field (SDK1) so the user cascade can't flip it — exactly the pattern already used for `transcriptionPipelineId`.

**How the clinical workspace switches to LOCAL (UI3):**

- `capture-panel.tsx` reads `resolvedConfig.stt.transcriptionMode` (via `useArcaConfig`, already imported `:52`).
- `BACKEND` (default) → unchanged `useRealtimeTranscription` WS path (still requires `resolvedPipelineId`; still blocks Start when none — `:96-99`).
- `LOCAL` → start the SDK browser pipeline (`useArca`/`useArcaAudio` → `PluginManager`/`TranscriptionPipeline`), which needs **no `pipelineId`** (`resolveSTTRuntimeProvider` returns `'local'` when provider/location say so — `TranscriptionPipeline.ts:584-601`). The lock means: when locked LOCAL, the panel uses the local path regardless of the doctor's `workflowMode`; when locked BACKEND, the WS path; when unlocked, the doctor's `workflowMode` chooses.

> This makes the effective mode a single resolved value the panel branches on, instead of two independent code paths drifting. The lock is enforced server-side (A8) and re-asserted by the admin-permission on `stt.transcriptionMode` (SDK1).

---

## 7. CaptureMode → pipeline-YAML / local translation layer

**Single mapping** (A5, pure + table-driven), reused everywhere capture is resolved:

| `CaptureMode` | backend `preprocessing.dual_capture.capture_raw` | backend `postprocessing.dual_capture.capture_processed` | local `captureRawAudio` |
|---|---|---|---|
| `RAW_AND_PROCESSED` | true | true | true |
| `RAW_ONLY` | true | false | true |
| `PROCESSED_ONLY` | false | true | false |
| `NONE` | false | false | false |
| `null` (unset) | — (no override) | — (no override) | — (legacy `captureRawAudio` column) |

- **Local path:** `TenantFrontendConfigService.resolveEffectiveLocalRawCapture` (A7) derives the local raw flag from `captureMode` via this table, still gated by the platform capability `enable-local-raw-capture` (`AND`). When `captureMode` is null, it falls back to the legacy `captureRawAudio` column — **back-compat** for tenants configured under TASK-332.
- **Backend path (non-destructive):** the translation does **not** rewrite stored pipeline YAML. The two `dual_capture` booleans remain the per-pipeline source of truth (`dto.py:488-512,561-569`). The tenant `captureMode` is the **tenant-level intent**; applying it to a session's resolved pipeline (overlaying the booleans at resolution time) is the consumption point. For Phase 4 we expose `captureMode` at tenant scope + the translation helper + the local wiring; **overlaying onto the backend session pipeline at runtime is documented as the consumption hook** and kept additive (the booleans still win per-pipeline if an admin set them explicitly). This avoids a destructive YAML rewrite and respects R-6.
- The structured editor already exposes both backend booleans (`pipeline-config-editor.tsx:483-501,610-628`), so admins retain per-pipeline control; the tenant `captureMode` is the convenience default + the local-path driver.

---

## 8. Diarization-in-the-form design

- **Reuse the existing parser/validator — no YAML semantics change.** STT already parses + validates the top-level `diarization` block (`yaml_parser.py:114-116,363-389,610-621`; `dto.py:465-486`). The editor's form↔YAML bridge (`pipeline-config-editor.tsx`) round-trips arbitrary keys via `deepMerge` (`:151-175`) and `configToYaml` (`:177-179`), so adding a `diarization` section to the structured `PipelineConfig` + `VisualForm` simply makes existing YAML keys editable in the form.
- **Form fields (subset, the admin-meaningful ones):** `diarization.enabled` (ToggleRow), and when enabled: `diarization.max_speakers` (numeric), `diarization.high_threshold` / `diarization.low_threshold` (numeric 0–1). These map 1:1 to `DiarizationConfig` fields and are already validated server-side (`yaml_parser.py:363-389`, e.g. `low < high`, ranges).
- **Default in `DEFAULT_CONFIG`:** `diarization: { enabled: false, max_speakers: 2, high_threshold: 0.7, low_threshold: 0.4 }` — matches `DiarizationConfig` defaults (`dto.py:469-475`) so a freshly-created pipeline's form↔YAML is stable.
- **Tenant `diarization` toggle (G-6):** the `TenantFrontendConfig.diarization` boolean is the tenant default for the **local** pipeline (it flows into the SDK local `stt.diarization` via the resolved config); the **backend** pipeline's diarization stays governed by the pipeline YAML block now editable in the form. The two are deliberately distinct surfaces (tenant default vs per-pipeline), documented to avoid confusion.

---

## 9. TDD test list (RED-first), per layer

Write each test first, watch it fail for the right reason, then implement (per `01-development-workflow.mdc` TDD mandate). Test names are concrete.

### Domain (`packages/domains/src/**/__tests__/`, Vitest)
- **Dom-T1** `entities/.../__tests__/TenantFrontendConfigEntity.test.ts` — "round-trips transcriptionMode / transcriptionModeLocked / captureMode via getters/setters".
- **Dom-T2** `factories/.../__tests__/TenantFrontendConfigFactory.test.ts` — "defaults transcriptionMode=BACKEND, locked=false, captureMode=null when omitted" + "accepts provided values".
- **Dom-T3** `mappers/.../__tests__/TenantFrontendConfigEntityMapper.test.ts` — "maps the 3 new fields DB↔entity in both directions, captureMode null-safe".

### Applications (`packages/applications/src/**/__tests__/`, Vitest)
- **A-T1** `tenant-frontend-config/__tests__/upsert-tenant-frontend-config.request.test.ts` — "rejects invalid transcriptionMode/captureMode enum values; accepts valid + omitted".
- **A-T2** `tenant-frontend-config/__tests__/tenant-frontend-config.dto.mapper.test.ts` — "response includes the 3 new fields".
- **A-T3** `tenant-frontend-config/__tests__/tenant-frontend-config.service.test.ts` — "create persists new fields", "update mutates only supplied fields", "broadcastSysEvent payload carries the new fields".
- **A-T4** `tenant-frontend-config/__tests__/capture-mode.translation.test.ts` — table-driven: all 4 modes → correct `{captureRaw,captureProcessed}` + local flag; `null` → no override.
- **A-T5** `tenant-frontend-config/__tests__/tenant-frontend-config.service.test.ts` (same file) — "resolveEffectiveLocalRawCapture derives from captureMode when set; falls back to captureRawAudio when null; returns false when platform capability off".
- **A-T6** `user/userPreferences/__tests__/userPreferences.service.test.ts` — precedence matrix: "locked → tenant mode regardless of workflowMode", "unlocked + workflowMode=local → LOCAL", "unlocked + workflowMode=remote → BACKEND", "unlocked + no workflowMode → tenant default"; response exposes `transcriptionMode` + `transcriptionModeLocked`.

### API (`apps/api/src/**/__tests__/`, Vitest)
- **API-T1** `modules/tenant-frontend-config/__tests__/tenant-frontend-config-admin.controller.test.ts` — "PUT round-trips new fields through the service" (DTO carries them; gating unchanged).
- **API-T2** `modules/tenant/__tests__/my-tenant.controller.test.ts` — "GET /tenant/me/config raw-capture row reflects captureMode-derived value" (extends existing test).

### UI (`apps/ui-playground/src/**/__tests__/`, Vitest + Testing Library)
- **UI-T1** `features/admin/audio-pipelines/__tests__/frontend-pipeline-tab.test.tsx` — "renders transcription-mode select + lock switch + capture-mode select; hydrates from config; includes them in save payload".
- **UI-T2** `features/admin/audio-pipelines/__tests__/pipeline-config-editor.test.tsx` (new or extend `audio-pipelines-page.test.tsx`) — "diarization section toggles + edits round-trip form→YAML→form without dropping other keys".
- **UI-T3** `features/clinical-workspace/components/__tests__/capture-panel.test.tsx` — "BACKEND mode uses useRealtimeTranscription and still blocks Start without a pipeline", "LOCAL mode uses the SDK local pipeline and does NOT require a pipelineId".

### SDK (`packages/agentic-sdk-v2/src/**/__tests__/`, Vitest)
- **SDK-T1** `core/__tests__/ConfigSchema.test.ts` — "stt.transcriptionMode parses LOCAL/BACKEND; permission is admin; user cannot edit it".
- **SDK-T2** `providers/__tests__/AgenticProvider.transcriptionMode.test.ts` — "injects resolved transcriptionMode into resolvedConfig.stt.transcriptionMode on mount and after user switch".
- **SDK-T3/T4/T5** type + hook tests — `useTenantFrontendConfig.test.ts` round-trips new fields; type-level coverage for the new `UserPreferences`/`TenantFrontendConfig` fields.

---

## 10. Verification criteria (layer-gates table — `01-development-workflow.mdc`)

| Layer | Build | Test |
|---|---|---|
| Database | `pnpm db:migrate` + `pnpm db:generate`; review generated SQL (additive only) | Migration SQL reviewed (no DROP/RENAME) |
| Domain | `pnpm build --filter @arcaai/domains` | `pnpm test:unit --filter @arcaai/domains` (Dom-T1..T3 green) |
| Applications | `pnpm build --filter @arcaai/applications` | `pnpm test:unit --filter @arcaai/applications` (A-T1..T6 green) |
| API | `pnpm build:api` | `pnpm test` (API-T1..T2) and `pnpm test:e2e` smoke for the config routes |
| UI / SDK | `pnpm build --filter @arcaai/vox` + ui-playground build | Vitest for UI-T1..T3 + SDK-T1..T5 |

Final gate: `ReadLints` on every modified file (no new lint errors), barrels updated (Dom3, A6), module registration (A10), and this plan's parent `README.md` updated with a Phase 4 Implementation Summary **after** code lands (not now).

---

## 11. Risks

- **R-6 (the headline risk) — Inert-surface migration / back-compat.** Wiring `TenantFrontendConfig` into the runtime changes behavior for tenants that set values expecting no effect:
  - *Transcription mode:* default `BACKEND` + lock `false` preserves the current hard-wired BACKEND clinical workspace; a doctor's existing `workflowMode` continues to apply (unlocked). No behavior change on day one.
  - *Capture mode:* **`captureMode` is nullable with no default** precisely so existing tenants keep today's per-pipeline / per-surface capture behavior; behavior only changes when an admin explicitly picks a mode. The backend translation is an additive overlay (does not rewrite YAML). The local-path `resolveEffectiveLocalRawCapture` falls back to the legacy `captureRawAudio` column when `captureMode` is null.
  - *Feature toggles (vad/noiseCancel/voiceEnrollment/diarization):* these existing booleans default `false`; once wired they change behavior **only** for tenants that had set them `true`. Mitigation: document in the Phase 4 summary; consider a one-line release note; the wiring reads them as defaults (lowest cascade tier) so per-user/per-pipeline settings still win.
- **R-UI3 — clinical capture-lane behavior change.** Adding a LOCAL branch to `capture-panel.tsx` is the only behavioral change in a PHI-sensitive lane. Mitigation: keep BACKEND path byte-identical; gate LOCAL strictly on the resolved mode; cover both branches in UI-T3; touch no review-surface files (§12).
- **R-rename — symbol churn if renamed.** Avoided by keeping `TenantFrontendConfig` (§3). If the user insists on `TenantAudioConfig`, do it as a separate non-additive prep migration first.
- **R-dual-source capture.** Two capture concepts now coexist (`captureRawAudio` legacy boolean vs `captureMode` enum). Mitigation: the translation helper is the single mapping; `captureMode=null` → legacy fallback; documented as the migration path (a later cleanup can backfill `captureMode` from `captureRawAudio`).
- **R-migration safety.** Per user rules + Prisma skill: migration is ADD-only; no `DROP`/`DELETE`/`TRUNCATE`. SQL reviewed before apply.

---

## 12. Overlap boundaries (CRITICAL)

**This plan touches NONE of:** `apps/harness/**`, `apps/smr/**`, the harness sensors, `summary.service.ts`, or `harness-internal.service.ts` (TASK-355/357/358/359). The only Python file referenced (`apps/stt/.../yaml_parser.py`, `dto.py`) is **read-only context** — the diarization/dual_capture parsing is reused unchanged; **no STT code change** is in this plan.

**Within `apps/ui-playground/src/features/clinical-workspace/**`:**

- **WILL touch (transcription/recording path only):** `components/capture-panel.tsx` (UI3 — add the LOCAL/BACKEND branch).
- **WILL NOT touch (TASK-355 review surface):** `components/review-panel.tsx`, `components/review/review-screen.tsx`, `hooks/use-harness-assurance.ts`, `lib/harness-assurance.ts`, and the **assurance bits of** `api/clinical-workspace.api.ts`. UI3 uses only the existing `startRecording`/`stopRecording` exports from `clinical-workspace.api.ts` (recording, not assurance) and does **not** modify that file.
- **WILL NOT touch:** `components/cockpit.tsx`, `components/launch-panel.tsx`, `components/live-summary-panel.tsx`, the `review/**` subtree, `hooks/use-dual-capture.ts` (reused as-is), `hooks/use-live-summary-stream.ts`, `lib/flow.ts`, `lib/live-summary.ts`, `lib/draft-polling.ts`, `lib/highlight-anchoring.ts`, `lib/artifacts.ts`.

The shared hook `apps/ui-playground/src/hooks/use-realtime-transcription.ts` stays **backend-only and unmodified** — the LOCAL path is added in `capture-panel.tsx` via the SDK, not by overloading this hook.

**No hard blocker or unavoidable overlap was found.** The clinical-workspace change is cleanly isolatable to `capture-panel.tsx` + the recording path; the review surface is untouched.

---

## 13. Questions for the user (genuinely blocking decisions only)

1. **Model rename — `TenantFrontendConfig` → `TenantAudioConfig`?** Recommendation: **keep `TenantFrontendConfig`** and add columns (additive, surgical; §3). Confirm, or request the rename as a separate prep task (non-additive, larger churn). *(Blocking only because it changes every file path below.)*
2. **Effective-mode resolver location — server vs SDK?** Recommendation: **server-side** in `UserPreferencesService.getPreferences()` (mirrors the existing `remoteConfig` cascade; lock stays authoritative server-side), surfaced via the UserPreferences response and re-projected into `resolvedConfig.stt.transcriptionMode` by the SDK (§6). Confirm, or request SDK-side resolution.

If both recommendations are accepted as-is, there are **no remaining blockers** and Phase 4 can proceed to RED tests on approval.

---

## 14. Change history

| Date | Change | Files |
|---|---|---|
| 2026-06-14 | Phase 4 (Audio workflow console, Pillar A) file-level TDD plan created (no code changes). | `docs/implementation/TASK-356-Admin-Managed-Models-Workflows/phase-4-audio-console-plan.md` |




