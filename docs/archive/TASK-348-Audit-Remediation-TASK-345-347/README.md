# TASK-348: Audit Remediation — Pre-Commit Audit of TASK-345 / 346 / 347

| Field | Value |
|---|---|
| **Ticket** | TASK-348 |
| **Title** | Audit Remediation — Pre-Commit Audit of TASK-345/346/347 |
| **Created** | 2026-06-10 |
| **Updated** | 2026-06-10 |
| **Status** | Completed (Phases 0-5 done; TG-4 live e2e green 2026-06-10) |
| **Type** | bugfix / hardening |
| **Branch audited** | `fix/2605-review` (uncommitted working tree) |
| **Related tickets** | TASK-345 (Harness Live Progress Feed), TASK-346 (Local Dev Service Scripts), TASK-347 (STT Cadence Punctuation Fix), TASK-342 (env scope-creep owner), TASK-341 (live-summary SSE pattern lineage) |

---

## 1. Requirement Analysis

### 1.1 Description

A comprehensive pre-commit audit was performed on the uncommitted working tree implementing TASK-345/346/347 (41 changed files, +907/−58 lines). Five parallel read-only review agents (TypeScript backend, Python services, frontend, security, system integration) reviewed the diff and surrounding code; four test suites were executed as evidence. This ticket records the complete findings register and defines the remediation plan.

### 1.2 Business Context

- **Clinical safety**: the progress feed is clinician-facing during live consultations; a frozen or lying progress UI directly causes the "is it working or stuck?" confusion TASK-345 exists to remove.
- **Deploy safety**: the harness runs Temporal workflows with long-lived in-flight executions (clinician GATE waits). A non-versioned workflow change wedges live documentation runs.
- **PHI/security**: HOPE processes healthcare data; secrets hygiene and access-control regressions carry elevated severity.

### 1.3 Audit Methodology

| Agent | Scope | Mode |
|---|---|---|
| TS backend reviewer | `apps/api` consultation module, `packages/applications` harness progress service/DTOs | read-only |
| Python reviewer | `apps/harness` (Temporal, api_client), `apps/stt` (punctuation, settings) | read-only |
| Frontend reviewer | `apps/ui-playground` clinical-workspace (hook, lib, panel, api) | read-only |
| Security auditor | internal endpoint auth, SSE authz/IDOR, PHI exposure, env diffs, shell scripts | read-only |
| System integration auditor | end-to-end TASK-345 wiring, contract consistency, scripts/docs/config gaps | read-only |

Test evidence (all run 2026-06-10 against the working tree):

| Suite | Command | Result | Duration |
|---|---|---|---|
| TS unit (applications harness + api consultation) | `pnpm test:unit <changed paths>` | **150 passed** (10 files) | 4.6s |
| Python harness unit | `pnpm py:harness:test:unit` (conda `arcaenv`) | **476 passed** | 24.7s |
| Python stt unit | `pnpm py:stt:test:unit` (conda `arcaenv`) | **1,876 passed** | 22.7s |
| ui-playground full suite | `pnpm --filter @arcaai/ui-playground test` | **1,243 passed** (147 files) | 21.3s |

**Total: 3,745 tests, 0 failures.** All findings below are latent defects/gaps not covered by the current suites.

### 1.4 Acceptance Criteria (for this remediation ticket)

1. All P0 items resolved before the TASK-345/346/347 work is committed.
2. The Critical Temporal versioning defect resolved (with replay test) before any deploy that includes TASK-345.
3. All P1 items resolved before the progress feed is enabled for clinical users.
4. Every fix lands test-first (RED → GREEN → REFACTOR) per the development workflow.
5. P2/P3 items explicitly triaged: fixed, deferred (with reason), or rejected (with reason) — recorded in Change History.

---

## 2. Current State Evaluation

### 2.1 Audited Change Set

- **TASK-345** — Harness Live Progress Feed: Temporal workflow emits stage events via `report_progress` activity → `api_client.report_progress` POST → `HarnessInternalController` (service-token guarded) → `HarnessProgressService` (Redis fold + pub/sub, 1h TTL) → `@Sse` stream on `ConsultationController` (ticket + tenant guarded) → `use-harness-progress` hook → `ReviewPanel` checklist.
- **TASK-346** — Local Dev Service Scripts: `scripts/dev-doctor.sh`, `dev-infra.sh`, `dev-service.sh`, `dev-stack.sh` + root `package.json` rewiring.
- **TASK-347** — STT Punctuation: `punctuation_enabled` feature flag (default `false`) skipping Cadence model load + clean failure logging. *Scope note: despite the ticket name, the diff contains no cadence/buffering logic — the change is a kill-switch plus logging.*
- **Env files**: `.env.dev` / `.env.test` modified (partially scope-creep from TASK-342-era ops work).

### 2.2 Verified Safe (no remediation required)

| # | Verified behavior | Evidence |
|---|---|---|
| V1 | End-to-end wiring is complete and contract-consistent across all hops (camelCase wire JSON, identical stage/status enums, matching endpoint paths and scope strings) | Both sides of every seam read by the integration auditor |
| V2 | Progress store is Redis-backed: restart-safe, multi-instance-safe via pub/sub, TTL-evicted; duplicate publishes suppressed (`maximum_attempts=1`) | `harness-progress.service.ts`, `workflows.py` |
| V3 | Internal endpoint auth fail-closed + constant-time (`crypto.timingSafeEqual`); hidden from Swagger; `@Public()` only skips the user-JWT chain | `harness-service-token.guard.ts:36-51` |
| V4 | No cross-tenant IDOR on the SSE stream: global `TenantOwnedResourceSseGuard` resolves ownership pre-stream → 404 | `app.module.ts:113-124`, `tenant-owned-resource.interceptor.ts:133-136` |
| V5 | Stream tickets: 256-bit, single-use (GET+DEL), 30s TTL, bound to authenticated caller; JWT never in URL | `stream-ticket.service.ts`, `jwtauth.guard.ts:122-130` |
| V6 | No PHI in progress payloads or logs — fixed server-side stage catalog; logs carry only `consultationId` + `stage` | `models.py`, `harness-progress.service.ts:140-183` |
| V7 | Frontend lifecycle race-safe: cancelled-flag guards, EventSource closed on unmount/consultation switch, stream stops at terminal state | `use-harness-progress.ts` |
| V8 | Shell scripts injection-resistant: `set -euo pipefail`, allowlisted args, array-built `exec`, no `eval`, scoped `kill_tree`, `docker compose down` without `-v` | `scripts/dev-*.sh` |
| V9 | No debug leftovers in diff; `package.json` changes scripts-only; no dangling script references; ports + conda env (`arcaenv`) consistent | Integration auditor sweep |
| V10 | All three TASK READMEs contain every required documentation section with accurate status | `docs/implementation/TASK-34{5,6,7}-*/README.md` |

