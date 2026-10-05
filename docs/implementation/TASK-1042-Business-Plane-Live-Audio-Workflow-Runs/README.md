# TASK-1042 — Live audio into standalone workflow runs (business plane)

**Status:** Review — merged into dev-2.2; gate, e2e and the vox-node live proof are green. Awaiting owner sign-off. The SDK changes ship with the unreleased 5.0.0 (TASK-1039), which the owner publishes locally.
**Previously:** Approved, waiting to start. On 2026-10-05 the owner approved every recommendation in §4 ("approved, go after OD-35 merges"). Lanes start once the TASK-1038 OD-35 lane is merged into dev-2.2.
**Type:** feature (gateway + harness + SDK + docs)
**Branch:** dev-2.2 (worktree `agent/sleepy-goldstine-f2d11d`, fast-forwarded to `92b21aee8`)
**Raised:** 2026-10-05, from owner decision **OD-37** (TASK-1036 §6.13). It reverses that row's
earlier "not now" recommendation.
**Builds on:** TASK-1036 (the `graph.settings` connections, the Input shape `delivery: 'stream'`) ·
TASK-1038 (protocol v2, the STT→run transcript mirror, sandbox recording ownership E2 fix 12,
OD-35 principal-bound run reads) · TASK-1039 (SDK 5.0: `useRun`, `useRunAudio`, `RunHandle`) ·
TASK-933 (machine credentials on the STT plane) · TASK-1002 (workflow-governed ASR agent selection).
**Sequencing:** after the TASK-1038 **OD-35** lane merges. It edits the same files
(`workflows.controller.ts`, `workflow-exposure/**`, `workflow-run/**`, the scope registries).

> Ticket number: TASK-1041 was taken mid-session by the tenant-lock fix (`882d06579`). TASK-1042
> was the next free number on 2026-10-05 (all refs + all worktrees). Re-check before the first commit.

---

## 1. Requirement Analysis

An integrator streams microphone audio into a **standalone** workflow run (no consultation). The
workflow's Input shape declares an `audio` kind with `delivery: 'stream'`, and its settings
`connections` include `socket`. The run's ASR step turns that audio into text, and downstream
nodes use the text.

| # | Requirement |
|---|---|
| R1 | `POST /workflows/:slug/runs` honours `input.<audioKind>.sttSessionId` and binds that live STT session to the run. |
| R2 | Ownership mirrors the sandbox rules: the same tenant, the same starting principal, and a live session that is not bound elsewhere. A cross-tenant or foreign session is 404 (404-over-403). |
| R3 | It is settings-gated: live audio needs `socket` in `graph.settings.connections`. |
| R4 | The harness reads the bound session's transcript for the graph's ASR node. |
| R5 | SDKs: `useRunAudio` in `@arcaai/vox` works without a consultation, and a new `runWithAudio` helper ships in `@arcaai/vox-node`. |
| R6 | A cross-tenant e2e spec, the route-authz matrix, and docs (Integration panel snippets, protocol note, SDK READMEs, rule 08). |

## 2. Current State Evaluation (code-verified 2026-10-05, HEAD `92b21aee8`)

### 2.1 What exists

| Building block | Where | Status |
|---|---|---|
| Declared payload shape: `STREAM_AUDIO` (`delivery` `stream`, the default on input) maps to the open object `{ sttSessionId: string }` | `packages/applications/src/services/consultation-context-schema/context-schema-definition.ts:922-955` | Merged (F1) |
| Settings rule `WF-SET-003`: a `stream` Input kind, or an STT/TTS agent node, needs `socket` (the STT-node arm is waived when `sources` includes `consultation`) | `packages/py-workflow-contract/.../workflow_settings.py:229-262`, TS `packages/workflow-contract/src/workflow-settings.ts:241` | Merged; publish-time only |
| Sandbox recording: `recording.sttSessionId` with ownership (tenant + `createdBy === requestUserId`, 404), liveness (409 `SANDBOX_RECORDING_NOT_LIVE`), and not bound elsewhere (409 `SANDBOX_RECORDING_BOUND_ELSEWHERE`) | `packages/applications/src/services/workflow-sandbox-run/workflow-sandbox-run.service.ts:227-256` | Admin plane only (`@ForbidApiKey`) |
| STT→run transcript mirror: appends `transcript.partial` / `transcript.final` (admin audience, no `nodeId`) through the one sequencer | `apps/api/src/modules/streaming/stt-run-transcript-mirror.ts:153-196` | Resolves runs **only through a consultation** (`if (!consultationId) return []`) |
| STT session create: all three credential classes, owner = `cls.user.id` (for an API key, the bound human) or the service account id | `apps/api/src/modules/streaming/transcription-job.controller.ts:352-358, 902` | Body takes `consultationId`; there is no run or workflow field |
| STT results: `stt:result:<sessionId>` Redis stream, approximate `MAXLEN` per `XADD`, `EXPIRE` after close | `apps/stt/src/stt/streaming/redis_streams.py:461-487` | Bounded, not durable |
| `useRunAudio` (vox): mic + session first, then `useRun.start(…, { consultationId })` | `packages/agentic-sdk-v2/src/hooks/useRunAudio.ts` | Merged (S2). Its JSDoc says no business route binds a bare session, so it works only with an open consultation |
| vox-node `hope.workflows.run` → `RunHandle`; `hope.stt.createStreamSession` / `socket()` / `closeStreamSession` | `packages/vox-node/src/resources/{workflows,stt}.ts` | Merged. `runWithAudio` does **not** exist |

### 2.2 Gaps

