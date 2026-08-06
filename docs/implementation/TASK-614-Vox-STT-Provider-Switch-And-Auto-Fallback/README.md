# TASK-614 — Vox SDK: STT Provider Switching & Automatic Fallback

| Field | Value |
|---|---|
| **Status** | `Review` — all 8 steps implemented 2026-08-06 (D-11 found late and closed; see §4 Lane A6); runtime evidence + commit outstanding |
| **Type** | `bugfix` + `feature` |
| **Branch** | `dev-2.1` |
| **Created** | 2026-08-06 |
| **Related** | TASK-567 (STT fallback BYOK), TASK-586 (compat runtime provider switch), TASK-603/604 (batch transcription), TASK-613 (live-transcription pipeline provenance — overlapping, see §1.4) |

---

## 1. Requirement Analysis

### 1.1 Requirement (owner, verbatim)

> 1. to allow developers/engineers to develop a function for switching between selected audio speech-to-text pipeline and the default fallback STT provider
> 2. for automatically fallback to the default fallback STT provider, for handing errors/issues/exceptions when transcribing (applied for both live-transcription and batch-transcription)

### 1.2 Restatement

**R1 — Manual switch (developer-facing).** A developer consuming `@arcaai/vox` (native) or `@arcaai/vox/compat` (v1-migrated) can build a working control that moves a session between the **selected pipeline** and the **tenant-admin default fallback provider**, in both directions, before and during capture — and the SDK's reported state matches what the backend is actually running.

**R2 — Automatic fallback.** When transcription fails (credential, quota, model-load, inference error), the platform falls back to the tenant's default fallback provider **without the developer writing any code**, for **live** and **batch** alike, and tells the client that it happened.

Both requirements are already *designed* (TASK-567/586) and partially built. This ticket is predominantly **closing defects that make the built behaviour unreachable or invisible**, plus the small amount of new plumbing that was never wired.

### 1.3 Classification

`bugfix` for D-1…D-6, D-9, D-10; `feature` for D-7/D-8 (batch fallback provenance surfaced to the SDK) and the session-create echo.

### 1.4 Relationship to TASK-613

TASK-613 (Pending) covers **per-utterance pipeline provenance**. Two of its acceptance criteria are **hard prerequisites** for this ticket and are absorbed here:

| TASK-613 item | Why it moves into 614 |
|---|---|
| **AC-3** — `activePipeline` server-derived, non-null for every backend session | Without it, the switch API cannot tell "no session" from "session with unknown pipeline" — the root of the reported bug (D-2/D-5) |
| **AC-4** — relay `active` / `is_fallback` on `provider_switched` | Without it, a switch back to primary is reported as fallback, and auto-fallback is invisible (D-4) |

TASK-613 keeps the **per-frame** stamp (its Lanes A1–A4, A6, B1, C3, C4, D5, D6) and gains a dependency on this ticket. Its Lane D1/D2/D4 are struck and re-homed here. **OD-A: owner confirms this split** (alternative: merge 613 into 614 entirely).

### 1.5 Scope

**In scope**

- **AC-1** — A live session's provider switch reaches the backend in every case where a live backend session exists. The SDK never reports `switched` for a switch it did not perform.
- **AC-2** — `activePipeline` is derived from the session-create response (server truth), non-null for every backend streaming session, including one started with no `pipelineId`.
- **AC-3** — `provider_switched` reaches the client with `active` + `isFallback` intact; a switch back to primary un-latches correctly in both native and compat clients.
- **AC-4** — Batch transcription auto-falls back to the tenant default on cloud-ASR/model failure (the TASK-567 worker path becomes reachable in production).
- **AC-5** — A batch result states which pipeline produced it, including when the fallback did.
- **AC-6** — The tenant's `autoSwitchEnabled` setting actually governs live auto-switch.
- **AC-7** — Both SDK surfaces (`useSttProviderToggle`, `useArcaSttProvider`) expose one documented, symmetric switch API with typed failures; the compat playground exercises the real path end-to-end.

**Out of scope**

- Per-utterance pipeline stamping on transcript frames (TASK-613).
- Changing *which* pipeline is selected as the fallback, or the tenant STT config admin UI.
- Client-side blind session rebuild on an arbitrary pipeline id (see §3.5 — deliberately rejected).
- Batch *queue-level* retry policy beyond the single in-attempt fallback re-run that already exists.

---

## 2. Current State Evaluation

Verified against the working tree on `dev-2.1`, 2026-08-06.

### 2.1 What already works (do not rebuild)

| Capability | Where |
|---|---|
| Per-session engine-switch controller: one-way auto (`record_failure`), bidirectional manual (`switch_manual`), fail-closed selection, cooldown | `apps/stt/src/stt/streaming/engine_switch.py` |
| Auto-switch wired into the live inference loop, with a buffer handoff that re-runs the failed utterance on the new engine | `session_manager.py:2352-2400` |
| Create-time fallback when the primary ASR fails to load (`created_on_fallback`) | `session_manager.py:920-965, 1019-1024` |
| User-selected start-on-fallback (`start_on: 'fallback'`) | `session_manager.py:880-910` |
| Batch fallback re-run inside one Dramatiq attempt + `usedFallbackPipelineId` marker | `transcribe_file.py:317-336` |
| Compat switch route with tenant ownership (404-over-403) and fail-closed 409 | `stt-compat.controller.ts:176-222` |
| Native switch routes (`SWITCH_TO_FALLBACK`, `SWITCH_TO_PRIMARY`) | `transcription-job.controller.ts:585+`, `StreamingSessionManager.ts:316-347` |
| SDK already parses `active`/`is_fallback` when present | `PluginManager.ts:817-831` |

**The backend engine-switch machinery is sound.** Every defect below is a break in the wiring between it and the client, or a value that is never passed.

### 2.2 Defect inventory