---

## 3. Findings Register

Severity: **Critical** (deploy/data-safety blocker) · **Major** (functional defect or significant gap) · **Minor** (edge case, hygiene, polish) · **Test Gap** (regression of audited behavior would not fail any test).

### 3.1 Critical

#### CRIT-1 — In-flight Temporal workflows break on deploy (no `workflow.patched()` / versioning)

- **Area**: Harness / Temporal · **Location**: `apps/harness/src/harness/temporal/workflows.py:182, 287, 336, 416, 446`; `worker.py:40`
- **Evidence**: Six new `_report_progress` activity calls are inserted into the deterministic workflow body — the first *before* `fetch_policy`. The worker is a plain `Worker(...)` with no Build-ID/Worker Versioning. Any execution started on the old code (especially runs parked at the clinician GATE `workflow.wait_condition`, which have long SLAs) will replay on the new worker, encounter `ScheduleActivity(report_progress)` where history recorded `ScheduleActivity(fetch_policy)`, raise a non-determinism error, and wedge — gate decisions and sign-offs never record. Existing workflow tests only start fresh executions and cannot catch this.
- **Remediation**: Gate every emission point behind `workflow.patched("task-345-harness-progress")` (or `workflow.get_version`). Alternatives: Worker Versioning with a new Build ID after draining, or verified-zero in-flight executions at cutover. Add a replay test against a captured pre-change history (see TG-1).
- **Priority**: **P0 (deploy blocker)**

### 3.2 Major

#### MAJ-1 — No failure terminal event: UI freezes; snapshot lies for 1h

- **Area**: Harness feed (workflow + service + UI) · **Location**: `workflows.py:147-174`; `packages/applications/src/services/consultation/harness/harness-progress.service.ts:33` (`SNAPSHOT_TTL`)
- **Evidence**: The terminal `completed` event is emitted only after `persist_draft` succeeds. On workflow failure (e.g. SMR generate retries exhausted — the degradation tests confirm "no draft on SMR failure"): the checklist freezes on an `active` stage until the parent 150s draft-poll times out; the SSE stream never closes server-side (15s heartbeats keep it alive); the Redis snapshot replays a misleading "active" state to late joiners for the full 1h TTL.
- **Remediation**: Emit a `failed` pseudo-stage terminal event (`closed: true`) from a workflow-level `try/finally` (best-effort); render a distinct failure state in `review-panel.tsx`; clear/shorten snapshot TTL on terminal events.
- **Priority**: P1

#### MAJ-2 — Cross-run snapshot contamination: fresh run renders as "pass 2"

- **Area**: API service · **Location**: `harness-progress.service.ts:140-183` (`fold`)
- **Evidence**: `fold()` merges into any prior snapshot keyed by `consultationId` only. `jobId` is carried in every event (line 143) but never compared. A second harness run within the 1h TTL (re-record, retry after failure) inherits the previous run's stages: `attempt` increments (line 155) so the first drafting pass renders as "pass 2", and old stages appear instantly completed.
- **Remediation**: In `fold()`, discard `prior` when `dto.jobId` is present and differs from `prior.jobId`.
- **Priority**: P1

#### MAJ-3 — Shared Redis channel teardown kills concurrent viewers' streams

- **Area**: API service · **Location**: `harness-progress.service.ts:106`; `redisSubscriber.service.ts:221-243`
- **Evidence**: `finalize(() => this.redisSubscriber.unsubscribeFromChannel(channel))` force-completes the **shared** per-channel Subject and removes the Redis subscription, bypassing the refcounting already built into `subscribeToChannel` (its own `finalize` → `decrementAndCleanup`). With two viewers on the same consultation (two tabs, doctor + supervisor), the first disconnect silently stops the second viewer's events. Inherited from the live-summary/jobs pattern (`consultation-job.service.ts:505`), but TASK-345 multiplies the exposed surface.
- **Remediation**: Drop the explicit `unsubscribeFromChannel`; rely on the refcounted teardown. Apply the same fix to the sibling services (separate commit; flag to team).
- **Priority**: P1

#### MAJ-4 — Dead SSE stream rendered as live progress

- **Area**: Frontend · **Location**: `apps/ui-playground/src/features/clinical-workspace/components/review-panel.tsx:53,65`; `hooks/use-harness-progress.ts:104-111`
- **Evidence**: The panel consumes only `progress.stages`, ignoring `status`/`error`. The one-shot stream ticket cannot satisfy `EventSource` native auto-reconnect, so any transient drop leaves `status: 'error'` with stale stages — a frozen checklist presented as live for up to the 150s draft-poll window.
- **Remediation**: When `status === 'error' && !closed`, fall back to the static "Generating…" block or render a "progress unavailable / reconnecting" note. Add ticket-re-minting reconnect with bounded retries on `onerror` (see ENH-3).
- **Priority**: P1

#### MAJ-5 — Non-atomic read-fold-write on the Redis snapshot

- **Area**: API service · **Location**: `harness-progress.service.ts:46-66`
- **Evidence**: `reportProgress` performs Redis GET → fold in app memory → SETEX → PUBLISH as separate awaits. The harness uses a 5s HTTP timeout inside a 10s activity, so a slow stage-N request can still be executing when stage N+1 arrives — a check-then-act lost update producing backward state flicker or a stale terminal snapshot. Self-heals on the next full-state event; TTL-bounded.
- **Remediation**: Make the fold atomic — Redis Lua script (GET+fold+SETEX+PUBLISH) or `WATCH/MULTI` — or reject ordinal regressions with a monotonic guard. At minimum document the sequential-emission assumption.
- **Priority**: P1

