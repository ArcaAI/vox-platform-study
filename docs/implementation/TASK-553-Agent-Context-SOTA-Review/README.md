# TASK-553 — Agent, Instruction & Context Management: SOTA Review + Hardening

| | |
|---|---|
| **Status** | Review |
| **Type** | review / refactor / quality |
| **Created** | 2026-07-24 |
| **Branch** | fix/2605-review |
| **Depends on** | TASK-533 (agentic loop), TASK-544 program (545–552) |

## Requirement Analysis

The harness agentic loop (TASK-533 + TASK-544 program) is implemented: departments own
one-or-many agents that follow instruction templates ("new-visit" / "re-visit"), optionally
apply a doctor's personalized DNA-writing-style instructions, ingest additional context during
a live consultation, and perform realtime knowledge/entity extraction, note-taking and
summarization over the streaming transcript.

This ticket:

1. Reviews the current implementation of **agent management**, **agent instruction
   management**, and **agent context management** in the harness agentic loop, end to end
   (control plane → runtime → realtime ingestion).
2. Researches current (2025–2026) SOTA best practices for those three concerns.
3. Documents findings in detail: defects, performance issues, quality gaps, and improvement
   opportunities — each mapped to a SOTA practice and anchored to code.
4. Produces a phased implementation plan with sub-tasks sized for parallel execution by
   allocated agents (sonnet-5 for well-scoped mechanical work, opus-4.8 for complex/risky
   work), then executes it.

## Current State Evaluation

Full detail in the three exploration reports; headline architecture facts:

- **Two loops, not one.** The genuinely realtime path is the TS `LiveDocumentationService`
  (segment-debounced, SMR-direct, windowed/whole transcript modes, generation-id guarded).
  The `apps/harness` Temporal `HarnessDocWorkflow` is a **single-shot** durable
  guides→generate→sensors→gate pass over the completed transcript (one
  `TranscriptionCreated` trigger per consultation; only `approval`/`edit` signals; bounded
  regen loop; fail-safe aggregator; claim-check for history size; PHI egress guards;
  TASK-551 redaction with audit manifest). See `exploration-runtime.md`.
- **Instruction plane** is a 4-tier resolution cascade (doctor-preferred → department-default
  `DepartmentAgent` with pinned `PromptVersion` → legacy department prompt-id columns →
  SYSTEM catch-all), DRAFT→PUBLISHED→APPROVED lifecycle with eval-gated promotion
  (TASK-549) and SYSTEM golden-library resync (TASK-548). See `exploration-control-plane.md`.
- **Realtime ingestion** is Redis Streams (STT-v2 XADD → gateway XREADGROUP → WS relay),
  finals-only persistence at session finalize, single harness trigger; live summary flows
  browser←SSE (gateway-direct, single-use stream tickets). See `exploration-realtime.md`.

The 2026 SOTA consensus architecture (single stateful orchestrator + ephemeral read-only
sub-tasks returning compact structured results) matches the harness's Temporal
workflow+activities design — the architecture is sound; the defects are in the governance
seams and the realtime edges.

## SOTA Research Findings

See `sota-research.md` (six sections: instruction management, context engineering,
realtime/streaming loops, ambient clinical documentation, tenant-instruction safety,
multi-agent orchestration; each item mapped to this harness).

## Findings Register (defects / improvements)

See `findings.md` — 36 findings (F-01…F-36): 2 CRITICAL, 8 HIGH, 14 MED, 12 LOW/INFO.
Flagship: **F-01** (prompt version pinning silently inert in the generation path) and
**F-02** (eval-gated promotion bypassable via content edits on APPROVED templates).

## Implementation Plan

Four parallel lanes with **disjoint file ownership** (repo carries heavy uncommitted work on
`fix/2605-review`; agents work in-tree, no worktrees, no git state changes). Lane A owns ALL
schema/migration/generator steps so `pnpm db:generate`/`gen:model` never run concurrently.

