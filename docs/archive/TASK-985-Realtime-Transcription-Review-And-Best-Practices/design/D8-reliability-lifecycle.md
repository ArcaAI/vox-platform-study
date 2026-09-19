# D8 — Reliability & session lifecycle: design dossier (TASK-985)

| | |
|---|---|
| **Area** | D8 — reliability, session lifecycle, concurrency, metering correctness |
| **Findings covered** | M-04, M-06 (server half), M-22, M-23, M-24, M-29, M-34, M-46, M-47, M-48, M-49, M-50, M-64, M-65, M-66, M-68; items QW-1, QW-5, ST-5, ST-6; owner decision OD-H |
| **Base** | `agent/agent-transcription-coordination-9dbc25` = `dev-2.2` @ `3f9145a98` |
| **Method** | static read only. No test, no service, no build was run; every live number below is a MEASUREMENT REQUEST (§7.2), never a result. |
| **Deliverable kind** | design, not code. Nothing here is implemented. |

Every `file:line` was opened and read on this branch. Where the ticket README's
claim and the code disagreed, the code wins and the divergence is stated.

---

## 0. The one sentence that organises this area

Four independent finalizers (`end_session`, the final audio frame, the control
`FINALIZE`, the idle reaper) converge on one session, and the ONLY thing
serialising them is a lock that is taken too late plus a boolean that is read as
if it were a completion. Everything in §1, §5 and half of §4 is a consequence of
that: the tail utterance is lost because a later finalizer overtakes the flush,
the ledger row is lost because the finalizer that ran discarded the summary the
finalizer that answers HTTP was supposed to return, and the capacity slot is
mis-counted because "session" means three different sets in three different
places (`sessions`, `sessionsById`, `_capacity_guard.active_session_ids`).

---

## 1. QW-1 — the tail race (M-04, M-23, M-29)

### 1.1 The interleaving, exactly

Verified against `apps/stt/src/stt/streaming/session_manager.py` and
`packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts`.

| t | Actor | Action | File:line |
|---|---|---|---|
| 0 | SDK | `{type:'stop'}` on the socket | `SttWebSocketClient.ts` sendStop |
| 0+ | Gateway | `writeControlCommand(sessionId,'finalize')` → XADD `stt:control` | `stt-ws.gateway.ts:1292-1294` |
| 0+ | SDK | enters `stopAndDrain(1500 ms ceiling, 250 ms quiet window)` | `SttWebSocketClient.ts:187-189, 655-693` |
| 1 | STT control handler | `session.finalize()` → status `FINALIZING`; publishes `finalizing` | `session_manager.py:3394-3399`; `session.py:497-507` |
| 2 | STT control handler | `_begin_tail_flush(sid)` → **True** (owner); `await _flush_final_utterance` + `await _drain_inference_queue` — a whisper.cpp decode of the tail on the process-wide per-model lock | `session_manager.py:3402-3407`; `whisper_cpp_asr.py:429,465` |
| 3 | SDK | sees `finalizing` → arms the 250 ms quiet window; no transcript arrives inside it (the tail decode is still running) → drain resolves `quiet_window`; `disconnect()` then `closeSession()` (DELETE), fire-and-forget | `SttWebSocketClient.ts:676-693`; `StreamingBackendSTTProvider.ts:372-393` |
| 4 | STT DELETE route | `end_session` → `_begin_tail_flush(sid)` → **False**, logs *"Tail flush already performed for this session; skipping duplicate flush/drain and proceeding to finalize"* → straight to `_finalize_session` | `routes.py:315-318`; `session_manager.py:1674-1682`; `:3513-3519` |
| 5 | STT DELETE route | takes the free finalize lock, status is `FINALIZING` (not `CLOSED`), so it proceeds: `_cancel_partial`, **publish `closed`**, upload WAVs, `build_transcript_json()`, `_persist_streaming_transcript`, `session.close()`, `remove_session()` | `session_manager.py:4255-4473` |
| 6 | STT | `remove_session` → `_stop_inference_loop(force_cancel=True)`, drops the publisher, drops the session — **cancelling the in-flight tail decode of step 2** | `session_manager.py:1716-1727, 1725` |
| 7 | Gateway | the captions reader saw the terminal `closed` and `subject.complete()`d; anything published after it is dropped | `streamingAudioBridge.service.ts:527-536` |

Net: the closing utterance is never decoded to completion, never reaches
`session.add_result`, and is therefore absent from the live captions, from
`transcript.json`, and from the durable transcript — while `audio_seconds` is
unaffected, so billing is normal. That is M-04.

Note step 2 vs step 5: the *drain* of the first trigger is `wait_for(queue.join(),
timeout=_inference_drain_timeout_s)` (60 s default, `session_manager.py:3037,388`).
After step 6 cancels the loop, `task_done()` is never called for the tail item, so
the FIRST trigger blocks until that 60 s timeout, then runs
`_settle_inference_loop` + `_drain_remaining_inline` against a queue and a session
the manager has already forgotten. Bounded, but it is a 60 s zombie coroutine per
lost tail and it is where any inline re-decode goes to die.

### 1.2 Is the guard correct, or is it the bug?

**Both, and the distinction is the fix.** `_begin_tail_flush` is a correct
MUTUAL-EXCLUSION guard: F-32 removed a real double-publish, the test-and-set is
genuinely atomic (no `await` between the membership read and the insert, single
threaded loop), and the F-32 test pins it
(`apps/stt/tests/unit/streaming/test_session_manager_tail_flush_guard.py`).

It is the bug because it supplies no HAPPENS-BEFORE. It answers "is someone else
doing the tail?" and the call site reads the answer as "is the tail done?". That
false reading is exactly the premise `_finalize_session_locked`'s own docstring
asserts — *"Callers must drain the inference queue **before** calling this
method"* (`session_manager.py:4258-4259`) — and which the `False` branch breaks at
all four sites. The log line is therefore ACCURATE about what it did and WRONG
about what it implies; a reader chasing a lost tail will read it as reassurance.

So: keep the mutual exclusion, add the completion edge. Do not delete the latch.

### 1.3 Server-side fix — which lock, which event, what must be awaited

**Do NOT widen `_finalize_locks` to cover flush+drain.** That lock also
serialises the MinIO uploads and the durable-transcript persist
(`session_manager.py:4318-4425`). Holding it across a tail decode re-serialises
teardown behind the GPU and undoes the deliberate split that publishes `closed`
before the uploads (`:4266-4275`) — the split that stopped the SDK's stop-drain
burning its full timeout. A completion LATCH is the right primitive: the later
finalizer must wait for the tail, not for the blob store.

Concrete shape:

```
# replaces  self._tail_flush_started: set[str]   (session_manager.py:336)
self._tail_flush_done: dict[str, asyncio.Event] = {}

def _begin_tail_flush(self, session_id) -> tuple[bool, asyncio.Event]:
    """(owned, done_event). Test-and-set stays atomic: no await between
    the get and the insert."""
    ev = self._tail_flush_done.get(session_id)
    if ev is not None:
        return (False, ev)          # a later trigger: it must AWAIT ev
    ev = asyncio.Event()
    self._tail_flush_done[session_id] = ev
    return (True, ev)
```

Every one of the four trigger sites becomes the same five lines:

```
owned, tail_done = self._begin_tail_flush(sid)
if owned:
    try:
        await self._flush_final_utterance(session=..., preprocessor=...)
        await self._drain_inference_queue(sid)
    finally:
        tail_done.set()             # a raising flush must not wedge waiters
else:
    try:
        await asyncio.wait_for(tail_done.wait(), timeout=self._tail_wait_timeout_s)
    except TimeoutError:
        logger.error("stt.stream.tail_wait_timeout", session_id=sid)  # proceed anyway
await self._finalize_session(session)
```

Trigger sites to change: `end_session` `:1674-1682`, `_on_frame` final-frame
`:3360-3366`, `_on_control` FINALIZE `:3402-3408`, `_reap_expired_sessions`
`:4754-4760`.

