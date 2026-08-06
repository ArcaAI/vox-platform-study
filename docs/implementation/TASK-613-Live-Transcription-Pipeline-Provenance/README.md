# TASK-613 — Live-Transcription Pipeline Provenance

| Field | Value |
|---|---|
| **Status** | `Review` — all lanes implemented 2026-08-06, all gates green, uncommitted on `dev-2.1`. **Runtime evidence (§3.7) outstanding** — stack was down |
| **Type** | `feature` |
| **Branch** | `dev-2.1` |
| **Created** | 2026-08-06 |
| **Related** | TASK-614 (STT provider switch + auto-fallback — absorbs AC-3/AC-4 of this ticket), TASK-567 (STT fallback BYOK), TASK-586 (compat runtime provider switch), TASK-564 (live-transcription metadata passthrough), TASK-587/598 (language selection/runtime) |

> **Scope change 2026-08-06 (OD-A resolved).** Two items of this plan turned out to be hard prerequisites for TASK-614's provider-switch fixes and were **moved there**:
> - **AC-3** (`activePipeline` server-derived) → TASK-614 Lane D1–D3
> - **AC-4** (`provider_switched` relays `active` / `is_fallback`) → TASK-614 Lane B1 / D4
>
> Consequently **Lane D rows D1, D2, D4 below are struck** — they are implemented under TASK-614. This ticket retains per-utterance provenance: Lanes A1–A4/A6, B1, C3–C4, D5–D6. Start it after TASK-614's Lanes A–C land, so the session-create echo and status relay already exist.

---

## 1. Requirement Analysis

**Requirement (owner, verbatim):** *"we need to return the true pipeline-id as metadata returned to the client along with transcript for live-transcription."*

### What "true" means here

The client today knows only which pipeline it **asked for**. The pipeline that actually produced a given utterance can differ from that request in five distinct ways, all of which exist in the code today:

| # | Divergence | Where it happens |
|---|---|---|
| D1 | Client sends **no** `pipelineId` → the gateway picks one from the `provider` enum or the tenant default | `stt-compat.controller.ts:105-113` |
| D2 | Client sends a **slug**, not a UUID → STT resolves it to a different identifier | `apps/stt/.../transcription/api/routes.py:115-120` (same reader used by streaming) |
| D3 | Session opens on the **fallback** by owner selection (`startOn: 'default'`/`'fallback'`) | `stt-compat.controller.ts:123-126`, `session_manager.py:1025-1028` |
| D4 | Primary ASR **fails to load at create** → STT silently opens on the fallback (`created_on_fallback`) | `session_manager.py:1019-1024` |
| D5 | Engine **switches mid-session** — auto (outage) or user-initiated, and now bidirectional | `session_manager.py:1134-1182`, `engine_switch.py:226+` |

D4 is the sharpest case: the session is created successfully, the client is told `status: 'active'`, and it transcribes on an engine the client never selected and is never told about with certainty.

### Scope

**In scope**

- **AC-1** — Every live-transcription transcript frame delivered to a client carries the pipeline id that produced *that utterance* (both the native `/ws/stt/stream` path and the v1-compat `stt-compat` path).
- **AC-2** — Session creation echoes the **resolved** pipeline id (and the engine actually opened on) back to the caller, so the client has a correct baseline from frame 0 — including when it sent no `pipelineId` at all.
- **AC-3** — The SDK store's `activePipeline` is **server-derived**, not request-derived, and is non-null for every backend streaming session.
- **AC-4** — `provider_switched` reaches the client complete: `active` / `is_fallback` are relayed (today they are dropped in the bridge — see §2.4).
- **AC-5** — No PHI or credential material is added to the wire; the pipeline id is a non-secret identifier already known to the tenant.

**Out of scope**

- Batch/file transcription provenance (`transcribe_file.py` already writes `usedFallbackPipelineId` into `result.metadata`; a follow-up may unify the two shapes).
- Any change to pipeline *selection* logic — this ticket reports the truth, it does not change which pipeline runs.
- Admin-console UI surfacing of the new field.

### Open questions for the owner

1. **OD-1 — Human-readable name.** Should the frame carry a `pipelineName` alongside the id? The store's `ActivePipelineInfo.name` currently just echoes the id (`useArcaAudio.ts:859`), so any UI showing "name" today is showing a UUID. Resolving the name costs a lookup at session create (once, not per frame). *Recommendation: yes, resolve once at create and carry the name on the session baseline only, not on every frame.*
2. **OD-2 — Per-frame cost.** Stamping every partial adds ~40 bytes/frame to a high-rate stream. *Recommendation: stamp anyway (see §3.1 rationale) — correctness of clinical provenance outweighs the bandwidth.*
3. **OD-3 — Compat wire placement.** For the v1-compat path, does `pipeline_id` go on the top-level `transcription` message or inside `metadata`? v1 clients ignore unknown keys either way, but `metadata` is the passthrough channel TASK-564 established. *Recommendation: both — top-level `pipeline_id` for new consumers, mirrored into `metadata.pipeline_id` for the TASK-564 passthrough contract.*

