# TASK-1038 — Run integrity and the delivery plane

**Status:** In Progress. Approved by the owner on 2026-10-04 as part of the TASK-1036 programme. Wave A is starting.
**Type:** bugfix (integrity) + feature (delivery plane) + performance
**Branch:** dev-2.2
**Raised:** 2026-10-04
**Programme:** TASK-1036 (UX: composer, agents, Studio) · **TASK-1038** (this) · TASK-1039 (SDK 5.0) · TASK-1040 (payload codec)
**Design record:** `docs/implementation/TASK-1036-Hope-Prompt-Agent-Config-Workflow-Studio-Lifecycle/README.md`. The findings are in §8.2, the delivery-plane design in §8.7, the integrity fixes in §8.8 and the event list in §10.3. They are not duplicated here.

## 1. Requirement Analysis

The owner set three directions on 2026-10-04:

- **W3.** Agents and prompts are pinned in every published agent and workflow, and the pin must hold at runtime. Document templates and DNA always use the latest version.
- **W5.** High performance, integrity and stability; streaming or polling; complete SDK integration; easy client setup.
- **W6.** Testing shows every event of a run.

| # | Requirement | Source |
|---|---|---|
| R1 | Published pins are **enforced at runtime**: the pinned agent version runs, with the prompt frozen inside it. | D-A |
| R2 | Every run has a bounded duration; cancel stops in-flight work. | D-B, R-4 |
| R3 | No silent data loss: a degraded node's output is kept; large payloads are claim-checked; oversized payloads fail by name. | D-H, R-3 |
| R4 | API callers can read a workflow's result (inline, or through a signed URL). | D-I |
| R5 | Streams scale and terminate: pooled readers, watcher retry, terminal fallback, backpressure, gap resync, 24 h TTL. | R-1, R-2, R-9, G11 |
| R6 | One **run protocol v2** for SSE and WS, carrying the public events plus the admin debug events. | §8.7, §10.3, OD-23 |
| R7 | `Idempotency-Key` on every start; an agent run resource (`POST /agents/:slug/runs`). | G3, OD-26 |
| R8 | Text deltas stream from workflows. | G2, OD-24 |
| R9 | Consultation data is read through **declared reads** only (tenant-checked, per-field PHI class), snapshotted at node start. | §9.3, OD-30 |
| R10 | Job streams are fixed: G6, G10, G12, G14, G16. | §8 delivery report |

## 2. Current State Evaluation

The full evidence table is in TASK-1036 §8.2. The orchestrator verified these in code on 2026-10-04:

| Finding | Evidence |
|---|---|
| D-A: the harness never reads `compiledConfig.policyBindings` | The only reference is the parser at `apps/harness/.../interpreter/compiled_config.py:281` |
| D-B: `maxTotalSeconds` is parsed and never enforced | `compiled_config.py:259` |
| D-I: no terminal path passes `resultRef` | `apps/api/src/modules/workflows/workflow-run-completion.service.ts:151-164`; `workflow-exposure.service.ts:843-850`; `nodes/deliver.py:15-21` admits it |
| R-1: one reader connection per service, shared by every `XREAD BLOCK 15s` | `workflow-stream.service.ts:312-331`; `workflow-run-completion.service.ts:243-244` |

## 3. Implementation Plan

Lanes, file ownership, rules and caps are in TASK-1036 §5.3–§5.5. This ticket's lanes:

| Wave | Lane | Tier | Scope |
|---|---|---|---|
| A | A1 RUN-HARNESS | opus | R1 (harness side), R2, R3, R4 (producer); replay fixtures captured first |
| A | A2 RUN-GATEWAY | opus | R4 (consumer and result route), R5, the internal agent-by-version route |
| A | C0b CONTRACT-AGENT-PROTOCOL (shared with TASK-1036) | opus | The R6 envelope and event catalogue (`packages/async-contract/src/run-protocol.ts`) |
| B | B1 HARNESS-CONTRACT (shared) | opus | Protocol v2 debug events, R8 text streaming, R9 read activity |
| B | B2 GATEWAY-AGENT (shared) | opus | R7 agent runs + idempotency, TTS media |
| B | B3a GATEWAY-STREAMS | opus | R6 emission on SSE and WS, R7 on job starts, R10 |
| B | B3b GATEWAY-PUBLISH-READ (shared) | opus | R1 publish-side pin freezing, the R9 declared-read route |

### TDD (RED first)

| Lane | Tests |
|---|---|
| A1 | Pinned version vN runs after the agent is republished to vN+1. Run over `maxTotalSeconds` → TIMED_OUT. Cancel cancels a running activity. A 300 KB node output → claim-check ref, run completes. A 3 MB input → `PAYLOAD_TOO_LARGE`. A degraded note is kept. `test_replay_compat` covers the new patch ids and the old fixtures. |
| A2 | 200 concurrent stream readers do not serialise: first-frame p95 below a threshold measured from baseline. A watcher survives an XREAD error. SSE terminates when the completed event is lost. WS resyncs on a trimmed id. `GET …/result` returns inline or a signed URL. Status falls back to the read model on harness 404. The agent-by-version route is cross-tenant 404. |
| B-wave | Protocol v2 fixture parity (TS and Python). Idempotent replay returns the same `runId`. `POST internal/consultations/:id/read` refuses undeclared paths and other tenants (404). |

## 4. Verification

TASK-1036 §5.6 items 1, 3 and 4 apply here: the integrity proofs, the performance proof of 200 SSE streams before and after, and the history-size comparison. Replay-compat must be green before any merge of harness code.

## 5. Implementation Summary

Wave A in progress.

## 6. Change History

| Date | Change |
|---|---|
| 2026-10-04 | Ticket raised from the TASK-1036 programme (OD-28). The owner approved it. Plan and lanes as in TASK-1036 §5. |
