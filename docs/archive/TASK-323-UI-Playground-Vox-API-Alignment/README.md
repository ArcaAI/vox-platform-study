# TASK-323 — UI-Playground: Adopt latest `@arcaai/vox` + API surfaces

| | |
|---|---|
| Ticket Number | TASK-323 |
| Short name | UI-Playground-Vox-API-Alignment |
| Created | 2026-06-01 |
| Updated | 2026-06-01 |
| Status | `In Progress` — **Wave 1 merged to `fix/2605-review`** (Phase 0 SDK bindings + D2/D3/D6/D7 app fixes). Waves 2+ (Phase 1 D1 / 2 / 3 / 4 / 5) remain. |
| Type | refactor + feature (SDK/API consumer alignment) |
| Scope | `apps/ui-playground/` (primary). Gating prerequisite in `packages/agentic-sdk-v2/` (`@arcaai/vox`) — see §3.1 / Decision Q1–Q2. |
| Builds on | TASK-318 (Storage SDK/Multi-Tenancy), TASK-319 (API Access-Scope Hardening), TASK-320 (Vox SDK ↔ API AuthZ Alignment), TASK-321 (UI-Playground Type-Check Baseline), TASK-322 (Consultation Lifecycle Endpoints) |

---

## 1. Requirement Analysis

### 1.1 Description

`apps/ui-playground` is the `@arcaai/vox` SDK / admin reference surface. Recent backend and SDK
work (TASK-318/319/320/322) reshaped the API and the SDK, but the playground has not kept up.
This ticket reviews how the playground currently consumes `@arcaai/vox` and `apps/api`, then
drives it onto **the latest SDK and the latest API endpoints**:

1. **Converge the app onto the SDK** — collapse the app's parallel HTTP/auth implementation
   (two hand-rolled clients + a raw refresh path + ~12 raw API modules) onto the SDK hooks and
   the single `AgenticClient` transport.
2. **Bind + adopt the new API surfaces** — admin consultation / transcription-job planes
   (TASK-319), storage config/keys/bucket-defaults (TASK-318), consultation lifecycle
   close/reopen/update (TASK-322), and server-side assembled summarization + attachments
   (TASK-318 W3-D).
3. **Fix the drift bugs** the divergence introduced (impersonation tenant leak in SMR requests,
   competing refresh wiring, `count`/`total` mismatch, raw refresh/impersonate strings).

### 1.2 Business context

- The playground is the canonical example of how a host app integrates `@arcaai/vox`. Its
  parallel implementation (duplicate clients, raw fetches) is a **maintenance and correctness
  liability** and a misleading reference for SDK consumers.
- A **real cross-tenant defect** exists today: SMR (summarization) requests do not honour the
  impersonated tenant, so a TENANT_ADMIN/SUPER_ADMIN impersonating a user in another tenant
  generates summaries in the **wrong tenant** (see D2, §2.4).
- New tenant-admin capabilities shipped on the API (tenant-wide consultation / job supervision,
  per-tenant storage provider config, storage access keys, bucket defaults) have **no UI**.
- New clinical capabilities (consultation close/reopen, attachment-aware summarization) are
  available end-to-end but unused by the reference UI.

### 1.3 Acceptance criteria

1. The playground consumes the new admin/storage/lifecycle API surfaces **through `@arcaai/vox`
   hooks** (not raw fetch). Where the SDK lacks a binding, the SDK is extended first (§3.1).