| # | Defect | Evidence | Impact |
|---|---|---|---|
| **D-1** | Compat playground drops the configured `pipelineId`: `useAudioCapture` is mounted with no `options`, and it wins the start race, so `audio.start({pipelineId: undefined})` runs; the pipeline-bearing second start is discarded by call-time idempotence with an INFO log | `playground-session.tsx:569-575, 683-684`; `useAudioCapture.ts:220`; `useArcaAudio.ts:292-323` | Live sessions never carry the selected pipeline. "Pipeline (SDK-configured)" is a lie — the tenant default has been transcribing all along |
| **D-2** | `useArcaSttProvider.switchTo` treats `activePipeline == null` as "capture has not started", so a **mid-session** switch silently records a pre-start preference and reports `switchStatus: 'switched'` | `useArcaSttProvider.ts:160-170` | **The reported bug.** Toggle produces no HTTP call, no WS frame, no error |
| **D-3** | `useSttProviderToggle` (native) has the same false premise; it throws a bare `Error` rather than a typed `ErrorInfo` | `useSttProviderToggle.ts:80-84` | Native consumers get an unclassifiable failure in exactly the same situation |
| **D-4** | The applications bridge deliberately drops `active` / `is_fallback` from the status projection; the compat gateway's `isFallback` branch is therefore dead code | `streamingAudioBridge.service.ts:623-638`; `stt-compat.gateway.ts:236-239` | SDK falls back to "absent ⇒ `isFallback = true`" (`useArcaAudio.ts:830`), so a switch **back to primary** is reported as fallback. Observed in the wild — `quick-compat-app/src/components/ProviderSwitch.tsx:39-52` works around it by comparing pipeline ids |
| **D-5** | `activePipeline` is request-derived; `null` for the whole session when the client omits `pipelineId` | `useArcaAudio.ts:858-860` | Every downstream read degrades (`activeProvider: null`, `fallbackAvailable: false`); direct cause of D-2's trigger condition |
| **D-6** | The gateway never passes `fallback_pipeline_id` into the batch Dramatiq job — the positional args stop at `userId` and `kwargs` carries only `storage` | `transcriptionRealtime.service.ts:322-350`; `transcribe_file.py:41-53` | **Batch auto-fallback is dead code in production.** A cloud-ASR failure fails the job instead of falling back |
| **D-7** | `usedFallbackPipelineId` is written into the STT result metadata but never surfaces through the job result to the SDK | `transcribe_file.py:336` | No provenance: a batch transcript produced by the fallback is indistinguishable from one produced by the selected pipeline |
| **D-8** | The SDK batch queue hard-requires a `pipelineId` and has no notion of a fallback | `useArcaBatchTranscription.ts:368-373` | A developer cannot express "use the tenant default" for batch at all |
| **D-9** | `switchProvider`'s degraded rebuild path needs `opts.fallbackPipelineId`, which no caller supplies and no client can know (the server never returns it) | `useArcaAudio.ts:1409-1421`; compat caller passes only `useCompatEndpoint` (`useArcaSttProvider.ts:181`) | Dead branch; a backend without the in-place route surfaces a raw 404 |
| **D-10** | The tenant's `autoSwitchEnabled` setting is stored and resolved but never sent to STT; `EngineSwitchController` always constructs with its default `True` | `platform-limits.ts:96`, `stt-fallback.descriptors.ts:47` vs. `streamingSession.service.ts:95-117`, `engine_switch.py:80` | A tenant that disables auto-switch still gets auto-switch |
| **D-11** | **The failure-driven auto-switch could not arm from an ASR error.** `process_utterance` wrapped the embedding + ASR gather in a broad `except Exception` that converted ANY inference failure into an empty `_InferenceResult()` and returned normally | `inference.py:348` vs. its only consumer `session_manager.py:2406-2415` (the sole production call site of `record_failure`) | **R2 was unmet in its core case.** Cloud auth rejection, quota exhaustion, model error or provider outage was logged `"Inference failed"`, produced an empty transcript, and never reached `record_failure` — the consecutive-failure counter never incremented, so the session went **quiet instead of switching engines**. Precise scope: the `try` wrapped only embedding + ASR, so failures *after* it (sanitize, hallucination filter, dedup, punctuation, publish) did still propagate and could arm the switch — auto-switch was not entirely dead, but was deaf to exactly the failure class it exists for |

> **D-11 provenance.** Surfaced by TASK-613 (§4b of its README) while this ticket already sat at `Review` claiming R2 worked, then independently re-verified against the working tree before the fix below. It was invisible to the existing Lane A tests because `test_session_manager_auto_switch_task614.py` calls `ctrl.record_failure(...)` **by hand** — it never drives a failing ASR callable through the real worker, so the broken link between them was untested in both directions.

### 2.3 Why the reported symptom looked like "nothing happened"

D-1 → `activePipeline` is `null` → D-2's guard fires → pending pre-start pick recorded, `switchStatus: 'switched'` returned, **no call**. The UI then relabels it `pending` and prints "No live session yet — queued" mid-recording (`ProviderToggle.tsx:33-34`, 56-60). Three defects compounding into a silent success.

---

## 3. Implementation Plan

Layer order per `01-development-workflow.md`: **Python STT → applications → API gateway → SDK → playground**. TDD RED→GREEN→REFACTOR per lane; every lane's tests are listed before its changes.

### 3.1 Design decisions

**DD-1 — Fallback selection stays server-side.** The client never names a fallback pipeline. It asks for a *direction* (`primary` | `fallback`); the gateway/STT resolve which pipeline that is from tenant config. This preserves the existing tenancy posture (a pipeline id the client picks is a cross-tenant probe surface) and keeps one resolution path for manual, auto, create-time and batch fallback.

**DD-2 — The session-create response is the client's baseline.** `activePipeline` becomes server-derived from it. This is the single change that makes every downstream read honest, and it removes the "did the client send a pipelineId?" branch from four consumers.

**DD-3 — "No live session" is decided by `isCapturing`, not by `activePipeline`.** The pre-start-preference path stays (it is the documented TASK-586 behaviour) but is gated correctly. With capture live, a switch either happens or rejects with a typed error — never a silent success.

**DD-4 — Batch fallback stays a single in-attempt re-run.** Dramatiq retry semantics are unchanged; we only supply the id the worker has always accepted.

