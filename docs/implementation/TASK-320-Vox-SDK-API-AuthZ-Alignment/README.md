# TASK-320 — `@arcaai/vox` SDK: API Alignment + AuthZ/Impersonation Hardening

| | |
|---|---|
| Ticket Number | TASK-320 |
| Parent / Origin | Follow-up to TASK-319 (API Access-Scope Hardening, commit `dcc58a02`) |
| Created | 2026-05-31 |
| Updated | 2026-05-31 |
| Status | In Progress — B2 + B5 implemented & merged to `fix/2605-review`; A3 delivered via the backend consultation-lifecycle ticket; B1/B3/A1/A2/A4/A5/B6/B7/B8 remain |
| Type | Bugfix + Enhancement (SDK ↔ API alignment, auth/impersonation correctness) |
| Branch | `fix/2605-review` (proposed) |
| Scope | `packages/agentic-sdk-v2/` (`@arcaai/vox`). Cross-cutting note: F-A3 has an `apps/api` dependency (see §3.4). |

---

## 1. Requirement Analysis

### 1.1 Description

TASK-319 reshaped the API gateway's end-user vs admin surface (new `/admin/consultations`
and `/admin/audio/transcription-jobs` controllers; end-user transcription-job reads became
owner-scoped; `/prompt-templates` → `/admin/prompt-templates`). The `@arcaai/vox` SDK is the
primary consumer of that API. This ticket reviews the SDK and fixes:

1. **Hooks / methods / API integrations** — confirm every endpoint the SDK calls still exists,
   add bindings for the new admin endpoints, and resolve drift / dead code.
2. **Authentication / authorization / impersonation** — confirm the SUPER_ADMIN and
   TENANT_ADMIN flows (login, token refresh, tenant context, and impersonation) are correct
   end-to-end.

The review below is **evidence-based**: every finding was verified against current source
(`file:line` cited). Two findings reported by automated exploration were checked and
**rejected** as false (see §2.3) to avoid acting on incorrect facts.

### 1.2 Business context

- Tenant admins / super admins cannot supervise tenant-wide clinical activity **through the
  SDK** — the admin dashboards have no SDK hook for the new tenant-wide consultation /
  transcription-job lists TASK-319 added.
- A super admin impersonating a user in **another tenant** currently sends the **admin's own
  tenant** in `X-Tenant-ID` for every HTTP request — a correctness/isolation defect.
- Core consultation lifecycle calls (`close`, `reopen`) hit endpoints that **do not exist** and
  fail at runtime.

### 1.3 Findings summary (severity-ranked, all verified)

| # | Sev | Area | Finding (one line) |
|---|---|---|---|
| **A1** | High | Integrations | No SDK binding for new admin endpoints `GET /admin/consultations(/:id)` and `GET /admin/audio/transcription-jobs(+/stats,/status/:status)`. |
| **A2** | High | Integrations | End-user `GET /audio/transcription-jobs` (+ `/stats`, `/status/:status`) is now **owner-scoped** server-side; SDK callers silently under-return (was tenant-wide). |
| **A3** | High | Integrations | `useArcaSession.close()`/`reopen()` call `POST /consultations/:id/close` and `/reopen`, and `CONSULTATION_ENDPOINTS.UPDATE` → `PATCH /consultations/:id` — **none exist in the backend** → runtime 404. |
| **B1** | High | Impersonation | `X-Tenant-ID` is **not** switched to the impersonated user's tenant; the provider syncs from `config.api.tenantId`, not `effectiveTenantId`. |
| **B2** | Medium | Auth | `setOnUnauthorized` (401→refresh mutex) is **never wired inside the SDK**; token auto-refresh (incl. impersonated token) is inert unless the host app wires it. |
| **B3** | Medium | Impersonation | `ImpersonateResponse.user.tenantId` is optional and unvalidated; if omitted, tenant context silently falls back to the admin's tenant. |
| **B5** | Medium | WS auth | `SttV2WebSocketClient.requireTenantClaim` defaults `false`; streaming may open without a tenant claim. |
| **A4** | Medium | Hygiene | Dead/deprecated SDK surface: `analyzeDNA` stub throws; `useRoles` deprecated aliases; unused `DNA_STYLE_ENDPOINTS` admin + `ROLE_ENDPOINTS.USER_ROLES` constants. |
| **A5** | Low | Clarity | `useStorage`/`useMonitoring` labelled "admin" but not under `/admin`; scope intent undocumented. |
| **B6** | Low | Auth | `/auth/revoke-impersonation` not in `REFRESH_SKIP_ENDPOINTS` → a 401 there triggers a stray refresh attempt. |
| **B7** | Low | Impersonation | `endImpersonation` swallows a failed server-side revocation; impersonated JWT may stay valid until natural expiry. |
| **B8** | Trivial | Docs | Stale `clearImpersonation()` reference in `AgenticClient` comment (no such export). |
| **B4** | — | Impersonation | **Verified correct, no action.** `IMPERSONATION_ROLES = ['SUPER_ADMIN','TENANT_ADMIN']` matches the seeded role set (no `PLATFORM_ADMIN` role exists). |