Design points that are load-bearing:

- **`finally: tail_done.set()` is not defensive tidiness, it is the deadlock
  guard.** `_flush_final_utterance` already swallows every exception
  (`:3565-3571`), but `_drain_inference_queue` does not, and the reaper must
  always be able to finish.
- **The wait is BOUNDED and non-fatal.** `_tail_wait_timeout_s` =
  `_inference_drain_timeout_s + 5` (65 s default), governed as
  `stt.streaming.tailWaitTimeoutS` (global-kv, `open-to-default`) so it is not a
  literal (rule 00 §Configuration Principles). On timeout: log at ERROR, emit
  `stt_stream_tail_wait_timeout_total`, and proceed — a wedged teardown leaks a
  GPU slot, which is worse than a lost tail.
- **Belt and braces at the sink.** Add the same bounded wait at the TOP of
  `_finalize_session_locked` (before the `CLOSED` short-circuit's sibling checks),
  so a fifth trigger added later inherits the invariant without having to
  remember it. This is the `defense-in-depth` shape: the contract is enforced at
  the method that states it, not only at the four callers.
- **`_on_frame` awaiting the latch runs on the ingestion dispatch loop**, which
  stops XACKing `stt:audio` while it waits. Under the terminal-frame design below
  that frame is the LAST stream entry, so there is nothing left to starve; the
  bounded `wait_for` caps the pathological case regardless. State this in the
  code comment — it is the non-obvious consequence a future reader will trip on.

**The invariant to write into the docstring and to test:**

> For a given session, `publish_status("closed")` and `build_transcript_json()`
> are reachable only after that session's tail flush + inference drain has
> completed or has timed out. `_tail_flush_done[sid].is_set()` is `True` at every
> entry to `_finalize_session_locked`'s upload block.

### 1.4 In-band `final=1` — closing the M-29 window

M-29 is a different loss with the same symptom. `stop` writes FINALIZE to
`stt:control`; audio flows on `stt:audio`. **Two Redis streams have no mutual
ordering**, so the control listener can process FINALIZE while the ingestion
consumer still has unread `stt:audio` entries, and `session.finalize()` flips the
status to `FINALIZING` — after which `_on_frame`'s first line,
`if session.status != SessionStatus.ACTIVE: return` (`session_manager.py:3294-3295`),
discards every remaining frame. 80–160 ms at steady state, more under back-pressure.

The wire already supports the fix and nothing uses it: `writeAudioFrame(...)`
takes `isFinal` and encodes `final: '1'|'0'`
(`streamingAudioBridge.service.ts:264-302`); the gateway hard-codes `false` at its
single call site (`stt-ws.gateway.ts:1341`); `_on_frame` already has a
`if frame.final:` branch that flushes and finalizes (`session_manager.py:3352-3366`).

**Design.** On `{type:'stop'}` the gateway writes a **zero-length terminal frame**
to `stt:audio` instead of the control command:

```
case 'stop': {
  await this.bridgeService.writeAudioFrame(
    session.sessionId, ++session.binarySeq, EMPTY_BUFFER,
    session.sampleRate, 'pcm_s16le', /* isFinal */ true, session.traceCarrier);
  session.stopRequested = true;
  session.stopFallbackTimer = setTimeout(
    () => void this.bridgeService.writeControlCommand(session.sessionId, 'finalize'),
    STOP_CONTROL_FALLBACK_MS);           // governed, default 2000
  break;
}
```

Why this is the right shape:

- **Ordering by construction.** The terminal frame is appended to the same stream
  as the audio, so the ingestion consumer reaches it strictly after every earlier
  entry. The "unread entries at FINALIZE" window is not narrowed, it is removed.
- **Zero-length is deliberate.** `record_frame` adds `len(data)//2 == 0` samples,
  so the marker cannot inflate `total_duration_seconds` — which is the billed
  quantity (`session_manager.py:4160`). `preprocessor.feed(b'')` must be proven a
  no-op; that is a unit test, not an assumption.
- **`MAXLEN ~10000` cannot trim it** — it is the last write on the stream.
- **The control FINALIZE cannot be deleted.** A socket that dies without `stop`
  never writes a terminal frame; the grace-expiry path (`stt-ws.gateway.ts:1174`)
  still needs the control command, and so does `SIGTERM` teardown (`:308-330`).
  It becomes the ABORT path plus a bounded fallback, not the normal stop path.
- **Do not send both immediately.** If the control command is written beside the
  frame, it can still win the race and the fix buys nothing. Hence the timer,
  cleared when the terminal `closed` status is relayed.

Rejected alternative, stated so it is not re-proposed: having the control handler
poll `XINFO STREAM stt:audio:{id}` for `last-generated-id` and wait for the
consumer's `_last_id` to reach it is a correct "drain to the current id", but it
costs a Redis round trip per poll, does not compose with `MAXLEN` trimming
(a trimmed id is never reached), and adds a second ordering mechanism beside the
one the wire already has.

### 1.5 The teardown summary, from EVERY finalizer (M-23)

**Confirmed and it is worse than the README states.** Three of the four
finalizers build the summary and throw it away:

| Finalizer | Returns the summary to | Emits a ledger row? |
|---|---|---|
| `end_session` via `DELETE /internal/streaming/sessions/{id}` | the HTTP caller → `StreamingSessionService.removeSession` → `emitStreamingUsage` | YES |
| final audio frame (`_on_frame`, `:3366`) | nobody — return value discarded | **no** |
| control `FINALIZE` (`_on_control`, `:3408`) | nobody — return value discarded | **no** |
| idle reaper (`:4760-4767`) | `_push_streaming_usage_back(summary)` with a hard-coded `interrupted=True` | yes |

And the DELETE that *should* emit answers **204** once any other finalizer has
run, because the route short-circuits on `mgr.get_session(session_id) is None`
(`routes.py:307-311`) and `removeSession` only emits `if (summary)`
(`streamingSession.service.ts:427-431`). So the ordinary clean stop — control
FINALIZE first, DELETE second — produces **no `transcribe.stream` row at all**.

The `interrupted` half is the same root cause seen from the gateway: the browser
SDK never sends `{type:'close'}` (it calls `disconnect()`,
`SttWebSocketClient.ts:694`), so `handleDisconnect` starts the 15 s grace and
`finalizeSession(session,'grace window expired')` sets `interrupted = true`
(`stt-ws.gateway.ts:1218,1230`) — for a session the clinician stopped cleanly.

**Design — a teardown-summary stash, so exactly one row is emitted with the
gateway's own `interrupted` verdict.**

1. `_finalize_session_locked` already builds the summary in its `finally`
   (`:4460-4468`). When the finalizer is not the HTTP `end_session` caller, stash
   it: `self._pending_teardown_summaries[sid] = (summary, monotonic() + ttl)`,
   bounded by `stt.streaming.teardownSummaryStashTtlS` (global-kv,
   `open-to-default`, default 120) and by a hard entry cap with oldest-first
   eviction (it is an in-memory dict on a PHI service; it must not grow).
2. `delete_streaming_session` returns **200 + the stashed summary** when the
   session is gone but a stash exists (pop it), instead of 204
   (`routes.py:307-311`). The gateway then emits the row, and it — not STT —
   decides `interrupted`, which is the correct ownership (`_build_teardown_summary`
   says so in its own docstring: *"STT has no notion of 'interrupted'"*,
   `session_manager.py:4098-4102`).
3. The reaper keeps `_push_streaming_usage_back` unchanged: it fires precisely
   when the gateway is gone and no DELETE is coming. The ledger's idempotency key
   is shared across both paths (`streamingSession.service.ts:395-399`), so a stash
   claimed late after a push-back is a no-op at the ledger, never a double charge.
4. Gateway: stop treating 204 as "someone else emitted". Log at WARN and count
   `stt_stream_teardown_summary_missing_total` — today the loss is invisible in
   metrics, which is why M-23 needed a code read to find (new sub-defect, §8 N-7).
5. Gateway: **finalize on the terminal `closed` status**, not only on the grace
   window. The captions subscription already completes on it
   (`streamingAudioBridge.service.ts:527-533`); the gateway's `complete:` handler
   (`stt-ws.gateway.ts:800+`) should call
   `finalizeSession(session, session.stopRequested ? 'session closed by client' : 'upstream closed')`.
   That fixes the wrong `interrupted` flag WITHOUT depending on the SDK change,
   and the SDK should send `close` after its drain anyway (L-SDK).

---

## 2. M-24 — the unreachable fallback (QW-5)

### 2.1 Confirmed, three independent links, all broken

1. **pywhispercpp discards `whisper_full`'s return code**, so an engine failure is
   an empty segment list. The adapter's own module docstring says it
   (`whisper_cpp_asr.py:33-36`): *"silently indistinguishable from genuine silence
   at the Python level."*
2. **`_decode_recover_locked` returns `[]` on both terminal branches** — a failed
   context rebuild (`:546`) and still-poisoned-after-rebuild (`:541-544`). It never
   raises.
3. **`record_success()` fires on every non-exception result**, including
   `text == ''` (`session_manager.py:2968-2971`), so the consecutive-failure run
   that arms the threshold switch is reset by the very silence the failure
   produces. `EngineSwitchController` arms only on `CloudASRAuthError` /
   `CloudASRQuotaError` (immediate) or `CloudASRTranscriptionError` / `ModelError`
   (threshold) — `engine_switch.py:49-52`.

whisper.cpp is the primary engine class for every served session, and it can
raise none of those four. The declared fallback chain is unreachable by
construction; only a CLOUD primary can ever fail over today.

### 2.2 The distinction that is the whole design

**An empty decode is evidence of failure only when the buffer carried speech.** A
genuinely silent utterance decoding to nothing is correct behaviour and must
never fail over — a fallback triggered by a quiet room would swap the engine in
the middle of a consultation for no reason, and (under M-34, unfixed) onto the
wrong prompt and language.

The adapter already owns half of that distinction and uses it for a different
purpose: `_carries_speech(audio)` gates the dead-zone retry
(`whisper_cpp_asr.py:503, 524-529`, RMS ≥ `_EMPTY_SPAN_RMS_FLOOR` 0.01). Two
cautions before reusing it as failure evidence:

- **It reads peak-normalized audio** (M-07: the preprocessor's gain reaches 20x,
  `preprocessor.py:35,351`). A normalized silent frame still sits low because the
  peak window is floored at 0.05, so the threshold is not obviously wrong — but it
  has never been validated as a *silence* discriminator, only as a *retry* gate.
  Either validate it on BP-7's room-tone clip, or (preferred) have the preprocessor
  stamp the pre-normalization RMS on `AudioUtterance` and use that.
- **The known-benign 4.50–4.70 s dead zone must not count.** `_decode_spans_locked`
  already retries such a span with a pulled-back boundary (`:496-521`). Count a
  span as failure evidence only when the RETRY also came back empty — that reuses
  machinery that exists and removes the one empty-with-speech case we know is not
  an engine fault.

### 2.3 When to raise `ModelError`

| # | Condition | Confidence | Today | Design |
|---|---|---|---|---|
| 1 | `_rebuild_locked()` returned `False` — no `model_path`, or `_construct_whisper_model` raised | unambiguous: the context is gone and cannot be recreated | `return []` (`:546`) | raise `ModelError("whisper.cpp context unrecoverable: <cause>")` |
| 2 | `_is_poisoned(logs)` still true after a successful recreate | unambiguous: the backend is in a permanent error state | `return []` (`:541-544`) | raise `ModelError("whisper.cpp backend poisoned after recreate")` |
| 3 | N consecutive empty decodes with speech present, retry included | heuristic — needs the §2.2 qualifier | nothing | raise `ModelError` on the Nth |

N is `stt.whisperCpp.emptyDecodeFailureStreak` (global-kv, `open-to-default`,
default **3**), counted **per model context** (keyed by `model_id`, alongside
`_get_model_lock`) rather than per session — a poisoned context is shared by every
adapter over that `LoadedModel`, so a per-session counter would need three
sessions' worth of failures to reach the threshold on a context that is already
dead. Reset on any non-empty decode.

Companion change at the inference loop: `record_success()` must stop resetting the
run on an empty-with-speech result. `_InferenceResult` gains
`empty_with_speech: bool`, and `session_manager.py:2968-2971` becomes
`if not result.empty_with_speech: controller.record_success()`. Without this, an
alternating empty/non-empty pattern never reaches the threshold even with
condition 3 in place.

### 2.4 Rebuilding outside the shared lock

Today `_rebuild_locked` runs with `self._lock` held (`:534-547` is called from
`_decode_spans_locked`, itself inside `with self._lock`, `:465`). That lock is the
process-wide per-model decode lock, so a multi-GB GGUF reload blocks every other
admitted stream's decode — on a capacity guard that admits 20 (M-26). Design:

- Keep `self._lock` for the decode. On poison, capture
  `generation = self._loaded.generation`, RELEASE the decode lock, take a separate
  per-`model_id` `_rebuild_lock`, and double-check: if
  `self._loaded.generation != generation` another thread already rebuilt — just
  retry the decode. Otherwise rebuild, bump `generation`, release.
- `LoadedModel` gains a monotonic `generation: int` bumped in the same statement
  that swaps `.model` (`whisper_cpp_asr.py:728-731`). Threads that block on
  `_rebuild_lock` re-read the generation and retry rather than decoding on the old
  context.
- These are `threading.Lock`s, not asyncio ones: `__call__` runs under
  `asyncio.to_thread` (`inference.py:855-866`). Standard double-checked rebuild.
- Bound it: `stt.whisperCpp.rebuildTimeoutS` (default 60). A rebuild that exceeds
  it raises `ModelError` rather than parking every session behind it.

### 2.5 The tail-path hole this opens (new, §8 N-3)

`_flush_final_utterance` swallows every exception (`session_manager.py:3565-3571`)
and `_run_inline_inference` has its own broad `except` (`:3486-3493`). So a
`ModelError` raised by the §2.3 fix while decoding the TAIL never reaches
`record_failure` — the one utterance most worth recovering is the one the switch
cannot see. Design: both handlers re-raise `SWITCHABLE_ASR_ERRORS` after logging
and route them through `controller.record_failure(...)`, exactly as
`inference.py:515-528` already does for the steady-state path. That import already
names itself the single source of truth (`engine_switch.py:55-60`); this is the
third caller it was written for.

### 2.6 Fault-injection tests

New file `apps/stt/tests/unit/streaming/test_whisper_cpp_fault_injection.py`:

| Case | Setup | Assertion | RED today? |
|---|---|---|---|
| a | monkeypatch `_construct_whisper_model` to raise; feed a poison log | `_decode_recover_locked` raises `ModelError` | yes (returns `[]`) |
| b | rebuild succeeds, logs stay poisoned | raises `ModelError` | yes |
| c | `Model.transcribe` returns `[]` for N speech buffers (retry included) | raises on the Nth, not the (N-1)th | yes |
| d | same as (c) but N SILENT buffers | never raises; `record_success` still resets | passes today, pins the §2.2 distinction |
| e | two threads, one decoding while the other triggers a rebuild | the decoder's lock wait < rebuild duration; both see `generation` advance | yes |
| f | end-to-end through `_start_inference_loop` with a fake `EngineSwitchController` | `record_failure` reached, `provider_switched` published, utterance re-run on the new callable | yes — extend `test_session_manager_auto_switch_task614.py` |
| g | the SAME fault raised from the TAIL path | `record_failure` reached (§2.5) | yes |

---

## 3. M-34 / M-49 / ST-6 / OD-H — the fallback chain

### 3.1 M-49 — one link of an ordered chain survives the wire

Confirmed at four layers:

- the seeded agent declares two fallbacks (`25-agents.ts:478`, per the README);
- `asrChainModels` sorts the `role === 'fallback'` rows by priority and returns
  `chain[0]` — the rest are dropped with no diagnostic
  (`build-resolved-asr-spec.ts:586-587`);
- the wire type carries a SINGLE `spec: AsrSpecCore | null`
  (`packages/types/src/asr-spec.ts:417-428`);
- `ResolvedSpecBundle` maps exactly two chains
  (`apps/stt/src/stt/pipeline/spec.py:832-834`) and `fallback_runtime_key` is a
  scalar (`:823-824`); `EngineSwitchController` holds one
  `fallback_pipeline_id` and `_active` is a two-value enum
  (`engine_switch.py:82,99,142-145`).

So the second declared fallback is dead config, and — the point that matters —
**a q8_0 failure that shares the f16 cause ends the chain**, because the one
surviving entry is the quantized sibling of the failing primary.

**Design.**

- `AsrSpecFallback` gains `chain: AsrSpecCore[]`; `spec` is kept for one release
  as a deprecated alias for `chain[0]` so the committed contract fixture
  (`tests/contracts/resolved-asr-spec.fixture.json`) and the Python mirror can
  ship in either order (the pattern `asr-spec.ts:396-404` already documents for
  `OPTIONAL_FIELDS`). Register the alias in
  `docs/operations/deprecation-register.md`.
- `asrChainModels` returns the ordered list; `fallbackOf` maps each entry through
  `buildAsrSpecCore`.
- `bundle_from_resolved` extends `chains` to the full list (`spec.py:832-834`),
  keying `pipeline_specs` by each runtime key — the loop already does this
  generically, so it is a one-line change. `fallback_runtime_key` →
  `fallback_runtime_keys: list[str]`.
- `EngineSwitchController._active` becomes an INDEX into
  `[primary, *fallbacks]`. `record_failure` at the threshold advances one step;
  an exhausted list stops switching (and logs once). `switch_manual` stays
  bidirectional between the CURRENT engine and index 0 — the clinician-facing
  control should not grow a chain selector.
- **Interim honesty fix, shippable alone in the QW-3 lane:** emit an
  `onProfileRejection` for every dropped chain entry at
  `build-resolved-asr-spec.ts:586`, so the resolver stops discarding configuration
  silently. Refusing >1 at publish (the README's alternative) makes the SEEDED
  agent unpublishable and is therefore a seed change, not a quick win.

### 3.2 M-34 — the switch swaps the callable and nothing else

`_apply` (`session_manager.py:1463-1481`) assigns `worker._asr_pipeline` and
`worker._active_pipeline_id`, then `_advance_usage_segments`. Everything else the
decoder depends on stays the primary's:

| Worker/preprocessor state | Set from | Re-derived at switch? |
|---|---|---|
| `_initial_prompt` (pair priming + agent prompt) | primary spec at construction | **no** — `inference.py:855` composes the primary's prompt for the fallback engine |
| `_max_decode_window_sec` | primary `_metadata.asr` | **no** (`inference.py:795-816`) |
| `_lexicon_corrector` | primary `postprocessing.lexicon` | **no** (`inference.py:175`) |
| `_punctuation_config`, `_postprocessing_config`, disfluency | primary | **no** |
| `pipeline_config.inference.language` (the per-session pin) | primary, mutated at create (`session_manager.py:1194-1195`) | **no** — the M-32-shaped trap: a CT2 fallback wants `ml` pinned where whisper.cpp ran unpinned |
| preprocessor `partial_window_s`, `max_utterance_sec` | primary | **no** |
| commit policy (`LocalAgreementPolicy`) | reset at each utterance final (`:3314`) | **not at the switch** |

The fix is small because the data is already in hand: `_build_fallback_asr_callable`
loads the fallback `PipelineSpec` via `_load_pipeline_config` — which for a
spec-driven session resolves out of `ResolvedSpecBundle.pipeline_specs` with no
DB read (`session_manager.py:1827-1872`) — and then **discards everything but the
callable** (`:1588-1611`).

**Design.**

- `_build_fallback_asr_callable` returns `(callable, fallback_pipeline_spec)`.
- `_apply(new_callable, pipeline_id, pipeline_spec)` re-derives, **in the same
  synchronous body** as the callable swap. The existing comment at `:1469-1474`
  already demands that discipline for the provenance stamp and gives the reason —
  any divergence attributes utterances to the wrong engine. The same argument
  applies verbatim to the prompt: a half-applied switch is worse than none.
- Re-derive: `_initial_prompt` (through `resolve_mode_for_engine` against the
  FALLBACK engine, so an ml-en pair prompt is not handed to a CT2 model that
  wants a pinned language), `_max_decode_window_sec`, `_lexicon_corrector`,
  `_punctuation_config`, `_postprocessing_config`, and the session language mode
  from `self._session_language_modes[session_id]` applied to the fallback copy.
  The signature probe re-runs on its own — it is keyed on callable identity
  (`inference.py:826-828`).
- **Front-end geometry changes at the next utterance boundary, not immediately.**
  `partial_window_s` / `max_utterance_sec` are preprocessor properties; changing
  the tail length mid-utterance corrupts the LocalAgreement window. Stash
  `pending_front_end_geometry` in `_apply` and adopt it on the next `is_final`.
- **Reset the commit policy and cancel the in-flight partial at `_apply`.** For an
  AUTO switch this is already implied (the reset at `:3314` ran before the failing
  decode), but a MANUAL switch (`switch_manual` via the control stream) fires
  mid-utterance, and `stable_chars` is then the agreed prefix of one hypothesis
  from each engine. Low severity, one line, listed at §8 N-2.
- **Carry-forward text is deliberately NOT reset.** `_previous_text` /
  `_last_final_tail` (`inference.py:572-591`) are clinical continuity, not engine
  state; the previous engine's words are the right prior for the next utterance.
  Say so in the comment so a later reader does not "fix" it.

### 3.3 ST-6 / OD-H — what the owner decision actually turns on

Input to OD-H, not a decision:

**The switch mechanism can only be as good as the fallback's own spec, and the
sequencing follows from that.** A **quantized sibling of the same fine-tune** is
the only fallback that is correct under TODAY's `_apply`, because prompt,
language policy, decode geometry and lexicon are identical — which is precisely
why it is the right FIRST chain entry and why it was a defensible interim choice.
Anything genuinely different — the CT2 turbo, an IndicConformer-ml RNNT lane, or
a cloud engine (Sarvam / Chirp 3 / Azure `ml-IN`) — is a different prompt regime
and a different language policy, so **M-34 must land before a heterogeneous
fallback is configured at all**, or the failover degrades the session it was
meant to rescue. Under M-49's chain that is expressible directly: entry 1 = the
quantized sibling (same-family, no re-derivation risk), entry 2 = the genuinely
different engine (requires M-34). A cloud entry additionally needs the PHI-egress
and India-residency decision the OD names, which is outside D8.

---

## 4. Gateway lifecycle

### 4.1 M-22 — `ready`-frame gating

The gateway emits `ready` after registration AND subscription, with `fromSeq` and
`sessionEpochMs` (`stt-ws.gateway.ts:699-709, 814-825`), and the rebind path
re-sends it (`:908-909, 925`). Its own comment names the race it exists to close.
Neither SDK consumes it: `SttWebSocketClient.connect()` resolves on socket open
(`:299-300`), `ready` falls through to `default:` and is logged as an unknown
message type, and `stt-socket-protocol.ts` does not document it.

Design: `connect()` resolves on `ready` (capturing `fromSeq` and
`sessionEpochMs`), bounded by `readyTimeoutMs` (default 5 000) after which it
resolves with a WARN rather than rejecting — the compatible posture while a
pre-`ready` gateway could still be on the other end; harden to a reject one
release later. The resume handshake is sent only after `ready` on the NEW socket.
Add `ready`/`resumed` to the SDK's known types and to `stt-socket-protocol.ts`.
Same change in `packages/vox-node`'s `realtime-stt-socket.ts`.

### 4.2 M-47 — no ping/pong

Confirmed: `ping`/`pong`/`isAlive` appear nowhere in
`apps/api/src/modules/streaming/stt-ws.gateway.ts`. A half-open client's session
stays in `sessionsById` holding its upstream STT session, its model pin and a GPU
slot until STT's own 300 s idle reaper (`settings.py:622`,
`session_manager.py:384`) — up to 10 minutes counting the reaper interval.

Design: reuse the existing 20 s `socketHeartbeat` (`:311-313`), which already
ticks for `publishSocketCount`. Per socket, `session.isAlive`; on each tick,
`isAlive === false` ⇒ `client.terminate()`, else set `isAlive = false` and
`client.ping()`. `client.on('pong', ...)` registered inside
`attachMessageHandler` (`:834`) so the rebind path re-registers it. Two misses ⇒
20–40 s detection. `terminate()` routes through `handleDisconnect`, so a genuinely
flaky client still gets its 15 s grace — the change shortens detection, it does
not remove resumability. Govern `sttStreaming.wsPingIntervalMs` (default 20 000)
and `sttStreaming.wsPingMissesBeforeTerminate` (default 2) alongside ST-5's
descriptors.

### 4.3 M-48 — the grace-window rebind mints a new consumer name

Confirmed: `subscribeSessionResults` passes `consumerGroup` but no
`consumerName` (`stt-ws.gateway.ts:765-771`), so the bridge generates
`reader-${nextSubscriptionId()}` per subscription
(`streamingAudioBridge.service.ts:369`). On rebind the new consumer reads its own
(empty) PEL then goes live at `'>'`; the OLD consumer's read-but-unacked entries
are reclaimable only by `XAUTOCLAIM` at `RESULT_CLAIM_MIN_IDLE_MS = 30_000`
(`:74, 604`) — longer than the 15 s grace window, and by then the session may be
finalized. Loss is bounded to entries delivered to the dead reader and not yet
emitted; contiguous client-side `seq`s make it silent.

Two options, deliberately different in scope:

- **(b), QW-5 scope:** on the rebind path only, call `reclaimResultPending` with
  `min-idle 0`. Narrow, one parameter. Safe here because the group is per-session
  and the gateway keeps exactly one live reader per session (a transient drop does
  NOT call `unsubscribeFromResults`, `:1160-1167`), so the only other consumer is
  the dead one.
- **(a), ST-5 scope:** pass a stable `consumerName: captions-${sessionId}` — which
  is what the group's own comment already assumes ("role-stable",
  `streamingAudioBridge.service.ts:32-39`). Then the initial `'0'` PEL read
  recovers the old in-flight deterministically. **This requires a re-emission
  guard**, because `tagAndBuffer` assigns a NEW `seq` on every pass
  (`stt-ws.gateway.ts:1110-1121`), so a redelivered entry would reach the client
  twice under two different seqs. Key the resume buffer by the STT-side identity
  (`utteranceIndex`, `isFinal`) and reuse the existing seq on redelivery.