**DD-5 — Rejected: client-side rebuild-on-fallback.** Tearing the session down and reopening it on a client-supplied fallback id would require exposing tenant pipeline ids to the browser and would duplicate selection logic. D-9's dead branch is removed rather than fed. If a backend genuinely lacks the in-place route, the switch fails loudly (typed `SWITCH_UNSUPPORTED`).

### 3.2 Lane A — STT service (`apps/stt`)

| # | Test (RED first) | Change |
|---|---|---|
| A1 | `create_session(auto_switch_enabled=False)` builds a controller that does **not** auto-switch on repeated failures | Accept `auto_switch_enabled: bool = True` on the create payload; pass to `_make_switch_controller` |
| A2 | `POST /internal/streaming/sessions` response carries `pipeline_id` (resolved) + `active_engine` (`primary`\|`fallback`) | Widen `StreamingSessionResponse` (`api/schemas.py:100-107`); populate from the created session + switch controller |
| A3 | A session created via the load-failure fallback path reports `active_engine: 'fallback'` in that response | Covers create-time fallback (`created_on_fallback`) |
| A4 | A session created with `start_on='fallback'` reports `active_engine: 'fallback'` | Covers the user-selected path |
| A5 | `transcribe_file` with `fallback_pipeline_id` supplied as a **kwarg** falls back and stamps `usedFallbackPipelineId` (regression lock on the existing behaviour, now reachable) | None — proves the worker contract the gateway will target |
| **A6** | **A raising ASR callable driven through the REAL inference worker + REAL inference loop arms the switch** (D-11): auth error → immediate switch; threshold-class errors → switch on the Nth; a non-ASR failure still degrades to an empty result; `autoSwitchEnabled: false` still suppresses it | `inference.py` re-raises the switch-relevant ASR failure classes instead of swallowing them; `engine_switch.py` publishes the class tuple |

> No change to `engine_switch.py`'s transition **logic**. It is correct — the defect was that nothing ever called it (A6/D-11).

### 3.3 Lane B — Applications (`packages/applications`)

| # | Test | Change |
|---|---|---|
| B1 | Status projection forwards `active` + `isFallback` when present, omits when absent | `streamingAudioBridge.service.ts:627-638` — closes the gap its own comment names; update the comment |
| B2 | Projection remains an allow-list — a novel upstream field is still dropped | PHI-posture regression guard |
| B3 | `StreamingStatusMessage` DTO carries `active` / `is_fallback` | `dto/streaming-session.dto.ts` |
| B4 | `createSession` sends `auto_switch_enabled` from the resolved tenant config | `streamingSession.service.ts:95-117` + `StreamingSessionDto` |
| B5 | `createSession` response maps `pipelineId` + `activeEngine` | `streamingSession.service.ts:128-140` |
| B6 | `dispatchDramatiqJob` includes `fallback_pipeline_id` in `kwargs` when supplied; omits the key entirely when not | `transcriptionRealtime.service.ts:312-350` (kwarg, not a positional arg — positional insertion would silently shift `storage`) |
| B7 | `createAndStream` resolves and forwards the tenant fallback | `transcriptionRealtime.service.ts:48-92` |
| B8 | A completed batch job's result exposes `usedFallbackPipelineId` when the fallback ran | Job-result mapping + `TranscriptionJobResponse` DTO |

### 3.4 Lane C — API gateway (`apps/api`)

| # | Test | Change |
|---|---|---|
| C1 | Native `POST /audio/transcription-jobs/stream/session` response includes `pipelineId` + `activeEngine` | `transcription-job.controller.ts:483-493` + DTO |
| C2 | Compat `POST /api/stt/start_session` response includes `pipeline_id` + `active_engine` (additive; v1 clients ignore unknown keys) | `stt-compat.controller.ts:82-149`, `dto/start-session.response.ts` |
| C3 | Both create paths forward the tenant's `autoSwitchEnabled` | Both controllers' `resolveSttFallbackConfig` (`:176-190` / `:253-266`) return it |
| C4 | Batch job creation resolves `fallbackPipelineId` from tenant STT config and passes it to dispatch | `transcription-job.controller.ts:60-86` (`dispatchBatchJob` params) |
| C5 | Compat `status` frame emits `isFallback` in **both** directions (the dead branch goes live once B1 lands) | `stt-compat.gateway.ts:236-239` — assert, no code change expected |
| C6 | Native WS relays `active`/`isFallback` untouched | `stt-ws.gateway.ts:567-592` |
| C7 | Cross-tenant probe of a foreign session still 404s; a fallback switch with no fallback configured still 409s | Existing posture regression |

### 3.5 Lane D — SDK (`packages/agentic-sdk-v2`) — the core of R1

| # | Test | Change |
|---|---|---|
| D1 | `activePipeline` is set from the **session-create response**, not `options.pipelineId` | `useArcaAudio.ts:858-860` |
| D2 | A session started with **no** `pipelineId` yields a non-null `activePipeline` | Closes D-5 |
| D3 | A `created_on_fallback` / `start_on:'fallback'` session reports `isFallback: true` from frame 0 | Uses `active_engine` from A2 |
| D4 | `onProviderSwitched` uses the real `isFallback`; the "absent ⇒ true" guess is removed | `useArcaAudio.ts:828-842` |
| D5 | **`isCapturing: true` + `activePipeline: null` → `switchTo` performs the live switch** (the missing test; today it silently no-ops) | `useArcaSttProvider.ts:158-193`, `useSttProviderToggle.ts:78-103` |
| D6 | `isCapturing: false` → still records the pre-start preference and resolves (TASK-586 behaviour preserved) | Same |
| D7 | `isCapturing: true` with no reachable streaming session → **rejects** with a typed `ErrorInfo` (`SWITCH_UNSUPPORTED`), never `'switched'` | Same |
| D8 | Both hooks expose an identical, symmetric surface; compat keeps `switchToFallback` as an alias | API-shape contract test |
| D9 | The dead `fallbackPipelineId` rebuild branch is removed; a 404 from the switch route surfaces as `SWITCH_UNSUPPORTED` | `useArcaAudio.ts:1399-1425` |
| D10 | Batch: an item whose job fell back exposes `usedFallbackPipelineId` and fires `onFallbackUsed` | `useArcaBatchTranscription.ts`, `BatchTranscriptionQueue` |
| D11 | Batch: `pipelineId` becomes optional — omitted means "tenant default", and the gateway resolves it | `useArcaBatchTranscription.ts:368-373` (closes D-8) |
| D12 | Mixed-version degrade: an older backend (no `pipeline_id`/`active_engine` in the create response) falls back to today's request-derived behaviour without throwing | Backward-compat guard for §3.6 |