### 1.4 Acceptance criteria

1. The SDK exposes typed bindings + hooks for `GET /admin/consultations(/:id)` and
   `GET /admin/audio/transcription-jobs(+/stats,/status/:status)`; a TENANT_ADMIN/SUPER_ADMIN
   can list tenant-wide data via the SDK; a plain DOCTOR is denied by the server (403) and the
   hook surfaces it cleanly. *(A1)*
2. The owner-scoped semantics of the end-user transcription-job reads are documented in the
   SDK, and any admin consumer is pointed at the new admin hooks. *(A2)*
3. `useArcaSession.close()`/`reopen()` and `CONSULTATION_ENDPOINTS.UPDATE` either resolve to a
   real backend route or are removed/guarded — no SDK method 404s by construction. *(A3, see §3.4)*
4. During impersonation, every HTTP request carries the **impersonated user's** `X-Tenant-ID`;
   on `endImpersonation`, it reverts to the admin's tenant. *(B1)*
5. `ImpersonateResponse.user.tenantId` is validated; a missing tenant fails closed (no silent
   fallback to the admin tenant). *(B3)*
6. Token auto-refresh works without host-app glue, or the requirement to wire
   `setOnUnauthorized` is made explicit and documented + tested. *(B2)*
7. WS streaming requires a resolvable tenant claim by default (or the provider wires it). *(B5)*
8. Dead/deprecated SDK surface is removed or wired; classifications documented. *(A4, A5)*
9. All changes are TDD; `@arcaai/vox` builds (`pnpm build:sdk`) and the full SDK suite passes;
   no new lint errors.

---

## 2. Current State Evaluation

> Global API prefix is `/api/v1`; SDK paths below omit it (the `baseUrl` carries it).
> The single source of truth for SDK endpoint strings is
> `packages/agentic-sdk-v2/src/core/constants.ts`.

### 2.1 Group A — hooks / methods / API integrations

**A1 — new admin endpoints have no SDK binding.** TASK-319 added
`AdminConsultationController` (`@Controller('admin/consultations')`, `@CanManage('Consultation')`)
and `AdminTranscriptionJobController` (`@Controller('admin/audio/transcription-jobs')`,
`@CanManage('Tenant')`). `constants.ts` has **no** `ADMIN_CONSULTATION_ENDPOINTS` group and no
admin override for transcription-job listing; no hook calls them. The SDK therefore cannot
serve the tenant-admin "see all in tenant" use case TASK-319 created.

**A2 — silent behavior change on end-user transcription-job reads.** TASK-319 F3 made
`GET /audio/transcription-jobs`, `/stats`, `/status/:status` owner-scoped
(`listForOwner`/`getStatusCountsForOwner`/`getByStatusForOwner`, keyed on `createdBy = caller`).
The SDK still calls the same paths via `STT_V2_ENDPOINTS.LIST_JOBS` / `JOB_STATS` /
`JOBS_BY_STATUS` (`core/TranscriptionJobService.ts`) with no indication results are now
owner-only. Same URL, same 200 — narrower dataset. Any admin view built on these returns only
the caller's own jobs.

**A3 — orphaned consultation lifecycle endpoints (VERIFIED runtime 404).**
`useArcaSession.close()` calls `CONSULTATION_ENDPOINTS.CLOSE(id)` →
`POST /consultations/:id/close` (`hooks/useArcaSession.ts:230`); `reopen()` calls
`REOPEN(id)` → `POST /consultations/:id/reopen` (`useArcaSession.ts:255`);
`CONSULTATION_ENDPOINTS.UPDATE(id)` → `PATCH /consultations/:id`. The consultation controller
uses a custom `@ApiEndpoint({ method, path })` decorator; its **complete** route list (verified
in `apps/api/src/modules/consultation/consultation.controller.ts`) is:
`open`, `:id` (GET), `patient/:patientId/history`, `patient/:patientId/date/:date`, `:id/chain`,
`:id/timeline`, and the `:id/context*` / `:id/summary*` / `:id/named-entities` families.
There is **no** `:id/close`, **no** `:id/reopen`, and **no** `PATCH :id`. A whole-`apps/api/src`
search for `reopen` / `:id/close` finds only unrelated WebSocket "close" handlers. These SDK
methods 404 at runtime.

