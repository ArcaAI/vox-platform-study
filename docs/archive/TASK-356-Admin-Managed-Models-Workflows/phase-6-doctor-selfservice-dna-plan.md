# TASK-356 Phase 6 — Doctor Self-Service + DNA Edit-Capture (Plan)

|  |  |
|---|---|
| **Ticket** | TASK-356 |
| **Phase** | 6 of 6 — Doctor self-service + DNA edit-capture |
| **Status** | **Plan — awaiting approval** |
| **Date** | 2026-06-15 |
| **Author** | Planning agent (read-only; no code written) |
| **Depends on** | Phase 5 (doctor-preferred prompt threading/resolution — *being planned in parallel: `phase-5-realtime-cascade-plan.md`*), Phase 3 (SMR call-path refactor — *being planned in parallel: `phase-3-smr-gateway-refactor-plan.md`*), TASK-355 (Harness latency / optimistic delivery — **Completed, committed `04cb3b8b`**) |
| **Scope discipline** | This is the **only** file this task creates. No code, no other doc edits, no migration run, no `git commit`. |

---

## 1. Purpose

Close the two remaining doctor-facing gaps in TASK-356 (README §6, §4.7):

1. **Doctor self-service** — give a doctor first-class, *own-scoped* routes + UI to (a) author/manage **personal** prompt templates and (b) choose their **preferred** template, plus (c) a **per-doctor DNA on/off toggle**. Today the service logic for personal prompts exists but is **not routed to doctors** (`PromptManagementService.createPersonal` `prompt-management.service.ts:193` is reachable only behind the admin controller), the preferred-template field is set only on the **admin** user surface, and DNA on/off is a **tenant-only** flag with no per-doctor override (README G-11, G-15).
2. **DNA edit-capture (README D-10)** — capture the **AI draft `v1` snapshot at generation**, capture the **draft→approved delta on edit/sign**, and feed **draft↔approved pairs** into the DNA writing-style processor so it learns the doctor's *edit behaviour*, not just their final prose. Today the DNA processor learns only from **approved final text** (`dna-writing-style.processor.ts:105-137`); the AI draft is never snapshotted and the delta is never stored.

This phase is **additive and opt-in**: with the tenant DNA flag off and no doctor opting in, behaviour is byte-identical to today.

---

## 2. Scope & decisions

### 2.1 In scope

| # | Deliverable | README anchor |
|---|---|---|
| S1 | Doctor-facing **personal prompt** routes (create / update / delete own) on the end-user controller | §4.7, G-11 |
| S2 | Doctor-facing **"set my preferred template"** self-service route (writes `UserProfile.preferredPromptTemplateId` for the **caller**) | §4.6/§4.7 |
| S3 | **Per-doctor DNA toggle** (storage + read/write route + effective-flag semantics under the tenant flag) | §4.2, G-15 |
| S4 | **AI-draft `v1` snapshot at generation** (capture a versioned snapshot of the AI draft at the generation boundary) | §4.7, D-10 |
| S5 | **Delta capture on edit/sign** (populate `contentDiff` + `fieldChanges` on the edit/sign version rows) | §4.7, D-10 |
| S6 | **DNA processor ingests draft↔approved pairs** (corpus builder + processor payload change; SMR transport untouched) | §4.4, §4.7, D-10 |
| S7 | **Doctor UI**: "My Prompts" page (personal CRUD + preferred picker) + DNA on/off switch on the existing DNA page | §4.7 |

### 2.2 Out of scope (hard boundaries)

- **Doctor-preferred prompt *resolution/threading* in the cascade** → **Phase 5** owns this. Phase 6 only *writes* `UserProfile.preferredPromptTemplateId` (self-service) and *reads it back* for the picker UI. See §11.2.
- **SMR call-path refactor** → **Phase 3** owns the SMR gateway. Phase 6 keeps the existing `callSmrV2` boundary in the DNA processor (`dna-writing-style.processor.ts:152`) stable. See §11.3.
- **Harness gating / latency / PHI egress / sensor calibration** → TASK-355 / 357 / 358 / 359. Do not touch the harness workflow, sensors, or sign-off governance logic.
- **Admin prompt management** (`/admin/prompt-templates`) — unchanged; Phase 1 owns the catalog plane.
- **Changing how the approved final text is produced or signed** — TASK-355 owns `approveSummary` governance; Phase 6 only *appends* (snapshot/delta capture + best-effort DNA-pair availability).

### 2.3 Decisions applied (from README §7) + new phase decisions

| ID | Decision | Source |
|---|---|---|
| D-10 | Full edit-capture: snapshot AI draft, store draft↔approved delta, feed pairs into DNA | README §7 |
| **P6-D1** (proposed) | **Reuse `ContextItemVersion`** for the `v1` snapshot + delta — **no new table/columns** (the columns already exist; see §5). Mark the AI-draft snapshot with `changeReason='ai_draft_v1'`, mirroring the existing `changeReason='approved'` convention the DNA processor already reads (`dna-writing-style.processor.ts:121`). | New — needs sign-off (BQ-1) |
| **P6-D2** (proposed) | **Decouple capture from processing.** Capture the snapshot at generation and the delta at edit/sign (cheap, synchronous, append-only). The DNA processor stays **batch/manual-triggered** (no new latency on the sign path). On-sign we only *ensure the pair exists*, never run SMR inline. | New — needs sign-off (BQ-3) |
| **P6-D3** (proposed) | **Per-doctor DNA toggle stored on `UserProfile`** as `dnaStyleEnabled Boolean?` (first-class, queryable, mirrors `preferredPromptTemplateId`). Alternative = `UserSettings` KV (zero migration). | New — needs sign-off (BQ-4) |
| **P6-D4** (proposed) | **Effective DNA flag = tenant `enable-dna-style` AND per-doctor toggle.** A doctor may opt **out** under an enabled tenant; a doctor **cannot** opt in if the tenant flag is off. | New — needs sign-off (BQ-4) |
| **P6-D5** (proposed) | Doctor personal-prompt routes live on the **end-user** controller (`prompt-template.controller.ts`), authorized `create`/`update`/`delete` on `PromptTemplate` **scoped to `USER_PERSONAL` owned by the caller** (the service already enforces ownership via `assertCanMutate` `prompt-management.service.ts:696`). Never `manage` (admin-only). | New — needs sign-off (BQ-5) |

