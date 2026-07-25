# Clinical Workspace Realtime Upgrade + Review Merge + Admin Live Console

| | |
|---|---|
| **Ticket** | TASK-341 |
| **Name** | Clinical Workspace Realtime Upgrade + Review Merge + Admin Harness "Live" Console |
| **Created** | 2026-06-08 |
| **Updated** | 2026-06-08 |
| **Status** | Completed (live end-to-end with real STT/SMR/NLP pending GPU/model host — see §7, same posture as TASK-340) |
| **Cross-ref** | **TASK-339** (Clinical Workflow Playground — ships the cockpit + `LiveDocumentationService`), **TASK-340** (Live SOAP Hardening — the realtime engine this console observes/controls), TASK-330 (Clinical Documentation Harness — owns `/admin/harness/*`), TASK-319 (admin consultation surface), TASK-263/307 (`/auth/stream-ticket`, SSE auth), TASK-331/340-Impersonation (admin-plane token routing) |
| **Plan** | `.cursor/plans/workspace_realtime_upgrade_admin_live_ffde0a77.plan.md` (source of truth — not edited) |
| **Migration** | **None** — metrics + kill-switch are transient via Redis (no Prisma model/enum). |

> Delivered as two workstreams in one ticket. **(A)** Consolidate the doctor cockpit: fully absorb the standalone *Clinical Review* feature into *Clinical Workspace* and retire the standalone route, and surface a read-only live-engine status. **(B)** Add an admin Harness **"Live"** console for tenant-admins to monitor active consultations' live SOAP in real time and for super-admins to observe/kill the realtime engine — which required new backend endpoints + Redis-published stats + a runtime kill-switch.

---

## 1. Requirement Analysis

### Description
- **Workstream A (frontend, `apps/ui-playground`)** — the realtime live-SOAP engine hardened under [TASK-340](../TASK-340-Live-SOAP-Hardening/README.md) is already wired into the cockpit via `useRealtimeTranscription` + `useLiveSummaryStream`. The "upgrade" is **integration + UX consolidation + status surfacing**, not a new STT/SMR engine: merge the seven presentational *clinical-review* components into *clinical-workspace*, retire the standalone `/clinical-review` route (a pure `SAMPLE_REVIEW` fixture demo) and its sidebar entry, and add a read-only live-engine status indicator to the cockpit.
- **Workstream B (backend + admin frontend)** — give admins cross-instance visibility/control of the engine: publish PHI-safe per-session stats to Redis on each flush, expose tenant-scoped admin endpoints to read them, add a SUPER_ADMIN runtime kill-switch (env default + Redis override, no redeploy), harden `/auth/stream-ticket` with a mint-time tenant-ownership check, and ship an admin "Live" page (sessions table + live-SOAP viewer reusing the doctor `LiveSummaryPanel` + engine kill-switch controls).

### Business context
The live-SOAP loop drives a doctor-facing cockpit but, until now, ops had **no admin-plane window** into it: no way to see which consultations are actively recording, how the SMR/NLP loop is performing, or to disable the engine without a redeploy. The standalone *Clinical Review* surface was a fixture-only demo duplicating components that belong in the unified workspace flow. This ticket consolidates the doctor UX and adds the admin observability + control plane, reusing the existing SSE relay and Redis client patterns (no new datastore, no migration).

### Acceptance criteria
- `/clinical-review` route + sidebar entry are gone; the seven review components + their tests live under `clinical-workspace`; the merged review still renders inside `review-panel`.
- The cockpit shows a read-only live-engine status (idle / connecting / open / closed / error + last-updated); ops controls stay in the admin console.
- On each flush the engine writes a PHI-safe `live-doc:stats:{consultationId}` snapshot (sizes/latencies/counts only) and adds the id to `live-doc:active:{tenantId}`; both are cleared on stop / self-heal on expiry.
- Tenant-admins can list/read active sessions for **their** tenant (defense-in-depth tenant match at the service layer); super-admins act cross-tenant via `X-Tenant-Id`.
- Super-admins can read + toggle the engine kill-switch globally; the override persists across restart and fans out to all API instances.
- `/auth/stream-ticket` re-checks, at mint time, that a `consultation_live_summary:<id>` scope belongs to the caller's active tenant; a super-admin's selected `X-Tenant-Id` propagates into the ticket.
- Gates pass: applications build, api build, applications unit tests, ui-playground build + unit tests, `ReadLints` clean on changed files (§6).