| # | Gap | Evidence |
|---|---|---|
| G1 | The business route forwards `input` verbatim. `sttSessionId` passes the trigger schema as a plain string; nothing checks ownership or liveness, and nothing binds the session. **Today any caller can name any string, and nothing happens.** | `workflow-exposure.service.ts` (`payload: dto.input`); reserved keys `exposure-palette-policy.ts:15` do not include it |
| G2 | A standalone run has no `subject`. The harness requires `consultationId` on it, so the run cannot ride the consultation path. | `workflow-exposure.service.ts:884-896`; harness `interpreter/models.py:174` (`extra="forbid"`) |
| G3 | **The graph never reads a session.** The STT `core.agent` node batch-transcribes a blob URI from its `audio` port. With `{sttSessionId}` it degrades `no_audio`. Even the sandbox only reaches the graph through declared `consultation.transcript` reads on the hidden sandbox consultation. | `apps/harness/.../nodes/core.py:2016-2046`; no non-test `sttSessionId` in `apps/harness/src` |
| G4 | The interpreter has no "wait for audio to end" semantics. Its only signal is `cancel`. Sandbox runs start live, and their run-start reads see a partial transcript. | `workflow.py:2212-2218`, `:1129-1145` |
| G5 | The sandbox ownership rule `createdBy === requestUserId` is unusable for a service account, which has no `requestUserId`. For an API key it compares the bound **human**, so two keys of one human would pass. OD-35 binds runs to the **credential**. | `workflow-sandbox-run.service.ts:236`; `transcription-job.controller.ts:352-358` |
| G6 | Speech captured between session open and run start is never mirrored. The mirror resolves the binding at frame time, and the session opens first. | Mirror resolution (5 s cache) + Test-tab order `use-sandbox-recording.ts:5-10` |
| G7 | Docs are wrong today. The Integration panel's stream-audio snippets open a session no run reads, and the vox snippet misstates `useRunAudio`'s API. TASK-1036 §8.7 promises a "run-bound WS with `runId`" that nothing implements. | `apps/admin-console/src/shared/docs/run-guide.ts:427-506` |
| G8 | No e2e spec covers sandbox recording or any session→run binding (unit tests only). | `apps/api/tests/e2e` grep |

## 3. Target Design (the recommendations in §4, as one picture)

```
integrator                      gateway (apps/api)                         harness
──────────                      ──────────────────                         ───────
1 POST stream/session  ───────► create job; stamp owner credential
  { workflowSlug }               resolve ASR agent from the graph (OD-5)
2 open /ws/stt/stream  ───────► audio → apps/stt → stt:result:<sid>
3 POST workflows/:slug/runs ──► gate socket (OD-10); ownership + live +
  input.audio.sttSessionId       unbound (OD-2/6); bind job↔run (OCC);
                                 start run                          ──────► STT core.agent node, audio port
                                 mirror: + run-bound sessions (admin)          = {sttSessionId}
4 send PCM … finalize/close ──► job completed                               polls internal transcript route
                                                                              (heartbeat) until ended (OD-4)
                                 GET internal/stt/sessions/:sid/transcript ◄── returns finals from offset 0
                                 ?runId= (job bound to that run, else 404)     → {transcript, segments, language}
5 run.events()/result() ◄──────  protocol v2 run stream                     downstream nodes run
```

### 3.1 Gateway

- **Binding service** (new, `workflow-exposure/run-audio-binding.service.ts`), called from `invoke` before the harness start:
  1. Find the input keys whose frozen trigger schema is `STREAM_AUDIO` with stream delivery (reuse `isStreamAudioSchema` from `sandbox-input-shape.ts`). If `input` carries `sttSessionId` on any other key, or on more than one key, the answer is 400 `RUN_AUDIO_INPUT_UNDECLARED` / `RUN_AUDIO_MULTIPLE` (OD-6).
  2. Settings gate: `socket` must be in the effective connections, else 400 `LIVE_AUDIO_UNSUPPORTED` (OD-10). A legacy definition without settings is refused the same way.
  3. Ownership: the job is in this tenant, `STREAMING`, and its stamped owner credential equals the starter's (OD-2), else 404. The job is live (`QUEUED`/`PROCESSING`, no `completedAt`), else 409 `RUN_AUDIO_SESSION_NOT_LIVE`. It is unbound (no `consultationId`, no `metaData.boundRun`), else 409 `RUN_AUDIO_SESSION_BOUND_ELSEWHERE`. One exception: it is already bound to **this** deterministic `runId`, which is an idempotent retry and is accepted.
  4. Agent agreement (OD-5): the session's resolved ASR agent must be the graph's STT node agent, else 409 `RUN_AUDIO_AGENT_MISMATCH`.
  5. Bind with OCC (`updateWithVersion`): `job.metaData.boundRun = { runId, workflowSlug, versionNumber, boundAt }`. The run row gets `metaData.sttSessionId`. If the harness start fails, the job is unbound again. Two concurrent starts on one session: the loser gets 409.
- **Session create** (`POST audio/transcription-jobs/stream/session`):
  - It accepts an optional `workflowSlug`, mutually exclusive with `consultationId`. The ASR agent then resolves from that published graph's single STT node (`agentSource: 'workflow'`, TASK-1002 precedence; more than one STT node is 409 `WORKFLOW_ASR_AGENT_UNAVAILABLE`, as today).
  - It stamps `metaData.ownerCredential = { class: 'user'|'apiKey'|'serviceAccount', id }`.