---

## 2. Current State Evaluation

Verified against the working tree on `dev-2.1`, 2026-08-06.

### 2.1 The transcript frame carries no pipeline identity at all

`SegmentResult` — the only shape that reaches a client as a transcript — has no pipeline field:

```
apps/stt/src/stt/streaming/schemas.py:162-205
  text, english_text, speaker_id, speaker_confidence, start_time, end_time,
  is_final, word_timestamps, inference_ms, stable_chars, utterance_index,
  result_type, language
```

`to_redis_dict()` (`:179-205`) therefore publishes no pipeline id, the bridge's transcript projection (`streamingAudioBridge.service.ts:732-747`) has none to forward, and both gateways relay what the bridge gives them (`stt-ws.gateway.ts:567-592`, `stt-compat.gateway.ts:202-227`).

**The pipeline id is known at every one of those hops** — `StreamSession.pipeline_id` exists (`session.py:143-144`) and is already written into the session's own metadata document (`session.py:445`) and diagnostics snapshot (`session.py:556`). It is simply never attached to a result.

### 2.2 Session creation does not echo the resolved pipeline

| Path | Response shape | Carries pipeline? |
|---|---|---|
| STT internal | `StreamingSessionResponse` — `session_id, status, reason, max_concurrent, current_active` (`api/schemas.py:100-107`) | ❌ |
| Native gateway | `{ sessionId, status, wsUrl, maxConcurrent, currentActive, ticket, ticketExpiresAt, voiceProfileSeeded }` (`transcription-job.controller.ts:483-493`) | ❌ |
| v1-compat | `StartSessionResponse` — `message, session_id, status, audio_config, provider` (`dto/start-session.response.ts`) | ❌ (only the coarse `provider` enum the caller sent) |

So D1–D4 above are all invisible to the client at session start.

### 2.3 The SDK's `activePipeline` is request-derived, not server-derived

```ts
// packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:858-860
store.setActivePipeline(
  options?.pipelineId ? { id: options.pipelineId, name: options.pipelineId, isFallback: options?.startOn === 'fallback' } : null,
);
```

Three consequences:

- A client that omits `pipelineId` (D1) gets `activePipeline === null` **for the whole session** — and every downstream consumer degrades: `useSttProviderToggle` reports `activeProvider: null` / `fallbackAvailable: false` (`useSttProviderToggle.ts:109-111`), and `useArcaSttProvider` falls back to `pendingIsFallback` (`useArcaSttProvider.ts:206-207`).
- `name` is the id echoed back — never a real pipeline name.
- `isFallback` is inferred from the client's own `startOn`, so a **D4 create-time fallback is not reflected** unless the `provider_switched` frame arrives *and* is fully relayed — which it is not (§2.4).

### 2.4 `provider_switched` is relayed incomplete — a known, still-open gap

STT publishes the full frame (`redis_streams.py:499-509`): `from_pipeline`, `to_pipeline`, `reason`, `active`, `is_fallback`, `utterance_index`.

The bridge's status projection deliberately drops two of them, and says so:

```
packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts:623-637
  NOTE: `active` / `is_fallback` are deliberately NOT relayed here — that is
  a pre-existing TASK-586 gap (the v1-compat gateway codes for them but never
  receives them) and widening the status DTO is out of this change's scope.
```

The compat gateway does code for them (`stt-compat.gateway.ts:236-239`) and therefore never fires. The SDK's handler compensates with a guess — absent both fields it assumes `isFallback = true` (`useArcaAudio.ts:830`), which is wrong for every user-initiated switch **back** to primary.

### 2.5 What already works (do not rebuild)

- The `status` result type is an established, PHI-free channel that both gateways forward, with a documented allow-list projection — the right place to widen, not a new frame type.
- `utterance_index` already correlates follow-up results (e.g. the `gloss` translation) with their final — the same ordinal a per-utterance pipeline stamp should use.
- Batch already solved its half: `transcribe_file.py:336` writes `result.metadata["usedFallbackPipelineId"]`.

---

## 3. Implementation Plan

### 3.1 Design decision — stamp at the source, per utterance

The pipeline id is attached to `SegmentResult` **where the ASR result is constructed**, not injected at a gateway. Rationale:

- D5 makes this genuinely per-utterance: after a mid-session switch, utterance *n* and utterance *n+1* come from different engines. Anything stamped at a gateway from session-level state races the switch and mislabels exactly the utterances around it — precisely the moment provenance matters most.
- The failure path proves it. When the engine switch fires, `session_manager.py:2377-2387` **re-runs the same utterance on the freshly-swapped engine**. Only a stamp taken at result-construction time reports the engine that actually produced the text.
- The stamp is then correct by construction for D1–D5 with no per-path logic, and both relay hops are allow-list projections, so widening each is a two-line change that keeps the PHI posture.

The session-create echo (AC-2) is the *baseline* covering the window before the first utterance; the per-frame stamp is the *truth*.