### 3.6 Lane E — Compat playground + docs

| # | Test | Change |
|---|---|---|
| E1 | The playground's capture hook carries the configured pipeline id (unit test on the session provider) | `playground-session.tsx:569-575` — pass `options: { sttPipelineId: config.pipelineId.trim() \|\| undefined }` |
| E2 | `ProviderToggle` shows "queued" only when capture is genuinely not running | `ProviderToggle.tsx:33-34` — derive `isPreSession` from capture state, not from `activeProvider == null` |
| E3 | `quick-compat-app`'s id-comparison workaround is reverted to the `isFallback` read once D-4/B1 land | `ProviderSwitch.tsx:39-52` (+ remove the WHY comment, which documents a bug that no longer exists) |
| E4 | Docs updated: switch API, auto-fallback semantics, batch fallback | `packages/agentic-sdk-v2/docs/Compat-API-Reference.md`, package README |

### 3.7 Backward compatibility

Every wire change is **additive**: new optional fields on two create responses and on the status frame; a new Dramatiq **kwarg** (never a positional-arg insertion — that would shift `storage`). An older SDK against a new backend ignores the extras; a new SDK against an older backend sees `undefined` and degrades to today's request-derived behaviour (D12).

### 3.8 Verification criteria (Phase 5)

- [ ] `pnpm stt:test` green (Lane A)
- [ ] `pnpm --filter @arcaai/applications test build` green (Lane B)
- [ ] `pnpm test:unit` + `pnpm test:e2e` green (Lane C)
- [ ] `pnpm --filter @arcaai/vox build test lint typecheck` green (Lane D)
- [ ] `pnpm --filter @arcaai/compat-playground build test` green (Lane E)
- [ ] `pnpm lint:all` / `pnpm typecheck:all` clean
- [ ] **Runtime evidence (live)** — compat playground: (a) toggle OFF mid-session produces a `POST /api/stt/switch` and a `provider_switched` frame; (b) toggle back ON un-latches (badge returns to the pipeline side); (c) a session started with no `pipelineId` still reports a real active pipeline
- [ ] **Runtime evidence (auto)** — force a primary-ASR failure (bad BYO key) and capture the auto `provider_switched` with `reason: 'auto'`
- [ ] **Runtime evidence (batch)** — a batch job on a failing primary completes on the fallback and the SDK item shows `usedFallbackPipelineId`
- [ ] No credential or PHI field added to any relayed frame (re-read both projections)

### 3.9 Owner decisions — RESOLVED 2026-08-06

1. **OD-A — TASK-613 split.** ✅ **Absorb** 613's AC-3/AC-4 into this ticket. TASK-613 keeps per-utterance frame stamping (its Lanes A1–A4, A6, B1, C3–C4, D5–D6) and gains a dependency on 614; its Lane D1/D2/D4 are struck and re-homed here.
2. **OD-B — Batch "tenant default" (D-8/D11).** ✅ **Make `pipelineId` optional** for batch. The gateway resolves `effective.defaultPipelineId ?? effective.fallbackPipelineId`; if neither exists → 409 with an explicit message. D11 stays in scope.
3. **OD-C — Expose `fallbackPipelineId` to the client?** ✅ **No.** Confirmed under DD-1/DD-5 — the client asks for a direction, never names a pipeline.

### 3.10 Sequencing — AGREED

**Lane E1 lands FIRST** as an immediate mitigation: it restores the configured pipeline id on the live session, which makes `activePipeline` non-null and the mid-session toggle reach the backend today, before the deeper fixes.

Caveat to record: with E1 alone, **switching OFF works but switching back ON still misreports**. D-4 (the bridge dropping `active`/`is_fallback`) makes the SDK assume `isFallback = true` on every `provider_switched` frame, so the primary direction does not un-latch until B1 + D4 land. E1 is a mitigation, not the fix.

After E1: lanes A→B→C are a dependency chain (the SDK cannot read fields the backend does not send). Lane D1 depends on A2/B5/C1–C2; D5–D9 (the reported bug, fixed properly) depends on D1–D4.

---

## 4. Implementation Summary

### Lane E1 — playground carries the pipeline id to the STARTING hook ✅

**Defect closed:** D-1.

| File | Change |
|---|---|
| `apps/compat-playground/src/context/playground-session.tsx:569-576` | `useAudioCapture` now receives `options: { sttPipelineId: config.pipelineId.trim() \|\| undefined }` |
| `apps/compat-playground/src/context/__tests__/playground-session.pipelineId.task614.test.tsx` | New — 4 tests asserting the id reaches the hook that STARTS capture (not only the STT hook, which passed throughout the defect) |

Evidence:

```
RED   → 2 failed | 220 passed — expected 'pipeline-abc', received undefined
GREEN → Test Files 21 passed (21) · Tests 222 passed (222)
typecheck (tsc --noEmit) — clean
lint (eslint src --max-warnings 0) — clean
```

**Runtime evidence: PENDING.** The dev stack was not running (`:8868` and `:8861` both refused). The live checks in §3.8 (switch produces `POST /api/stt/switch`; a no-`pipelineId` session reports a real pipeline) need `pnpm stack:dev` plus a tenant with a configured fallback pipeline. To be captured before closure.

**Known remaining limitation after E1:** switching OFF now reaches the backend, but switching back ON still misreports — D-4 keeps `active`/`is_fallback` off the wire, so the SDK's "absent ⇒ fallback" guess never un-latches. Closed by lanes B1 + D4.

### Lane D5–D7 — a switch is gated on capture, not on `activePipeline` ✅