- **Mirror:** `resolveRuns` also follows `job.metaData.boundRun.runId` (RUNNING, within `runStreamMaxOpenHours`). The admin trace then shows transcripts for these runs too. Mirrored events stay admin-audience (OD-8).
- **Internal route** `GET internal/stt/sessions/:sessionId/transcript?runId=`:
  - Auth: `X-Service-Token`, `X-Tenant-Id` mandatory.
  - It answers 404 unless the job is in that tenant and `boundRun.runId === runId`.
  - It returns `{ state: 'live'|'ended', finals: [...], language }`, with finals read from `stt:result:<sid>` from offset 0. Pre-bind speech is therefore included (G6, OD-9).
  - If the stream was trimmed or expired before the end, it returns `state: 'truncated'` and never a silently short transcript.
- **Consultation-bound route** (`consultations/:id/workflows`): `sttSessionId` in `input` stays refused (400). Consultation runs already get audio through the consultation.

### 3.2 Harness

- In `core.py` `_run_transcription`: when the `audio` port carries `{sttSessionId}` instead of a blob reference, a new branch `_run_session_transcript` takes over.
  - It polls the internal route through the existing gateway client (cadence 2 s), heartbeating on each poll, until `ended`. It then returns `{transcript, segments, language}`, which is the same output contract as the batch path (`data_contract.py:94`).
  - `truncated` → node `FAILED` with `transcript_truncated`. Reaching `workflowRuns.liveAudioMaxSeconds` → `FAILED` with `live_audio_timeout`. Cancel → the existing cancel-in-flight path.
- **Replay:** the change lives inside an existing node activity, so it needs no `workflow.patched` marker and no vocabulary change. The only workflow-side change is the per-node activity options for this node (timeout = `liveAudioMaxSeconds`, plus a `heartbeat_timeout`). The lane must prove with `test_replay_compat` that the options do not affect determinism; if they do, they go behind a marker.

### 3.3 Contract and settings

- New publish rule **`WF-SET-005`** (TS + Python + fixture): a `stream`-delivery Input kind must be bound to the `audio` port of a `SPEECH_TO_TEXT` `core.agent` node. Otherwise the audio would be captured and read by nothing. Severity per OD-7.
- New `global-kv` descriptor `workflowRuns.liveAudioMaxSeconds` (default 3600, `open-to-default`). It is the ceiling for the ASR node's wait.

### 3.4 SDKs (ride 5.0.0, TASK-1039; released locally by the owner per the runbook)

- **`@arcaai/vox` `useRunAudio({ workflow, audioField? })`:**
  - With no consultation open, it opens the session with `workflowSlug`, then calls `run.start({ ...input, [audioField]: { sttSessionId } })`.
  - `audioField` defaults to the single stream-audio key of the published Input shape; with zero or several keys it throws a typed error before any request.
  - With a consultation open, it keeps today's consultation-bound behaviour.
  - `stop()` finalizes and closes the session and never cancels the run. JSDoc rewritten.
  - `StreamingSessionManager` / `useArcaAudio` gain a `workflowSlug` pass-through.
- **`@arcaai/vox-node` `hope.workflows.runWithAudio(slug, input, { audioField?, language?, sampleRate?, idempotencyKey? })`** returns `{ run: RunHandle, audio: { sendPcm16, finalize(), close() } }`.
  - Order: `stt.createStreamSession({ workflowSlug })` → `socket.connect()` → `workflows.run(...)`. On a start refusal, the socket and the session are closed.
  - `finalize()` closes the session, and the run continues to its result.
  - `CreateStreamSessionRequest` gains `workflowSlug`. Zero runtime dependencies stay; Node ≥ 22 (`globalThis.WebSocket`).
- **Console docs** (`run-guide.ts`): rewrite the three stream-audio snippets (vox, vox-node, raw HTTP+WS) to bind the session to the run; fix the `useRunAudio` signature; update the test.

### 3.5 Frozen contract (2026-10-05; changing it means changing every lane that codes against it)

**C1. STT session create** (`POST /api/v1/audio/transcription-jobs/stream/session`).
- Gains an optional `workflowSlug: string`, mutually exclusive with `consultationId`. Both present → 400 `STREAM_SESSION_TARGET_CONFLICT`.
- With `workflowSlug` and no explicit `agentSlug`, the ASR agent resolves from the slug's active published version: its single `SPEECH_TO_TEXT` `core.agent` node. The response then echoes `agentSource: 'workflow'`.
- An unknown or invisible slug → 404. More than one STT node → 409 `WORKFLOW_ASR_AGENT_UNAVAILABLE` (existing code). No STT node → the normal department/tenant resolution.
- The SDK request types gain `workflowSlug?: string`. Nothing else on the request or response changes.

**C2. Run start input** (`POST /api/v1/workflows/:slug/runs`, unchanged route, body and scopes):
- `input[<audioField>] = { sttSessionId: string }`, where `<audioField>` is the one Input key whose schema in `GET workflows/:slug/schema` is the stream-audio payload schema (an object whose only declared property is `sttSessionId`, a string).

**C3. Errors on run start** (body `{ code, message }`, same shape as other coded errors):

| Status | `code` | When |
|---|---|---|
| 400 | `RUN_AUDIO_INPUT_UNDECLARED` | `sttSessionId` on a key that is not a stream-audio Input kind |
| 400 | `RUN_AUDIO_MULTIPLE` | `sttSessionId` on more than one key |
| 400 | `LIVE_AUDIO_UNSUPPORTED` | settings lack `socket`, or a legacy definition without settings |
| 404 | (house 404) | session unknown, other tenant, or started by another principal |
| 409 | `RUN_AUDIO_SESSION_NOT_LIVE` | session ended |
| 409 | `RUN_AUDIO_SESSION_BOUND_ELSEWHERE` | bound to a consultation or to another run |
| 409 | `RUN_AUDIO_AGENT_MISMATCH` | the session's ASR agent ≠ the graph's STT node agent |