### Out of scope (per plan)
- New Prisma models/enums (metrics + flags are transient via Redis).
- Token-by-token streaming SOAP (still out, per TASK-340).
- Changing the doctor cockpit's impersonation/SDK auth model.
- Extracting the live-doc UI into `@arcaai/vox` beyond what the merge requires (review/live types already originate in `@arcaai/vox`).

---

## 2. Current State Evaluation

- **Engine (TASK-340)** — `LiveDocumentationService` computes per-flush metrics (`flushCount`, `smr/nlpLatencyMs`, `smr/nlpFailed`, `staleDropCount`, `generation`, `lastUpdatedAt`) but they were **log-only**; nothing was queryable cross-instance. `LIVE_DOC_ENABLED` was read **once** at construction (no runtime toggle).
- **SSE relay** — generic and already cross-instance-correct: `GET /consultations/:id/live-summary/stream?ticket=` (TASK-340) + recording lifecycle on `consultation.controller.ts`. Reused unchanged.
- **Doctor UI** — the cockpit (`features/clinical-workspace/`) already consumes the hardened event via `useLiveSummaryStream`; `mapProvenanceToReviewData` already lives in the workspace. The *clinical-review* feature was a separate `SAMPLE_REVIEW` fixture demo (route + 7 components), all of whose types come from `@arcaai/vox` → no type conflicts on the move.
- **Admin Harness** — `HarnessAdminController` (`/admin/harness/*`, TASK-330) already establishes the `@Authorize` + CLS tenant-resolution + super-admin-via-`?tenantId=` pattern; `AdminConsultationController` (TASK-319) lists tenant consultations. Both extended here.
- **Stream tickets** — `POST /auth/stream-ticket` was `@Authorize()` with a free-form scope and **no mint-time ownership check**; the SSE route is `@TenantOwnedResource` but a ticket bypasses that interceptor → needed a defense-in-depth recheck.
- **adminClient** — had `stream()` but no ticket helper / no live-summary URL builder for the admin plane.

### Pre-existing working-tree context (not introduced by this ticket)
The working tree already carried **uncommitted [TASK-340](../TASK-340-Live-SOAP-Hardening/README.md) hardening** (its README, `soap-parser.ts`, `streamingAudioBridge.service.ts`, and large portions of `live-documentation.service.ts`) on which TASK-341 builds directly, plus unrelated env churn from a parallel Guardrail/LM-Studio effort and E2E test-config fixes. These are itemised in §7 so the TASK-341 diff is unambiguous.

---

## 3. Implementation Plan

TDD (RED → GREEN) per the workflow rules; layer order Database → Domain → Services → API → Frontend (no DB/Domain changes here). A1/A2 (merge) and B (backend + admin) were largely independent; within B, backend (B1→B4) preceded the admin frontend (B5→B6). `LiveSummaryPanel`'s final location (set by A1) is reused by B6.

| Todo | Scope |
|---|---|
| **A1** | Move 7 review components + 2 tests + fixture into `clinical-workspace/components/review/`; rewire `review-panel` imports; keep moved tests green. |
| **A2** | Delete the standalone route, demo page, `approveReviewedNote` stub, feature barrels; remove the "Clinician Review" sidebar entry. |
| **A3** | Surface a read-only live-engine status indicator in the cockpit; verify launch → cockpit → Review & sign → artifacts. |
| **B1** | Publish PHI-safe per-session stats to Redis on each flush; clear on stop. RED first. |
| **B2** | Tenant-scoped `GET /admin/harness/live/sessions` + `/:id`; `?status=` filter on the admin consultation list. RED first. |
| **B3** | Runtime kill-switch (env default + Redis override + control-channel fan-out); `GET/PATCH /admin/harness/live/config` (SUPER_ADMIN). RED first. |
| **B4** | Mint-time tenant-ownership check on `/auth/stream-ticket`; active-tenant precedence so super-admin `X-Tenant-Id` propagates. Document the auth model. |
| **B5** | adminClient `fetchStreamTicket` + live-summary URL builder + admin SSE hook. Unit-test ticket mint + SSE parse + closed/reconnect. |
| **B6** | Admin "Live" route + page: sessions table, click-through live-SOAP viewer reusing `LiveSummaryPanel`, kill-switch card; loading/empty/error/active states. |