**A4 — dead/deprecated surface.**
- `useArca().analyzeDNA` / `useArcaSummary().analyzeDNA` — `@deprecated` stub that **throws**.
- `useRoles`: `getUserRoles` / `assignRole` / `removeRole` — `@deprecated` (TASK-279), `console.warn`,
  delegate to canonical methods.
- `constants.ts`: `DNA_STYLE_ENDPOINTS` admin entries (`/admin/dna-writing-styles/...`) and
  `ROLE_ENDPOINTS.USER_ROLES` / `USER_ROLE` (`/users/:id/roles`) are defined but have **no hook
  consumer** today.

**A5 — classification clarity.** `useStorage` and `useMonitoring` file headers say "admin"
but their endpoints are not under `/admin/` (`/storage/*`, `/monitoring/*`). Storage is
tenant-scoped at the API layer (TASK-318); intent should be documented to avoid future
mis-gating.

### 2.2 Group B — authentication / authorization / impersonation

**B1 — `X-Tenant-ID` not switched during impersonation (VERIFIED).**
`providers/AgenticProvider.tsx:526` computes the correct value:
```
const effectiveTenantId = impersonated?.tenantId ?? authUser?.tenantId ?? configRef.current.api.tenantId ?? null;
```
It is used for IndexedDB/namespace keys (`:535`) and the rehydration effect (`:645`). **But** the
synchronous client sync writes the **static config** tenant, not `effectiveTenantId`:
```
651  if (config.api.tenantId) {
652    if (client.getTenantId() !== config.api.tenantId) {
653      client.updateTenantId(config.api.tenantId);   // ← ignores impersonation
654    }
655  } else if (client.getTenantId()) { client.clearTenantId(); }
```
Note the **token** sync immediately below is impersonation-aware (`:659 const isImpersonating …`,
`:661 if (!isImpersonating)`), but the tenant sync is not — an asymmetry. Result: a SUPER_ADMIN
impersonating a user in another tenant keeps sending the admin's tenant on every
`AgenticClient` request (`core/AgenticClient.ts:196-198`, also duplicated in `postFormData:548`
and `uploadFormData:680`).

**B2 — `setOnUnauthorized` never wired by the SDK (VERIFIED).** `AgenticClient` implements the
401→refresh single-flight mutex (`deduplicatedRefresh`, `:861`) and exposes
`setOnUnauthorized` (`:880`), but a source-wide search shows **no caller** in the SDK
(`AgenticProvider`/`useAuth` never call it). Token expiry → hard 401 unless the host app wires
it; an expiring impersonated token has no refresh path.

**B3 — optional/unvalidated impersonated tenant.** `types/auth.ts`:
`ImpersonateResponse.user: AuthUser & { tenantId?: string }`. If the backend omits `tenantId`,
`effectiveTenantId` silently falls back to the admin's tenant (compounding B1).

**B5 — WS tenant claim opt-in.** `core/SttV2WebSocketClient.ts` `requireTenantClaim` defaults
`false` (TASK-317 AC-10), so a streaming session can open without a resolvable tenant claim.

**B6 / B7 / B8** — minor: `/auth/revoke-impersonation` missing from `REFRESH_SKIP_ENDPOINTS`
(`AgenticClient.ts:104`); `endImpersonation` swallows a failed revocation
(`hooks/useAuth.ts:202-209`); stale `clearImpersonation()` comment (`AgenticClient.ts:27`).

**What is already correct (no action):**
- **`/admin/prompt-templates` (TASK-319 F4) is already synced** — `PROMPT_TEMPLATE_ENDPOINTS`
  uses `/admin/prompt-templates` (comment cites TASK-319 F4); `usePrompts` matches. No drift.
- Impersonation token isolation via module-level `WeakMap` (`AgenticClient.ts:30`,
  `startImpersonation`/`stopImpersonation` `:902-944`) — token never enters the store / structured
  clone / replays.
- SSE auth via single-use stream tickets (`SSEClient` → `POST /auth/stream-ticket`); WS auth via
  one-shot session tickets + refresh-ticket; per-tenant BroadcastChannel + HKDF HMAC subkey
  rotation on tenant switch.
