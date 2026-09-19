# D7 — Observability & Evaluation: design dossier

TASK-985 realtime transcription review, area D7 (observability + evaluation). Design only — no
code changed by this dossier. Verified against `dev-2.2` in the worktree
`agent-transcription-coordination-9dbc25` (= `3f9145a98`) and `hope-v2-deployment@main` (`68833de`,
TASK-989, merged **after** the TASK-985 review was written — several M-21 gaps are already closed;
see §7).

Findings covered: M-03, M-11, M-12, M-15, M-16, M-18, M-19, M-20, M-21, M-42, M-43 (server half),
M-44, M-45, M-67; BP-1, BP-5, QW-12, ST-4; OD-M.

---

## 1. The metric contract

This is the wire other lanes build against. Every new series is additive; nothing existing is
renamed (dashboards on `dev-2.2`/TASK-989 already query `stt_streaming_rtf`,
`stt_streaming_inference_latency_seconds`, `stt_streaming_inference_queue_dropped_total`,
`stt_streaming_script_mismatch_total`, `stt_streaming_sessions_active`,
`stt_streaming_sessions_total` — do not touch their names or label sets).

### 1.1 New STT-side series (`apps/stt/src/stt/core/metrics.py`)

| Name | Type | Labels (bound) | Unit | Emitted at | Closes |
|---|---|---|---|---|---|
| `stt_streaming_utterances_total` | Counter | `is_final` (2: `true`/`false`), `engine` (≤6: `whisper_cpp`, `faster_whisper`, `ct2`, `cloud_asr_sarvam`, `cloud_asr_openai`, `unknown` — the `resolve_asr_engine()` enum already used at `session_manager.py:2407`), `reason` (≤5: `max_duration`, `semantic`, `silence_timeout`, `force_flush`, `recovery` — see §1.4) | count | `preprocessor.py` at every `_emit_utterance()` call site (::513 force-emit, ::568/::572 semantic/timeout emit, ::~727 flush-triggered) via a new `record_utterance(is_final, reason)` helper the preprocessor calls with the `engine`/`pipeline_id` it already holds; the STREAMING inference layer (`inference.py`) increments the SAME counter for the decode-side `is_final` split if a partial gets suppressed before reaching the preprocessor's emit (keep it to ONE call site — the preprocessor — to avoid double counting) | M-45 (denominator for script-mismatch and queue-drop ratios) |
| `stt_model_load_latency_seconds` | Histogram | `model` (bounded by resident AiModel slugs, single low tens), `engine` | seconds, buckets `[0.5,1,2.5,5,10,30,60,120]` (already declared, dead — reuse) | `apps/stt/src/stt/models/cache.py:467`, wrapping `await loader.load(model_config)` in `_load_by_slug` with `time.perf_counter()` | M-19 (dead metric), QW-4 measurement |
| `streaming_session_finished` (function) → `stt_streaming_sessions_total{status="finished:<x>"}` — **see §1.2, do NOT add a new metric name; wire the existing series correctly instead** | Counter | `status` (≤4: `closed`, `recovered`, `reaped`, `failed` — reuses the existing `STREAMING_SESSIONS_TOTAL` Counter already labelled `status`) | count | `session_manager.py:_finalize_session_locked` (normal path, after `record_streaming_teardown`, ~:4222), the reaper block (~:4746, success and exception branches) | M-19 (empty-series SLO query) |
| `stt_streaming_lock_wait_seconds` | Histogram | `model` (bounded, same set as model_load), `engine` (constant `whisper_cpp` for this adapter — a faster-whisper/CT2 adapter would add its own constant) | seconds, buckets `[0.001,0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2.5]` | `apps/stt/src/stt/streaming/whisper_cpp_asr.py:465`, wrapping the `with self._lock:` acquire (`time.monotonic()` before, observe the delta right after acquisition, before `_decode_spans_locked`) | M-26 (concurrency curve needs a lock-contention signal) |
| `model_inference_latency_seconds{service="stt",model=<slug>}` (existing shared contract — **relabel `STREAMING_INFERENCE_LATENCY`'s call site, do not add a series**) | — | — | — | `inference.py:873`: replace the bare `observe_streaming_inference(_elapsed)` with `with track_model_inference(self._active_pipeline_id or "unknown"):` around the `self._asr_pipeline(...)` call (or call both — see §2) | M-20 (no engine/model label on streaming inference latency) |
| `stt_ingest_lag_seconds` | Histogram | none (session-scoped signal, no label needed — see cardinality note §3) | seconds, buckets `[0.05,0.1,0.25,0.5,1,2.5,5,10]` | `session_manager.py:3293` `_on_frame`, first line: `INGEST_LAG.observe(max(0.0, time.time() - frame.ts))` — `AudioFrame.ts` already carries the gateway-forward epoch time (`schemas.py:70`; its docstring wrongly says "client-side timestamp" — new defect, see §8) | M-03 (ingest-lag) |

### 1.2 `stt_streaming_sessions_total{status}` — fix, don't add

`STREAMING_SESSIONS_TOTAL` (`metrics.py:75-79`) already has the right shape (`Counter`, one label
`status`); the only emitter (`streaming_session_started`, `metrics.py:322`) always writes
`status="started"`. `streaming_session_ended` (`:328`) only syncs the active gauge — it never
increments the counter for a *finished* label value. Fix: add a `streaming_session_finished(status:
str) -> None` helper (`STREAMING_SESSIONS_TOTAL.labels(status=status).inc()`) and call it once per
terminal outcome:

- `status="closed"` — the normal path, beside the existing `record_streaming_teardown(...,
  status="closed", ...)` call at `session_manager.py:~4222`.
- `status="recovered"` — the crash-restart branch already identified in the same function
  (`elif engine is not None and deployment is not None:`, the "RECOVERED session" comment, ~:4189).
- `status="reaped"` — the reaper block (~:4746), success branch (`teardown_summary =
  await self._finalize_session(session)` succeeds).
- `status="failed"` — the reaper's `except Exception` branch (~:4768, "Failed to reap session
  gracefully; forcing removal") and any `remove_session` call that runs without a prior
  `_finalize_session` (a session torn down before any teardown summary could be built).

This gives the SLO doc's `sum(rate(stt_streaming_sessions_total{status=~"closed|recovered|reaped"}[5m]))
/ sum(rate(stt_streaming_sessions_total{status="started"}[5m]))` a non-empty numerator for the
first time.

### 1.3 New gateway-side series (`apps/api`, new file `apps/api/src/observability/stt-metrics.ts`, following the existing `prom-client` + `register.getSingleMetric(...) ?? new X(...)` idempotent-registration pattern already used in `apps/api/src/observability/metrics.ts`)

| Name | Type | Labels (bound) | Unit | Emitted at | Closes |
|---|---|---|---|---|---|
| `stt_gateway_first_partial_seconds` | Histogram | `agentSlug` (bounded — number of published SPEECH_TO_TEXT agents per tenant, capped low tens platform-wide) | seconds, buckets `[0.25,0.5,1,1.5,2,3,5,10]` | `stt-ws.gateway.ts`, inside `forwardAudioFrame` (~:1334) set `session.firstFrameForwardedAt ??= Date.now()` on first call; inside `relayResult` (~:944), on the first `msg.isFinal !== true` transcript of the session, observe `(Date.now() - session.firstFrameForwardedAt) / 1000` and set a `session.firstPartialObserved = true` latch so it fires once | M-03 (`first_partial_seconds`) |
| `stt_gateway_commit_latency_seconds` | Histogram | `agentSlug` | seconds, buckets `[0.5,1,1.5,2,3,4,5,7.5,10,15]` | `stt-ws.gateway.ts`, `forwardAudioFrame`: push `{audioSec: session.audioBytesForwarded / (sampleRate*2), atMs: Date.now()}` onto a bounded ring `session.audioClockSamples` (cap 200, same eviction pattern as `resumeBuffer` at ~:1117) on every Nth frame (throttle to ~1/100ms of audio, not every frame, to bound array growth without losing precision); `relayResult`, on `msg.isFinal === true` with a numeric `endTime`, binary-search `audioClockSamples` for the closest sample ≤ `endTime` and observe `(Date.now() - sample.atMs) / 1000` | M-03 (`commit_latency_seconds`) |
| `stt_gateway_audio_egress_dropped_total` | Counter | `kind` (2: `partial`, `final`) | count | `relayResult` (~:948, ~:968), wherever `session.droppedPartialResults++` / `session.droppedFinalResults++` currently only feed the disconnect log line (~:1135-1140) | M-03, M-43 (egress drop is a log field only) |
| `stt_gateway_audio_ingest_dropped_total` | Counter | none | count | `forwardAudioFrame`'s `.catch()` (~:1349), beside `session.droppedAudioFrames++` | M-03, M-67 (client-side drops never reach the server — this closes the SERVER half; the CLIENT-reported count from M-67's `client_stats` frame is a separate series, see §3 cardinality note) |
| `stt_gateway_ingest_lag_seconds` (relay lag on `stt:audio`, gateway → STT) | — deferred to STT-side `stt_ingest_lag_seconds` above; do not duplicate — the gateway has no visibility into when STT actually reads the frame, only when it wrote it | — | — | — | — |
| `stt_gateway_relay_lag_seconds` | Histogram | none | seconds, buckets `[0.01,0.025,0.05,0.1,0.25,0.5,1,2.5]` | `streamingAudioBridge.service.ts`, `readResultStream`'s parse loop (~:750): `const entryMs = Number(entryId.split('-')[0]); RELAY_LAG.observe(Math.max(0, Date.now() - entryMs) / 1000)` — uses the Redis Stream entry id's own millisecond component, no wire-format change needed | M-03 (relay-lag) |
| `inferenceMs` on the transcript frame | wire field (not a Prometheus metric) | — | ms | `streamingAudioBridge.service.ts` `subject.next({...})` (~:822): add `...(data.inference_ms ? { inferenceMs: parseFloat(data.inference_ms) } : {})` — the field is already written by STT (`schemas.py:195`) and parsed off `data` into the bridge's local scope but dropped before construction of `StreamingTranscriptMessage` | M-03 ("`inferenceMs` is stripped by the bridge") |

### 1.4 `reason` / `endpoint_reason` enum (shared STT-side constant)

Closed set, defined once (e.g. `preprocessor.py` module constants, mirroring the existing
`semantic_endpointer.py` `REASON_*` constants):

| Value | Fires when |
|---|---|
| `max_duration` | `preprocessor.py:513` force-emit (utterance hit `_max_utterance_frames`) |
| `semantic` | `_should_semantic_endpoint()` returned `True` (`preprocessor.py:568`) — the ONLY `EndpointDecision.reason` value that can pair with `should_endpoint=True` is `REASON_ENDPOINT` (`semantic_endpointer.py:64`), so this branch never needs the underlying sub-reason to stay bounded |
| `silence_timeout` | fixed-timer backstop, `state.silence_frames >= self._min_silence_frames` (`preprocessor.py:572`) |
| `force_flush` | tail flush at session stop (`_flush_final_utterance`) |
| `recovery` | crash-recovery single-segment reconstruction (no live preprocessor emit) |

Use this SAME enum for `stt_streaming_utterances_total{reason}` (§1.1) and for the log line
`stt.streaming.utterance.closed` (new, INFO, one per utterance — see §6). Do NOT surface
`EndpointDecision.reason`'s other 6 values (`disabled`, `no_hypothesis`, `too_short`,
`below_silence_floor`, `incomplete_trailing_filler`, `low_confidence`) as a metric label — they are
per-FRAME "why not yet" decisions inside the 300ms partial cadence, effectively unbounded in volume
and PHI-adjacent-free but noisy; if M-39's cut-reason telemetry is wanted at that granularity, use a
Counter (not a label) keyed on the SAME closed 7-value set, separate from the utterance-level
`reason` above.

---

## 2. M-19 — dead metrics: wire or delete

| Metric | Verdict | Why |
|---|---|---|
| `VAD_SEGMENTS_DETECTED`, `VAD_PROCESSING_LATENCY` (`metrics.py:164,169`) | **Delete.** | Confirmed dead by grep — defined, never `.inc()`/`.observe()`'d anywhere in `apps/stt/src`. VAD latency is ALREADY covered by the generic `model_inference_latency_seconds{service="stt",model="silero-vad-v5"}` via `track_model_inference("silero-vad-v5")` (`vad/silero_service.py:158`) — a second, VAD-specific histogram would duplicate that signal under a different name. `VAD_SEGMENTS_DETECTED` has no natural call site: the preprocessor's own onset/offset logic decides speech segments (§1.4's `reason` enum), so a redundant "VAD segment" counter would double-count against `stt_streaming_utterances_total`. |
| `MODEL_LOAD_LATENCY` (`:143`) | **Wire.** | See §1.1 — real gap, real call site (`cache.py:467`), and it is the ONLY latency signal for the M-17 cold-start story (session-create p95 vs warm p95 currently has no server-side latency breakdown, only the gateway's end-to-end `durationMs`). |
| `MODEL_CACHE_HITS`, `MODEL_CACHE_MISSES` (`:150,155`) | **Delete.** | Confirmed dead. Fully superseded by the SHARED `model_cache_loads_total{cache}` / `model_cache_evictions_total{cache,reason}` / `model_cache_resident_models{cache}` contract (`build_model_cache_metrics_sink()`, wired into every `ModelCache` at `models/cache.py:302`) — that sink is the FIXED cross-service contract the `model-retention.json` dashboard reads; a second hit/miss counter under a different name would be a second source of truth for the same fact and would NOT appear on that dashboard. |
| `STREAMING_SESSIONS_TOTAL{status}` | **Fix (not delete, not "wire as new").** | See §1.2 — the metric exists and is scraped; only the `finished` half of its label space was never written, so `sum(rate(...{status="closed"}[5m])) / sum(rate(...{status="started"}[5m]))`-shaped SLO queries divide a series that is either absent or permanently zero on the numerator. |

---

## 3. Cardinality risks

| Label | Series carrying it | Bound | Why safe |
|---|---|---|---|
| `engine` | `stt_streaming_utterances_total`, `stt_streaming_rtf` (existing), `stt_streaming_audio_duration_seconds` (existing), lock-wait | ≤6, closed enum from `resolve_asr_engine()` | Format-derived, not free text; new engines are a code change, not runtime data |
| `model` / `model_slug` | `stt_model_load_latency_seconds`, `model_inference_latency_seconds`, lock-wait | Low tens | Bounded by resident `AiModel` rows platform-wide, same bound the EXISTING `model_running_instances{service,model}` already accepts — no new risk class |
| `reason` (utterance) | `stt_streaming_utterances_total` | 5, closed enum (§1.4) | Enumerated in code, not derived from free text or exception messages |
| `status` | `stt_streaming_sessions_total` | 4 (`closed`,`recovered`,`reaped`,`failed`) plus the existing `started` = 5 total | Enumerated at the 4 call sites listed in §1.2 |
| `agentSlug` | gateway `first_partial_seconds`, `commit_latency_seconds` | Low tens per tenant, but **unbounded ACROSS tenants** if used raw | **Risk.** Use the AGENT's platform-wide slug only if slugs are globally unique and the count of distinct SPEECH_TO_TEXT agents stays in the tens (true today per the cloned-per-tenant content model in `00-project-context.md` — every tenant clones the SAME small SYSTEM reference set, so slugs repeat across tenants rather than multiplying). If a tenant is ever allowed a fully custom agent slug, drop this label to a constant `agent="stt"` or bucket by `pipeline_id` prefix instead — do NOT label by raw `tenantId` (PHI-adjacent, matches the existing "no tenant label" rule on `STREAMING_AUDIO_DURATION`) or by the full agent UUID (unbounded, one series per session-worth of history) |
| `kind` (`partial`/`final`) | `stt_gateway_audio_egress_dropped_total` | 2 | Fixed enum |
| none | `stt_ingest_lag_seconds`, `stt_gateway_relay_lag_seconds`, `stt_gateway_audio_ingest_dropped_total` | n/a | Deliberately UNLABELLED — matches the existing `STREAMING_INFERENCE_QUEUE_DROPPED_TOTAL` precedent (`metrics.py:126`, comment: "unlabeled on purpose"); a per-session or per-tenant label on a transport-timing histogram is both a cardinality risk and adds nothing a log line + trace span (§6) doesn't already give at session grain |
| `tenant` (existing, `STT_PROVIDER_SWITCH_TOTAL`) | pre-existing, not touched by this dossier | number of active tenants | Flag only: this is the ONE existing STT metric with a raw tenant label; do not copy this pattern onto any NEW series in §1 — it predates the "no tenant label" convention stated beside `STREAMING_AUDIO_DURATION` and is out of this dossier's scope to fix |

---

## 4. BP-1 baseline fingerprint

Structured fingerprint schema (JSON), read FROM the session the harness opened (via the STT
`stt.streaming.windows` log line extended, see below — never re-derived from the seed, which is
exactly the class of bug M-15 documents: `_note` fields drift because nothing forces them to match
what ran):

```json
{
  "agentVersion": "<Agent._version at session open>",
  "modelSlug": "<AiModel.slug>",
  "modelDigest": "<sha256 or ETag of the GGUF file, from the s3fs-resolved AiModel row>",
  "maxDecodeWindowSec": 7.0,
  "partialWindowSec": 3.0,
  "partialIntervalMs": 300,
  "endpointing": "semantic",
  "vadEnabled": false,
  "promptHash": "<sha256 of the composed pair+agent initialPrompt string>",
  "engineBuild": "<whisper.cpp commit / GGML_CUDA flag / CUDA arch, from build-info.json>",
  "device": "cuda|mps|cpu",
  "sdkOperatingPoint": "harness|scribe|playground"
}
```

- **Read from the session, not the seed.** Extend the existing `stt.streaming.windows` INFO log
  (`session_manager.py:779-785`) — already logs `session_id`, `model_slug`, `partial_window_s`,
  `max_decode_window_sec` once per session — into a `stt.streaming.fingerprint` event carrying the
  full schema above, at the SAME call site (it already has `pipeline_config`, `inference_cfg`, and
  `vad_enabled` in scope). The harness reads this ONE log line (via its existing log-capture path
  used for `stt.streaming.windows` today) instead of re-reading `_metadata.asr` off the agent row —
  that is the mechanism that makes "what ran" and "what the baseline recorded" the same fact by
  construction, closing M-15's root cause rather than just re-capturing once.
- **`assert_no_regression` skip-with-reason.** `test_streaming_quality_scorecard.py` compares the
  captured fingerprint (stored beside each baseline entry) to the session's own
  `stt.streaming.fingerprint` line; on ANY field mismatch, the assertion function
  (`assert_no_regression`) returns a skip (pytest `pytest.skip(reason=...)`, not a pass and not a
  fail) naming the mismatched field(s), e.g. `"fingerprint mismatch: partialWindowSec 3.0 != baseline 15.0"`.
  This directly replaces the current failure mode (a gate that silently compares two different
  configurations and calls it a regression or a pass).
- **Replace `_note` with the fingerprint object.** The free-text `_note` fields in
  `streaming_thresholds.json` / `mlen_scorecard_baseline.json` are the M-15 mechanism (hand-edited,
  drift from the header on every re-capture that forgets to touch it too) — the fingerprint object
  is machine-written by the harness at capture time and machine-compared at run time; no human
  transcription step exists in the loop that could drift.

---

## 5. M-11 gate shape / ST-4 statistics

| Current | Redesign |
|---|---|
| N=3, single-final clips, hand-widened epsilon (e.g. 0.40 on commit p50) to stop a real TASK-934-scale regression from failing | **N≥5** per fixture, quiet stack (`sessions_active=0`, model pre-warmed by a throwaway session, no LM Studio load — same environment-control clause as §4) |
| One pooled statistic per metric, epsilon chosen after seeing the spread | **Median + 2×MAD** as the default robust-to-outlier gate (cheap, no bootstrap dependency); **bootstrap CI (B≥1000, resampled BLOCKWISE — i.e. resample whole per-clip runs, not individual frames, to respect the within-run autocorrelation of a streaming session)** wherever a baseline COMPARISON is claimed (a "is this worse than baseline" verdict, not just "is this in range") |
| No split between the stop-flush transient and steady state | **Two gate classes**: (a) short clips (current 3, single-final, ≤25s) stay as a STOP-FLUSH regression check — these ARE expected to be noisier (one final IS the whole utterance, so `committed_revision_rate` is near-degenerate); (b) new ≥60s multi-final clips (ST-4/QW-12 fixture) become the STEADY-STATE gate with tighter bounds, because they average over many commits and are not dominated by the cold-open/tail-flush transient |
| `medical_wer` only, no term-restricted variant | **`term_restricted_wer`** (MedWER shape, F9-K4): errors scored ONLY on a fixed drug/diagnosis/symptom term list, reported with its own 95% bootstrap CI — this is the metric clinicians actually care about (a missed "atorvastatin" matters more than a missed "the") |
| CER computed offline only, not part of the streaming gate | **CER as PRIMARY for Malayalam/code-switch** (F9-E2: better correlation with human judgment than WER on Malayalam), `medical_wer` stays primary for English fixtures |
| `committed_revision_rate` can be vacuously 0.0 (today's run: PASS but meaningless when no partial ever carries `stableChars > 0`) | Gate must ASSERT the denominator is non-zero (at least one partial with `stableChars > 0` across the run) before treating a 0.0 revision rate as a pass — otherwise it's an untested code path reporting a green result, exactly the class of bug the `committed_revision_rate` skip-`stableChars=0`-tails logic already half-handles for individual utterances but not for a whole-run vacuous case |

---

## 6. QW-12 nightly gate

- **Job**: `stt-quality-gate` in `.gitlab-ci.yml` / `.gitlab/ci/test.yml`, **opt-in** via
  `RUN_INFRA_TESTS` (matches the existing opt-in convention for GPU-runner jobs), scheduled nightly
  (GitLab CI schedule, not `rules: changes:`) AND required manually on any commit touching seed
  `streaming.*` / `_metadata.asr` fields (a pre-merge CI comment/checklist item, since a schedule
  alone would let a bad geometry change merge and only be caught the following night).
- **What it runs**: the WS-gateway streaming scorecard (English + ml-en fixtures from §5/ST-4),
  the loss harness (incl. mid-clip close, QW-11), the stop-after-speech tail test, the room-tone
  test (BP-7), the concurrency curve (BP-6). Artifacts: the scorecard JSON files (including each
  run's captured `stt.streaming.fingerprint`), uploaded with `expire_in: 30 days` like the existing
  `junit-stt.xml` artifact pattern in `test.yml`.
- **Geometry-parity unit test** (CI-blocking, runs in the FAST `test-stt` unit lane, not the nightly
  GPU job): a new `test_seed_geometry_parity.py` reads the committed
  `streaming_thresholds.json` / `mlen_scorecard_baseline.json` fingerprints and the LIVE seed file
  (`packages/database/src/prisma/db_main/seed/25-agents.ts` — read at parse time, not against a
  live DB) and FAILS if any `streaming.*` / `_metadata.asr` field on the served agent differs from
  the baseline's recorded fingerprint. This is what makes an ungoverned geometry edit (the
  `e3d61eefb` / `ea174814e` pattern M-16 names) visible at PR time instead of only on the next
  nightly run.
- **Fix the two stale doc/config facts this finding names**: `.gitlab/ci/test.yml:565`'s
  `test-stt` job explicitly `--ignore=tests/integration/` — the new nightly job must NOT simply
  remove that ignore from the fast lane (integration tests need live GPU + model weights, wrong for
  a per-commit unit gate); it is a SEPARATE job. `docs/operations/testing/ci-gates.md:46` still
  lists `test-stt` as fully advisory with no mention of the new nightly job — update that table to
  add the `stt-quality-gate` row (nightly, GPU-runner, opt-in `RUN_INFRA_TESTS`, blocking within
  its own scheduled pipeline but not part of the per-MR advisory set) and to note that the geometry
  parity unit test (unlike the rest of `test-stt`) IS blocking because it runs in a different,
  already-blocking lane if promoted, or stays advisory-but-loud (a distinct named CI check) if the
  owner does not want to promote all of `test-stt` — this is a decision this dossier surfaces, not
  makes.

---

## 7. M-44 log hygiene

- **Root cause, corrected location**: the finding cites `middleware/logging.py:27`, which does not
  exist under that path. The actual emitter is the SHARED `AccessLogMiddleware` in
  `packages/py-obs/src/hope_obs/middleware.py` (`logger.info("request.start", ...)` and
  `logger.info("request.complete", ...)` unconditionally for EVERY request — confirmed by reading
  the class: no path exclusion exists for `/api/v1/health`, `/metrics`, or k8s probe paths). Because
  this is the SHARED `hope_obs` contract (`06-python-services.md`: "observability is `packages/py-obs`
  and nothing else"), the fix belongs THERE, not in a per-service STT-only middleware — it benefits
  all six Python services identically and avoids re-introducing a service-local logging path the
  rule explicitly bans.
- **Probe-path exclusion**: `AccessLogMiddleware.__init__` gains an `exclude_paths: frozenset[str]`
  (default `{"/api/v1/health", "/api/v1/health/live", "/api/v1/health/ready", "/metrics"}`),
  checked once against `scope["path"]` before either `logger.info` call. This is a constructor
  parameter, not a new env var (per the "no hardcoded configuration... env is bootstrap floor only"
  rule, an actual PATH LIST for health probes is closer to a code constant than a tenant-facing
  config value — it never varies by tenant or deployment — so a literal default here is defensible;
  if a service ever needs a different set, it passes its own at construction, no DB/env round trip
  needed for a build-time routing fact).
- **`urllib3` pinned to WARNING**: `apps/stt`'s S3/MinIO client (boto3/s3fs) logs at INFO through
  `urllib3.connectionpool` by default; pin `logging.getLogger("urllib3").setLevel(logging.WARNING)`
  once at `main.py` startup (the same place `HF_HUB_OFFLINE=1` and other startup-only settings
  already live).
- **`STT_LOG_LEVEL=info` (bare name, matching `STT_DATABASE_ENABLED`'s no-`env_prefix` precedent in
  `06-python-services.md`)**: a per-service override so `LOG_LEVEL=debug` at the deployment-repo
  overlay level (cited as the source of the current chatter) does not force STT's OWN loggers to
  DEBUG; STT reads its own level first, falling back to the shared `LOG_LEVEL`.
- **Child span per utterance**: `stt.stream.utterance`, opened at utterance start (first frame
  after `_emit_utterance`'s preceding onset) and closed at commit/emit, carrying `session_id`,
  `utterance_index`, `reason` (§1.4), `inference_ms` — NO transcript text (matches the
  `semantic_endpointer.py` PHI-hygiene precedent: "logs reasons, word counts... never carries
  transcript text"). This rides the SAME OTel trace context already propagated gateway → Redis
  audio → STT → Redis result at no per-frame cost (`stt-ws.gateway.ts:745`,
  `redis_streams.py:250-283,490-504`) — a new SPAN under the existing trace, not a new propagation
  mechanism.

---

## 8. M-21 dashboard and alerts

**Materially changed since the TASK-985 README was written.** `hope-v2-deployment@main` commit
`68833de` ("feat(task-989): HOPE Platform dashboard... + observability hardening") already ships:

- `deployment/k8s/base/dashboards/platform.json`: panels for `stt_streaming_sessions_active`,
  `stt_streaming_sessions_total` (rate), `stt_streaming_rtf` p50/p95 by `engine`,
  `stt_streaming_inference_latency_seconds` p50/p95, `stt_streaming_audio_duration_seconds` p50/p95
  by `engine`, `stt_streaming_inference_queue_dropped_total` (rate), `stt_streaming_script_mismatch_total`
  (rate), and a session-termination-reason panel PARSED FROM THE GATEWAY FINALIZE LOG (not a
  metric).
- `deployment/k8s/base/alert-rules.yaml`, group `stt_realtime` (~:981-1013): `SttRealTimeFactorAboveOne`
  (RTF p95 > 1 over a 15m window, `for: 10m`, `severity: page`), `SttTranscriptUtterancesDropped`
  (`increase(stt_streaming_inference_queue_dropped_total[10m]) > 0`, `severity: page`),
  `SttScriptMismatch` (`increase(stt_streaming_script_mismatch_total[15m]) > 0`, `severity: ticket`).

**What is still genuinely missing (this dossier's scope):**

1. No panel/alert for `first_partial_seconds` / `commit_latency_seconds` / relay-lag / ingest-lag —
   none of these series exist yet (§1.3), so TASK-989 could not have covered them. Add a new
   "STT — Latency Budget" row to `platform.json` once §1.3 ships.
2. **The two existing alerts are absolute-count, not ratio, BECAUSE M-45's denominator did not
   exist at TASK-989 time** — `SttTranscriptUtterancesDropped` and `SttScriptMismatch` fire on
   `increase(...) > 0` rather than a percentage of utterances, which is blunter than this dossier's
   original ask ("mismatch ratio > 5%/h") and than M-21's own recommendation. This is direct,
   dated evidence that M-45 is a real prerequisite, not a nice-to-have: once
   `stt_streaming_utterances_total` (§1.1) exists, upgrade both alerts to
   `sum(increase(stt_streaming_script_mismatch_total[1h])) / sum(increase(stt_streaming_utterances_total{is_final="true"}[1h])) > 0.05`
   shape, and correspondingly retune `SttRealTimeFactorAboveOne`'s threshold — this dossier's
   original recommendation (p95 > 0.8 over 10m) is TIGHTER than the shipped 1.0/15m; treat 0.8/10m
   as the target for a follow-up tune once real RTF distribution data exists under the corrected
   geometry from BP-1/BP-2.
3. **DCGM is still never joined to the STT workload.** `deployment/k8s/base/dashboards/gpu.json`
   queries `DCGM_FI_DEV_*{gpu=~"$gpu"}` by physical GPU index/`modelName` only — no `pod`/`container`
   label, and neither `platform.json` nor `alert-rules.yaml` joins DCGM series to
   `model_running_instances{service="stt"}` or `stt_streaming_rtf`. A GPU-contention explanation for
   an RTF spike (LM Studio and STT share the same time-sliced cards per `09-infrastructure-devops.md`)
   still requires a human to cross-reference two dashboards by eye. Recommended join (once DCGM
   exports a pod label, which requires the GPU-operator's pod-resource mapping to be enabled — an
   infra-side change out of this dossier's scope): `DCGM_FI_DEV_GPU_UTIL * on(pod) group_left()
   kube_pod_labels{label_app="hope-stt"}`.

---

## New defects

| Claim | Evidence | Severity | Suggested fix |
|---|---|---|---|
| `AudioFrame.ts`'s docstring says "client-side timestamp" but the value is written by the GATEWAY at forward time (`Date.now() / 1000` in `streamingAudioBridge.service.ts` `writeAudioFrame`, ~:293), not by the browser | `apps/stt/src/stt/streaming/schemas.py:70` vs `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts:293` | low | fix the docstring; if a TRUE end-to-end capture-to-ingest latency is ever wanted, the browser would need to stamp its own send time on the binary WS frame, which is a wire-format change out of this dossier's scope |
| `stt_streaming_utterances_total` risks double-counting if wired at BOTH the preprocessor's emit sites AND anywhere in `inference.py` that also "counts" an utterance (e.g. a future QW-9/QW-10 repeat-guard instrumentation) | design risk, not yet in code — flagging before another lane wires a second increment site | low | this dossier fixes the call site to ONE place (`preprocessor.py`'s `_emit_utterance` family); any lane adding decode-time (post-ASR) counters must key off a DIFFERENT metric name, not increment this one a second time |
| `MODEL_CACHE_HITS` / `MODEL_CACHE_MISSES` and `model_cache_loads_total{cache}` are two DIFFERENT metric families measuring overlapping facts under different names, and only one (`model_cache_loads_total`) is wired — a future contributor re-wiring the dead pair instead of reading the shared-sink contract first would create a second, disagreeing source of truth | `apps/stt/src/stt/core/metrics.py:150-160` vs `:375-382` (`build_model_cache_metrics_sink`) and `apps/stt/src/stt/models/cache.py:302` | low | delete the dead pair (§2) rather than wire it, closing the ambiguity permanently |

## Confirmed / refuted (file:line)

- M-03 "gateway registers no STT series" — confirmed: `grep -n "Counter\|Histogram\|Gauge" apps/api/src/modules/streaming/stt-ws.gateway.ts` returns nothing.
- M-03 "inference_ms is stripped by the bridge" — confirmed: `apps/stt/src/stt/streaming/schemas.py:195` writes it to Redis; `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts` parses `data.*` fields (~:750-822) but the `subject.next({...})` object omits `inference_ms`/`inferenceMs` entirely.
- M-03 "drop counters are log fields" — confirmed: `apps/api/src/modules/streaming/stt-ws.gateway.ts:1135-1140` logs `droppedAudioFrames`/`droppedPartialResults`/`droppedFinalResults` only inside `this.logger.log(...)` at `handleDisconnect`.
- M-19 dead metrics — confirmed by grep: `VAD_SEGMENTS_DETECTED`, `VAD_PROCESSING_LATENCY`, `MODEL_LOAD_LATENCY`, `MODEL_CACHE_HITS`, `MODEL_CACHE_MISSES` each appear ONLY at their `metrics.py` definition line, no call site anywhere under `apps/stt/src`.
- M-19 "`sessions_total` only ever says `started`" — confirmed: `streaming_session_started` (`metrics.py:322`) is the only call incrementing `STREAMING_SESSIONS_TOTAL`; `streaming_session_ended` (`:328`) touches only the gauge.
- M-16 `.gitlab/ci/test.yml:565` — confirmed: `--ignore=tests/e2e/ --ignore=tests/integration/ -x`.
- `docs/operations/testing/ci-gates.md:46` — confirmed: `test-stt | pytest | advisory | unit, then tests/ excluding e2e/integration`.
- M-21 "no dashboard/alert covers streaming" — **partially refuted by later work**: `hope-v2-deployment@main` `68833de` (TASK-989, merged after the TASK-985 review) ships a dashboard and an `stt_realtime` alert group covering RTF/queue-drop/script-mismatch. First-partial/commit-latency/lag series and the DCGM join remain genuinely missing — see §7.
- `docs/operations/observability/observability-slos.md` and `observability-oncall.md`, cited by M-03/M-19/M-21 — **not found** at those paths in the live tree (only `python-logging-and-tracing.md` and `README.md` exist under `docs/operations/observability/`); likely archived under `docs/archive/**`, which is off-limits this sprint per `00-project-context.md`. Not re-verified further; treat the live `platform.json`/`alert-rules.yaml` in the deployment repo as the current source of truth over the cited doc paths.
- The `reason` enum for semantic endpointing (`REASON_DISABLED`...`REASON_ENDPOINT`) — confirmed at `apps/stt/src/stt/streaming/semantic_endpointer.py:58-65`; `EndpointDecision.reason` is computed but discarded by its only caller, `preprocessor.py._should_semantic_endpoint`, which reads only `.should_endpoint`.
