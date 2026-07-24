# TASK-553 — Exploration Report 3: Realtime Transcript → Agent Pipeline

Produced by the TASK-553 exploration pass on 2026-07-24. Scope: browser SDK → `apps/stt-v2`
→ `apps/api` gateway → `packages/applications`/`packages/domains` → `apps/harness` (Temporal)
/ `apps/nlp`, plus the TASK-543 live-summary SSE path. All citations verified against the
working tree (branch `fix/2605-review`).

---

## 1. Segment Flow (STT → persistence → harness)

**Publish mechanism is Redis Streams `XADD`, not WS or HTTP, on the STT-v2 side.**

| Hop | File:Line | Behavior |
|---|---|---|
| 1 | `apps/stt-v2/src/stt_v2/streaming/inference.py:447-456,509` | `StreamingInferenceWorker.process_utterance` builds `SegmentResult(text=…, is_final=utterance.is_final, …)`, calls `publisher.publish(result)`. Same path for partial and final; only `is_final` differs. |
| 2 | `session_manager.py:2026-2066` | Partial emission: `_fire_partial` → `worker.process_partial`, annotates `stable_chars` (LocalAgreement-2 commit policy, `:2061-2064`). |
| 3 | `session_manager.py:2189-2210` (frame-final), `:2225-2249` (control `FINALIZE`) | Final emission → `_flush_final_utterance` → `_drain_inference_queue` → worker publishes tail `SegmentResult(is_final=True)`. |
| 4 | `redis_streams.py:427-446` | `ResultPublisher.publish()` — `XADD stt:result:{session_id}` with `maxlen=10000, approximate=True`. |
| 5 | `redis_streams.py:460-470` | `publish_status()` writes `"finalizing"`, `"closed"`, `"cancelled"` status entries to the **same** stream. |
| 6 | `session.py:450-460` | `finalize()` sets `FINALIZING`; published **before** the tail final is drained (`session_manager.py:2234` then `:2237-2241`) — wire order is `finalizing → FINAL → closed`. |
| 7 | `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts:427-528` | Gateway `XREADGROUP` consumer (group `captions`); acks only after emitting (`:479-499`, at-least-once). |
| 8 | `streamingAudioBridge.service.ts:623-634` (`parseAndEmitResult`) | Terminal check: `status === 'closed' \|\| status === 'cancelled'` — **`finalizing` explicitly non-terminal** (comment `:610-621`). Fixed form of the TASK-470/471 bug (§5.1). |
| 9 | `apps/api/src/modules/streaming/stt-ws.gateway.ts:433-459`, `:546-571` | Gateway relays to browser WS with egress backpressure (partials dropped, finals queued — §5.6). |
| 10 | `session_manager.py:2492-2560` (`_persist_streaming_transcript`), called once from `_finalize_session_locked` (`:2997`) | At session finalize ONLY: builds full transcript text + `build_transcript_segments()` (`session.py:318-358`, one dict per **final**) and POSTs once. |
| 11 | `apps/stt-v2/src/stt_v2/core/api_client/gateway.py:258,322-331` | `create_transcript` → `POST /internal/stt/transcripts`, `X-Internal-Service-Key`, plus an **unused** `Idempotency-Key` (§5.7). |
| 12 | `apps/api/src/modules/internal/stt-internal.controller.ts:34-39` | → `SttInternalService.createTranscript`. |
| 13 | `packages/applications/src/services/stt/internal/sttInternal.service.ts:223-282` | Dedup-by-existence check (`:235-238`), creates encrypted `ContextItem` type TRANSCRIPT (`:240-256`), `persistTranscriptSegments()` (`:259`), emits `TranscriptionCreated` (`:270-279`) — **the single trigger into the harness path**. |
| 14 | `sttInternal.service.ts:75-129` | One `transcriptSegmentRepository.create` **per segment** in a loop (N+1 — §6 G1). |
| 15 | `TranscriptSegmentEntity.ts:10-35` | Non-PHI: `idx`, `t0Ms/t1Ms`, `speaker`, `charStart/charEnd` only — text lives in the encrypted ContextItem. |