### Testing strategy
- **A:** moved `review-screen.test.tsx` + `transcript-pane.test.tsx` keep passing; `review-panel.test.tsx` mock path rewired; a `clinical-review-retired.test.ts` asserts the route is gone; `cockpit.test.tsx` covers the status indicator.
- **B backend (vitest, RED first):** Redis `sadd/srem/smembers` (`redis-cache.service.test.ts`); stats publish/clear + `getActiveSessions`/`getSessionStats` tenant isolation + kill-switch override/fan-out (`live-documentation.service.test.ts`); `?status` parse/validation (`consultation.service.test.ts`, `admin-consultation.controller.test.ts`); live endpoints + `assertLiveConfigAdmin` (`harness-admin.controller.test.ts`); stream-ticket ownership + active-tenant precedence (`auth.controller.stream-ticket.test.ts`).
- **B frontend (vitest):** admin SSE hook ticket-mint + parse + reconnect/closed (`use-admin-live-summary-stream.test.ts`); admin Live page loading/empty/error/active + kill-switch (`live-page.test.tsx`).

---

## 4. Implementation Summary

### New / changed endpoints (controller-relative; global prefix `/api/v1`)
| # | Method + path | Returns | Auth |
|---|---|---|---|
| 1 | `GET /admin/harness/live/sessions` | `{ items: LiveDocSessionStatsResponse[], total }` | TENANT_ADMIN (`read HarnessWorkflow`), tenant-scoped; super-admin cross-tenant via `?tenantId=` / `X-Tenant-Id`. |
| 2 | `GET /admin/harness/live/sessions/:id` | `LiveDocSessionStatsResponse` | TENANT_ADMIN; `404` if absent / expired / cross-tenant. |
| 3 | `GET /admin/harness/live/config` | `{ enabled, envDefault, source, updatedAt?, updatedBy? }` | SUPER_ADMIN / global (`assertLiveConfigAdmin`). |
| 4 | `PATCH /admin/harness/live/config` | `LiveDocEngineConfigResponse` (body `{ enabled, reason? }`) | SUPER_ADMIN; persists Redis override + control-channel fan-out (no redeploy). |
| 5 | `GET /admin/consultations?status=RECORDING` | `PaginatedConsultationResponse` | TENANT_ADMIN (`@CanManage('Consultation')`); `400` on invalid enum value. |
| 6 | `POST /auth/stream-ticket` (hardened) | `IssueStreamTicketResponse` | `@Authorize()`; mint-time tenant-ownership recheck for `consultation_live_summary:<id>` scopes; active-tenant `X-Tenant-Id` propagates to `ticket.tenantId`. |

### Redis keys (transient; no migration)
| Key | Type | Purpose |
|---|---|---|
| `live-doc:stats:{consultationId}` | `SETEX` JSON | Per-session PHI-safe stats snapshot, TTL = `LIVE_DOC_STATS_TTL_SEC` (300s default), refreshed every flush. |
| `live-doc:active:{tenantId}` | Set (TTL-backstopped) | Active recording consultations for a tenant; `srem` on stop, self-healed when a member's snapshot has expired. |
| `live-doc:config:enabled` | persistent JSON | Kill-switch override `{ enabled, updatedAt, updatedBy, reason }` (survives restart). |
| `live-doc:config:control` | pub/sub channel | Fans a kill-switch toggle out to all API instances' in-memory mirror. |

