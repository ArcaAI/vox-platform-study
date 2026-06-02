# TASK-325 — Admin Console Transformation (ui-playground)

| | |
|---|---|
| Ticket Number | TASK-325 |
| Short name | Admin-Console-Transformation |
| Created | 2026-06-02 |
| Updated | 2026-06-02 |
| Status | `Pending` — gap analysis complete; **decisions resolved (§3.6)**; split into per-phase sub-tickets **TASK-326–329** (§3.7). Awaiting go on Phase 0 (**TASK-326**). No code written yet. |
| Type | feature + bugfix (security/tenancy) — large, multi-phase |
| Scope | `apps/ui-playground/` (primary). Backend scope/data gaps in `apps/api/`, `packages/database/`, `packages/domains/`, `packages/applications/`. SDK bindings via `@arcaai/vox` (`packages/agentic-sdk-v2/`). |
| Builds on | TASK-233 (Administration Section — original pages), TASK-244 (Audio-Config), TASK-245 (Admin User Prefs + Impersonation), TASK-295 (Backend Impersonation Security), TASK-296 (Voice-Profile E2E), TASK-299 (Consultation Job SSE + DNA), TASK-301/302 (System-Config multi-tenancy + roadmap), TASK-305/313/314/317 (multi-tenancy / tenant-scope hardening), TASK-307 (API-Gateway hardening), TASK-316 (DB-backed config), TASK-320 (Vox SDK ↔ API AuthZ), TASK-322 (Consultation lifecycle), TASK-323 (UI-Playground Vox/API alignment) |
| Interactive review | `~/.cursor/projects/Users-taphuynh-Desktop-igglo-ARCAAI-hope-v2/canvases/admin-console-review.canvas.tsx` (tabbed gap-analysis canvas) |

> **Method note.** Findings were produced by 5 parallel full-stack exploration agents (UI → API controller/DTO → Prisma model → SDK), then the two **Critical** defects, the sidebar gating, and the design-system component availability were re-verified against source by hand. Items tagged **(verified)** were confirmed at the cited `file:line`; the remainder are agent-cited exploration and should be re-confirmed before the relevant phase. Coverage percentages are reviewer judgment, **not** test coverage.

---

## 1. Requirement Analysis

### 1.1 Description

Transform `apps/ui-playground` (already self-described as "ArcaVox Admin Console React") from the partial admin surface delivered in TASK-233 into a **complete Admin Console + Developer Playground**, split by two admin scopes everywhere:

- **GLOBAL admin** — manages all tenants; must select a tenant before acting on tenant-scoped data; can then operate the tenant-admin interfaces for the selected tenant.
- **TENANT admin** — locked to their own tenant.

Each administration interface is **one menu** (sub-menus allowed). Menus are **re-orderable** by global/tenant admin and persisted as **admin personalized preferences in the database**.

**Administration (9 menus):** (1) Tenant management, (2) User management, (3) Department management, (4) Prompt-template management (versioning, usage stats, quality/score testing, version diff), (5) DNA writing-style dashboards + activity, (6) Audio-processing management (**frontend** + **backend** pipelines; backend stored as YAML in DB), (7) Storage & file management, (8) Audit log, (9) Embedded Prisma Studio.

**Developer playgrounds (6):** (1) Overview + service status + **user impersonation** (global admin selects a tenant first), then — all requiring impersonation and a **realtime code-sample panel that reflects the impersonated user's preferences** — (2) Consultation, (3) Audio & Transcription (local + remote), (4) Voice Profile (local + backend enrollment), (5) DNA writing style, (6) Summarization.

### 1.2 Business context

- The playground is the canonical reference for `@arcaai/vox` consumers **and** the operational console for global/tenant admins. Today it is SUPER_ADMIN-centric: a tenant admin sees only 5 of 11 admin pages and cannot self-serve their tenant.
- **Real security exposure exists** (see §2.6): user/department/audit list endpoints are not tenant-scoped at the controller layer, and the embedded Prisma Studio executes arbitrary queries with no audit trail.
- Clinically important capabilities (in-flow recording, batch-SSE case notes, dept-prompt fallback, chain-of-consultation, RAW+PROCESSED dual capture) and admin capabilities (frontend pipeline config, prompt quality testing, DNA dashboards) are specified but unbuilt.

### 1.3 Acceptance criteria (target end-state)