**Partial segments never reach the DB.** `StreamSession.add_result` (`session.py:261-265`) discards non-finals; only finals accumulate and are bulk-POSTed once at finalize.

---

## 2. Trigger Cadence

**No per-segment, debounced, or token-threshold trigger for the harness.** One `TranscriptionCreated` event → one `HarnessDocWorkflow` per consultation.

| Hop | File:Line | Behavior |
|---|---|---|
| 1 | `consultation-event.handler.ts:93-227` | Fails closed without tenantId (`:102`); resolves pipelineConfig (`:131`); aborts if `autoSummaryEnabled` false (`:133`); if `harnessEnabled` (`:146`) → mints jobId, loads transcript, resolves DNA redaction rules, `harnessGatewayService.start()` (`:172-181`) — the ONLY caller. |
| 2 | `consultation.events.ts:297-301` | `DEFAULT_PIPELINE_CONFIG = { autoSummaryEnabled: true, autoNerEnabled: true, haltOnFailure: false }`; `harnessEnabled` opt-in/undefined by default (`:286-290`); false ⇒ legacy BullMQ `createSummaryJob` (`:227`). No explicit "generate note now" UI trigger for the harness. |
| 3 | `harness-gateway.service.ts:141-161` | POST `document:start` with full `transcriptText`, `X-Service-Token` (`:214-220`). |
| 4 | `apps/harness/src/harness/api/endpoints/internal.py:132-201` | Deterministic id `harness-doc-{consultation_id}` (`:75-77`); duplicate start → `{"status":"already_running"}` (`:199-201`). |
| 5 | `workflows.py` | Two signals only: `approval` (`:281-284`), `edit` (`:286-301`). **No transcript-content signal.** `transcript_text` one-time input (`models.py:83`). |
| 6 | `workflows.py:685` | Only "iteration" = bounded regen loop over sensor verdicts on the same snapshot. |
| 7 | `workflows.py:1433-1457` | Only wait_condition/timer = clinician sign-off gate (SLA/escalation). |

**Config** (`core/config.py`, `HARNESS_`): `MAX_REGEN=2` (:327), `GATE_SLA_SECONDS=86400` (:328), `GATE_ESCALATION_SECONDS=43200` (:329), `NLP_BASE_URL=http://localhost:8864` (:318), `ACTIVITY_START_TO_CLOSE_S=150` (:411), `LLM_REQUEST_TIMEOUT_S=120` (:423). Token budget default 0 = unbounded (`models.py:49`), consulted only inside the regen loop.

**Latency characteristic**: note generation begins only after the whole session ends. No incremental note-drafting against live transcript in the harness; TASK-543 "live summary" (§3) is a separate Redis-pub/sub concept, not harness-driven.

---

## 3. Live Summary Path (browser ⇄ gateway SSE, TASK-543)

```
Browser: useArcaLiveSummary.start(consultationId)
  → SSEClient.connect(getStreamBaseUrl() + LIVE_SUMMARY_STREAM(id))
    → POST /auth/stream-ticket (via BFF/AgenticClient, JWT-authed)
    → EventSource(gatewayOrigin + path + ?ticket=…)  [gateway-direct]
  ← gateway: GET :id/live-summary/stream (@Sse, guarded)
    ← LiveDocumentationService.subscribeToLiveSummary(id)
      ← Redis snapshot read (late-join) + pub/sub `consultation:live-summary:<id>`
      ← publisher: flush()/stop() → safePublish() → setex + publish
```