Recommend (b) now, (a) as the durable fix — and note that the guard in (a) is
worth having on its own merits: `readResultStream` is explicitly at-least-once
(`:537`), so redelivery is contract, not exception.

### 4.4 M-64 — uncompensated post-create Redis writes

Confirmed: `transcription-job.controller.ts:874-895` runs three writes in a
`Promise.all` AFTER `createSession` succeeded. A rejection (Redis blip, ticket
mint failure) propagates out of the handler with no compensation, so the STT
session stays admitted — holding its GPU slot and model pin — until the 300 s
reaper.

Design: wrap in `try/catch`; on failure `await this.sessionService.removeSession(result.sessionId, /* interrupted */ true, tenantId)` (best-effort, swallow its own error), clear the binding, then rethrow the original. `interrupted: true` is correct — the session was aborted before it served. No spurious ledger row results: `usageSegments` filters zero-duration segments (`streamingSession.service.ts:463`).

### 4.5 M-68 — the concurrency gate counts live sockets only

Confirmed: `getPerTenantSessionCounts()` iterates `this.sessions`
(`stt-ws.gateway.ts:386`), the socket-keyed map, which `handleDisconnect` deletes
from immediately (`:1133`) while the session survives in `sessionsById` for the
whole grace window holding its upstream STT session. The published map feeds
`SocketRegistryService.getTenantAggregateCount`, which is *"the signal the
concurrency gate compares against `maxConcurrentSessions`"*
(`socket-registry.service.ts:26-30`) and is read by
`entitlements.service.ts:464-466`.