| Lane | Agent (model / effort) | Findings | Owned surface |
|---|---|---|---|
| **A — Instruction governance & prompt hardening** | opus-4.8 / xhigh | F-01, F-02, F-03 (prompt DTOs + spotlighting + system layer), F-16, F-17, F-20, F-33 | `prompt-template.prisma` + `department-agent.prisma` + one TASK-553 migration (+psql apply to dev/test), domains `PromptTemplate*`, applications `prompt-resolution/`, `prompt-assembly`, `prompt-management` (+DTOs), their tests |
| **B — Realtime streaming reliability** | opus-4.8 / high | F-04, F-05, F-06, F-07, F-21, F-30, F-36 | `live-documentation.service.ts`, `stt-ws.gateway.ts`, `streamingSession.service.ts`, SDK `SttWebSocketClient.ts`, admin-console dead hook, their tests |
| **C — Python services hardening** | sonnet-5 / high | F-08, F-12, F-23, F-26, F-29 (+ dev token check) | `apps/stt` streaming settings/enqueue, `apps/harness` `workflows.py`/`activities.py`/`worker.py`/`models.py`, `scripts/dev-service.sh`; replay-compat suite must stay green |
| **D — Data layer & context perf/safety** | sonnet-5 / high | F-09, F-10, F-14, F-15, F-03 (context/highlight DTO caps + attachment fold cap) | `sttInternal.service.ts` + `stt-internal.controller.ts` (+DTO), `harness-internal.service.ts`, `context.service.ts`, `TranscriptSegment`/`NamedEntity` repositories, context/highlight DTOs, their tests |

Deferred findings (F-11, F-13, F-18, F-19, F-22, F-24, F-31, F-32, F-34, F-35) carry
follow-up recommendations in `findings.md`.

**Verification gates** (per lane + final cross-cutting pass): affected package unit tests
(`pnpm --filter @arcaai/applications test`, `@arcaai/domains`, `@arcaai/vox`), targeted
`pnpm test:unit` for apps/api suites, `pnpm py:harness:test` (incl. `test_replay_compat`),
`pnpm py:stt:test:unit`, builds of touched packages, migration SQL applied to dev (5432)
and test (5433) DBs via psql (db-push-managed — additive SQL only, never reset).

## Implementation Summary

All four lanes completed 2026-07-24 (parallel agents on disjoint files; opus-4.8 on lanes
A/B, sonnet-5 on lanes C/D), plus two orchestrator wire-ups. 26 of 36 findings fixed; 10
deferred with written recommendations in `findings.md`.

### Lane A — Instruction governance & prompt hardening (F-01, F-02, F-03p, F-16, F-17, F-20, F-33)

- **Schema/migration** `20260724000000_task_553_prompt_governance`:
  `PromptTemplate.approvedVersionNumber Int?` + backfill (`= currentVersionNumber WHERE
  status='APPROVED'`; dev 71 rows, test 89 rows) + composite index
  `DepartmentAgent(tenantId, departmentId, isDefault)`. Applied via psql to dev (5432) and
  test (5433); `gen:model`/`gen:entity`/`gen:factory` idempotent, CI drift gates clean.
- **F-01**: `PromptResolutionService` resolves governed snapshot content for every tier
  (agent tier: `pinnedVersionNumber ?? approvedVersionNumber ?? latest`; other tiers:
  `approvedVersionNumber` snapshot, `template.content` only for version-less legacy rows);
  `PromptAssemblyService.assemble` consumes `resolved.content` (template fetch retained
  only for metadata) and surfaces `resolvedVersionNumber`. Integration tests prove pin-v3 +
  edit-to-v5 → v3 served.
- **F-02**: `approveTemplate` pins `approvedVersionNumber` inside the existing approve
  transaction; content edits on APPROVED templates accumulate un-served versions until
  re-approval (which re-runs the eval gate). No status demotion — live behavior preserved.
