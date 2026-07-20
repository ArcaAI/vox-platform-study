# TASK-420 — Admin Console Playground Tier (Figma frames 50–59)

- **Status**: Review
- **Type**: feature — playground screens inside `apps/admin-console`
- **Created**: 2026-07-04
- **Origin**: TASK-415 Decision 2 (Playground tier deferred) confirmed by the 2026-07-04 review

## Requirement Analysis

Deliver the tier 50–59 Playground surfaces inside the Admin Console (deferred out of TASK-415, which covers admin tiers 10–49):

- **SDK-based clinical consultation demo** — `@arcaai/vox` capture → transcribe → document flow.
- **Live transcription** — WS streaming session (`/ws/stt-v2/stream`, session via `POST /audio/transcription-jobs/stream/session`).
- **Voice profile enrollment** — `/voice-profile/*`.
- **DNA writing style self-service** — `/dna-writing-styles/*` (incl. self SSE job stream).
- **Summarization / LLM demos** — `/text/generate*`, task streams (`GET /text/tasks/:taskId/stream`), provider catalog.

## Current State Evaluation

- All backend planes exist and are exercised today by the deprecated `apps/ui-playground` (API-integration reference only — its design tokens and sessionStorage auth are NOT to be copied).
- The console's BFF (TASK-415 Phase 3) already mints single-use stream tickets; browser SSE/WS connect directly to the gateway (`NEXT_PUBLIC_API_HOST`) per the established pattern.
- Design gate: Figma frames 50–59 in `HOPE-Admin-Console` must be authored and approved before screen implementation (`12-design-workflow.mdc`).

## Capabilities Matrix — Tier 50–59 (Playground)

- **Date**: 2026-07-05. Authored INSIDE this ticket (the TASK-415 matrix is closed and is not edited); format and conventions mirror `docs/implementation/TASK-415-Hope-Admin-Console/capabilities-matrix.md` sections 2 & 5. Every endpoint below was verified against its controller in `apps/api/src/modules/`.
- **Convention**: all HTTP paths are relative to the global prefix `/api/v1`. `*` compresses sibling routes on the same base path. Capability row numbers continue the TASK-415 matrix (rows 1–33 live there).
- **Audience**: the Playground is for admins exploring the platform's clinical apps — both `GLOBAL_ADMIN` (working tenant selected; "Acting on: «Tenant»" banner) and `TENANT_ADMIN` (own tenant). Where tenant context is required, global admins without a selection get the NoTenant gate (rule `12-design-workflow.mdc` §5). Playground actions run under the ADMIN'S OWN account (demo data lands in the working tenant); they are end-user planes, not `/admin/*` surfaces.

### Tier 50–59 — Playground (both admin audiences; tenant context required unless noted)

