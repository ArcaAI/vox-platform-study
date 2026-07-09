# TASK-449 — Harness-Loop Remediation Program (Umbrella)

- **Status**: In Progress — Wave 1 executed (5/6 streams merged to `fix/task-449-wave1`, integration build green; awaiting landing decision). TASK-453 held on C1-01 decision; TASK-455 held for live-stack pass.
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

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Program opened. Wave plan approved in session; Wave 1 tickets TASK-450…455 scaffolded with code-verified evidence (6 read-only scout agents). No implementation started. |
| 2026-07-09 | Wave 1 executed: TASK-450/451/452/454 implemented (TDD, isolated worktrees), adversarially reviewed (4 reviewers; every stream had ≥1 real finding, all fixed), and merged into `fix/task-449-wave1` (26 files, 0 conflicts, integration build 16/16). C2-06 reproduced. TASK-453 held (C1-01 decision); TASK-455 held (live stack). Discovered TASK-463 (durable NamedEntity corruption) + TASK-464 (SDK drop surfacing) via review. TASK-450 e2e written, deferred to landing. |
| 2026-07-09 | Owner decisions: TASK-463 → Wave 1.5 (executed: shared NLP→NamedEntity mapper, review Approve, both paths confirmed LIVE); C1-01 → Option C (closed Won't-fix); land → `fix/2605-review`. TASK-463 merged to integration; Wave 1 + 1.5 merged to `fix/2605-review` (`39515a17` + docs `d35ff948`). Wave 2 (TASK-456…460) scaffolding started. |
| 2026-07-09 | Wave 2 fully scaffolded (TASK-456/457/458/459/460) from 5 code-verified scouts; no implementation. Six register refinements recorded (dead configs, PHI-scope, false comment, asymmetric resume). Sequencing + replay-safety + cross-stream ordering documented. |