- **F-20/F-03**: layered deterministic `PLATFORM_SYSTEM_PROMPT` (never-fabricate,
  data-not-commands, omit-don't-invent, PHI rules); every injected section wrapped in
  `<<<EXTERNAL_DATA section="…">>>` delimiters; `@MaxLength(50000)` on template-content DTOs.
- **F-17**: dead locals removed; DNA style substituted only into placeholders present in the
  resolved content. **F-33**: `wasApprovedLiveEdit` marker on ResourceUpdated for
  APPROVED-template content edits.

### Lane B — Realtime streaming reliability (F-04, F-05, F-06, F-07, F-21, F-30, F-36)

- **F-04/F-05**: `subscribeToLiveSummary` rebuilt on the harness-progress pattern —
  refcount-only teardown (co-viewer streams survive a disconnect) + subscribe-first with
  ReplaySubject buffering and `updatedAt` de-dupe (no missed events, incl. terminal `closed`).
- **F-06/F-36**: gateway `handleResume` returns `resume_failed` (reason `unknown_session`)
  for post-grace phantom sessions; `finalizeSession`/`onModuleDestroy` clear the
  stream-session tenant binding. SDK client treats terminal `resume_failed` reasons as
  session-gone (fires `onReconnectFailed`) vs recoverable `buffer_overflow`.
- **F-07**: SDK reconnect chain re-arms when a reconnect attempt fails to open; failure
  callback fires exactly once at budget exhaustion.
- **F-21**: dead `agentic.context.claimCheck.minBytes` knob removed from the live lane (the
  real threshold is harness-side `HARNESS_CLAIM_CHECK_MIN_BYTES`). **F-30**: dead
  `useLiveSummaryStream` hook removed from admin-console.

### Lane C — Python services hardening (F-08, F-12, F-23, F-26, F-29)

- **F-12**: `persist_entities` exhaustion degrades to safe (workflow completes without NER
  priors) instead of failing the run; command-sequence-neutral, replay suite green
  (12 passed, all 10 patch eras; Wave 2 later added an 11th era — see below).
- **F-23**: `fetch_policy` classifies 401/403 as non-retryable `PolicyAuthError` with a loud
  `harness.policy_auth_failed` log naming `HARNESS_SERVICE_TOKEN`; transient outages
  unchanged. `scripts/dev-service.sh` verified already exporting the token (no change).
- **F-29**: `HARNESS_MAX_CONCURRENT_ACTIVITIES` (default 8) now caps Temporal worker
  admission. **F-26**: replay-compat comment on the intentionally-unused
  `warm_start_enabled` field.
- **F-08**: `streaming_inference_queue_maxsize` declared as a real STT-v2 setting; the
  steady-state enqueue is now bounded (`wait_for` 1.0s) and drops with a structured warning
  + new `STREAMING_INFERENCE_QUEUE_DROPPED_TOTAL` metric — captions degrade instead of
  silently losing durable audio.

### Lane D — Data layer & context perf/safety (F-09, F-10, F-14, F-15, F-03p)

- **F-10**: `assertConsultationWritable` (404 on non-ENABLED) guards all five harness
  write-back paths. **F-09**: `Idempotency-Key` honored on `POST internal/stt/transcripts`
  with Redis single-flight + response replay (derived key fallback); existence check kept
  as second layer.
- **F-14**: hand-written `createMany` on `TranscriptSegmentRepository`/`NamedEntityRepository`;
  segment persistence and NER persistence are now single batched inserts.
- **F-15**: DB-level pagination for `getContextItemsPaginated`; `Promise.all` for relation
  fetches; single `id IN (…)` batch for tenant asserts (404 semantics preserved).
- **F-03**: `@MaxLength(200000)` context content, `@MaxLength(10000)` highlight fields;
  attachment fold capped at 20k chars with explicit truncation marker.

### Orchestrator wire-ups (cross-lane)

- `harness-internal.service.ts` prompt provenance now prefers
  `assembled.resolvedVersionNumber` (the version the LLM actually saw), falling back to the
  mutable row only for version-less legacy templates.
- `claimCheck.minBytes` removed from `agentic-context.descriptors.ts` (defaults + descriptor)
  — zero consumers remained; no parity test referenced it.

### Verification evidence (condensed, real output)

- `@arcaai/database` test: **868 passed**. `@arcaai/domains` build clean, test **1395
  passed** / 2 skipped / 9 todo.
- `@arcaai/applications` build clean; **full suite after all lanes + wire-ups: 342 files,
  6904 passed | 4 skipped, 0 failed** (76s).
- apps/api streaming suites **224 passed**; stt-internal controller **6/6**;
  `pnpm build:api` 8/8 tasks.
- `@arcaai/vox` core suites **1385 passed**; admin-console streams/client tests **26 passed**.
- `pnpm py:harness:test` **1011 passed** (incl. `test_replay_compat` 12 passed, all 10
  eras); `py:harness:lint` clean. `pnpm py:stt:test:unit` **2456 passed** / 1 skipped
  (pre-existing pyannote skip); `py:stt:lint` clean.
- Migration applied to dev + test DBs (psql: ALTER/UPDATE 71 & 89/CREATE INDEX; column,
  index, and backfill verified by query).
- Lint: 0 errors on all touched files (only-warn treated as errors; pre-existing warnings
  in `live-documentation.service.ts` untouched).

## Wave 2 Implementation Summary (deferred findings — 2026-07-25)

All 11 deferred findings closed per `followup-plan.md` (lanes E/F opus-high, lane G
sonnet-high, disjoint files, TDD with RED→GREEN evidence per lane report).

### Lane E — Governance & schema features
- **F-18** revisit carry-forward: default-OFF knob `agentic.revisit.carryForwardEnabled`;
  producer loads the parent visit's most authoritative note (SIGNED_NOTE > MODIFIED_SUMMARY
  > RAW_SUMMARY; deleted parent ⇒ null, cross-tenant parent ⇒ 404), 15k-char cap enforced at
  both producer and assembler; injected as a non-authoritative `EXTERNAL_DATA
  section="prior_visit_summary"` block with a mandatory re-confirm preamble. Dead
  `sameDayPrequelSummary` param/variable removed (+ seed metadata/prose swapped to
  `prior_visit_summary` by the orchestrator).