| Hop | File:Line | Behavior |
|---|---|---|
| Hook | `useArcaLiveSummary.ts:56-97` | `start()` tears down prior stream; `onMessage` (`:71-87`) parses full-state `LiveSummarySnapshot`, **unconditionally overwrites** state, disconnects on `closed === true` (`:75-79`). Malformed JSON swallowed (`:80-86`). |
| Ticket mint | `SSEClient.ts:173-212` | `apiClient.post(STREAM_TICKET, { scope })` via BFF. Mint failure → `scheduleReconnect()` (`:194-205`). |
| URL build | `SSEClient.ts:214-217`, `AgenticClient.ts:1092-1096` | `getStreamBaseUrl()` converts wsUrl → http(s) + `/api/v1` (gateway origin). Ticket as `?ticket=` (EventSource can't carry headers). |
| Reconnect | `SSEClient.ts:298-342` | Exponential backoff capped 30s, jitter, `maxReconnectAttempts=10`; each reconnect re-mints a fresh ticket (`:340`). |
| Ticket issuance | `auth.controller.ts:893-940` | JWT guard + defense-in-depth `assertConsultationScopeOwnership` (`:962-983`); 404 on mismatch. `StreamTicketService.issueTicket` (`stream-ticket.service.ts:66-80`): randomBytes(32), Redis, **30s TTL**, single-use. |
| SSE route | `consultation.controller.ts:508-520` | `@Sse` + `@TenantOwnedResource` + `@StreamScope({namespace:'consultation_live_summary'})`. |
| Ticket consumption | `jwtauth.guard.ts:54-169` | Atomic GET+DEL (`consumeTicket`, `stream-ticket.service.ts:82-118`), scope check, CLS rehydrate, double-consumption dedup marker. |
| SSE ownership guard | `tenant-owned-resource-sse.guard.ts:61-150` | Pre-stream `assertAccess` + re-check every 30s; only ownership loss ends the stream (fail-open for infra). Does not cover identity revocation (`:28-35`). |
| Data source | `live-documentation.service.ts:1087-1136` | Snapshot read (`:1093-1100`) **then** subscribe (`:1100`) — order matters, see §5.3. Heartbeat 15s (`:1114-1122`). |
| Publish | `live-documentation.service.ts:650-951` (`flush`), `:505-565` (`stop`) | `safePublish` (`:1833-1845`): `setex(snapshotKey, 3600)` then `publish`. `stop()` publishes terminal `{closed:true}`. |
| Console wiring | `consultation-demo-screen.tsx:22,215,265-266,304,321` | Uses `useArcaLiveSummary` from `@arcaai/vox` — the genuinely live-wired path. |

**Note**: harness-progress/assurance streams use a parallel, independently-reimplemented ticket+SSE stack (`use-event-stream.ts`, Next route `stream-ticket/route.ts:9-46`) with linear backoff, `maxRetries=3`. A near-duplicate `useLiveSummaryStream` in `apps/admin-console/.../api/hooks.ts:192-199` has **no call site** — dead code, drift risk.

---

## 4. Entity/Knowledge Extraction Path

**FOUR independent, uncoordinated NER paths** — no shared flag decides authority:

| # | Path | Trigger | Target | Persists? |
|---|---|---|---|---|
| 1 | Harness Temporal | `extract_entities` (`activities.py:626-667`; workflow `:518-535` transcript, `:735-747` note, `:937-948` redaction re-extract) | `NlpClient.classify_tokens` (`nlp_client.py:35-56`) → **direct to apps/nlp**, bypassing gateway | Yes — `persist_entities` (`api_client.py:341-365`) → `harness-internal.service.ts:242-295` → NamedEntity rows |
| 2 | Auto-NER-after-summary (BullMQ) | `handleSummaryGenerated` (`consultation-event.handler.ts:267-354`) if `autoNerEnabled` (default true) | `createNerJob` (`consultation-job.service.ts:287-329`) | Via #3's processor |
| 3 | Manual/sync extract endpoint | SDK `triggerEntityExtraction()` (`useArcaContext.ts:345-366`) → `POST :id/summary/:ctx/extract-entities` → `summary.service.ts:929-984` | `callNlpService` (`summary.service.ts:1208-1222`) — apps/api → apps/nlp directly | Yes (`:950-957`) |
| 4 | Browser KnowledgePipeline | `useArcaAudio.ts:251-278` on every final (`triggerMode:'auto'`) | dynamic import `@arcaai/med-ner`, client-side (`KnowledgePipeline.ts:200-247`; default `types/pipeline.ts:261-278`) | **No** — local Zustand only (`useArcaAudio.ts:263`); `location:'backend'` throws unimplemented (`KnowledgePipeline.ts:454-460`) |

`context.addCaseNote()` (`useArcaContext.ts:59-92`) = plain `POST :id/context`, no NLP. `extractEntities()` (`useArcaContext.ts:288-319`) is a GET of persisted rows.

**Duplication risk**: pipeline flags are server-side only; browser defaults (`ner.location:'browser', auto`) are never server-gated. Paths #1 and #2/#3 can both run NER for the same content with zero mutual awareness.

`apps/harness/.../knowledge.py:115-207` is unrelated (institutional RAG ingestion).

---

## 5. Failure Modes & Defects

### 5.1 TASK-470/471 tail-final bug — VERIFIED FIXED on current HEAD
`parseAndEmitResult` now terminates only on `closed`/`cancelled` (`streamingAudioBridge.service.ts:632-634`); `finalizing` non-terminal. Fix commit `0040fe3e` (rebased `75a3794f`) is an ancestor of HEAD. **Residual risk**: browser `stop()` closes the WS without waiting for server ack; `relayResult` only sends when `readyState === OPEN` (`stt-ws.gateway.ts:568`) — a tail final after a normal close can still miss the live caption UI (durable transcript unaffected).

### 5.2 [HIGH] Live-summary SSE — unsafe shared-Subject teardown
`live-documentation.service.ts:1111`: `finalize(() => this.redisSubscriber.unsubscribeFromChannel(channel))` calls the **unsafe** direct teardown, bypassing the refcount in `subscribeToChannel` (`redisSubscriber.service.ts:165-215`, `decrementAndCleanup` `:256-263` — direct call unconditionally completes the shared Subject, `:221-226`). Contrast: `harness-progress.service.ts:91-94` documents this exact hazard and uses only the refcounted path. **Impact**: with two concurrent viewers of the same consultation (two tabs / second clinician / reconnect racing teardown), the first disconnect silently ends every other viewer's stream (no `closed:true`, no error).

### 5.3 [HIGH] Live-summary SSE — snapshot-before-subscribe race
`live-documentation.service.ts:1093-1100`: snapshot read **then** subscribe (a real Redis round-trip). Any `safePublish` (incl. terminal `closed:true`) landing in the window is dropped for that viewer. Sibling `harness-progress.service.ts:104-121` subscribes first, buffers via ReplaySubject, de-dupes vs snapshot by `updatedAt` — with a comment saying it exists to close this exact gap. live-documentation lacks it.

### 5.4 [HIGH] STT-v2 inference queue overflow → silent AUDIO loss
`session_manager.py:1848-1850`: `asyncio.Queue(maxsize≈64)` — `streaming_inference_queue_maxsize` read via `getattr(_settings, …, 64)` but **never declared in settings.py** (untunable). Steady-state `await inference_queue.put(utt)` (`:2180`) has no timeout → blocks the single `IngestionConsumer` dispatch loop (`redis_streams.py:223-234`) when full → can't XACK → audio accrues on `stt:audio:{sessionId}` (`MAXLEN ~10000`) → **raw audio frames silently trimmed before ever being read**. Finalize-path enqueue (`:2330-2340`) correctly uses `wait_for(timeout)`.

### 5.5 [MED] LLM concurrency governor uncoordinated with Temporal admission
`llm_concurrency.py:53,90`: `HARNESS_LLM_MAX_CONCURRENCY=1` semaphore per endpoint per process. `worker.py:191-199` sets no `max_concurrent_activities` — Temporal admits unbounded concurrent inferential activities (900s timeout) queuing behind one semaphore. No per-tenant/consultation admission control.

### 5.6 [INFO] WS egress backpressure design
`stt-ws.gateway.ts:61-64`: high-watermark 512KiB; partials over threshold dropped pre-seq (`:550-559`); finals queued (limit 200) with `{type:'gap', reason:'egress_overflow'}` marker on overflow (`:623-635`); resume buffer retains for reconnect-replay (but see 5.8).

### 5.7 [HIGH] Duplicate transcript TOCTOU + dead Idempotency-Key
`sttInternal.service.ts:233-238`: check-then-act (`findTranscripts` then `create`), no unique constraint/lock — two concurrent finalizes can create two TRANSCRIPT ContextItems + two TranscriptionCreated events. STT-v2 sends `Idempotency-Key` (`gateway.py:322-327`) but `stt-internal.controller.ts:34-38` never reads it; `CreateTranscriptRequest` has no field. Blast radius: `harness-internal.service.ts` gates segment-citation features on `transcripts.length === 1` (~:1109,1149,1190) — duplicates silently disable evidence-grounding.

### 5.8 [HIGH] Reconnect — false "resumed" ack after grace expiry
`stt-ws.gateway.ts:378-424`: after `WS_RESUME_GRACE_MS` (15s) + finalize deleted the session (`:774`), reconnect creates a **new** SessionInfo with empty `resumeBuffer` (`:390`). `handleResume` (`:905-932`) checks only `buffer.length > 0` (`:916`) — vacuously passes — replies `{type:'resumed'}` (`:928`), never `resume_failed`. Re-subscribed consumer group cursor is already past `closed` → new reader gets nothing forever. Compounding: `streamingSession.service.ts:157-176` never clears `StreamSessionTenantBindingService` (24h TTL) → fresh tickets mintable against a dead session. **Net**: client believes it resumed; mic keeps capturing; nothing transcribes; no error anywhere.

### 5.9 [HIGH] SDK reconnect chain dies after one failed attempt
`SttV2WebSocketClient.ts`: `attemptReconnect()` (`:521-595`) re-armed only from `onclose`'s `wasConnected` branch (`:315,327-333`) gated on `this.ws !== null`, but `this.ws` set only in `onopen` (`:277`). A reconnect attempt that fails to open (refused/DNS/timeout, `:256-271`) fires `onclose` with `ws` null → reject branch (`:324-326`) — retry chain dies silently, `onReconnectFailedCb` never fires, before maxAttempts exhausted. The `.catch()` comment at `:592` is incorrect for this case.

### 5.10 [MED] Flush/drain outside the finalize lock
`_finalize_session` serialized per-session (`session_manager.py:2840-2857`), but `_flush_final_utterance` (`:2304-2352`) and `_drain_inference_queue` (`:1903-1927`) run **before/outside** the lock at all three trigger sites (`:2196-2202`, `:2236-2242`, `:3262-3268`) — near-simultaneous finalize triggers can double-flush the tail utterance.

### 5.11 [HIGH] Harness write-back ignores consultation status
`harness-internal.service.ts` write paths (`persistEntities:242-295`, `persistDraft:477-662`, `finalizeAssurance:676-849`, `recordGateDecision:857-892`, `recordEscalation:904-944`) do `findById` + `assertEqualTenants` only — never `resourceStatus`/consultation-status. Base `Repository.findById` (`repository.ts:101-110`) has no resourceStatus filter. An in-flight workflow can write drafts/entities against a soft-deleted/closed consultation.

### 5.12 [MED] Exhausted activity retries permanently strand the note
Bounded RetryPolicies (`workflows.py:112-137`); `persist_entities` call at `workflows.py:548-560` has **no try/except** → on exhaustion `ActivityError` → workflow FAILED (`:352-370`). Nothing re-issues `document:start` (one-shot trigger, deterministic id blocks natural retry). Sustained apps/api outage during the run permanently strands that consultation's note until manual ops.

### 5.13 [LOW] Unbounded buffers
`StreamSession.results` append-only, never capped (`session.py:100,261-265`) (audio_buffer 500MB / ring_buffer 30s ARE capped). `LiveSession.transcriptParts` grows unboundedly (`live-documentation.service.ts:141,580,655`) — windowing bounds only what's sent per flush. Redis streams correctly `MAXLEN ~10000` (which is what enables 5.4's loss vector).

