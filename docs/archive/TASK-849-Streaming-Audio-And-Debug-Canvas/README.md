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

### Lane 849b — binary audio / TTS (step 5). **Complete.**

Steps 6–8 (lane 849c) are untouched and still open.

#### What was built

`agentic.tts` is REAL. It dispatches synthesis, streams audio frames on lane A's delta lane, and
writes the artifact to the claim-check store. **Three existing mechanisms, no fourth** — which is
what §5's *"refuse a second bespoke audio path"* asks for, and what makes OD-4 affordable:

| Concern | Mechanism reused |
|---|---|
| Synthesis dispatch | ONE activity, `dispatch_speech_synthesis` — the exact counterpart of TASK-724's `dispatch_batch_transcription` that `agentic.stt` already calls |
| Streaming | `run_event_producer().emit_token_delta(...)` — lane A's single delta entry point, same envelope, same per-run Redis Stream, same resume-token contract |
| Artifact write | `claim_check.store_bytes` — the binary sibling of the `store_blob` call `output.deliver` already makes; same store, same content-addressed key, same ref shape |

**Audio never enters Temporal history.** The activity RESULT is a `ClaimCheckRef` (~200 bytes:
bucket, key, size, sha256, content type). The bytes live and die as a local variable inside one
activity body, because `dispatch_speech_synthesis` is awaited as a plain coroutine from inside
`interpreter.agentic_tts`, exactly as `agentic.stt` awaits its own dispatch.

**Why a gateway route was unavoidable.** `apps/tts` is the reference STATELESS,
gateway-injected-config service (rule 06): it opens no DB connection and holds no credential, so
every caller must arrive with the tenant's configuration already folded into the body. A Temporal
worker has no DB handle and no Vault client *by design*, so it can fold nothing — a harness→tts
direct call could only run on `apps/tts`'s own static settings. That is a platform default
silently beating a tenant's own configuration (the §3.4 rule 16 cascade bypass) *and* BYOK-vs-CLOUD
funding derived from the wrong row. So `POST /internal/harness/tts/synthesize` was added, mirroring
`stt/batch-jobs`: harness names the text and the voice, the gateway resolves routing chains,
allowed providers, BYO credentials, voice bindings, the character quota and the usage row.