- **B4:** `IMPERSONATION_ROLES = ['SUPER_ADMIN','TENANT_ADMIN']` (`useAuth.ts:18`) matches the
  seeded roles (`seed/03-role.ts`: SUPER_ADMIN, TENANT_ADMIN, DOCTOR, NURSE, SERVICE_ACCOUNT,
  DEPARTMENT_HEAD). No `PLATFORM_ADMIN` exists, so the list is complete. (`canImpersonate` is a
  client display hint; the server `@CanManage` guard is the real boundary — acceptable.)

### 2.3 Automated-exploration claims that were checked and REJECTED

- *"`open`/`getById` use no decorator / controller has no routes"* — false; the controller uses
  a custom `@ApiEndpoint` decorator (`consultation.controller.ts:278`), so `@Get/@Post` greps
  miss it. (A3 was re-verified by enumerating the actual `path:` list instead.)
- *"`IMPERSONATION_ROLES` missing `PLATFORM_ADMIN`"* — false; no such role exists (see B4).

---

## 3. Implementation Plan (TDD)

Sequenced by risk: correctness/security first (Wave 1), new admin surface (Wave 2), hygiene
(Wave 3). Every task: write the failing test (RED) → minimal implementation (GREEN) → run the
touched suite + `ReadLints`. Test root: `packages/agentic-sdk-v2/src/**/__tests__/`.

### Wave 1 — auth/impersonation + integration correctness (highest value, mostly non-breaking)

**T1 (B1) — switch `X-Tenant-ID` to the impersonated tenant.**
- Files: `src/providers/AgenticProvider.tsx`; test `src/providers/__tests__/AgenticProvider.impersonation-tenant.test.tsx` (new).
- Change the client tenant-sync block to use `effectiveTenantId` instead of `config.api.tenantId`:
  ```ts
  if (effectiveTenantId) {
    if (client.getTenantId() !== effectiveTenantId) client.updateTenantId(effectiveTenantId);
  } else if (client.getTenantId()) {
    client.clearTenantId();
  }
  ```
- RED test: render provider with `authUser.tenantId = 'T-admin'`, then set
  `authImpersonatedUser.tenantId = 'T-other'`; assert `apiClient.getTenantId() === 'T-other'`;
  after `endImpersonation`, assert it reverts to `'T-admin'`.

**T2 (B3) — validate impersonated tenant; fail closed.**
- Files: `src/hooks/useAuth.ts` (in `impersonate`), `src/types/auth.ts`; extend
  `src/hooks/__tests__/useAuth*.test.ts`.
- After `POST /auth/impersonate`, if `data.user.tenantId` is absent/empty, do **not** mutate the
  token/store; throw a typed `AgenticError('VALIDATION_ERROR', …)` and leave the admin session
  intact. RED test asserts a missing `tenantId` rejects and no impersonation state is set.

**T3 (B2) — first-class token-refresh wiring.**
- Files: `src/providers/AgenticProvider.tsx` (wire `apiClient.setOnUnauthorized` to a handler that
  calls `useAuth.refreshToken` / `POST /auth/refresh`), or a small `useAutoRefresh` hook mounted
  by the provider; test `src/providers/__tests__/AgenticProvider.refresh.test.tsx` (new).
- RED test: a 401 on a normal GET triggers exactly one refresh (single-flight) and one retry;
  refresh failure propagates the original 401. Decision to confirm in review: auto-wire vs.
  documented opt-in (AC-6 allows either, default to auto-wire).

**T4 (B6, B8) — trivial auth hygiene.**
- Add `/auth/revoke-impersonation` to `REFRESH_SKIP_ENDPOINTS` (`AgenticClient.ts:104`); remove the
  stale `clearImpersonation()` comment (`:27`). Extend the existing skip-list test.

### Wave 2 — new admin surface (A1) + scope documentation (A2)

**T5 (A1) — admin endpoint constants.**
- File: `src/core/constants.ts`. Add `ADMIN_CONSULTATION_ENDPOINTS`
  (`LIST = '/admin/consultations'`, `GET(id) = '/admin/consultations/${id}'`) and admin
  transcription-job endpoints (`ADMIN_TRANSCRIPTION_JOB_ENDPOINTS.LIST = '/admin/audio/transcription-jobs'`,
  `STATS`, `BY_STATUS(status)`). Mirror the TASK-319 F4 comment convention. Extend the
  `constants.*.test.ts` path assertions.