**C4. Ending the audio.** The client ends the audio with the socket's `finalize`, then `DELETE`/close of the session (the existing `closeStreamSession`). That completes the job row. The run continues to its result. A client disconnect never cancels the run.

**C5. Internal transcript route** (gateway ↔ harness; owned by L1, consumed by L2):
- `GET /api/v1/internal/stt/sessions/:sessionId/transcript?runId=<runId>`
- Headers: `X-Service-Token`, `X-Tenant-Id` (both mandatory).
- 404 unless the session's job is in that tenant and bound to `runId`.
- 200 body:
  ```json
  { "state": "live" | "ended" | "truncated" | "timeout",
    "language": "en" | null,
    "transcript": "finals joined with single spaces",
    "finals": [ { "text": "…", "utteranceIndex": 0, "start": 0.0, "end": 1.2, "speaker": null, "language": null } ] }
  ```
- `start`, `end`, `speaker`, `language` and `utteranceIndex` on a final are optional.
- `timeout` means the session has been bound longer than `workflowRuns.liveAudioMaxSeconds` without ending.
- `truncated` means the retained result stream no longer starts at the first final.

**C6. ASR node output** (unchanged contract, `data_contract.py:94`): `{ transcript, segments, language }`, where `segments` = `finals` mapped to `{ text, start, end, speaker }`.

**C7. Harness run start** (`POST /workflow-runs:start`, gateway → harness; L1 sends it, L2 accepts it).
- New optional field `liveAudio: { sttSessionId: string, maxWaitSeconds?: integer > 0 }`.
- It is a server-resolved channel, like `subject`: the gateway sets it only after the C3 checks pass, and a caller's `payload` can never create it.
- `maxWaitSeconds` is the gateway-resolved `workflowRuns.liveAudioMaxSeconds`. The harness clamps it tighten-only to the module constant `LIVE_AUDIO_MAX_WAIT_SECONDS = 3600` (`caps.py`). If it is absent, the constant applies.
- On `InterpreterInput` it becomes `live_audio: LiveAudioBinding | None = None`; the default keeps old histories deserialising.

**C8. Session ownership** (OD-2, against the merged OD-35 helper `packages/applications/src/services/workflow-run/run-principal-access.ts`).
- At session create, `TranscriptionJob.metaData.owner = RunPrincipalAccessService.currentPrincipal()`. That is `{ type: 'user'|'apiKey'|'serviceAccount', id }`, and for a machine caller `id` is the CREDENTIAL id.
- At bind, the check is `sameRunPrincipal(readOwner(job.metaData), currentPrincipal())`. Otherwise the house 404, the same body as an unknown session.
- A session without `owner` (created before this change) is never bindable.
- `job.metaData.boundRun = { runId, workflowSlug, versionNumber, boundAt }`; the run row also carries `metaData.sttSessionId` beside OD-35's `startedBy`.
- The idempotent-retry check compares `boundRun.runId` with the deterministic run id, which is already principal-scoped by `principalScopedIdempotencyKey`.

## 4. Decisions (FINAL: owner approved 2026-10-05)

The owner answered "approved, go after OD-35 merges". Every recommendation below is therefore final, as written.

| Id | Question | Options | Recommendation |
|---|---|---|---|
| **OD-1** | How does a standalone run get the live audio? | **A** hidden run-owned consultation (reuse the sandbox path) · **B** bind the session to the run and let the ASR node read the session · **C** run first, then a run-bound STT socket keyed by `runId` (the §8.7 sketch) | **B.** A writes a fake clinical row, needs a clinician for service accounts, and triggers the live-handoff/realtime-skip logic (`workflow.py:396-414`, `:1129-1145`), which is a trap for a non-sandbox run. C needs a new socket route and ticket scope and duplicates the STT socket. B reuses the session, the socket and the mirror, and matches the Test-tab order. |
| **OD-2** | Who may bind a session? | Same tenant only · same human · **same credential** | **Same credential:** the same JWT user, the same API key id, or the same service account id, stamped on the session at create. This matches OD-35 (runs bound to the starting principal). It also fixes G5: a service account can bind, and a second key of the same human cannot. Failure is 404. |
| **OD-3** | What does the graph read? | The mirrored run events · **the session's finals through an internal route** · a new consultation-style read | **Internal route, finals from offset 0**, consumed by the STT `core.agent` node. Its output contract is unchanged, so downstream bindings work as they do for batch audio. |
| **OD-4** | When does the ASR node finish? | When the session ends (client `finalize`/close), with a ceiling · at run start (partial) | **When the session ends**, inside a heartbeated activity, with ceiling `workflowRuns.liveAudioMaxSeconds` (default 3600). The wait counts against the run's own budget, and the run budget is not paused: pausing would add a workflow-level change behind a new marker. |
| **OD-4a** (amends OD-4, owner 2026-10-05) | OD-4 is impossible as written: `caps.py` caps a node activity at 900 s and the run's compute budget at 3600 s. | Durable wait · inside the ASR step (≈15 min max) | **Durable wait (chosen).** It works like the consultation live-handoff wait. When `live_audio` is set, before the stage walk the workflow polls the short activity `interpreter.load_live_audio_state` (C5, state only) every 5 s until `ended`/`truncated`/`timeout`, or the clamped ceiling. The wait is not charged to `maxTotalSeconds`, and `execution_timeout_seconds` adds the ceiling to the backstop. It is guarded by `inp.live_audio and workflow.patched("task-1042-live-audio-wait")` (cheap operand first). The ASR node then reads the transcript once (C5). |
| **OD-5** | Which ASR agent transcribes: the session's or the graph's node? | The session's, ignore the node · **the graph's node, enforced** | **The graph's node.** Session create takes `workflowSlug` and resolves the node's agent (TASK-1002: "workflow wins"). Binding a session served by a different agent is 409 `RUN_AUDIO_AGENT_MISMATCH`. |
| **OD-6** | Cardinality? | **One stream-audio key per run, one run per session, exclusive** · several | **One and one, exclusive.** An idempotent retry of the same start is accepted. A second run on the same session is 409. |
| **OD-7** | A `stream` Input kind not wired to an STT node: publish error or warning? | **ERROR (`WF-SET-005`)** · warning | **ERROR.** Otherwise integrators stream audio that nothing reads, which is G7 again. |
| **OD-8** | Should the business-plane run stream show transcripts? | Keep `transcript.*` admin-only · make them public | **Admin-only (protocol v2 unchanged).** The integrator already receives transcripts on its own STT socket, and the run stream stays PHI-lean. |
| **OD-9** | Speech before the run binds (session opens first) | **Included** · dropped | **Included:** the route reads finals from offset 0. If the result stream was trimmed (MAXLEN/EXPIRE), the node fails with `transcript_truncated` rather than return a short transcript. The lane verifies the `streaming_result_stream_maxlen` default against a `liveAudioMaxSeconds` session. |
| **OD-10** | Gate error when settings lack `socket` (or a legacy definition has no settings) | 404 (hide) · **400 `LIVE_AUDIO_UNSUPPORTED`** | **400**, the same family as the existing `MODE_UNSUPPORTED`. The workflow is visible to the caller; only this mode is off. |
| **OD-11** | Release vehicle for the SDK changes | **Ride 5.0.0 (TASK-1039, unreleased)** · a separate 5.1.0 | **Ride 5.0.0.** The changes are additive, and 5.0.0 is not yet published. The owner publishes locally per the runbook. |
| **OD-12** | Sequencing with OD-35 | **After OD-35 merges** · in parallel | **After.** Same files, and this route depends on the principal-binding helpers OD-35 introduces. |