2. Exactly **one** refresh path is active (the SDK's auto-wired `onUnauthorized`, TASK-320 B2);
   the app's competing `setOnUnauthorized` override and `lib/auth-refresh.ts` raw path are
   removed or reduced to a single SDK-backed adapter. Impersonation 401-recovery still works.
3. All API calls carry the **effective (impersonated) tenant** uniformly — D2 is fixed; SMR
   generation respects the impersonated tenant.
4. Tenant-admin can, in the UI, view **tenant-wide** consultations and transcription jobs
   (`/admin/consultations`, `/admin/audio/transcription-jobs`); a plain DOCTOR is denied by the
   server (403) and the UI surfaces it cleanly.
5. Tenant-admin can manage storage **config**, **access keys**, and **bucket defaults**
   (`/admin/tenants/storage/{config,keys,buckets/defaults}`) in the UI.
6. Consultation **close / reopen / update** are wired into `features/consultation/**`.
7. Summarization uses server-side **assembled** generation (`POST /text/generate/assembled`) and
   the **attachment → mediaId** link is exercised end-to-end.
8. Pagination shape is standardized (no `count`/`total` mismatch); the `useTenants` name collision
   is resolved.
9. Gates green: `pnpm build:sdk`; `pnpm --filter @arcaai/vox test`;
   `pnpm --filter @arcaai/ui-playground type-check` = **0**;
   `pnpm --filter @arcaai/ui-playground test` introduces **no** new failures vs. the known
   pre-existing baseline (TASK-321: 92 failures in 5 files);
   `pnpm --filter @arcaai/applications test` regression guard stays green; `ReadLints` clean.

### 1.4 Explicit non-goals

- No backend (`apps/api`) endpoint changes — every consumed route already exists (verified §2.2).
- No visual redesign beyond what the new pages/capabilities require (follow `10-skeleton-loading`
  + `11-ux-ui-principles`).
- No conversion to TS project references; the TASK-321 `paths`/type-check gate config is preserved.

---

## 2. Current State Evaluation

> Global API prefix is `/api/v1`; SDK endpoint strings (single source of truth:
> `packages/agentic-sdk-v2/src/core/constants.ts`) omit it (the `baseUrl` carries it).
> Every finding below is source-verified (file:line cited).

### 2.1 The headline: a parallel implementation of the SDK

`ui-playground` re-implements transport/auth that `@arcaai/vox` already centralizes:

- **Two hand-rolled HTTP clients** — `features/admin/api/admin-client.ts` and
  `features/summarization/api/smr-client.ts` (each reads Zustand directly, injects
  `Authorization`/`X-API-Key`/`X-Tenant-Id`/`If-Match`, and runs its own 401→refresh).
- **A raw refresh path** — `lib/auth-refresh.ts` (`POST /auth/refresh` via bare `fetch`).
- **~12 raw API modules** — `features/**/api/*.ts` (tenants, departments, prompts, users, roles,
  audit-logs, audio-pipelines, storage, tenant-storage, dna-reports, voice-profiles,
  summarization), most of which duplicate an existing SDK hook.

### 2.2 What changed in the "latest" SDK/API (the target baseline)

| Area | Change | Where (verified) |
|---|---|---|
| Token refresh | SDK **auto-wires** `onUnauthorized` (body-based `/auth/refresh`, single-flight) | TASK-320 §4.1 (`AgenticProvider`) |
| WS tenant claim | `requireTenantClaim` default-on; SDK always appends `tenantId` to WS URL | TASK-320 §4.2 |
| Consultation lifecycle | `PATCH /consultations/:id`, `POST /:id/close`, `POST /:id/reopen` **exist** | `consultation.controller.ts:363,376,386` (TASK-322) |
| SDK lifecycle methods | `useArcaSession` exposes `close()` + `reopen()` | `useArcaSession.ts:216-258`; constants `constants.ts:33-38` |
| Owner-scoped jobs | end-user `GET /audio/transcription-jobs(+/stats,/status)` owner-scoped | `transcription-job.controller.ts` (TASK-319 F3) |
| New admin planes | `GET /admin/consultations(/:id)`; `GET /admin/audio/transcription-jobs(+/stats,/status)` | `admin-consultation.controller.ts:36`, `admin-transcription-job.controller.ts:29` |
| Storage admin | `/admin/tenants/storage/keys`, `/config(+/effective)`, `buckets/defaults` (GET/PUT) + provision | `storage-access-key.controller.ts:16`, `tenant-storage-config-admin.controller.ts:23`, `tenant-bucket.controller.ts` |
| Attachments + assembled SMR | `ContextItem.mediaId`; `POST /text/generate/assembled` (server-side assembly + DNA + attachment text) | `smr-proxy.controller.ts` (TASK-318 W3-D) |
| Prompt templates | under `/admin/prompt-templates` | `prompt-management.controller.ts`; app already aligned ✓ |
| Optimistic concurrency | `@RequiresIfMatch()` on tenant/department/prompt/pipeline/`tenant/me/config` PATCH | TASK-319/321 |

### 2.3 SDK coverage map — migrate-now vs. SDK-must-bind-first

**Has an SDK hook today** (`hooks/index.ts`) → app can converge immediately:
`useTenants`, `useDepartments`, `usePrompts`, `useUsers`, `useRoles`, `useAuditLog`, `usePolicies`,
`useApiKeys`, `useVoiceEmbedding`, `useStorage`, `usePipelines`, `useGlobalSettings`,
`useUserSettings`, `useMonitoring`, `useHealthCheck`, `useDnaStyle`.

**No SDK hook yet** → must be added before the app can consume "via the SDK"
(this is the unfinished tail of TASK-320 A1 + TASK-318 R9):

| API surface | Needed SDK addition | Status |
|---|---|---|
| `GET /admin/consultations(/:id)` | `useAdminConsultations` | TASK-320 A1 — not done |
| `GET /admin/audio/transcription-jobs(+/stats,/status)` | `useAdminTranscriptionJobs` | TASK-320 A1 — not done |
| `/admin/tenants/storage/buckets` (+tree/presigned/**defaults**/provision) | `useTenantBuckets` | TASK-318 R9 — not started |
| `/admin/tenants/storage/keys` | `useStorageKeys` | TASK-318 R9 — not started |
| `/admin/tenants/storage/config(+/effective)` | `useTenantStorageConfig` | TASK-318 R9 — not started |
| `POST /text/generate/assembled` + `/text/*` proxy | unify via `AgenticClient` (or a small `useSmr`) | not wrapped |
| `session.update()` → `PATCH /consultations/:id` | add to `useArcaSession` (constant exists `constants.ts:33-34`) | method missing |

### 2.4 Drift / correctness risks (severity-ranked)

| # | Sev | Risk | Evidence |
|---|---|---|---|
| D1 | High | **Competing refresh wiring.** SDK auto-registers `onUnauthorized` (TASK-320 B2); the app overrides it imperatively → fragile/order-dependent. | `hooks/use-auto-refresh.ts:95` vs `AgenticProvider` |
| D2 | High | **SMR ignores impersonation tenant.** `smrClient` always uses global `authStore.tenantId`; no per-request override → impersonation generates summaries in the **wrong tenant**. | `features/summarization/api/smr-client.ts` `getHeaders()` |
| D3 | Med | **`count` vs `total`.** Local `PaginatedResponse<T>` uses `count`; SDK `listConsultations` returns `total`; pipelines module uses `total`. Silent pagination breakage if standardized. | `admin/api/tenants.ts` vs `consultation-list.tsx:86` |
| D4 | Med | **Raw `/auth/refresh` + `/auth/impersonate`** hard-coded outside the SDK. | `lib/auth-refresh.ts:86`, `hooks/use-auto-refresh.ts:62` |
| D5 | Med | **Owner-scoped jobs** — any "all jobs in tenant" assumption now silently under-returns (must use the admin hook). | TASK-319 F3 |
| D6 | Low | **`CONTEXT_ENDPOINTS.ADD/GET` called raw** in 3 sites instead of `context.*` → bypasses SDK store/contract. | `case-note-form.tsx:84`, summary/pre-summary index |
| D7 | Low | Two name-colliding `useTenants` (SDK vs local). | `tenant-selector.tsx:2` vs `admin/api/tenants.ts` |

### 2.5 AgenticProvider wiring (today)

`providers/sdk-provider.tsx:56-61` mounts `<AutoRefreshInit>` (which calls `useAutoRefresh()`)
inside `<AgenticProvider>`. `use-auto-refresh.ts:95` then imperatively calls
`apiClient.setOnUnauthorized(handleUnauthorized)`, overriding the SDK's auto-wired handler — the
root of D1. The provider config feeds `tenantId`/`accessToken` from the local auth store; during
impersonation the impersonation token is fed through `config.api.accessToken`.

### 2.6 Summarization (today)

`features/summarization/api/summarization.ts` calls `/text/generate` (client-side prompt
assembly) at lines 48/59/97/167/213/302 and `/text/providers`, `/text/tasks/:id(+/stream,/cancel)`
— it does **not** use the newer server-side `POST /text/generate/assembled` (DNA-styled +
attachment-aware). Transport is the separate `smrClient` (root of D2).

---

## 3. Implementation Plan

Sequenced so each phase is independently shippable behind a green type-check + test gate. Every
behavioral change is TDD (RED → GREEN → refactor). Risk-ordered: prerequisites and correctness
first, then convergence, then new surfaces/capabilities, then cleanup.

### 3.1 Phase 0 — SDK prerequisites (extend `@arcaai/vox`) — **gating**

The app cannot consume the new admin/storage endpoints "via the SDK" until the SDK binds them.
This is the remaining TASK-320 A1 + TASK-318 R9 work (ownership: Decision Q1).

- **0.1** Add endpoint constants in `constants.ts`: `ADMIN_CONSULTATION_ENDPOINTS`,
  `ADMIN_TRANSCRIPTION_JOB_ENDPOINTS`, `TENANT_BUCKET_ENDPOINTS`
  (list/get/tree/presigned/**defaults**/provision/create/delete), `STORAGE_KEY_ENDPOINTS`,
  `TENANT_STORAGE_CONFIG_ENDPOINTS`.
- **0.2** New hooks (compose `useApiOperation`, mirror `usePrompts`/`useUsers`):
  `useAdminConsultations`, `useAdminTranscriptionJobs`, `useTenantBuckets`, `useStorageKeys`,
  `useTenantStorageConfig`. Barrel-export from `hooks/index.ts` (+ `core.ts`). RED tests assert
  correct path/params and that a server 403 surfaces as a clean `AgenticError`.
- **0.3** Add `session.update(input)` → `PATCH /consultations/:id` to `useArcaSession`
  (close/reopen already present).
- **0.4** Unify the `/text/*` SMR proxy: either a thin `useSmr`/`useTextGeneration` hook or route
  the app's summarization through `AgenticClient` (Decision Q2). Add `/text/generate/assembled`.
- **Gate:** `pnpm build:sdk`; `pnpm --filter @arcaai/vox test` (~2957 green — must stay green);
  `ReadLints`.

### 3.2 Phase 1 — Unify transport & auth (kill the duplication)

- **1.1** Route `smrClient` + `adminClient` requests through the SDK `AgenticClient`
  (`useArcaStore(s => s.apiClient)`) — immediate **D2 fix** (uniform effective-tenant injection).
- **1.2** Resolve **D1/D4**: remove the imperative `setOnUnauthorized` override, rely on the SDK's
  auto-wired refresh, and keep only the impersonation re-mint step the SDK doesn't do (Decision
  Q3). Collapse `lib/auth-refresh.ts` into the SDK refresh or a single thin adapter.
