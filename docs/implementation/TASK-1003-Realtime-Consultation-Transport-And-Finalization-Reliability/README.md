# TASK-1003 — Realtime consultation reliability: tunnel drops, reconnect storms, lost audio, slow stop, missing summary

| Field | Value |
|---|---|
| Status | **In Progress** — merged to `dev-2.2`, pushed and deployed (pipeline #1327 green incl. `verify-dev`, 2026-09-24); awaiting the SYSTEM `text.externalGuardrail.timeoutS` = 75 write and the §9 end-to-end runs |
| Type | bugfix + infrastructure |
| Branch | `dev-2.2` (hope-v2) · `main` (hope-v2-deployment) · `refactor-hope-integaration` (ALaaSv3.0) |
| Repos | `arca/hope-v2`, `arca/hope-v2-deployment`, `ALaaSv3.0` (`apps/audio-stream-svc`) |
| Reported by | testers, 2026-09-24: 3 Malayalam + English transcription runs |
| Opened | 2026-09-24 |
| Rules read | `00`, `01`, `04`, `05`, `06`, `08`, `09`, `14`, `_karpathy` |

## 1. Requirement

Testers ran three Malayalam + English consultations through ALaaS → HOPE and reported:

1. **Run 1:** English words were written in Malayalam script, with only occasional English text.
2. **Run 2:** only two lines appeared, from the middle of the audio. The start was lost (they suspected a late WebSocket open), and so was the end (the last transcript on stop).
3. **Run 3:** English and Malayalam each came out in their own script. But a **"Consultation Error"** pop-up and **502 Bad Gateway** errors appeared, and no summary was produced.

Owner (2026-09-24): open a ticket, document every finding and its fix following best practice, then fix them with agents at the right model/effort tier.

## 2. Evidence (Grafana Loki/Prometheus/Tempo + Rancher, 2026-09-24, times UTC)

### 2.1 Topology of the failing path

```
web_ui ──WS──▶ ALaaS audio-stream-svc (broker, @arcaai/vox-node 3.6.0, HOPE service account)
                    │  HTTPS + WS to api.taphuynh.dev
                    ▼
        Cloudflare edge ══QUIC══ cloudflared ×2 (hope-v2-dev) ──▶ Traefik (10.42.0.138) ──▶ hope-api
                                                                              ├─▶ hope-stt (whisper.cpp / Sarvam duplex)
                                                                              ├─▶ hope-text ─▶ hope-guardrail ─▶ hope-text /judge
                                                                              ├─▶ hope-nlp
                                                                              └─▶ hope-harness (Temporal)
```

Every consultation call reached the gateway with client IP `10.42.0.138`, which is the Traefik pod. So the HOPE client is the ALaaS broker calling the public hostname through the tunnel; the admin-console BFF is not involved. "Consultation Error" appears in neither repo; the broker's `ConsultationErrorCode` renders through `apps/web_ui/components/agentic/consultationSessionErrors.js`.

### 2.2 Timeline

Which log segment belongs to which tester run is **inferred** (the testers can confirm). Tenant `50000000-…-0001`.

| Time | Consultation | ASR engine | What happened |
|---|---|---|---|
| 07:10–08:12 | — | — | `cloudflared_tunnel_ha_connections` flaps from 4 to 1 per pod, repeatedly |
| 07:47–07:49 | `01a0d262` | whisper.cpp `arcaai-whisper-large-ml-en-gguf`, `language: null` | Session create took **6.87 s** (cold model). Output was Malayalam script for English speech |
| 08:01–08:10 | `01a0d262` | same | **7 `recording/start` in 9 min, up to 3 parallel STT sessions.** Every WS drop (08:04:27, 08:09:28, 08:09:56) is in the same second as a cloudflared `Request failed`. Stops took **18.2 s** and **20.0 s**. `refresh-ticket` 404 ×3 on each closed session |
| 08:19–08:31 | `01a0d219` | same | Stops took 28.0 s and 26.7 s. cloudflared failed the 08:31 `recording/stop` mid-flight (`Incoming request ended abruptly: context canceled`), so the client got a 502 |
| 08:36–08:47 | `01a0d28f` | Sarvam `saaras:v4` codemix | Two parallel sessions again (08:36:35 and 08:37:34). Sarvam non-fatal `Backend: UNAVAILABLE` |
| 08:56–09:04 | `01a0d28f` | Sarvam | Sarvam `Backend: INTERNAL`. `recording/stop` **35.4 s**. `summary/latest` polled 08:59:10–08:59:37, then the client gave up; drafts landed 08:59:41 and 08:59:56. The gate SLA passed at 09:04:42, so the consultation became **`CLOSED_INCOMPLETE`** (`completion_timeout`) |

### 2.3 What was ruled out

- **Pods:** no restarts in the namespace over 4 h; all Deployments Healthy.
- **Gateway:** `hope-api` emitted **zero** 5xx. The 502s come from the Cloudflare edge.
- **Load:** node NIC `enp6s18` was ~20 KB/s, so bandwidth wasn't saturated.
- **Models mount:** the s3fs models mount is readable by uid 1001.

### 2.4 Impact counts (Loki)

| Signal | 09-21 | 09-22 | 09-23 | 09-24 (to 09:30) |
|---|---|---|---|---|
| `stt.stream.usage_pushback_failed` (usage lost) | 43 | 18 | 38 | 16 |
| STT sessions closed | 44 | 22 | 43 | 19 |
| cloudflared `Request failed` | 127 | 37 | 42 | 7 |
| text `external_guardrail.attempt_failed` | 77 | 163 | 32 | 8 |
| nlp `/classify/tokens` 503 | 44 | 28 | 50 | 34 |

## 3. Findings

Each finding lists the root cause and its evidence. Code citations come from the discovery pass (6 read-only agents, 2026-09-24) and were spot-checked by the orchestrator.

### Transport

**F-1 — The tunnel runs QUIC over a lossy UDP path, and nothing alerts on it.**
- **Config:** `hope-v2-deployment/deployment/k8s/base/cloudflared.yaml` has no `protocol:` key, so cloudflared uses `auto`, which means QUIC on UDP/7844. The ConfigMap has no `originRequest` block, no `ha-connections` flag, and no PodDisruptionBudget.
- **Logs:** `failed to accept QUIC stream: timeout: no recent network activity` and `failed to dial to edge with quic`. Each time, every stream multiplexed on that connection drops, including the STT WebSockets and the long POSTs, and the edge answers 502.
- **Documented cause:** Cloudflare attributes this signature to network devices that time out UDP aggressively, and recommends `protocol: http2` as the mitigation ([common errors](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/)).
- **Precedent:** the same churn (~50 reconnects in 30 min) is already recorded in `hope-v2-deployment/docs/first-deployment-2026-09-01.md` §8.1.
- **Alerting:** the metrics are scraped, but `alert-rules.yaml` has **no** cloudflared rule.
- **Why two replicas don't help:** both cloudflared replicas sit on the one node, so they share the same egress path.

### ALaaS broker (the HOPE client)

**F-2 — Two reconnect mechanisms run on every socket drop, causing the session storm.**
- **vox-node side:** `RealtimeSttSocket` auto-resumes by default whenever `refreshTicket` is wired (`hope-v2 packages/vox-node/src/core/realtime-stt-socket.ts:130-133,539-585`). It emits `close {resuming:true}` and resumes the same session.
- **Broker side:** the adapter ignores `resuming` (`audio-stream-svc/src/consultation/hope-realtime.vox-node.adapter.ts:471-474`). `SttLane.reopen()` then runs its own ladder (`stt-lane.ts:194-203,724-741`), and each attempt makes a new `createStreamSession` and a new `recording.start`.
- **Orphaned socket:** `connect()` overwrites `this.sttSocket` without closing the old one (`stt-lane.ts:349`). The orphan keeps refreshing tickets on a session that is later closed, which produces the `refresh-ticket` 404 ×3.
- **Result:** up to 9 reconnect attempts per drop, parallel sessions, and a transcript split across sessions. That is Run 2's "two lines from the middle".

**F-3 — Audio before the socket opens is dropped.**
- `SttLane.sendFrame()` returns early when `this.sttSocket` is null (`stt-lane.ts:374-377`). Session create, `recording.start` and connect run sequentially first, so a 6.9 s cold create loses 6.9 s of speech.
- The only buffer is a 3 s ring used on reconnect (`stt-lane.ts:743-752`).

**F-4 — Stop is not ordered: frames can follow the stop frame, and finalize is not awaited.**
- `pushAudio`/`sendFrame` never read `ended`/`closed` (`stt-lane.ts:415-438`).
- `SttLane.finalize()` discards the SDK's `finalize()` promise.
- `ConsultationBrokerService.stop()` calls `hope.stopRecording()` concurrently with the socket drain (`consultation-broker.service.ts:635-703`).

**F-5 — A transient `recording/stop` failure is fatal, and the summary budget is shorter than the server's latency.**
- `stop()` maps any `stopRecording` error to `HOPE_UNAVAILABLE` and returns without polling (`:694-699`). vox-node won't retry the POST (no idempotency key), so one 502 ends finalization while HOPE carries on and writes the drafts.
- `pollForFinalNote` polls every 5 s up to `summaryTimeoutMs` (code default 180 s, overridable by `ALAAS_SUMMARY_TIMEOUT_MS`). The observed cutoff was 6 polls, about 27 s, which matches a ~30 s override (**inferred**; the env value isn't in the repo).
- It uses neither `streams.harnessProgress` (whose terminal event carries `closed: true`) nor any other push readiness signal.

**F-6 — A stale npm lockfile sits beside pnpm.**
- `audio-stream-svc/package-lock.json` pins vox-node 3.4.0, while `package.json` and `pnpm-lock.yaml` say 3.6.0. An `npm ci` would silently install the old SDK.

### Gateway (`apps/api`, `packages/applications`)

**F-7 — `recording/stop` blocks for 18–35 s on work whose result it throws away.**
- `ConsultationController.stopRecording` (`consultation.controller.ts:1001-1024`) awaits `liveDocumentationService.stop()` and discards the return value.
- `stop()` (`live-documentation.service.ts:2621-2699`) drains the live-note backlog with forced flushes: NLP `classify/tokens`, then TEXT `/generate`, then guardrail `/api/medical/validate` ×3, then the TEXT judge.
- It also awaits the harness `consultation-ending` signal.
- The response needs only the DRAINING transition. Completion already has asynchronous carriers: the SSE `closed: true` frame on `live-summary/stream`, and the harness `n_finalize` poll on the `persistLiveHandoff` row.
- Tempo trace `cc82a5ad6f63a8623c97513ee3404961`: 35.4 s total, of which 34 s is `/generate` and 25 s + 15 s + 7 s is `/api/medical/validate`.

**F-8 — `recording/start` accepts parallel STT sessions and never closes the one it replaces.**
- `ConsultationEntity.canTransitionTo` treats `RECORDING → RECORDING` as a legal self-transition (`ConsultationEntity.ts:378-380`).
- `assertSttSessionLive` checks only the session named in the call (`consultation.service.ts:2204-2206,2258-2292`).
- `LiveDocumentationService.attachSttStream` only unsubscribes locally (`live-documentation.service.ts:1600-1607,5114-5116`). The earlier STT sessions stay open until their grace window or idle reaper, still holding GPU and model pins.

**F-9 — Stop is signalled out of band, so tail frames are dropped.**
- The WS `stop` handler writes `{action:"finalize"}` to `stt:control:{sid}` (`stt-ws.gateway.ts:1974-1984`). That stream is independent of `stt:audio:{sid}`.
- STT's `_on_control` flips the session to FINALIZING while audio entries are still unread, so `_on_frame` drops them (`apps/stt/.../session_manager.py:4769-4789`). This is the `frame_dropped_after_finalize` warning.
- The designed fix (TASK-985 M-29) is an in-band `final=1` audio entry. STT supports it (`session_manager.py:4870-4904`) and the bridge can write it (`streamingAudioBridge.service.ts:291-330`), but `forwardAudioFrame` hard-codes `isFinal=false` (`stt-ws.gateway.ts:2037,2069`). It was never wired end to end.

**F-10 — Streaming usage metering is lost for effectively every session.**
- **(a) Contract drift:** TASK-935 (`0c865ccfb`) added `lexicon_correction_count` to STT's teardown summary (`session_manager.py:5929-5954`). The gateway DTO `SttStreamingUsagePushbackRequest` (`apps/api/src/modules/internal/dto/stt-streaming-usage.request.ts:118-202`) never gained the field, and `forbidNonWhitelisted` rejects it with a 400. `_push_streaming_usage_back` does not retry and has no dead-letter queue, so the usage row is lost permanently.
- **(b) Teardown race:** the normal path is supposed to be the gateway's `DELETE /internal/streaming/sessions/:id` claiming the summary in its response. Live logs show the DELETE returning **204 in ~190 ms** and then `stt.stream.teardown_stash_unclaimed` two minutes later, for sessions `01a0d290` and `01a0d2a1`. The DELETE lands while the tail flush is still running, so the stash isn't there yet. Every session therefore falls through to the push-back path of (a).
- **What is lost:** `SESSION_SECOND`, `AUDIO_SECOND`, GPU/CPU seconds and byte ledger rows, plus the `TranscriptionJob` close-out.

**F-11 — `summary/latest` 404 can't tell "not ready" from "never".**
- `getLatestSummary` 404s with no state and no pointer to `harness-progress/stream` (`summary.service.ts:1742-1755`).
- A draft *is* returned as soon as `persistDraft` writes `RAW_SUMMARY`. The client simply stopped 4 s too early.

### Text ↔ Guardrail

**F-12 — The timeout budget is inverted and retries pile up on the shared GPU.**
- **Outer budget:** `text.externalGuardrail.timeoutS` = 10 s, `maxRetries` = 2 (`apps/text/.../runtime_defaults.py:168-171`, descriptor `text-provider-connections.descriptors.ts:78-81`). Every exception is retried, `ReadTimeout` included (`external_guardrail.py:240-320`).
- **Inner budget:** guardrail's judge call to TEXT has a 60 s budget (`guardrail.judge.timeoutSeconds`) and takes 7–25 s in practice.
- **Effect:** TEXT abandons each attempt at 10 s and starts a new `validate`. Guardrail's in-flight judge call is not cancelled, so up to 3 LLM judge calls stack on the single LM Studio GPU, and each one slows the next.
- **No shedding:** there is no circuit breaker on the TEXT→guardrail leg. Guardrail→TEXT has one.
- **Fail posture:** fail-closed is correct and stays.

### Harness / NLP

**F-13 — The doc workflow's NER always fails, which forces every note into mandatory review.**
- `extract_entities` and `nlp_extract_entities` (`apps/harness/.../temporal/activities.py:1241-1287,3758-3790`) call `NlpClient.classify_tokens` with no `model_name` (`nlp_client.py:37-63`). Since TASK-890 F13/F14, `apps/nlp` fails closed with 503 when `model_name` is missing (`classify.py:163-166`). This is a missed call site; no document records it as deferred.
- **Consequences:**
  - `degraded=True` always, so `aggregate()` forces `GateDecision.FLAG` (mandatory clinician review, never auto-pass) (`workflows.py:622-660`, `aggregator.py:144-149`).
  - No `NamedEntity` rows are written.
  - The highest-harm sensors (`entity_faithfulness`, `numeric_dose`) check nothing.
  - MCP terminology validation is skipped.
- **The right resolver exists but can't be reached:** it is the gateway's in-process `resolveNerModelInjection` (`nlp.ner`, SYSTEM-only, fail-closed) at `packages/applications/.../shared/resolveNerModelSelection.ts:103-138`. It has no internal HTTP route the Python worker can call.

### STT

**F-14 — Cold start on the first session.**
- The 6.5 s is the first mmap of the multi-GB GGUF over the s3fs `local_path`.
- `stt.warmDefaultAsrOnBoot` exists (`apps/stt/src/stt/main.py:108,118-211`) but defaults **off**.
- `stt_model_cache.estimate_failed` is cosmetic log noise: the resolved spec carries `memory_size_mb=None` (`spec.py:724,733`), and the estimate goes through the `except` branch of `hope_runtime_models/cache.py:426-433`.

**F-15 — The ml-en whisper fine-tune writes English speech in Malayalam script, and nothing detects it.**
- `language: null` is by design for code-switch pair modes on whisper.cpp (`language_modes.py:479-496`; TASK-985 OD-B measured it as optimal).
- The script-mismatch guard only fires for sessions pinned to a Latin-script language (`inference.py:329,536-553`). There's no check for English content written in the Malayalam Unicode block.
- Sarvam codemix (Run 3) produced the correct scripts.
- The broker sends `agentSlug` only when `HOPE_STT_AGENT_SLUG_BY_MODE` has an exact key for the language mode (`stt-lane.ts:547-550`, `consultation.module.ts:55-84`); otherwise HOPE's assignment cascade picks the engine.

**F-16 — Sarvam non-fatal errors are only visible as log lines.**
- `transcriber_error` with `is_fatal:false` is telemetry by design (`session_manager.py:4022-4035`), which is correct.
- But there's no counter, so a sustained non-fatal outage shows up only in logs.

### Policy interaction (not a defect)

**F-17 — The 5-minute completion timeout closes unreviewed test runs.**
- `consultation.session.completionTimeoutMinutes` = 5 (`consultation-completion.descriptors.ts:32-62`) is an owner decision (TASK-1001 D-6/D-8). It drives both the gateway BullMQ close-out and the harness gate SLA.
- Combined with F-13, which forces every note into review, any run nobody signs within 5 minutes ends `CLOSED_INCOMPLETE`.

## 4. Best practices applied

| Practice | Applied to | Source |
|---|---|---|
| Use TCP (`http2`) for tunnels whose UDP path is lossy; alert on connector health, not only pod health | F-1 | Cloudflare Tunnel [common errors](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/), [metrics](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/metrics/) |
| **One reconnect authority per connection.** Prefer resume (same session, sequence-numbered replay) over recreate. Recreate only after resume has definitively failed, and close the superseded resource first | F-2, F-8 | vox-node `RealtimeSttSocket` resume contract; gateway C3-01 grace/replay |
| Buffer (bounded) from capture start and flush on open, so client/server start-up latency never costs data | F-3 | same pattern as the existing reconnect ring (`RECONNECT_RING_MAX_BYTES`) |
| End-of-stream is an **in-band** marker ordered after the last data frame, never a message on a separate unordered channel | F-4, F-9 | TASK-985 M-29 (designed, not wired) |
| Long work behind a request returns once the state change is durable; completion is **pushed** (SSE) with a bounded poll only as fallback | F-5, F-7, F-11 | [Async Request-Reply pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/async-request-reply), RFC 9110 §15.3.3 |
| Retry only operations that are idempotent and have an idempotency identity; classify transient (5xx/network/timeout) apart from terminal errors | F-5, F-8 | [AWS Builders' Library — timeouts, retries and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) |
| **Timeouts nest:** each caller's deadline exceeds its callee's worst case. Never retry a timed-out call whose work keeps running downstream; propagate the deadline; shed load with a circuit breaker | F-12 | same; [Google SRE — cascading failures](https://sre.google/sre-book/addressing-cascading-failures/); [gRPC deadlines](https://grpc.io/docs/guides/deadlines/); TASK-995 (harness LLM budget, same class) |
| Internal wire contracts get a **parity test** between producer and consumer, so a field added on one side fails CI rather than production | F-10 | existing precedent: `ResolvedAsrSpec` fixture parity (`tests/contracts/resolved-asr-spec.fixture.json`) |
| Model **selection** fails closed at the resolver; a clinical run **degrades** (forced review) rather than crashing; side effects stay in activities, so workflow replay is unaffected | F-13 | rules `00` Configuration Principles, `06` Temporal |
| Pin config, not code; tenant → SYSTEM cascade; change behaviour through descriptors | F-12, F-14, F-17 | rules `00`, `09` §Configuration Tiers |

## 5. Solution design

| # | Fix | Where | Test written first (RED → GREEN) |
|---|---|---|---|
| S-1 | Pin `protocol: http2`; bump `cloudflared.hope/config-revision`. Add alert rules: `CloudflaredEdgeConnectionsDegraded` (<4 for 5m, ticket), `CloudflaredEdgeConnectionsLost` (==0 for 2m, page), `CloudflaredRequestErrorsHigh`. Record the tradeoff (no post-quantum on the tunnel hop) and the revert criterion in `docs/cloudflare-tunnel.md`. **No** upgrade to 2026.9.x (#1737 segfault) | deployment repo `base/cloudflared.yaml`, `base/alert-rules.yaml` (+ `alert-rules.test.yml`), `docs/cloudflare-tunnel.md` | promtool rule test in `alert-rules.test.yml`; `kustomize build overlays/dev` renders `protocol: http2` |
| S-2 | Single reconnect authority (**OD-9**, recommended: the SDK's resume): the broker reacts to `close` only when `resuming === false` or on resume failure. Before any recreate, `close()` the previous socket and `DELETE` its session; never keep two live sessions | ALaaS `hope-realtime.vox-node.adapter.ts`, `stt-lane.ts` | `stt-lane.spec.ts`: a drop with `resuming:true` causes 0 `createStreamSession` / 0 `recording.start`; a failed resume causes exactly 1 recreate, and the old socket is closed first |
| S-3 | Bounded pre-open ring buffer (≤ 30 s PCM16), flushed in order after `connect()` | ALaaS `stt-lane.ts` | `stt-lane.spec.ts`: frames pushed before connect arrive in order after open; overflow drops oldest and counts it |
| S-4 | Gate `pushAudio`/`sendFrame` on `ended`; `stop()` awaits the socket finalize (terminal status or bounded drain ≤ 10 s) **before** `recording.stop` | ALaaS `stt-lane.ts`, `consultation-broker.service.ts` | spec: no `sendPcm16` after finalize; `stopRecording` is called only after the finalize promise settles |
| S-5 | Classify `stopRecording` errors (5xx/network/timeout are transient). On transient failure, still enter readiness waiting. Readiness goes through `streams.harnessProgress` (primary) with a `summary/latest` poll as fallback; the budget is ≥ 180 s and above server p99 (**OD-8**). Emit `retryable:true` for transient errors. Delete the stale `package-lock.json`; log the resolved `(languageMode, agentSlug)` per session | ALaaS `consultation-broker.service.ts`, `consultation.module.ts` | `consultation-broker.service.spec.ts`: a 502 from `stopRecording` still reaches `latestSummary`/progress; the emitted error is `retryable:true` |
| S-6 | `recording/stop` returns once the DRAINING transition is persisted. `liveDocumentationService.stop()` and `signalConsultationEnding()` run in the background with a logged rejection path and a per-consultation single-flight guard. The response body is unchanged (**OD-2**) | `consultation.controller.ts`; `live-documentation.service.ts` (single-flight only) | `consultation.controller.recording-stop.test.ts`: resolves before a deferred `stop()` settles; a rejection is logged, not propagated; a second stop joins the in-flight drain |
| S-7 | `summary/latest` 404 carries `code: SUMMARY_NOT_READY` plus `progressStreamPath` | same controller (same lane as S-6) | controller test on the 404 body |
| S-8 | A `recording/start` naming a *different* STT session while one is bound and live closes the superseded session through the gateway's normal teardown (**OD-3** recommends supersede over 409). The same session id stays a no-op | `consultation.service.ts` (`startRecording`), `live-documentation.service.ts` (`attachSttStream` teardown hook) | `consultation.service.recording-stt-guard.task1001.test.ts` + new case: the superseded session is closed exactly once |
| S-9 | The WS `stop` writes an in-band `isFinal=true` audio entry after the last forwarded frame and keeps the control `finalize` as fallback. STT's `_on_control` FINALIZE waits (bounded) for the audio consumer to reach the stream tail | `stt-ws.gateway.ts`; `apps/stt/.../session_manager.py` | `stt-ws.gateway.reliability.task985.test.ts`: stop leads to `writeAudioFrame(isFinal:true)`; `apps/stt/tests/unit/streaming/test_finalize_drain.py`: zero `frames_dropped_after_finalize` under a raced control write |
| S-10a | Add optional `lexicon_correction_count` (`@IsInt @Min(0) @IsOptional`) to the DTO. Add a **contract parity test**: every key of STT's teardown summary is declared on the DTO | `stt-streaming-usage.request.ts`; `tests/contracts/` fixture + STT pytest + api vitest | `stt-streaming-usage.request.test.ts` (validates); parity test fails on today's tree |
| S-10b | The DELETE claim waits (bounded, ≤ 5 s) for the in-flight teardown summary instead of answering 204 before the stash exists; push-back stays the backstop | `apps/stt/.../api/routes.py` (DELETE), `session_manager.py` (`claim_teardown_summary`) | `test_teardown_claim_race.py`: a DELETE during tail flush returns the summary (200), with no `teardown_stash_unclaimed` |
| S-11 | Timeout budget (**OD-4**): the outer TEXT→guardrail deadline exceeds guardrail's inner judge budget. Retry only connect errors and 5xx, **not** `ReadTimeout`. Add a `CircuitBreaker` on `ExternalGuardrailClient` (same class as guardrail's `core/breaker.py`). Descriptor defaults change; the fail-closed posture is unchanged. Size values from Tempo p99 of `/generate/internal/judge` measured in-lane | `apps/text/.../external_guardrail.py`, `runtime_defaults.py`; descriptor `text-provider-connections.descriptors.ts`; guardrail `effective_config.py` default | `test_external_guardrail_client.py`: a 15 s response under the new budget succeeds with one attempt; a `ReadTimeout` is not retried; the breaker opens after N failures and sheds fail-closed |
| S-12 | Internal route `GET internal/harness/models/resolve?taskKey=nlp.ner` sharing `resolveNerModelInjection` (fail-closed 503 naming the key). Harness `ApiClient.resolve_task_model()`. `extract_entities`/`nlp_extract_entities` resolve **inside the activity** and call `classify_tokens_raw(model_name, model_path, labels)`. No workflow change, so no `workflow.patched` | `harness-internal.controller.ts` + applications service; `apps/harness/.../api_client.py`, `activities.py` | `harness-internal.model-resolve.controller.test.ts` (+ taskKey case); `test_activities.py::TestExtractEntities` (model forwarded; resolver failure still degrades); `test_replay_compat.py` stays green |
| S-13 | `hope_runtime_models` `_estimate_for`: a missing estimate is 0 without the warning. Script telemetry: flag a final whose Latin-word proportion in the Malayalam block exceeds the threshold on unpinned/ml sessions (`stt.streaming.script_mismatch`, **telemetry only**, **OD-6**). Add a counter for non-fatal duplex errors | `packages/py-runtime-models/.../cache.py`; `apps/stt/.../inference.py`, `session_manager.py` | `test_model_cache.py::test_estimate_missing_key_no_warning`; `test_script_mismatch_unpinned.py`; `test_sarvam_duplex_nonfatal_errors.py` |
| S-14 | Config, not code (orchestrator, through the admin API after merge): `stt.warmDefaultAsrOnBoot = true` on SYSTEM (**OD-5**); a testers' tenant override of `consultation.session.completionTimeoutMinutes` only if the owner wants it (**OD-7**) | settings registry | read back via `GET admin/settings/registry/:key` |

## 6. Decisions taken (owner may override)

| # | Decision | Why |
|---|---|---|
| D-1 | The usage drift is fixed on the **gateway** (declare the field) plus a parity test, not by stripping it in STT | The field is legitimate telemetry; the defect is the missing contract test |
| D-2 | The NER model resolves **inside** the existing activity | No new workflow command, so it stays replay-safe; this is the `core.classify`/`_run_ner` precedent |
| D-3 | The stop marker goes in-band, with the control `finalize` kept as fallback | Older SDKs and the reaper/HTTP paths still need the control path |
| D-4 | cloudflared stays on 2026.8.3 | 2026.9.0 has a QUIC probe SIGSEGV (#1737); upgrade in its own validated change |
| D-5 | Sarvam non-fatal errors stay non-fatal; only a counter is added | The current design is deliberate and correct (`session_manager.py:4030-4035`) |
| D-6 | One ticket, lanes per repo, file-disjoint | The findings share one incident; partitioning follows rule 14 §3 |
| D-7 | Lanes run only their own RED→GREEN test; the orchestrator merges, then runs **one** gate pass | Owner directive (TASK-983) |
| D-8 | The 5-minute completion timeout is **not** changed in code | Owner decision TASK-1001 D-6/D-8 |

## 7. Open decisions (owner)

| OD | Question | Recommendation |
|---|---|---|
| **OD-1** | Pin the tunnel to `protocol: http2` now? It auto-syncs to the cluster on push. Diagnosing the host/router UDP conntrack or MTU root cause needs host access and is proposed as a separate follow-up | **Yes.** It's the documented mitigation, reversible, and the tradeoff (no post-quantum on one hop) is acceptable |
| **OD-2** | `recording/stop` returns once DRAINING is persisted (same body, ~50 ms instead of 18–35 s) and the live-note drain moves to the background? | **Yes.** No response field depends on the drain; completion is already pushed |
| **OD-3** | A second `recording/start` with a *different* live STT session: supersede (close the old one) or reject with 409? | **Supersede.** The last writer wins and there's always exactly one live session; a 409 would strand a legitimately recovering client |
| **OD-4** | TEXT→guardrail budget. Proposal: `text.externalGuardrail.timeoutS` 10 → **45**, retries only on connect/5xx; `guardrail.judge.timeoutSeconds` 60 → **40**, `maxAttempts` 2 → 1, so the inner budget (40 s) fits inside the outer (45 s). The lane confirms against measured judge p99 before committing | **Yes**, with the p99 check |
| **OD-5** | Turn on `stt.warmDefaultAsrOnBoot` (SYSTEM)? It keeps the default ASR model resident from boot | **Yes** |
| **OD-6** | ml-en script issue. Options: (a) route Malayalam+English realtime to the Sarvam codemix agent through tenant assignment / ALaaS `HOPE_STT_AGENT_SLUG_BY_MODE`; (b) script-mismatch **telemetry** only (S-13); (c) pin `ml` (does not fix English words) | **(b) now + owner picks (a)**; (c) not recommended |
| **OD-7** | Give the testers' tenant a longer completion timeout (e.g. 30 min) so unreviewed runs don't close as `CLOSED_INCOMPLETE`? | Owner's call; no code either way |
| **OD-8** | ALaaS readiness: `streams.harnessProgress` as primary, with a poll fallback budget of **180 s** (confirm or raise the deployed `ALAAS_SUMMARY_TIMEOUT_MS`) | **Yes** |
| **OD-9** | Which layer owns reconnect: (A) the SDK resumes and the broker recreates only after resume fails, or (B) the broker only (`autoResume:false`)? | **(A).** Resume keeps the session, the sequence and the server replay buffer; recreate splits the transcript |
| **OD-10** | After merge and gates: push `dev-2.2` (CI promote to dev cluster), push the deployment repo, and push ALaaS `refactor-hope-integaration`? Each is outward-facing | Ask at merge time |

### 7.1 Owner answers (2026-09-24)

> "go with your recommendations on all ODs", with three amendments:

| OD | Answer | What it changes |
|---|---|---|
| OD-1, 2, 5, 8, 9 | As recommended | — |
| OD-4 | As recommended ("with the p99 check") | **Adjusted by the p99 check.** Loki, 3 days, text access log: judge n≈695, p50 2.9 s, p90 13.6 s, **p99 50.6 s**, max 60 s; guardrail `validate` n≈819, p50 2.6 s, p90 10.1 s, p99 50 s. The proposed 40 s judge / 45 s TEXT budget would cut real p99 calls, so: judge budget stays **60 s** with `maxAttempts` 2 → **1**; TEXT→guardrail `timeoutS` 10 → **75 s**; retries only on connect errors and 502/503/504, **never** on `ReadTimeout`; breaker on the TEXT→guardrail leg. The nesting invariant 75 > 60 × 1 is pinned by a test. These percentiles are inflated by today's retry stacking and should fall once it stops |
| **OD-3** | Supersede, **and** "ensure the recording (when storing the stream as a file to storage is enabled) … nothing broken, the full stream will be captured and stored properly" | STT stores every session unconditionally: `upload_streaming_raw_chunk` during the session, then `upload_streaming_raw_complete` (WAV), processed WAV, transcript and metadata at finalize (`session_manager.py:6039-6135`, keyed `sessions/{session_id}/`). **Acceptance criteria added (AC-S1…S4, §8.3):** a superseded session is closed through the **normal finalize path** (flush, then upload), never cancelled or discarded; no audio frame is dropped at the head (pre-open buffer), across a reconnect (resume + replay), or at the tail (in-band EOS); and every STT session bound to a consultation stays linked to it (`TranscriptionJob.consultationId`) |
| **OD-6** | "No routing — strictly follow the model and provider configured in the ASR Agent, and fall back to the default/fallback provider/model set by platform/tenant admin" | **Verified already true:** the chain is the agent's own `role:'fallback'` models or its named `parameters.fallback.agentSlug` agent (`build-resolved-asr-spec.ts:743-751`), and credentials cascade tenant → SYSTEM. So: **no** language routing is added; the script-mismatch signal (S-13) is **telemetry only** and must never trigger an engine switch (pinned by test); non-fatal vendor errors keep not switching (D-5). The ALaaS `HOPE_STT_AGENT_SLUG_BY_MODE` map, when set, is an explicit client selection (TASK-1002 precedence 1); the lane logs it and does not extend it |
| **OD-7** | "make sure timeout is set to 5m" | **Verified live:** no `GlobalSetting` row exists for `consultation.session.completionTimeoutMinutes` in any tenant (`psql` on `hope-postgres-0`), so the descriptor default of **5** applies everywhere; the gateway logged `timeoutMinutes: 5`. No change; a descriptor test pins the default at 5 (L-LIFECYCLE) |

## 8. Implementation plan (on go)

### 8.0 Adjustments made at go

- The two ALaaS lanes merge into **one** (`L-ALS`, `opus`). Both need `hope-realtime.vox-node.adapter.ts` (reconnect events *and* the harness-progress subscription), so rule 14 §3 makes them one writer.
- `L-STOP` and `L-START` run as **`L-LIFECYCLE`** (they share `live-documentation.service.ts`, see the conflict check below).
- Final set: **8 lanes**: L-TUN, L-DTO, L-STT (`sonnet`); L-LIFECYCLE, L-EOS, L-GRD, L-NER, L-ALS (`opus`).

### 8.1 Lanes

Each writer gets its own worktree from the current `dev-2.2` HEAD (after this README is committed), node_modules by symlink (never `pnpm install` in a nested worktree), and a self-contained brief: ticket, boundary, rules to read, the one test file to write first, what not to touch, and a return contract.

| Lane | Repo | Owns (files) | Findings | Tier / effort | Why this tier |
|---|---|---|---|---|---|
| **L-TUN** | hope-v2-deployment | `base/cloudflared.yaml`, `base/alert-rules.yaml`, `alert-rules.test.yml`, `docs/cloudflare-tunnel.md` | F-1 | `sonnet` / low | Mechanical YAML plus rules, exact diff pre-specified (S-1) |
| **L-DTO** | hope-v2 | `apps/api/src/modules/internal/dto/stt-streaming-usage.request.ts` + its test; new `tests/contracts/stt-teardown-summary.*` parity fixture and the two parity tests | F-10a | `sonnet` / low | Small, well-specified contract change |
| **L-STOP** | hope-v2 | `consultation.controller.ts` (stop + summary 404), `live-documentation.service.ts` (single-flight around `stop()` only) + tests | F-7, F-11 | `opus` / high | Changes a lifecycle contract with concurrency (single-flight, background errors) |
| **L-START** | hope-v2 | `consultation.service.ts` (`startRecording`), `live-documentation.service.ts` (`attachSttStream` teardown hook) + test | F-8 | `opus` / medium | Deciding lane: session ownership semantics |
| **L-EOS** | hope-v2 | `stt-ws.gateway.ts` (stop path), `apps/stt/.../session_manager.py` (`_on_control` drain, `claim_teardown_summary`), `apps/stt/.../api/routes.py` (DELETE) + tests | F-9, F-10b | `opus` / high | Cross-language ordering and race; subtle |
| **L-GRD** | hope-v2 | `apps/text/.../external_guardrail.py`, `runtime_defaults.py`, `text-provider-connections.descriptors.ts`, guardrail `effective_config.py`/`config.py` defaults + tests | F-12 | `opus` / medium | Safety-critical fail-closed path; timeout sizing needs judgement |
| **L-NER** | hope-v2 | `harness-internal.controller.ts` + resolver service, `apps/harness/.../api_client.py`, `activities.py` + tests | F-13 | `opus` / medium | Cross-service, replay-safety constraint |
| **L-STT** | hope-v2 | `packages/py-runtime-models/.../cache.py`, `apps/stt/.../inference.py` (script telemetry), Sarvam non-fatal counter + tests | F-14 (noise), F-15, F-16 | `sonnet` / medium | Contained telemetry changes |
| **L-ALS-A** | ALaaSv3.0 | `stt-lane.ts`, `hope-realtime.vox-node.adapter.ts` + specs | F-2, F-3, F-4 (lane side) | `opus` / high | Reconnect authority and buffering: the core client defect |
| **L-ALS-B** | ALaaSv3.0 | `consultation-broker.service.ts`, `consultation.module.ts`, `package-lock.json` (delete) + spec | F-4 (broker await), F-5, F-6, F-15 (log) | `opus` / medium | Error classification and readiness contract |

**Conflict check.** `live-documentation.service.ts` is touched by both L-STOP (`stop()` single-flight) and L-START (`attachSttStream`). Under rule 14 §3 that makes them **one writer**: L-STOP and L-START run as a single lane (`L-LIFECYCLE`, `opus`/high) in one worktree, sequentially. Every other lane is file-disjoint. `session_manager.py` is owned by L-EOS only; L-STT does not touch it (the non-fatal counter lives in the Sarvam adapter/metrics module, and if that's impossible the counter moves to L-EOS).

### 8.2 Waves

1. **Wave 0 (orchestrator):** commit this README; confirm `dev-2.2` HEAD; create worktrees; copy `.env.dev`/`.env.test`.
2. **Wave 1 (parallel, 8 writers):** L-TUN, L-DTO, L-LIFECYCLE, L-EOS, L-GRD, L-NER, L-STT, L-ALS-A + L-ALS-B (the two ALaaS lanes are separate worktrees in that repo). Each lane writes its RED test, makes it GREEN, commits, and reports.
3. **Wave 2 (orchestrator, `opus`):**
   - Review each diff against its brief.
   - Merge into `dev-2.2` from the primary (after asking you which branch is the target, per rule 14 §5); ALaaS lanes into `refactor-hope-integaration`; L-TUN into deployment `main`.
   - Rebuild consumed `dist`.
   - Run **one** gate pass: `pnpm lint`, `pnpm typecheck:all`, `pnpm --filter @arcaai/api exec tsc --noEmit`, `pnpm --filter @arcaai/applications test`, `pnpm test:unit`, `pnpm stt:test`, `pnpm text:test`, `pnpm guardrail:test`, `pnpm harness:test` (incl. `test_replay_compat`), `pnpm api:route-manifest` / `api:openapi` / `api:portal` / `vox-node gen:admin` (for the new internal route), ALaaS `jest` for the touched specs, and `kustomize build overlays/dev` in the deployment repo.
4. **Wave 3 (after OD-10):** push; apply S-14 settings through the admin API; runtime proof (§9).

### 8.3 Recording-storage acceptance criteria (OD-3)

| AC | Criterion | Owner lane |
|---|---|---|
| AC-S1 | A superseded STT session is finalized through the gateway's normal teardown (`removeSession` → STT `DELETE`), producing `Session recordings uploaded` with a raw WAV. It is never cancelled and never discarded | L-LIFECYCLE (test on the gateway call), L-EOS (STT DELETE path still uploads) |
| AC-S2 | The stored raw WAV of a session contains every frame the client sent before `stop`, including the frames in flight when the stop arrives (in-band EOS; `frames_dropped_after_finalize == 0`) | L-EOS |
| AC-S3 | Audio produced before the socket opens and during a reconnect reaches the session (pre-open ring + SDK resume replay); a recreate after a failed resume finalizes the old session first | L-ALS |
| AC-S4 | The bounded DELETE claim wait (S-10b) never shortens or skips the upload; the upload happens before the summary is claimed | L-EOS |

### 8.4 Deploy-time settings (wave 3, admin API, read back after each write)

| Key | Tier | Live today | Set to | Why |
|---|---|---|---|---|
| `text.externalGuardrail.timeoutS` | SYSTEM `GlobalSetting` | **10** (stored row; the seed upsert never overwrites `value`) | **75** | L-GRD stops retrying `ReadTimeout`, so leaving the stored 10 s in place would fail ~10 % of validations closed on the first attempt. **Deploy blocker** |
| `stt.warmDefaultAsrOnBoot` | SYSTEM | absent (code default off) | `true` | OD-5 |
| `consultation.session.completionTimeoutMinutes` | — | absent, so default **5** | unchanged | OD-7 (verify only) |

Checked 2026-09-24: `AiRoutingPolicy` `guardrail.validate` has no `configJson` timeout (no per-selection escape from the budget); the SYSTEM `nlp.ner` election row exists (the prerequisite for L-NER).

### 8.5 Follow-ups found in-lane (out of scope, recorded)

- **Inverted budgets one layer up (pre-existing):** apps/nlp → TEXT `ExternalTextConfig` 30 s with retry-on-everything (`apps/nlp/.../core/config.py:678`); harness `TextClient` httpx 120 s (`apps/harness/.../core/config.py:671`); gateway non-streaming TEXT callers at 120–180 s. A generation with both input and output screening can now legitimately take up to 75 s + generation + 75 s. Before this change the same calls failed closed after 30 s.
- The deployment repo has no CI job that runs `promtool test rules` (`alert-rules.test.yml` is run by hand).
- `packages/py-runtime-models` has no worktree source guard: from a worktree its tests silently import the primary checkout unless `PYTHONPATH=<wt>/src`.
- `NlpClient.classify_tokens` (the model-less call) now has no production callers.
- Gateway `StreamingSessionService.removeSession` DELETE uses a literal 30 s timeout (`streamingSession.service.ts:546`), below STT's governed 65 s tail-wait bound. A sibling finalize running past 30 s can still lose the summary. Govern it above STT's bound.
- STT `redis_streams._reclaim_pending` (`XAUTOCLAIM`) deliveries do not signal ingest progress, so a finalize right after a consumer takeover waits out the full bound (rare, bounded).
- Multi-replica gateway: a cross-instance reconnect restarts `binarySeq` at 0 and STT refuses `seq <= last_seq`. That is safe with today's single API replica but breaks full-stream capture (AC-S3) once there is a second one.

## 9. Verification (after deploy)

| Check | Pass criterion | How |
|---|---|---|
| Tunnel | `cloudflared_tunnel_ha_connections` == 4 per pod for 24 h; zero `no recent network activity`; new alerts load | Prometheus / Loki |
| Reconnect | Forced WS drop mid-recording gives 1 STT session per consultation, 0 extra `recording/start`, 0 `refresh-ticket` 404 | tester replay + gateway `SttWsGateway` logs |
| Start of audio | First words of a cold-start session present in the transcript | tester replay (cold pod) |
| End of audio | 0 `frame_dropped_after_finalize`; last sentence present | STT logs + transcript |
| Stop latency | `recording/stop` p95 < 1 s | gateway `Request completed` durationMs |
| Usage | 0 `usage_pushback_failed`, 0 `teardown_stash_unclaimed`; `AiUsageEvent` rows per session | Loki + DB |
| Guardrail | 0 `external_guardrail.attempt_failed ReadTimeout` under normal load; ≤ 1 judge call per validate | Loki + Tempo |
| NER | 0 NLP `/classify/tokens` 503 from harness; `NamedEntity` rows persisted; doc runs not all `FLAG` | Loki + DB |
| Summary | ALaaS shows the draft after stop with no error; no `CLOSED_INCOMPLETE` when the clinician saves in time | tester replay |

## 10. Implementation summary

### 10.1 What changed, per lane

| Lane | Tier | Branch / commits | Change |
|---|---|---|---|
| L-TUN | sonnet | deployment `task-1003/tun` `889ca4c` | `protocol: http2` (config-revision 2); 3 alert rules + promtool tests; `docs/cloudflare-tunnel.md` §8 |
| L-DTO | sonnet | `3a38ecaee` | DTO accepts `lexicon_correction_count`; cross-language contract fixture `tests/contracts/stt-streaming-usage.fixture.json` pinned by a real-builder pytest and a DTO vitest |
| L-STT | sonnet | `dbc1e67ab` | absent size estimate no longer warns; `stt_streaming_script_profile_chars_total{script}` + `stt.streaming.script_profile` (telemetry only, pinned not to switch engines); `stt_cloud_asr_non_fatal_errors_total{provider,code}` |
| L-GRD | opus | `b38cc3851` | TEXT→guardrail 75 s / retry only connect + 502/503/504 (never ReadTimeout, never a judge-timeout 503) / 5 s connect bound / breaker (5 failures, 15 s); judge `max_attempts` 1; seed + descriptor + floor at 75; nesting invariant test |
| L-NER | opus | `c8829b0c2`, `05a5f68d6`, `c48424ddf` | `GET internal/harness/models/resolve?taskKey=nlp.ner` (SYSTEM-only, fail-closed 503); harness resolves inside `extract_entities`/`nlp_extract_entities` and calls `classify_tokens_raw` with `model_name` + labels + `clinical_taxonomy` (no `model_path`, matching the gateway so NLP keeps one resident copy) |
| L-EOS | opus | `85e19f489` | WS `stop` writes an in-band `isFinal` frame after the last forwarded frame (control finalize kept as fallback); STT drains the audio backlog (bounded by the governed tail-wait budget) before finalizing; DELETE waits for an in-flight teardown and returns the summary (200) after the upload; `stt.session.superseded` listener finalizes the replaced session (never cancels) |
| L-LIFECYCLE | opus | `84d0ecfc0` | `recording/stop` returns once DRAINING (same body); drain + loop signal run in the background inside a copied CLS context, single-flight; `live-doc:handoff-pending` marker keeps the harness from reading "ended with nothing" early; `recording/start` waits for a running drain and supersedes a replaced session (live re-bind, else durable `TranscriptionJob` binding); `summary/latest` 404 carries `SUMMARY_NOT_READY` + `progressStreamPath`; completion timeout pinned at 5 min / gate SLA 300 s |
| L-ALS | opus | ALaaS `task-1003/als` `c08c1b1` | one reconnect authority (SDK resume; broker recreates only after resume fails, releasing the old socket + session first); 30 s pre-open/resume hold buffer; finalize refuses late frames and awaits terminal status before `recording/stop`; transient stop failures (5xx/network/timeout) still wait for the note via harness-progress + poll, ≥ 180 s floor on `ALAAS_SUMMARY_TIMEOUT_MS`; ASR selection logged; stale `package-lock.json` removed |
| integration | orchestrator | `0417f072f` | shared `STT_SESSION_SUPERSEDED_EVENT` import in the gateway; regenerated `openapi.json` + console api-docs; e2e task-939/task-635 wait for `closed: true` after stop |

### 10.2 Gate pass (2026-09-24, integration worktree `hope-v2-task-1003-verify` with a real `pnpm install`)

| Gate | Result |
|---|---|
| `db:generate`, `build:packages`, `api:build`, `typecheck`, `api tsc --noEmit` | PASS |
| `pnpm lint` | PASS after a prettier fix in `stt-ws.gateway.ts` (8 formatting errors from L-EOS); `@arcaai/api` 0 errors / 65 warnings, none on added lines; admin-console PASS when run alone (the turbo run aborted it after the api failure) |
| `pnpm test:unit` | 28 485 passed, **6 failed**: `loki-line-contract.test.ts`, which fails identically on `dev-2.2` (pre-existing) |
| `stt` pytest | 4 140 passed, 40 failed + 8 errors: 46 fail identically on `dev-2.2` (e2e/integration needing live MinIO/DB/models, stale mocks); 2 CORS e2e fail only without the gitignored `apps/stt/.env` (pass with it) |
| `text` / `guardrail` / `harness` unit (incl. `test_replay_compat`) | 1 999 / 562 / 2 758 passed |
| `nlp` pytest | 703 passed, 2 failed (`test_metrics_endpoint_task636.py`, identical on `dev-2.2`) |
| `py-runtime-models` | 91 passed |
| Python lint (stt, text, guardrail, harness) | PASS |
| Python typecheck | stt: 4 mypy errors, the same 4 files on `dev-2.2`; others PASS |
| `api:openapi:check`, `api:portal:check`, `vox-node gen:admin:check` | PASS (only the `summary/latest` 404 description changed) |
| Affected API vitest re-run on the integrated build | 148 passed |
| ALaaS (`task-1003/als` worktree) | `tsc --noEmit` PASS; jest 34 suites / **806 passed**; eslint on `src/consultation` PASS |
| Deployment repo | `kubectl kustomize` dev/staging/prod/standalone render (orbstack is a pre-existing local-only failure); `promtool check rules` 61 rules, `promtool test rules` SUCCESS |

Not run: the API Playwright e2e suite (needs the live test stack); the two adapted specs compile (`playwright test --list`). Runtime proof is §9 after deploy.

### 10.3 Push and deploy (2026-09-24)

- hope-v2 `dev-2.2` was rebased onto a peer history rewrite with identical trees (verified tree-equal), then fast-forward pushed; deployment `main` rebased onto 14 newer promotion commits and pushed (L-TUN `b17e4f3`); ALaaS merged `--no-ff` on `refactor-hope-integaration` (`41dc1a7`).
- `promote-dev` refused the first run through the freshness stamp: the rewrite made the stamped commit an ancestor only by tree, not by hash. Proven tree-identical, then re-run as pipeline **#1327** with `PROMOTE_ALLOW_STALE=true` (recorded in the stamp and the promotion commit subject `[STALE OVERRIDE]`).
- Pipeline #1327: every build, validate and scan job green; `promote-dev` and `verify-dev` green (22:27–22:36 +10:00).
- Deploy-time setting still open: SYSTEM `text.externalGuardrail.timeoutS` reads **10** in the cluster DB (checked 2026-09-24 after the deploy); it must go to 75 through the admin console (audited, cache-invalidating), not by SQL.

## 11. Change history

| Date | Change |
|---|---|
| 2026-09-25 | **Correction:** the three cloudflared alerts (L-TUN) were NOT active after the 2026-09-24 deploy — Prometheus in hope-v2-dev never reloads a Git-changed rule file by itself (plain ConfigMap volume, no reloader). Loaded 2026-09-25 23:34Z via `POST /-/reload` (verified in `/api/v1/rules`); durable fix is a deployment-repo follow-up. |
| 2026-09-24 | Pushed and deployed: stale-override promotion (tree-identical history rewrite), pipeline #1327 green incl. `verify-dev`; guardrail timeout setting still 10 pending the console write. |
| 2026-09-24 | Owner **go**: all ODs as recommended; amendments OD-3 (full-stream storage), OD-6 (no routing, agent chain only; verified already true), OD-7 (5 min; verified live). ALaaS lanes merged into one; 8 lanes. |
| 2026-09-24 | Ticket opened. Incident triaged from Grafana (Loki/Prometheus/Tempo) and Rancher; discovery by six read-only agents (`sonnet`: client SDK, gateway, STT+text/guardrail, harness, cloudflared research, ALaaS broker), findings spot-checked live (DELETE-204 then `teardown_stash_unclaimed`; Traefik client IP; Tempo stop trace). Plan and ODs written; awaiting go. |