## 5. Implementation Plan (after the go)

### 5.1 Lanes (one worktree each, branched from dev-2.2 **after** OD-35 merges)

| Lane | Tier | Owns (exclusive) | TDD list (own files only; no gate suites, per the owner rule) |
|---|---|---|---|
| L1 GATEWAY | opus | NEW `packages/applications/src/services/workflow-exposure/run-audio-binding.service.ts` (+`__tests__`); `workflow-exposure.service.ts` (the call site only); `apps/api/src/modules/streaming/{transcription-job.controller.ts,dto/transcription-job.dto.ts,stt-run-transcript-mirror.ts}`; the ASR agent resolver (`workflowSlug` arm); NEW `apps/api/src/modules/internal/stt-session-transcript-internal.controller.ts`; settings descriptor `workflowRuns.liveAudioMaxSeconds` | 404 cross-tenant / foreign credential / unknown; 409 not-live, bound-elsewhere, agent-mismatch, concurrent bind; 400 undeclared, multiple, socket off, legacy definition; idempotent retry accepted with a single bind; unbind on start failure; session create stamps credential + resolves by `workflowSlug`; mirror follows `boundRun`; internal route 404 on runId mismatch, `truncated` on a trimmed stream |
| L2 HARNESS + CONTRACT | opus | `apps/harness/.../interpreter/nodes/core.py` (`_run_session_transcript`), the harness gateway client method, the per-node activity options; `packages/{workflow-contract,py-workflow-contract}` `WF-SET-005` + `tests/contracts/workflow-settings.fixture.json` | Session branch: polls until ended, heartbeats, output contract; `transcript_truncated`; `live_audio_timeout`; cancel; the blob path unchanged; `WF-SET-005` TS/Python parity on the fixture; `test_replay_compat` for the options change (the one replay test this lane runs, because the change touches the workflow) |
| L3 SDK + DOCS | sonnet | `packages/agentic-sdk-v2/src/{hooks/useRunAudio.ts,core/StreamingSessionManager.ts,hooks/useArcaAudio.ts,types/*}`; `packages/vox-node/src/{resources/workflows.ts,resources/stt.ts,types/stt.ts}` + NEW `core/run-with-audio.ts`; `apps/admin-console/src/shared/docs/run-guide.ts` (+ test); the SDK READMEs and the vox-node guide | `useRunAudio` standalone order + `audioField` discovery + typed errors + stop never cancels; `runWithAudio` order, close-on-refusal, finalize; snippet test pins the binding |

The orchestrator (this session) owns:
- the e2e spec `apps/api/tests/e2e/workflow-run-live-audio-cross-tenant.spec.ts`: tenant B's session 404, a colleague's API key / service account 404, an ended session 409, a consultation-bound session 409, socket off 400, an idempotent retry, and the internal route runId mismatch 404;
- regenerating all five artifacts (`api:build`, `api:route-manifest`, `api:openapi`, `api:portal`, `vox-node gen:admin`);
- the docs: this README, protocol-v2 §4 (transcripts of a run-bound session carry no `nodeId`), rule `08-vox-sdk.md`. TASK-1036 §6.13 (OD-37 → "superseded by TASK-1042") and §8.7 "Audio in" are edited by the TASK-1036 session, not here (agreed 2026-10-05);
- the merge, and the single gate pass afterwards.

### 5.2 Order