- **F-24** exemplar curation: `ExemplarCurationStatus` enum + `curationStatus` (default
  PENDING) + `(tenantId, curationStatus)` index; knob `agentic.fewshot.curationMode`
  (`off`|`enforce`, default `off` = current behavior); admin
  `PATCH admin/harness/gate-edit-exemplars/:id/curation` (single-field, OCC via
  `updateWithVersion`, projection response, ResourceUpdated sys-event — `GateEditExemplar`
  was already in `ResourceType`).
- **F-11** SummaryMeta OCC: `_version` column (migration backfilled default 1 on both DBs);
  mapper strips `version`; `finalizeAssurance` is now compare-and-set with one full
  read-modify retry on conflict.
- Migration `20260725000000_task_553b_governance_wave2` (all statements idempotent),
  psql-applied to dev(5432) + test(5433), verified identical.

### Lane F — Temporal & STT concurrency/perf
- **F-13** assemble reuse behind NEW patch era `task-553-assemble-reuse` — invariance was
  verified first; reuse is deliberately narrowed to the pre-delivery regen loop
  (`_regen_compute` keeps its own call because the early draft persist can add NamedEntity
  rows the assemble reads). New captured replay fixture + forward-guard test; all 12 prior
  fixtures replay green unchanged (single-iteration runs record no marker — byte-identical
  legacy histories). **Replay suite is now 13 tests / 11 eras.**