- **Gate:** auth/impersonation Vitest suites green; manual smoke login → impersonate → 401 recovery.

### 3.3 Phase 2 — Converge raw admin modules onto existing SDK hooks

Mechanical, file-by-file, each independently verifiable; delete the now-orphan
`features/admin/api/*.ts` and `features/{voice-profile,dna-writing-style}/api/*.ts`:

`tenants.ts → useTenants` · `departments.ts → useDepartments` · `prompts.ts → usePrompts` ·
`users.ts → useUsers` · `roles.ts → useRoles` · `audit-logs.ts → useAuditLog` ·
`audio-pipelines.ts → usePipelines` · `storage.ts → useStorage` ·
`voice-profiles.ts → useVoiceEmbedding` · `dna-* → useDnaStyle`.

- Thread `If-Match`/`expectedVersion` through SDK mutations (API enforces `@RequiresIfMatch()`).
- Standardize on the SDK pagination shape → **fixes D3, D7**.
- **Gate:** per-feature type-check + existing feature tests; no `count`/`total` regressions.

### 3.4 Phase 3 — Adopt new admin API surfaces (depends on Phase 0)

- **3.1** Tenant-wide views via `useAdminConsultations` + `useAdminTranscriptionJobs`
  (RBAC-gated to TENANT_ADMIN/SUPER_ADMIN; surface server 403 cleanly).