**Defects closed:** D-2 (the reported bug, properly), D-3.

| File | Change |
|---|---|
| `packages/agentic-sdk-v2/src/compat/useArcaSttProvider.ts:166-196` | Pre-start branch now keys off `audio.isCapturing`. The idempotence shortcut runs only when `activePipeline` is known; otherwise the backend adjudicates. Header doc corrected |
| `packages/agentic-sdk-v2/src/compat/useArcaSttProvider.ts:93-111` | `switchFailedError` classifies "no active streaming session" as `SWITCH_UNSUPPORTED` / `configuration`, distinct from a backend refusal |
| `packages/agentic-sdk-v2/src/hooks/useSttProviderToggle.ts:78-100` | Same gating; rejects with `AgenticError('SWITCH_UNSUPPORTED')` before capture instead of a bare `Error`. Header doc corrected |
| `packages/agentic-sdk-v2/src/types/common.ts:93` | New `AgenticErrorCode` member `SWITCH_UNSUPPORTED` |
| `…/compat/__tests__/useArcaSttProvider.test.tsx` | +4 tests: mid-session switch with unknown pipeline (both directions), typed rejection, pre-start preference preserved |
| `…/hooks/__tests__/useSttProviderToggle.test.ts:120-150` | **Contract change** — the old "rejects when there is no live streaming session" test asserted the defective premise; replaced with capture-based gating + typed rejection |

The invariant now enforced by test: **the hook never reports `switched` for a switch it did not perform.**

Evidence:

```
RED   → 3 failed | 8 passed (compat) · native suite failed on the replaced contract
GREEN → Test Files 245 passed (245) · Tests 3939 passed (3939)
typecheck (tsc --noEmit) — clean
lint — 0 errors, 3 warnings (all pre-existing, in useArcaConfig.ts / AgenticProvider.tsx — untouched)
build — ESM+CJS+dts OK; dist rebuilt so the playground consumes the fix
compat-playground re-run against the rebuilt SDK — 222 passed (222)
```

### Lane B1–B3 + D4 — the switch direction is relayed, not guessed ✅

**Defect closed:** D-4.

| File | Change |
|---|---|
| `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts:623-651` | `buildStatusMessage` now relays `active` and `is_fallback`. `is_fallback` is **coerced to a real boolean** — the wire carries `'1'`/`'0'` strings and every consumer types it `boolean`; relaying the raw `'0'` would be worse than dropping it (truthy in JS). The stale "deliberately NOT relayed" comment is replaced |
| `…/streaming/dto/streaming-session.dto.ts:211-235` | `StreamingStatusMessage` gains `active?: 'primary' \| 'fallback'` and `is_fallback?: boolean` |
| `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:820-855` | The `onProviderSwitched` direction is now resolved in descending order of certainty: `isFallback` → `active` → **pipeline-id comparison against the requested pipeline** → (last resort) `true`. The blind "absent ⇒ fallback" guess is gone |
| `…/streaming/__tests__/streamingAudioBridge.service.test.ts:594-655` | +4 tests: both directions relayed, pre-586 backend omits both, allow-list still drops a novel field (PHI posture) |
| `…/hooks/__tests__/useArcaAudio.providerSwitch.task567.test.ts:242-280` | +2 tests: explicit primary frame un-latches; legacy frame with neither field infers from the pipeline id |

The pipeline-id inference (step 3) is what `apps/quick-compat-app/src/components/ProviderSwitch.tsx` had to hand-roll in app code. It now lives in the SDK, so E3 can delete that workaround.

Evidence:

```
RED   → bridge 2 failed | 68 passed · SDK 1 failed | 12 passed
GREEN → applications bridge suite 70 passed (70)
        vox full suite 245 files / 3941 tests passed
applications build (tsc) — clean
applications lint — 0 errors; no warnings in either touched file (prettier fix applied)
```

**Scope change — D9 withdrawn.** The plan called for deleting `switchProvider`'s degraded rebuild branch as dead code. It is not dead: `switchToFallback(fallbackPipelineId)` is a *native* public API and a native consumer that knows its fallback id can legitimately use it (it has passing coverage at `useArcaAudio.providerSwitch.task567.test.ts:268`). Deleting a working, tested public path is outside this ticket's requirement. It stays; the compat layer simply does not use it.

### Lane A5 + B6 + C4 + D10 — batch auto-fallback is dispatched, and says so ✅

**Defects closed:** D-6, D-7.

Requirement 2's batch half. `transcribe_file.py:317-336` has implemented the fallback re-run since TASK-567, but **nothing ever supplied `fallback_pipeline_id`**, so the branch was unreachable in production: a failing primary ASR simply failed the job.

| File | Change |
|---|---|
| `apps/api/src/modules/streaming/transcription-job.controller.ts:309-331` | `transcribeFile` resolves the tenant fallback via the existing `resolveSttFallbackConfig` and passes it to dispatch. **Fail-open** — a broken tenant STT config must never block a transcription (same posture as the streaming path) |
| `…/transcription-job.controller.ts:71-84` | `dispatchBatchJob` params gain `fallbackPipelineId` |
| `packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts:322-366` | Sent as a Dramatiq **kwarg**, next to `storage`. Positional append was rejected: the actor tail is `(…, user_id, storage, fallback_pipeline_id)`, so it would force emitting the `storage` slot and would silently shift on any future insertion |
| `…/realtime/ITranscriptionRealtimeService.ts:62-64` | Interface widened |
| `packages/agentic-sdk-v2/src/compat/useArcaBatchTranscription.ts` | `BatchQueueItem.usedFallbackPipelineId` — read from `job.resultMetadata.metadata.usedFallbackPipelineId` through a fully guarded accessor (two untyped pass-through levels; a shape change must degrade to "none recorded", never throw) |
| `apps/stt/tests/unit/test_transcribe_file_fallback_task567.py` | +3 **cross-language contract** tests: the actor is invoked with the exact 10 positional args + kwargs the gateway emits. A renamed kwarg or changed positional count is how this feature stayed dead for a whole ticket cycle |
| `…/realtime/__tests__/transcriptionRealtime.service.test.ts` | +3 tests (kwarg present / omitted / alongside `storage`; positional args asserted unchanged) |
| `…/streaming/__tests__/transcription-job.stt-fallback.controller.test.ts` | +3 tests (forwarded / omitted / fail-open) |
| `…/compat/__tests__/useArcaBatchTranscription.test.ts` | +2 tests (fallback surfaced / null on the normal path) |