Design: iterate `this.sessionsById`, skipping `session.finalizing`. That counts
exactly the sessions holding an upstream STT session and a GPU slot, which is what
the cap is about. Pin it with a unit test that disconnects a socket and asserts
the tenant count is unchanged until the grace expires. Note the interaction: the
M-47 ping shortens the window in which the count was wrong, and this makes it
right for the window that remains.

### 4.6 ST-5 — egress/resume coalescing and the configuration tier

**Coalescing.** Partials are DROPPED under back-pressure, not queued
(`stt-ws.gateway.ts:947-964`), so coalescing applies to the RESUME buffer, which
replays every unseen entry unconditionally (`:1506-1511`). `utteranceIndex` is on
the transcript message (`streamingAudioBridge.service.ts:829`), so keying is free.

- Resume buffer keeps at most ONE partial per `utteranceIndex` (the newest) and
  EVERY final. A final is distinct clinical content and is never coalesced.
- On replay, drop any partial whose `utteranceIndex` is below the highest replayed
  final's (superseded by its own final), and any entry older than
  `sttStreaming.resumeMaxReplayAgeMs` (default 10 000).
- Watermark: 512 KiB is ≈ 50 s of stale captions. Governed default **32 KiB**.
  (Different axis from M-36's 1 MiB CLIENT watermark — that is an SDK-lane
  concern; do not conflate them.)