---

## 3. Current state (grounded, `path:line`)

### 3.1 Generation / edit / sign path (TASK-355-owned — see §11.1)

- **`SummaryService.generateSummary`** `packages/applications/src/services/consultation/summary/summary.service.ts:160` — creates the `RAW_SUMMARY` `ContextItem` but **creates no `ContextItemVersion`**. → **No `v1` snapshot exists today** (gap for S4).
- **`SummaryService.updateSummary`** `summary.service.ts:255` — creates a `ContextItemVersion` (~`:278`) capturing the previous content, but passes **`undefined` for `contentDiff` and `fieldChanges`** → **delta never stored** (gap for S5). This method also contains the **TASK-355 Slice 5c** best-effort `signalEdit` harness hook (forwarded only while status is `DRAFT_PENDING_SENSORS`) — a **direct collision surface** (§11.1).
- **`SummaryService.approveSummary`** `summary.service.ts:355` — writes the `SIGNED_NOTE` version, the WORM `ATTEST` audit, and the TASK-355 Phase D governance (`overrideSafetyFlag`, `SIGNED_BEFORE_ASSURANCE`, `SAFETY_OVERRIDE`, `signalApproval`). The existing DNA corpus marker `changeReason='approved'` is written on the approved version here. **TASK-355 territory — append-only coordination required** (§11.1).
- **`SummaryService.resolvePreferredPromptTemplateId`** `summary.service.ts:741` — *reads* `UserProfile.preferredPromptTemplateId` on the synchronous summary path (Phase 5 threading territory).
- **Edit DTO** `…/summary/dto/update-summary.request.ts:4-25` — already carries `content`, `changeReason`, `changeSummary`, and `changeSource` (enum `doctor_edit | ai_regeneration | system`, `:20-24`). **No DTO change is required to capture the delta** — only computation + persistence into the existing version columns.
- **Controller** `apps/api/src/modules/consultation/consultation.controller.ts` — exposes `generateSummary` / `updateSummary` / `approveSummary` behind `verifyConsultationOwnership`; heavily TASK-355-integrated (assurance SSE, override body). Append-only here too.
- **Module wiring** `…/summary/summary.service.module.ts:17-25` — imports `CoreDatabaseModule` (supplies `ContextItemVersionRepository`), `PromptResolutionServiceModule`, `HarnessAuditServiceModule`, `HarnessGatewayServiceModule`. **Does not** import a DNA queue → relevant to the DNA-trigger decision (§4.3, BQ-3).

### 3.2 ContextItemVersion schema — already supports snapshot + delta (key finding)

`packages/database/src/prisma/db_main/consultation.prisma:355-410`:

- `content String? @db.Text` (`:371`) — full snapshot of content at this version.
- `contentDiff String? @db.Text` (`:374`) — "JSON diff or text diff from previous version".
- `changeReason String?` (`:377`), `changeSummary String?` (`:378`), `changedBy String?` (`:379`), `changeSource String?` (`:380`).
- `fieldChanges Json? @db.JsonB` (`:383`) — `{ field: { old, new } }`.
- Indexed on `tenantId`, `contextItemId`, `versionNumber`, `createdAt`, `changedBy`; `@@unique([contextItemId, versionNumber])` (`:408`); `@@schema("core")` (`:409`).

**Conclusion:** the `v1` snapshot and the edit/sign delta need **no new schema** — every required column already exists and is nullable/additive-ready.

- **Factory** `packages/domains/src/factories/generated/core/ContextItemVersionFactory.ts` — `CreateVersion` (`:50`), `CreateFromContextItem` (`:109`), `CreateUserEditVersion` (`:143`) **all already accept `contentDiff` and `fieldChanges`**. No factory regeneration required; a small new convenience method for the `v1` snapshot is optional.
- **Repository** `packages/domains/src/repositories/generated/core/ContextItemVersionRepository.ts` — `getVersionsByChangeReason(contextItemId, changeReason)` (`:60`), `getVersionHistory` (`:22`), `getVersion` (`:32`). The DNA pair fetch reuses `getVersionsByChangeReason(id, 'ai_draft_v1')` + the existing `'approved'` lookup.

### 3.3 DNA writing-style — model, processor, service, scheduler