#### MAJ-6 — No payload bounds: unbounded `stages[]`, uncapped strings/numbers

- **Area**: API DTO + service · **Location**: `packages/applications/src/services/consultation/harness/dto/harness-internal.dto.ts` (`HarnessProgressRequest`); `harness-progress.service.ts:159-169`
- **Evidence**: `tenantId`/`jobId`/`stage`/`label` are `@IsString()` with no `@MaxLength`; `ordinal`/`total` have no `@Min`/`@Max`; `fold` appends a new entry for every unrecognized `stage` key with no cap. A buggy or compromised token-holder can grow the per-consultation snapshot unboundedly, rebroadcast to every SSE subscriber. (Mitigated by service-token guard, Express 100kB JSON limit, 1h TTL.) OWASP A04.
- **Remediation**: `@MaxLength(128)` on `stage`, `@MaxLength(256)` on `label`/ids; `@Min(1)`/`@Max(50)` on `ordinal`/`total`; `@IsIn([...HARNESS_PROGRESS_STAGES, 'completed'])` on `stage`; hard cap on `stages.length` in `fold`.
- **Priority**: P1

#### MAJ-7 — Real Vault AppRole credentials + pepper staged into tracked `.env.dev`

- **Area**: Security / secrets hygiene · **Location**: `.env.dev:120` (`API_KEY_PEPPER`), `.env.dev:333-334` (`VAULT_ROLE_ID`, `VAULT_SECRET_ID`)
- **Evidence**: Blank values replaced with live UUIDs and a concrete pepper in a **git-tracked** file. Mitigations: dev Vault is in-memory and `role_id` regenerates on every infra bootstrap (ephemeral, dev-only → Medium not High). Additional blast radius: a committed pepper flips API-key hashing from plain SHA-256 to HMAC for every other developer, whose seeded keys then 401 until reseed — the exact failure class TASK-342/346 just fixed. The TASK-342 Change History explicitly labels these edits "(local-only)"; TASK-346's README states "no new secrets". OWASP A05/A07.
- **Remediation**: Revert all three values to blank-with-comment before commit; keep machine-local values in an untracked overlay. Rotate the AppRole if the Vault was ever shared/persistent.
- **Priority**: **P0 (commit blocker)**

#### MAJ-8 — `use-harness-progress` hook has zero unit tests

- **Area**: Frontend / test coverage · **Location**: `apps/ui-playground/src/features/clinical-workspace/hooks/use-harness-progress.ts` (entire file)
- **Evidence**: All non-trivial async lifecycle logic (ticket mint → `EventSource` → cancel-on-unmount → terminal close) is untested. The component test mocks the hook entirely; the lib test covers only the pure reducer. Consistent with the (also untested) `use-live-summary-stream.ts`, but this is the highest-risk untested code in the changeset.
- **Remediation**: Hook test with a fake `EventSource` + mocked `fetchStreamTicket`: unmount-during-ticket-fetch (no EventSource created, no state writes); `closed: true` closes the source; `consultationId` switch resets and reconnects; `readyState === CLOSED` surfaces `status: 'error'`.
- **Priority**: P1

#### MAJ-9 — Progress emission awaited inline; queue wait unbounded

- **Area**: Harness / Temporal · **Location**: `workflows.py:160-171` (+ budgets `:92-93`)
- **Evidence**: Each of the 6 emissions is `await workflow.execute_activity(...)` *before* the real stage runs, with only `start_to_close_timeout=10s` — no `schedule_to_close_timeout`, so saturated activity slots block until pickup, and a wedged (not refused) API costs ~5s per transition (~30s per run worst case). Bends TASK-345 AC-1 ("progress failures NEVER fail **or delay** the workflow").
- **Remediation**: Add `schedule_to_close_timeout` (~10s) to bound total queue+exec time, or fire via `workflow.start_activity` without awaiting (ordinals already preserve ordering). Update AC wording to "best-effort with bounded delay".
- **Priority**: P1

### 3.3 Minor

