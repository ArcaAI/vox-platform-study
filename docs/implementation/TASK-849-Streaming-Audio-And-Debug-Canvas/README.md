# TASK-849 — Two-Lane Streaming, Binary Audio & Realtime Debug Canvas

| Field | Value |
|---|---|
| **Status** | `Pending` — plan expanded 2026-09-01; **blocked on TASK-848** |
| **Type** | `feature` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track D |
| **Tier / Effort** | `opus` / **xhigh** (transport design); `sonnet` / high (debug canvas UI); `sonnet` / medium (a11y outline view) |
| **Depends on** | TASK-847 ✅; **TASK-848 (in progress)** |
| **Owns** | `apps/api/src/modules/workflows/`, harness activities, the studio debug surface |

## 1. Requirement Analysis

Realtime debug on the canvas, plus streaming for the node types that need it.

**OD-4 kept STT and TTS nodes in the day-1 slice**, against the research recommendation to defer them. That
decision moves binary audio transport into this ticket and makes it the largest in the program. TASK-847
shipped `agentic.stt` as REAL (batch dispatch) and left `agentic.tts` as observable `DEGRADED`, marked in
`interpreter/nodes/agentic.py` at `:23`, `:76` and `:301` — *"TASK-849 owns binary audio transport (OD-4)"*.

## 2. Current State Evaluation

**The poll bridge exists for a reason, and that reason is the actual work.** `WorkflowStreamService`
(`apps/api/src/modules/workflows/workflow-stream.service.ts`) polls at
`WORKFLOW_STREAM_POLL_INTERVAL_MS = 2_000` with a 15s SSE heartbeat. Its own docstring explains why: the
harness interpreter dispatcher exposes **no `text/event-stream` endpoint** — only `POST …:start`,
`GET …/{runId}` (plain JSON) and `POST …:cancel`. **TASK-717 shipped the envelope + resume-token package
(Phases A/B) but explicitly deferred "Phase C" — a reference producer wired into any service.**
*Building that producer is the core of this ticket.* Do not replace the poll bridge with another poll bridge.

**Realtime consultation streaming is ALREADY shipped and must be reused, not reinvented** (F-21): six
ticket-scoped SSE planes over Redis pub/sub, each `@TenantOwnedResource` with its own `@StreamScope`
namespace — `live-summary`, `live-assist`, `harness-progress`, `harness-assurance`, `trajectory`, `loop` —
plus durable `section.patch` read-back. `apps/stt` already streams over Redis Streams and `apps/text` over
SSE with a Redis message id per event for resume.

**F-13 as corrected:** there is no streaming producer for workflow RUNS. That is a different statement from
"no streaming anywhere", which is false.

## 3. Implementation Plan

1. **Build the TASK-717 Phase C producer** in the harness interpreter, emitting the already-specified
   envelope with resume tokens. This is what lets the gateway stop polling.
2. **Two-lane split — do NOT route token streams through Temporal.**
   - Token / STT / TTS deltas → **Redis Streams** (the proven pattern, with message-id resume).
   - Control events (`node.started/completed/failed`, `loop.iteration`, `guardrail.verdict`) → **Temporal**.
   Signals land in history; the ceiling is **51,200 events / 50 MB** per run. Temporal's Workflow Streams
   is Public Preview — **take no Public Preview dependency at day 1**; use a `@workflow.query` state
   snapshot plus a Redis mirror, and adopt Workflow Streams at GA behind the gateway.
3. **Transport to the browser is SSE**, reusing the existing single-use stream tickets and
   `TenantOwnedResourceSseGuard`. Traffic is unidirectional; cancel/approve are POSTs → Signals. A WebSocket
   buys nothing and duplicates the auth surface. **Never put a JWT in a URL.**
4. **Client contract: snapshot-then-delta with `Last-Event-ID`**, re-snapshotting on a trimmed-id gap.
5. **Binary audio (OD-4).** Promote `agentic.tts` from `DEGRADED` to real: synthesis dispatch plus the
   artifact write. **Reuse `apps/stt`'s existing streaming transport and the TASK-724 batch path rather than
   inventing a second audio mechanism** — that reuse is what makes OD-4 affordable. Update
   `test_neither_ever_claims_to_have_produced_anything` deliberately; do not delete it.
6. **Debug canvas affordances** (design lessons only — n8n is Sustainable-Use-licensed and Dify forbids
   multi-tenant use; **do not copy code from either**): green/red node outlines with per-node
   Input/Output/Error tabs; a per-iteration drill-down for the Loop node (`◀ 3/12 ▶`); per-node "inspect
   output"; agent tool-call printing.
7. **Replay/scrub of a COMPLETED run comes free** because control events are durable — a genuine
   differentiator over every prior-art tool. Build it.
8. **A canvas cannot pass WCAG 2.2 AA alone.** Budget the keyboard-navigable **outline view** as a
   first-class alternative (est. 3–5 days), not as a discovery at the axe gate.

## 4. Verification Criteria

- The gateway no longer polls: `WORKFLOW_STREAM_POLL_INTERVAL_MS` is gone or unused on the push path.
- Token stream survives a client disconnect/reconnect with `Last-Event-ID` and loses nothing.
- **A run with 10k token deltas adds NO proportional Temporal history — measured, not asserted.**
- Audio round-trip through an `agentic.stt` node and an `agentic.tts` node.
- axe 0 violations on the debug surface; a full keyboard pass via the outline view.
- `pnpm harness:test` / `lint` / `typecheck`; `pnpm --filter @arcaai/api test`;
  `pnpm --filter @arcaai/admin-console build lint test`.
- **F-31 applies:** rebuild any package you change before running a downstream gate.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Tokens leak into Temporal history | Enforce the split **with a test**, not a convention — assert history size against delta count |
| Binary audio doubles the transport surface | Step 5 reuse; refuse a second bespoke audio path |
| Replacing a poll bridge with another poll bridge | Step 1 is the producer; the poll interval must actually disappear |
| Canvas fails the a11y gate late | Step 8 budgeted up front, not discovered |
| Copying AGPL/Sustainable-Use prior-art code | Design lessons only — n8n and Dify are licence blockers (F-20) |

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Ticket created, aligned to TASK-837 §4. |
| 2026-09-01 | Plan expanded against the shipped poll bridge, the TASK-717 Phase-C gap, and the TASK-847 handoff markers. Blocked on TASK-848. |