- **Model** `packages/database/src/prisma/db_main/dna-writing-style.prisma` — `DnaWritingStyleReport` (per-doctor, `isLatest`, `currentVersionNumber`) + `DnaWritingStyleVersion`. **No per-doctor on/off field** (gap for S3).
- **Processor** `packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts:105-137` — corpus = `ContextItem`s of type `RAW_SUMMARY`/`MODIFIED_SUMMARY` that have a version with `changeReason='approved'` (`:121`); it takes the **final approved `item.content`** only. SMR called at `:152` (`callSmrV2`). **The AI draft is never part of the corpus** (gap for S6).
- **Service** `…/dna-writing-style/dna-writing-style.service.ts:79` — `generateDnaReport` enqueues the BullMQ job (manual trigger). No toggle logic.
- **Scheduler** `…/dna-writing-style/dna-regeneration.scheduler.ts` — monthly cron (default **disabled**), re-enqueues for all doctors with a latest report. **No on-sign trigger exists today.**
- **Doctor DNA API** `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts` — `generate` / `getMyStyle` / `getMine` / `update` / `setDefault` / `getVersions` / job status; doctor-scoped via `assertActingAsDoctor()` (`:72`). **No toggle endpoint** (gap for S3).

### 3.4 Prompt management — service has personal logic, routes don't expose it

- **Service** `packages/applications/src/services/prompt-management/prompt-management.service.ts` — `createPersonal(dto)` (`:193`, scope `USER_PERSONAL`), `listAvailableForCaller(...)` (`:443`), ownership guard `assertCanMutate(...)` (`:696`). Interface declares `createPersonal` `…/IPromptManagementService.ts:33`.
- **Admin controller** `apps/api/src/modules/prompt-management/prompt-management.controller.ts` — `/admin/prompt-templates`, `@Authorize(['manage','PromptTemplate'])`. Admin-only; does **not** expose `createPersonal`.
- **End-user controller** `apps/api/src/modules/prompt-management/prompt-template.controller.ts` — `/prompt-templates`, `@Authorize(['read','PromptTemplate'])`, exposes **only** `GET /available` (`:31`). → **No doctor-facing create/update/delete-personal or set-preferred route** (gap for S1, S2).

### 3.5 Per-doctor preferences + tenant DNA flag

- **`UserProfile`** `packages/database/src/prisma/db_main/user.prisma:150` — holds `preferredPromptTemplateId String?` (`:164`). This is the seam field for S2 / Phase 5.
- **`UserSettings`** `user.prisma:113` — generic per-user key/value store (zero-migration candidate for the DNA toggle, BQ-4 alternative).
- **Tenant DNA flag** — `enable-dna-style` is a **tenant `GlobalSetting`** (seeded in `packages/database/src/prisma/db_main/seed/11-global-setting.ts`, namespace `feature-flags`), surfaced to the SDK as `ENABLE_DNA_STYLE` (`packages/agentic-sdk-v2/src/types/config.ts`). **No per-doctor layer** (gap for S3).
- **Phase 5 boundary** `…/consultation/prompt/prompt-resolution.service.ts:16` — explicit comment: *"DNA resolution is no longer part of this service; DNA style is per-doctor and resolved elsewhere"*; Tier-0 preferred read at `:85`. Confirms the resolution cascade is Phase 5's, not Phase 6's.

### 3.6 UI surfaces

- **Doctor DNA page** `apps/ui-playground/src/features/dna-writing-style/index.tsx` (page `:480`, `MyStyleCard` `:401`), route `apps/ui-playground/src/routes/_authenticated/dna-writing-style/index.tsx`, impersonation-gated, uses `./api/dna-writing-styles`. **This is where the per-doctor DNA on/off switch lands** (S7).
- **Doctor prompt UI — does not exist.** There is only an **admin** feature `apps/ui-playground/src/features/admin/prompts/**` (route `…/_authenticated/admin/prompts.tsx`). There is **no** `features/prompts` and **no** `…/_authenticated/prompts.tsx`. → New doctor "My Prompts" feature + route + nav entry (S7).
- **SDK hooks** `packages/agentic-sdk-v2/src/hooks/usePrompts.ts` (+ `types/prompt.ts`) and `…/hooks/useDnaStyle.ts` exist — extension points for the new personal-prompt + toggle calls.
- **Consultation version UI** (optional read-only draft↔final diff surface): `apps/ui-playground/src/features/consultation/components/context-version-list.tsx`, `version-detail-panel.tsx`. The review/sign surface (`clinical-workspace/components/review-panel.tsx`, `review/review-screen.tsx`) is **TASK-355 Slice 6 territory** — avoid (§11.1).

---

## 4. File-by-file change plan (layer order DB → Domain → App → API → UI)

> Order rationale: the only candidate migration (DNA toggle) is tiny and isolated; the edit-capture work is migration-free and concentrates in the application layer.

### 4.0 Layer 0 — DB (Prisma) — **only if BQ-4 chooses the column option**

| File | Change | Notes |
|---|---|---|
| `packages/database/src/prisma/db_main/user.prisma` | Add `dnaStyleEnabled Boolean?` to `UserProfile` (after `preferredPromptTemplateId`, `:164`) | Additive, nullable; `@@schema` unchanged. Follow `02-database-prisma.mdc` field ordering. **Skip entirely if BQ-4 = `UserSettings` KV.** |
| `packages/database/.../migrations/<ts>_task356_p6_dna_toggle/migration.sql` | `ALTER TABLE … ADD COLUMN "dnaStyleEnabled" BOOLEAN;` | Generate via `prisma migrate diff`; purely additive. |

**No migration for S4/S5** — `ContextItemVersion` already has all columns (§3.2). This is the headline divergence from the brief's "will likely need additive schema": **edit-capture is migration-free.**

