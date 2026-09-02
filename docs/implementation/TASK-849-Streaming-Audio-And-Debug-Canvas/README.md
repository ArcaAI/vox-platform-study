# TASK-849 — Two-Lane Streaming, Binary Audio & Realtime Debug Canvas

| Field | Value |
|---|---|
| **Status** | `In Progress` — UNBLOCKED 2026-09-01 (TASK-848 complete); split into three lanes |
| **Type** | `feature` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track D |
| **Tier / Effort** | `opus` / **xhigh** (transport design); `sonnet` / high (debug canvas UI); `sonnet` / medium (a11y outline view) |
| **Depends on** | TASK-847 ✅; TASK-848 ✅ |
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

## 3b. Execution split — three lanes, sequenced

Track D stalled four dispatch attempts when a whole ticket went to one agent. This ticket is bigger than
TASK-848 was, so it is split at its natural seams and sequenced by real dependency, not run all at once.

| Lane | Steps | Tier / Effort | Owns | Depends on |
|---|---|---|---|---|
| **849a — producer + two-lane transport** | 1–4 | `opus` / xhigh | `apps/harness/.../interpreter/` (emission), `apps/api/src/modules/workflows/` | — |
| **849b — binary audio / TTS** | 5 | `opus` / high | `apps/harness/.../nodes/agentic.py`, the audio path | 849a's Redis lane |
| **849c — debug canvas + a11y outline** | 6–8 | `sonnet` / high | `apps/admin-console/src/features/workflow-studio/` | 849a's event contract |

**849a runs alone first** — both other lanes consume what it defines. 849b and 849c can then run in
parallel: one is a harness node, the other is admin-console, and they share no file.

**Anti-stall constraints on every lane** (what made TASK-845 and the TASK-848 finish succeed): no
sub-agents; `pnpm install` to completion before any other work; **commit after each numbered step**; read
this ticket plus §1/§3 of the program document only, not its full ~1600 lines.

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

### Lane 849a — producer + two-lane transport (steps 1–4). **Complete.**

Steps 5–8 (lanes 849b and 849c) are untouched and still open.

#### What was built

**Step 1 — the TASK-717 Phase C producer.** `apps/harness/src/harness/temporal/interpreter/run_events.py`
writes conforming `AsyncEnvelope`s onto ONE `MAXLEN`-bounded Redis Stream per run,
`wf:run:<runId>:events`. Idempotency keys use the recipe table's `AsyncIdempotencyKey.workflow_node`
for node settlement (the SAME key for completed and failed — the corollary in `idempotency.py`'s own
header), a `:started` suffix for the distinct "this node began" intent, and `…:delta:<sequence>` for
token deltas (shaped after `textChunk`). Redis assigns the message id, which is the transport cursor a
resume token wraps — the producer never invents one.

**The stream is a MIRROR, never the record.** Every write is best-effort and returns `None` on failure,
the same posture `_TrajectoryBatch.flush()` already has. Temporal's history is the durable truth; a
Redis outage costs a client its live push and nothing else.

**Step 2 — the control lane.** `interpreter.emit_run_events` mirrors node/run outcomes out of the
workflow, batched at stage boundaries (every `execute_activity` is three history events, so per-node
emission would grow the control lane with node count for no gain). Two design points worth keeping:

* `_preflight_skip` was extracted from `_dispatch_node` so "will this node actually run?" has ONE
  spelling. Without it the emitter would announce a node as started that the walk then reports
  SKIPPED — and the two predicates would drift, exactly what the `_LOOP_NODE_TYPE` comment beside it
  warns about.
* `_STREAM_PATCH` is the third patch gate. Unlike `_GATE_PATCH`'s, its cheap operand cannot be proven
  False from a config — the emit fires on every stage boundary of every graph — so `workflow.patched`
  is the only thing between this change and a non-determinism error on every in-flight clinical run.

**Step 3 — the delta lane, and the split MEASURED.** `run_event_producer()` is the public entry point a
streaming node activity uses; `NodeActivityInput` gained `run_id` because the delta stream is keyed per
run and `trajectory` carries a workflow VERSION id, not a run id (lanes B and C both consume this).
Deltas never touch Temporal — not a signal, not an activity result.