Administration:
- [ ] A1 Global admin: create/update/**soft-delete** tenants; "manage selected tenant as tenant admin" path. Tenant admin: name, buckets/folders, departments, users + assignments, prompt templates + default-by-department.
- [ ] A2 Per-user (both scopes): profile, personalized settings (frontend + backend audio pipeline prefs), enrolled voice profiles, preferred prompt templates, DNA style + history — **tenant-scoped for tenant admins**.
- [ ] A3 Department management + tenant assignment + user↔department assignments, both scopes.
- [ ] A4 Prompt templates with versioning, usage stats, **quality/score testing**, and **version diff** (content + variables), both scopes.
- [ ] A5 DNA **aggregate dashboards** (tenant-level + by-user activity), both scopes.
- [ ] A6 **Frontend** pipeline config (ASR model, noise-cancel, VAD, voice enrollment, diarization — stored as **typed JSON**, Q5) **and** **backend** pipeline (YAML in DB) per tenant, both scopes.
- [ ] A7 Storage/bucket/folder management incl. delete, access keys, provider config, both scopes.
- [ ] A8 Audit log with date/action/resource filters, responsible-user, before/after drill-down, export — tenant-scoped for tenant admins.
- [ ] A9 Embedded Prisma Studio — **super-admin only** (Q4); every query/sequence audited (no tenant-admin mode).

Playgrounds:
- [ ] P1 Overview + service status; impersonation with **global-admin-selects-tenant-first** gate.
- [ ] P2 Consultation: new/resume (same-day revisit); inject text/file/image/audio (batch transcription + SSE); in-flow recording using impersonated prefs (realtime transcript); summary via preferred dept prompt **with fallback** (recorded as a context item); chain-of-consultation reference; **RAW + PROCESSED** dual capture to buckets.
- [ ] P3 Live transcription: local (multi-model, task selection, user prefs) + remote (tenant pipeline).
- [ ] P4 Voice enrollment: **local** (in-browser) + backend; embeddings on user profile + frontend cache; quick test (mic/upload); diarization seeding feedback.
- [ ] P5 DNA: view/generate from **selected historical data**; **set-default**; **version diff**; impersonation-guarded.
- [ ] P6 Summarization: backend list + versions; generate (prompt + context + DNA); **cache hit/rate**, **quality**, **version diff**, **edit→new version**, **tag**.
- [ ] X Cross-cutting: header **scope switcher** (global→tenant), **re-orderable persisted menus**, **realtime code-sample panel**, all honoring rules `07/10/11`.

### 1.4 Non-goals

- No visual redesign beyond what new capabilities require; follow the existing design system + rules `07-react-ui` / `10-skeleton-loading` / `11-ux-ui-principles`.
- No replacement of `@arcaai/vox`; new admin surfaces should consume SDK hooks (continuing TASK-323), extending the SDK first where a hook is missing.
- This ticket does not re-do completed prior work (TASK-233/295/296/299/322); it builds on it.

---

## 2. Current State Evaluation

### 2.1 Baseline

`apps/ui-playground` already ships most admin pages and a playground set. Routes present (`src/routes/_authenticated/`): `admin/{tenants,users,departments,prompts,audio-pipelines,storage,audit-logs,configurations,studio,dna-reports}`, `playground/overview`, `consultation/{index,$id}`, `audio/{live-transcription,job-transcription}`, `voice-profile`, `dna-writing-style`, `summarization/{pre-summary,summary}`, `installation/*`. The header already reads "ArcaVox / Admin Console".

### 2.2 Structural gap — scope model & navigation **(verified)**

The sidebar is fully hardcoded in a `useMemo` keyed only on `isSuperAdmin` / `canAccessDnaReports` (`apps/ui-playground/src/components/layout/app-sidebar.tsx:92-176`). Consequences:

- **Tenant admins see only 5 of 11 admin pages.** `Tenants`, `Users`, `Prompts`, `Departments`, `Audio Pipelines`, `Prisma Studio` are gated to `isSuperAdmin` (`app-sidebar.tsx:117-153`). A `TENANT_ADMIN` cannot self-serve users/departments/prompts/pipelines.
- **No header scope switcher.** Global admins have no first-class "select a tenant" control; the working tenant-pick logic exists only inside `features/playground/overview/components/tenant-selector.tsx`.
- **No persisted, re-orderable menus.** Order/visibility are code-controlled; nothing is stored per admin/tenant. `UserSettings` (`packages/database/src/prisma/db_main/user.prisma`) and `GlobalSetting` already have `namespace` + JSON `value` and can hold this with **no migration**.

### 2.3 Administration gap matrix

> Status legend: `Built` ≈ spec-complete · `Partial` ≈ exists with gaps · `Missing` ≈ core requirement absent. `%` = reviewer-judged coverage.

#### A1 — Tenant management — `Partial` (75%)
- **Committed:** Global CRUD `tenant.controller.ts` (`POST/GET/PATCH/DELETE /admin/tenants`, usage, configs); self-service `MyTenantController` (`GET/PATCH /tenant/me/config`); models `Tenant` + `GlobalSetting` + `TenantBucket`; full UI `features/admin/tenants/`.
- **Gaps:** no "manage selected tenant as its tenant admin" path (set `tenantKey` in `auth-store` to reuse `/tenant/me/*`); tenant-detail tabs lack Prompt-Templates + tenant-scoped Storage (`FilesTab` uses the global shared bucket list); no user↔department assignment.
- **Defects:** soft-delete on `delete` unverified (must set `resourceStatus: DELETED`); no `SysEvent` broadcast after config update.
- **Fix:** add `PromptTemplatesTab` + tenant-scoped `StorageTab` (reuse `features/admin/api/tenant-storage.ts`); add "Manage as tenant admin" CTA.

#### A2 — User management — `Partial` (70%) — contains a **Critical** defect
- **Committed:** CRUD + settings + roles + API keys (`user.controller.ts`, `user-settings/roles/preferences` controllers); models `User/UserProfile/UserSettings/UserVoiceProfile`; full UI `features/admin/users/`.
- **Gaps:** voice profiles not surfaced in user admin (no `GET /admin/users/:id/voice-profiles`); per-user DNA history not linked; frontend settings hidden (UI filters to `arcaai-sdk` namespace only); no per-user backend-pipeline preference editor; no `preferredPromptTemplateId` field.
- **Defects:** **(verified) CRITICAL** — `UserController.fetchAll` (`apps/api/src/modules/user/user.controller.ts:61-66`) applies no tenant scope/guard (contrast `fetchByTenant` at `:87`). Combined with `User` being excluded from the tenant-scope Prisma extension (TASK-305 known gap — no `tenantId` column), a `TENANT_ADMIN` with `manage:User` can enumerate users platform-wide. Confirm the CASL ability, then scope.
- **Fix:** scope `fetchAll` by effective `tenantId` for non-super-admins; add voice-profile + DNA + all-namespace settings sections to `UserDetailDialog`.

#### A3 — Department management — `Partial` (70%)
- **Committed:** CRUD + prompt-config (`department.controller.ts`), `Department` (self-ref tree, prompt fields), page + tenant-detail tab.
- **Gaps:** no `GET /admin/departments/tenant/:tenantId`; no user↔department assignment model; tenant admins cannot reach the page (SUPER_ADMIN-gated nav).
- **Defects:** `fetchAll` tenant isolation relies on the extended Prisma client/CLS — verify `DepartmentService` injects the scoped client (cross-ref TASK-305/313); `includeDisabled` parsed via fragile string compare.
- **Fix:** add `UserDepartment` join model + assignment endpoints; expose Departments to tenant admins.

#### A4 — Prompt templates — `Built` (80%)
- **Committed:** versioning (`PromptVersion`), usage records (`PromptUsageRecord`), activate-version, word-level diff (`apps/ui-playground/src/components/version-diff-panel.tsx`), OCC end-to-end, tenant switch via `X-Tenant-Id`.
- **Gaps:** **quality/score TESTING absent** (no fields, no `POST /:id/test`, no UI); usage stats shallow (total + lastUsedAt only); diff covers `content` not `variables`; pagination done in-memory in the controller.
- **Defects:** client `PromptTemplateCategory` includes dead `PRE_SUMMARY` (no DB enum); `getVersion`/`getUsageStats` use `as any`; `activateVersion` is a non-atomic read-then-write.
- **Fix:** add `lastTestScore/Output/At` + `POST /:id/test` (SMR-scored) + Test panel; aggregate usage via `GROUP BY`; push pagination to the repository.

#### A5 — DNA writing-style dashboards — `Partial` (45%)
- **Committed:** per-doctor reports + versions + diff (`features/admin/dna-reports/`), generate (HTTP+SSE), admin list/update.
- **Gaps:** **no aggregate dashboard** (spec wants tenant-level metrics + by-user activity; current UI is a row browser); `DnaUsageRecord` activity unused; no bulk generation.
- **Defects:** admin controller `@Authorize(['manage','all'])` blocks tenant admins (spec needs tenant-admin scope); admin PATCH lacks OCC.
- **Fix:** add `GET /admin/dna-writing-styles/dashboard?tenantId=` aggregates → Stat strip + chart; split global vs tenant-admin controllers.

#### A6 — Audio-processing management — `Missing` core (40%)
- **Committed:** backend `AsrPipeline` (YAML in DB), CRUD + YAML validate + form↔YAML editor (`features/admin/audio-pipelines/pipeline-config-editor.tsx`), assign-tenant, OCC.
- **Gaps:** **FRONTEND pipeline config does not exist anywhere** (no DB/API/UI) — spec separates browser-side VAD/noise/enrollment/diarization from the backend YAML pipeline; no per-tenant **default** pipeline selector; no pipeline version history; no enable/disable toggle; enrollment/diarization absent from the config schema.
- **Defects:** delete likely hard-delete; list unpaginated; tenant switcher gates on `SUPER_ADMIN` not `GLOBAL_ADMIN`.
- **Fix:** add `TenantFrontendConfig` model + `GET/PUT /admin/tenant/frontend-config` + Frontend-Pipeline tab; add `AsrPipelineVersion`; add default-pipeline assignment.

#### A7 — Storage & file management — `Partial` (65%)
- **Committed:** tenant bucket CRUD + folder tree + presigned URLs (`tenant-bucket.controller.ts`), object data-plane (`storage.controller.ts`), UI `features/admin/storage/`.
- **Gaps:** delete file/bucket hooks exist but unused in UI; no access-key UI (`StorageAccessKey` + `storage-access-key` module exist); no storage-config UI (`tenant-storage-config-admin.controller.ts`); no presigned download link in blob list.
- **Defects:** two bucket-create paths (admin vs data-plane) can diverge on metadata; legacy `features/admin/api/storage.ts` hooks are unscoped dead code.
- **Fix:** wire `useDeleteTenantObject/Bucket` + confirm dialogs; add access-key + storage-config panels; consolidate the create path.

#### A8 — Audit log — `Partial` (55%)
- **Committed:** `AuditLog` (rich, indexed), list / by-resource / by-user, tenant-filtered UI table (`features/admin/audit-logs/`).
- **Gaps:** no date-range/action/resource filters; no responsible-user column; no before/after `data` drill-down; no CSV export.
- **Defects:** `fetchAll` has no controller-layer tenant guard (relies on the service `buildTenantWhere`) — add an explicit scope check as `fetchByUser` already has.
- **Fix:** add filter params + detail drawer + export endpoint.

#### A9 — Embedded Prisma Studio — `Built` but risky (70%)
- **Committed:** embedded via `@prisma/studio-core` (`features/admin/components/studio-page.tsx`) + BFF (`pstudio.controller.ts`), Bearer-only auth, `@CanManage('all')`.
- **Gaps (resolved by Q4):** spec mentioned a tenant-admin view, but Q4 keeps Studio **super-admin only** — the only remaining work is auditing.
- **Defects:** **(verified)** `POST /admin/pstudio` (`apps/api/src/modules/pstudio/pstudio.controller.ts:56-69`) runs raw `query`/`sequence` via `studioService.executeQuery/executeSequence` with no tenant scoping and **no audit trail** — a super-admin bypasses soft-delete and audit entirely. Gated to super/global admin (`@CanManage('all')`) so it is by-design privileged, but unaudited.
- **Fix (Q4):** keep super-admin-only; **log every Studio call to `AuditLog`** (`action: READ`/`UPDATE`, `resourceType: 'PrismaStudio'`). Drop the tenant-admin read-only mode.

### 2.4 Developer-playground gap matrix

#### P1 — Overview & impersonation — `Partial` (50%)
- **Committed:** `TenantSelector` component; impersonation in `auth-store`; service-status grid (`features/introduction/components/service-status-grid.tsx`).
- **Gaps:** the tenant-select-before-impersonation gate was removed from Overview (a test documents the removal) → a global admin lands on the user list with no tenant context; service-status grid renders only on `/introduction`, not Overview; no live code-sample panel anywhere.
- **Fix:** re-introduce the tenant gate for global admins; move status grid to Overview; add `LiveCodePanel`.

#### P2 — Consultation — `Partial` (55%) — backend strong, UI thin
- **Committed:** `consultation.controller.ts` (+job, +admin); models `Consultation/ContextItem/SummaryMeta`; chain endpoint `GET /:id/chain` + `generateComprehensiveSummary`; `useFileTranscription` SSE hook.
- **Gaps:** audio case-note tab is upload-only — batch transcription + SSE not wired into `CaseNoteForm`; no in-flow mic recording (`useArcaAudio` unused in consultation); summary generation passes no dept `summaryPromptId`/`revisitPromptId` (no fallback); chain-of-consultation not surfaced in UI; **dual RAW+PROCESSED capture missing — `AudioRecording` has a single `mediaId`**.
- **Fix:** wire `useFileTranscription`; add a recording panel using impersonated prefs; pass dept prompt w/ fallback; surface the chain; add `rawMediaId`/`processedMediaId` + save both streams.

#### P3 — Audio & transcription — `Built` (70%)
- **Committed:** local (`LocalSTTProvider`) + remote (`StreamingBackendSTTProvider`) paths; model/pipeline selectors; tenant-lock indicators; `transcription-job.controller.ts` (stream + batch + SSE).
- **Gaps:** local model **TASK** (transcribe/translate) not exposed; user prefs are in-memory only (not persisted); no realtime code-sample; remote model behind a pipeline id is opaque.
- **Defects:** `localAsrModels` vs `availableModels` field mismatch between tenant defaults and resolved config.
- **Fix:** add `task` to schema + UI; debounced `PATCH /user/me/settings`; add `LiveCodePanel`.

#### P4 — Voice profile — `Partial` (55%) — backend-only
- **Committed:** backend enrollment (`voice-profile.controller.ts`); `UserVoiceProfile(embedding vector(256))`; SDK `useVoiceEmbedding` with encrypted frontend cache.
- **Gaps:** **LOCAL in-browser enrollment entirely missing** (all flows hit backend); "quick test" (mic/upload match) missing; diarization seeding feedback (`voiceProfileSeeded`) not displayed.
- **Defects:** `VoiceEmbeddingPanel` always renders "Active"; TanStack-query vs SDK-hook active state can diverge.
- **Fix:** add a local embedding provider + `POST /voice-profile/enroll-embedding`; add a Test-Match tab + `POST /voice-profile/test`.

#### P5 — DNA writing style — `Partial` (50%)
- **Committed:** view current style + versions + generate (HTTP+SSE), edit dialog.
- **Gaps:** "select historical data" for generation not implemented (freeform text only); "set as default" has no endpoint/action; version DIFF absent (single-select) though `diffUtils` + `version-diff-panel.tsx` exist.
- **Defects:** no `ImpersonationGuard` → an admin generates a DNA profile for themselves, not the impersonated doctor; `selectedReport` never set → Edit dialog opens empty.
- **Fix:** add `POST /:reportId/set-default`; two-version diff; context-item picker; wrap page in `ImpersonationGuard`.

#### P6 — Summarization — `Partial` (55%)
- **Committed:** generate (sync/async/SSE); context-item selection; DNA injection; provider/model controls; models `SummaryMeta` + `ContextItemVersion` + `Tag`; `PATCH /:summaryId` (→ new version).
- **Gaps:** no backend summary LIST/version browser (history is `localStorage`-only); cache hit/rate not modeled or shown; quality/rating absent; version diff not wired; tagging UI/endpoint absent; edit→new-version not wired.
- **Defects:** non-debug path posts raw DNA text → bypasses the cross-doctor ownership guard (route via `/text/generate/assembled` with IDs); `localStorage` history not namespaced by tenant/user; streaming results hard-code 0 tokens; `/consultations/_/context/:id` placeholder path is wrong.
- **Fix:** add a backend browser + `version-diff-panel.tsx`; add `cacheHit`/`qualityScore` fields + endpoints; tag popover; namespace history.

### 2.5 Realtime code-sample visualization — **Missing across all playgrounds**
The spec requires a live snippet reflecting the impersonated user's prefs. Today only static markdown `DocPanel` exists (`features/doc-panel/`). No reactive code block bound to store state exists anywhere.

### 2.6 Cross-cutting defects (severity-ranked)

| # | Sev | Area | Issue | Recommended fix |
|---|---|---|---|---|
| X1 | **Critical** | Prisma Studio | `POST /admin/pstudio` runs raw query/sequence; no scope, no audit **(verified `pstudio.controller.ts:56-69`)** | Audit-log every call; **keep super-admin-only (Q4)** — no tenant-admin mode |
| X2 | **Critical** | User mgmt | `GET /admin/users` (`fetchAll`) unscoped **(verified `user.controller.ts:61-66`)** + `User` excluded from tenant-scope extension (TASK-305) → cross-tenant enumeration | Inject effective `tenantId` for non-super-admins; confirm CASL ability |
| X3 | High | Summarization | Non-debug path posts raw DNA text → bypasses cross-doctor ownership guard | Route via `/text/generate/assembled` with `dna_writing_style_id` + `prompt_template_id` |
| X4 | High | Audio pipeline | Frontend pipeline config missing across DB/API/UI | Add `TenantFrontendConfig` + API + tab |
| X5 | High | Audit log | `fetchAll` lacks a controller-layer tenant guard | Add explicit scope check (as `fetchByUser`) |
| X6 | High | Multi-tenancy | `User*` / `UserVoiceProfile` not tenant-scoped at DB | Phase-A schema hardening + tenant-leading composite indexes — **deferred to TASK-305 Phase A (decision 2026-06-02)**: overlaps the existing A.10/A.11 `User*` schema design and `User` is multi-tenant by nature. Controller/service scope (X2/X5) still fixed in TASK-326 |
| X7 | High | DNA admin | `@Authorize(['manage','all'])` blocks tenant admins required by spec | Split global vs tenant-admin DNA controllers |
| X8 | Med | Consultation | Single `mediaId` — no RAW+PROCESSED dual capture | Add `rawMediaId`/`processedMediaId` + pipeline save |
| X9 | Med | Admin mutations | Missing `SysEvent`/`AuditLog` broadcasts on several updates | Add `broadcastSysEvent` after each mutation |
| X10 | Med | Summarization | `localStorage` history not namespaced by tenant/user | Key by `{tenantId}.{userId}`; clear on switch |

### 2.7 Design-system inventory (for the UX work) — **(verified available)**
`@arcaai/ui` already provides what most of this needs — **compose, don't rebuild**:

| Need | Reuse (exists) |
|---|---|
| List ↔ detail CRUD | `MultiColumnLayout` / `MasterDetailComposed` (resizable, virtualized) |
| Version + diff | `apps/ui-playground/src/components/version-diff-panel.tsx` + `diff` package |
| Dashboards / metrics | `registries/tool-ui/chart` (recharts `2.15.4`) + `tool-ui/stats-display` |
| Data tables | `registries/tool-ui/data-table` (add `getSortedRowModel()`) |
| Pipeline YAML editor | `audio-pipelines/pipeline-config-editor.tsx` (form↔YAML) |
| Code samples | `registries/kibo-ui/code-block` (Shiki, `transformerNotationDiff`) |
| Drag reorder | `@dnd-kit/sortable ^10` (already a dependency) |
| Toasts / loading | `sonner` + `Skeleton` |

---

## 3. Implementation Plan

Sequenced so security lands before tenant admins get access, the shell/scope lands before feature build-out, and admin completeness precedes the playgrounds. Every behavioral change is TDD (RED → GREEN → refactor) down the layer chain (Database → Domain Factory/Mapper/Repo → Application Service+DTO → API Controller → UI). New admin surfaces consume **SDK hooks** (extend `@arcaai/vox` first where missing, per TASK-323).

### 3.1 Phase 0 — Security & tenancy hardening (**do first; gating**)
- **0.1** Tenant-scope `fetchAll` for users (X2), departments, and audit logs (X5) for non-super-admins; add a regression test proving cross-tenant isolation.
- **0.2** Prisma Studio (X1): write an `AuditLog` entry for every `query`/`sequence`. **Keep super-admin-only (Q4)** — no tenant-admin mode.
- **0.3** Multi-tenant schema hardening for `User*` models (X6) + tenant-leading composite indexes — **deferred to TASK-305 Phase A (decision 2026-06-02)**; it overlaps the existing A.10/A.11 design and `User` is intentionally multi-tenant. Controller/service-level tenant scope (X2/X5) is still fixed here in TASK-326.
- **0.4** Add `broadcastSysEvent`/audit on admin mutations (X9); verify soft-delete on all `delete` paths (A1/A3/A6).
- **Verify:** `pnpm --filter @arcaai/applications test`, `pnpm test:e2e` cross-tenant guards green; `ReadLints` clean.

### 3.2 Phase 1 — Console shell & scope model
- **1.1** Header `ScopeSwitcher` (global admin: `Popover` + `Command` tenant picker; tenant admin: locked badge) — extract the logic from `features/playground/overview/components/tenant-selector.tsx`; set store + `X-Tenant-Id` on every request.
- **1.2** Move admin nav gating from **visibility** to **data-scope**: render the same 9 menus for both scopes; tenant admins get scoped data, not hidden pages.
- **1.3** Re-orderable, persisted menus: store ordered ids in `UserSettings` (`namespace:'arcaai-admin'`, `key:'menuOrder'`) via `PATCH /user/me/settings`; tenant default in `GlobalSetting`; resolution user → tenant → hardcoded; drag with `@dnd-kit/sortable`, optimistic Zustand update.
- **1.4** Restore the global-admin **select-tenant-before-impersonation** gate (P1).
- **Verify:** RBAC matrix tests (tenant admin sees scoped data; global admin gated to a selected tenant); menu order round-trips through the DB.

### 3.3 Phase 2 — Administration completeness (spec items A4–A8)
- **2.1** A6 Frontend pipeline config (`TenantFrontendConfig` + `GET/PUT /admin/tenant/frontend-config` + tab) + default-pipeline assignment + `AsrPipelineVersion` history (X4).
- **2.2** A4 Prompt quality/test (`lastTestScore/Output/At` + `POST /:id/test`) + richer usage analytics + variables diff.
- **2.3** A5 DNA aggregate dashboards (`GET /admin/dna-writing-styles/dashboard`) + tenant-admin controller split (X7).
- **2.4** A7 Storage delete/keys/config UI; A8 audit filters + detail drawer + export.
- **2.5** A1/A2/A3 tenant-detail completeness: prompt + storage tabs, voice-profile + DNA + all-namespace settings in `UserDetailDialog`, `UserDepartment` assignments.
- **Verify:** per-feature suites; Skeleton states (rule 10); toast on every mutation (rule 11).

### 3.4 Phase 3 — Developer-playground completeness (spec P2–P6 + code samples)
- **3.1** P2 Consultation: in-flow recording (impersonated prefs) + batch-SSE case notes + dept-prompt fallback + chain UI + RAW/PROCESSED dual capture (X8).
- **3.2** P4 Voice: local in-browser enrollment + quick-test + diarization seeding feedback.
- **3.3** P5 DNA: historical-data select + set-default + version diff + `ImpersonationGuard`.
- **3.4** P6 Summarization: backend browser + `cacheHit`/`qualityScore` + version diff + tagging + edit→version; fix raw-DNA ownership path (X3) + history namespacing (X10).
- **3.5** `LiveCodePanel` (Shiki, reactive to store/impersonated prefs) across every playground (§2.5).
- **Verify:** attachment→summary + recording→transcript smoke; SSE streaming intact.

### 3.5 UX/UI playbook (applies to every phase)
**New shadcn-compliant components to build** (`cva` + Radix + `cn()` + semantic tokens):

| Component | Purpose |
|---|---|
| `ScopeSwitcher` (header) | tenant picker for global admin; locked badge for tenant admin; sets store + `X-Tenant-Id` |
| `DraggableNavGroup` | dnd-kit sortable sidebar; persists to `UserSettings(arcaai-admin)` |
| `AdminPreferences` store/hook | resolve order user → tenant default → hardcoded |
| `LiveCodePanel` | reactive Shiki snippet bound to playground store / impersonated prefs |
| `YamlDiffViewer` | `diffLines` + code-block notation-diff for pipeline & version history |
| `AuditLogDetailDrawer` | before/after JSON, responsible user, correlation id |

**Rules to honor:** skeletons over spinners (10); fixed-dimension dialogs with primary input flex-filling (11); semantic tokens + full dark mode; toast on every action; empty states with icon+title+description; `gap-*` not `space-*`; `size-*` for equal dimensions; one scroll container per panel.

### 3.6 Resolved decisions (2026-06-02)

| # | Decision | Resolution |
|---|---|---|
| Q1 | Ticket size | **Umbrella + per-phase sub-tickets.** TASK-325 = umbrella; phases = TASK-326–329 (§3.7), Phase 0 first. |
| Q2 | Tenant-scoping (X2/X5/X6) | **Controller/service scope (X2/X5) fixed completely in TASK-326.** **X6 (DB-level `User*` `tenantId`) deferred to TASK-305 Phase A (decision 2026-06-02)** — overlaps A.10/A.11; `User` is multi-tenant by design. |
| Q3 | SDK-first | **Yes.** New admin/storage surfaces consume `@arcaai/vox` hooks; extend the SDK first where a hook is missing (continuing TASK-323). |
| Q4 | Prisma Studio | **Super-admin only.** No tenant-admin mode; remaining work = audit every query/sequence to `AuditLog`. |
| Q5 | Frontend pipeline storage | **Typed JSON** (`TenantFrontendConfig`), consumed directly by the browser SDK. |

### 3.7 Sub-ticket breakdown (Q1)

TASK-325 is the **umbrella**. Each phase is an independently shippable sub-ticket behind its own green gate. The detailed current-state evidence lives here (§2); each sub-ticket carries its own focused plan + verification and links back here.

| Sub-ticket | Phase | Scope | Depends on | Status |
|---|---|---|---|---|
| **TASK-326** | Phase 0 | Security & tenancy hardening — X1/X2/X5/X7/X9 + soft-delete (**X6 deferred → TASK-305 Phase A**) | — (do first) | `Completed` (2026-06-02) |
| **TASK-327** | Phase 1 | Console shell & scope — `ScopeSwitcher`, scope-not-visibility nav, persisted re-orderable menus, impersonation tenant-gate | TASK-326 | `Completed` (2026-06-02) |
| **TASK-328** | Phase 2 | Administration completeness — A4–A8 (frontend pipeline, prompt testing, DNA dashboards, storage, audit) + A1–A3 tenant-detail completeness | TASK-326, TASK-327 | `Pending` |
| **TASK-329** | Phase 3 | Developer-playground completeness — P2–P6 + `LiveCodePanel` | TASK-326, TASK-327 | `Pending` |

---

## 4. Implementation Summary

> **Not started.** Awaiting plan approval (§3.6 decisions). No code written; this document is the analysis + plan only. Populate per phase as work lands (files changed, migrations, endpoints, deviations), mirroring TASK-323's Wave structure.

---

## 5. Verification Gates

```
# Backend (Phases 0 / 2 / 3 backend slices)
pnpm db:migrate && pnpm db:generate           # when schema changes (A2/A6/P2/P6)
pnpm build --filter @arcaai/domains && pnpm test:unit --filter @arcaai/domains
pnpm build --filter @arcaai/applications && pnpm test:unit --filter @arcaai/applications
pnpm build:api && pnpm test:e2e               # cross-tenant scope guards (Phase 0)

# SDK (when extending @arcaai/vox)
pnpm build:sdk && pnpm --filter @arcaai/vox test

# App (all phases)
pnpm --filter @arcaai/ui check-types
pnpm --filter @arcaai/ui-playground type-check   # = 0 (TASK-321 baseline)
pnpm --filter @arcaai/ui-playground test         # no NEW failures vs known baseline
# ReadLints on every edited file → clean
```

Per phase: run the touched suite (RED→GREEN) + `ReadLints` before proceeding. Capture actual output as evidence (rule `verification-before-completion`).

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-02 | Ticket created. Five parallel full-stack exploration agents reviewed `apps/ui-playground` ↔ `apps/api` ↔ `packages/database` ↔ `@arcaai/vox` against the Admin-Console + Developer-Playground spec. Verified the 2 Critical defects (`user.controller.ts:61-66`, `pstudio.controller.ts:56-69`), the sidebar scope gating (`app-sidebar.tsx:92-176`), and design-system component availability. Produced the gap matrix (A1–A9, P1–P6), a severity-ranked cross-cutting defect list (X1–X10), a 4-phase implementation plan, and a UX/UI playbook. Companion interactive review canvas created. Status `Pending` — awaiting §3.6 decisions. | this README; `canvases/admin-console-review.canvas.tsx` |
| 2026-06-02 | Decisions resolved (Q1–Q5, §3.6): umbrella + per-phase sub-tickets; tenant-scoping fixed in-ticket; SDK-first; Prisma Studio super-admin-only; frontend config typed JSON. Created sub-tickets **TASK-326** (Phase 0), **TASK-327** (Phase 1), **TASK-328** (Phase 2), **TASK-329** (Phase 3). Adjusted A6/A9 criteria + A9/X1/X6 fixes + Phase 0 plan accordingly. | this README; TASK-326–329 READMEs |
| 2026-06-02 | **Wave 1 shipped — TASK-326 `Completed`** and merged to `fix/2605-review`. Delivered X1/X2/X5/X7/X9 + pipeline soft-delete; gates build 8/8, unit 4507+1447, lint clean (e2e committed for CI). **Decision: X6 deferred to TASK-305 Phase A** (overlaps A.10/A.11; `User` multi-tenant) and X7 OCC deferred. Wave 2 = TASK-327 next (plan-gate). | TASK-326 README + code |
| 2026-06-02 | **Wave 2 shipped — TASK-327 `Completed`** and merged to `fix/2605-review`. Console shell & scope model: `isGlobalScope` (SA≡GA, D1), header `ScopeSwitcher` (picker / locked badge), React Query invalidation on tenant change, scope-not-visibility nav with Prisma-Studio-global-only, persisted re-orderable menus (`useAdminPreferences`, USER→TENANT→DEFAULT) reusing `@arcaai/ui` Sortable (D2), impersonation tenant-gate + Overview service grid. `@arcaai/vox` untouched (D3 already live). Gates: type-check 0, tests 731/731, @arcaai/ui build ok, lint clean. Wave 3 = TASK-328 ∥ TASK-329 next (plan-gate). | TASK-327 README + code |