**Configuration tier — this is a rule violation, not a preference.**
`WS_EGRESS_HIGH_WATERMARK_BYTES` and `WS_RESUME_GRACE_MS` are module-scope
`process.env` reads evaluated at import (`stt-ws.gateway.ts:91-94, 114-121`),
declared in `turbo.json:589-590` and `.env.sample:753,758`. Neither is part of the
bootstrap floor: neither is needed to reach the DB or authenticate to Vault, and
both are exactly the kind of value that must change without a restart
(`09-infrastructure-devops.md` §Configuration Tiers, corollary L1).

Design: add to `packages/applications/src/services/settings-registry/descriptors/stt-gateway.descriptors.ts`, beside `sttStreaming.sessionCreateTimeoutMs`, which is the exemplar for this exact shape — gateway-read, `global-kv`, `globalOnly: true`, `maxScope: 'system'`, `failMode: 'open-to-default'`, no `consumedBy` (no Python reader):

| Key | Default | Note |
|---|---|---|
| `sttStreaming.egressHighWatermarkBytes` | 32768 | resolved once per session at handshake into `SessionInfo`, so the per-result relay path stays synchronous |
| `sttStreaming.resumeGraceMs` | 15000 | resolved at `handleDisconnect`, so a change reaches the next drop |
| `sttStreaming.resumeMaxReplayAgeMs` | 10000 | new |
| `sttStreaming.wsPingIntervalMs` / `...MissesBeforeTerminate` | 20000 / 2 | §4.2 |
| `sttStreaming.stopControlFallbackMs` | 2000 | §1.4 |

Deprecate the two env reads: keep them as a one-release override with a one-time
WARN, add rows to `docs/operations/deprecation-register.md` (marked in the
implementing release, removed two releases later per the owner policy), then
delete from `turbo.json#globalEnv` and `.env.sample`.