| # | Capability | Backend endpoints | Guard | Global admin | Tenant admin | Planned route | Screens & key UI | Notes |
|---|---|---|---|---|---|---|---|---|
| 34 | SDK clinical consultation demo (capture → transcribe → document) | `POST /consultations/open`, `GET /consultations[,/:id,/:id/chain,/:id/timeline]`, `POST :id/recording/{start,stop}`, `POST :id/{close,reopen}`, `POST/GET :id/context`, `GET :id/context/transcriptions`, `POST :id/recordings`, `POST :id/summary[/async]`, `POST :id/summary/pre-summary[/async]`, `POST :id/summary/comprehensive[/async]`, `GET :id/summary/latest`, `POST :id/summary/:contextItemId/approve`, `GET :id/named-entities`; job polling `GET /consultations/jobs/:jobId`, `PATCH /consultations/jobs/:jobId/cancel` | Class `@Authorize()`; `open` method-pinned `create:Consultation`; mutations creator-scoped in the service (`verifyConsultationOwnership`), reads via the consultation access gate | Working tenant required; demo consultations are created under the admin's own account | Own tenant | `/playground/consultation` | `@arcaai/vox` capture pane (mic-permission prompt, VAD/noise-filter chips, REC indicator, level meter), streaming transcript pane, live-summary SSE pane, generate actions; sub-frame 50.1: documentation review (harness stage checklist, per-claim assurance verdicts, approve/sign-off) | Traceability rows 14, 16, 35. `recording/start` returns the live-summary `sseUrl` and flips status → RECORDING. SDK composes the whole plane via `AgenticClient` (`packages/agentic-sdk-v2`) |
| 35 | Live transcription (WS streaming + batch upload) | `POST /audio/transcription-jobs/stream/session` (201 → `wsUrl` + one-shot ticket), WS `/ws/stt-v2/stream?sessionId&ticket`, `POST stream/session/:sessionId/refresh-ticket`, `DELETE stream/session/:sessionId`; batch `POST transcribe` (multipart, ≤100 MB); owner-scoped `GET /audio/transcription-jobs[,/stats,/status/:status,/:id]`, `POST :id/{cancel,retry}`; pipeline picker `GET /audio/pipelines[,/:id,/slug/:slug]` | Class `@Authorize()`; list/stats/status owner-scoped (caller's OWN jobs — the tenant-wide grid is tier 30–49 row 28); per-id/session routes `@TenantOwnedResource` (cross-tenant → 404); session create asserts pipeline ownership (404) + entitlements concurrency quota (429 at `maxConcurrentSessions`) | Working tenant required (session binds `user.tenantId`) | Own tenant | `/playground/live-transcription` | Pipeline picker, mic-permission prompt, WS status chip (connecting/live/reconnecting/closed 4401), partial vs final transcript stream, session ticket-refresh indicator; batch tab: drag-drop upload → job card with SSE progress, my-jobs strip with cancel/retry | Traceability rows 10, 11. All WS handshake failures close with generic 4401 (no cause leak). `voiceProfileSeeded` in the session response bridges row 36 |
| 36 | Voice profile enrollment (own account) | `POST /voice-profile/enroll` (multipart, ≤3 audio files, ≤10 MB each, `audio/*`), `GET /voice-profile`, `PATCH :id/{activate,deactivate}`, `DELETE :id` | Per-method `create/read/update/delete:UserVoiceProfile` — granted to EVERY authenticated user by `user-profile-own` conditioned `userId = ${user.id}` (biometric, user-owned only); per-id routes `@TenantOwnedResource` | Own profile only (works with or without a working tenant; profile rows live in the admin's home tenant) | Own profile only | `/playground/voice-profiles` | Record-or-upload enrollment wizard (up to 3 samples, per-file size meter), profile list with active badge, activate/deactivate toggles, delete confirm | Enrolls the CALLER'S own voice — no admin surface exists over other users' biometrics by design (seed `01-policy.ts`). Seeded profiles auto-attach to row 35 streaming sessions |
| 37 | DNA writing style self-service | `POST /dna-writing-styles/generate` (→ job), `GET my-style`, `GET mine`, `GET doctor/:doctorId` (self only, else 403), `PATCH :reportId` (If-Match; 428/412), `PATCH :reportId/default`, `GET :reportId/versions`, `GET/PUT settings` (per-doctor toggle), `GET jobs/:jobId`, `GET jobs/:jobId/stream` (SSE) | Class `@Authorize()`; owner-scoped in the service; `generate` + `PUT settings` REJECT a non-impersonating admin with 403 (`assertActingAsDoctor`, TASK-331 doc-07 F1) — DNA styles are per-doctor PHI-derived artifacts | Read surfaces render; generate/toggle require impersonating a doctor (or holding a clinical role) | Same — impersonation required for generate/toggle | `/playground/dna-writing-style` | My-style card, report list with set-default, version timeline, ETag-aware edit form, generate action with SSE job progress, DNA on/off toggle; prominent "Act as a doctor" gate panel | The admin surface is tier 30–49 row 26; THIS plane is the self/doctor view. The impersonation gate is a designed state, not an error |
| 38 | Summarization / LLM demos | `POST /text/generate` (sync or streaming), `POST /text/generate/assembled` (server-side prompt assembly from context items / templates / DNA style; `debug` returns assembly meta), `GET /text/tasks/:taskId`, `GET /text/tasks/:taskId/stream` (SSE pass-through), `POST /text/tasks/:taskId/cancel`, `GET /text/providers`, `GET /text/guardrail-providers` | `@Authorize()` per method (any authenticated); `assembled` `debug:true` requires GLOBAL_ADMIN/TENANT_ADMIN (code check); `?tenantKey=__GLOBAL__` on providers is `isSuperAdmin`-gated | Tenant context drives model fallback + provider catalog; `__GLOBAL__` catalog reachable via the GLOBAL_ADMIN elevated check (TASK-417) | Own tenant catalog | `/playground/llm` | Prompt/system-prompt editor, provider+model picker (tenant catalog with SMR live fallback), temperature/max-tokens controls, streaming output pane with task status chip + cancel, assembled-mode panel (context items, template, DNA style, debug meta), guardrail provider list | Traceability row 15. Model omitted → tenant's effective `{provider, model}` via HarnessPolicy cascade, else SMR fail-closed 422 (designed error state) |

### Realtime surfaces used by tier 50–59 (SSE / WS)

Auth pattern (identical to TASK-415 §5): every SSE route accepts `Authorization: Bearer <jwt>` or a single-use `?ticket=` minted by `POST /auth/stream-ticket` (30-second TTL, scope-bound). The console BFF mints tickets; the browser connects directly to the gateway.

| Stream | Endpoint | Ticket scope | Playground use |
|---|---|---|---|
| Live STT | WS `/ws/stt-v2/stream?sessionId&ticket` | one-shot `stt_session:<sessionId>` (minted BY session create; `refresh-ticket` for reconnects) | Frame 51 transcript stream |
| Live summary | `GET /consultations/:id/live-summary/stream` | `consultation_live_summary:<id>` | Frame 50 running SOAP snapshot while recording |
| Harness progress | `GET /consultations/:id/harness-progress/stream` | `consultation_harness_progress:<id>` | Frame 50.1 stage checklist |
| Harness assurance | `GET /consultations/:id/harness-assurance/stream` | `consultation_harness_assurance:<id>` | Frame 50.1 claim verdicts + gate decision |
| Consultation jobs | `GET /consultations/jobs/:jobId/stream` | job-scoped | Frame 50 async summary progress |
| Transcription job | `GET /audio/transcription-jobs/:id/stream` | job-scoped (`@TenantOwnedResource` pre-stream) | Frame 51 batch-upload progress |
| DNA job (self) | `GET /dna-writing-styles/jobs/:jobId/stream` | job-scoped | Frame 53 generate progress |
| SMR task | `GET /text/tasks/:taskId/stream` | — (plain `@Authorize()` pass-through; no `@StreamScope`) | Frame 54 token stream |

### Verification notes (endpoint/guard findings, 2026-07-05)

1. **DNA impersonation gate**: `POST /dna-writing-styles/generate` and `PUT /dna-writing-styles/settings` return 403 for an admin who is neither a clinical user nor impersonating one (`assertActingAsDoctor`) — the playground frame designs this as a first-class gate state.
2. **Elevated check**: `GET /text/providers?tenantKey=__GLOBAL__` is gated by `isSuperAdmin` (the helper name survives; since TASK-417 it checks the consolidated `GLOBAL_ADMIN` role).
3. **Concurrency quota**: `POST /audio/transcription-jobs/stream/session` throws a typed 429 when the tenant is at `maxConcurrentSessions` (entitlements kill-switch ON) — designed as an error state on frame 51.
4. **WS close codes**: all `/ws/stt-v2/stream` handshake failures collapse to generic 4401 (no session/ticket enumeration) — status chip copy stays generic.
5. **Voice profiles are strictly user-owned** (`user-profile-own`, `userId = ${user.id}`): there is no tenant-admin surface over other users' voice biometrics; the read-only per-user list on `20.1 - User Detail` (`GET /admin/users/:id/voice-profiles`) is the only admin view.
6. **Owner-scoped job reads**: `/audio/transcription-jobs` list/stats/status return the CALLER'S jobs only — no overlap with the tier 30–49 admin grid (row 28).

### Proposed frames & routes (Figma group `Playground`, 50–59)

| Frame | Name | Route | Matrix row |
|---|---|---|---|
| 50 | `50 - Consultation Demo` (+ dark variant) | `/playground/consultation` | 34 |
| 50.1 | `50.1 - Documentation Review` | `/playground/consultation` (review phase) | 34 |
| 51 | `51 - Live Transcription` | `/playground/live-transcription` | 35 |
| 52 | `52 - Voice Profiles` | `/playground/voice-profiles` | 36 |
| 53 | `53 - My DNA Writing Style` | `/playground/dna-writing-style` | 37 |
| 54 | `54 - LLM Playground` | `/playground/llm` | 38 |

Frames 55–59 remain reserved (unused). Routes sit under a `(playground)` route group in `apps/admin-console`, mirroring the existing `(global)`/`(shared)`/`(tenant)` groups; the sidebar renders the PLAYGROUND section when the caller holds any admin tier.

## Implementation Plan (high level — detail before starting)

1. ~~Extend the TASK-415 capabilities matrix~~ → Tier 50–59 capability section authored INSIDE this README (above; the closed TASK-415 matrix is untouched), endpoints/guards verified against controllers. ✅ 2026-07-05
2. ~~Figma frames 50–59~~ → authored 2026-07-05 (inventory below) — **APPROVED by the user 2026-07-06** (design gate cleared, rule `12-design-workflow.mdc` §2).
3. Screens per the TASK-415 phase pattern — split into six parallel sub-tickets (2026-07-06):

| Sub-ticket | Scope | Route |
|---|---|---|
| TASK-431 | Playground foundation: `(playground)` route group + guard, sidebar tier `50-59`, session `user.tenantId`, `@arcaai/vox` dep, SDK `wsUrl` fix | — |
| TASK-432 | Frames 50 + 50.1 — SDK consultation demo + documentation review | `/playground/consultation` |
| TASK-433 | Frame 51 — live transcription (WS + batch) | `/playground/live-transcription` |
| TASK-434 | Frame 52 — voice profile enrollment | `/playground/voice-profiles` |
| TASK-435 | Frame 53 — my DNA writing style | `/playground/dna-writing-style` |
| TASK-436 | Frame 54 — LLM playground | `/playground/llm` |

## Figma Frame Inventory — group `Playground` (approved 2026-07-06)

Authored 2026-07-05 in `HOPE-Admin-Console` via the Figma bridge. New top-level group container `Playground` (slate-400 canvas, auto-layout, 3-per-row wrap) placed after `Tenant admins'`. All frames 1440 px light theme (dark variant noted), built by duplicating the approved B2 archetype chrome (07 shell + 09 templates lineage) — token hexes strictly from `packages/ui/src/styles/globals.css` incl. `*-strong` on-tint text. Every frame carries: sidebar with new `PLAYGROUND — tier 50–59` nav group (active item highlighted in canonical order), "Acting on:" banner with dual-render annotation, STATE VARIANTS strip (loading skeleton / empty / error / NoTenant), playground chrome (live/REC indicators, streaming panes, SSE/WS status chips, mic-permission chips), and a matrix-traceability footnote.

| Frame | Content highlights | Evidence PNG |
|---|---|---|
| `50 - Consultation Demo` | `@arcaai/vox` capture pane (mic/pipeline/VAD/noise, level meter, REC 00:41 dot), WS live-transcript pane (partial row + caret), live-summary SSE pane (SOAP + async job progress), session status bar, mic-permission + SSE chips | `figma-evidence/50-consultation-demo.png` |
| `50.1 - Documentation Review` | Harness stage checklist (SSE harness-progress), per-claim assurance verdicts (PASS/REVIEW/running), draft note w/ provenance + gate decision, "Approve & sign-off" (success button), REVIEW GATE indicator, flagged-claim warning chip | `figma-evidence/50.1-documentation-review.png` |
| `51 - Live Transcription` | Session controls (stop/refresh-ticket/DELETE session), partial-vs-final transcript stream w/ latency meta, batch-upload pane (drag-drop ≤100 MB, job card w/ SSE progress, my-jobs strip), STREAMING indicator, 429-quota + 4401 error panel | `figma-evidence/51-live-transcription.png` |
| `52 - Voice Profiles` | Record-or-upload enrollment wizard (3 samples, per-file size), profile list w/ active badge + PATCH/DELETE actions, biometric user-owned chip, REC SAMPLE indicator; NoTenant panel repurposed as "not required here" annotation (own-account plane) | `figma-evidence/52-voice-profiles.png` |
| `53 - My DNA Writing Style` | Impersonation-gate panel ("Act as a doctor", GATE 403 indicator, warning chip — designed state), report list w/ set-default + ETag edit, generate pane w/ SSE job stream, DNA ON chip | `figma-evidence/53-my-dna-writing-style.png` |
| `54 - LLM Playground` | Prompt/system editor w/ stream-vs-sync + assembled mode, streaming output pane w/ caret + TASK RUNNING indicator + token chip, providers & guardrails pane (`__GLOBAL__` gate note, 422 fail-closed), admin-only debug chip | `figma-evidence/54-llm-playground.png` |
| `50-dark - Consultation Demo` | Full dark-theme recolor of frame 50 using `.dark` tokens (bg `#0c1418`, card `#111d23`, border `#25333b`, primary teal-400, dark `*-strong` = base role colors; chip tints = role @10% over card) | `figma-evidence/50-consultation-demo-dark.png` |

Frames 55–59 remain reserved (unused), matching the proposed-frames table above.

**Gate**: cleared — the user approved the 50–59 batch on 2026-07-06.

## Implementation Summary

All six sub-tickets are implemented (each in `Review`; per-ticket detail and evidence live in their own READMEs). Consolidated integration verification on the merged tree, 2026-07-06 (re-run after the final TASK-432 test consolidation):

- **Tests**: `pnpm --filter @arcaai/admin-console test` → **95 files, 729/729 passed** (includes all five `playground-*` feature suites plus the updated nav/sidebar suites).
- **Lint**: `pnpm --filter @arcaai/admin-console lint` (`--max-warnings 0`) → clean, exit 0.
- **Types**: `pnpm --filter @arcaai/admin-console check-types` → clean, exit 0.
- **Build**: `pnpm --filter @arcaai/admin-console build` → production build succeeds; all five routes compiled as dynamic (`ƒ`): `/playground/consultation`, `/playground/live-transcription`, `/playground/voice-profiles`, `/playground/dna-writing-style`, `/playground/llm`.

### What was delivered

| Sub-ticket | Deliverable |
|---|---|
| TASK-431 | `(playground)` route group + 404-posture tier guard, sidebar `PLAYGROUND` section (admin-gated `visibleNavEntries`), session `user.tenantId`, `@arcaai/vox`/`@arcaai/stt`/`@arcaai/room` deps, SDK `ApiConfig.wsUrl` origin fix (BFF REST + direct-gateway WS) |
| TASK-432 | `features/playground-consultation` — SDK capture pane, open→record→summary flow, 50.1 documentation review sub-view |
| TASK-433 | `features/playground-live-transcription` — streaming tab (session create → WS w/ tenant claim, partial/final transcript, 429-quota + 4401 panels), batch tab (multipart upload, SSE job card, my-jobs) |
| TASK-434 | `features/playground-voice-profiles` — record-or-upload enrollment wizard (≤3 samples), profile list w/ activate/deactivate/delete |
| TASK-435 | `features/playground-dna-style` — impersonation GATE-403 panel, my-style card (ETag/If-Match editing), report list, generate pane (SSE primary, 2s poll fallback on stream error), DNA settings toggle |
| TASK-436 | `features/playground-llm` — prompt editor (provider/model cascade incl. omit option), sync + streaming generate, assembled mode w/ admin-only debug, providers/guardrails catalog w/ elevated `__GLOBAL__` switch |

### Known runtime caveats (for the E2E/design-QA pass)

1. **Scope-less SSE routes**: `GET /text/tasks/:taskId/stream` (SMR) and `GET /dna-writing-styles/jobs/:jobId/stream` (DNA self) carry `@Authorize()` but no `@StreamScope`, and `JwtAuthGuard` rejects `?ticket=` on scope-less routes. TASK-436 therefore streams through the same-origin BFF proxy with cookie auth; TASK-435 attempts the ticketed stream and falls back to its designed 2s poll. Optional backend follow-up: add `@StreamScope` to those two routes to unify on the ticket pattern.
2. **SMR 422 detail**: SMR's fail-closed `{ detail }` payload doesn't survive the shared `GatewayError` parser (expects `{ message }`) — the designed 422 panel renders with generic copy (documented in TASK-436).
3. Playwright E2E + axe + design QA against the running app (rule `12-design-workflow.mdc` §6) remain to be executed as the final gate for this parent ticket.

## Change History

| Date | Change |
|---|---|
| 2026-07-04 | Ticket created from the TASK-415 review (deferred Playground tier formalized). |
| 2026-07-05 | Status → In Progress. Tier 50–59 capabilities matrix (rows 34–38 + realtime-surfaces table + verification notes) authored inside this README; every endpoint/guard verified against `apps/api/src/modules/**`. |
| 2026-07-05 | Figma group `Playground` + frames 50, 50.1, 51, 52, 53, 54 and dark variant `50-dark` authored in `HOPE-Admin-Console`; 7 evidence PNGs saved to `figma-evidence/`. **Awaiting user approval** (design gate) before any screen implementation. |
| 2026-07-06 | **Design gate cleared** — user approved the frames 50–59 batch. Implementation split into parallel sub-tickets: TASK-431 (foundation), TASK-432 (consultation demo), TASK-433 (live transcription), TASK-434 (voice profiles), TASK-435 (DNA writing style), TASK-436 (LLM playground). |
| 2026-07-06 | All six sub-tickets implemented (parallel agents). Consolidated integration pass on the merged tree: 729/729 tests (re-verified after the last agent consolidated duplicated TASK-432 suites), lint + types clean, production build green with all five playground routes. Status → Review; remaining gate = runtime E2E + axe + design QA (caveats noted in Implementation Summary). |