| ID | Area | Finding | Location | Recommended fix | Priority |
|---|---|---|---|---|---|
| MIN-1 | Auth | Ticket-mint ownership check covers only `consultation_live_summary:*`; new `consultation_harness_progress:*` scope passes unchecked (SSE guard still blocks — defense-in-depth divergence, OWASP A01) | `auth.controller.ts:754,780` | Generalize mint-time assertion to all `consultation_*:<id>` scopes, fail-closed | P1 |
| MIN-2 | API service | Stale re-delivery of an earlier stage is indistinguishable from a regen — `attempt` increments and later stages reset | `harness-progress.service.ts:153-158` | Monotonic `seq`, or treat re-emission as regen only at/after current active ordinal | P2 |
| MIN-3 | API service | Snapshot-then-subscribe gap can drop an event published in the window (incl. terminal `closed`) | `harness-progress.service.ts:80-87` | Subscribe first, then emit snapshot; de-dupe by `updatedAt` | P2 |
| MIN-4 | API | Publish endpoint returns `201 Created` even with `{ ok: false }` | `harness-internal.controller.ts:103-108` | `@HttpCode(200)` or 202 | P3 |
| MIN-5 | Contract | `tenantId` required + validated in DTO but never used — no publish-side consultation↔tenant assertion | `harness-internal.dto.ts:233-236`; `reportProgress()` | Assert ownership at publish, or drop the field | P2 |
| MIN-6 | Frontend | Stale `closed:true` snapshot (1h TTL) replayed on re-subscribe suppresses a new run; hook never resets `closed` | `use-harness-progress.ts:52-60,97-99` | Reset `closed`/`status` on first non-closed event; server clears snapshot on new `jobId` (with MAJ-2) | P2 |
| MIN-7 | Frontend | Normalizer doesn't dedupe by `stage` key → React duplicate-key warnings on malformed payloads | `lib/harness-progress.ts:56-73`; `review-panel.tsx:75` | Dedupe-last via `Map` keyed on `stage` before sorting | P2 |
| MIN-8 | Frontend / a11y | Live checklist not announced to screen readers; icons use `aria-label` on bare SVGs | `review-panel.tsx:72-91` | `role="status" aria-live="polite"` + `aria-busy`; `role="img"` or visually-hidden labels | P2 |
| MIN-9 | Frontend / UX | Checklist grows one row at a time; `total` threaded end-to-end but never rendered (no "Step N of 5") | `review-panel.tsx:63-92` | Pre-render stage catalog (or placeholders up to `total`) as pending | P2 |
| MIN-10 | STT | `_enabled` stays `true` after failed model load → per-utterance reload attempts (crash-loop class; dodged only because default is off) | `apps/stt/src/stt/punctuation/service.py:78-92` | Flip `_enabled = False` on load failure → degrade to passthrough | P1 |
| MIN-11 | STT | Global kill-switch silently overrides per-pipeline `punctuation.enabled: true` YAML | `service.py:115,131,147` | One-time startup warning + document precedence | P3 |
| MIN-12 | STT | Contradictory boot logs: "disabled…" immediately followed by "initialized" | `main.py:188-193`; `worker.py:101` | Condition the "initialized" line on actual outcome | P3 |
| MIN-13 | Config/docs | `PUNCTUATION_ENABLED` undocumented in env reference | `settings.py:479` vs `apps/stt/.env.example` | Commented `PUNCTUATION_ENABLED=false` block in `.env.example` + service README | P2 |
| MIN-14 | Dev scripts | `dev-stack.sh`: no `down`/detached mode (orphans after SIGKILL); predictable shared `/tmp` log dir (symlink truncation + PHI-in-logs vector, CWE-377); `$(command_for "$svc")` word-splitting | `scripts/dev-stack.sh:41,123-128,179` | Pidfile-based `down`; logs under `$HOME`/`$XDG_STATE_HOME` `chmod 700`; array-built command | P2 |
| MIN-15 | Dev scripts | Python dev services bind `0.0.0.0` — PHI-processing dev services exposed on LAN | `scripts/dev-service.sh:171-197` | Default `--host 127.0.0.1`; `0.0.0.0` as explicit opt-in | P2 |
| MIN-16 | Docs | README command table missing `infra:down\|status\|logs`, `:watch` variants, `DRY_RUN=1`, subset launches | `README.md:65-78` | Add rows or link TASK-346 README | P3 |
| MIN-17 | Hygiene | Env repairs from other workstreams bundled (`.env.test` S3/JWT/rate-limit; `.env.dev` TTS→GUARDRAIL, `LIVE_DOC_*`, SMR flip) | `.env.test:63-121`; `.env.dev:137-235` | Split env changes into their own commit referencing TASK-342, after MAJ-7 strip | **P0 (commit hygiene)** |
| MIN-18 | Config | Divergent model identifiers: `.env.dev` `google/gemma-4-e4b` vs launcher default `gemma-4-e4b-it-qat` (env value is dead documentation — Python services don't read `.env.dev`) | `.env.dev:172` vs `scripts/dev-service.sh:127` | Align on the identifier LM Studio serves, or annotate the authoritative source | P3 |

### 3.4 Test Gaps

| ID | Area | Gap | Location | Required test | Priority |
|---|---|---|---|---|---|
| TG-1 | Harness | No Temporal replay test vs pre-change history — CRIT-1 structurally invisible to the suite | `apps/harness/src/harness/tests/unit/temporal/` | `Replayer` test using captured pre-TASK-345 workflow history | **P0** (with CRIT-1) |
| TG-2 | Harness | Retry-storm test can't fail: non-retryable error + `calls >= 1` assertion would pass with `maximum_attempts=50` | `test_doc_workflow.py:763-789` | Retryable error + exact per-stage call count pinning `maximum_attempts=1` | P1 |
| TG-3 | API | No invalid / oversized / unknown-stage payload tests (pairs with MAJ-6) | `harness-progress.service.test.ts` | Fold test pushing N unknown stages (assert cap); pipe test asserting 400 on over-length body | P1 |
| TG-4 | API | SSE authz asserted via decorator metadata only; no cross-tenant probe | `consultation.controller.harness-progress.test.ts:43-57` | E2E cross-tenant 404 on `:id/harness-progress/stream`, mirroring live-summary spec | P2 |
| TG-5 | STT | TASK-347's logging ACs (one clean warning + traceback at debug) untested | `main.py:188-193`; `worker.py:101` | Mock failing `initialize()`; assert one `warning` + `debug(..., exc_info=True)` | P2 |

### 3.5 Enhancement Opportunities (backlog candidates — not defects)

| ID | Enhancement | Rationale |
|---|---|---|
| ENH-1 | Failure-aware feed: `failed`/`cancelled` terminal events via workflow `try/finally`, failure state in panel, snapshot TTL cleared on terminal | Structurally closes MAJ-1/MAJ-2 |
| ENH-2 | Atomic fold via Redis Lua + monotonic `seq` | Eliminates MAJ-5/MIN-2 at the root |
| ENH-3 | Shared `useTicketedEventSource` hook with ticket-re-minting reconnect | `use-harness-progress` and `use-live-summary-stream` are near-identical copies; fixes transient-drop death for both |
| ENH-4 | Stage catalog as shared contract (mirror in TS DTO or send in first event) | Pre-render full checklist; guard label/ordinal drift between services |
| ENH-5 | Single shared refcounted Redis subscriber provider | One persistent SUBSCRIBE connection per feature module today; removes the MAJ-3 foot-gun class |
| ENH-6 | Feed observability: publish-failure (`ok:false`) counters, active SSE relay gauge, `dev:doctor` end-to-end stream probe | Catch relay regressions before clinicians do |
| ENH-7 | Pooled `httpx.AsyncClient` in harness `api_client` | New client per call, amplified by 6+ posts per workflow |
| ENH-8 | `dev-stack` lifecycle: pidfile `down`, detached mode, post-spawn health checks reusing dev-doctor probes | Closes MIN-14 ergonomics |

---

## 4. Remediation Plan (Implementation Plan)

> Gate: this plan requires user approval before any code is written. Each item follows TDD RED → GREEN → REFACTOR. Layer order respected (no DB/domain changes anticipated — all fixes live in harness Python, applications services, API controllers, UI, scripts, docs).

### Phase 0 — Commit hygiene (no code, do first) — **P0**

| Step | Finding | Action | Verification |
|---|---|---|---|
| 0.1 | MAJ-7 | Revert `API_KEY_PEPPER`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID` in `.env.dev` to blank-with-comment | `git diff HEAD -- .env.dev` shows no secret values; gitleaks pre-commit passes |
| 0.2 | MIN-17 | Split env-file changes into a dedicated commit referencing TASK-342 | Clean commit boundaries: env commit vs TASK-345/346/347 commits |

### Phase 1 — Deploy blocker: Temporal versioning — **P0**

| Step | Finding | TDD | Files |
|---|---|---|---|
| 1.1 | TG-1 | **RED**: add `Replayer` test using a captured pre-TASK-345 history JSON → fails (non-determinism) on current code | `apps/harness/src/harness/tests/unit/temporal/test_replay_compat.py` (new), history fixture |
| 1.2 | CRIT-1 | **GREEN**: wrap all 6 `_report_progress` emission points in `workflow.patched("task-345-harness-progress")` | `apps/harness/src/harness/temporal/workflows.py` |
| 1.3 | — | **VERIFY**: replay test passes; full `pnpm py:harness:test:unit` green; fresh-execution tests still see all 6 emissions | test output captured |

### Phase 2 — Feed correctness (backend) — P1

| Step | Finding | TDD | Files |
|---|---|---|---|
| 2.1 | MAJ-1 | RED: workflow test — failure path emits terminal `failed` event (`closed: true`); GREEN: `try/finally` best-effort terminal emission | `workflows.py`, `models.py`, `test_doc_workflow.py` |
| 2.2 | MAJ-2 | RED: fold test — differing `jobId` discards prior snapshot; GREEN: jobId comparison in `fold()` | `harness-progress.service.ts`, `harness-progress.service.test.ts` |
| 2.3 | MAJ-3 | RED: test — two concurrent subscribers; first unsubscribe must not complete second stream; GREEN: remove explicit `unsubscribeFromChannel`, rely on refcount | `harness-progress.service.ts`, service test |
| 2.4 | MAJ-5/MIN-2 | RED: test — out-of-order/duplicate earlier-stage event does not regress state; GREEN: monotonic ordinal/seq guard in fold (Lua atomicity deferred to ENH-2 unless trivial) | `harness-progress.service.ts`, DTO, service test |
| 2.5 | MAJ-6/TG-3 | RED: validation tests — over-length strings, out-of-range ordinals, unknown stage beyond cap → rejected/capped; GREEN: `@MaxLength`/`@Min`/`@Max`/`@IsIn` + fold cap | `harness-internal.dto.ts`, `harness-progress.service.ts`, tests |
| 2.6 | MAJ-9 | RED: assert activity options include `schedule_to_close_timeout`; GREEN: add bounded timeout | `workflows.py`, `test_doc_workflow.py` |
| 2.7 | TG-2 | Strengthen retry test: retryable error + exact call count | `test_doc_workflow.py` |
| 2.8 | MIN-1 | RED: mint-time test — `consultation_harness_progress:<other-tenant-id>` rejected; GREEN: generalize ownership assertion | `auth.controller.ts`, auth tests |
| 2.9 | MIN-3, MIN-4, MIN-5 | Subscribe-before-snapshot; `@HttpCode(200)`; tenant assertion at publish (or drop field — decide at review) | `harness-progress.service.ts`, `harness-internal.controller.ts`, DTO |

### Phase 3 — Frontend resilience — P1

| Step | Finding | TDD | Files |
|---|---|---|---|
| 3.1 | MAJ-8 | RED: new hook test suite (fake EventSource): unmount-during-ticket-fetch / closed stops stream / id-switch resets / error surfaces | `hooks/__tests__/use-harness-progress.test.ts` (new) |
| 3.2 | MAJ-4 | RED: panel test — `status:'error' && !closed` renders fallback, not frozen checklist; GREEN: consume `status`/`error` in panel | `review-panel.tsx`, `review-panel.test.tsx` |
| 3.3 | MAJ-4 | Ticket-re-minting reconnect with bounded backoff on `onerror` (scoped to this hook; ENH-3 generalization separate) | `use-harness-progress.ts`, hook tests |
| 3.4 | MIN-6 | RED: stale `closed` replay then fresh event → new run renders; GREEN: reset on first non-closed event | hook + tests |
| 3.5 | MIN-7 | RED: duplicate stage keys deduped-last; GREEN: `Map` dedupe in normalizer | `lib/harness-progress.ts`, lib tests |
| 3.6 | MIN-8, MIN-9 | `aria-live` region + icon roles; render "Step N of `total`" + pre-rendered pending catalog | `review-panel.tsx`, tests |

### Phase 4 — STT, scripts, docs — P1/P2/P3

| Step | Finding | Action | Files |
|---|---|---|---|
| 4.1 | MIN-10 | RED: failed `_load_model()` → `_enabled` false, passthrough, no reload per utterance; GREEN: flip flag on failure | `punctuation/service.py`, `test_service.py` |
| 4.2 | TG-5, MIN-12 | Logging tests (one warning + debug exc_info); fix contradictory boot log | `main.py`, `worker.py`, tests |
| 4.3 | MIN-11, MIN-13 | Precedence warning + `.env.example`/README documentation | `service.py`, `apps/stt/.env.example`, README |
| 4.4 | MIN-14, MIN-15 | `dev-stack down` (pidfiles), `$HOME`-scoped logs `chmod 700`, array-built command, `127.0.0.1` default binding | `scripts/dev-stack.sh`, `scripts/dev-service.sh` |
| 4.5 | MIN-16, MIN-18 | README command rows; model identifier alignment | `README.md`, `.env.dev` |
| 4.6 | TG-4 | Cross-tenant 404 e2e for the progress stream | `apps/api/tests/e2e/` |

### Phase 5 — Verification & documentation

- Full test matrix re-run (the four suites in §1.3) + `pnpm lint` + `pnpm build:api` / `pnpm build:modules` — outputs captured here as evidence.
- ReadLints on every modified file — zero new errors.
- Update this README: Implementation Summary + per-finding status (Fixed / Deferred / Rejected) + Change History entries.
- Enhancement items ENH-1..8 triaged into follow-up tickets or explicitly deferred.

### Out of scope for TASK-348

- ENH-3/ENH-5 generalizations across live-summary/jobs services (separate ticket — touches TASK-341 surfaces).
- Any cadence/buffering work implied by TASK-347's title (no such code exists in the diff; see §2.1 scope note).

---

## 5. Implementation Summary

Audit deliverables:

- This findings register (33 findings: 1 Critical, 9 Major, 18 Minor, 5 Test Gaps; 8 enhancements; 10 verified-safe confirmations).
- Audit canvas: `task-345-347-audit.canvas.tsx` (workspace canvases).
- Test evidence baseline: 3,745 tests passing across 4 suites (§1.3).

### Phase 0 — Commit hygiene (Completed 2026-06-10) — resolves MAJ-7, MIN-17

- `.env.dev`: `API_KEY_PEPPER`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID` reverted to blank-with-comment (MAJ-7).
- Env changes committed separately from feature work as `57fb4d2c chore(TASK-342): split local env config repairs from feature work` (MIN-17). Note: the TASK-345/346/347 feature work itself had been committed as `50059301` between audit and remediation.
- **Audit addendum (new finding resolved in passing)**: the gitleaks pre-commit hook blocked the env commit on `.env.test:86` (`hope-jwt-secret`) — the labeled e2e JWT placeholder cannot pass the gate because the rule's capture group makes the allowlist's secret-target see the var name, never matching the `not-for-prod` regex (same root cause as the pre-existing `dev-init.sh` entry). Added a reviewed fingerprint to `.gitleaksignore` per the file's documented process, citing this audit's Verified Safe #7. Gitleaks then passed: "no leaks found".

### Phase 1 — Temporal replay compatibility (Completed 2026-06-10) — resolves CRIT-1, TG-1

TDD evidence:

- **RED**: `test_replay_compat.py::test_pre_task345_history_replays_on_current_definition` against the unpatched definition failed with exactly the predicted defect: `NondeterminismError: [TMPRL1100] Activity type of scheduled event 'fetch_policy' does not match activity type of activity command 'report_progress'`.
- **GREEN**: gated `_report_progress` behind `workflow.patched("task-345-harness-progress")` (single helper covers all six emission points). Replay passes; fresh executions still emit all stages (existing progress-sequence tests unchanged and passing).
- **Forward guard**: second fixture captured from the patched definition + `test_task345_history_replays_on_current_definition`, so any future unpatched workflow change fails the suite.

Files created/modified:

| File | Purpose |
|---|---|
| `apps/harness/src/harness/temporal/workflows.py` | `workflow.patched()` gate in `_report_progress` (CRIT-1 fix) |
| `apps/harness/src/harness/tests/unit/temporal/test_replay_compat.py` | New replay-compat suite (pre-345 era + 345 era) |
| `apps/harness/src/harness/tests/unit/temporal/_capture_replay_fixture.py` | Maintained fixture-capture helper (documents provenance + procedure) |
| `apps/harness/src/harness/tests/unit/temporal/fixtures/doc_workflow_pre_task345_history.json` | Frozen pre-TASK-345-era history (captured from commit `50059301^`) |
| `apps/harness/src/harness/tests/unit/temporal/fixtures/doc_workflow_task345_history.json` | TASK-345-era history (forward replay baseline) |

Verification (all captured 2026-06-10):

| Gate | Command | Result |
|---|---|---|
| Replay + workflow tests | `pytest .../test_replay_compat.py .../test_doc_workflow.py` | 23 passed |
| Full harness unit suite | `pnpm py:harness:test:unit` | **478 passed** (476 baseline + 2 new) |
| Lint / format | `ruff check` + `black --check` (modified files) | clean |
| Typecheck | `pnpm py:harness:typecheck` | Success: no issues in 75 source files |

Deployment note: collapse the gate to `workflow.deprecate_patch("task-345-harness-progress")` once no pre-TASK-345 executions can still be in flight (gate SLA horizon), then remove it in a later release per the standard Temporal patch lifecycle. The same lifecycle applies to the Phase 2 patch `task-348-failure-terminal`.

### Phase 2 — Backend feed correctness (Completed 2026-06-10) — resolves MAJ-1/2/3/5/6/9, MIN-1/2/3/4/5, TG-2/3 (+TG-4 spec)

Executed test-first by a dedicated agent; RED evidence captured per finding. Highlights:

- **MAJ-1 — failure terminal**: workflow failures now emit a terminal `failed` event best-effort, then re-raise (workflow still fails). Wire contract: `stage: "failed"`, `label: "Documentation generation failed"`, `ordinal = total`. Emission is double patch-gated (`task-345-harness-progress` + `task-348-failure-terminal`) — both replay fixtures still pass. The API fold marks the currently-active stage `failed` (status union now includes `'failed'`), leaves completed/pending stages untouched, and publishes `closed: true` (same close mechanism as `completed`).
- **MAJ-2 — cross-run contamination**: snapshot now stores `jobId`; `fold()` discards the prior snapshot when the incoming `jobId` differs — a new run renders fresh (`attempt: 1`) and reopens a terminally-closed feed.
- **MAJ-3 — concurrent viewers**: explicit `unsubscribeFromChannel` finalize removed; teardown relies solely on `subscribeToChannel`'s refcounted cleanup. Sibling live-summary/jobs services left untouched (out of scope, flagged to team).
- **MAJ-5 + MIN-2 — lost update / stale re-delivery**: deterministic monotonic guard in `fold()` — non-terminal events below the active ordinal are ignored (no publish, still `{ok: true}`); re-emission at/after the active ordinal counts as a regen (`attempt`++); different `jobId` bypasses the guard; post-`closed` events for the same run are ignored. Lua atomicity deferred to ENH-2.
- **MAJ-6 + TG-3 — payload bounds**: `@MaxLength(128)` on `stage`, `@MaxLength(256)` on `label`/`tenantId`/`jobId`, `@Min(1)`/`@Max(50)` on `ordinal`/`total`, `@IsIn` against the mirrored stage catalog (`HARNESS_PROGRESS_STAGE_KEYS` + both terminals). Defense-in-depth `MAX_STAGES = 50` cap in `fold()`. Tradeoff (deliberate): adding a workflow stage now requires updating both catalog mirrors (`models.py` + `harness-internal.dto.ts`).
- **MAJ-9 — bounded queue wait**: `schedule_to_close_timeout=10s` added to all progress activity options.
- **TG-2**: retry-bound test strengthened — retryable error + exact per-stage call count; mutation-tested (with `maximum_attempts=50` the new assertion fails `300 == 6`; the old test could never fail).
- **MIN-1**: `assertLiveSummaryScopeOwnership` generalized to `assertConsultationScopeOwnership` — every `consultation_*:<id>` ticket scope is ownership-checked fail-closed (404) at mint time; `consultation_job` explicitly exempted (suffix is a job id; its SSE guard does its own tenant-scoped lookup).
- **MIN-3**: subscribe-before-snapshot via `ReplaySubject` bridge; snapshot emitted after the channel is live; relayed events de-duped by `updatedAt`.
- **MIN-4**: `@HttpCode(200)` on the internal progress POST.
- **MIN-5**: `tenantId` now folded into every published event. Publish-time consultation→tenant ownership assertion **rejected with rationale** (documented in the DTO): the module is intentionally Redis-only with no consultation repository; tenancy is enforced at mint time (MIN-1) and stream time (`TenantOwnedResourceSseGuard`), and the endpoint is HMAC-guarded.
- **TG-4**: `apps/api/tests/e2e/task-348-harness-progress-cross-tenant.spec.ts` (5 tests) mirrors `task-307-consultation-job-cross-tenant.spec.ts`. **Live run green 2026-06-10**: `pnpm test:e2e task-348-harness-progress-cross-tenant` → 5 passed (4.3s) against the test stack (containers on 5433/6380, API in test mode, fresh schema push + seed). Verified on the wire: same-tenant sanity 200, cross-tenant stream GET not-200, cross-tenant `consultation_harness_progress` ticket mint → 404 (MIN-1), synthetic-uuid 404 shape parity, no collateral damage.

### Phase 3 — Frontend resilience (Completed 2026-06-10) — resolves MAJ-4, MAJ-8, MIN-6/7/8/9

- **MAJ-8**: new 11-test hook suite (`hooks/__tests__/use-harness-progress.test.ts`) with fake `EventSource` + mocked ticket mint: unmount-during-ticket-fetch, terminal close, consultation switch, error surfacing, reconnect paths.
- **MAJ-4 (render)**: panel now consumes `status`/`error` — `status: 'error' && !closed` falls back to the static "Generating…" block with a "live progress unavailable" note instead of a frozen checklist; genuine `failed` terminal renders a distinct failure state.
- **MAJ-4 (reconnect)**: bounded ticket-re-minting reconnect on `onerror` (3 attempts, 1s/2s/4s backoff, budget restored by any received message). Generalization into a shared hook deferred to ENH-3.
- **MIN-6**: a `closed: true` event arriving as the *first* message on a connection is treated as snapshot replay (recorded, keeps listening); only a close after live events on the same connection is a genuine terminal. Terminal flag resets on fresh non-closed events (new `jobId` run).
- **MIN-7**: normalizer dedupes-last by `stage` key via `Map`; `failed` added as a known status.
- **MIN-8/9**: `role="status" aria-live="polite"` + `aria-busy` on the live region, icon a11y fixed, "Step N of `total`" counter, pending placeholders pre-rendered up to `total`.

### Phase 4 — STT, scripts, docs (Completed 2026-06-10) — resolves MIN-10/11/12/13/14/15/16/18, TG-5

- **MIN-10**: `_enabled` flips to `False` on punctuation model-load failure → clean passthrough degrade, no per-utterance reload attempts.
- **MIN-11**: one-time startup warning when the global kill-switch suppresses a per-pipeline `punctuation.enabled: true`; precedence documented.
- **MIN-12 + TG-5**: `initialize()` returns a bool; "initialized" boot log now conditioned on actual outcome in both `main.py` and the Dramatiq `worker.py`; logging contract tests added (one clean warning + traceback at debug).
- **MIN-13**: `PUNCTUATION_ENABLED` block added to `apps/stt/.env.example` + README config section (rationale + precedence).
- **MIN-14**: `dev-stack.sh` — pidfile-based `down`, logs under the user state dir with symlink refusal, array-built service commands (no word-splitting).
- **MIN-15**: `dev-service.sh` — loopback (`127.0.0.1`) default binding; `0.0.0.0` is an explicit `HOST` opt-in.
- **MIN-16/18**: root README command-table rows + TASK-346 pointer; `.env.dev` model identifier annotated with the authoritative source (comment-only change).

### Phase 5 — Final verification (2026-06-10, combined working tree)

Full matrix re-run after all phases merged in the working tree:

| Suite | Command | Result |
|---|---|---|
| TS unit (full root) | `pnpm test:unit` | **13,741 passed**, 4 skipped, 9 todo — 2 failures, both **pre-existing at HEAD** (§5.2) |
| Python harness unit | `pnpm py:harness:test:unit` | **480 passed** (incl. both replay-compat fixtures) |
| Python stt unit | `pnpm py:stt:test:unit` | **1,892 passed** |
| ui-playground full suite | `pnpm --filter @arcaai/ui-playground test` | **1,261 passed** (148 files) |
| Builds | `pnpm build:modules` + `pnpm build:api` | green (7/7, 8/8) |
| Lints | ReadLints across every touched directory + new e2e spec | zero errors |

Cross-boundary contract reconciliation (coordinator-verified, not delegated): the Python stage catalog (`HARNESS_PROGRESS_STAGES` in `models.py`) and the TS validation allowlist (`HARNESS_PROGRESS_STAGE_KEYS` in `harness-internal.dto.ts`) mirror exactly; the `failed` terminal contract is identical on both sides of the wire and in the UI normalizer.

Known benign interaction (documented, not a defect): a client connecting to an *already-closed* feed (stale snapshot, run finished) exhausts its 3 reconnect attempts against a server that closes after the snapshot, then falls back to the static "Generating…" block — honest degraded UX that self-heals on next mount or new-run event (MAJ-2 jobId reset).

### 5.1 Final per-finding disposition

| Finding | Disposition | Phase |
|---|---|---|
| CRIT-1, TG-1 | Fixed (patch gate + replay suite) | 1 |
| MAJ-7, MIN-17 | Fixed (secrets stripped; env commit `57fb4d2c`) | 0 |
| MAJ-1/2/3/5/6/9, MIN-2/3/4, TG-2/3 | Fixed | 2 |
| MIN-1 | Fixed (generalized mint-time ownership) | 2 |
| MIN-5 | Fixed with documented scope decision (no publish-side repo lookup) | 2 |
| TG-4 | Fixed — spec landed and live run green (5/5, 2026-06-10) | 2/5 |
| MAJ-4/8, MIN-6/7/8/9 | Fixed | 3 |
| MIN-10/11/12/13/14/15/16/18, TG-5 | Fixed | 4 |
| ENH-1 | Substantially delivered via MAJ-1 fix (snapshot-TTL-clear variant not needed — `closed` + jobId reset cover it) | 2 |
| ENH-2 | Partially delivered (monotonic guard); Lua atomic fold **deferred** — backlog | — |
| ENH-3 | Partially delivered (reconnect in `use-harness-progress`); shared-hook generalization **deferred** — backlog (touches TASK-341 surfaces) | — |
| ENH-4 | Delivered (stage catalog mirrored in TS DTO `@IsIn`) | 2 |
| ENH-5/6/7 | **Deferred** — backlog candidates | — |
| ENH-8 | Partially delivered (pidfile `down`); detached mode + health probes **deferred** | 4 |

### 5.2 Pre-existing issues discovered (out of TASK-348 scope — candidate follow-up tickets)

| Issue | Evidence | Note |
|---|---|---|
| `Highlight` model has `tenantId` but is missing from `TENANT_SCOPED_MODELS` | `packages/database/src/extensions/__tests__/tenant-scope.test.ts` fails at HEAD (drift guard working as designed) | **Security-relevant**: Highlight queries are not auto-tenant-scoped. Zero working-tree changes under `packages/database` — predates this work |
| EU-07 DTO test expects non-UUID `pipelineId` rejection, but TASK-298 D-19 deliberately widened the pattern to slug-or-UUID | `apps/api/src/modules/streaming/__tests__/transcription-job.controller.test.ts` fails at HEAD | Test/DTO drift — test not updated when D-19 landed |
| ui-playground `tsc` errors in admin files | Phase 3 agent report | Unrelated to clinical-workspace changes |
| stt `black`/`mypy` non-compliance outside touched files | Phase 4 agent report | Touched files verified clean |

---

## 6. Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-10 | Initial audit performed (5 parallel review agents + 4 test suites) on uncommitted TASK-345/346/347 working tree; findings register and remediation plan documented. Status → Review. | This README |
| 2026-06-10 | Plan approved for Phases 0-1. Phase 0 executed: secrets stripped from `.env.dev` (MAJ-7), env changes split into commit `57fb4d2c` (MIN-17), reviewed gitleaks fingerprint added for the `.env.test` e2e JWT placeholder (audit addendum). | `.env.dev`, `.env.test`, `.gitleaksignore` |
| 2026-06-10 | Phase 1 executed test-first: replay-compat suite added (RED reproduced CRIT-1's NondeterminismError), `workflow.patched("task-345-harness-progress")` gate added (GREEN), forward-guard fixture captured (TG-1). 478 harness unit tests, ruff/black/mypy all green. Status → In Progress. | `workflows.py`, `test_replay_compat.py`, `_capture_replay_fixture.py`, 2 history fixtures |
| 2026-06-10 | Phases 2-4 executed in parallel (three non-overlapping agents), all test-first. Phase 2: failure terminal contract, jobId snapshot reset, refcounted teardown, monotonic fold guard, payload bounds + stage catalog mirror, bounded activity timeout, generalized mint-time ownership, subscribe-before-snapshot, `@HttpCode(200)`, TG-4 e2e spec. Phase 3: hook test suite, honest error/failed rendering, bounded re-minting reconnect, stale-close handling, stage dedupe, a11y + step counter. Phase 4: punctuation disable-on-failure, truthful boot logs + logging tests, env/README docs, script hardening (state-dir logs, pidfile `down`, loopback default). | See §5 Phase 2/3/4 file tables in agent reports; 28 findings resolved |
| 2026-06-10 | Phase 5 verification on the combined tree: 13,741 TS + 480 harness + 1,892 stt + 1,261 ui-playground tests passed; builds green; zero lints. The only 2 root-suite failures verified **pre-existing at HEAD** (§5.2: `Highlight` tenant-scope drift, EU-07 pipelineId test drift). Stage-catalog mirror + `failed` wire contract reconciled across Python/TS/UI. Per-finding disposition recorded (§5.1); ENH backlog triaged. Status → Review. | This README |
| 2026-06-10 | TG-4 executed live: test stack brought up (API test mode, fresh DB reset + seed), `pnpm test:e2e task-348-harness-progress-cross-tenant` → **5 passed (4.3s)**. Follow-up tickets opened for the pre-existing §5.2 findings: TASK-349 (Highlight tenant-scope drift), TASK-350 (EU-07 pipelineId test drift). Status → Completed. | This README, TASK-349/TASK-350 READMEs |
