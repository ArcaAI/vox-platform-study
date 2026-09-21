# TASK-998 — Realtime Cloud ASR Transcript Coherence (Sarvam Saaras v4)

| | |
|---|---|
| **Status** | Pending — plan awaiting owner decisions (see §5) |
| **Type** | bugfix + feature (transport change) |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-09-21 |
| **Surfaces** | `apps/stt` (streaming), `packages/types` (asr-spec), `packages/database` (seed catalogue), `packages/agentic-sdk-v2`, `packages/ui`, `packages/applications` (summary join) |

## 1. Requirement Analysis

Live consultation transcription on the cloud provider `sarvam-saaras-v4` returns a transcript that
reads as disjointed chunks. The requirement is a transcript that is **smooth, reasonable and
coherent**, and a documented set of best practices for driving a cloud ASR provider in realtime.

"Chunked" turns out to name **five independent defects**, not one. They are separable and have very
different costs, which is why §5 asks for decisions rather than proposing a single fix.

## 2. Current State Evaluation

Investigated 2026-09-21 by four parallel read-only lanes (STT internals, vendor API research,
downstream trace, local-vs-cloud contrast) plus orchestrator verification. Every claim below carries
a `path:line` or a vendor doc URL.

### 2.1 The transport is wrong — and the catalogue already claims otherwise

`sarvam_recognize_utterance` is a **single-shot multipart REST POST** of one WAV per VAD-segmented
utterance (`apps/stt/src/stt/streaming/sarvam_asr.py:113-127`), returning one flat string with
`word_timestamps: []` (`:134`).

Sarvam **does** offer a realtime WebSocket with true in-speech partials:

```
wss://api.sarvam.ai/speech-to-text-realtime/ws?language_code=&lt;bcp47|auto&gt;&model=saaras:v4&mode=codemix
header: api-subscription-key
→ {"event":"audio_input","audio":"<base64>"}      linear16, 16 kHz, mono, ~3200 B / 100 ms
→ {"event":"flush"} | {"event":"end"} | {"event":"ping"}
← session.begin | vad.speech_start | vad.speech_end
← transcript.partial {event,text,language}
← transcript.final   {event,text,language,language_confidence,start_s,end_s}
← config.updated | pong | session.end{audio_duration_s} | error{code,is_fatal,message}
```

Server-side endpointing is tunable per session (`endpointing` `vad|manual`, `threshold` 0.3,
`silence_duration_ms` 500, `min_speech_duration_ms` 250) and `stream_type` trades partial latency
(`fast|balanced|simulated`). Source:
https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming

The seeded catalogue row **already advertises the socket we did not build** —
`packages/database/src/prisma/db_main/seed/ai-models/audio.ts:519` says *"WebSocket streaming"* and
`:537` tags `streaming`; `apps/stt/src/stt/processors/asr_capabilities.py:125` declares
`streaming=True`. The implementation is REST.

**Corrected assumptions.** Two things we believed going in are false: `saaras` is *not* a
translate-only family (it has five modes — `transcribe`/`translate`/`verbatim`/`translit`/`codemix`;
the translate-only `/speech-to-text-translate` on `saaras:v2.5` is deprecated), and `mode=codemix` is
genuinely documented. The mode selected in `sarvam_asr.py:104` is correct. Only the transport is wrong.

### 2.2 The agent's streaming geometry was tuned for a local whisper fine-tune and inherited unchanged

Streaming parameters live on the **agent**, not the model, so pointing `realtime-transcription` at a
cloud model inherits geometry designed for a 7-second-window local GGUF
(`docs/implementation/TASK-994-Codeswitch-ML-EN-Chunk-Geometry-And-Decode-Tuning/README.md:40-44`):
`endpointing 'semantic'`, `maxUtteranceSec 60`, `partialWindowSec 3`, `partialIntervalMs 300`,
VAD off (energy segmenter), `minSilenceMs 350`.