Evidence:

```
RED   → api 1 failed | 17 passed · applications 2 failed | 52 passed · vox batch 2 failed | 14 passed
GREEN → apps/api streaming            248 passed (8 files)
        applications realtime          54 passed · bridge 70 passed
        vox full suite                3943 passed (245 files) · typecheck clean
        apps/stt batch fallback         7 passed
        api build (turbo, 8 tasks)     successful
        applications build (tsc)       clean
```

> **A5 is a characterization lock, not a RED→GREEN fix.** The worker already bound the kwarg correctly, so those three tests passed on first run. They exist to keep the wire contract from drifting — stated plainly rather than presented as a fix.

### Lane A1 + B4 + C3 — the tenant's auto-switch governance reaches STT ✅

**Defect closed:** D-10.

`autoSwitchEnabled` and `consecutiveFailureThreshold` are stored on `TenantSttConfig`, resolved by `resolveEffectiveSttConfig`, and returned by the effective-config API — and then dropped at the gateway. `EngineSwitchController` always built with its own defaults, so **a tenant that disabled auto-fallback still got it**, and a raised failure threshold was ignored.

| File | Change |
|---|---|
| `apps/stt/src/stt/streaming/session_manager.py` | `create_session` + `_make_switch_controller` accept both; `None` ⇒ the controller's own default, so an older gateway is byte-identical |
| `apps/stt/src/stt/streaming/api/{schemas,routes}.py` | Request fields (`consecutive_failure_threshold` carries `ge=1`) and forwarding |
| `packages/applications/.../streamingSession.service.ts` + `dto/streaming-session.dto.ts` | Sent as `auto_switch_enabled` / `consecutive_failure_threshold`, `?? null` (**not** a truthiness guard — `false` is the whole point) |
| `apps/api/.../transcription-job.controller.ts`, `.../stt-compat.controller.ts` | Both `resolveSttFallbackConfig` helpers return the governance; both payloads spread on `!== undefined` |
| `apps/stt/tests/unit/streaming/test_session_manager_auto_switch_task614.py` | New — 3 tests driving REAL failures through the REAL controller (asserts behaviour, not a passed argument) |
| `…/streamingSession.service.test.ts`, `…/transcription-job.stt-fallback.controller.test.ts` | +5 tests incl. explicit-`true` and fail-open cases |

### Lane A2–A4 + B5 + C1–C2 + D1–D3 + D12 — `activePipeline` is server-derived ✅