- **3.2** Storage admin: extend `tenant-storage.ts` UI onto `useTenantBuckets` (incl. **bucket
  defaults** GET/PUT, tree, presigned); add **storage keys** (`useStorageKeys`, secret-shown-once
  UX) and **storage config** (`useTenantStorageConfig`, provider/topology).
- **Gate:** Skeleton states (rule `10-skeleton-loading`); RBAC gating verified.

### 3.5 Phase 4 — New product capabilities

- **4.1** Consultation **lifecycle UI**: wire `session.close()`/`reopen()`/`update()` into
  `features/consultation/**` (confirm + toast per `11-ux-ui-principles`).
- **4.2** **Attachments + assembled summarization**: upload attachment → `Media` → link via
  `mediaId`; switch summarization to `POST /text/generate/assembled`. Replaces D6 raw context
  calls with `context.*` methods.
- **Gate:** attachment → summary smoke; SSE streaming still works.

### 3.6 Phase 5 — Drift cleanup & verification

- Remove dead raw clients/modules; resolve the `useTenants` collision; align pagination types.
- **Final gates** (§5).

### 3.7 Open decisions (proposed defaults — confirm before coding)

| # | Decision | Proposed default |
|---|---|---|
| Q1 | Scope/ambition | **SDK-first, then full convergence** — land Phase 0, then Phases 1→5 (full convergence onto the SDK). |
| Q1b | Phase 0 ownership | **Separate SDK ticket** (continue TASK-320 A1 / TASK-318 R9) that TASK-323 depends on. (Folding into TASK-323 as Phase 0 is acceptable.) |
| Q3 | Refresh/impersonation | **Delegate to the SDK auto-refresh** (TASK-320 B2); remove app `use-auto-refresh` + `lib/auth-refresh`; add impersonation re-mint as a small SDK extension (one refresh path). |
| Q4 | Doc | This document. ✅ |