Three of those are actively harmful against Sarvam:

| Knob | Value | Why it harms the cloud engine |
|---|---|---|
| `endpointing: semantic` | on | The endpointer cuts on **terminal punctuation in the partial hypothesis** (`apps/stt/src/stt/streaming/semantic_endpointer.py:69-71`). Whisper partials are largely unpunctuated; **Sarvam returns punctuated text**. The same endpointer that is well-behaved locally becomes a hair-trigger on cloud, chopping at every model-emitted full stop. **This is the primary cloud-specific over-segmentation mechanism.** |
| `maxUtteranceSec: 60` | 60 s | Sarvam's sync REST endpoint caps at **30 s**. Any utterance in 30–60 s is a hard 400 → `CloudASRTranscriptionError` → dropped unless a fallback switch fires. |
| `partialIntervalMs: 300` | 300 ms | Each partial is a **separate full REST POST** on a rolling 3 s tail that starts mid-phrase (`session_manager.py:3854-3938`). Bounded by skip-if-busy (`:3869-3871`) to one in flight, so the real rate is ~1/RTT — but every one of them is a billed, independently-decoded hypothesis that the final then contradicts. |

### 2.3 Nothing assembles the finals — at any layer

| Layer | What it does | Citation |
|---|---|---|
| STT transcript build | `" ".join(...)` over finals, no sentence/gap logic | `apps/stt/src/stt/streaming/session.py:443-456` |
| Cross-segment text rule | Only a ≤3-word **deletion** at the seam within 1 s | `apps/stt/src/stt/streaming/inference.py:1532-1592` |
| The component built to bridge boundaries | **Dead** — `LocalAgreementStreamer` is docstring-marked "EXPERIMENTAL — NOT WIRED", measured as a Malayalam regression and shelved | `apps/stt/src/stt/streaming/local_agreement_streamer.py:3-11` |
| SDK store | Append-only array of whole per-utterance objects; never revisited | `packages/agentic-sdk-v2/src/store/agenticStore.ts:599` |
| UI | One `<div>` block per final; no adjacency or speaker grouping | `packages/ui/src/components/live-transcript/transcript-segment.tsx:82-143` |
| Persistence | One `ContextItem` POSTed **per utterance** | `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:878-901` |
| Summarization | `transcripts.map(c => c.content).join('\n\n')` — the LLM sees every fragment as its own paragraph | `packages/applications/src/services/consultation/summary/summary.service.ts:734` |

The merge the platform *already believes in* exists and is wired to **batch only**:
`merge_vad_segments` (`apps/stt/src/stt/transcription/segment_merger.py`, called at
`apps/stt/src/stt/transcription/batch_service.py:1499`), configured by
`stt.segmentMerge.gapThresholdS`. Streaming never got it.

### 2.4 Failures punch unmarked holes

No retry exists at the cloud HTTP layer — one POST, `timeout=120.0`, no backoff
(`sarvam_asr.py:113-127`). A single 5xx or timeout goes straight to `EngineSwitchController`
(`engine_switch.py:46-60`; auth/429 switch immediately, transcription errors after 2 consecutive).
If no switch fires, the utterance is **dropped with only a `logger.error`**
(`session_manager.py:3586-3591`). Other silent drop paths: a full inference queue after a 1 s
enqueue wait (`session_manager.py:4070-4086`) and the hallucination gate blanking a short/quiet
segment (`inference.py:753-761`). Each drop concatenates two non-adjacent blocks with a single space
and no marker.