**Defect closed:** D-5 (and TASK-613's AC-2/AC-3).

| File | Change |
|---|---|
| `apps/stt/src/stt/streaming/api/{schemas,routes}.py` | *(from the parallel session — reviewed and verified)* `StreamingSessionResponse` echoes `pipeline_id` + `active_engine`, the latter read from the per-session `EngineSwitchController`, so it is truthful for `start_on='fallback'` **and** the create-time load-failure path |
| `packages/applications/.../streamingSession.service.ts` + DTO | Maps both into `StreamingSessionStatus`; `undefined` against an older STT |
| `apps/api/.../transcription-job.controller.ts` + `dto/transcription-job.dto.ts` | Native create response carries `pipelineId` / `activeEngine`, spread only when present |
| `apps/api/.../stt-compat.controller.ts` + `dto/start-session.response.ts` | Compat `start_session` echoes `pipeline_id` / `active_engine` — additive; v1 clients ignore unknown keys |
| `packages/agentic-sdk-v2/src/core/PluginManager.ts` | New `onStreamingSessionCreated` callback, fed from `sessionManager.onSessionCreated`; stays silent when the gateway echoes nothing |
| `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` | `serverPipelineRef` filled during `initialize()`; `setActivePipeline` prefers it and falls back to the request-derived value. Cleared on both start and stop so a previous session's engine can never leak forward |
| `packages/agentic-sdk-v2/src/types/stt.ts` | `StreamingSessionResponse` gains both optional fields |
| tests | +4 in `useArcaAudio.providerSwitch.task567.test.ts` (resolved-over-requested, **non-null for a no-pipelineId session**, `isFallback` from frame 0, mixed-version degrade), +2 in `PluginManager.providerSwitchWiring.task567.test.ts`, +2 in `streamingSession.service.test.ts`, +2 in the gateway suite |

One test-double fix: `PluginManager.providerSwitchWiring`'s `StreamingSessionManager` mock lacked `onSessionCreated`. The real class always has it, so the **double** was wrong — corrected there rather than defensively optional-chaining production code for an impossible case.

Evidence (steps 5 + 6):

```
vox            3949 passed (245 files) · typecheck clean · lint 0 errors (3 pre-existing warnings) · build OK
applications   stt streaming + realtime 223 passed · build (tsc) clean
apps/api       streaming + stt-compat 288 passed · build (turbo, 8 tasks) successful
apps/stt       unit 2698 passed · ruff clean on touched files · black formatted
compat-playground  222 passed (21 files)
```

**Pre-existing, not introduced here:** `apps/stt` e2e has 202 collection errors (`stt.core.database.connection has no attribute '_engines'` — an unmodified file); `apps/stt/tests/unit/test_dockerfile_pywhispercpp_build.py` has 1 ruff import-order error; `apps/api` has 4 prettier errors in committed `smr-compat/summary-schemas.ts`; the applications `SECRETS_PROVIDER=vault` failures described above.

### Lane D11 + E2–E4 — batch tenant-default, playground/docs ✅

**Defect closed:** D-8. Completes AC-7.

| File | Change |
|---|---|
| `apps/api/.../transcription-job.controller.ts` + `dto/transcription-job.dto.ts` | `TranscribeFileRequest.pipelineId` is OPTIONAL. New `resolveDefaultPipelineId`: tenant-default pipeline → configured STT fallback → **409 with an actionable message**. It never guesses (`pipelines[0]` would make the engine depend on row order) |
| `packages/agentic-sdk-v2/src/compat/useArcaBatchTranscription.ts` | No longer fails an upload client-side for a missing pipeline; omits the field rather than sending an empty one (the gateway validates it as slug/UUID) |
| `packages/agentic-sdk-v2/src/core/FileTranscriptionService.ts` | `FileTranscribeOptions.pipelineId` optional; the form field is appended only when supplied; `normalizeJobResponse` tolerates its absence |
| `apps/compat-playground/src/components/ProviderToggle.tsx` | "Pre-session" now means `capture.phase === 'idle'`, from the console's own session context — it used to mean `activeProvider === null`, so the card announced "no live session yet — queued" mid-recording |
| `apps/quick-compat-app/src/components/ProviderSwitch.tsx` | The hand-rolled pipeline-id comparison and its WHY comment are **deleted** — the SDK now does that inference. The `pipelineId` prop became orphaned and was removed (with its call site in `LiveTranscription.tsx`) |
| `packages/agentic-sdk-v2/docs/{Compat-API-Reference,Batch-Transcription-Reference}.md` | Switch semantics (capture-gated, `SWITCH_UNSUPPORTED`, read-not-guessed direction, server-derived `activePipeline`), a new **Automatic fallback** section, optional batch `pipelineId`, and `usedFallbackPipelineId` on `BatchQueueItem` |

**Contract change, deliberate:** `useArcaBatchTranscription`'s test "fails the item with an actionable error when no pipeline is resolvable" asserted client-side refusal of a request the backend can serve. Replaced — deciding that in the SDK, with no knowledge of the tenant's configuration, was overreach.

Evidence:

```
vox                 3950 passed (245 files) · typecheck clean · lint 0 errors · build OK
apps/api            streaming + stt-compat 292 passed (11 files) · build (8 tasks) OK
applications        stt streaming + realtime 223 passed · build (tsc) clean
apps/stt            unit 2698 passed
compat-playground   223 passed (21 files) · typecheck + lint clean
quick-compat-app    tsc --noEmit clean
```

### Lane A6 — the auto-switch can finally arm from an ASR error ✅

**D-11 closed.** The one link that made R2 ("automatically fallback … for handling errors/issues/exceptions when transcribing") true in its core case was missing: nothing could ever call `record_failure` for an ASR-layer failure.

**RED first, and observed.** New suite `apps/stt/tests/unit/streaming/test_auto_switch_on_asr_failure_task614.py` builds a REAL `StreamingInferenceWorker` around an ASR callable that raises, registers it where the switch controller's `_apply` closure looks for it, and drives utterances through the REAL `SessionManager._start_inference_loop`. 4 of 6 failed on the unfixed tree; the captured log is the defect verbatim:

```
[error] Inference failed          error='401 invalid key' session_id=s1 utterance_index=0
[info ] Utterance transcribed     text_len=0 is_final=True session_id=s1 utterance_index=0
→ assert ctrl.switched is True  ... AssertionError: assert False is True
```

The 2 that passed are deliberate regression locks on behaviour the fix must NOT change (non-ASR failure still degrades to empty; a tenant with `autoSwitchEnabled: false` still gets no switch).

**The change (2 files, surgical).**

| File | Change |
|---|---|
| `apps/stt/src/stt/streaming/engine_switch.py` | Publish `SWITCHABLE_ASR_ERRORS = _IMMEDIATE_SWITCH_ERRORS + _THRESHOLD_SWITCH_ERRORS`. **Single source of truth** — the same tuple that decides `_classify` now decides what propagates, so a class added to one and hand-copied into the other cannot silently re-open D-11 |
| `apps/stt/src/stt/streaming/inference.py` | A narrower `except SWITCHABLE_ASR_ERRORS` placed **before** the existing broad handler: log with `error_type`, then `raise`. Everything else keeps today's degrade-to-empty path, unchanged |

**Design decision — DD-6: re-raise the classified class, do not add a sentinel.** The inference loop's `except` already does the right thing with a raised failure (classify → maybe swap → re-run the utterance on the new engine → keep the session alive), so a failure sentinel would have meant a second, parallel error protocol for no gain. Re-raising *only* the switch-relevant classes keeps the blast radius at exactly the failures a swap can fix.

**Blast radius (checked, not assumed).** For a propagated failure that does *not* trigger a switch (below threshold / no fallback configured / auto-switch off) the loop logs `"Background inference failed"` and that utterance yields no `SegmentResult`. The only behaviour lost versus before is `session.add_result()` of an **empty** final — `ResultPublisher.publish()` already drops empty-text results (`redis_streams.py:434`), so **nothing that used to reach a client stops reaching it**, and an empty segment contributes nothing to the assembled transcript. The `finally` block still sets the partial gate, so partial emission is untouched.

**Deliberately NOT changed: `process_partial`.** It carries the same swallow (`inference.py:1101`), but its caller `_run_partial` (`session_manager.py:2630`) swallows everything and never consults the switch controller — so re-raising there would arm nothing while risking the partial path. Finals are the switch's signal; partials on a dead engine are silent either way, and the next final arms the switch.

**Evidence.**

```
apps/stt/tests/unit/streaming/test_auto_switch_on_asr_failure_task614.py  6 passed
apps/stt/tests/unit                                                       2718 passed
apps/stt/tests/  (pnpm stt:test gate)  2753 passed · 49 skipped · 3 xfailed · 202 errors
                                       (202 = the documented pre-existing e2e conftest
                                        db_conn._engines errors, unchanged in count)
ruff check inference.py engine_switch.py + the new test    All checks passed!
mypy       inference.py engine_switch.py                   Success: no issues found
```

---

## Status: all 8 steps complete; runtime evidence outstanding

Every defect D-1…D-11 is closed. What remains before this ticket can move past `Review`:

- **Runtime evidence (§3.8)** — the stack was down for this whole session (`:8868`, `:8861` refused). Needs `pnpm stack:dev` plus a tenant with a configured fallback pipeline to capture: a real `POST /api/stt/switch` on toggle, an un-latching switch back, an auto `provider_switched` with `reason: 'auto'`, a batch job falling back, and a no-`pipelineId` session reporting a real pipeline.
- **Commit** — everything is uncommitted on `dev-2.1`.

### ⚠️ Concurrent work detected in `apps/stt` (2026-08-06) — RESOLVED

While running Lane B, the working tree showed **staged changes to `apps/stt` that this session did not make**:

```
apps/stt/src/stt/streaming/api/schemas.py   — StreamingSessionResponse gains pipeline_id + active_engine
apps/stt/src/stt/streaming/api/routes.py    — populated from the created session
apps/stt/src/stt/streaming/schemas.py       — SegmentResult widened
apps/stt/tests/unit/{test_streaming,test_streaming_api,streaming/test_language_modes_api}.py
```

That is **exactly Lane A2/A3/A4 of this ticket** (and TASK-613 Lane A).

**Resolution (owner decision, 2026-08-06):** this ticket takes the work over. The staged changes were reviewed against Lane A2's criteria and verified green (137 tests) before anything was built on them; `_resolve_active_engine` correctly reads the per-session `EngineSwitchController`, so `active_engine` is truthful for both create-time fallback paths. They are retained as-is and are now part of this ticket's Lane A. TASK-613's memory index already records that session as halted.

### Pre-existing suite failure (not caused by this ticket)

`pnpm --filter @arcaai/applications test` reports **363 failures**, all in `src/services/consultation/context/**`, all with:

> `ContextItem content field encryption is required (SECRETS_PROVIDER=vault) but no SecretsService is available`

`.env.test:2249` sets `SECRETS_PROVIDER=vault`, and those suites construct `ContextService` without a `SecretsService`. Environmental and pre-existing — unrelated to the STT streaming files touched here (whose suite is 70/70). Flagged for the owner; **not** fixed under this ticket.

### Revised lane order (after E1)

The plan's A→B→C→D chain is a *data* dependency, not a work order. Re-sequenced to front-load user-visible correctness — each step below is self-contained:

| Order | Work | Depends on |
|---|---|---|
| 1 ✅ | E1 — playground pipeline id | — |
| 2 ✅ | **D5–D7** — gate the switch on `isCapturing`, typed rejection (the reported defect, fixed properly) | — (SDK only) |
| 3 ✅ | **B1–B3 + D4** — relay `active`/`is_fallback`, drop the SDK guess (C5–C6 are gateway assertions, still to add) | — (STT already publishes them) |
| 4 ✅ | **A5 + B6 + C4 + D10** — batch auto-fallback dispatch + provenance | — |
| 5 ✅ | **A1 + B4 + C3** — `autoSwitchEnabled` reaches STT | A1 |
| 6 ✅ | **A2–A4 + B5 + C1–C2 + D1–D3 + D12** — server-derived `activePipeline` | A2 |
| 7 ✅ | **D11 + E2–E4** — batch tenant-default, playground/doc polish | 4, 6 |

**Owner decisions 2026-08-06 (round 2):** take over the parallel session's staged `apps/stt` work and build on it (steps 5–6 unblocked); continue with step 4 first. Both applied.

---

## 5. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-06 | **D-11 found and closed (Lane A6)** — the failure-driven auto-switch could not arm from an ASR error, so R2 was unmet in its core case while this ticket sat at `Review` claiming otherwise. Reported by TASK-613 §4b, re-verified link by link here: `record_failure` has one production call site (the inference loop's `except`), which only fires if `process_utterance` raises, which it never did for an ASR failure — `inference.py:348` converted every one into an empty `_InferenceResult()`. RED observed first (4/6 of a new suite that drives a raising ASR callable through the real worker + real loop; the 2 passing are regression locks). Fix: `engine_switch.py` publishes `SWITCHABLE_ASR_ERRORS` as the single source of truth, and `inference.py` re-raises exactly those before its broad handler (DD-6 — no sentinel; the loop's existing handler already classifies, swaps and re-runs). `process_partial` deliberately unchanged (its caller consults no controller). Blast radius verified: the only lost behaviour is `add_result` of an empty final, which `publish()` already dropped. Gates: 6 new passed · `apps/stt/tests/unit` 2718 passed · full suite 2753 passed with only the documented pre-existing 202 e2e conftest errors · ruff + mypy clean. | Claude |
| 2026-08-06 | Step 7 (D11 + E2–E4) implemented — D-8 closed. Batch `pipelineId` optional with server-side default resolution; playground toggle gated on capture; the quick-compat-app workaround deleted now the SDK owns that inference; SDK docs updated. All 10 defects closed; status `Review`. | Claude |
| 2026-08-06 | Steps 5–6 implemented — D-10 and D-5 closed. Tenant auto-switch governance now reaches STT; `activePipeline` is server-derived end-to-end (STT echo → applications → both gateways → SDK), with a mixed-version degrade path. Took over the parallel session's `apps/stt` work after verifying it. | Claude |
| 2026-08-06 | Batch lane (A5+B6+C4+D10) implemented — D-6/D-7 closed. Batch auto-fallback now actually dispatches; the fallback pipeline rides as a Dramatiq kwarg and the SDK queue item states which engine produced the transcript. | Claude |
| 2026-08-06 | Lanes E1, D5–D7, and B1–B3+D4 implemented (TDD, RED captured for each). D9 withdrawn with reason. Concurrent `apps/stt` work detected — Lane A paused. Pre-existing `SECRETS_PROVIDER=vault` failures in the applications context suite documented. | Claude |
| 2026-08-06 | Ticket created. STT provider-switch and fallback paths reviewed end-to-end across STT (`engine_switch.py`, `session_manager.py`, `transcribe_file.py`), applications bridge, both gateways, and the SDK (native + compat hooks, batch queue). Ten defects documented with evidence, incl. the reported silent mid-session no-op (D-2), the batch fallback never being dispatched (D-6), and the tenant `autoSwitchEnabled` setting never reaching STT (D-10). Plan drafted across 5 lanes; 3 owner decisions raised. Status `Pending`. | Claude |