1. Wait for the OD-35 merge, then fast-forward.
2. Freeze the error codes and the internal-route response shape in this README §3.1.
3. Run L1 ∥ L2 ∥ L3 in parallel. L3 codes against the frozen contract.
4. Merge into dev-2.2, then the single gate pass (TS lint, typecheck, unit; harness + contract pytest including replay-compat; `@arcaai/vox`, `@arcaai/vox-node`, `@arcaai/admin-console`; the five artifact checks).
5. e2e against the test API (`RESET_DB=false`, test infra by arrangement with the e2e-repair session).
6. Live proof on the dev stack, by arrangement with the TASK-1036 session that holds it: vox-node `runWithAudio` with a WAV fixture → result text; browser `useRunAudio` via the console.

### 5.3 Verification criteria

- Every §3.1 status code is pinned by a unit test, and the cross-tenant ones also by e2e.
- A standalone run bound to a 60 s live session returns a transcript that includes speech captured before the run started.
- Replay-compat is green, and old histories replay unchanged.
- The route-authz matrix is green; no new route reachable by an API key on the admin plane.
- The Integration panel snippets match the shipped SDK signatures (test-pinned).

## 6. Implementation Summary

### 6.1 Lanes

| Lane | Tier | Branch head | Merged as |
|---|---|---|---|
| L3 SDK + docs | sonnet | `task-1042/sdk` `0e7086c8a` | `12d2ee1ac` |
| L2 harness + contract | opus | `task-1042/harness` `c4fdea7c0` | `9ef53ae35` |
| L1 gateway | opus | `task-1042/gateway` `20d3e4377` | `4f0f79132` |

Orchestrator commits:
- the contract C1–C8 (§3.5) and OD-4a;
- the docs: protocol-v2 §4, rule 08, the vox-node STT resolution order;
- the replay-fixture registration (`bfb5f08d6`);
- the e2e spec `apps/api/tests/e2e/workflow-run-live-audio-cross-tenant.spec.ts` (`93c90babd`).

### 6.2 What shipped

**Gateway (`packages/applications`, `apps/api`):**
- `run-audio-binding.service.ts` runs the C3 checks in order, binds with OCC, releases the binding if the start fails, and refuses `sttSessionId` on the consultation route.
- `run-audio-transcript.service.ts` and `internal/stt-session-transcript-internal.controller.ts` serve C5. The route is `@Public` + `HarnessServiceTokenGuard`, needs `X-Tenant-Id`, and reads the result stream once (`EXISTS`, `XINFO`, `XRANGE` in one EVAL).
  - `truncated` = `entries-added > length` (fail-closed when Redis does not report it).
  - `ended` = the job row is no longer live, or a `closed`/`cancelled` status frame.
  - `timeout` = still live past `boundAt + liveAudioMaxSeconds`.
- STT job rows carry `metaData.owner`, the OD-35 principal. `TranscriptionJobEntity` and its factory now expose `metaData` (L1 deviation: it was never wired).
- Session create takes `workflowSlug`. The ASR resolver gains a workflow arm (`agentSource: 'workflow'`).
- The transcript mirror follows `metaData.boundRun`.
- New descriptor `workflowRuns.liveAudioMaxSeconds` (default 3600, range 60–3600, tenant-tightenable).
- The harness start carries `liveAudio`.

**Harness and contract:**
- `StartWorkflowRunRequest.liveAudio` → `InterpreterInput.live_audio`, with `caps.LIVE_AUDIO_MAX_WAIT_SECONDS = 3600` (tighten-only) and the execution-timeout backstop term.
- The durable wait `_await_live_audio` sits behind `inp.live_audio is not None and workflow.patched("task-1042-live-audio-wait")`. It polls the activity `interpreter.load_live_audio_state` every 5 s, and the budget clock is paused during the wait.
- The ASR `core.agent` gains a session branch that calls C5 once.
- WF-SET-005 (`SETTINGS_LIVE_AUDIO_UNREAD`), TS + Python, with 13 shared fixture cases.
- A replay fixture `interpreter_task1042_live_audio_history` is registered in `INTERPRETER_FAMILY_FIXTURES`.

**SDKs and console:**
- vox-node `hope.workflows.runWithAudio` (+ `RunAudioFieldError`) and `CreateStreamSessionRequest.workflowSlug`.
- vox `useRunAudio` standalone mode (`audioField`) and the `workflowSlug` pass-through (`PluginManager`, `@arcaai/stt` `STTProcessor` / `StreamingBackendSTTProvider`).
- `run-guide.ts` stream-audio snippets rewritten.

### 6.3 Deviations from the frozen contract (accepted by the orchestrator)

| # | Deviation | Why |
|---|---|---|
| D1 | A `truncated` / `timeout` / unbound session ends the ASR node **DEGRADED** with no output (code in the reason and the trajectory), not FAILED. | A node activity cannot return FAILED, and `core.agent` is not critical. The run ends DEGRADED; a short transcript is still never returned. |
| D2 | WF-SET-005 exempts workflows whose `sources` include `consultation`. | This mirrors WF-SET-003. The seeded consultation note schemas declare a stream kind that is read through the consultation session. |
| D3 | `RUN_AUDIO_AGENT_MISMATCH` also covers a graph with zero or several STT nodes. A non-string `sttSessionId` is 400 without a code. C5 answers 400 without `runId` or `X-Tenant-Id`, and 503 when Redis is unreadable. | These are additions only; the frozen rows are unchanged. |
| D4 | `packages/domains` `TranscriptionJobEntity` / `Factory` gained `metaData`. | It is required for C8 to persist. |
| D5 | The SDK lane edited `PluginManager`, `STTProcessor` and `StreamingBackendSTTProvider`. | These are pass-throughs; without them `workflowSlug` never reaches the wire. |
| D7 | vox-node `runWithAudio` `finalize()` tolerates a 404 from `closeStreamSession` **after a successful socket finalize**. | **Found by the live proof:** the socket `stop` ends the session on the gateway, so the DELETE that follows answers 404 and `finalize()` threw although the audio had ended cleanly. A 404 after a FAILED finalize, or any other error, still surfaces. Pinned by two unit tests. |
| D6 | `@arcaai/workflow-contract` `bindings.ts` + `py-workflow-contract` `bindings.py`: a `context.<kind>` path whose schema is the stream-audio payload (an object whose only property is the string `sttSessionId`) resolves as `audio`, not `json`. | **Found by the e2e spec, missed by every lane:** the publish gate refused `context.mic` → ASR `audio` with `BINDING_TYPE_MISMATCH`, so no standalone live-audio workflow could be published, the very graph WF-SET-005 requires. Pinned by two shared `bindings.fixture.json` cases (positive + narrowness). Blob-delivered audio derives to a media reference that cannot be told from a document by shape, so it still types as `json` (follow-up). |