> The two highest-value fixes to land early regardless of final scope: **D2** (SMR
> impersonation tenant — a real cross-tenant bug) and **D1** (competing refresh wiring).

---

## 4. Implementation Summary

### Wave 1 — merged to `fix/2605-review` (2026-06-01)

Two **file-disjoint** workstreams executed in parallel worktrees, then serialized-merged by the
orchestrator (S first, since the app depends on the SDK surface), integration-verified, and the
worktrees torn down.

**Workstream S — Phase 0: SDK bindings** (`packages/agentic-sdk-v2`, merge `2f78f1c7`)
- Added 6 endpoint-constant groups to `src/core/constants.ts`: `ADMIN_CONSULTATION_ENDPOINTS`,
  `ADMIN_TRANSCRIPTION_JOB_ENDPOINTS`, `TENANT_BUCKET_ENDPOINTS`, `STORAGE_KEY_ENDPOINTS`,
  `TENANT_STORAGE_CONFIG_ENDPOINTS`, `SMR_ENDPOINTS`.
- Added 5 hooks: `useAdminConsultations`, `useAdminTranscriptionJobs`, `useTenantBuckets`,
  `useStorageKeys`, `useTenantStorageConfig` (+ tests); barrel exports in `src/core.ts` & `src/hooks/index.ts`.
- Wired `session.update()` through `useArcaSession.ts` / `useArca.ts` (`SessionActions.update` in `src/types/consultation.ts`).
- Additive only — no behavior change to existing surface.