### Authorization model (final)
- **Monitoring (endpoints 1, 2, 5)** = **TENANT_ADMIN**, tenant-scoped. The controller resolves the read tenant from CLS (`resolveReadTenantId`): a tenant-admin is pinned to its own tenant (passing a foreign `?tenantId=` → 403), a super-admin may target any tenant via `?tenantId=`/`X-Tenant-Id`. **Defense-in-depth:** `LiveDocumentationService.getActiveSessions/getSessionStats` re-filter every snapshot by `tenantId`, so a guessed cross-tenant consultation id returns nothing / 404.
- **Kill-switch (endpoints 3, 4)** = **SUPER_ADMIN / global scope** (`assertLiveConfigAdmin` → `isSuperAdmin`), matching the platform GLOBAL-DEFAULT policy routes.
- **Stream ticket (endpoint 6)** = any authed user, but with **active-tenant precedence** (`cls.tenantId || user.tenantId || null`, so a super-admin's selected `X-Tenant-Id` wins over an empty JWT tenant) and a **mint-time ownership recheck** (`assertLiveSummaryScopeOwnership`): a `consultation_live_summary:<id>` ticket is only issued when the consultation belongs to the caller's active tenant (missing OR cross-tenant → `404`, no existence leak), mirroring the SSE route's `@TenantOwnedResource`. The `impersonatedBy` claim still rides through the ticket for HIPAA audit.

### Files changed

**Workstream A — Clinical Workspace consolidation (`apps/ui-playground`)**

| File | Disposition | Purpose |
|---|---|---|
| `src/features/clinical-workspace/components/review/{review-screen,soap-note-panel,transcript-pane,claim-line,needs-attention-list,confidence-indicator,claim-status-badge}.tsx` | **new** | The 7 review components moved in from `clinical-review` (types from `@arcaai/vox`). |
| `src/features/clinical-workspace/components/review/__tests__/{review-screen,transcript-pane}.test.tsx` | **new** | Moved component tests, kept green. |
| `src/features/clinical-workspace/components/review/index.ts` | **new** | Barrel for the merged review components. |
| `src/features/clinical-workspace/fixtures/sample-review.ts` | **new** | Moved `SAMPLE_REVIEW` fixture (see deviation D1 — currently unreferenced). |
| `src/features/clinical-workspace/components/__tests__/cockpit.test.tsx` | **new** | Covers the read-only `LiveEngineStatus` indicator. |
| `src/components/layout/__tests__/clinical-review-retired.test.ts` | **new** | Asserts `/clinical-review` is retired (no route / no nav entry). |
| `src/features/clinical-workspace/components/cockpit.tsx` | modified | Adds the read-only `LiveEngineStatus` readout (idle/connecting/open/closed/error + last-updated); re-wraps panels in a grid. |
| `src/features/clinical-workspace/components/review-panel.tsx` | modified | Import rewired `@/features/clinical-review/components` → `./review`. |
| `src/features/clinical-workspace/components/__tests__/review-panel.test.tsx` | modified | Mock path updated to the local `./review`. |
| `src/components/layout/app-sidebar.tsx` | modified | Removed the "Clinician Review" nav entry + unused `ShieldCheck` import. |
| `src/routeTree.gen.ts` | modified (regenerated) | Drops `/clinical-review`, adds `/admin/harness/live` (shared with B6). |
| `src/features/clinical-review/**` (14 files) + `src/routes/_authenticated/clinical-review.tsx` | **deleted** | Standalone review surface retired (components, 2 tests, fixture, `approve-note.ts` stub, barrels, demo page, route). |

**Workstream B — backend (`packages/applications` + `apps/api`)**

| File | Disposition | Purpose |
|---|---|---|
| `packages/applications/.../live-documentation/dto/live-doc-admin.dto.ts` | **new** | `LiveDocSessionStatsResponse`, `LiveDocSessionsListResponse`, `LiveDocEngineConfigResponse`, `UpdateLiveDocEngineConfigRequest`. |
| `packages/applications/.../live-documentation/dto/index.ts` | modified | Re-exports the new admin DTO. |
| `packages/applications/.../live-documentation/live-documentation.service.ts` | modified | B1 `publishStats`/`clearStats` (stats snapshot + active set); B2 `getActiveSessions`/`getSessionStats` (tenant-isolated reads, self-heal); B3 runtime kill-switch (`isEngineEnabled`/`getEngineConfig`/`setEngineEnabled`, `onModuleInit` seed + `live-doc:config:control` fan-out). *(Also carries uncommitted TASK-340 hardening — see §7.)* |
| `packages/applications/.../live-documentation/__tests__/live-documentation.service.test.ts` | modified | RED→GREEN: stats publish/clear, tenant isolation, kill-switch override + fan-out. |
| `packages/applications/.../baseServices/redis/redis-cache.service.ts` | modified | Adds `sadd` / `srem` / `smembers` set operations. |
| `packages/applications/.../baseServices/redis/__tests__/redis-cache.service.test.ts` | modified | Tests for the new set operations. |
| `packages/applications/.../consultation/consultation.service.ts` | modified | Optional `status` filter on `listConsultationsForTenant`. |
| `packages/applications/.../consultation/IConsultationService.ts` | modified | `status?: ConsultationStatus` on the list params type. |
| `packages/applications/.../consultation/__tests__/consultation.service.test.ts` | modified | Covers the `status` filter. |
| `apps/api/.../harness-admin/harness-admin.controller.ts` | modified | 4 new `live/*` endpoints + `assertLiveConfigAdmin`. |
| `apps/api/.../harness-admin/harness-admin.module.ts` | modified | Imports `LiveDocumentationServiceModule`. |
| `apps/api/.../harness-admin/__tests__/harness-admin.controller.test.ts` | modified | Sessions list/single (tenant + 404) + config GET/PATCH (super-admin gate). |
| `apps/api/.../consultation/admin-consultation.controller.ts` | modified | `?status` query + `parseStatus` (400 on invalid enum). |
| `apps/api/.../consultation/__tests__/admin-consultation.controller.test.ts` | modified | `?status` pass-through + invalid-value rejection. |
| `apps/api/.../auth/auth.controller.ts` | modified | Active-tenant precedence + `assertLiveSummaryScopeOwnership` + `ConsultationRepository` injection. |
| `apps/api/.../auth/__tests__/auth.controller.stream-ticket.test.ts` | modified | Mint-time tenant-ownership + super-admin tenant propagation. |
| `.env.example`, `.env.dev` | modified (partial) | Add `LIVE_DOC_STATS_TTL_SEC=300` (the only TASK-341 env change — see §7). |

**Workstream B — admin frontend (`apps/ui-playground`)**

| File | Disposition | Purpose |
|---|---|---|
| `src/features/admin/harness/api/live.ts` | **new** | DTO mirrors, `fetchStreamTicket`, `buildLiveSummaryStreamUrl`, `liveApi`, TanStack query/mutation hooks + keys. |
| `src/features/admin/harness/live/use-admin-live-summary-stream.ts` | **new** | Admin SSE hook (mint ticket → open `EventSource` with `?ticket=` + `X-Tenant-Id`; closed/reconnect handling). |
| `src/features/admin/harness/live/index.tsx` | **new** | Live page: sessions table + live-SOAP viewer reusing `LiveSummaryPanel` + global-scope `EngineControlsCard` kill-switch. |
| `src/features/admin/harness/live/__tests__/use-admin-live-summary-stream.test.ts` | **new** | Ticket mint + SSE parse + closed/reconnect. |
| `src/features/admin/harness/live/__tests__/live-page.test.tsx` | **new** | Loading / empty / error / active states + kill-switch toggle. |
| `src/routes/_authenticated/admin/harness/live.tsx` | **new** | The `/admin/harness/live` route. |
| `src/features/admin/api/admin-client.ts` | modified | Exposes `getBaseUrl()` for the SSE URL builder. |
| `src/features/admin/harness/components/harness-tabs.tsx` | modified | Adds the "Live" tab. |

**Totals (TASK-341):** 20 new + 22 modified + 15 deleted = **57 source files**, plus `LIVE_DOC_STATS_TTL_SEC` added to `.env.example` / `.env.dev`. **No Prisma migration.**

---

## 5. Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-08 | **A1/A2** — merged 7 `clinical-review` components + 2 tests + fixture into `clinical-workspace/components/review/`; rewired `review-panel`; retired the standalone route, demo page, stub, barrels, and "Clinician Review" sidebar entry; added retired-route test. | review subtree (new), `review-panel.tsx`(+test), `app-sidebar.tsx`, `routeTree.gen.ts`, `clinical-review/**` (deleted), `clinical-review-retired.test.ts` (new) |
| 2026-06-08 | **A3** — read-only `LiveEngineStatus` indicator in the cockpit + `cockpit.test.tsx`. | `cockpit.tsx`, `cockpit.test.tsx` (new) |
| 2026-06-08 | **B1** — Redis `sadd/srem/smembers`; `publishStats`/`clearStats` (stats snapshot + active set). RED→GREEN. | `redis-cache.service.ts`(+test), `live-documentation.service.ts`(+test) |
| 2026-06-08 | **B2** — `getActiveSessions`/`getSessionStats` (tenant-isolated) + `live/sessions` endpoints; `?status` filter on the admin consultation list. RED→GREEN. | `live-documentation.service.ts`(+test), `harness-admin.controller.ts`(+test), `consultation.service.ts`(+test), `IConsultationService.ts`, `admin-consultation.controller.ts`(+test) |
| 2026-06-08 | **B3** — runtime kill-switch (env default + Redis override + control-channel fan-out); `GET/PATCH live/config` (SUPER_ADMIN) + `assertLiveConfigAdmin`; `LiveDocumentationServiceModule` wired into the harness-admin module; `LIVE_DOC_STATS_TTL_SEC` config. | `live-documentation.service.ts`(+test), `live-doc-admin.dto.ts`(+barrel), `harness-admin.controller.ts`(+test), `harness-admin.module.ts`, `.env.example`, `.env.dev` |
| 2026-06-08 | **B4** — `/auth/stream-ticket` active-tenant precedence + mint-time `assertLiveSummaryScopeOwnership` + `ConsultationRepository` injection; documented auth model. RED→GREEN. | `auth.controller.ts`(+stream-ticket test) |
| 2026-06-08 | **B5/B6** — adminClient `getBaseUrl`; `live.ts` (DTO mirrors + SSE plumbing + hooks); admin SSE hook; Live page (sessions + viewer + kill-switch) + route + "Live" tab. | `admin-client.ts`, `harness-tabs.tsx`, `live.ts` (new), `live/**` (new), `routes/.../admin/harness/live.tsx` (new), `routeTree.gen.ts` |
| 2026-06-08 | **verify-doc** — full integration gates run (§6); corrected the ui-playground unit-test invocation (`test`, not `test:unit` — see D4); README created; status → Completed. | this file |

---

## 6. Verification Evidence

All gates run from the repo root via zsh; real output captured (logs under `/tmp/gate*.log`). **Every gate passes; no code fixes were required** — the only deviation was the ui-playground test-script name (D4).

### Builds
```
$ pnpm build --filter @arcaai/applications
@arcaai/applications:build > rimraf dist tsconfig.tsbuildinfo && tsc
 Tasks:    7 successful, 7 total
  Time:    10.772s                       exit 0

$ pnpm build:api
@arcaai/api:build > rimraf dist && nest build && tsc-alias
 Tasks:    8 successful, 8 total
  Time:    20.781s                       exit 0

$ pnpm --filter @arcaai/ui-playground build
vite v7.3.1 — ✓ 14782 modules transformed
✓ built in 18.73s                        exit 0
# emits the new admin Live chunk (dist/assets/live-*.js); the >500 kB chunk
# warnings are pre-existing shiki/mermaid bundles, unrelated to this work.
```

### Unit tests
> Note (D4): `@arcaai/ui-playground` has **no `test:unit` script** — its unit-test script is `test` (`vitest run`). `pnpm --filter @arcaai/ui-playground test:unit` errors with `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`. The applications package *does* have `test:unit`. Both forms below use the script that exists for each package; in both cases `--filter` is applied at the **pnpm** level (never `pnpm test:unit --filter`, which forwards `--filter` to vitest and errors — per TASK-340).

```
$ pnpm --filter @arcaai/applications test:unit
 Test Files  209 passed | 1 skipped (210)
      Tests  4920 passed | 4 skipped (4924)
   Duration  24.20s                      exit 0

$ pnpm --filter @arcaai/ui-playground test     # = vitest run
 Test Files  141 passed (141)
      Tests  1185 passed (1185)
   Duration  10.87s                      exit 0
# ("Not implemented: navigation to another Document" is a jsdom log from the
#  clinical-review-retired navigation assertion — not a failure.)
```

### Lint (`ReadLints` on every changed/created file)
**No linter errors.** The only diagnostics are **6 pre-existing warnings** in `cockpit.tsx` (`min-h-[32rem]` / `lg:min-h-[34rem]` Tailwind-shorthand suggestions). The diff shows those exact classes were merely re-wrapped into a new grid `div`, not introduced by this work; per the surgical-change rule they are left as-is (warnings, not errors).

---

## 7. Deviations / Notes

### Flagged follow-ups (carried from the plan / workers)
- **D1 — moved `sample-review.ts` is unreferenced.** The retired demo page was its only consumer; the fixture was moved (not deleted) to preserve it for future review-component stories/tests. Currently dead; safe to delete if no story adopts it.
- **D2 — `LaunchPanel` DEMO seeds left as-is.** The cockpit launch still seeds `DEMO` patient/doctor ids (TASK-339 behaviour). Productionising this with real patient/doctor selection is an explicit, out-of-scope follow-up (plan A3, optional).
- **D3 — orphaned `data-testid="clinical-review-screen"`.** The moved `review-screen.tsx` still carries the old test id. Harmless (the retired-route test does not depend on it); rename to a workspace-scoped id in a future cleanup.
- **D4 — gate command corrected.** The plan's gate list said `pnpm --filter @arcaai/ui-playground test:unit`, but that script does not exist for ui-playground (only `test` = `vitest run`). The equivalent existing script was used; the unit-test intent is unchanged and all 1185 tests pass.
- **D5 — frontend admin scoping deviations (from the B5/B6 worker).** Tenant scoping is sent via the `X-Tenant-Id` header (not `?tenantId=`); the single-session endpoint (#2) is implemented backend-side but **not consumed** by the page (the table is fed by the list endpoint #1, the viewer by SSE); the `PATCH live/config` call omits the optional `reason`; `useAdminConsultations` was left untouched (the Live page uses the dedicated `live/sessions` source, not `?status=RECORDING`). Endpoints #2 and #5 remain available for future use / external callers.

### Coexisting working-tree changes NOT attributable to TASK-341
The working tree contains uncommitted changes from adjacent efforts that this worker did **not** author and left intact:
- **TASK-340 (Live SOAP Hardening), uncommitted:** `docs/implementation/TASK-340-Live-SOAP-Hardening/README.md`, `soap-parser.ts` (+test), `streamingAudioBridge.service.ts` (+test) — confirmed via `TASK-340` markers in their diffs. `live-documentation.service.ts` (+test) is a **shared** file: it carries both TASK-340 hardening (P0-A/P0-B/P1-A) and the TASK-341 B1/B3 additions. TASK-341 builds directly on this engine.
- **Guardrail / LM-Studio effort, uncommitted:** the TTS→Guardrail and `SMR_OPENAI_COMPAT_*` / Ollama-default changes in `.env.dev` and `.env.example` (the TASK-341 env change is *only* `LIVE_DOC_STATS_TTL_SEC=300`).
- **E2E test config, uncommitted:** `.env.test` (`S3_*`, `JWT_SECRET_KEY`, `SECRETS_TTL_SEC`) — unrelated auth/storage test fixes.

### Not verified: live end-to-end with real STT/SMR/NLP (expected; GPU/model host unavailable)
Same posture as [TASK-340 §7](../TASK-340-Live-SOAP-Hardening/README.md) and TASK-339. The admin Live console's data path depends on the running engine (real STT capture → SMR running-note → NLP entities) to populate `live-doc:stats:*` and the SSE stream. The doctor/admin STT/SMR/NLP services require a GPU + model host (and, for NLP, a mounted HF model cache) that is **not available on this machine**, so the realtime data path could not be exercised live. This is de-risked structurally instead: the stats publish/read, tenant isolation, kill-switch override + fan-out, stream-ticket ownership, `?status` filter, the admin SSE hook (mint + parse + closed/reconnect), and the page states are all covered by unit tests (§6). Remaining open item: a single end-to-end smoke against live SMR/NLP output once a GPU/LM-Studio host (and mounted NLP cache) is available.