### 6.5 Gate: one pass after the complete integration (orchestrator, 2026-10-05)

Run in the sibling verify worktree `../hope-v2-task-1042-verify`: a real `pnpm install --frozen-lockfile --prefer-offline`; the primary checkout's `node_modules` symlinks were checked afterwards and are untouched. The tree is dev-2.2 + every TASK-1042 commit, last at `f673e6abc` (which includes dev-2.2's `fe47d7d1a`).

**Artifacts regenerated** (`5f80ef21c`): `route-manifest.json`, `openapi.json`, and the admin and business portal files. vox-node `gen:admin` reported no change, because no admin route changed.

**Run 1 found:**
- **Integration fixes, all made** (`fix(task-1042)` + `style(task-1042)`):
  - the internal transcript controller lacked `InternalTenantLockGuard` (TASK-1043's coverage rule);
  - a `useRunAudio` store-typing error (TS18046);
  - WF-SET-005 test typing;
  - the run-guide drift pin was missing `runWithAudio`;
  - one prettier lint ERROR in `transcription-job.controller.ts`, plus prettier warnings across our files;
  - a silent `catch` in the C5 timeout check, which now propagates per the config rule;
  - the Integration-tab test expected `hope.stt` (the tab now passes `streamAudioField`, so the snippets name the real field).
- **Not ours, fixed by their owners on dev-2.2:**
  - `consultation-workflow-dispatch.consultation-metadata.task1038` (OD-35 `onBehalfOf`);
  - the TASK-1043 coverage test's `import.meta.glob` TS1343.
- **Environmental:** 208 console files could not load because the `@arcaai/ui` dist was cut off by the turbo abort. After a rebuild they pass.

**Final results:**

| Step | Result |
|---|---|
| TS lint (`turbo run lint --continue`) | rc 0 |
| TS typecheck | rc 0 for every package; api rc 0 after merging dev-2.2 `fe47d7d1a` |
| Python ruff (harness, py-workflow-contract) | rc 0 |
| mypy harness | rc 0 |
| docs, openapi, portal, `gen:admin`, `gen:check`, env-sync, python-surface checks | all rc 0 |
| TS unit (root vitest, `.env.test`) | 30,841 passed. 6 files timed out at 30 s in the final run under machine load (duration 649 s vs 275 s, import 89%); the same 6 files pass alone, 143/143. Run 1 had no timeouts. |
| `@arcaai/admin-console` | 4,511 passed |
| `@arcaai/vox` | 3,398 passed |
| `@arcaai/vox-node`, `@arcaai/stt` | rc 0 |
| `py-workflow-contract` pytest | rc 0 |
| Harness pytest, including replay-compat with `interpreter_task1042_live_audio_history` | rc 0 |
| TASK-1043 lock coverage (after its fix) | 4 passed; our controller is covered |

**E2E** on the isolated test infra (released by the TASK-1044 session), test API built from the verify tree, `RESET_DB=false`:
- `task-776-route-authz-matrix`: all 7 pass. 758 routes swept, 0 anomalies. The `@Public()` `/internal/*` inventory pin moved 40 → 41 for the new transcript route, which answers 401 without a service token.
- `workflow-run-live-audio-cross-tenant`: the 4 STT-free cases pass (unknown session 404, `RUN_AUDIO_INPUT_UNDECLARED`, `LIVE_AUDIO_UNSUPPORTED` via a legacy definition, `STREAM_SESSION_TARGET_CONFLICT`). The 4 live-session cases skip with a reason: the STT service is not running in the test environment (session create 503 `GATEWAY.DOWNSTREAM_UNAVAILABLE`). They are covered by unit tests and are part of the live proof.
- The first run surfaced D6. A workflow that DECLARES settings without `socket` cannot publish a stream-audio Input (WF-SET-003 ERROR), so `LIVE_AUDIO_UNSUPPORTED` is only reachable through a legacy definition.
- Also fixed in this round: mypy on `py-workflow-contract` (the gate script had run mypy for the harness only) found two `arg-type` errors in WF-SET-005; both are fixed.

**Full e2e suite** (the final one for dev-2.2, at the TASK-1036 orchestrator's request), test API built from dev-2.2 `c04d05eec`, `RESET_DB=false`, 6.8 min: **1,436 passed, 82 skipped, 2 failed, 0 flaky.** Neither failure is caused by this ticket:
- `task-933-service-account-consultation` › "drives the consultation…": **environmental**. Recording start needs the harness to record the governing run, and the test harness on 8966 is not running; the test API log shows 9 `ECONNREFUSED` to 8966. It fails alone too.
- `task-959-usage-surface` › "the day bucket moves by exactly what was billed into it": **shared state under parallel workers**. It passes alone, 5/5.

**Not run:** the browser `useRunAudio` live pass (console Test tab / an app). It is unit-tested and shares the gateway path the vox-node proof exercised.

### 6.6 Live proof (dev stack, 2026-10-05 03:44 UTC, coordinated with the TASK-1036 session)

- **Setup:** the dev stack was restarted from dev-2.2 `0f00ddc3b`, then the primary checkout was rebuilt for `@arcaai/workflow-contract` (D6) and the gateway restarted.
- **Run:** one vox-node `hope.workflows.runWithAudio` call with an API key minted for the run, from the verify-tree build, against a workflow authored for the proof in the Global tenant: trigger (stream-audio `mic`) → `realtime-transcription` → output, with `connections: [api, socket]`. The audio was `cardiology_consult_01.wav` (21.9 s, 16 kHz mono PCM16), sent at real-time pace in 100 ms frames.

| Step | Evidence |
|---|---|
| Publish with `context.mic` → ASR `audio` | accepted (D6 live) |
| Session create with `workflowSlug` → run start with `{ sttSessionId }` | 202, run RUNNING at 03:44:16 |
| Durable wait | `node.started n_trigger` at 03:44:42, after the audio ended (finalize 03:44:38) |
| Mirror (`boundRun`) | 38 `transcript.partial` + 4 `transcript.final` in `wf:run:<id>:events` |
| ASR session branch (C5 → C6) | `n_asr` SUCCEEDED; `output.data` `transcript` = the full 21.9 s text ("the patient presence with shortness of breath on exertion … start aspirin 81mg daily"), `segments` = 3 timed segments (0–5.632, 5.632–8.896, 8.896–21.888) |
| Run | COMPLETED in 26.3 s; 0 failed / degraded nodes |
| SDK | `audio.finalize()` threw 404, so **D7** was fixed |

The proof graph wired no output field, so the business result was `{}`; the transcript was read from the admin `output.data` events.

Left on the dev DB: workflow definition `t1042_live_710e2103bb` (Global). Its DELETE answers 409 because a run references it. The proof's API key and context schema were deleted.

### 6.4 Known limits and follow-ups

- **Result-stream cap.** `stt.streaming.resultStreamMaxlen` defaults to 10000. Partials during speech run at about 2.5 entries/s, so the cap holds about 4000 s of continuous speech, just above the 3600 s ceiling. A session past it reads as `truncated` (fail-closed, never short). The owner decided (2026-10-05) to keep 10000.
- After close, the result stream expires in 3600 s. A C5 read after that reads as `truncated` unless the row recorded zero characters. The harness reads within 5 s of the end, so only a much later re-read is affected.
- The Integration tab passes the real `audioField` when the Input shape has exactly ONE live-audio kind (`RunShapes.streamAudioField`). With several, the snippets show the `<audioField>` placeholder.
- Blob-delivered audio (`delivery: 'blob'`) still binds as `json` to an ASR `audio` input (D6 covers stream only); a separate follow-up.
- The deprecated `:slug/invoke` alias also binds audio but carries no Swagger update.


## 7. Change History

| Date | Change |
|---|---|
| 2026-10-05 | Ticket raised from OD-37. Discovery by 3 sonnet scouts (gateway, harness, SDK); the orchestrator re-verified the sandbox ownership rule, the mirror's consultation-only resolution, the standalone `subject` limit, the harness `no_audio` path and the `useRunAudio` limit in code. Plan and OD-1..12 written. Status Pending. |
| 2026-10-05 | **Owner approved** OD-1..12 as recommended. Start is gated on the OD-35 merge (OD-12). Status → Approved, waiting to start. |
| 2026-10-05 | OD-35 is not yet merged (the lane is still running). On the owner's instruction the SDK lane (L3) and the harness lane (L2) start now and the gateway lane (L1) is held. Contract C1–C7 frozen. **OD-4a**: the owner chose the durable wait, because the 900 s / 3600 s caps make OD-4 impossible. |
| 2026-10-05 | L3 merged (`12d2ee1ac`). OD-35 merged on dev-2.2 (`ee31a7e67`, `71c3ebeda`) and brought in (`b263f0627`). C8 pins session ownership to the OD-35 principal helper. The service-account run-ticket gap does not affect this ticket: vox-node `RunHandle` streams SSE with header credentials and mints no ticket. L1 launched. |
| 2026-10-05 | L2 and L1 merged; artifacts regenerated in the verify worktree `../hope-v2-task-1042-verify` (`5f80ef21c`). Owner: merge target dev-2.2; keep `resultStreamMaxlen` at 10000. Single gate pass running. |
| 2026-10-05 | Single gate pass in the verify worktree; integration fixes made; the Integration tab wires `streamAudioField`; verify merged into the orchestrator branch (`e28fe7e8c`). |
| 2026-10-05 | Merged into dev-2.2 (`2689d5da8`). E2E on the test infra found D6 (stream-audio binding typed `json`), fixed in both contract twins with shared fixture cases; mypy fix in WF-SET-005; authz inventory 41. |
| 2026-10-05 | Full e2e on dev-2.2 `c04d05eec`: 1,436 passed, 82 skipped, 2 failed (both environmental or shared-state, triaged). |
| 2026-10-05 | Live proof on the dev stack passed end to end (§6.6) and found D7 (`runWithAudio` finalize 404), fixed. Status → Review. |
| 2026-10-05 | File ownership agreed with the TASK-1036/1038 session: no collision except `workflow-exposure.service.ts` (sequenced after OD-35). TASK-1036 §6.13 and §8.7 stay with that session. |