**Step 4 — the gateway consumes the push.** `WorkflowStreamService` reads the run's stream with a
blocking `XREAD`, reusing `TextStreamConsumerService`'s mechanism rather than inventing one (F-21).
Client contract: snapshot → deltas with the resume token as each frame's SSE `id` → `Last-Event-ID`
resume → re-snapshot on a trimmed-id gap. `formatSseFrame` used to emit `envelope.id` as the `id` line;
that is a value which LOOKS like a cursor to a browser and resumes nothing, so it now emits the resume
token and omits the line entirely on the snapshot frame (async-contract §3.6).

#### Files changed

| File | Change |
|---|---|
| `apps/harness/src/harness/temporal/interpreter/run_events.py` | **NEW** — the Phase C producer |
| `apps/harness/src/harness/temporal/interpreter/activities.py` | `interpreter.emit_run_events`; public `run_event_producer()`; registered in `INTERPRETER_ACTIVITIES` |
| `apps/harness/src/harness/temporal/interpreter/workflow.py` | `_STREAM_PATCH`; `_preflight_skip` extracted; three gated emit helpers; `run_id` threaded into `NodeActivityInput` |
| `apps/harness/src/harness/temporal/interpreter/models.py` | `RunEventSpec`, `RunEventBatch`; `NodeActivityInput.run_id` |
| `apps/harness/src/harness/core/redis_client.py` | `build_run_event_redis` (second named job, own connection) |
| `apps/harness/pyproject.toml`, `uv.lock`, `tests/conftest.py` | `hope-async-contract` dependency + `pythonpath` + worktree guard |
| `apps/api/src/modules/workflows/workflow-stream.service.ts` | **poll deleted**; `XREAD` consumer, resume, trimmed-gap re-snapshot, `compareStreamIds` |
| `apps/api/src/modules/workflows/workflow-run-event.ts` | `runEventStreamKey`, `RUN_EVENT_TRANSPORT`, `WORKFLOW_RUN_COMPLETED`; `formatSseFrame` takes a resume token |
| `apps/api/src/modules/workflows/workflows.controller.ts` | `Last-Event-ID` header + `lastEventId` query, explicitly documented as optional |
| `apps/api/src/modules/workflows/workflows.module.ts` | `CommonServiceModule` for `IConfigService` |
| Tests | `test_task849_run_events.py`, `test_task849_control_mirror.py`, `test_task849_two_lane_split.py`, `test_replay_compat.py` (+2 guards), `fixtures/interpreter_stream_v1_history.json`, and the three `apps/api/src/modules/workflows/__tests__/` suites |
| Generated | `openapi.json`, `openapi.admin.json`, `openapi.business.json`, `vox-node/src/resources/admin/schemas.ts` |

#### Evidence

**§4 criterion 1 — the gateway no longer polls.** `WORKFLOW_STREAM_POLL_INTERVAL_MS` is deleted, and a
test asserts the module no longer exports it. Another asserts `getRunStatus` is called EXACTLY ONCE for
a whole live run.

```
✓ the poll is gone > reads the run status EXACTLY ONCE for a whole live run — the rest is pushed
✓ the poll is gone > exports no poll interval any more
✓ the poll is gone > reads the run stream under the SAME key the producer writes
```

**§4 criterion 2 — resume loses nothing.**

```
✓ resume > every pushed frame carries an opaque resume token as its SSE id
✓ resume > a disconnect and reconnect with Last-Event-ID loses NOTHING
✓ resume > a malformed or foreign-transport Last-Event-ID resyncs instead of failing the request
✓ resume > re-snapshots when the cursor has been TRIMMED out of the retained window
```

**§4 criterion 3 — 10k deltas add NO proportional Temporal history. Measured, not asserted.** The same
graph run twice against a real ephemeral Temporal server, histories compared via `fetch_history()`:

```
[TASK-849 two-lane split, measured] deltas=10 -> temporal_history_events=37 | deltas=10000 -> temporal_history_events=37 | history_bytes=23120
[TASK-849 two-lane split, measured bytes] deltas=10 -> history_bytes=23108 | deltas=10000 -> history_bytes=23120
3 passed in 1.34s
```