### 3.2 The seam (verified — build against these, not against §2's symptom list)

`StreamingInferenceWorker` owns all three `SegmentResult` construction sites (`inference.py:436` main, `:556` gloss, `:1114` empty/partial) and publishes them (`:501`, `:566`). It holds `self._asr_pipeline`, which the engine switch **mutates in place on the live worker**:

```python
# session_manager.py:1150-1155  — _apply(), passed to EngineSwitchController
def _apply(new_callable: StreamingAsrCallable) -> None:
    worker = self._inference_workers.get(session_id)
    if worker is not None:
        worker._asr_pipeline = new_callable   # "the whole seamless swap"
```

That single function is the atomic swap point, called from `engine_switch.py:246` immediately before `self._active = target`. **Therefore: carry the pipeline id alongside the callable through the same seam.** Concretely —

1. `StreamingInferenceWorker.__init__` gains `active_pipeline_id: str | None = None` → `self._active_pipeline_id`; all three `SegmentResult(...)` sites set `pipeline_id=self._active_pipeline_id`.
2. `apply_callable` widens to `(new_callable, pipeline_id)`; `_apply` sets `worker._active_pipeline_id = pipeline_id` in the same body. `_switch_to` passes `self._fallback_pipeline_id` / `self._primary_pipeline_id` matching `target`.
3. At create, the worker is constructed with the **effective** id, not the requested one. `session_manager.py:891` already computes the equivalent: `initial_pipeline_id = fallback_pipeline_id if started_on_fallback else pipeline_id`. Extend it to cover the load-failure path, which sets `created_on_fallback = True` at `:963`:
   ```python
   effective_pipeline_id = fallback_pipeline_id if (started_on_fallback or created_on_fallback) else pipeline_id
   ```
   Set it on the worker after the runtime is unpacked (`:964-966`), before registration at `:982`.
4. `note_switched_at_create` (`engine_switch.py:193-205`) deliberately does **not** call `apply_callable` — the manager already installed the fallback callable. Step 3 is what covers D4; do not add an `_apply` call there.
5. The crash-recovery rehydrate path reconstructs a worker at `session_manager.py:3728-3770` — it needs the same treatment or recovered sessions emit unstamped frames.

### 3.3 Frozen wire contract (authoritative — lanes MUST NOT renegotiate)

Field names are fixed here so the four lanes can run in parallel without drift. Any lane that believes a name is wrong stops and escalates rather than choosing its own.

| Hop | Field(s) | Type | Optional? |
|---|---|---|---|
| Redis result stream (`SegmentResult.to_redis_dict`) | `pipeline_id` | `str` | key **omitted** when unknown |
| STT `POST /internal/streaming/sessions` response | `pipeline_id`, `active_engine` | `str`, `"primary" \| "fallback"` | required |
| Bridge → gateway transcript DTO | `pipelineId` | `string` | optional |
| Bridge → gateway status DTO | ~~`active`, `isFallback`~~ → **shipped by TASK-614 as `active`, `is_fallback`** | `'primary' \| 'fallback'`, `boolean` | optional (present only on `provider_switched`) |
| Native `POST /stream/session` response | `pipelineId`, `activeEngine` | `string`, `'primary' \| 'fallback'` | required |
| Native WS transcript frame | `pipelineId` | `string` | optional |
| Compat `POST /api/stt/start_session` response | `pipeline_id`, `active_engine` | `string`, `'primary' \| 'fallback'` | required (additive; v1 clients ignore unknown keys) |
| Compat WS `transcription` message | `pipeline_id` **and** `metadata.pipeline_id` | `string \| null` | both present (per OD-3) |
| SDK transcript result | `pipelineId` | `string` | optional |
| SDK `ActivePipelineInfo` | shape unchanged — **source** changes to the server response | — | — |

**Naming rule:** snake_case on every Python/Redis/v1-compat surface, camelCase on every TS-native surface. This mirrors the existing `from_pipeline`/`fromPipeline` split — do not "harmonize" it.

> **Contract reconciliation 2026-08-06 (post-TASK-614).** Verified against what 614 actually shipped:
> - **Status DTO** — 614 shipped `is_fallback` (snake), not the `isFallback` this table originally specified, alongside its already-snake `from_pipeline`/`to_pipeline` siblings (`dto/streaming-session.dto.ts:250-256`). **That is now the contract**; the table row above is struck accordingly. Do not "fix" it to camelCase — the compat gateway and SDK already consume the shipped shape.
> - **Transcript DTO** — unchanged and still camelCase (`stableChars`, `utteranceIndex`, `englishText`), so `pipelineId` for task B1 is correct as written.
> - **Session-create hops (AC-2)** — shipped by 614 exactly as specified: `pipeline_id`/`active_engine` on STT, `pipelineId`/`activeEngine` on the native gateway, `pipeline_id`/`active_engine` on compat.

### 3.4 Backward compatibility (non-negotiable)

Every change is **additive**. Two directions must both work and both need a test:

- **Old SDK → new backend**: extra fields ignored. No existing field changes type, meaning, or optionality.
- **New SDK → old backend**: `pipelineId === undefined` / `active_engine` absent. The SDK must degrade to today's request-derived behavior, never throw and never render "undefined".

### 3.5 Task breakdown, ownership, and model tier

Lanes A→B→C are a strict dependency chain (each consumes the previous hop's contract). Lane D consumes C. Within a lane, tasks marked ∥ may run concurrently.

**Tier rationale:** tier tracks *reasoning* difficulty, not diff size. Tasks that touch concurrency, an in-place mutation seam, or a source-of-truth inversion get the top tier even when the diff is ~20 lines; schema/DTO/type plumbing with a frozen contract is mechanical regardless of file count.

#### Lane A — STT service (`apps/stt`) · gate: `pnpm stt:test` green

| # | Task | Tier | Effort | Depends on |
|---|---|---|---|---|
| A1 ∥ | Add `pipeline_id: str \| None = None` to `SegmentResult`; emit in `to_redis_dict()` only when set; round-trip in `from_redis_dict` (`schemas.py:162-220`) | sonnet-5 | medium | — |
| A2 ∥ | Widen `StreamingSessionResponse` with `pipeline_id` + `active_engine` (`api/schemas.py:100-107`); populate from the created session in `routes.py:70-130` | sonnet-5 | medium | — |
| **A3** | **The seam.** Steps 1–5 of §3.2: worker field + 3 construction sites, `apply_callable` widening, `_switch_to` call sites, create-time effective id, rehydrate path. | **opus-4-8** | **xhigh** | A1 |
| A4 | Tests: primary-stamp, post-switch-stamp, `created_on_fallback` first-frame stamp, `started_on_fallback` stamp, gloss inherits its final's stamp, switch-retry utterance carries the **new** engine's id | opus-4-8 | high | A3 |

> **A3 hazard:** `_apply` mutates a private attribute on a live worker while the inference loop reads it each utterance. Keep the pipeline-id assignment in the *same* function body as the callable assignment — do not introduce a second update path, a getter callback, or an `await` between them.

#### Lane B — Applications bridge (`packages/applications`) · gate: `pnpm --filter @arcaai/applications test build`

| # | Task | Tier | Effort | Depends on |
|---|---|---|---|---|
| B1 | Forward `pipelineId` in the transcript projection (`streamingAudioBridge.service.ts:732-747`) + DTO | sonnet-5 | medium | A1 (contract only) |
| B2 | Forward `active` + `isFallback` in `buildStatusMessage` (`:627-638`); **rewrite the `:623-625` comment** that declares them deliberately unrelayed — leaving it would mislead the next reader | sonnet-5 | medium | B1 (same file — must NOT run concurrently with B1) |
| B3 ∥ | Map `pipelineId`/`activeEngine` onto `StreamingSessionStatus` (`streamingSession.service.ts:88-140`) | sonnet-5 | medium | A2 |
| B4 | Regression test: both projections stay allow-lists — inject a novel upstream field, assert it is dropped | sonnet-5 | medium | B1, B2 |

#### Lane C — API gateway (`apps/api`) · gate: `pnpm test:unit`, then `pnpm test:e2e`

| # | Task | Tier | Effort | Depends on |
|---|---|---|---|---|
| C1 ∥ | Native session-create response + DTO (`transcription-job.controller.ts:483-493`) | sonnet-5 | medium | B3 |
| C2 ∥ | Compat `start_session` response + DTO (`stt-compat.controller.ts:82-149`, `dto/start-session.response.ts`) | sonnet-5 | medium | B3 |
| C3 ∥ | Native WS transcript pass-through; test asserts `pipelineId` is not stripped by `relayResult` (`stt-ws.gateway.ts:567-592`) | sonnet-5 | medium | B1 |
| C4 | Compat `transcription` message: top-level `pipeline_id` + mirrored `metadata.pipeline_id`, preserving the TASK-564 `resolveMetadata` passthrough (`stt-compat.gateway.ts:202-227`) | sonnet-5 | high | B1 |
| C5 | Verify the now-live `isFallback` branch (`stt-compat.gateway.ts:236-239`) fires in **both** switch directions — it has never executed | sonnet-5 | medium | B2 |
| C6 | Cross-tenant regression: a foreign session still 404s; no new field leaks tenant/pipeline data pre-auth | sonnet-5 | medium | C1–C4 |

#### Lane D — SDK (`packages/agentic-sdk-v2`) · gate: `pnpm --filter @arcaai/vox build test lint typecheck`

| # | Task | Tier | Effort | Depends on |
|---|---|---|---|---|
| **D1** | **Source-of-truth inversion.** `activePipeline` derives from the session-create response, not `options.pipelineId` (`useArcaAudio.ts:858-860`). Must hold for: no-`pipelineId` session (→ non-null), `created_on_fallback` (→ `isFallback: true` from frame 0), and an old backend (→ graceful degrade to today's behavior). | **opus-4-8** | **xhigh** | C1, C2 |
| **D2** | Remove the `isFallback` guess in `onProviderSwitched` (`useArcaAudio.ts:828-842`) now that B2/C5 deliver the real fields; the `?? true` default is wrong for every switch back to primary. Re-verify the durable-latch semantics in `sttConnectionState`. | **opus-4-8** | **high** | C5, D1 |
| D3 ∥ | Type plumbing: `pipelineId` on the transcript result (`types/stt.ts`, `types/audio.ts`) | sonnet-5 | medium | D1 |
| D4 ∥ | Compat `onTranscript` metadata carries `pipeline_id`; TASK-564 passthrough contract unchanged (`compat/useArcaSpeechToText.ts`, `compat/types.ts`) | sonnet-5 | medium | D3 |
| D5 | `useArcaSttProvider` / `useSttProviderToggle` report the true provider for a no-`pipelineId` session; assert the previously-`null` degradation is gone (`useArcaSttProvider.ts:204-207`, `useSttProviderToggle.ts:109-111`) | sonnet-5 | high | D1 |

#### Lane E — Integration & closure

| # | Task | Tier | Effort | Depends on |
|---|---|---|---|---|
| E1 | Cross-lane contract audit: every hop in §3.3 verified end-to-end; both mixed-version directions (§3.4) exercised | opus-5 | xhigh | A–D |
| E2 | Runtime evidence capture (§3.7) in the compat playground | sonnet-5 | high | E1 |
| E3 | Ticket §4 Implementation Summary + §5 Change History from captured evidence | sonnet-5 | medium | E2 |

### 3.6 Agent execution protocol

**TDD is mandatory and RED must be observed.** Per `01-development-workflow.md`: no implementation before a failing test, and a test that never failed verifies nothing. Each agent pastes the RED output, then the GREEN output. A task reporting only GREEN is rejected and re-run.

**Working-tree isolation.** Multiple agents on one tree destroy uncommitted work — this repo has already lost work that way. Either give each lane its own `git worktree`, or serialize lanes and **commit at every lane gate**. If using worktrees: `Agent(isolation: 'worktree')` bases off `main`, **not** `dev-2.1` — the branch must be set explicitly or the lane builds against the wrong baseline.

**Rebuild edited workspace packages.** `@arcaai/applications` and `@arcaai/vox` are consumed as built `dist`. A downstream lane testing against a stale `dist` reproduces the TASK-594/597 false negative — a fix that was already correct read as broken for hours. Lane B and Lane D end with a package build before the next lane starts, and any Vite consumer clears `.vite`.

**Escalation, not improvisation.** An agent that finds the frozen contract (§3.3) wrong, or a seam that does not match §3.2, **stops and reports**. It does not pick a different field name, add a compatibility shim, or widen scope. Contract changes are made once, here, and re-broadcast.

**Scope discipline.** Every changed line traces to an AC in §1. Adjacent code is not "improved", refactored, or reformatted. The one sanctioned exception is the stale comment at `streamingAudioBridge.service.ts:623-625` (task B2), which this change makes false.

**Handoff artifact.** Each lane returns: files changed, RED + GREEN output, the gate command output, and any assumption it had to make. Assumptions surface to the owner — they are not resolved by the next agent in the chain.

### 3.7 Verification criteria (Phase 5 gate)

- [ ] `pnpm stt:test` green (Lane A)
- [ ] `pnpm --filter @arcaai/applications test build` green (Lane B)
- [ ] `pnpm test:unit` + `pnpm test:e2e` green (Lane C)
- [ ] `pnpm --filter @arcaai/vox build test lint typecheck` green (Lane D)
- [ ] `pnpm lint:all` and `pnpm typecheck:all` clean
- [ ] Mixed-version matrix (§3.4) green in **both** directions
- [ ] **Runtime evidence** — a live compat-playground session showing: (a) a session started with **no** `pipelineId` reporting the resolved id from frame 0, (b) a mid-session switch where consecutive utterances carry **different** pipeline ids, (c) a `created_on_fallback` session reporting the fallback id without any client-side inference
- [ ] PHI posture re-read: both projections still allow-lists; no credential or patient data added to any frame

---

## 4. Implementation Summary

**Partial — Lane A1+A2 only. Execution halted 2026-08-06 by owner decision; remainder is blocked on TASK-614.**

### Landed (staged on `dev-2.1`, NOT committed)

| File | Change |
|---|---|
| `apps/stt/src/stt/streaming/schemas.py` | `SegmentResult.pipeline_id: str \| None = None`; emitted by `to_redis_dict()` only when set; round-tripped by `from_redis_dict()` |
| `apps/stt/src/stt/streaming/api/schemas.py` | `StreamingSessionResponse` gains required `pipeline_id: str` + `active_engine: str` |
| `apps/stt/src/stt/streaming/api/routes.py` | New `_resolve_active_engine()` helper reading the installed `EngineSwitchController` via the public `SessionManager.get_switch_controller()`; wired into `create_streaming_session` **and** `get_streaming_session` (shared response model) |
| `apps/stt/tests/unit/test_streaming.py`, `test_streaming_api.py`, `streaming/test_language_modes_api.py` | New coverage + 3 pre-existing session mocks updated for the now-required fields |

**Evidence.** TDD honored — RED first (7 failures: `KeyError`, `AttributeError: no attribute 'pipeline_id'`, `DID NOT RAISE ValidationError`), then GREEN. Gate `pnpm stt:test`: **2727 passed**, 49 skipped, 3 xfailed, 202 errors. A clean-tree baseline captured *before* any edit reported **2720 passed, 202 errors** — the 202 are a pre-existing `db_conn._engines` `AttributeError` in `tests/e2e/conftest.py`, unrelated and unchanged. Net: +7 passing, zero new failures.

**Contract note.** `pipeline_id` / `active_engine` are **required** on `StreamingSessionResponse` per §3.3 — the one non-additive edge in the change. Every construction site must supply them; the only other site (`get_streaming_session`) was found and populated rather than left broken.

### Known gap handed to A3

`active_engine` is truthful today for both fallback divergences (D3 `start_on=fallback`, D4 `created_on_fallback`) — the controller flips to `'fallback'` before `create_session` returns. But `pipeline_id` is `session.pipeline_id`, the **requested primary** id, so a D3/D4 session reports `active_engine: 'fallback'` beside a `pipeline_id` naming the primary. A3 must either stamp the session with the `effective_pipeline_id` of §3.2 step 3, or expose the fallback id off the switch controller for `routes.py` to select. **Until then these two fields can disagree — do not treat `pipeline_id` from this endpoint as authoritative for a fallback session.**

### Lane A3+A4 — the per-utterance stamp seam ✅

| File | Change |
|---|---|
| `inference.py` | `StreamingInferenceWorker` gains `active_pipeline_id`; all three `SegmentResult(...)` sites stamped. The **gloss inherits its originating final's** id, not the live worker's — a switch can land between the final and its fire-and-forget gloss |
| `engine_switch.py` | `apply_callable` widened to `(callable, pipeline_id)`; `_switch_to` passes the id matching `target`; new `active_pipeline_id` property derived from `_active` (cannot drift) |
| `session_manager.py` | `_apply` sets `worker._active_pipeline_id` **in the same synchronous body** as `worker._asr_pipeline`; `_assemble_session_runtime` gains `active_pipeline_id`, passed at all three create branches **and** the crash-rehydrate path |
| `api/routes.py` | `_resolve_active_engine` → `_resolve_active_pipeline` returning `(effective id, engine)` — closes the A2 gap; `pipeline_id` and `active_engine` can no longer contradict each other |

**Effective-id design choice:** read `controller.active_pipeline_id` rather than stamp `SessionMetadata.pipeline_id`. Stamping the session field would have silently changed crash recovery, which reloads pipeline config from `meta.pipeline_id` — a `created_on_fallback` session would have started recovering onto the *fallback*. The controller is also the same object the swap seam updates, so the response provably cannot drift from the live engine.

**Gate:** `pnpm stt:test` → **2747 passed**, 202 pre-existing errors, 0 failures. 11 RED first.

### Lane B1 + C3 + C4 — relay ✅

| File | Change |
|---|---|
| `streamingAudioBridge.service.ts` + `dto/streaming-session.dto.ts` | Transcript projection forwards `pipelineId` (camelCase, conditional spread); allow-list preserved with a regression test proving a novel upstream field is still dropped |
| `stt-ws.gateway.ts` | **No production change** — `relayResult`/`tagAndBuffer` spread `{...msg, seq}`. Proven by test across both the immediate-send and the bounded backpressure-queue paths |
| `stt-compat.gateway.ts` | Top-level `pipeline_id` (`null` when unknown) **and** mirrored `metadata.pipeline_id`, non-mutating so the TASK-564 `resolveMetadata` cache is preserved |

**Gates:** applications `stt/streaming` 95/95 green, build clean; apps/api full unit run 2367 green.

### Lane D — SDK surfacing ✅

| File | Change |
|---|---|
| `SttWebSocketClient.ts` + `types/stt.ts` | `normalizeTranscript` reads `pipelineId` (preferred) then `pipeline_id`, set only when non-empty — the `detectedLanguage` pattern |
| `compat/speechToTextMetadata.ts` | New `resolvePipelineId` mirroring `resolveDetectedLanguage`'s precedence; overlaid as `pipeline_id`, key omitted when unresolved |
| `packages/stt` — `StreamingBackendSTTProvider.ts` + `types/index.ts` | **The last mile.** `StreamingTranscriptPayload.pipelineId` → `TranscriptionResult.pipelineId`. Without this the field died at the transport hop and never reached the store |
| `types/audio.ts` + `useArcaAudio.ts` | `TranscriptSegment.pipelineId`; the segment builder copies it via conditional spread |

**Gates:** `@arcaai/stt` 443 passed, typecheck clean, build OK. `@arcaai/vox` **3963 passed**, typecheck clean, lint 0 errors (3 pre-existing warnings), build OK.

### AC status

| AC | State |
|---|---|
| AC-1 — per-utterance stamp on every transcript, both paths | ✅ end to end |
| AC-2 — session-create echoes resolved pipeline + engine | ✅ (A2 here; consumed by TASK-614) |
| AC-3 / AC-4 — server-derived `activePipeline`, complete `provider_switched` | ✅ delivered under TASK-614 |
| AC-5 — no PHI/credential added | ✅ both projections remain allow-lists, guarded by test |

### Outstanding

**Runtime evidence (§3.7) is not captured** — the local stack was not running. Still owed: a live session showing (a) a no-`pipelineId` session reporting a real id from frame 0, (b) consecutive utterances carrying **different** ids across a mid-session switch, (c) a `created_on_fallback` session reporting the fallback id with no client-side inference. Until then this ticket stays `Review`, not `Completed`.

---

## 4b. ⚠️ Cross-ticket finding — the failure-driven auto-switch cannot arm from an ASR error — **FIXED under TASK-614 (D-11)**

> **Resolved 2026-08-06.** TASK-614 adopted this as its defect D-11 and fixed it: `process_utterance` now re-raises `SWITCHABLE_ASR_ERRORS` instead of degrading them to an empty transcript, so `record_failure` is reached and the automatic fallback arms. The analysis below is retained as the discovery record.

Surfaced by the Lane A3 agent while building the switch-retry test, then independently verified. **This is TASK-614's territory, not this ticket's — nothing was changed for it here.** It is recorded because TASK-614 is sitting at `Review` claiming this behaviour works, and because it materially weakens the value of per-utterance provenance (a switch that never fires produces no interesting provenance).

**The chain:**

1. `EngineSwitchController.record_failure(...)` is what arms the automatic, outage-driven switch.
2. It has exactly **one** production call site: `session_manager.py:2413`, inside the inference loop's `except` block.
3. That `except` can only fire if `inference_worker.process_utterance(...)` raises.
4. But `process_utterance` wraps the ASR call in a broad `except Exception` (`inference.py:348`) that converts **any** inference failure into an empty `_InferenceResult()` and returns normally.

**Consequence:** an ASR-layer failure — cloud auth rejection, quota exhaustion, model error, provider outage — is logged as `"Inference failed"`, yields an empty transcript, and **never reaches `record_failure`**. The consecutive-failure threshold never increments, so the automatic fallback never triggers. The session goes quiet instead of switching engines.

**Scope of the defect (be precise):** the `try` wraps only the embedding + ASR gather. Failures *after* it (sanitize, hallucination filter, dedup, punctuation, publish) still propagate and can arm the switch. So auto-switch is not entirely dead — but it is deaf to exactly the failure class it exists for.

**Not fixed here.** Recommended owner action: verify against TASK-614's AC for R2 before committing that ticket, and decide whether `process_utterance` should re-raise a classified ASR error (or return a failure sentinel the loop inspects) rather than swallowing it. A fix belongs in TASK-614 or a follow-up, with its own RED test driving a raising ASR callable through the real loop.

> **RESOLVED 2026-08-06 in TASK-614 (defect D-11, Lane A6)** — re-verified link by link, then fixed by re-raising the classified ASR failure classes (`SWITCHABLE_ASR_ERRORS`, published by `engine_switch.py`) ahead of `inference.py`'s broad handler. RED was observed first via `apps/stt/tests/unit/streaming/test_auto_switch_on_asr_failure_task614.py`, which drives a raising ASR callable through the real worker and the real inference loop. `process_partial` is deliberately unchanged. Nothing in this ticket's own lanes changed.

---

## 5. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-06 | Ticket created. STT live-transcription flow reviewed end-to-end (STT `SegmentResult` → Redis result stream → applications bridge → native + compat gateways → SDK store/hooks). Five divergences between requested and actual pipeline documented; the TASK-586 `active`/`is_fallback` relay gap confirmed still open. Plan drafted across 4 lanes; 3 owner decisions (OD-1..OD-3) raised. Status `Pending`. | Claude |
| 2026-08-06 | Plan reworked for multi-agent execution. **Correction:** the first draft named `session_manager.py` ~2286-2404 as the stamp site; the real seam is `StreamingInferenceWorker` (3 × `SegmentResult` construction sites) plus the in-place `_apply` swap at `session_manager.py:1150-1155` — §3.2 now specifies it concretely, including the switch-retry and crash-rehydrate paths the first draft missed. Added §3.3 frozen wire contract (prevents parallel-lane drift), §3.4 two-direction mixed-version requirement, §3.5 per-task tier/effort assignment with dependency graph, §3.6 execution protocol (RED-must-be-observed, worktree isolation, workspace-dist rebuild, escalate-don't-improvise). | Claude |
| 2026-08-06 | **Lane A1+A2 done (schema additions only, no stamping logic).** A1: `SegmentResult.pipeline_id: str \| None` added (`schemas.py`), emitted in `to_redis_dict()` only when set, round-tripped in `from_redis_dict()` — same conditional pattern as `language`. A2: `StreamingSessionResponse` gains required `pipeline_id: str` + `active_engine: str` (`api/schemas.py`); populated in both `create_streaming_session` and `get_streaming_session` (`api/routes.py`) via a new `_resolve_active_engine()` helper that reads the already-installed `EngineSwitchController` through the existing PUBLIC `SessionManager.get_switch_controller()` accessor — no changes to `session_manager.py`. This makes `active_engine` truthful today for the D3 (`start_on=fallback`) and D4 (`created_on_fallback`) cases (the controller's `active_engine` is flipped to `'fallback'` before `create_session` returns in both). **Known gap for A3:** `pipeline_id` in the create/status response is `session.pipeline_id`, which is the *requested* primary pipeline id (`SessionMetadata.pipeline_id`), not the *effective* one — in the D3/D4 fallback cases it still names the primary pipeline while `active_engine` correctly says `'fallback'`. A3 must either stamp `SessionMetadata`/the session object with the effective id at create (per §3.2 step 3's `effective_pipeline_id`) or expose the fallback pipeline id off the switch controller so routes.py can pick it when `active_engine == 'fallback'`. Because `StreamingSessionResponse` is shared by the GET status endpoint too, A2 also populated it there (2-line addition, same helper) and fixed 3 pre-existing tests whose ad-hoc session mocks lacked `.pipeline_id` — required once the field became non-optional; flagged since it goes slightly beyond the literal "populate them in create_streaming_session" instruction but was necessary to avoid breaking the GET endpoint. Tests: `pnpm stt:test` → 2727 passed, 49 skipped, 3 xfailed, 202 errors (all pre-existing `db_conn._engines` AttributeError in `tests/e2e/conftest.py`, confirmed present on a clean tree before any A1/A2 edit — unrelated to this change). Files: `apps/stt/src/stt/streaming/schemas.py`, `apps/stt/src/stt/streaming/api/schemas.py`, `apps/stt/src/stt/streaming/api/routes.py`, `apps/stt/tests/unit/test_streaming.py`, `apps/stt/tests/unit/test_streaming_api.py`, `apps/stt/tests/unit/streaming/test_language_modes_api.py`. | Claude |
| 2026-08-06 | **Resumed and completed; status → `Review`.** TASK-614 reached `Review`, unblocking this ticket. Contract re-verified against what 614 actually shipped — one drift found and adopted rather than fought: the status DTO ships `is_fallback` (snake), not the `isFallback` §3.3 originally specified; the transcript DTO stays camelCase, so `pipelineId` was correct. Lanes A3+A4 (the stamp seam, incl. the A2 effective-id gap), B1+C3+C4 (relay), and D (SDK) all landed with RED-first TDD. **A gap the plan did not anticipate:** the SDK lane's agent found `pipelineId` died at the `@arcaai/stt` transport hop — `StreamingBackendSTTProvider.normalizeTranscript` did not forward it, so nothing reached the store and no consumer of `audio.transcriptSegments` would ever see it. Closed here (`packages/stt` payload + result types + forward, `TranscriptSegment.pipelineId`, `useArcaAudio` segment builder) with its own RED-first test, including a mid-session-switch case and an old-backend degrade case. Gates: stt 2747 passed; applications stt/streaming 95/95 + build; apps/api 2367 passed; `@arcaai/stt` 443 passed + typecheck + build; `@arcaai/vox` 3963 passed + typecheck + lint 0 errors + build. Also surfaced §4b (auto-switch deaf to ASR errors), since fixed by 614 as its D-11. Remaining: runtime evidence (§3.7) and commit. | Claude |
| 2026-08-06 | **Execution HALTED after Lane A1+A2; status → `Blocked`.** Mid-execution, this ticket was re-scoped (blocked on TASK-614, Lane D1/D2/D4 struck) while TASK-614 went `In Progress` in a PARALLEL session on the same working tree. The overlap is direct, not adjacent: TASK-614 Lane A2 is the same task as this ticket's A2 (already satisfied by the landed work — consume it, do not redo it); its B1 ≡ this ticket's B2; its D1/D4 ≡ this ticket's D1/D2, same files and line ranges (`useArcaAudio.ts:858-860`, `:828-842`). Concurrency was observed live — `packages/agentic-sdk-v2/src/compat/__tests__/useArcaSttProvider.test.tsx` and `hooks/__tests__/useSttProviderToggle.test.ts` went from clean to modified between two `git status` calls seconds apart, i.e. the other session writing into Lane D's files. Continuing would have risked the mutual-clobber failure mode this repo has already suffered. Owner decision: halt 613, let 614's Lanes A–C land first. Landed A1/A2 work was **staged** (not committed) to protect it from concurrent-session loss. Resume condition: TASK-614 Lanes A–C merged, then restart at Lane A3 (the per-utterance stamp seam, §3.2) — re-verify §3.3's frozen contract against whatever 614 actually shipped before writing a line. | Claude |
