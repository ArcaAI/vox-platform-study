# TASK-332 — Audio Dual-Capture: Local (Raw Stream Capture)

| | |
|---|---|
| **Ticket** | TASK-332 |
| **Track** | A — Local (in-house TS/SDK/UI) |
| **Parent** | TASK-331 doc-06 (F2 — clinical playground dual capture) |
| **Created** | 2026-06-05 |
| **Updated** | 2026-06-05 |
| **Status** | Pending (plan — awaiting approval) |

> Sibling ticket: **TASK-333 — Audio Dual-Capture: Remote (per-pipeline)**. The two run in parallel.

---

## 1. Requirement Analysis

### Description
When the active audio pipeline is **LOCAL** (client-side WASM processing in `@arcaai/vox`), optionally capture the **RAW microphone stream**, upload it to backend storage, and attach it as an `AUDIO_RECORDING` context item on the consultation. "Processed" output for the local path is the transcription — **not** a second audio artifact — so this captures a **single raw blob** (no `DualStreamRecorder`).

### Control model (two-level gate)
- **Developer capability (platform):** a `locked` `GlobalSetting` owned by `SYSTEM_TENANT_ID` enables the feature to *exist*. Only SUPER_ADMIN can change it. Default **OFF**.
- **Tenant-admin toggle:** a per-tenant switch on `TenantFrontendConfig` turns it **ON for all users** in the tenant.
- **Effective enablement = `platformCapability AND tenantToggle`, computed server-side.** The client reads **one** resolved boolean — it never ANDs two flags or learns about the dev gate.

### Business context
Gives an auditable raw recording for local-processing workflows without shipping a half-built affordance (the TASK-331 doc-06 F2 "misleading affordance" risk). Reuses the SDK's existing admin-locked config rail.

### Acceptance criteria
- [ ] Platform capability flag exists, is `locked` (only SUPER_ADMIN can write), defaults OFF.
- [ ] Tenant admin can toggle `captureRawAudio` per tenant; honored only when the platform capability is ON.
- [ ] `GET /tenant/me/config` returns a single resolved boolean for local raw capture.
- [ ] SDK exposes the typed flag in `resolvedConfig.audio` as an **admin-locked path** (not user-overridable).
- [ ] Consultation recording panel reads the typed flag (no dead cast); when ON + local pipeline, the raw mic blob is uploaded and attached as a context item; when OFF, no raw capture.
- [ ] All gates green (tests/build/lint); migration is additive.

---

## 2. Current State Evaluation

| Area | Finding | Evidence |
|---|---|---|
| SDK audio schema | `AudioConfigSchema` is fully typed (Valibot); **no** `captureRawAudio`/`dualCapture` field, so `v.parse()` strips it → `resolvedConfig.audio.dualCapture` is **always `undefined`** | `packages/agentic-sdk-v2/src/core/ConfigSchema.ts` |
| Admin-locked rail | `ConfigManager` 4-tier cascade (system←tenant←dept←user) + `CONFIG_PERMISSIONS` + `stripLockedAndAdminPaths` already enforces "admin sets, user can't override" | `core/ConfigManager.ts`, `core/ConfigSchema.ts` |
| Dead UI read | Panel reads the flag via an unsafe cast → **always false**; `DualStreamRecorder` is started unconditionally and only the RAW upload is gated | `apps/ui-playground/.../consultation-recording-panel.tsx:46,69` |
| Tenant local config home | `TenantFrontendConfig` (per-tenant, tenant-admin writable) already holds `noiseCancel/vad/voiceEnrollment/diarization`; **no** `captureRawAudio` | `packages/database/src/prisma/db_main/tenant.prisma:37-68`; `TenantFrontendConfigService.upsert`; `PUT /api/v1/admin/tenant-frontend-config` |
| Dev-gate precedent | `GlobalSetting.locked` exists but is **unenforced** (`// TODO`); `AppSettingsService` cache is keyed by `key` only (not tenant-scoped) → the platform capability must be a single `SYSTEM_TENANT_ID`-scoped row | `globalSetting.service.ts:11`; `appSettings.service.ts:209-231` |
| Config → SDK | `GET /tenant/me/config` → `ModelRegistry.loadTenantConfig` → `AgenticProvider` maps only a **subset** (`stt.defaultModel`, `features`) into `tenantOverrides`; audio fields are not mapped | `AgenticProvider.tsx:~526-545` |

### Impact areas
SDK config schema/provider; backend tenant-config resolver + `TenantFrontendConfig` + `GlobalSetting` service; admin UI; consultation recording panel + recording hook.

---

## 3. Implementation Plan (TDD — RED → GREEN → REFACTOR)

