# TASK-449 — Harness-Loop Remediation Program (Umbrella)

- **Status**: In Progress — Wave 1 + 1.5 + **Wave 2 (Batches 1 & 2) landed on `fix/2605-review`** (merges `39515a17` Wave 1/1.5, `a786aa23` Batch 1, `90bb993d` TASK-455, `b2645dc6` TASK-457). TASK-457 live-validated (resume e2e green: `fromSeq=lastSeq+1`, ready-ack, no dup/freeze). TASK-453 closed Won't-fix. **Remaining**: backlog TASK-464/465/466, Wave 3 (P2), SOTA enhancement track.
- **Type**: infrastructure (program coordination; child tickets are bugfix)
- **Parent review**: [TASK-448 — Harness-Loop Quality Review](../TASK-448-Harness-Loop-Quality-Review/README.md) — 33 verified findings (1 Critical, 11 High, 18 Medium, 3 Low), review-only, nothing executed there.
- **Owner surfaces**: coordination only — this ticket owns NO source files. Every code change belongs to a child ticket.
- **Method**: waves of parallel agent workstreams, partitioned by exclusive file ownership; orchestrator (main session) owns merges and wave transitions.

## Requirement Analysis

Execute the TASK-448 remediation roadmap (P0 → P1 → P2) as a coordinated program of parallel workstreams, each an independently reviewable ticket, without two concurrent agents ever editing the same file.

### Acceptance criteria (program-level)

- [ ] All 33 register findings either **fixed** (red-then-green test evidence in the child ticket) or **explicitly refuted-and-closed** (permitted only for the two PLAUSIBLE findings C2-02, C2-06 after re-verification).
- [ ] Streaming e2e suite covers resume-after-drop, backpressure recovery, ticket-refresh mid-session (TASK-455).
- [ ] The consumer-groups migration (Wave 2) ships only with measured no-regression latency + zero-loss evidence from the eval harness.
- [ ] Every child ticket README carries an Implementation Summary with pasted verification output.
- [ ] Full monorepo gates green at each wave barrier: `pnpm lint`, `pnpm test:unit`, `pnpm test:integration`, affected `pnpm py:<svc>:test`, `pnpm test:e2e`.

## Current State Evaluation

See TASK-448 §Findings register and §Per-subsystem state for the verified defect inventory. Baseline facts for this program:

- Branch situation (2026-07-09): `fix/2605-review` carries a large unrelated diff; **none** of the finding files are touched there. All remediation branches cut from `main`.
- Ticket numbering: TASK-448 was the highest existing number in `docs/implementation/` + `docs/archive/`; this program allocates **TASK-449 (umbrella) and TASK-450…462 (workstreams)**.
- No streaming e2e coverage exists today (TASK-448 finding S-10) — Wave 1 builds it; Wave 2's riskiest change is gated on it.

## Implementation Plan

### Wave structure

| Wave | Theme | Tickets | Barrier to next wave |
|---|---|---|---|
| **1 (P0)** | Patient safety & PHI | TASK-450…455 (6 parallel streams) | All merged; per-stream suites + full lint/unit green; e2e skeleton running |
| **2 (P1)** | Durability under failure | TASK-456…460 (5 streams) | Consumer-groups migration passes eval harness (latency/loss measured) |
| **3 (P2)** | Cleanup | TASK-461, TASK-462 | Program close-out |

### Wave 1 tickets (this scaffold)

| Ticket | Stream | Findings | Sev | Size | Status |
|---|---|---|---|---|---|
| [TASK-450](../TASK-450-Stream-Ticket-Tenant-Binding/README.md) | Gateway PHI egress | C4-01 | **Critical** | M | Pending · **expedite** |
| [TASK-451](../TASK-451-STT-Commit-Policy-VAD-Onset-Safety/README.md) | STT commit & VAD safety | C2-01, C2-06† | High | M | Pending |
| [TASK-452](../TASK-452-Live-NER-Contract-Aggregation/README.md) | Live NER contract | C5-01, C5-02 | High | S | Pending |
| [TASK-453](../TASK-453-Harness-Assurance-Before-Ready/README.md) | Harness premature-ready | C1-01 | High | M | **Blocked** (decision gate) |
| [TASK-454](../TASK-454-Client-Audio-Drop-Visibility/README.md) | Client audio-drop visibility | C6-01 | High | M | Pending |
| [TASK-455](../TASK-455-Streaming-E2E-Eval-Harness/README.md) | Streaming e2e + eval harness | S-10, S1-EVAL | — | L | Pending · gates Wave 2 |