**Workstream T — App correctness** (`apps/ui-playground`, merge `f0518c30`)
- **D2** — `summarization/api/smr-client.ts` `getHeaders()` made impersonation-aware (effective tenant + token), parity with `admin-client`; regression suite `smr-client.impersonation.test.ts` (4 tests).
- **D7** — local admin `useTenants` → `useAdminTenants` (collision with `@arcaai/vox` `useTenants`) across `admin/api/{tenants,index}.ts`, `admin/overview/index.tsx`, `admin/users/index.tsx`.
- **D3** — single documented `PaginatedResponse<T>` (`count`) hoisted into `admin/api/admin-client.ts`; 6 duplicate defs removed (`audit-logs`, `dna-reports`, `prompts`, `roles`, `users`, `tenants`); +2 count-pagination tests.
- **D6** — **not migrated** (correctly): `useArca().context` exposes no `addWorknote`/`addAttachment`, and `useArcaContext()` is not exported from `@arcaai/vox`. All 3 raw `CONTEXT_ENDPOINTS` sites left as-is. **→ feeds Phase 0.5 (SDK gap) below.**

### Integration verification (post-merge, on `fix/2605-review`)

| Gate | Result |
|---|---|
| `pnpm build:sdk` | 6/6 packages built ✅ |
| `pnpm --filter @arcaai/ui build` | dist rebuilt ✅ |
| `pnpm --filter @arcaai/vox test` | **143 files / 3036 passed** ✅ |
| `pnpm --filter @arcaai/ui-playground type-check` | **0 errors** ✅ |
| `pnpm --filter @arcaai/ui-playground test` | **92 failed / 595 passed** — = TASK-321 baseline, **+6 new passing, 0 new failures** ✅ |

### Carried into the backlog
- **Phase 0.5 (new):** expose `addWorknote` / `addAttachment` (or a batched context write) on the public `@arcaai/vox` context surface so D6's 3 raw `CONTEXT_ENDPOINTS` sites can converge in Wave 2.
- Pre-existing baselines untouched: 12 pre-existing `tsc` errors in SDK test files (TASK-321-style scoping) and the 5 TASK-321 failing app test files.

---

## 5. Verification Gates

```
# SDK (Phase 0)
pnpm build:sdk
pnpm --filter @arcaai/vox test                 # must stay green (~2957 baseline)

# App (all phases)
pnpm --filter @arcaai/ui check-types            # rebuild @arcaai/ui dist (TASK-321 gate dep)
pnpm --filter @arcaai/ui-playground type-check  # = 0 errors (TASK-321 baseline)
pnpm --filter @arcaai/ui-playground test        # no NEW failures vs known 92/5-file baseline
pnpm --filter @arcaai/applications test         # TASK-319 regression guard stays green
# ReadLints on every edited file → clean
```

Per-phase: run the touched suite (RED→GREEN) + `ReadLints` on edited files before proceeding.

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-01 | Ticket created. Reviewed ui-playground ↔ `@arcaai/vox` ↔ `apps/api` consumption (evidence-based, file:line). Identified the parallel-implementation drift, the SDK coverage gap (TASK-320 A1 / TASK-318 R9 unfinished), 7 drift risks (D1–D7), and produced a 6-phase migration plan with verification gates. Status `Pending` — awaiting decisions in §3.6. | this README |
| 2026-06-01 | **Wave 1 merged** to `fix/2605-review` via 2 disjoint parallel worktrees (orchestrator serialized-merge S→T, then teardown). **S/Phase 0** (`2f78f1c7`): 6 endpoint-constant groups, 5 hooks, `session.update()`. **T/app** (`f0518c30`): D2 SMR impersonation tenant, D3/D7 pagination + `useTenants` collision; D6 left as-is (no public SDK equivalent → new Phase 0.5). Integration green: SDK 3036 pass, app type-check 0, app tests 0 new failures (+6). Status → `In Progress`. | `packages/agentic-sdk-v2/*`, `apps/ui-playground/src/features/{admin,summarization}/*`, this README |