Identical event count and near-identical byte count at a 1000× difference in deltas. The test also
asserts all 10 000 envelopes genuinely landed on the stream, so it cannot pass by emitting nothing.

**Replay.** The command sequence DID change (three new `execute_activity` calls), so both directions are
guarded and a stream-era fixture was captured:

```
23 passed, 3 warnings in 0.78s   # test_replay_compat.py (21 before this lane)
```

**Green gates.**

```
$ ruff check apps/harness/src/                         -> All checks passed!
$ mypy --config-file apps/harness/pyproject.toml ...   -> Success: no issues found in 144 source files
$ pytest apps/harness/src/harness/tests/               -> 1930 passed, 1 warning in 58.04s
$ pnpm api:build                                       -> Tasks: 12 successful, 12 total
$ vitest run apps/api/src                              -> Test Files 264 passed | Tests 4106 passed (4106)
$ pnpm --filter @arcaai/api lint                       -> 65 problems (0 errors, 65 warnings)  [all pre-existing, none in changed files]
$ pnpm api:openapi:check                               -> OK — every served route is documented or deliberately excluded
$ pnpm api:portal:check                                -> no drift (admin 627 ops, business 185 ops)
$ pnpm --filter @arcaai/vox-node gen:admin:check       -> no drift (52 areas, 408 routes, 372 schemas)
```

#### Negative probes — proof the new tests are not test-shaped no-ops

Two assertions were verified to FAIL when the property they guard is broken, then restored:

1. Renaming `_STREAM_PATCH` makes the forward replay guard fail while the pre-stream guard stays green
   — so the gate is load-bearing, not ceremonial.
2. Folding 10 000 tokens into the streaming node's activity `output` makes the byte/decode assertion
   fail. **The first version of that assertion did NOT catch it**: Temporal base64-encodes payload
   bodies, so a substring search over `to_json()` passes whatever happens. It now decodes every payload
   before searching, and compares history bytes across the two delta counts.

#### What lanes B and C now depend on

* **Event contract** — `run_events.py`'s type constants and payload shapes; envelopes are conforming
  `AsyncEnvelope`s with `correlationId = runId`.
* **Delta lane entry point** — `run_event_producer().emit_token_delta(...)`, called from inside a node
  ACTIVITY. Lane B's audio path uses this and must not add a second transport.
* **`NodeActivityInput.run_id`** — already threaded; a streaming node needs it to name its stream.
* **Client contract** — snapshot-then-delta, `id` = opaque resume token, echo as `Last-Event-ID`,
  re-snapshot on a `workflow.run.progress` frame arriving mid-stream.

#### Not done in this lane (declared, not hidden)

* `workflow.loop.iteration` and `workflow.guardrail.verdict` are DEFINED in `run_events.py` and handled
  by the emit activity, but nothing emits them yet. The loop's per-iteration hook would go in
  `interpreter.loop_state_checkpoint` (which already runs once per iteration, so no command-sequence
  change) and needs `run_id`/`node_id`/`iteration` added to `LoopCheckpointInput`. Left out to keep this
  lane's replay blast radius to the interpreter's own walk.
* No integration test against a LIVE Redis or a live gateway. Both halves are covered by hermetic tests
  against a real in-memory stream and a real Temporal server; an end-to-end run needs `pnpm setup:dev`
  infra, which is the orchestrator's surface, not a lane's.

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Ticket created, aligned to TASK-837 §4. |
| 2026-09-01 | Plan expanded against the shipped poll bridge, the TASK-717 Phase-C gap, and the TASK-847 handoff markers. Blocked on TASK-848. |
| 2026-09-02 | **Lane 849a complete (steps 1–4).** TASK-717 Phase C producer built; control events mirrored out of Temporal behind `_STREAM_PATCH`; delta lane straight to Redis Streams; gateway poll DELETED in favour of a blocking `XREAD` with `Last-Event-ID` resume and trimmed-gap re-snapshot. Split measured at 37 Temporal history events for both 10 and 10 000 deltas. Steps 5–8 remain open for lanes 849b/849c. |