**Quota exposure is a suspect, not a finding.** Sarvam's sync REST limits are 60/100/4000 req-min
(Starter/Pro/Business — https://docs.sarvam.ai/api-reference-docs/getting-started/pricing). With
skip-if-busy the ceiling is ~1 partial + 1 final per RTT (~60–120 req/min at 1 s RTT), which brushes
Starter and is marginal on Pro. **Which tier the account holds is unknown and must be checked** —
a 429 is an immediate engine switch, and with no fallback that is a silent hole.

### 2.5 Inert config that reports success

- `run_sarvam_inference` **declares** `prompt` and discards it (`session_manager.py:3205-3213`).
  Because the signature declares it, `inference.py`'s signature probe (`:1147-1207`) reports
  "prompt accepted", so the "engine takes no prompt" warning at `:1192-1199` **never fires**, and
  `_compose_bounded_prompt`'s token bisection burns CPU per final for nothing.
- `UNSUPPORTED_DECODE_KNOBS` (`packages/types/src/asr-spec.ts:286-289`) has entries for
  `whisper.cpp` and `faster-whisper` only. An operator setting `initialPrompt`,
  `prevTextContextWords` or `wordTimestamps` on a cloud-backed agent gets **no provenance signal**
  that it did nothing.
- Sarvam returns no word timestamps, so every timing-dependent stage (`inference.py:847-869`) is a
  silent no-op on this path.

### 2.6 Prior art — an acknowledged gap in this evaluation

`docs/archive/**` is denied by this workspace's permission settings, so
**TASK-985 (Realtime Transcription Review And Best Practices)**, TASK-891 and TASK-861 could not be
read directly by the investigation or by the orchestrator. TASK-985 is a prior review of this exact
problem space. What survives is its digest inside the TASK-994 README (sections D2/D3/D4/D9,
M-07/M-34/M-49, QW-3/8/9/13). **This plan should not be executed until TASK-985 is read** — see
decision OD-6.

### 2.7 Landmines from TASK-994 that constrain any fix

- **No prior text in the decode window on the local ml-en fine-tune.** Agent `initialPrompt` cost
  +0.29 CER; `prevTextContextWords` cost −0.117 CER when non-zero. Local-engine-specific *in this
  codebase* (cloud adapters forward no prompt at all), but it means **"add context carryover" is not
  a free win** — if we ever forward Sarvam's `prompt` hint it must be measured, not assumed.
- `audioCtx` multiple of 256; `maxTokens` never capped on Malayalam; the 7 s decode minimum is a
  narrow notch, not a basin. All whisper.cpp-only — **none apply to cloud**, and none should be
  copied across.
- `SttWebSocketClient.DEFAULT_DRAIN_TIMEOUT_MS = 1500` vs a tail final arriving 3–6 s later
  (TASK-991 W2-5) — architecture-general, and a cloud RTT can exceed the same window.

## 3. Root causes, ranked by contribution to "looks chunked"

1. **Semantic endpointing fires on Sarvam's own punctuation** (§2.2) — over-segments at every full
   stop the model emits. Cloud-specific; config-only to disprove.
2. **No assembly layer anywhere** (§2.3) — even perfectly transcribed utterances render, persist and
   summarize as discrete blocks. Engine-independent; would survive a transport fix.
3. **Wrong transport** (§2.1) — no vendor partials, 30 s cap breached, per-utterance overhead, and
   our synthetic partials are independent re-decodes that contradict the final.
4. **Unmarked holes on failure** (§2.4) — drops concatenate non-adjacent speech with a bare space.
5. **Inert config reporting success** (§2.5) — operators cannot see that their tuning did nothing.

## 4. Implementation Plan (proposed — not started)

Sequenced so each phase is independently shippable and independently provable.

### Phase 0 — Config-only mitigations (no code, no contract change)

Re-tune the cloud agent. Provable in one live session, reversible instantly.

| Change | From → To | Closes |
|---|---|---|
| `streaming.endpointing` | `semantic` → `fixed` | RC-1 |
| `streaming.maxUtteranceSec` | 60 → 25 | 30 s REST cap |
| `streaming.partialIntervalMs` | 300 → 1500 (or partials off) | cost + contradiction |
| `postProcessing.punctuation.enabled` | on → off | double-punctuation of already-punctuated text |
| `decoding.prevTextContextWords`, `instruction.initialPrompt` | cleared | they are inert; stop pretending |

**Verification:** one live consultation on the Sarvam agent, before/after transcript captured.

### Phase 1 — Streaming assembly (engine-independent, biggest coherence win)

1. Wire `merge_vad_segments` into the streaming path with a gap threshold, mirroring the batch
   behaviour that already exists — or implement the equivalent at publish time in
   `inference.py`. Reuse `stt.segmentMerge.gapThresholdS`.
2. Replace `" ".join` (`session.py:454`) with a sentence-aware join: normalise whitespace, avoid
   double terminal punctuation, insert a paragraph break only past a silence-gap threshold.
   The parallel span builder (`session.py:458-498`) must stay byte-identical — it asserts a
   one-character separator today.
3. Group adjacent same-speaker segments in `useLiveTranscript`'s `displaySegments` memo so the UI
   renders flowing paragraphs instead of one bubble per utterance.
4. Change the summarization join from `'\n\n'` to the same sentence-aware assembly
   (`summary.service.ts:734`), so the LLM stops seeing fragments as paragraphs.

### Phase 2 — The Sarvam realtime WebSocket engine

1. New `apps/stt/src/stt/streaming/sarvam_realtime_asr.py` owning a persistent WS per session.
2. **This does not fit `StreamingAsrCallable`** (request/response per buffer). A streaming engine
   consumes the audio feed continuously and emits its own partials/finals. It needs a second engine
   shape in `session_manager`, with local VAD segmentation **bypassed** for such engines — Sarvam's
   server-side endpointing replaces it. Denoise/normalize/resample still apply upstream.
3. Map `transcript.partial` → `is_final=False` and `transcript.final` → `is_final=True` on the
   existing `SegmentResult` schema; `start_s`/`end_s` populate the timing fields that are empty today.
4. Reconnect/resume: the socket closes on inactivity (1008) and has no documented resume — send
   periodic `ping`, and on reconnect re-open rather than assuming continuity.

### Phase 3 — Make inert config visible

1. Drop the `prompt` parameter from the cloud callables (or make the probe capability-driven rather
   than signature-driven, `inference.py:1147-1207`) so the existing warning fires.
2. Add `sarvam`/`openai`/`azure` entries to `UNSUPPORTED_DECODE_KNOBS`
   (`packages/types/src/asr-spec.ts:286-289`) — contract change, needs the parity fixture.
3. Correct the catalogue row (`audio.ts:519,537`) so it stops advertising a transport we do not
   implement — or land Phase 2 first and make the claim true.

### Phase 4 — Retry before fallback (contract change)

Add bounded retry-with-backoff for transient cloud failures before `EngineSwitchController` is
consulted. No such concept exists in `ResolvedAsrSpec` today; a new
`decoding.retry{maxAttempts,backoffMs}` field needs the Pydantic mirror in `spec.py` and an update
to `tests/contracts/resolved-asr-spec.fixture.json`. Mark dropped segments in the transcript rather
than closing the gap silently.

## 5. Owner Decisions (answered 2026-09-21)

| # | Decision | Outcome |
|---|---|---|
| **OD-1** | Transport | **(a) WebSocket now** — and for **ALL cloud ASR providers**, not Sarvam alone. |
| **OD-2** | Local VAD for cloud engines | **(a) Disabled entirely.** No HOPE VAD or endpointer on a duplex engine; the vendor endpoints server-side. Signal conditioning (resample / normalise / denoise) still runs — it is not segmentation. |
| **OD-3** | Where assembly lives | **(b) Per-consumer.** The wire stays one message per utterance; the UI and the summarizer each assemble for their own purpose. NOT centralised in `apps/stt`. The orchestrator recommended (a); the owner chose (b). |
| **OD-4** | Vendor quota | Platform admin sets **per-minute volume by enabled provider**, globally OR for a specific tenant, for tenants on **Pro plan and above**. See the scope note below. |
| **OD-5** | Catalogue text | **(a) Correct it now**, for all cloud providers. |
| **OD-6** | TASK-985 prior art | **(b) Do not consult it** — it covers the local whisper / built-in engine, not the cloud plane. (It is also denied by workspace permissions.) The §2.6 gap is therefore accepted deliberately, not an oversight. |
| **OD-7** | Ticket number | **TASK-998** confirmed. |

### OD-4 scope note — the requirement is implemented in two dimensions

"Per-minute volume" is the correct control for the REST architecture this ticket is
replacing; it does not bind on the one being built. A live consultation under duplex is **one
persistent WebSocket for the whole session**, not N requests per minute, and the vendor's
streaming ceiling is a different quantity: Sarvam documents **20/100/100 concurrent
connections** by account tier against **60/100/4000 requests per minute** for sync REST
(https://docs.sarvam.ai/api-reference-docs/getting-started/pricing).

Per-minute volume still genuinely binds, because **batch transcription stays on REST** and is
untouched by this ticket. So both dimensions ship on one plane, one counter infrastructure and
one admin surface:

| Dimension | Binds on | Enforced at |
|---|---|---|
| `requestsPerMinute` | batch / REST transcription | batch job creation |
| `maxConcurrentStreams` | live duplex sessions | streaming session open |

Both are per enabled provider (`CLOUD_BYO_PROVIDERS.stt`), resolve **tenant → SYSTEM** on
absence, and are written only by a platform admin. "Pro and above" is an eligibility BOUND on
whether a tenant may hold its own allocation — a sub-Pro tenant falls back to the platform
default, never to zero. Enforcement lives in `packages/applications`; `apps/stt` gains no
database read (`06-python-services.md` — the STT service is spec-driven, no DB on the agent path).

### Standing constraints carried into implementation

- The Sarvam **account tier is Pro or above** (owner, OD-4), so the sync-REST ceiling is ≥100
  req/min. It is shared across every concurrent consultation, which is the starvation this
  quota plane exists to prevent.
- OpenAI's seeded wire id `gpt-4o-transcribe` is on the vendor's not-recommended list
  (superseded by `gpt-live-transcribe` for streaming and `gpt-transcribe` for completed audio).
  The pre-existing open decision on that id is **deliberately left unresolved** by this ticket.
- Azure's production path is the Speech SDK's threaded callbacks, not a socket. Its WS-native
  Voice Live API is public preview with no SLA and is **rejected for a PHI platform**.

## 6. Implementation Summary

### Lane S6 — per-provider cloud-ASR capacity quotas (OD-4)

> **OD-4, 2026-09-21 (verbatim):** *"platform admin will set minute volume by
> enabled provider globally OR specific by tenant that has Pro plan and above"*

Two capacity dimensions per cloud STT provider, a platform default, an optional
per-tenant allocation, and the "Pro and above" eligibility bound — all inside the
EXISTING entitlements plane rather than a parallel one.

| Dimension | Protects | Enforced at |
|---|---|---|
| `requestsPerMinute` | the vendor's sync-REST per-minute cap (Sarvam 60/100/4000 by account tier) — still binds, because BATCH transcription stays on REST | batch transcription-job create |
| `maxConcurrentStreams` | the vendor's concurrent-WebSocket cap (Sarvam 20/100/100) — the ceiling that binds for LIVE work, now that a consultation is ONE persistent socket rather than N requests | streaming-session open |

Providers are exactly `CLOUD_BYO_PROVIDERS.stt`
(`packages/applications/src/services/ai-provider-connection/constants.ts`),
READ at the write path rather than copied. There is no second list anywhere —
not in the schema, not in the DTOs, not in the console.

#### Schema — three additive columns, no new model

| Column | Model | Meaning |
|---|---|---|
| `sttProviderQuotas Json? @db.JsonB` | `PlanEntitlement` | the PLATFORM DEFAULT, per provider, per dimension |
| `sttProviderQuotas Json? @db.JsonB` | `TenantEntitlement` | the tenant's OWN allocation |
| `featureProviderQuotaAllocation Boolean @default(false)` | `PlanEntitlement` | the "Pro and above" eligibility BOUND |

A JSONB map rather than one scalar column per provider because the provider list
lives in code and moves — this very ticket adds a Sarvam duplex lane. A column
set would be a second hardcoded list needing a migration across two tables, four
domain files, two DTOs and the console per provider, and drifting silently when
someone forgot one. No new Prisma model: `PlanEntitlement`/`TenantEntitlement`
already ARE the two tiers, already carry OCC, already have a super-admin-only
CRUD surface and a shipped console screen.

Migration: `20260921163644_task_998_provider_capacity_quotas` (additive only;
`ADD COLUMN` × 3, no index, no backfill, no destructive DDL).

#### Resolution — tenant → platform default, per DIMENSION

`resolveProviderQuotas` (`entitlements/provider-quotas.ts`, pure) merges the
tenant map over the plan map for each dimension independently, over the union of
both tiers' providers. So a tenant allocated only `maxConcurrentStreams` keeps
inheriting the platform `requestsPerMinute`. Unresolved at both tiers = `null` =
unlimited (not enforced), which is what every plan seeds as. `0` is a real,
enforceable allocation and the merge uses `??`, never `||`.

`50000000-…` ("Global") appears nowhere; a null-plan tenant resolves
`providerQuotas: {}` (unbounded) along with the rest of `UNGATED_ENTITLEMENTS`.

#### "Pro and above" BOUNDS, it never SUPPLIES

`featureProviderQuotaAllocation` is `false` on STARTER, `true` on
TRIAL/PRO/ENTERPRISE, and is consulted at exactly one place — the WRITE, in
`EntitlementsService.assertMayHoldProviderQuotas` (403). `resolveProviderQuotas`
never reads it. The consequence is the one that matters: a tenant below Pro
resolves the PLATFORM DEFAULT, and a PRO→STARTER downgrade returns a tenant to
the platform default rather than stranding it at zero on the path that starts a
consultation recording. Clearing an allocation (`null` / `{}`) is always allowed,
so a downgrade can be tidied up. Pinned by
`entitlements/__tests__/provider-quotas.test.ts`.

There is deliberately no `TenantEntitlement` tri-state override of the bound: a
per-tenant override of an eligibility bound is vacuous, because the only caller
the bound applies to is the super admin who would flip it.

#### Enforcement — the counter is Redis, and it does not leak

`packages/applications/src/services/provider-capacity/` — a SECOND limiter, and
the comment on `provider-capacity.constants.ts` says why beside
`TieredThrottlerGuard`: that one bounds INBOUND requests by what the platform
will serve a tenant, this one bounds OUTBOUND calls by what the vendor's account
will accept. Different direction, different owner of the number, different key.

Both dimensions are single atomic Lua calls against the shared Redis, never an
in-process counter (which would multiply the vendor's ceiling by the replica
count) and never a read-then-write pair (which lets N concurrent opens all
observe `active = limit − 1`).

* **rate** — fixed minute window, `CHECK-then-INCR` so a refused call does not
  consume the vendor budget it never reached.
* **concurrency** — a sorted set scored by "last seen", swept by the TTL cutoff
  before it is counted. A slot held by a replica that was SIGKILLed is reclaimed
  by the next acquire after the window, with nothing to notice the death and
  nothing to clean up by hand; an INCR/DECR pair would leak one slot per crash,
  permanently. Re-acquiring the same `sessionId` is idempotent, so a resume is
  never refused by the slot it already owns. Teardown releases immediately, by
  `sessionId` alone, through a reverse index the limiter writes at acquire —
  most teardown paths never saw the resolved ASR spec.

#### Fail posture — declared, not improvised

Infrastructure failure FAILS OPEN; an explicit over-limit verdict FAILS CLOSED.
Redis unreachable, no Redis wired, or a failed entitlement resolve ⇒ the call
proceeds, logged at WARN and counted on
`provider_capacity_check_skipped_total{dimension}`. This is a clinical-safety
judgement stated on `IProviderCapacityService`: refusing to start a consultation
because a quota counter is down is worse than briefly over-running a vendor cap
that the vendor will itself rate-limit, visibly and retryably. An actual
over-limit verdict is the opposite case — the call is known to be refusable
upstream — so it raises `QuotaExceededException`.

Both capability strings (`sttProviderRequestsPerMinute`,
`sttProviderMaxConcurrentStreams`) were added to `QUOTA_RATE_CAPABILITIES` in
`apps/api/src/interceptors/exception.interceptor.ts` so they map to **429**, not
the default 409: a vendor window rolls over and a live stream ends, so this is
retry-later, never a permanent conflict.

`apps/stt` gained NO database read and was not touched: enforcement is in the
gateway, which is where the tenant, the plan and the resolved spec already are.

#### Files

| Path | Change |
|---|---|
| `packages/database/src/prisma/db_main/entitlement.prisma` | +3 columns |
| `packages/database/src/prisma/db_main/migrations/20260921163644_task_998_provider_capacity_quotas/migration.sql` | new |
| `packages/database/src/prisma/db_main/seed/15-entitlements.ts` | `featureProviderQuotaAllocation` per plan; `sttProviderQuotas` deliberately unseeded |
| `packages/domains/src/{models,entities,factories}/generated/core/{Plan,Tenant}Entitlement*.ts` | hand-authored column surfacing (`gen:*` creates no files) |
| `packages/applications/src/services/entitlements/provider-quotas.ts` | new — shape, per-dimension merge, write validation |
| `packages/applications/src/services/entitlements/{resolve-entitlements,entitlements.constants,entitlements.service}.ts`, `dto/*` | resolution, the plan bound, the 400/403 write gates, DTOs |
| `packages/applications/src/services/provider-capacity/**` | new — the limiter (interface, constants + Lua, service, module) |
| `packages/applications/src/services/stt/asr-provider.ts` | new — the one reader of `models.asr.provider` |
| `packages/applications/src/services/stt/{job,streaming}/**` | the two enforcement call sites + release/heartbeat |
| `apps/api/src/interceptors/exception.interceptor.ts` | the two capabilities → 429 |
| `apps/admin-console/src/features/entitlements/**` | plan JSON editor + table column, tenant override key, feature label |

#### Known gap, handed on

`heartbeatStreamSlot` exists and is called opportunistically from
`StreamingSessionService.getSessionStatus`, but its intended steady-state caller
is `SttWsGateway.scheduleHeartbeat` (the ~20 s tick that already republishes the
socket registry). Wiring it there belongs to the lane that owns the gateway and
shortens the crash-reclaim window from `PROVIDER_STREAM_SLOT_TTL_SECONDS` (2 h)
to seconds. Until then the 2 h window is the backstop for the crash case only —
ordinary teardown, and a failed session open, both release immediately.

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-21 | **Lane S6** — per-provider cloud-ASR capacity quotas (OD-4). Added `PlanEntitlement.sttProviderQuotas` (platform default), `TenantEntitlement.sttProviderQuotas` (tenant allocation) and `PlanEntitlement.featureProviderQuotaAllocation` (the "Pro and above" bound), migration `20260921163644_task_998_provider_capacity_quotas`. New `ProviderCapacityService` enforces both dimensions on a shared Redis counter at batch-job create and streaming-session open; fail-open on limiter infrastructure, fail-closed on an over-limit verdict, both capabilities mapped to 429. `apps/stt` unchanged — no DB read added to the agent path. |