### 4.7 M-46 and M-06 (server half) — the two I do not own the fix for

- **M-46** (no stalled-session detection) is an SDK/console concern:
  `lastTranscriptAt` plus a window derived from the session's resolved
  `maxUtteranceSec` → a `'stalled'` banner. It belongs to L-SDK. The server half
  it needs already exists — the session response carries the resolved agent — so
  nothing in L-STT or L-GW blocks it.
- **M-06 server half:** the server can only count what reaches it. The gateway's
  `droppedAudioFrames` counts failed XADDs only (`stt-ws.gateway.ts:1349`), so
  client-side discards are invisible (M-67). The server-side enabler for QW-11 is
  a `client_stats` control frame accepted on `stop` and recorded on the session —
  one new case in `handleMessage`'s switch, stamped into the teardown summary's
  attributes. Scope it with QW-11 in L-SDK, not here; it is listed only so the
  handshake between the lanes is explicit.

---

## 5. Metering correctness

Metering is billing. The standard is not "the fix looks reasonable" but "the
billed quantity is a function of the distinct audio the platform accepted."

### 5.1 M-66 — redelivery re-adds duration to the billed count

**Chain, confirmed.** `record_frame` adds `len(data)//2 / sample_rate` to
`total_duration_seconds` on every dispatched frame, with no seq check
(`session.py:207-219`). `_finalize_session_locked` reads
`audio_seconds = session.total_duration_seconds` (`session_manager.py:4160`),
puts it in the teardown summary (`:4242`), and the gateway emits it as the
`AUDIO_SECOND` component of the `transcribe.stream` ledger row
(`streamingSession.service.ts:427-465`). So `total_duration_seconds` IS the
invoice.

**The window.** `IngestionConsumer` dispatches a batch and XACKs *after*
(`redis_streams.py:424-432`); `last_seq` is persisted only on the periodic
`persist_if_needed` (`session_manager.py:3345`). A worker crash between dispatch
and XACK leaves entries in the PEL; recovery's first-pass
`XAUTOCLAIM(min_idle 0, force=True)` redelivers them (`redis_streams.py:374-380,
309-363`) and `record_frame` counts them again.

**The correctness argument.** The gateway assigns a monotonic `seq` once per
frame (`stt-ws.gateway.ts:1252-1255, 1272`) and it rides on the stream entry
(`streamingAudioBridge.service.ts:285-286`). Distinctness is therefore decidable
at ingest with no new state and no coordination: a frame whose `seq` is not
greater than the highest already counted is, by construction, audio the platform
already accepted and already billed. Billing on delivery count instead of on
distinct `seq` is billing on a transport artifact.

**Design.**

1. `record_frame` returns early on `seq <= self._metadata.last_seq`: no samples,
   no duration, no buffer append. Count `stt_audio_frame_redelivered_total`.
2. On `seq > last_seq + 1`, add the gap to `stt_audio_seq_gap_total` and to a
   `total_expected_samples` field, so coverage is derivable rather than inferred.
3. **Persist `last_seq` on the same cadence as the XACK.** `_on_batch` already
   HSETs `last_stream_id` into the meta hash every batch
   (`session_manager.py:3245-3254`); add `last_seq` to that same HSET. Without
   this, `last_seq` after a crash is whatever the *periodic* persist left behind,
   which can be well behind the frames actually counted — and those are re-counted
   regardless of step 1. This step is what bounds the residual double-count to a
   single batch, and it is the half most likely to be dropped as "tidying".
4. State the residual in the ticket: frames counted in the final batch before a
   crash, within one `_on_batch` window, can still be re-counted. Bounded by
   `COUNT 100` — sub-second of audio — and disclosed rather than claimed away.

Also fix the flag, not just the quantity: the reaper's push-back hard-codes
`interrupted=True` (`session_manager.py:4780-4790`) even for a session that was
cleanly stopped but whose gateway DELETE was lost. It does not change the billed
amount; it does mis-attribute. One line, §8 N-6.

### 5.2 M-65 — uncapped `processed_audio_buffer`

Confirmed asymmetry in `session.py`: `audio_buffer` is capped at
`_max_audio_buffer_bytes` with a one-shot WARN (`:222-231`), `ring_buffer` at 30 s
(`:234-240`), and `processed_audio_buffer` (`:128`) is extended unconditionally by
`_on_frame` (`session_manager.py:3303-3306`) with no cap at all. At 16 kHz mono
s16, raw + processed ≈ 230 MB per session-hour; against the capacity guard's
admitted 20 streams that is ~4.6 GB/hour on a 24 Gi limit.

**The constraint that makes the obvious fix wrong.** "Drop the uploaded prefix
after each snapshot" breaks `complete.wav`: `_finalize_session_locked` encodes the
WHOLE buffer (`session_manager.py:4356-4364`; `session.py:320-348`). That WAV is a
clinical artifact and PHI. So the fix is two steps with different risk, and they
must not be conflated:

1. **Now (L-STT):** give `processed_audio_buffer` the SAME cap and the same
   one-shot WARN `audio_buffer` has. One-line parity; removes the unbounded case
   outright. Export `stt_streaming_session_buffer_bytes{kind=raw|processed}` as a
   gauge so the §7.2 measurement has something to read.
2. **Its own ticket:** stop holding the complete WAV in memory at all. The
   snapshot loop already uploads deltas as indexed chunks
   (`session_manager.py:4840-4875`). Replace the finalize-time
   `upload_streaming_*_complete` with a MinIO multipart completion over those
   parts (44-byte WAV header as part 0; the snapshot cadence must respect the
   5 MiB minimum part size for all but the last). Memory then bounds at one
   snapshot interval instead of session length. **Acceptance is byte-identical
   `complete.wav` on a fixture clip against the current path** — a change to how a
   PHI artifact is assembled is proven, not argued.

### 5.3 M-50 — bounded, with two residuals worth landing here

`session.close()` sets TTLs on `stt:audio`, `stt:result`, `stt:control`
(`session.py:538-546`) but never `UNLINK`s them, and `stt:result` is never
trimmed (only `stt:audio` is, `session_manager.py:3266-3269`). Redis is 512 MB
`noeviction`. Bounded, but free to fix: `UNLINK` the three keys at finalize after
the durable transcript is persisted, and give `stt:result` the same periodic
`XTRIM MINID` treatment keyed on the captions group's cursor. Fold the data-tier
README correction in with M-60 (docs lane, not D8).

---

## 6. Ordering and ownership

### 6.1 Lanes

| Lane | Owns (files) | Items |
|---|---|---|
| **L-CONTRACT** | `packages/types/src/asr-spec.ts`, `build-resolved-asr-spec.ts`, `apps/stt/src/stt/pipeline/spec.py`, `tests/contracts/resolved-asr-spec.fixture.json` | M-49 chain (§3.1) |
| **L-STT** | `apps/stt/src/stt/streaming/{session_manager,session,whisper_cpp_asr,engine_switch,inference,redis_streams}.py`, `apps/stt/src/stt/streaming/api/routes.py` | §1.3 latch, §1.5 stash, §2 M-24, §3.2 M-34, §5.1 M-66, §5.2 step 1, §5.3, §8 N-1 |
| **L-GW** | `apps/api/src/modules/streaming/stt-ws.gateway.ts`, `transcription-job.controller.ts`, `packages/applications/src/services/stt/streaming/*`, `.../descriptors/stt-gateway.descriptors.ts` | §1.4 terminal frame, §1.5 items 4-5, M-47, M-48, M-64, M-68, ST-5 |
| **L-SDK** | `packages/agentic-sdk-v2`, `packages/stt`, `packages/vox-node`, the playground hook | M-22 client half, quiet-window 0 / wait-for-`closed`, `close` after drain, `stopAndDrain` on the hook, `finalize(): Promise` on vox-node, M-46, QW-11 |