**Layer order:** DB → Domain → Service/endpoint → SDK schema/provider → UI.

### T1 — SDK typed flag + remove the dead read
- Add `captureRawAudio: v.optional(v.boolean(), false)` to `AudioConfigSchema` (`ConfigSchema.ts`).
- Add a `CONFIG_PERMISSIONS` entry for `audio.captureRawAudio` with `permission: 'admin'` so user prefs can't override it (`stripLockedAndAdminPaths` enforces).
- Replace `consultation-recording-panel.tsx:46` cast with `resolvedConfig?.audio?.captureRawAudio === true`.
- **TDD:** ConfigManager test — tenant sets `audio.captureRawAudio=true`; a user-pref override attempt is stripped; resolved stays `true`. Schema test — defaults `false`. UI test — panel reads the typed flag.
- **Files:** `core/ConfigSchema.ts`, `core/ConfigManager.ts` (if perms table lives there), `consultation-recording-panel.tsx` + tests.

### T2 — Control-plane (DB + backend + admin UI)
- **DB (additive migration):** `TenantFrontendConfig.captureRawAudio Boolean @default(false)` — `tenant.prisma`. `ADD COLUMN` only, no destructive ops.
- **Domain/Service:** thread `captureRawAudio` through the `TenantFrontendConfig` entity/factory/DTO + `TenantFrontendConfigService.upsert`; response includes it.
- **Platform capability:** seed a `GlobalSetting` row — `tenantId=SYSTEM_TENANT_ID`, namespace `feature-flags` (platform-owned), key `enable-local-raw-capture`, `dataType=Boolean`, `locked=true`, `value='false'` (`seed/11-global-setting.ts` platform section).
- **Enforce `locked`:** implement the `GlobalSettingService` write-guard (`globalSetting.service.ts:11` TODO) — reject writes to `locked` rows unless requester is SUPER_ADMIN.
- **Server-computed effective boolean:** in the resolver feeding `GET /tenant/me/config`, compute `effective = platformCapability(GlobalSetting) && tenant.captureRawAudio(TenantFrontendConfig)` and surface as `audio.captureRawAudio` in the `TenantAudioConfig` payload.
- **SDK provider mapping:** `AgenticProvider` maps `tenantCfg.audio.captureRawAudio → tenantOverrides.audio.captureRawAudio` (`~526-545`); ensure it lands on the admin-locked path.
- **Admin UI:** add a structured "Capture raw audio (local)" toggle to the tenant-frontend-config admin surface; disabled with a hint when the platform capability is OFF.
- **TDD:** AND-composition (4 combinations); `locked` guard rejects TENANT_ADMIN, allows SUPER_ADMIN; tenant-config endpoint returns the effective boolean; provider mapping; admin hook update.

### T3 — Capture path (SDK/UI)
- Expose the **raw mic track** from the in-consultation recording hook — minimal option: add `getRawInputTrack()` exposure to `useRealtimeTranscription`; alternative: converge the panel onto `useArcaAudio`.
- On record stop, when effective `captureRawAudio` && local pipeline: record the **raw mic blob with a single `MediaRecorder`** (not `DualStreamRecorder`), `storage.uploadFile('attachments', blob)` → key, then attach as an `AUDIO_RECORDING` context item (`addContextItem`/`useAudioRecordings.add`). Transcription flow unchanged.
- Replace the current unconditional `DualStreamRecorder` (same-track) usage on the local path to avoid the raw==processed artifact.
- **TDD:** flag ON + local → stop uploads raw + creates context item (mock storage + add); flag OFF → no raw capture; remote path unaffected.

### Testing strategy
- SDK: vitest (`ConfigManager`/schema/hook). Backend: vitest (`TenantFrontendConfigService`, `GlobalSettingService` locked guard, tenant-config resolver). UI: vitest+RTL (panel). All: per-package build + lint.

### Verification criteria
- Effective boolean correct for all 4 combinations (capability on/off × tenant on/off).
- `locked` write-guard enforced.
- Panel reads the typed flag; raw capture only when effective ON + local.
- Migration additive; full gate green.

---

## 4. Implementation Summary
_To be completed during implementation._

## 5. Change History
| Date | Change | Files / Commits |
|---|---|---|
| 2026-06-05 | Plan authored (parallel Track A of TASK-331 doc-06 F2 follow-up) | — |

---

### Cross-cutting (shared with TASK-333)
- The additive `SummaryMeta` prompt-tier migration from TASK-331 doc-06 (`20260603175719_add_summary_meta_prompt_tier`) is merged but **unapplied** — apply on the next deploy.