`resolveTtsTenantConfig` is EXTRACTED from `SpeechProxyController.applyTenantConfig`, not copied:
two spellings of *"which provider serves this tenant's speech, on whose key"* drift invisibly,
because both would still synthesize. The per-caller MAPPING stays separate (the proxy honours a
caller-supplied format/speed; this route takes the node's config).

**Contract observation, declared not hidden.** `agentic.tts`'s config carries `providerConfigRef`
(it shares the agent node's binding shape) and this activity resolves nothing from it. TTS provider
selection lives on the tenant's `TenantTtsConfig` routing chains — the same tenant → SYSTEM
cascade, read on the gateway side where the DB handle is. The node still stores a reference and
resolves nothing itself; the reference it resolves *by* is simply the tenant, not a policy row.
### Lane 849c — debug canvas + a11y outline (steps 6–8). **Complete against what lane A shipped; the loop drill-down carries lane A's own recorded gap forward, honestly.**

Continuation of a prior attempt that stalled mid-file (banked two commits: the SSE client contract, and
a WIP drawer rewrite). This lane reconciled that contract against lane A's actual `run_events.py`
(written before lane A had merged) and finished steps 6–8.

#### Contract reconciliation

The inherited `api/types.ts` handled `workflow.node.started`, `workflow.run.progress`/`.completed`, and
documented (but did not TYPE) `.node.completed`/`.node.failed`/`.loop.iteration`/`.guardrail.verdict` as
sharing `WorkflowNodeEventPayload`. The one real gap was `workflow.token.delta` — the DELTA lane, entirely
absent from both the type contract and `api/live-events.ts`'s subscription list. Added
`WorkflowTokenDeltaPayload` (`{ nodeId, sequence, text }`, matching `emit_token_delta`'s payload exactly),
a `WorkflowRunEventType` union documenting all seven wire event types plus the gateway's own
`workflow.run.progress` snapshot frame, and a doc note on `workflow.run.completed`'s DUAL payload shape
(the gateway's snapshot builder vs. the harness's raw-forwarded control-lane mirror — two different
shapes under one type name, confirmed by reading both `workflow-run-event.ts` and
`workflow-stream.service.ts`).

#### What was built

* **Canvas problem borders (step 6).** `lib/node-problem.ts` (inherited, kept) maps a rollup or a live
  `workflow.node.*` payload onto the canvas's existing ERROR/WARNING border mechanism. Wired into
  `run-trace-screen.tsx`'s `nodeProblemById`: the durable rollup first, then the LIVE frame for that
  EXACT `nodeId` overrides it — a red border can appear the instant a `workflow.node.failed` frame
  arrives, before the next REST re-snapshot resolves, and a fresh retry clears a stale border. There is
  no "green" border: the canvas's border mechanism (`packages/ui`) only ships ERROR/WARNING severities
  (built for validation findings) — extending it was out of this lane's `apps/admin-console`-only
  boundary, so a successful/running node is conveyed by `NodeRunBadge`'s icon+text overlay instead. State
  never reads by colour alone either way.
* **Input/Output/Error tabs + live output preview.** `RunNodeDetailDrawer` (inherited rewrite, finished
  here) opens on Output by default; a `liveOutputPreview` prop now surfaces the `workflow.token.delta`
  accumulator (capped 4 000 chars, reset on a fresh `workflow.node.started` for that node) — the first
  real consumer of the delta lane, and what makes the debug surface feel live rather than a status
  poller.
* **Live activity feed.** `RunLiveActivity` (inherited) rendered in the status banner; prints
  node started/completed/failed frames in arrival order, never a fabricated tool-call argument (none is
  on the wire).
* **Loop drill-down (step 6, honest gap carried forward).** `LoopIterationDrilldown` (inherited) renders
  the full `◀ 3/12 ▶` affordance always, in a disabled state with the reason stated — `iterations` is
  `null` for every run today because nothing emits `workflow.loop.iteration` yet (lane A's own recorded
  gap, re-verified against `activities.py`/`run_events.py`, not rediscovered). Needs: the
  `interpreter.loop_state_checkpoint` hook lane A already named as the place to add it.
* **Replay/scrub (step 7).** New `RunReplayScrubber` — play/pause/step/jump controls plus a Radix
  `Slider`, reading ONLY the durable REST trace already on screen (no new endpoint, no live connection —
  "free" as the plan called it). A toolbar toggle on a terminal run slices `trace.nodes` to a revealed
  step count and feeds the SAME correlation → problem → overlay pipeline the live view uses, so
  scrubbing back genuinely HIDES not-yet-revealed nodes (canvas border and list badge both), not just
  dims them. Fixed-interval auto-play, honestly documented as an ordered walk-through rather than a
  timestamp-accurate reproduction.
* **Outline view (step 8).** The pre-existing `?view=list` / `RunTraceListView` peer IS the
  keyboard-navigable outline: real focusable `<button>`s in an ordered `<ol>`, each carrying the same
  `NodeRunBadge` (icon+text, never colour-alone). Confirmed it also respects replay scrubbing (same
  `effectiveRollups` slice as the canvas).

#### Files changed

| File | Change |
|---|---|
| `apps/harness/.../interpreter/nodes/agentic.py` | `interpreter_agentic_tts` promoted from DEGRADED to real; `_TTS_NOT_YET_EXECUTABLE` deleted; module docstring corrected |
| `apps/harness/.../temporal/activities.py` | **NEW** `dispatch_speech_synthesis` (+ `_AUDIO_DELTA_FRAME_BYTES` delta framing); registered in the worker's activity list |
| `apps/harness/.../temporal/models.py` | `SpeechSynthesisInput`, `SpeechSynthesisResult` (with an `audio` property) |
| `apps/harness/.../temporal/claim_check.py` | **NEW** `store_bytes`; `store_blob` now delegates to it, so there is one spelling |
| `apps/harness/.../services/api_client.py` | `synthesize_speech()` + `SpeechSynthesisResponse` |
| `apps/harness/.../interpreter/registry.py` | corrected the comment that still said `agentic.tts` does not run |
| `apps/api/src/modules/speech/harness-tts-internal.controller.ts` | **NEW** — `POST /internal/harness/tts/synthesize` |
| `apps/api/src/modules/speech/tts-tenant-config.ts` | **NEW** — the extracted `resolveTtsTenantConfig` |
| `apps/api/src/modules/speech/speech-proxy.controller.ts` | uses the extraction; orphaned `ProviderOverrides` import removed |
| `apps/api/src/modules/speech/speech.module.ts` | registers the new controller |
| `apps/api/route-manifest.json` | regenerated — 705 routes |
| Tests | `test_task849_agentic_tts.py`, `test_task849_audio_two_lane_split.py`, `harness-tts-internal.controller.test.ts`; `test_agentic_nodes_task847.py` narrowed |

#### Evidence

**§4 criterion — an audio round-trip through an `agentic.tts` node.** A real two-node graph
(`agentic.input` → `agentic.tts`, both SHIPPED node specs wired by a real edge) walked by the real
`WorkflowInterpreter` against an ephemeral Temporal server. The run SUCCEEDS, the artifact is
written, and the delta frames concatenate back to exactly what was synthesised:

```
✓ TestAudioNeverEntersTemporalHistory::test_the_run_still_succeeds_and_the_deltas_rebuild_the_artifact
✓ TestTheArtifactWrite::test_it_succeeds_and_publishes_a_claim_check_ref_for_the_audio
✓ TestTheArtifactWrite::test_the_node_asks_the_gateway_for_the_bound_text_and_voice
✓ TestTheDeltaLane::test_the_deltas_decode_back_to_exactly_the_stored_artifact
10 passed in 0.15s   # test_task849_agentic_tts.py
```

`agentic.stt` is untouched and still green (`TestSttNodeResolvesNothingItself`, in the 1942).

**The split, MEASURED for audio — decoded, not a substring search.** Same graph, 32 KiB of audio
and 32 MB of audio:

```
[TASK-849 lane B audio split, measured] audio_bytes=32768 -> temporal_history_events=55 | audio_bytes=32768000 -> temporal_history_events=55 | history_bytes=34704
[TASK-849 lane B audio split, measured bytes] audio_bytes=32768 -> history_bytes=34688 | audio_bytes=32768000 -> history_bytes=34704
3 passed in 1.86s
```

A **1000× larger artifact grew Temporal history by 16 bytes** — the ref's own sha256/size, which is
all that reaches it. Content assertions DECODE every payload body before searching, because
Temporal base64-encodes them and a raw-JSON search is vacuous (lane A found that the hard way); the
delta assertions also prove the frames genuinely landed, so the equality cannot pass by emitting
nothing.

**Replay.** The command sequence did **not** change. `interpreter/workflow.py` and
`interpreter/activities.py` are byte-identical to lane A's — the node activity simply does more
work internally, which replay never re-executes. No new patch gate was needed, and the existing
guards still pass unchanged:

```
23 passed, 3 warnings in 0.67s   # test_replay_compat.py — same 23 as lane A
```

**Green gates.**

```
$ pnpm harness:test        -> 1942 passed, 1 warning in 105.27s   (1939 → +3 audio split; 1930 at lane A)
$ pnpm harness:lint        -> All checks passed!
$ pnpm harness:typecheck   -> Success: no issues found in 144 source files
$ pnpm api:build           -> Tasks: 12 successful, 12 total
$ vitest run apps/api/src  -> Test Files 265 passed | Tests 4118 passed (4118)
$ pnpm --filter @arcaai/api lint -> 65 problems (0 errors, 65 warnings)  [lane A's exact baseline]
$ pnpm api:openapi:check   -> OK — every served route is documented or deliberately excluded
$ pnpm api:portal:check    -> no drift (admin 627 ops, business 185 ops)
$ pnpm --filter @arcaai/vox-node gen:admin:check -> no drift (52 areas, 408 routes, 372 schemas)
```

The last three are unchanged BY CONSTRUCTION: the new route is `@ApiExcludeController()`, exactly
like every other `internal/harness/*` route, so it appears in `route-manifest.json` (identical
shape to its `stt/batch-jobs` sibling) and in none of the published documents.

#### Negative probe — proof these tests are not test-shaped no-ops

The audio was folded back into the node's activity `output` as base64, then restored. Three
findings, one of which changed the test:

1. **The measurement caught it.** `test_a_thousandfold_larger_artifact_adds_no_proportional_history`
   failed: `Temporal history grew with audio size: 55 events for 1 frame(s) vs 54 for 1000`.
2. **The node-level guard caught it directly.**
   `test_the_activity_RESULT_carries_no_audio_bytes` failed on the base64 form.
3. **The history CONTENT check did NOT catch it, and now does.** With 32 MB folded in, the LARGE
   run exceeds Temporal's **2 MB per-payload ceiling** — the activity errors, the node degrades,
   and no output reaches history at all, so the large history comes back *cleaner* than the honest
   one. Only the small run, under the ceiling, still carried the smuggled bytes. The assertion now
   scans **both** histories and both encodings (raw and base64). Without that, a check reading the
   large history alone would have passed on a node actively routing audio through Temporal.

Worth recording alongside the numbers: under the probe the same three tests took **602 seconds**
instead of **1.9**. Pushing 32 MB of base64 through Temporal history is not merely over a limit —
it is three orders of magnitude slower, which is the practical shape of the failure §3.4 rule 17
exists to prevent.

#### The narrowed test — deliberate, not deleted

`test_neither_ever_claims_to_have_produced_anything` asserted that `agentic.loop` AND `agentic.tts`
never report SUCCEEDED. It is now `test_the_loop_never_claims_to_have_produced_anything`.

Deleting it wholesale was the trap: it would have failed for the RIGHT reason on `agentic.tts` and
the cheap fix — removing the whole test — would silently drop the guard on `agentic.loop`, whose
pin is still load-bearing. TASK-848 made the loop real via a CHILD WORKFLOW, so this activity is now
the **replay-only** path a pre-gate history walks through; it must never start claiming iterations
it did not run. `agentic.tts`'s own honesty moved to where its behaviour lives
(`TestItStillResolvesNothingItself`): a missing `voiceRef`, a missing tenant, no bound text and any
dispatch failure each still DEGRADE with no output.

#### Not done in this lane (declared, not hidden)

* **No live round-trip against a running `apps/tts` or a live Redis.** Both halves are hermetic —
  a real Temporal server, a real in-memory claim-check store, a real interpreter walk, with the
  Redis socket and the upstream synthesis faked. An end-to-end run needs `pnpm setup:dev` infra,
  which is the orchestrator's surface, not a lane's (the same boundary lane A declared).
* **`ogg` is in the node's config schema and not in this route's `format` enum**, because
  `apps/tts` does not serve it. Refused at the gateway rather than forwarded to a 4xx.
* **The delta frame size (32 KiB) is a wire constant, not a setting** — the same category as lane
  A's `RUN_EVENT_STREAM_MAX_LEN`. Nothing about a tenant, a provider or a deployment changes what
  a sensible audio frame is.
| `apps/admin-console/src/features/workflow-runs/api/types.ts` | `WorkflowTokenDeltaPayload`; `WorkflowRunEventType` union; `workflow.run.completed` dual-shape doc note |
| `apps/admin-console/src/features/workflow-runs/api/live-events.ts` | `WORKFLOW_TOKEN_DELTA` subscribed; `liveOutputByNodeId` accumulator (capped, reset-on-start); reset-on-`runId` rewritten as a render-time adjustment (lint) |
| `apps/admin-console/src/features/workflow-runs/components/run-node-detail-drawer.tsx` | `liveOutputPreview` prop rendered in the Output tab |
| `apps/admin-console/src/features/workflow-runs/components/run-replay-scrubber.tsx` | **NEW** — play/pause/step/jump + Slider replay control |
| `apps/admin-console/src/features/workflow-runs/components/run-trace-screen.tsx` | live-events wiring, `nodeProblemById`/`canvasNodes`, `RunLiveActivity` in the status banner, replay toolbar, drawer `liveOutputPreview` |
| `apps/admin-console/src/features/workflow-runs/components/__tests__/run-trace-screen.test.tsx` | fixed a pre-existing assertion the inherited drawer rewrite broke ("Payload" → "Output not available"); added a live-stream test (FakeEventSource + ticket stub), dark-theme axe passes (list + canvas), a replay-scrub test |

#### Evidence

```
$ pnpm --filter @arcaai/admin-console exec eslint src/features/workflow-runs --max-warnings=0
(clean — no output)

$ pnpm --filter @arcaai/admin-console exec vitest run src/features/workflow-runs --reporter=default
 ✓ |server| lib/__tests__/rollup-correlation.test.ts (5 tests)
 ✓ |server| lib/__tests__/graph-layout.test.ts (12 tests)
 ✓ |client| components/__tests__/failure-panel.test.tsx (5 tests)
 ✓ |client| components/__tests__/gate-approval-panel.test.tsx (10 tests)
 ✓ |client| components/__tests__/workflow-runs-screen.test.tsx (6 tests)
 ✓ |client| components/__tests__/run-trace-screen.test.tsx (10 tests)
 Test Files  6 passed (6)
      Tests  48 passed (48)

$ pnpm --filter @arcaai/admin-console typecheck
5 pre-existing errors, all in playground-consultation/playground-live-transcription (missing
@arcaai/vox / @arcaai/stt dist/ in this worktree) — zero in workflow-runs/workflow-studio.

$ cd apps/admin-console && npx playwright test --list tests/e2e/workflow-runs.spec.ts
Total: 12 tests in 2 files   # collects cleanly; not run — no infra authorised
```

`pnpm --filter @arcaai/admin-console build` is BLOCKED in this worktree by the same pre-existing gap
(`packages/agentic-sdk-v2` and `packages/stt` have no `dist/` at all here — never built, not stale), on
two files this lane never touches. Reported, not silently worked around; not a shared-tree bootstrap this
lane's boundary licenses fixing.

#### Not done in this lane (declared, not hidden)

* **The loop drill-down has no live data source** — see above; this is lane A's gap, re-confirmed, not
  fixed here (the fix belongs in `apps/harness`, outside this lane's boundary).
* **No "green" canvas border** — a deliberate scope decision to avoid a `packages/ui` change; state is
  conveyed without colour via `NodeRunBadge` instead. See "What was built" above.
* **No new Playwright e2e spec.** The existing `workflow-runs.spec.ts` (12 tests) already covers the
  trace screen's outline view and both-theme axe; the vitest suite above adds the live-stream/replay
  coverage a live backend would otherwise be needed for. Confirmed the existing spec still collects
  cleanly against these changes.
* **`pnpm --filter @arcaai/admin-console build` unverified** — blocked by the pre-existing missing
  `@arcaai/vox`/`@arcaai/stt` builds noted above.

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Ticket created, aligned to TASK-837 §4. |
| 2026-09-01 | Plan expanded against the shipped poll bridge, the TASK-717 Phase-C gap, and the TASK-847 handoff markers. Blocked on TASK-848. |
| 2026-09-02 | **Lane 849a complete (steps 1–4).** TASK-717 Phase C producer built; control events mirrored out of Temporal behind `_STREAM_PATCH`; delta lane straight to Redis Streams; gateway poll DELETED in favour of a blocking `XREAD` with `Last-Event-ID` resume and trimmed-gap re-snapshot. Split measured at 37 Temporal history events for both 10 and 10 000 deltas. Steps 5–8 remain open for lanes 849b/849c. |
| 2026-09-02 | **Lane 849b complete (step 5).** `agentic.tts` promoted from observable `DEGRADED` to REAL: `dispatch_speech_synthesis` (the TTS counterpart of TASK-724's batch dispatch) through a new `POST /internal/harness/tts/synthesize`, audio frames on lane A's delta lane, and the artifact written via `claim_check.store_bytes`. Three existing mechanisms, no fourth. Split measured at 55 Temporal history events for BOTH 32 KiB and 32 MB of audio (history grew 16 bytes at 1000× the payload), asserted on DECODED payload bodies. Command sequence unchanged — `workflow.py` untouched, `test_replay_compat.py` still 23 passed. `test_neither_ever_claims_to_have_produced_anything` NARROWED to `agentic.loop`, whose pin stays load-bearing as TASK-848's replay-only path. Steps 6–8 remain open for lane 849c. |
| 2026-09-02 | **Lane 849c complete (steps 6–8).** Contract reconciled against lane A's merged `run_events.py` (added the missing `workflow.token.delta` type). Canvas problem borders wired to both the durable rollup and live frames; live output preview from the token-delta lane; replay/scrub built reading only the durable trace; the pre-existing `?view=list` confirmed as the keyboard outline view. Loop drill-down's empty state carries lane A's recorded no-emitter gap forward rather than papering over it. `pnpm --filter @arcaai/admin-console build` left unverified in-worktree — blocked by pre-existing unbuilt `@arcaai/vox`/`@arcaai/stt` there. **Verified by the orchestrator post-merge: EXIT=0.** |
| 2026-09-02 | **Orchestrator post-merge fix.** The console's port-lattice drift guard fired on merge — correctly. Lane A's regeneration folded in the `audio` and `object` port primitives, and BOTH console mirrors predated `object`: `PORT_SUPERTYPE` recorded `entities`/`edits`/`verdict`/`context<schemaRef>` as lattice ROOTS when canonically all four are `⊑ object`, and the `WorkflowPortPrimitive` union omitted `audio` and `object` outright. Not cosmetic — the mirror backs the canvas's connection validation, so a stale copy silently refuses legal wires, and the guard's own message notes it also backs the `document -> ner` anti-laundering rule where drift the other way would PERMIT a wire that must not exist. Realigned verbatim (`ca0493b8a`, `657fbe5f6`). All three lanes merged; admin-console build/lint/test green at 2264. |