### 6.2 Sequencing, and why each edge exists

1. **L-CONTRACT → L-STT's M-34/M-49 work.** The chain shape changes
   `ResolvedSpecBundle` and `EngineSwitchController`'s constructor. Doing M-34
   first means rewriting `_apply` when the chain lands, and the cross-language
   parity fixture is a SINGLE artifact — two lanes editing it is the
   one-writer-per-file rule (`14-multi-agent-worktrees.md` §3), not a preference.
2. **L-STT's latch (§1.3) → L-GW's terminal frame (§1.4).** This edge is
   counter-intuitive and it is the most important one in this dossier. The
   terminal frame makes `_on_frame` the FIRST finalizer and moves the tail flush
   LATER (it now starts only after the whole audio backlog has drained), which
   *widens* the window in which the SDK's DELETE overtakes it. Landing the frame
   before the latch makes M-04 more likely, not less.
3. **L-STT's stash (§1.5) → L-GW's finalize-on-`closed` (§1.5 item 5).**
   Finalizing on `closed` brings the gateway's DELETE forward relative to the STT
   finalize — straight into the window that today answers 204. The stash must
   exist before that window is widened, or ledger coverage gets worse first.
4. **M-64 and M-68 are logically independent but share `stt-ws.gateway.ts`**, so
   they belong to the SAME lane and are sequenced INSIDE it. Two agents on that
   file is the anti-pattern rule 14 names; "independent" is about logic, not about
   merge safety.
5. **Within L-STT, M-24 and M-34 both touch `session_manager.py`** (`:2968-2971`
   and `:1463-1481` respectively) — same file, therefore sequential within the one
   lane, not parallel. Same for §1.3 and §1.5, which both edit
   `_finalize_session_locked`.
6. **L-SDK last.** Every SDK change makes the client wait LONGER for a server that
   must first be correct. `quietWindowMs: 0` shipped before the latch converts a
   250 ms early exit into a 1 500 ms timeout on every single stop, with no
   correctness gain — a latency regression bought for nothing.
7. **ST-5's descriptors before lowering the watermark.** 512 KiB → 32 KiB as an
   env default needs a redeploy to undo; behind a descriptor it is a control-plane
   write. Register first, then change the default.

**Merge order: L-CONTRACT → L-STT → L-GW → L-SDK**, each re-running its own gates
AFTER the merge (a clean merge is not a passing build). Gates per lane:
`pnpm stt:test` + `stt:lint` + `stt:typecheck` for L-STT; `pnpm test:unit` +
`pnpm api:build` + the e2e sweep for L-GW; `pnpm --filter @arcaai/vox build test
lint typecheck` for L-SDK; L-CONTRACT runs both the TS and Python halves plus the
contract fixture test.

---

## 7. Test plan

### 7.1 Automated (in-lane, TDD — every row must be RED first)

| Item | Test | Location | Asserts |
|---|---|---|---|
| §1.3 latch | `test_session_manager_tail_flush_guard.py` (extend) | L-STT | a second trigger entering while the first is mid-flush does NOT reach `_finalize_session` before `tail_done` is set; `closed` is published after the tail's `add_result` |
| §1.3 latch | same file, new case | L-STT | a RAISING `_drain_inference_queue` still sets the event (no deadlock) and the second trigger proceeds |
| §1.3 latch | same file, new case | L-STT | the bounded wait times out → ERROR logged, teardown still completes, capacity released |
| §1.4 terminal frame | `stt-ws.gateway.spec` unit | L-GW | `{type:'stop'}` writes `writeAudioFrame(..., isFinal=true)` with a zero-length buffer and does NOT write the control command synchronously |
| §1.4 terminal frame | `test_session_manager_finalize_ordering.py` (extend) | L-STT | a zero-length `final=1` frame adds 0 samples and 0 s duration, and triggers the flush path |
| §1.5 stash | new `test_session_manager_teardown_stash.py` | L-STT | control-path finalize stashes; a later DELETE answers 200 with that summary, not 204; the stash expires |
| §1.5 gateway | `streamingSession.service.test.ts` (extend) | L-GW | a 200-with-summary after a control-path finalize emits exactly one `transcribe.stream` row with `interrupted=false` |
| §2 M-24 | new `test_whisper_cpp_fault_injection.py` cases (a)–(g), §2.6 | L-STT | `ModelError` raised on each failure condition; never on silence |
| §2 M-24 | `test_session_manager_auto_switch_task614.py` (extend) | L-STT | the injected fault reaches `record_failure` and publishes `provider_switched` |
| §2.5 tail hole | same | L-STT | a `ModelError` from the TAIL path reaches `record_failure` |
| §3.1 chain | contract fixture round-trip, TS + Python | L-CONTRACT | a two-entry chain survives resolver → wire → `ResolvedSpecBundle`; `spec` alias still reads `chain[0]` |
| §3.1 resolver | `build-resolved-asr-spec` unit | L-CONTRACT | a dropped entry emits an `onProfileRejection` (interim fix) |
| §3.2 M-34 | new `test_engine_switch_state_rederivation.py` | L-STT | after `_apply`, the worker's prompt / window / lexicon / language come from the FALLBACK spec, not the primary's |
| §3.2 M-34 | same | L-STT | a mid-utterance manual switch resets the commit policy and cancels the in-flight partial |
| M-22 | `SttWebSocketClient.test.ts` | L-SDK | `connect()` does not resolve before `ready`; resolves with a WARN on `readyTimeoutMs`; no "Unknown message type" for `ready`/`resumed` |
| M-47 | gateway unit with fake timers | L-GW | two missed pongs terminate; one miss does not; a pong resets |
| M-48 | `streamingAudioBridge.service.test.ts` | L-GW | the rebind path reclaims at `min-idle 0`; with the stable name (option a) a redelivered entry keeps its original `seq` |
| M-64 | `transcription-job.controller` unit | L-GW | a rejected post-create write calls `removeSession(id, true, tenant)` and rethrows the original error |
| M-68 | gateway unit | L-GW | the per-tenant count is unchanged by a disconnect until the grace expires; `finalizing` sessions are excluded |
| ST-5 | gateway unit | L-GW | the resume buffer holds one partial per `utteranceIndex`; every final survives; over-age entries are not replayed |
| ST-5 | descriptor registry test | L-GW | both new keys are registered, `globalOnly`, `system`-scoped, `open-to-default` |
| §5.1 M-66 | new `test_session_frame_seq_continuity.py` | L-STT | a redelivered `seq` adds no duration and increments the redelivery counter; a gap increments the gap counter; `last_seq` is HSET on every batch |
| §5.2 M-65 | `test_snapshot_processed_audio.py` (extend) | L-STT | `processed_audio_buffer` stops growing at the cap and WARNs exactly once; the gauge reports both kinds |
| §8 N-1 | new `test_capacity_reconciler_create_window.py` | L-STT | a session in creation is not reclaimed by `_reconcile_capacity_guard` |

Plus one **stop-after-speech e2e** (`apps/api/tests/e2e/`, Playwright against the
live gateway): play a clip whose last 1.5 s is a known phrase, issue `stop`
300 ms after it ends, assert the phrase appears in the live caption stream AND in
`transcript.json` AND that exactly one `transcribe.stream` row exists with
`interrupted = false`. That single spec covers M-04, M-23 and M-29 end to end and
is the acceptance test for QW-1.

### 7.2 Live measurements — for the ORCHESTRATOR only

I ran none of these and must not. Each states arms, metric and the decision it
settles.