Exact per-file ownership manifests live in each child ticket's §File-ownership manifest (all code-verified against line numbers by read-only scouts on 2026-07-09).

† C2-06 is PLAUSIBLE (not reached by the TASK-448 verifier) — TASK-451's first task is re-verification; if refuted, close that half with evidence instead of fixing. (Scout's close read says the claim holds; re-verify anyway.)

**Expedite rule**: TASK-450 (Critical, live cross-tenant PHI egress) merges as soon as it individually passes its gates — it does not wait for wave synchronization.

### ⚠️ Open decision — blocks TASK-453 (C1-01)

Scouting revealed the harness premature-ready behavior is **coded as an intentional product decision** ("RELAXED sign-off governance", Q2a), with a test asserting it as desired ([summary.service.test.ts:1639](../../../packages/applications/src/services/consultation/summary/__tests__/summary.service.test.ts)). TASK-453 is therefore **Blocked** pending a product/clinical owner's choice among: **A** block sign-off during the assurance window · **B** keep autonomy but run the safety-only sensor before "ready" (recommended — the genuine gap is safety-only) · **C** accept as-is, close won't-fix. See [TASK-453 §Decision gate](../TASK-453-Harness-Assurance-Before-Ready/README.md). This is the one Wave-1 item that cannot start on assignment alone.

### Discovered during Wave 1 review (not in the original TASK-448 register)

Adversarial review surfaced two issues the original review missed — the scoped fixes are correct, but each has a sibling path needing its own work:

| Ticket | Discovery | From | Severity | Status |
|---|---|---|---|---|
| [TASK-463](../TASK-463-NamedEntity-Persistence-Contract/README.md) | The C5-01 contract bug also lives in TWO paths that persist `NamedEntity` rows (`ner.processor.ts`, `summary.service.ts`) → durable data corruption | TASK-452 review (I-1) | **High** (durable) | **Wave 1.5 — in progress** (folded in per owner, 2026-07-09) |
| [TASK-464](../TASK-464-SDK-Provider-Drop-Surfacing/README.md) | The SDK provider counts audio drops but nothing surfaces them → the vox consultation path is still silent (only the playground hook was fixed) | TASK-454 review (Imp-1) | Med–High | Backlog (pending prioritization) |