**T6 (A1) — admin hooks.**
- Files: `src/hooks/useAdminConsultations.ts` (new) and
  `src/hooks/useAdminTranscriptionJobs.ts` (new); barrel exports in `src/index.ts` (+ `core.ts`);
  tests under `src/hooks/__tests__/`.
- `useAdminConsultations`: `list({ page, pageSize, patientId?, doctorId?, departmentId? })` →
  `GET /admin/consultations`; `get(id)` → `GET /admin/consultations/:id`. Compose
  `useApiOperation` (matches `usePrompts`/`useUsers`). RED tests assert correct path + params and
  that a server 403 (plain doctor) surfaces as a clean `AgenticError`.
- `useAdminTranscriptionJobs`: `list`, `stats`, `byStatus(status)` → the admin paths.

**T7 (A2) — document owner-scoping + route admin consumers.**
- Files: `src/core/TranscriptionJobService.ts` + `STT_V2_ENDPOINTS` doc comments; note that
  `LIST_JOBS`/`JOB_STATS`/`JOBS_BY_STATUS` are **owner-scoped** since TASK-319 F3 and that admins
  must use `useAdminTranscriptionJobs`. No behavior change to end-user calls. Add/extend a test
  asserting the doc-contract via the constants.

### Wave 3 — hygiene (A4, A5, B5, B7)

**T8 (A4) — remove dead code.** Delete the `analyzeDNA` stubs (`useArca`, `useArcaSummary`) and
the unused `DNA_STYLE_ENDPOINTS` admin / `ROLE_ENDPOINTS.USER_ROLES` constants if confirmed
unconsumed; keep the `useRoles` deprecated aliases until the next major (note in code).
Update tests/exports; verify no import breaks.

**T9 (A5) — document scope.** Add header doc-comments clarifying `useStorage`/`useMonitoring`
are tenant-scoped server-side (not `/admin`-gated).

**T10 (B5) — WS tenant claim.** Have `AgenticProvider` pass `requireTenantClaim: true` (or the
effective tenant) when constructing WS/streaming clients; RED test asserts a tenant-less connect
rejects before opening a socket. (Default-flip is behavior-affecting → confirm in review.)

**T11 (B7) — surface revocation failure.** In `endImpersonation`, retain local cleanup but log +
optionally re-throw a non-fatal warning the caller can observe; test the failure path.

### 3.4 Cross-cutting decision — A3 (close/reopen/update)

`close`/`reopen`/`PATCH :id` are **missing on the backend**, so the SDK cannot be "fixed" in
isolation. Options (confirm before implementing):
- **(a) Backend adds the routes** (separate `apps/api` task: `POST /consultations/:id/close`,
  `/reopen`, `PATCH /consultations/:id` on `ConsultationController` with owner/`@CanManage`
  checks) — keeps the SDK API; requires a backend ticket.
- **(b) SDK removes/guards** `close()`/`reopen()`/`UPDATE` until the backend supports them —
  smallest surface, but drops a product capability.

Recommendation: confirm with PO whether consultation close/reopen is a required capability. If
yes → open a backend ticket and keep the SDK methods (add SDK tests once routes land). If no →
remove the SDK methods + constants under this ticket.

### 3.5 Testing strategy & gates

- Per task: `pnpm --filter @arcaai/vox test <file>` (RED→GREEN) + `ReadLints` on edited files.
- Final gates: `pnpm build:sdk`; `pnpm --filter @arcaai/vox test` (full suite, currently 2948
  passing — must stay green); `pnpm --filter @arcaai/vox type-check` for files this ticket edits.
- No DB/domain changes in the SDK scope (A3 option (a) would be a separate backend ticket with
  its own layer gates).

---

## 4. Implementation Summary

> Partial. This round implemented the two **default-changing** findings the PO prioritised
> (**B2**, **B5**) and resolved **A3** via a dedicated backend ticket. The remaining findings
> (B1, B3, A1, A2, A4, A5, B6, B7, B8 / tasks T1–T2, T4–T11) are **not yet implemented**.

### 4.1 B2 — auto-wired token refresh (DONE, merged)

Implemented as a body-based refresh (the API's `auth.controller.ts` `refresh()` is `@Public()`,
reads `{ refreshToken }` from the body, and returns a rotated `{ token, refreshToken }`):

- `src/core/AgenticClient.ts` — module-level `refreshTokens` `WeakMap` +
  `setRefreshToken`/`getRefreshToken`/`hasRefreshToken`/`clearRefreshToken` (mirrors the
  impersonation-token discipline — never in localStorage / store / structured clone).