| # | Question | Arms | Metric | Decision rule |
|---|---|---|---|---|
| 1 | Does the latch alone close the tail race, or is the terminal frame also needed? | (a) HEAD, (b) HEAD+latch, (c) HEAD+latch+terminal frame | fraction of runs where the last GT utterance is in BOTH the caption stream and `transcript.json`; N ≥ 20 per arm, `cardiology_consult_01` + a scripted 1.5 s tail, stop 300 ms after it ends | (b) ≥ 0.95 and (c) = 1.00 ⇒ ship both. If (b) = 1.00, re-run (b) vs (c) with a 2 s artificial ingest stall before deciding whether the frame is deferrable |
| 2 | Is ledger coverage restored, with the right flag? | HEAD vs HEAD+stash+finalize-on-`closed` | `count(transcribe.stream rows) / count(sessions)` over 20 clean stops; `interrupted` distribution | ratio = 1.000 and `interrupted = false` on every clean stop |
| 3 | Is the declared fallback actually reachable after M-24? | HEAD vs HEAD+M-24, fault injected by pointing the primary row at a corrupt GGUF (or a test-only poison hook) | `stt_provider_switch_total{reason="auto"}`; finals still produced | HEAD must show **0** (confirming today's unreachability — this arm is the proof of the finding, not a formality) and the fix ≥ 1 with the session still transcribing |
| 4 | How fast is a half-open client detected? | HEAD vs HEAD+ping | seconds from a firewall-dropped client egress to STT `remove_session` | ≤ 60 s (against ~300 s today) |
| 5 | Does the rebind lose read-but-unemitted finals? | unique vs stable consumer name (or min-idle-0 rebind), socket force-closed 200 ms after a final is published | finals delivered to the reconnected client / finals in `transcript.json`; duplicate `seq` count observed by the client | 1.000 delivered AND 0 duplicate seqs. A duplicate means the §4.3(a) re-emission guard is required before shipping the stable name |
| 6 | How much memory does a session hold? | HEAD vs HEAD+processed-buffer cap | RSS delta over a 30-minute session; `stt_streaming_session_buffer_bytes` | bounded by the cap; report the absolute number — it is the input to the §5.2 step-2 go/no-go |
| 7 | Is capacity accounted correctly across a cold create? | HEAD vs HEAD+N-1 fix, model TTL-evicted immediately before the create so the load straddles a heartbeat tick | `stt_streaming_active_sessions` vs the guard's `active_count` 30 s after create | equal in the fixed arm; HEAD expected to show guard < sessions (reproducing the §2.3 observation) |
| 8 | Does the fallback speak the right language after M-34? | forced failover, ml-en clip | CER + Latin-script ratio of the post-switch finals vs the pre-switch finals | post-switch CER within the ml-en gate's band; a script flip at the switch boundary blocks ST-6 |

Measurement 3's HEAD arm is worth calling out separately: it is the only cheap
way to turn "the fallback chain is unreachable" from a code argument into an
observation, and it costs one session.

---

## 8. New defects

| Id | Claim | Evidence | Sev | Suggested fix |
|---|---|---|---|---|
| **N-1** | The capacity reconciler releases an IN-CREATION session's slot. `try_acquire` runs at `session_manager.py:1085`; the session enters `_sessions` only at `:1278`. `_reconcile_capacity_guard` (`:4931-4947`) runs every `_heartbeat_interval_s` (default 10, `:385`) and releases every guard id not in `_sessions`. A cold model load — measured at ~4.6 s in README §2.3, and 16.87 s on the cluster per `stt-gateway.descriptors.ts` — straddles a tick. The slot is freed while the session goes on to live, so the cap is silently exceeded and the later `remove_session` release is a no-op. Observed live in README §2.3 and left untriaged. | `session_manager.py:1085,1278,4931-4947,385` | **med** | track `self._creating: set[str]`, added before `try_acquire` and discarded in the same `finally` that releases on failure; `leaked = guard_ids - tracked_ids - creating_ids` |
| **N-2** | The commit policy is not reset at an engine switch. `_reset_commit_policy` is called only at utterance finalization (`:3314`) and in the tail flush (`:3545`), never in `_apply` (`:1463-1481`). A MANUAL switch arrives on the control stream mid-utterance, so `LocalAgreementPolicy` then computes `stable_chars` as the agreed prefix of one hypothesis from engine A and one from engine B. | `session_manager.py:1463-1481, 3314, 3545`; `commit_policy.py:265-273` | low | reset the policy and cancel the in-flight partial inside `_apply`, in the same synchronous body as the callable swap |
| **N-3** | A `ModelError` raised on the TAIL path can never arm the fallback. `_flush_final_utterance` swallows every exception (`:3565-3571`) and `_run_inline_inference` has its own broad `except` (`:3486-3493`), so the closing utterance — the one most worth recovering — is the one failure the engine switch cannot see. Latent today (nothing raises), load-bearing the moment M-24 lands. | `session_manager.py:3486-3493, 3565-3571`; `inference.py:515-528` | med (once M-24 lands) | re-raise `SWITCHABLE_ASR_ERRORS` from both handlers and route them through `controller.record_failure`, as `inference.py:515` already does |
| **N-4** | The 60 s zombie drain. When a later finalizer's `remove_session` cancels the inference loop (`:1716`), the FIRST finalizer is still inside `wait_for(queue.join(), timeout=60)` (`:3037`); `task_done()` is never called, so it blocks the full timeout and then runs `_settle_inference_loop` + `_drain_remaining_inline` against a session the manager has already dropped (`_drain_remaining_inline` returns early on the missing session, `:3078-3080`). | `session_manager.py:1716-1727, 3022-3048, 3073-3092` | low | fixed as a side effect of §1.3 (the second finalizer can no longer overtake), but assert it: a test that no coroutine survives teardown by more than the tail-wait bound |
| **N-5** | `StreamingSessionService.removeSession` treats HTTP 204 and "no summary built" identically, with no warn and no counter (`:411-431`), so the M-23 ledger loss is invisible in metrics — it required a code read to find. | `streamingSession.service.ts:411-431` | low | WARN + `stt_stream_teardown_summary_missing_total`, labelled by `status` |
| **N-6** | The reaper's usage push-back hard-codes `interrupted=True` (`:4780-4790`) even for a session the clinician stopped cleanly whose gateway DELETE was lost. Quantity is right, attribution is wrong. | `session_manager.py:4780-4790` | low | stamp the finalize REASON on the summary at build time and let the push-back forward it, instead of asserting an abort |
| **N-7** | `.env.sample` and `turbo.json` both declare `STT_WS_EGRESS_HIGH_WATERMARK_BYTES` / `STT_WS_RESUME_GRACE_MS` as governed-looking runtime vars while the code reads them at MODULE SCOPE (`stt-ws.gateway.ts:91-94,114-121`), so a change requires a pod restart, not a redeploy of config. That is the §4.6 tier violation restated as a documentation defect: the declaration implies a mutability the code does not have. | `stt-ws.gateway.ts:91-94,114-121`; `turbo.json:589-590`; `.env.sample:753,758` | low | ST-5's descriptors; until then, a comment at each const stating it is read once at import |

Refuted / narrowed during this pass, so they are not re-raised:

- **Not a defect:** `handleDisconnect` unsubscribing the captions reader for the
  grace window (`:1160-1167`) does not lose finals — it drops only THIS gateway
  subscription, not `unsubscribeFromResults`, so the `LiveDocumentationService`
  fan-out keeps reading and a reconnect resumes from the group's Redis-owned
  cursor. The comment there is accurate.
- **Narrowed:** M-34's "the fallback chain's `initial_prompt` is discarded" is
  true, but the fallback `PipelineSpec` — prompt, lexicon, window, streaming
  geometry — is fully mapped and already in memory
  (`spec.py:715-790`, `session_manager.py:1827-1872`). The fix is a re-derivation
  at `_apply`, not a re-resolution; it costs no DB read and no model reload.
- **Narrowed:** M-65's "drop the uploaded prefix after each snapshot" cannot ship
  as stated — `complete.wav` is encoded from the whole buffer at finalize
  (`session_manager.py:4356-4364`). §5.2 splits it into a one-line cap now and a
  multipart-assembly ticket with a byte-identity acceptance test.