- **F-32** double-tail guard: atomic per-session test-and-set latch covering all FOUR
  finalize trigger sites (the plan's three + `end_session`); finalize lock untouched.
- **F-19/F-35**: `prompt_chars` + `prompt_tokens_est` on every LLM_CALL trajectory step;
  `harness.prompt_size_warn` above `HARNESS_PROMPT_SIZE_WARN_CHARS` (default 400000);
  nothing truncated. Cache-stat passthrough audited end-to-end and proven already lossless
  (locked by a test that passed on RED). Reliable cache-hit population still needs an
  apps/smr `GenerationStats` normalization — recorded in `validation-plan.md`.

### Lane G — Scoped hardening
- **F-22**: `handleSummaryGenerated` skips the BullMQ NER job (and still completes the
  pipeline) when `harnessEnabled` — the harness persists its own entities. Browser-side NER
  remains the one documented owner decision (nothing persisted there).
- **F-28**: two-tier caps (warn 10k / hard-cap 50k, log-once) on Python
  `StreamSession.results` and TS `LiveSession.transcriptParts`.
- **F-31**: `SttWebSocketClient.stopAndDrain(5000)` — intentional-stop drain that keeps the
  socket open for the tail final until terminal status or timeout, reconnect suppressed.
  Orchestrator wire-up activated it: `StreamingBackendSTTProvider.destroy()` prefers
  `stopAndDrain` (optional interface method; fallback `disconnect()` preserved) + test.
- **F-34**: `scrubForeignProvenanceIds` — one batched in-tenant check over
  `caseNoteIds/preSummaryIds/previousSummaryIds` on the two reader paths that surface them
  (`getSummaryMeta`, `getContextItemWithRelations`); poisoned ids dropped with a warning,
  reads never 500. Exploration confirmed no other live dereferencing reader exists.

### Wave 2 verification evidence (condensed, real)

- `@arcaai/applications` full: **6931 passed | 4 skipped, 0 failed** (Lane E final run;
  Lane G's parallel run 6930 — the delta is Lane E's own late-landing test).
- `@arcaai/domains` 1395 passed; `@arcaai/database` 868 passed (re-run after seed swap);
  generator drift checks clean ("no drift", "schema coverage OK", 74 models);
  `resourceType.enum-parity` green. apps/api full unit **2422 passed** (harness-admin 62).
- `py:harness` **1023 passed** (replay **13 passed** incl. the new era; ruff + mypy clean).
  `apps/stt` unit **2464 passed** + integration 45 passed (3 skipped, live stack absent);
  ruff clean.
- `@arcaai/vox` full **3571 passed**; `@arcaai/stt` **419 passed** + build clean (after the
  stop-drain wire-up).
- Environment note: the arcaenv editable install pointed at the removed `apps/stt-v2` path;
  re-pointed via `pip install -e apps/stt --no-deps` (environment-only fix).

### Not runtime-verified (owner tail)

Unit/integration-level verification only — no live-stack browser/e2e pass this session
(consistent with the program's other tickets in Review). See `validation-plan.md` for the
recommended standing automation and the owner's manual validation checklist (pin-an-agent
prompt check, carry-forward flip, curation enforce flip, two-tab SSE, >15s STT reconnect,
CAS-retry log observation).

## Change History

| Date | Change |
|---|---|
| 2026-07-24 | Ticket created; exploration (3 agents) + SOTA research (1 agent) launched |
| 2026-07-24 | Exploration + research complete: `sota-research.md`, 3 exploration reports, `findings.md` (36 findings, 2 critical). TASK-533 README era-count drift (F-27) fixed in place |
| 2026-07-24 | Implementation Wave 1: 4 parallel lanes (A/B opus-4.8, C/D sonnet-5) + 2 orchestrator wire-ups; 26 findings fixed; all gates green (evidence above). Status → Review |
| 2026-07-25 | Wave 2 (`followup-plan.md`): all 11 deferred findings closed via lanes E/F (opus, high) + G (sonnet, high) + orchestrator wire-ups (stop-drain activation in `@arcaai/stt`, seed variable swap). New patch era `task-553-assemble-reuse` (replay 13/13). `validation-plan.md` added. All gates green |