### 5.14 Idempotency summary
- **Broken**: streaming-transcript create (5.7).
- **Correct**: `withHarnessIdempotency` (`harness-internal.service.ts:967-1010`) Redis-keyed on workflow run/activity id (`activities.py:192-203`) — replays prior response; `reportTrajectory` DB-unique `(tenantId,sessionId,runId,seq)`.

---

## 6. Performance Observations

| # | Finding | File:Line | Detail |
|---|---|---|---|
| G1 | N+1 insert — transcript segments | `sttInternal.service.ts:110-123` | One INSERT per segment (dozens–hundreds per consult), no createMany. |
| G2 | N+1 insert — NER entities | `harness-internal.service.ts:264-289` | One INSERT + per-row encryption per entity, every regen iteration. |
| G3 | Full context re-fetch every regen iteration | `workflows.py:685-702`, `activities.py:873-909`, `harness-internal.service.ts:342-458` | `assemble` re-runs all context queries unconditionally up to 3× per run though nothing changes between iterations (contrast: `verdict_cache` IS threaded). |
| G4 | Per-claim judge calls × regens | `groundedness.py:187-242`, `citation_verify.py:102-142`, `safety.py:60-124` | One judge call per claim per pass; `verdict_cache` only helps unchanged claims. Worst case 20-claim note × 2 regens ⇒ 60–120+ judge calls + 3 generates. |
| G5 | Gate wait push-based (OK) | `workflows.py:1433-1457` | wait_condition + signals, no polling. |
| G6 | No chatty DB polling found | `stt-ws.gateway.ts:198-205,610-614`, `live-documentation.service.ts:1247-1275` | All intervals cheap/self-limiting. |
| — | Untunable-looking config | `session_manager.py:197-198,252` | `streaming_inference_queue_maxsize` never declared in settings.py — ties into 5.4. |
| — | Duplicate NER work across services | §4 | Harness NER + BullMQ/manual NER both hit apps/nlp for the same content, no coordination flag. |
| — | Two parallel SSE-hook implementations | `hooks.ts:192-199` (dead) vs SDK `useArcaLiveSummary` (live) | Dead code + wire-contract drift risk. |

---

### Key files for follow-up
- `apps/stt-v2/src/stt_v2/streaming/{session_manager.py,session.py,redis_streams.py,inference.py,schemas.py}`
- `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts`
- `apps/api/src/modules/streaming/stt-ws.gateway.ts`
- `packages/applications/src/services/stt/internal/sttInternal.service.ts`
- `packages/applications/src/services/consultation/events/{consultation-event.handler.ts,consultation.events.ts}`
- `packages/applications/src/services/consultation/harness/{harness-gateway.service.ts,harness-internal.service.ts,harness-progress.service.ts}`
- `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts`
- `apps/harness/src/harness/temporal/{workflows.py,activities.py,worker.py,models.py}`
- `packages/agentic-sdk-v2/src/core/{KnowledgePipeline.ts,SSEClient.ts,AgenticClient.ts,SttV2WebSocketClient.ts}`
- `packages/agentic-sdk-v2/src/hooks/{useArcaLiveSummary.ts,useArcaContext.ts,useArcaAudio.ts}`