- `src/hooks/useAuth.ts` — captures the refresh token on `login`, clears it on `logout`.
- `src/providers/AgenticProvider.tsx` — registers an idempotent `onUnauthorized` handler
  (guarded effect keyed on the client instance). On a 401 it POSTs `/auth/refresh` with the
  in-memory token, calls `updateAccessToken` + rotates the stored refresh token, and returns
  `true` (one retry). It returns `false` while impersonating (admin session not clobbered) or
  when no refresh token is held; `/auth/refresh` is in `REFRESH_SKIP_ENDPOINTS` so refresh
  cannot recurse.

### 4.2 B5 — default-on WS tenant claim (DONE, merged)

- `src/core/SttV2WebSocketClient.ts` — `requireTenantClaim` effective default flipped to `true`
  (the explicit `requireTenantClaim: false` escape hatch is preserved).
- `src/core/StreamingSessionManager.ts` — `getWebSocketUrl()` now always appends `tenantId`
  from `apiClient.getTenantId()` (the SDK's only real connect site,
  `StreamingBackendSTTProvider`, calls `connect(url)` with no options, so the claim must live in
  the URL).

### 4.3 A3 — consultation lifecycle endpoints (DONE on the backend, separate ticket)

A3 could not be fixed in the SDK alone (the routes did not exist server-side). Delivered as a
backend ticket — `docs/implementation/TASK-322-Consultation-Lifecycle-Endpoints/`
(renumbered from TASK-321 to resolve a collision with the parallel
`TASK-321-UI-Playground-TypeCheck-Baseline` ticket — see §5) — which added
`POST /consultations/:id/close`,
`POST /consultations/:id/reopen`, and `PATCH /consultations/:id` (Controller → Service → mapper/DTO,
owner-gated). The SDK methods `useArcaSession.close()`/`reopen()` and `CONSULTATION_ENDPOINTS.UPDATE`
now resolve to real routes. SDK-side tests/bindings for these routes remain a follow-up under this
ticket.

### 4.4 Verification (captured)

- **SDK (isolated branch):** `turbo run build --filter=@arcaai/vox` → 6/6; full suite
  **2957 passing / 0 failing** (baseline 2948).
- **Integrated `fix/2605-review` after merge:** `pnpm build:api` → 8/8 tasks;
  `pnpm build:sdk` → 6/6 tasks (the latter also compiled the parallel uncommitted
  `ConfigManager.ts` WIP cleanly).

### 4.5 Not yet implemented (remaining scope)

B1 (impersonation `X-Tenant-ID`), B3 (validate impersonated tenant), A1 (admin hooks/constants),
A2 (owner-scope docs), A4 (dead code), A5 (scope docs), B6/B7/B8 (auth hygiene). Tasks T1–T2 and
T4–T11 from §3 remain open.

---

## 5. Change History

| Date | Change | Files |
|---|---|---|
| 2026-05-31 | Ticket created. SDK review complete (12 verified findings + 1 verified-correct); plan drafted. Built on TASK-319 (`dcc58a02`). | this README |
| 2026-05-31 | **B2 + B5 implemented** (isolated worktree, commit `842ca848`) and merged to `fix/2605-review` (merge `64b19c13`). Auto-wired body-based token refresh; flipped WS `requireTenantClaim` default-on with SDK streaming always supplying the claim. SDK suite 2948→2957 green. | `AgenticClient.ts`, `useAuth.ts`, `AgenticProvider.tsx`, `SttV2WebSocketClient.ts`, `StreamingSessionManager.ts` + tests |
| 2026-05-31 | **A3 delivered on the backend** (commit `aa883a73`, merge `3d49da96`): `POST /consultations/:id/close`, `/reopen`, `PATCH /consultations/:id`. Filed first as `TASK-321-Consultation-Lifecycle-Endpoints`, which collided with the user's parallel **Completed** `TASK-321-UI-Playground-TypeCheck-Baseline` (its number is baked into uncommitted ui-playground WIP). | docs |
| 2026-05-31 | **Collision resolved**: renumbered the consultation ticket `TASK-321` → **TASK-322** (folder renamed + self-refs updated in the 10 consultation/api files; comments/JSDoc/decorator-description/test-names only — no functional change). UI-Playground TASK-321 left untouched. | `docs/implementation/TASK-322-Consultation-Lifecycle-Endpoints/` + 9 consultation/api files |