### 4.1 Layer 1 — Domain (`packages/domains`) — minimal

| File | Change | Notes |
|---|---|---|
| `…/factories/generated/core/ContextItemVersionFactory.ts` | *(Optional)* add `CreateAiDraftSnapshot(...)` convenience that sets `versionNumber=1`, `changeReason='ai_draft_v1'`, `changeSource='ai_model'` | Pure convenience; `CreateFromContextItem` (`:109`) already suffices. No regeneration. |
| `…/repositories/generated/core/ContextItemVersionRepository.ts` | *(Optional)* add `getFirstAiDraft(contextItemId)` thin wrapper over `getVersionsByChangeReason(id,'ai_draft_v1')` | Convenience for the DNA corpus builder. |
| `UserProfile` entity/model/factory/mapper (generated) | **Only if BQ-4 = column**: regenerate (or hand-edit per repo convention) to expose `dnaStyleEnabled` end-to-end | Full DB→entity→model→factory→mapper→repo regen, per the Phase-1 pattern. **None of this if KV option.** |

### 4.2 Layer 2 — Application services (`packages/applications`) — the core of this phase

**S4 — AI-draft `v1` snapshot at generation** (two generation boundaries):

| File | Change | Collision |
|---|---|---|
| `…/consultation/summary/summary.service.ts` `generateSummary` (`:160`) | After creating the `RAW_SUMMARY` `ContextItem`, create a `ContextItemVersion` v1 via the factory with `content=<ai draft>`, `changeReason='ai_draft_v1'`, `changeSource='ai_model'`, `changedBy='system'` | **TASK-355** owns this file — append-only, sequence after `04cb3b8b` (§11.1). |
| `…/consultation/harness/harness-internal.service.ts` `persistDraft(...)` | Capture the same `ai_draft_v1` snapshot when the **harness/optimistic** path persists the early draft (so both generation boundaries snapshot) | **TASK-330/355** territory + **Phase 3** seam — the snapshot sits at the *persist-draft boundary* regardless of which SMR model produced it (§11.3). |

**S5 — Delta capture on edit/sign:**

| File | Change | Collision |
|---|---|---|
| `…/consultation/summary/summary.service.ts` `updateSummary` (`:255`, version create `:278`) | Compute `contentDiff` (unified text diff old→new) + `fieldChanges` (structured per-section JSON) and pass them into the version factory call (today both `undefined`) | **TASK-355 Slice 5c `signalEdit`** lives in this exact method — add delta computation *before* the existing signal, do not reorder it (§11.1). |
| `…/consultation/summary/summary.service.ts` `approveSummary` (`:355`) | On sign, ensure the approved version is delta-stamped vs the prior version (so the *final* draft→approved delta is captured even when the doctor signs without editing) | **TASK-355** owns the sign path — append-only after the existing `ATTEST`/governance writes. |
| `…/common/util/<new> content-diff.util.ts` (new) | Small pure util: `diffContent(old, new) → { contentDiff, fieldChanges }`. No existing diff utility found | Standalone; unit-tested in isolation (RED-first). Pick a tiny, dependency-light diff (BQ-2). |

**S6 — DNA processor ingests draft↔approved pairs:**

| File | Change | Collision |
|---|---|---|
| `…/dna-writing-style/dna-writing-style.processor.ts` (corpus `:105-137`) | Extend the corpus builder: for each approved summary, also fetch the `ai_draft_v1` version (`getVersionsByChangeReason(id,'ai_draft_v1')`) and build **draft↔approved pairs**; pass pairs into the SMR payload (keep `callSmrV2` at `:152` unchanged) | **Phase 3** refactors the SMR transport — change the *corpus/payload*, not the call boundary (§11.3). |
| `…/dna-writing-style/dna-writing-style.processor.ts` (job input) | Add an optional `mode: 'final' | 'pairs'` (or pair-aware payload) so legacy final-only behaviour is preserved when no `v1` snapshot exists (back-compat for old consults) | Back-compat: pre-Phase-6 consults have no `v1` → fall back to final-only. |
| DNA analysis prompt template (seed `category='DNA_ANALYSIS'`, read at processor `:146`) | *(Possibly)* a pairs-aware prompt variant that teaches from `{draft}`→`{approved}` deltas | If template change needed, coordinate with Phase 1 catalog ownership; otherwise reuse existing. |

**S3 — Per-doctor DNA toggle (read/write + effective-flag):**

| File | Change | Notes |
|---|---|---|
| `…/dna-writing-style/dna-writing-style.service.ts` | Add `getDnaEnabled(doctorId)` / `setDnaEnabled(doctorId, enabled)` reading/writing the chosen store (UserProfile column or UserSettings KV) | New methods + `ISummaryService`-style interface entry. |
| `…/dna-writing-style/dna-writing-style.service.ts` (+ wherever DNA style is *applied* at generation) | Effective flag = tenant `enable-dna-style` **AND** per-doctor toggle (P6-D4). Gate both (a) whether DNA style is applied to generation and (b) whether the processor runs for that doctor | The *application* of DNA style at generation may be Phase 5/realtime territory — confirm seam (BQ-4/§11.2). |

**S1/S2 — Doctor personal-prompt + preferred-template service surface:**