TASK-463 is durable clinical-data corruption that TASK-448 did not catch; the product owner folded it into **Wave 1.5** (executed alongside Wave 1's landing). TASK-464 is backlogged.

### Decisions resolved (2026-07-09)

- **TASK-463** → Wave 1.5, execute now (above).
- **C1-01 / [TASK-453](../TASK-453-Harness-Assurance-Before-Ready/README.md)** → **Option C (accept as-is)** — closed Won't-fix, no code. Removes the `summary.service.ts` coordination concern with TASK-463.
- **Landing** → merge the integration branch (Wave 1 + 1.5) into **`fix/2605-review`** once TASK-463 lands.

### Cross-stream conflict ledger (Wave 1 → Wave 2)

| Shared file | Wave 1 owner | Later claimant | Rule |
|---|---|---|---|
| `stt-ws.gateway.ts` | TASK-450 (handshake region) | TASK-457 (consumer groups, Wave 2) | 450 merges first |
| `live-documentation.service.ts` | TASK-452 (NLP mapping block) | TASK-459 (Wave 2) | 452 merges first |
| `workflows.py` | TASK-453 (optimistic path) | TASK-458 (Wave 2) | 453 merges first |
| `use-live-stt-session.ts` / `SttV2WebSocketClient.ts` | TASK-454 | TASK-461 (Wave 3) | 454 merges first |
| `session_manager.py` | — (Wave 1 does not touch it) | TASK-456 then TASK-457 (Wave 2) | 456 merges before 457's Python half |
| `packages/agentic-sdk-v2` (file-disjoint) | — | TASK-461 ∥ TASK-464 (Wave 3 / backlog) | file-disjoint (461: `SttV2WebSocketClient`/`KnowledgePipeline`; 464: `agenticStore`/`useArcaAudio`/`PluginManager`) → parallelize, no ordering |

### Orchestration contract (applies to every child ticket)

1. **One agent, one worktree, one ticket** — branch `fix/task-<nnn>-<slug>` from `main`; agents never merge, the orchestrator does.
2. **File-ownership manifest is binding** — an agent needing to touch any file outside its manifest (barrels, `turbo.json`, shared configs, another stream's file) STOPS and reports; the orchestrator serializes that edit.
3. **Context pack** — every agent prompt includes: the child ticket README, the two-pipeline architecture preamble (below), and the `.claude/rules/` file(s) for its layer.
4. **TDD is mandatory** — the first commit is a failing test reproducing the defect. No fix before red. Behavior over implementation.
5. **Verification gate per stream** — the child ticket's listed commands, output pasted into its README §Implementation Summary. Harness workflow changes additionally pass replay-compat tests.
6. **Adversarial review before merge** — a separate reviewer agent per stream, prompted to refute the fix and to check the TASK-448 "verified-sound" behaviors did not regress (replay determinism, 404-over-403 tenancy, within-connection egress backpressure, graceful SOAP parsing).
7. **Wave barrier** — next wave starts only after the integration branch passes the full gate set.

### Architecture preamble (include verbatim in every agent prompt)

> Two transcript pipelines run over each consultation and must not be conflated:
> **REALTIME LOOP** (best-effort, clinician-facing): mic → SDK/WS → gateway `/ws/stt-v2/stream` → Redis `stt:audio` → STT-v2 → Redis `stt:result` → WS captions + LiveDocumentationService → SMR/NLP → SSE live summary. Ephemeral UX; never what the clinician signs.
> **DURABLE HARNESS** (post-hoc, system-of-record): finalize → WAV upload → persisted TRANSCRIPT → `TranscriptionCreated` → Temporal `HarnessDocWorkflow` (NER → RAG → bounded regen → sensors → clinician gate → WORM audit). The persisted TRANSCRIPT/summary/NamedEntity rows and the harness-gated draft are the clinical authority.
> A fix aimed at one loop must not silently alter the other.

### Wave 2 / Wave 3 (pre-allocated, scaffolded at Wave-1 exit)

TASK-456 STT finalize durability (C2-02†, C2-03, C2-05, C2-07) · TASK-457 Redis consumer-groups migration (C3-01/02/03/05/06 — gated on TASK-455) · TASK-458 Harness idempotency & escalation (C1-02…06) · TASK-459 Live-doc durability (C5-04, C5-06) · TASK-460 Gateway auth & retry hygiene (C4-02/03/04) · TASK-461 SDK/playground reconnect UX + wire contract (C6-02/03/04, C5-05) · TASK-462 Misc hygiene (C5-03 decision, C4-05, C2-04).

## Implementation Summary

### Wave 1 (P0) — executed 2026-07-09

Five of six Wave-1 streams implemented, adversarially reviewed, and assembled; TASK-453 held on the C1-01 product decision; TASK-455 held for a live-stack pass.

**Method**: each stream ran as one background agent in an isolated git worktree branched from current HEAD (`f84ff216`; NOT `main`, which is 1089 commits stale — the findings were verified against the current tree). TDD red-first; binding file-ownership manifest; adversarial reviewer per stream prompted to refute the fix and check the TASK-448 "verified-sound" behaviors; orchestrator-authorized manifest extensions for review fixes and sanctioned collateral; orchestrator owns all merges.

**Streams (all merged into `fix/task-449-wave1`, off `f84ff216`)**:

| Ticket | Findings | Branch | Individual gates | Review → fix |
|---|---|---|---|---|
| TASK-450 | C4-01 (Critical) | `fix/task-450-stream-ticket-tenant-binding` | api 72 + 63 unit, build/lint clean | I-1: 2nd un-gated mint endpoint (`refreshStreamTicket`) → gated |
| TASK-451 | C2-01, C2-06 | `fix/task-451-stt-commit-vad-safety` | stt-v2 2085 unit, ruff/mypy clean | I-1: unbounded onset dips → bounded; non-monotonic `stable_chars` proven safe |
| TASK-452 | C5-01, C5-02 | `fix/task-452-live-ner-contract` | applications 5884 + nlp 52, ruff clean | I-2/M-1: metrics-test integrity + precedence test |
| TASK-454 | C6-01 | `fix/task-454-audio-drop-visibility` | admin-console 840 + stt 411 | signal-erasure on reconnect → session-sticky latch |

**Assembly**: 4 clean `--no-ff` merges → 26 files, 1231 insertions, 0 conflicts (files disjoint by manifest; verified no real conflict markers). **Integration build** (`turbo build` of api/applications/stt/admin-console + deps in the integration worktree): **16/16 tasks successful**.

**Reproduced/refuted**: C2-06 (PLAUSIBLE) was reproduced before fixing. No finding was refuted.

**Deferred verification**: TASK-450's cross-tenant e2e (`task-450-stt-session-cross-tenant.spec.ts`) is written and compiles (`playwright --list`) but not executed — it needs the live test stack (docker + test API + STT-v2); run it at landing/CI. The 135 unit tests already cover the mint-404 / handshake-4401 / both-gates / fail-closed / no-leak scenarios.

**Discovered (new, not in the TASK-448 register)**: [TASK-463](../TASK-463-NamedEntity-Persistence-Contract/README.md) (durable `NamedEntity` corruption in 2 persistence paths — from the TASK-452 review) and [TASK-464](../TASK-464-SDK-Provider-Drop-Surfacing/README.md) (vox SDK path still silent — from the TASK-454 review). Awaiting prioritization.

**Decisions resolved (2026-07-09)**: TASK-463 → Wave 1.5 (executing); C1-01 → Option C, closed Won't-fix; landing → merge `fix/task-449-wave1` (Wave 1 + 1.5) into `fix/2605-review` after 463. TASK-464 → backlog.

### Wave 1.5 (P0.5) — executing 2026-07-09

TASK-463 (durable `NamedEntity` contract fix) runs as one TDD stream (worktree, adversarial review), then merges into `fix/task-449-wave1`. On completion the whole integration branch merges into `fix/2605-review`.

### Landing (2026-07-09)

Wave 1 + 1.5 merged into `fix/2605-review`: merge commit `39515a17` (32 files, 1475 insertions) + docs commit `d35ff948`. Integration build 16/16; combined `@arcaai/applications` 5893 tests pass. User's local config (`.env.dev`, `.claude/`, `.mcp.json`, `CLAUDE.md`) left untouched. gitleaks clean.

### Wave 2 (P1) — scaffolded (2026-07-09, no implementation)

All five tickets written with code-verified evidence (5 read-only scouts against the post-Wave-1 tree), exclusive file-ownership manifests, red-first TDD plans, acceptance criteria, and adversarial-review focus:

| Ticket | Findings | Size | Notes |
|---|---|---|---|
| [TASK-456](../TASK-456-STT-Finalize-Reaper-Durability/README.md) | C2-02/03/05/07 | M | STT finalize/reaper durability. Merges before TASK-457's Python half (shared `session_manager.py`) |
| [TASK-457](../TASK-457-Redis-Consumer-Groups/README.md) | C3-01/02/03/05/06 | L | Consumer-groups migration — **critical path**, **gated on TASK-455**. Test-breaking by design |
| [TASK-458](../TASK-458-Harness-Idempotency-Escalation/README.md) | C1-02…06 | L | Harness idempotency/escalation. Only C1-02 needs a replay patch-marker+fixture |
| [TASK-459](../TASK-459-Live-Doc-Durability/README.md) | C5-04/06 | M | Live-doc truncation carry-forward + NX owner lock (via existing `eval`) |
| [TASK-460](../TASK-460-Gateway-Auth-Retry-Hygiene/README.md) | C4-02/03/04 | M | Gateway auth uniformity + SSE re-auth + SMR retry idempotency |

**Register refinements found during scouting** (recorded in the tickets): `streaming_audio_idle_timeout_s`=300 is dead config (C2-02); C2-07's duplicate risk is `Media` rows only (transcript is idempotent); harness-progress/assurance SSE are "no PHI" per the code — only live-summary carries PHI (C4-03); STT-v2's audio consumer already resumes via `last_stream_id`, so C3-02's gap is gateway-scoped; the "resume buffer holds it" comment (C3-03) is provably false; the 2000 audio-stream bound (C3-06) is dead config. Zero consumer-group primitives exist anywhere.

**Suggested sequencing**: TASK-455 (eval harness) → TASK-456 → TASK-457 (gated on 455); TASK-458/459/460 parallelize independently. Wave 3 (P2: C5-03, C4-05, C2-04, C6-02/03/04, C5-05, C1-05-notify, C3-06, C1-06) + the SOTA enhancement track follow.

### Wave 2 Batch 1 — executed & landed (2026-07-10)

TASK-456/458/459/460 implemented (TDD, isolated worktrees, current-HEAD base), adversarially reviewed, and merged into `fix/2605-review` (merge `a786aa23`, 31 files). Every stream had ≥1 real review finding fixed before merge; **TASK-456 required a Critical rework** (loud-retain → capacity-DoS) into a durable at-least-once transcript outbox, plus two Important follow-ups (429-burst drop, at-most-once crash window). Combined build 8/8; per-package gates: stt-v2 2100 · harness 662 (replay 7) · applications 5900 · api 2021. Two new receiver-half follow-ups discovered: [TASK-465](../TASK-465-NLP-Guardrail-Service-Token-Enforcement/README.md) (from 460) + [TASK-466](../TASK-466-Harness-Callback-Consumption/README.md) (from 458).

### Wave 2 Batch 2 — executed & landed (2026-07-10)

TASK-455 (streaming e2e + loss/latency eval harness) landed first (`90bb993d`), capturing the plain-XREAD baseline (gap_count 0, coverage 0.996). Then TASK-457 (consumer-groups migration, the program's critical path) was implemented in an isolated worktree, adversarially reviewed, and **live-validated against a running test stack** before merge: the resume-after-drop TARGET e2e is green (resume `fromSeq=lastSeq+1`, `{type:'ready'}` ack confirmed, no duplicate flood, no silent freeze, control channel live). The review found a **Critical multi-replica caption-split** (cross-instance shared-group drain) + 3 Important (registration race, shutdown-orphan, seq-dedup) + minors; all fixed except I2 (seq-continuity/dedup) which is a durable-safe, deferred follow-up. Merged into `fix/2605-review` (`b2645dc6`, `--no-ff`, 13 files).

**Coordination note**: 457's WS-control (`isBinary`) fix overlapped the owner's in-flight **[TASK-467](../TASK-467-STT-WS-Control-Frame-Classification/README.md)** WIP on `fix/2605-review`. Per owner decision, the 3 overlapping TASK-467 files (gateway + gateway test + resume spec) were committed standalone (`45b3ae08`) for attribution ahead of the merge; 457's superset versions then won the merge. TASK-467's 2 non-overlapping files (backpressure-spec narrative, `vitest.config.ts` test-infra) + follow-up TASK-468 remain in the owner's WIP on `fix/2605-review` (untouched by the merge).

### Wave 3 (P2) — scaffolded (2026-07-10, no implementation)

The two Wave 3 cleanup tickets + the split-off SMR-idempotency ticket + the SOTA enhancement track are written with code-verified evidence against the current `fix/2605-review` tree (every finding re-confirmed **OPEN** before scaffolding):

| Ticket | Findings | Size | Notes |
|---|---|---|---|
| [TASK-461](../TASK-461-SDK-Reconnect-UX-Wire-Contract/README.md) | C6-02/03/04, C5-05 | M | SDK reconnect UX (recovered-status, terminal-failure cleanup) + shared transcript wire-contract + stable browser-NER ids. File-disjoint from TASK-464 → parallelize |
| [TASK-462](../TASK-462-Gateway-Backend-Hygiene/README.md) | C4-05, C2-04, C5-03 (interim) | S–M | SMR error-body sanitization + PAUSE/RESUME no-op + C5-03 **interim decision only** (annotate columns + groundedness guard; the real writer is SOTA Theme C). C2-04 flagged for a possible manifest-purity split (Python vs TS) |
| [TASK-469](../TASK-469-SMR-Idempotency/README.md) | C1-04 (residual) | M | **Split off TASK-458** — the SMR idempotency-key closure (harness sender + SMR receiver). TASK-458 narrowed retries but left the worker-crash re-invoke open (documented at `activities.py:322-327`). Supersedes TASK-466 AC-3. Replay-safe (activity-body only) |

**Already done — NOT scaffolded** (re-verified CLOSED against the tree): **C3-06** (single MAXLEN source of truth — closed by [TASK-457](../TASK-457-Redis-Consumer-Groups/README.md): `AUDIO_STREAM_MAXLEN = 10000` in `streamingAudioBridge.service.ts`) and **C1-06** (policy-fetch failure sets `reduced_assurance` — closed by [TASK-458](../TASK-458-Harness-Idempotency-Escalation/README.md): `workflows.py:259-279`). C1-05 (escalation notify) also shipped in TASK-458; its receiver half is [TASK-466](../TASK-466-Harness-Callback-Consumption/README.md).

**[SOTA enhancement track](../SOTA-Track/README.md)** scaffolded: six themes (F streaming-eval gate · A streaming ASR · B diarization · C clinical NER+linker · D live guardrails · E harness lineage/eval) mapped to 14 candidate tickets (suggested TASK-470…483) with per-theme scope/size/value/risk/deps and a measurement-first sequencing (Theme F gates A/C; E1 after C lands). Theme C (TASK-476) is the real close of C5-03.

**Suggested sequencing**: close Wave 3 (TASK-461/462/469) → SOTA Theme F (measurement gate) → parallel A1/C/D → gated A2·A3/B → Theme E.

### Discovered during SOTA (2026-07-10)

The SOTA enhancement round (live validation + per-ticket reviews) surfaced three follow-ups the earlier waves did not. Each is scaffolded as its own tracking ticket (docs only, code-verified against `fix/2605-review`), numbered from the next free slot after the SOTA allocation (470–483 taken → new findings start at 484):

| Ticket | Discovery | From | Severity | Size | Status |
|---|---|---|---|---|---|
| [TASK-484](../TASK-484-Streaming-Audio-Read-Timeout/README.md) | STT-v2 emits PARTIALS but **no final** through the gateway (`hypothesis_words 0`, `medical_wer 1.0`, `audio_coverage_ratio 0.0`); persistent `XREADGROUP "Timeout reading from localhost:6380"` on the audio stream. Reproduced across 3 configs; manifests during audio gaps / combined load (the TASK-457 continuous-audio resume e2e passed). | TASK-470/471 SOTA live validation | **High** (prod reliability) | M | Pending · **actively investigated in a parallel session (chip `task_1db4d82a`)** · blocks TASK-470 scorecard + TASK-471 latency gate |
| [TASK-485](../TASK-485-Default-Pipeline-LocalAgreement2/README.md) | The `isDefault` pipeline `production-whisper-large-v3` (also the default `streaming_pipeline_slug`) uses `PIPELINE_CONFIGS.production`, which lacks the `commit_policy: local_agreement_2` streaming block `turbo`/`best_practice_realtime` got — so TASK-471's tentative tail is dark on the default clinician path. | TASK-471 review (MINOR) | Low | S | Pending (decision-gated: is `production-whisper-large-v3` used for live streaming?) |
| [TASK-486](../TASK-486-Vox-Typecheck-Cleanup/README.md) | ~10 **pre-existing** `tsc` errors in 4 untouched `@arcaai/vox` test files (`bundle-externals.task364.test.ts`, `SttV2WebSocketClient.test.ts`, `useHarnessAdmin.test.ts`, `promptMetrics.test.ts`) leave the SDK `typecheck` quality gate RED on `fix/2605-review`. | TASK-464 + TASK-461 reviews | Low | S | Pending |

**Deferred review minors (no ticket)** — captured here for traceability; each is a small, low-severity follow-up an owner may fold into related work rather than raise standalone:

- **464-M1** — a drop→reconnect regression test to guard the TASK-454 session-sticky latch (the 454-class signal-erasure-on-reconnect fix) against future regression.
- **462-M2** — a typed/coded control-error channel for C2-04 (STT PAUSE/RESUME is a silent no-op today) to add when a real client that exercises control frames lands (adjacent to the [TASK-467](../TASK-467-STT-WS-Control-Frame-Classification/README.md) control-frame work).
- **478-Ma** — the ~30 s worst-case guardrail-hang latency ceiling (`~(max_retries+1)×timeout_s`), already documented at [TASK-478](../TASK-478-SMR-Input-Fail-Closed/README.md)'s retry loop; a hard latency cap is deferred (relies on the caller's request timeout today).

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Program opened. Wave plan approved in session; Wave 1 tickets TASK-450…455 scaffolded with code-verified evidence (6 read-only scout agents). No implementation started. |
| 2026-07-09 | Wave 1 executed: TASK-450/451/452/454 implemented (TDD, isolated worktrees), adversarially reviewed (4 reviewers; every stream had ≥1 real finding, all fixed), and merged into `fix/task-449-wave1` (26 files, 0 conflicts, integration build 16/16). C2-06 reproduced. TASK-453 held (C1-01 decision); TASK-455 held (live stack). Discovered TASK-463 (durable NamedEntity corruption) + TASK-464 (SDK drop surfacing) via review. TASK-450 e2e written, deferred to landing. |
| 2026-07-09 | Owner decisions: TASK-463 → Wave 1.5 (executed: shared NLP→NamedEntity mapper, review Approve, both paths confirmed LIVE); C1-01 → Option C (closed Won't-fix); land → `fix/2605-review`. TASK-463 merged to integration; Wave 1 + 1.5 merged to `fix/2605-review` (`39515a17` + docs `d35ff948`). Wave 2 (TASK-456…460) scaffolding started. |
| 2026-07-09 | Wave 2 fully scaffolded (TASK-456/457/458/459/460) from 5 code-verified scouts; no implementation. Six register refinements recorded (dead configs, PHI-scope, false comment, asymmetric resume). Sequencing + replay-safety + cross-stream ordering documented. |
| 2026-07-10 | Wave 2 Batch 1 executed + landed: TASK-456/458/459/460 (TDD, adversarial review — TASK-456 through a Critical rework + 2 re-reviews). Merged to `fix/2605-review` (`a786aa23`, 31 files; combined build 8/8). Discovered TASK-465 + TASK-466 (receiver halves). Batch 2 (TASK-455 → 457, live stack) pending a go/infra decision. |
| 2026-07-10 | **Wave 2 Batch 2 executed + landed — Wave 2 complete.** TASK-455 eval harness landed (`90bb993d`, plain-XREAD baseline). TASK-457 consumer-groups migration (critical path) implemented in an isolated worktree, adversarially reviewed (Critical multi-replica caption-split + 3 Important + minors; all fixed except deferred I2 seq-dedup), and **live-validated** on a running stack (resume e2e TARGET green: `fromSeq=lastSeq+1`, ready-ack, no dup flood, no freeze). Merged to `fix/2605-review` (`b2645dc6`, `--no-ff`, 13 files). Overlapping WS-control fix committed standalone as TASK-467 (`45b3ae08`) for attribution before the merge; 457's superset won. Mid-run blocker resolved: the HF model-cache drive (`/Volumes/aillusion`, `HF_HOME`) detached and was re-attached by the owner, enabling the live validation. |
| 2026-07-10 | **Wave 3 + SOTA scaffolded; C3-06/C1-06 confirmed already done; SMR idempotency split to TASK-469.** Wrote [TASK-461](../TASK-461-SDK-Reconnect-UX-Wire-Contract/README.md) (SDK reconnect UX + wire contract — C6-02/03/04, C5-05), [TASK-462](../TASK-462-Gateway-Backend-Hygiene/README.md) (gateway/backend hygiene — C4-05, C2-04, C5-03 interim), and the split-off [TASK-469](../TASK-469-SMR-Idempotency/README.md) (SMR idempotency-key closure of C1-04, supersedes TASK-466 AC-3) — all code-verified OPEN against `fix/2605-review`. C3-06 (closed by TASK-457) + C1-06 (closed by TASK-458) re-verified CLOSED → NOT scaffolded. [SOTA-Track](../SOTA-Track/README.md) scaffolded (6 themes → suggested TASK-470…483, measurement-gated). 464↔461 file-disjoint ledger row added. No implementation. |
| 2026-07-10 | **Discovered-during-SOTA tickets scaffolded (docs only).** Registered [TASK-484](../TASK-484-Streaming-Audio-Read-Timeout/README.md) (**High** — streaming audio read-timeout: STT-v2 emits PARTIALS but no final through the gateway with persistent `XREADGROUP "Timeout reading from localhost:6380"`; **actively investigated in a parallel session, chip `task_1db4d82a`**; blocks the TASK-470 scorecard + TASK-471 latency gate), [TASK-485](../TASK-485-Default-Pipeline-LocalAgreement2/README.md) (Low — the default `production-whisper-large-v3` pipeline config lacks the `commit_policy: local_agreement_2` block, so the TASK-471 tentative tail is dark on the default clinician path), and [TASK-486](../TASK-486-Vox-Typecheck-Cleanup/README.md) (Low — ~10 pre-existing `@arcaai/vox` test-file `tsc` errors reddening the SDK `typecheck` gate) — all code-verified against `fix/2605-review` (highest existing TASK was 478; new findings start at 484). Recorded three deferred review minors with no ticket: 464-M1 (latch regression test), 462-M2 (typed control-error channel for C2-04), 478-Ma (~30 s guardrail-hang latency ceiling, documented in TASK-478). No implementation. |
| 2026-07-11/12 | **SOTA model-staging + full closure/finish pass** (owner-directed). Model-staging resolved: MiniCheck **GGUF everywhere** — the calibration-gated `nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF` scorer for the guardrail groundedness gate (TASK-479) and the harness atomic-fact entailer (TASK-481), both default-OFF/fail-closed; NVIDIA checkpoints pinned — `diar_streaming_sortformer_4spk-v2.1` (475) + `nemotron-3.5-asr-streaming-0.6b` (472). Finished the last buildable implementation: the **Sortformer NeMo streaming loader** (475, fail-safe, UNVALIDATED-pending-GPU). Resolved deferred findings/defects across the backlog via 3 worktree agents + adversarial-review agents: 465 env gap, 482 dead-field, 462 M-2 control-channel typing, 489 speaker-label deviation, the **guardrail typecheck RED** (479 `Annotated` root-cause fix), 490's 2 Low PHI findings, and a pre-existing numpy-seed **flaky test**. **17 program tickets closed to Completed** (451/452/456/458/460/461/462/464/465/466/469/474/478/484/485/486/490) — each adversarially reviewed or agent-verified. **Remaining Review tickets each carry ONE concrete external blocker** and are not closeable from here: live-audio stack/e2e (450/454/455/468/470/471/473/477/487), GPU/model-weights (472/475/476/479/480/481/482), concurrent TTS session's uncommitted schema (459 DB constraint / 463 mapper nit), or prod-enablement/out-of-scope (483 S3 dep / 489 @arcaai/stt wire-threading). Nothing pushed — all on `fix/2605-review` for the owner to land. |