| File | Change | Notes |
|---|---|---|
| `…/prompt-management/prompt-management.service.ts` | Reuse `createPersonal` (`:193`); add `updatePersonal(id, dto, caller)` + `deletePersonal(id, caller)` that call `assertCanMutate` (`:696`) for caller-ownership; ensure `listAvailableForCaller` (`:443`) covers the doctor's own personals | Service mostly exists; add the two own-scoped mutators. |
| `…/prompt-management/IPromptManagementService.ts` | Declare the new own-scoped methods | Interface parity. |
| `…/user/user-profile.service.ts` (or equivalent) | Add `setMyPreferredPromptTemplate(callerId, templateId)` writing `UserProfile.preferredPromptTemplateId` for the **caller** (validate the template is available to the caller via `listAvailableForCaller`) | **Phase 5 seam**: Phase 6 *writes*; Phase 5 *reads/threads* (§11.2). |

### 4.3 Layer 3 — API (`apps/api`)

| File | Change | Auth |
|---|---|---|
| `apps/api/src/modules/prompt-management/prompt-template.controller.ts` (end-user) | Add `POST /prompt-templates/personal`, `PATCH /prompt-templates/personal/:id`, `DELETE /prompt-templates/personal/:id`; add `PUT /prompt-templates/preferred` (set caller's preferred) | `@Authorize(['create'|'update'|'delete','PromptTemplate'])` + service-level caller-ownership (`assertCanMutate`). **Never `manage`.** OCC `If-Match` on update/delete per repo convention. |
| `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts` | Add `GET /dna-writing-styles/settings` + `PUT /dna-writing-styles/settings` (per-doctor toggle), guarded by `assertActingAsDoctor()` (`:72`) | Doctor self-scoped only. |
| DTOs (new) | `UpdatePersonalPromptRequest`, `SetPreferredTemplateRequest`, `DnaSettingsRequest/Response` | `@Expose()` + class-validator per backend DTO convention. |
| `apps/api/src/modules/consultation/consultation.controller.ts` | *(Optional, S7)* read-only `GET …/context-items/:id/draft-delta` to surface the v1↔approved diff | Behind `verifyConsultationOwnership`. Append-only; do not touch TASK-355 routes. |

**DNA trigger (BQ-3):** recommended = **no new on-sign SMR run**. If the user wants an on-sign *enqueue* of the DNA job, prefer a **SysEvent listener** on the existing sign event over importing the DNA queue into `SummaryServiceModule` (keeps the TASK-355-owned `approveSummary` clean and avoids new module coupling).

### 4.4 Layer 4 — UI (`apps/ui-playground`)

| File | Change |
|---|---|
| `apps/ui-playground/src/features/dna-writing-style/index.tsx` (near `MyStyleCard` `:401`) | Add a **DNA on/off `Switch`** bound to `GET/PUT /dna-writing-styles/settings`; disable + explain when the **tenant** flag is off (effective-flag UX). |
| `apps/ui-playground/src/features/prompts/**` (**new**) | New "My Prompts" feature: list own personals, create/edit/delete dialogs (mirror `features/admin/prompts` patterns but own-scoped), + a **preferred-template picker** (`PUT /prompt-templates/preferred`). |
| `apps/ui-playground/src/routes/_authenticated/prompts.tsx` (**new**) + nav entry | Mount the doctor "My Prompts" page; add to the authenticated nav. |
| `…/features/prompts/api/*` (new) + *(optional)* `packages/agentic-sdk-v2/src/hooks/usePrompts.ts` | Wire the new endpoints; optionally extend the SDK hook for parity. |
| *(Optional, S7)* `…/features/consultation/components/version-detail-panel.tsx` | Read-only "AI draft vs signed" diff view using the new draft-delta endpoint. **Do not** modify `clinical-workspace/review-*` (TASK-355). |

---

## 5. Schema / migration assessment

| Item | New schema? | Detail |
|---|---|---|
| AI-draft `v1` snapshot (S4) | **No** | New `ContextItemVersion` row, `changeReason='ai_draft_v1'`. All columns exist (`consultation.prisma:371-383`). |
| Edit/sign delta (S5) | **No** | Populate existing `contentDiff` (`:374`) + `fieldChanges` (`:383`). Factory already accepts both. |
| DNA draft↔approved pairs (S6) | **No** | Built at read-time from existing versions via `getVersionsByChangeReason` (`:60/:121`). |
| Per-doctor DNA toggle (S3) | **One nullable column** *or* **none** | BQ-4: `UserProfile.dnaStyleEnabled Boolean?` (additive migration + full domain regen) **vs** `UserSettings` KV row (zero migration). |
| Personal prompt routes (S1/S2) | **No** | `PromptTemplate` + `UserProfile.preferredPromptTemplateId` already exist (`user.prisma:164`). |

**Net:** the maximum migration footprint of this phase is **one nullable boolean column** — far smaller than the brief assumed. If BQ-4 chooses `UserSettings`, the phase is **fully migration-free**. Any column choice follows `02-database-prisma.mdc` (field ordering, `@@schema("core")`/relevant schema, additive-only) and triggers the standard domain regeneration chain.

---

## 6. Propagation / clone-per-tenant

- **No new seedable catalog entity.** The per-doctor DNA toggle and personal prompts are **per-user**, created at runtime — there is no tenant-clone fan-out (unlike Phase 1's catalog rows).
- **Tenant `enable-dna-style`** already seeds per tenant (`seed/11-global-setting.ts`); Phase 6 adds no new global setting. The per-doctor toggle *defaults to unset* → effective flag falls back to the tenant flag (P6-D4), so existing tenants are unaffected.
- **DNA analysis prompt template** (if a pairs-aware variant is needed, §4.2) is a `DNA_ANALYSIS` template — if it must be seeded/cloned per tenant, coordinate with Phase 1 catalog ownership; default is to reuse the existing template (no clone).

---

## 7. Auth & safety posture

- **Doctor routes are strictly own-scoped.** Personal-prompt mutations authorize `create`/`update`/`delete` on `PromptTemplate` **and** enforce caller-ownership in the service (`assertCanMutate` `:696`) — a doctor can never edit another user's or a tenant/department template. Never grant `manage` (admin-only).
- **Preferred-template self-service** validates the chosen template is in the caller's `listAvailableForCaller` set before writing `UserProfile.preferredPromptTemplateId` for the caller only.
- **DNA toggle** is self-scoped via `assertActingAsDoctor()` (`:72`); an admin not impersonating a doctor cannot self-toggle (mirrors the existing DNA-page impersonation guard).
- **Edit-capture is non-destructive & WORM-safe.** The `v1` snapshot and delta are **append-only** `ContextItemVersion` rows; they do not alter the signed note, the `ATTEST` chain, or TASK-355 sign-off governance. Snapshot/delta writes are **best-effort where they touch the TASK-355 sign path** — a snapshot/delta failure must never block or roll back generation/edit/sign (mirror the Slice 5c best-effort `signalEdit` discipline).
- **No PHI egress change.** The DNA processor keeps the existing local `callSmrV2` boundary; pairs are the same already-stored clinical text. PHI-egress enforcement is TASK-357's domain — untouched.
- **DNA opt-out is honoured end-to-end** (generation application + processor corpus) so a doctor who disables DNA is neither styled nor learned-from.

---

## 8. RED-first TDD test list

> Each item: write the failing test first, confirm it fails for the right reason, then implement (per `methodology/test-driven-development`). Suites: Vitest for TS layers.

**Diff util (S5):**
1. `diffContent` returns empty diff for identical content.
2. `diffContent` produces a unified `contentDiff` for a single-line edit.
3. `diffContent` produces `fieldChanges` `{section:{old,new}}` for a changed SOAP section; whole-doc fallback when unparseable.

**Snapshot at generation (S4):**
4. `generateSummary` creates exactly one `ContextItemVersion` with `versionNumber=1`, `changeReason='ai_draft_v1'`, `changeSource='ai_model'`, `content=<draft>`.
5. `generateSummary` snapshot failure does **not** roll back the `RAW_SUMMARY` creation (best-effort).
6. Harness `persistDraft` captures an `ai_draft_v1` snapshot on the optimistic path (and only once).

**Delta capture (S5):**
7. `updateSummary` populates `contentDiff` + `fieldChanges` on the new version (previously `undefined`).
8. `updateSummary` still fires the TASK-355 `signalEdit` exactly as before (regression guard — order preserved, best-effort).
9. `approveSummary` stamps the final draft→approved delta even when the doctor signs without editing.

**DNA pairs (S6):**
10. Corpus builder pairs `ai_draft_v1` with the approved final for a consult that has both.
11. Falls back to final-only for a legacy consult with no `v1` snapshot (back-compat).
12. `callSmrV2` boundary unchanged (payload includes pairs; transport signature untouched).

**Per-doctor DNA toggle (S3):**
13. `getDnaEnabled` default (unset) ⇒ effective flag follows the tenant flag.
14. Doctor opt-out under enabled tenant ⇒ effective `false` (not styled, not learned-from).
15. Doctor cannot opt **in** when tenant flag is off ⇒ effective `false`.

**Doctor prompt routes (S1/S2):**
16. `POST /prompt-templates/personal` creates a `USER_PERSONAL` template owned by the caller.
17. `PATCH/DELETE /prompt-templates/personal/:id` on **another** user's template ⇒ forbidden (ownership).
18. `PUT /prompt-templates/preferred` sets only the caller's `UserProfile.preferredPromptTemplateId`; rejects a template not in `listAvailableForCaller`.
19. End-user controller never exposes `manage`-scoped operations.

**DNA settings route (S3):**
20. `GET/PUT /dna-writing-styles/settings` self-scoped; admin-not-impersonating ⇒ blocked.

**UI (S7):**
21. DNA page renders the on/off switch; disabled + explained when tenant flag off.
22. "My Prompts" page lists/creates/edits/deletes own personals and sets preferred (happy path + ownership error toast).

---

## 9. Verification gates

Per `01-development-workflow.mdc` + `verification-before-completion` (capture actual output as evidence):

- **DB** (only if column option): `pnpm db:migrate` + `pnpm db:generate`; `prisma migrate diff` returns empty (in sync); migration SQL reviewed (additive only).
- **Domain**: `pnpm build --filter @arcaai/domains` + `pnpm test:unit --filter @arcaai/domains` green (only if column regen).
- **Applications**: `pnpm test:unit --filter @arcaai/applications` (summary + DNA + prompt suites green); typecheck + build clean.
- **API**: `pnpm build:api` + controller/route unit tests (new prompt + DNA settings routes); `pnpm test:e2e` for the new doctor routes.
- **UI**: `ui-playground` typecheck (no new errors beyond the known pre-existing admin `jobs`/`queues` index-signature ones) + the new prompts/DNA suites; eslint 0 errors on touched dirs.
- **Regression**: full `@arcaai/applications` unit suite stays green (TASK-355 summary/approve tests must not regress); the Slice-5c `signalEdit` test (#8) and the optimistic-delivery replay fixtures remain green.
- **Lint**: `ReadLints` on every modified file.

---

## 10. Overlap boundaries & coordination map

| File / area | Owner(s) | Phase 6 action | Coordination |
|---|---|---|---|
| `summary.service.ts` `generateSummary` (`:160`) | TASK-355 (committed `04cb3b8b`) | **Append** `v1` snapshot | Sequence after `04cb3b8b`; append-only; best-effort. |
| `summary.service.ts` `updateSummary` (`:255`, Slice 5c `signalEdit`) | TASK-355 | **Add** delta computation **before** the existing signal | Do not reorder/alter `signalEdit`; regression test #8. |
| `summary.service.ts` `approveSummary` (`:355`) | TASK-355 | **Append** final-delta stamp; (optional) DNA-pair availability | Append after `ATTEST`/governance; never block sign. |
| `harness-internal.service.ts` `persistDraft` | TASK-330/355 + **Phase 3** | **Add** snapshot at the harness generation boundary | Snapshot sits at persist-draft boundary regardless of SMR model (Phase 3). |
| `consultation.controller.ts` | TASK-355 | *(Optional)* add read-only draft-delta route | Append-only; do not touch assurance/override routes. |
| `clinical-workspace/review-panel.tsx`, `review/review-screen.tsx` | TASK-355 Slice 6 | **Avoid** | Put any draft↔final diff in `consultation/version-detail-panel.tsx` instead. |
| `prompt-resolution.service.ts` (Tier-0 read `:85`), legacy BullMQ threading | **Phase 5** | **Avoid resolution**; only *write* preferred id + *read* for picker | Shared field `UserProfile.preferredPromptTemplateId` (`:164`): P6 writes, P5 reads/threads. No schema collision. |
| DNA processor `callSmrV2` (`:152`) | **Phase 3** | Change corpus/payload, **not** transport | Keep call boundary stable for Phase 3's SMR-gateway refactor. |
| Harness gating / latency / PHI / sensors | TASK-355/357/358/359 | **Avoid** | No harness workflow/sensor/governance edits. |

**Sequencing recommendation:** Phase 6 can proceed now for S1/S2/S3/S4/S5 (all grounded against committed code). S6's *application of DNA style at generation* and the *legacy-path preferred threading* should be **coordinated with Phase 5** (resolution owner). The harness-boundary snapshot (S4 part 2) should be **coordinated with Phase 3** (SMR call-path owner) but does not block the legacy-path snapshot.

---

## 11. Detailed seam notes

### 11.1 TASK-355 collision (corrected from the brief)

The brief states these files are "**currently** modified by in-flight TASK-355". **Grounded reality:** TASK-355 is **Completed (2026-06-14)** and **committed at HEAD `04cb3b8b`** on branch `fix/2605-review`; `git diff HEAD` shows **no uncommitted changes** on `summary/`, `consultation/`, `dna-writing-style/`, or `prompt-management/`. So the risk is not a live merge race — it is that Phase 6 edits the **exact methods TASK-355 just authored** (`updateSummary` `signalEdit`, `approveSummary` governance, the review UI). Treat as **shared, append-only, sequence-after** code; every Phase 6 touch on the sign path must be best-effort and covered by a TASK-355 regression guard (test #8).

### 11.2 Phase 5 seam (precise line)

- **Phase 6 owns:** the doctor **routes + UI** — the `PUT /prompt-templates/preferred` self-service *write* of `UserProfile.preferredPromptTemplateId`, the personal-prompt CRUD, and the DNA self-service surface.
- **Phase 5 owns:** the *resolution/threading* — reading `preferredPromptTemplateId` into the cascade (Tier-0 already works on the sync path `prompt-resolution.service.ts:85`; Phase 5 adds the **legacy BullMQ-path** threading per README §2.5/§4.6) and the realtime/pipeline application of DNA style.
- **Shared field, no schema collision:** `UserProfile.preferredPromptTemplateId` already exists (`user.prisma:164`). Phase 6 writes it; Phase 5 reads it.

### 11.3 Phase 3 seam

Phase 3 refactors the SMR call path that produces the AI draft (and is named in README §4.4 as also feeding the DNA processor). Phase 6 dependencies:
- The **`v1` snapshot must sit at the generation/persist-draft boundary** regardless of which model SMR resolves — so it survives Phase 3's transport refactor.
- The **DNA processor change is corpus/payload only** (`dna-writing-style.processor.ts:105-137`); the `callSmrV2` boundary (`:152`) stays stable so Phase 3 can swap the transport underneath without re-touching Phase 6 logic.

---

## 12. Risks

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | Snapshot/delta writes added to the TASK-355 sign path destabilise sign-off | Med | Best-effort, append-only, never roll back; regression test #8 + full applications suite gate. |
| R2 | `fieldChanges` format churns later (consumers depend on shape) | Med | Lock the shape in BQ-2 before build; version it in `metaData` if needed. |
| R3 | DNA-pair corpus regresses style quality vs final-only | Med | Keep `mode` switch (final|pairs); A/B the pairs prompt before defaulting on; back-compat fallback (test #11). |
| R4 | Two generation boundaries (legacy `generateSummary` + harness `persistDraft`) double-snapshot or miss one | Med | Idempotent `versionNumber=1` + `@@unique([contextItemId,versionNumber])` (`:408`) guards duplicates; tests #4/#6. |
| R5 | DNA toggle storage choice (column vs KV) reworked later | Low | Decide BQ-4 up front; both are additive and reversible. |
| R6 | Phase 5 planned in parallel ⇒ preferred-id *write* may land before the legacy *read/threading* | Low | Write is harmless without threading (sync path already reads it); flag the dependency, don't block. |
| R7 | New doctor "My Prompts" route/nav diverges from admin prompt UX | Low | Mirror `features/admin/prompts` components; reuse `@arcaai/ui`. |

---

## 13. Blocking questions (please answer before build)

1. **BQ-1 — `v1` snapshot storage.** Reuse `ContextItemVersion` with `changeReason='ai_draft_v1'` (recommended; **no migration**) **or** a dedicated `SummaryDraftSnapshot` table? *Recommendation: reuse — the columns already exist (`consultation.prisma:371-383`) and the DNA processor already keys off `changeReason`.*
2. **BQ-2 — Delta/diff format.** `contentDiff` = unified text diff; `fieldChanges` = `{section:{old,new}}` keyed by SOAP heading with whole-doc fallback — acceptable? Any required consumer (analytics) that constrains the shape? Preferred diff lib (or hand-rolled minimal)?
3. **BQ-3 — DNA processor trigger.** Keep **batch/manual** (recommended; capture-on-sign, process-off-line — no sign-path latency) **or** enqueue on sign? If on-sign, OK to use a **SysEvent listener** (not import the DNA queue into `SummaryServiceModule`) to keep `approveSummary` clean?
4. **BQ-4 — Per-doctor DNA toggle: storage + semantics.** `UserProfile.dnaStyleEnabled Boolean?` (first-class column, one additive migration) **or** `UserSettings` KV (zero migration)? Confirm effective-flag semantics = tenant AND doctor (opt-out allowed, opt-in blocked when tenant off). And: is *applying* DNA style at generation a Phase 6 or Phase 5 responsibility (the toggle write/read is Phase 6 either way)?
5. **BQ-5 — Doctor-route auth scope.** Confirm personal-prompt routes use `create/update/delete` + caller-ownership (not `manage`), on the **end-user** `prompt-template.controller.ts`. Confirm the self-service preferred-template route writes the caller's profile only.
6. **BQ-6 — UI surface scope for this phase.** Minimum: DNA on/off switch + "My Prompts" page (personal CRUD + preferred picker). Is the **read-only draft↔final diff** view (in `consultation/version-detail-panel.tsx`) in or out for Phase 6?
7. **BQ-7 — Sequencing vs Phase 3 / Phase 5.** Phase 5 and Phase 3 are **being planned in parallel** (`phase-5-realtime-cascade-plan.md`, `phase-3-smr-gateway-refactor-plan.md` present but not yet approved). OK to land Phase 6's S1/S2/S3/S4(legacy)/S5 now and **gate** the harness-boundary snapshot (S4 part 2) + DNA-style *application* on Phase 3 / Phase 5 respectively? Confirm the seam ownership above matches their final plans.

---

## 14. Appendix — file inventory + overlap/coordination map

**Read-only (grounding) — no edits:**
- `summary.service.ts:160/255/278/355/741`, `update-summary.request.ts:20-24`, `summary.service.module.ts:17-25`
- `consultation.prisma:355-410` (esp. `371/374/377-383/408`), `ContextItemVersionFactory.ts:50/109/143`, `ContextItemVersionRepository.ts:22/60`
- `dna-writing-style.processor.ts:105-137/146/152`, `dna-writing-style.service.ts:79`, `dna-regeneration.scheduler.ts`, `dna-writing-style.controller.ts:72`, `dna-writing-style.prisma`
- `prompt-management.service.ts:193/443/696`, `IPromptManagementService.ts:33`, `prompt-management.controller.ts`, `prompt-template.controller.ts:31`, `prompt-resolution.service.ts:16/85`
- `user.prisma:113/150/164`, `seed/11-global-setting.ts`, `config.ts` (`ENABLE_DNA_STYLE`)
- `features/dna-writing-style/index.tsx:401/480`, `features/admin/prompts/**`, `routes/_authenticated/{dna-writing-style,admin/prompts}.tsx`, `hooks/usePrompts.ts`, `hooks/useDnaStyle.ts`

**Will edit (Phase 6):**
- **App:** `summary.service.ts` (snapshot+delta, append-only — TASK-355 shared), `harness-internal.service.ts` (`persistDraft` snapshot — Phase 3 seam), `dna-writing-style.processor.ts` (pairs corpus — Phase 3 seam), `dna-writing-style.service.ts` (toggle), `prompt-management.service.ts` (+ interface), user-profile service (preferred write), new `content-diff.util.ts`
- **API:** `prompt-template.controller.ts` (+personal CRUD + preferred), `dna-writing-style.controller.ts` (+settings), new DTOs, (optional) `consultation.controller.ts` (draft-delta read)
- **DB/Domain (only if BQ-4=column):** `user.prisma` + migration + `UserProfile` regen
- **UI:** `features/dna-writing-style/index.tsx` (switch), **new** `features/prompts/**` + `routes/_authenticated/prompts.tsx` + nav, (optional) `consultation/version-detail-panel.tsx`

**Do NOT touch:** `clinical-workspace/review-*` (TASK-355 Slice 6), harness workflow/sensors/governance (TASK-355/357/358/359), `prompt-resolution.service.ts` cascade (Phase 5), `callSmrV2` transport (Phase 3), `/admin/prompt-templates` (Phase 1).
