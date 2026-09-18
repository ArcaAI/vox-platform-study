# TASK-985 — D2 design dossier: segmentation & endpointing

| | |
|---|---|
| **Area** | D2 — segmentation & endpointing |
| **Covers** | M-07 / QW-13, M-13, M-29 (segmentation half), M-39, M-40, ST-2, BP-7, BP-4b arm (2), OD-C; §2.5 error classes 2 and 3 |
| **Owned files** | `apps/stt/src/stt/streaming/preprocessor.py`, `apps/stt/src/stt/streaming/semantic_endpointer.py` |
| **Read-only / patch-request files** | `session_manager.py` (session lane), `inference.py` + `whisper_cpp_asr.py` (decode lane), `commit_policy.py` (commit lane), `core/metrics.py` (shared), `pipeline/{dto,spec}.py` (contract), `packages/database/.../seed/25-agents.ts` (seed) |
| **Base** | `agent/agent-transcription-coordination-9dbc25` = `dev-2.2` @ `3f9145a98` |
| **Method** | Static read only. No test, no service, no build was run. Every number below is either read off the source or derived arithmetically from constants that are quoted with their `file:line`. Anything that needed a measurement is in §7 as a numbered request, not asserted. |

---

## 0. The one-paragraph finding

The streaming front end has **one segmenter running today and it is not the one the
configuration describes**. `vad.enabled: false` means Silero never loads
(`session_manager.py:1898-1903`), so every session segments on
`StreamingPreprocessor._run_energy_fallback` (`preprocessor.py:665-698`). That fallback
measures RMS on the **peak-normalized** frame while its noise-floor ceiling
(`_FALLBACK_NOISE_FLOOR_MAX = 0.015`, `:35`) is a **raw**-amplitude number — a units
mismatch that makes the "adaptive" floor saturate in exactly the quiet rooms it was
meant to adapt to, and turns the gate into a fixed absolute detector at **-53 dBFS of
raw ambient** (M-07). The same normalized samples then reach the hallucination RMS gate
(`inference.py:1187`), which therefore cannot fire on the utterances the energy gate
opened. Meanwhile the agent's own VAD tuning (`threshold 0.5 / minSpeech 100 /
minSilence 350`) is dropped on the floor because `_build_preprocessor_vad_kwargs` reads
it only inside `if ... vad.enabled` (`session_manager.py:510-524`), so endpointing runs
on the hardware profile's 500 ms literal (M-13). The fixes for those two are small,
independent of each other, and independent of OD-C. ST-2 (Silero as primary segmenter)
is the structural answer and should land **after** both, because it changes four knobs
at once if it lands first.

---

## 1. QW-13 — room-tone false onsets (M-07)

### 1.1 Mechanism, confirmed line by line

1. `feed()` normalizes **before** anything else and **reassigns the frame**:
   `preprocessor.py:421-423` — `if self._normalize: frame_f32 = self._normalize_frame(frame_f32)`.
   From that point on there is no raw frame in scope. `vad_frame = frame_f32` (`:428`),
   `state.utterance_buffer.append(frame_copy)` (`:508`) and
   `self._processed_samples.append(...)` (`:509`) all carry normalized audio.
2. `_normalize_frame` (`:339-352`) divides by
   `self._peak_tracker = max(max(self._peak_window), _NORMALIZER_MIN_PEAK)` where
   `_NORMALIZER_MIN_PEAK = 0.05` (`:66`) and `_peak_window` is a sliding
   `_NORMALIZER_WINDOW_MS = 3000` ms max (`:61`, `:252-254`). After **> 3 s** with no
   speech the window holds ambient peaks only; if ambient peak < 0.05 the divisor floors
   at 0.05, so **gain = 20×, exactly**.
3. `_run_energy_fallback` (`:665-698`) computes `rms` from that normalized frame (`:679`),
   adapts an EMA noise floor `min(..., _FALLBACK_NOISE_FLOOR_MAX)` = **0.015** (`:691`,
   `:35`), sets `adaptive_threshold = max(1e-4, floor × 2.5)` (`:696`, `_ENERGY_MULTIPLIER`
   at `:34`) and returns `probability = rms / (2 × threshold)` (`:697`).
4. Onset needs `prob >= self._threshold`, which on the served path is the **constructor
   default 0.6** (`:151`) because M-13 stops the agent's 0.5 arriving.

### 1.2 The arithmetic (this is the whole bug)

The EMA is fed normalized RMS but clamped by a raw-scale ceiling. In a quiet room the
clamp always binds:

| Quantity | Value |
|---|---|
| gain after a > 3 s pause (ambient peak < 0.05) | 20× |
| EMA ceiling in normalized units | 0.015 |
| ...the **raw** level that ceiling corresponds to | 0.015 × 0.05 = **0.00075** (-62 dBFS) |
| ⇒ any room quieter than -62 dBFS saturates the "adaptive" floor | the gate is no longer adaptive |
| saturated threshold | 0.015 × 2.5 = 0.0375 |
| normalized RMS needed for `prob >= 0.6` | 0.6 × 2 × 0.0375 = **0.045** |
| raw RMS that produces it at 20× gain | 0.045 / 20 = **0.00225** |
| in dBFS | 20·log₁₀(0.00225) = **-52.96 dBFS** |

That reproduces M-07's "-53 dBFS" exactly, and it identifies the *cause* more precisely
than M-07 states it: the normalizer is not the bug on its own — the bug is that
`_FALLBACK_NOISE_FLOOR_MAX` is a raw-amplitude constant applied to a normalized
measurement, which **disables the adaptation that would otherwise absorb the gain**.
Without the clamp the EMA would climb to 0.045, threshold to 0.1125, `prob` to 0.4, and
no onset would occur. (Note the design intent is visible at `:62-66`: the divisor floor
was added precisely to stop this, and it only bounds the gain at 20× rather than
removing the coupling.)

Then, once such an utterance is open, the hallucination gate cannot rescue it:
`_is_hallucination` reads `utterance.samples` (`inference.py:1187`), i.e. the same
normalized audio, against `hallucination_rms_threshold = 0.01` (`dto.py:798`). The
room-tone utterance measures 0.045 ≫ 0.01, so gate 2 never trips, and the text goes out
as a final. **Both halves of M-07 are confirmed.**

`threshold` is not a rescue either: fixing M-13 alone forwards the agent's 0.5, which
moves the trip point to raw 0.0025 = **-52.0 dBFS**. One decibel. M-13 and M-07 are
genuinely independent.

### 1.3 Why the existing test did not catch it

`test_streaming_preprocessor.py:1746 test_normalizer_never_amplifies_noise_floor` feeds a
0.002 constant frame and asserts `max(out) <= 0.05`. 0.002 × 20 = 0.04, so it passes —
but the assertion is about the **normalizer's output ceiling**, not about what the energy
gate does with it, and the test's name ("never amplifies noise floor") states a property
the code does not have: it amplifies the noise floor by exactly 20×, it merely stops
short of full scale. The test should be renamed and joined by the gate-level tests in §7.

### 1.4 Decision — scale the gate, do not un-normalize the frame

Three candidate fixes were considered:

| Option | Verdict |
|---|---|
| (a) Gate on the pre-normalization frame kept in a second variable | **Rejected.** The pre-normalization frame is also **pre-resample** (`:421-423`) and **pre-denoise** (`:429-434`). Gating on it re-admits out-of-band HF energy that the anti-alias filter removes (a hiss-heavy room measures *higher*, i.e. more likely to open — the wrong direction) and throws away the denoiser's contribution to the gate, which is the whole point of `denoise_scope="vad_only"` (`:200-203`). |
| (b) Carry the normalizer's current gain and divide the measured RMS by it | **Chosen.** Exact undo of a known scalar, applied *after* resample and denoise, so the gate keeps both. One field, one division. Correct by construction when `normalize` is off (gain stays 1.0). |
| (c) Emit raw-scaled samples to the decoder | **Rejected** — the brief requires the 20× gain be kept for the decoder input, and the normalizer exists to make a quiet mic decodable. |

**The 20× gain for the decoder is untouched.** Only the two *gates* move into raw units.

### 1.5 Patch — `preprocessor.py` (my file)

1. `__init__`, beside `self._peak_tracker = 0.0001` (`:204`):
   ```python
   # Gain the normalizer applied to the most recent frame (1.0 when
   # `normalize` is off). The energy gate and the downstream hallucination
   # RMS gate are thresholds on the ROOM, so they are evaluated in raw
   # amplitude; the 20x gain stays on the samples the DECODER sees.
   self._normalizer_gain: float = 1.0
   ```
2. `_normalize_frame` (`:339-352`), after `self._peak_tracker = ...` at `:351`:
   ```python
   self._normalizer_gain = 1.0 / self._peak_tracker
   ```
3. `reset()` (`:282-291`), beside `self._peak_tracker = 0.0001`:
   `self._normalizer_gain = 1.0`
4. `_run_energy_fallback` (`:679`):
   ```python
   rms = float(np.sqrt(np.mean(np.square(frame)))) / self._normalizer_gain
   ```
   and rewrite the `_FALLBACK_NOISE_FLOOR_MAX` comment to name the unit:
   `0.015 raw amplitude ≈ -36.5 dBFS — the loudest room whose floor we still
   track; above it the EMA is clamped so it cannot chase speech.`
5. `AudioUtterance` (`:89-106`): add
   ```python
   # Peak-normalizer gain applied to `samples` at emit time (1.0 when the
   # stage is off). Downstream ENERGY gates must divide by it: the samples are
   # amplified for the decoder, the thresholds are about the room.
   normalizer_gain: float = 1.0
   ```
   and set it in `_emit_utterance` (`:844-851`) and `_maybe_emit_partial` (`:792-799`)
   from `self._normalizer_gain`.

**Scalar-vs-exact.** `_normalizer_gain` at emit time is the gain in force over the last
3 s peak window, not a per-frame average across the utterance. That is exact for
room-tone (the divisor is pinned at the 0.05 floor throughout) and sound for the gate's
actual scope, which is `word_count <= 3` (`inference.py:1186`) — at most ~1.5 s of audio,
inside one peak window. If BP-7 shows the approximation missing a case, the escalation is
an exact raw sum-of-squares accumulator carried in parallel with `utterance_buffer`;
I deliberately did **not** start there because that parallel list has to be sliced
identically by the force-emit split (`:521-523`), the carry (`:875-880`) and the partial
window (`:775-782`), which is three new places to get wrong for a gate that fires on ≤ 3
words.

### 1.6 What changes for sessions that are fine today (the risk, stated)

After the fix the energy gate is a **relative** detector again, in raw units:

| Scenario (raw) | floor EMA | threshold | prob at speech | onset? |
|---|---|---|---|---|
| quiet room, ambient RMS 0.00225 | 0.00225 | 0.0056 | ambient 0.2 | **no** (was yes) |
| same room, speech RMS 0.03 | 0.00225 | 0.0056 | 5.3 → clipped 1.0 | yes |
| loud room, ambient RMS 0.02 | clamped 0.015 | 0.0375 | ambient 0.27 | no |
| loud room, speech RMS 0.08 | clamped 0.015 | 0.0375 | 1.07 | yes |

The EMA adapts at 0.05/frame (`:690`) ⇒ τ ≈ 20 frames ≈ **640 ms**, and it is frozen
while an onset attempt or the post-emit cooldown is live (`:685-689`,
`_NOISE_FLOOR_COOLDOWN_FRAMES = 15`, `:36`), so a > 3 s pause is always fully adapted.
The unchanged risk window is the first ~640 ms of a session, where the seed
`_fallback_noise_floor = 0.002` (`:275`) stands in — which is a *sane raw* room-tone
estimate (-54 dBFS) and was a *nonsense normalized* one, so cold-start behaviour improves
as a side effect.

This changes onset behaviour on **every energy-path session**, i.e. every session today.
That is why BP-7 must run both the room-tone clip and the three English fixtures
(measurement request **MR-1**), and why QW-13 must not be merged on the room-tone number
alone.

### 1.7 Independence from OD-C — stated for the record

`_run_energy_fallback` is reached from `_run_vad` in three ways (`:645-663`): no VAD
service, service not loaded, **and any per-frame Silero exception**. So even if OD-C
turns Silero on for the SYSTEM agent, the energy path remains live for (i) every tenant
whose agent has not opted in, (ii) every session whose `_load_vad_service` load failed
(`session_manager.py:1919-1925` swallows and returns `None`), and (iii) every frame that
throws inside ONNX. QW-13 governs all three. It is a prerequisite of ST-2, not an
alternative to it.

---

## 2. M-13 — the agent's VAD tuning is inert

### 2.1 Confirmed

The mapper **does** carry the tuning regardless of `enabled`:
`spec.py:669-677` writes `threshold`, `min_speech_duration_ms`, `min_silence_duration_ms`
and `padding_ms` into `VadConfig` whenever the agent stated them, and
`preprocessing.vad = VadConfig(**vad_kwargs)` (`:687`). So
`pipeline_config.preprocessing.vad.min_silence_duration_ms == 350` on the served session.

The loss is entirely in one `if`:
`session_manager.py:510` — `if pipeline_config and pipeline_config.preprocessing.vad.enabled:` —
whose `else` at `:523-524` substitutes `self._profile.vad_silence_threshold_ms`, which is
the literal `500` on **all five** hardware profiles (`execution_profile.py:161, 186, 209,
243, 283`). The seed's Lane-F2 comment at `25-agents.ts:260` ("`minSilenceMs` 500 -> 350")
therefore describes a change that has never run. Confirmed.

Four values differ between the two branches, not one:

| kwarg | `vad.enabled: false` (today) | `vad.enabled: true` | source of the "true" value |
|---|---|---|---|
| `threshold` | 0.6 (preprocessor default, `preprocessor.py:151`) | 0.5 | agent (`25-agents.ts:273`) |
| `min_speech_duration_ms` | 100 (preprocessor default, `:152`) | 100 | agent — same value, coincidentally |
| `min_silence_duration_ms` | **500** (profile literal) | **350** | agent |
| `pre_speech_context_ms` | 300 (`_PRE_SPEECH_CONTEXT_MS`, `:32`) | **500** | `VadConfig` default (`dto.py:604`) — *no agent field exists* |

That last row is a defect of its own (D2-N1 below) and it is why ST-2 must not be the
first thing that flips `enabled`.

### 2.2 Patch — `session_manager.py` (session lane; patch request CL-1)

Replace `:510-524` with an unconditional read, keeping the `hasattr` guards that let the
deprecated YAML path pass a partial config:

```python
# The agent's segmentation TUNING is read whether or not the Silero stage is
# on: the energy fallback is still a segmenter, and it obeys the same four
# numbers. Only the MODEL is gated by `vad.enabled` (`_load_vad_service`).
vad_cfg = getattr(getattr(pipeline_config, "preprocessing", None), "vad", None)
if vad_cfg is not None:
    kwargs["threshold"] = vad_cfg.threshold
    kwargs["min_speech_duration_ms"] = vad_cfg.min_speech_duration_ms
    kwargs["min_silence_duration_ms"] = vad_cfg.min_silence_duration_ms
    for name, attr in (
        ("pre_speech_context_ms", "pre_speech_context_ms"),
        ("max_utterance_duration_ms", "force_emit_after_ms"),
        ("force_emit_lookback_ms", "force_emit_lookback_ms"),
        ("force_emit_overlap_ms", "force_emit_overlap_ms"),
    ):
        if hasattr(vad_cfg, attr):
            kwargs[name] = getattr(vad_cfg, attr)
# no `else` branch: with no pipeline config at all the preprocessor's own
# constructor defaults stand, which is the TASK-877/880 rule for every other knob.
```

Then **delete `ExecutionProfile.vad_silence_threshold_ms`** — the field
(`execution_profile.py:65`) and all five literals (`:161, 186, 209, 243, 283`). It has
exactly one production reader (`session_manager.py:524`) and it is the thing being
removed. This is QW-3's own instruction ("delete `vad_silence_threshold_ms`"), so D2 and
the QW-3 lane must not both do it — see §6.

**Behaviour delta this alone produces, on the served agent:** `min_silence` 500 → 350 ms
(finals cut 150 ms sooner — *more* fragmentation, §2.5 class 2, which is why it is
measured as BP-4b arm (2) and not merged on faith), `threshold` 0.6 → 0.5 (a *lower* bar,
i.e. **more** room-tone onsets until QW-13 lands — so **QW-13 must merge first or in the
same change**), and `pre_speech_context_ms` 300 → 500 ms (200 ms more pre-roll audio on
every utterance).

### 2.3 Log the effective values

The session log answers "which windows did this session get" (`stt.streaming.windows`,
`session_manager.py:779-785`) and says nothing about segmentation. Rather than duplicate
the numbers at the call site — which is how they drifted — expose them from the object
that applies them.

In `preprocessor.py` (my file):

```python
@property
def effective_segmentation(self) -> dict[str, Any]:
    """The numbers this preprocessor is ACTUALLY running on.

    TASK-985 M-13: the admin UI showed 350 ms while 500 ms ran. The one place
    that can answer honestly is the object holding the value.
    """
    return {
        "segmenter": "silero" if (self._vad_service is not None
                                  and self._vad_service.is_loaded) else "energy",
        "threshold": self._threshold,
        "neg_threshold": self._neg_threshold,
        "min_speech_ms": self._min_speech_duration_ms,
        "min_silence_ms": self._min_silence_duration_ms,
        "pre_speech_context_ms": round(self._pre_speech_frames * self._frame_duration_ms),
        "max_utterance_ms": round(self._max_utterance_frames * self._frame_duration_ms),
        "partial_window_s": self._partial_window_s,
        "partial_interval_s": self._partial_interval_s,
        "normalize": self._normalize,
        "endpointing": "semantic" if (self._endpointer is not None
                                      and self._endpointer.enabled) else "fixed",
        "endpoint_min_silence_ms": getattr(
            getattr(self._endpointer, "_config", None), "min_endpoint_silence_ms", None),
        "endpoint_min_words": getattr(
            getattr(self._endpointer, "_config", None), "min_words", None),
    }
```

(the two `_config` reads want a small public accessor on `SemanticEndpointer` —
`SemanticEndpointer.config` — which is also mine to add.)

Patch request **CL-2**: at `session_manager.py:779-785`, add
`**preprocessor.effective_segmentation` to the existing `stt.streaming.windows` INFO
line, or emit a sibling `stt.streaming.segmentation` line. One INFO line per session; no
PHI; bounded keys. `segmenter` deliberately reports what LOADED, not what was declared,
which is the same distinction `has_vad=runtime.vad_service is not None`
(`session_manager.py:1350`) already makes and `session._vad_active = runtime.vad_enabled`
(`:1271`) still gets wrong.

---

## 3. ST-2 — VAD-gated segmentation (the structural design)

### 3.1 Target configuration

| Knob | Value | Where it lives | Note |
|---|---|---|---|
| `vad.enabled` | `true` | `25-agents.ts:273` (SYSTEM/Global agent row) | the model binding is already there |
| `vad.modelSlug` | `silero-vad` | same | already bound; `buildResolvedAsrSpec`'s 409 `ASR_AGENT_VAD_MODEL_MISSING` guard cannot fire |
| `threshold` | **0.5** | agent | Silero v5 upstream default (F9-V1) |
| neg / off threshold | **0.35**, derived | `preprocessor.py:53,172` | `_NEG_THRESHOLD_GAP = 0.15` already implements exactly the upstream `neg_threshold = threshold - 0.15`; **no change needed** |
| `minSpeechMs` | **100** (band 100–250) | agent | already 100; keep, do not raise — `dto.py:594-597` records why 250 was wrong |
| `minSilenceMs` | **350** (band 300–500) | agent | reaches the engine only after M-13 |
| pre/post pad | **200** (band 100–300) | see §3.5 | today the streaming pre-roll is `pre_speech_context_ms`, and no agent field maps to it |
| `endpointing` | `vad` | `AsrSpecStreaming.endpointing` literal (`spec.py:410`) | new third value; see §3.6 |
| `maxUtteranceSec` | leave at 60 **until** §5 | agent | do not change it in the same release |

Energy is demoted from segmenter to **pre-VAD noise floor** (§3.4).

### 3.2 Where Silero runs relative to the 32 ms loop

It already runs in the right place and nobody has to move it:
`feed()` → `_run_vad(vad_frame)` (`preprocessor.py:448`) → `SileroVADService.process_chunk`
(`silero_service.py:198-250`), one ONNX `session.run` per 512-sample frame, carrying the
per-session LSTM state in `VADSessionState.h_state` (`:231-243`) off a process-wide
singleton whose graph is stateless (`get_vad_service`, `:431-456`).

Two properties matter and both are already correct:

- **Thread settings are pinned to 1/1 CPU** (`silero_service.py:76-83`:
  `inter_op_num_threads = 1`, `intra_op_num_threads = 1`,
  `providers=["CPUExecutionProvider"]`). Do **not** relax these. The pod runs
  `OMP_NUM_THREADS=8`; an unpinned ORT session would open 8 threads *per session object*
  and contend with the decode threads on a 2-request/8-limit CPU budget. It would also
  put VAD on the GPU, where the shared per-model `threading.Lock`
  (`whisper_cpp_asr.py:429,465`) and the 6/6 time-sliced units leave no room.
- **State is per session, weights are shared.** 20 concurrent streams are 20
  `VADSessionState` objects (2×1×128 float32 = 1 KiB each) against one ONNX session.

**Cost.** `silero_service.py:4` claims ~189 µs/frame on CPU; that is a docstring, not a
measurement on this image. Taken at face value it is 189 µs per 32 ms of audio =
**0.6 % of one core per stream**, and at the 20-stream admission cap ≈ **12 % of one
core** — but *all of it synchronous on the ingestion dispatch loop*, because
`preprocessor.feed` is `async` yet `process_chunk` is a plain blocking call. 12 % of a
core of head-of-line blocking on the loop that also does `XACK` is a latency tax on every
other session, not just a CPU cost. Measurement request **MR-3** settles it. If it
measures badly, the fix is *not* `to_thread` per frame (the hop costs more than the
inference) but batching the frames of one `feed()` call into one ORT run — `feed` already
loops over every complete frame in the chunk (`preprocessor.py:411-414`), and an 80 ms
browser chunk is 2–3 frames.

### 3.3 Failure posture — fail open to energy, with a counter

Today's degrade paths and what is wrong with each:

| Path | Code | Today | Change |
|---|---|---|---|
| model not staged / load raises | `session_manager.py:1919-1925` | one WARNING, `vad_service = None`, silent energy fallback for the whole session | keep the fallback; add `stt_streaming_vad_degraded_total{stage="load"}` and make the session's log line say `segmenter="energy"` (§2.3) |
| `is_loaded` False | `preprocessor.py:645-646` | silent per-frame fallback | same counter, `stage="not_loaded"`, latched once per session |
| per-frame ONNX exception | `preprocessor.py:657-663` | **`logger.warning` on every frame** | latch: warn once per session, count every time (`stage="inference"`). At 31 frames/s per session a persistent ONNX fault is a 31 line/s log flood into Loki — see D2-N2 |

Fail-open is the right posture (a consultation that stops segmenting is worse than one
that segments coarsely), but only because QW-13 has made the fallback safe first. **ST-2
without QW-13 would fail open into the room-tone bug.** That ordering is not negotiable.

Patch in `preprocessor.py`:

```python
def _run_vad(self, frame: np.ndarray) -> float:
    if self._vad_service is None or not self._vad_service.is_loaded:
        self._note_vad_degraded("not_loaded")   # latched + counted
        return self._run_energy_fallback(frame)
    try:
        return cast(float, self._vad_service.process_chunk(
            chunk=frame, session_state=self._vad_state, threshold=self._threshold))
    except Exception as exc:
        self._note_vad_degraded("inference", exc)  # warn ONCE, count always
        return self._run_energy_fallback(frame)
```

`_note_vad_degraded` holds a `set[str]` of already-warned stages on the instance and
increments the counter unconditionally.

### 3.4 Energy demoted to a pre-VAD noise floor

With Silero primary, the energy path stops deciding onsets and becomes a cheap veto:
**a frame whose raw RMS is below the adaptive floor cannot be speech no matter what
Silero says.** That is the F9-V2 observation (energy alone fails on fans and second
speakers) used in the direction it is actually good for — rejecting, not accepting.

```python
prob = self._run_vad(vad_frame)
if self._vad_service is not None and self._vad_service.is_loaded:
    # Pre-VAD noise floor: Silero scores spectral speech-likeness and will
    # happily score room tone or an HVAC harmonic; a frame below the adapted
    # raw floor is vetoed before the state machine sees it. Purely subtractive
    # — it can never OPEN an utterance.
    if self._run_energy_fallback(vad_frame) < _ENERGY_VETO_PROB:
        prob = 0.0
```

`_ENERGY_VETO_PROB` sits well below the onset threshold (0.2 is the natural starting
point: it is the `prob` a raw frame at the adapted floor itself produces,
`floor / (2 × 2.5 × floor)`). The veto runs the same `_run_energy_fallback`, so the EMA
keeps adapting — which it must, since with VAD primary the EMA is otherwise frozen
whenever `in_speech` (`:685-689`). **Open question for MR-2's arm 3**: whether the veto
earns its place at all, or whether Silero at 0.5 already rejects room tone. Ship ST-2
with the veto behind a constant and measure it; do not ship two unmeasured changes.

### 3.5 The pad knob, and the wire field that is missing

`AsrSpecVad` carries `speech_pad_ms` (`spec.py:253-259`) → `VadConfig.padding_ms`
(`:676-677`, `dto.py:603`). **The streaming preprocessor never reads `padding_ms`.**
Its only readers are the batch path (`transcription/preprocessing.py:211,234`) and
`silero_service.detect_speech` (`:146`). The streaming equivalent is
`pre_speech_context_ms` (`dto.py:604` → `session_manager.py:515-516` →
`preprocessor.py:160,213-216`), for which **no `AsrSpecVad` field exists at all**.

So ST-2's "pad 100–300 ms" is today unreachable from an agent. Two ways out:

- **(a) Reuse `speech_pad_ms` for the streaming pre-roll** — map it onto
  `pre_speech_context_ms` in `_build_preprocessor_vad_kwargs` when present. Semantically
  the same knob (roll captured around a speech segment), no contract change, no fixture
  change in `tests/contracts/resolved-asr-spec.fixture.json`, no TS/py parity work.
  **Recommended.** The asymmetry (batch pads both ends, streaming only the head) should be
  written down at the mapping site.
- (b) Add `AsrSpecVad.pre_speech_context_ms` as a new `OPTIONAL_FIELDS` member. Correct but
  costs a coordinated change in `packages/types/src/asr-spec.ts`, `spec.py`,
  `build-resolved-asr-spec.ts` and the committed fixture — a contract-lane ticket, not a
  D2 one.

Either way the value must be **stated by the agent**, because §2.1's table shows it
silently moves 300 → 500 the moment `enabled` flips.

### 3.6 `endpointing: 'vad'`

`AsrSpecStreaming.endpointing` is `Literal["fixed", "semantic"]` (`spec.py:410`) and
`_endpoint_config` maps it to one boolean: `enabled = (endpointing == "semantic")`
(`:622`). The semantic endpointer's only positive signal is **terminal punctuation on the
running hypothesis** (`semantic_endpointer.py:227, 279-282`), and on the served pipeline
the punctuation model is `cadence-fast`, which is **finals-only**
(`inference.py:1244-1245`: `if not is_final: return text`). So the endpointer's signal on
a partial is whatever punctuation whisper itself emitted — unmeasured, and on the ml-en
fine-tune not to be relied on.

Worse, it reads **stale** text. `observe_hypothesis` is fed from the partial task
(`session_manager.py:3212-3215`), partials are suppressed while
`silence_frames > 0` (`preprocessor.py:559-579`), and the decode itself measured ~0.63 s
on MPS. So at the 200 ms decision point (`min_endpoint_silence_ms`, `dto.py:657`) the
hypothesis being judged **predates the pause that triggered the judgement**, missing the
last word or two — the exact words that decide whether the turn is complete.

`endpointing: 'vad'` therefore means: *the silence timer, driven by Silero's probability
rather than by a punctuation guess.* Concretely it is a third enum value that leaves the
`SemanticEndpointer` un-instantiated (`_make_endpointer` returns `None`,
`session_manager.py:891-903` — already the behaviour for `"fixed"`) and makes the
preprocessor's offset gate authoritative. Mechanically `'vad'` and `'fixed'` are the same
code path; they differ in what `min_silence_ms` *means*, because with Silero the silence
run is anchored on the model's own neg-threshold hysteresis (`:546-557`) rather than on an
energy proxy. Recommendation: **add the literal anyway**, because "fixed" on the energy
fallback and "fixed" on Silero are two different products and the config should be able
to say which one was asked for. The semantic path stays available for when a
Malayalam-capable turn model is staged (Smart Turn v3 and LiveKit both lack Malayalam,
F9-V4), which is what `load_default_endpoint_model`'s seam exists for
(`semantic_endpointer.py:132-148`).

### 3.7 Utterance cap and splitting at the longest silence

`_find_best_split_point` (`preprocessor.py:804-827`) searches the last
`force_emit_lookback_ms` (1500 ms) for the lowest **mean-square energy** frame. A
stop-consonant closure is low energy and is *inside* a word — the code knows this
(`:54-57`) and pays 120 ms of carry to compensate. With Silero on there is a strictly
better signal available: **the lowest speech PROBABILITY frame** in the lookback is a real
pause, not a plosive.

Design, bounded so it adds no per-utterance parallel list: keep a
`deque(maxlen=lookback_frames)` of the last N frame probabilities on `_PreprocessorState`,
appended in the in-speech branch beside `state.utterance_buffer.append(frame_copy)`
(`:508`). The split search only ever looks at the last `lookback_frames` (`:809-810`), so
a bounded ring indexed from the buffer end is sufficient and needs no slicing on split,
carry or partial-window paths. When the ring is populated (Silero active) prefer
`argmin(prob)`; otherwise fall back to today's energy search unchanged.

### 3.8 Migration from the served `vad.enabled: false`

The path is short because the model binding is already in the row
(`25-agents.ts:270-273`) and `ModelCache` already warms VAD weights when the stage is on
(`session_manager.py:2066-2071`).

1. **QW-13 merges first** (§1). Without it, enabling VAD is *net worse* on the fallback
   paths of §3.3.
2. **M-13 merges** (§2), so the four numbers are visible in the log before anyone changes
   them.
3. **BP-7 / MR-1 runs** on the energy path with QW-13 in, to prove the room-tone clip is
   clean without VAD. That is the number OD-C is actually owed — it makes Silero an
   accuracy decision rather than a false-onset workaround.
4. **MR-2** runs Silero on a Global-playground **sibling** agent (never a SYSTEM write —
   BP-2's rule). Arms in §7.
5. Only then flip `vad.enabled` on the SYSTEM row, in a change that *also* states
   `threshold`, `minSpeechMs`, `minSilenceMs` and the pad explicitly, so no default
   silently moves (§2.1's table).
6. **Rollback is one boolean** — with M-13 in, flipping `enabled: false` no longer
   silently reverts the other three numbers as well, which is the property that makes this
   safe to try.

Cold start: `SileroVADService.initialize()` is lazy (`silero_service.py:57-86`), so the
first session per pod pays the ONNX load inside `create_session`. Small next to the 4.6 s
ASR load already measured (README §2.3) but it lands in the same POST. If OD-F warms the
ASR model at boot, warm the VAD ONNX session in the same hook — it is a few MB and a
singleton.

---

## 4. M-39 — cut-reason telemetry

### 4.1 What is missing

`_emit_utterance` (`preprocessor.py:829-894`) is reached from **five** distinct decisions
and records which one nowhere:

| Reason | Call site | Meaning |
|---|---|---|
| `semantic` | `:566-569` | `_should_semantic_endpoint` returned True |
| `silence_timer` | `:570-574` | `silence_frames >= _min_silence_frames` |
| `max_utterance` | `:531`, `:542` | force-emit (smart split / hard overlap) — sub-label the two |
| `flush` | `:618-619` | session finalize with an open utterance |
| `flush_pending_onset` | `:627-635` | finalize on an unconfirmed onset |
| `partial` | `_maybe_emit_partial`, `:792-799` | not a cut |

Worse, the semantic path **already computes a PHI-free reason and throws it away**:
`EndpointDecision.reason` is documented as "a stable, PHI-free tag for telemetry"
(`semantic_endpointer.py:122-129`) and `_should_semantic_endpoint` returns
`bool(decision.should_endpoint)` (`preprocessor.py:717`), discarding
`REASON_LOW_CONFIDENCE` / `REASON_SILENCE_FLOOR` / `REASON_TOO_SHORT` /
`REASON_INCOMPLETE`. Those four tags are precisely the evidence that would say whether
"semantic" endpointing ever fires at all on the served pipeline (§3.6).

### 4.2 Design

1. `AudioUtterance` gains `endpoint_reason: str = "unknown"`; `_emit_utterance` takes
   `reason: str` (keyword-only, required) and stamps it. Every call site named above
   passes its own.
2. `_should_semantic_endpoint` returns the full `EndpointDecision` (or
   `(bool, reason)`), and the caller records `decision.reason` on a session-scoped
   `Counter[str]` even when it does **not** cut. Fail-safe contract unchanged: exception
   → `(False, "error")`.
3. New metric in `core/metrics.py` (shared file — patch request **CL-3**):
   ```python
   STREAMING_UTTERANCES_TOTAL = Counter(
       "stt_streaming_utterances_total",
       "Utterances emitted by the streaming preprocessor, by cut reason",
       ["reason", "is_final"],
   )
   ```
   6 reasons × 2 = 12 series, no tenant label (PHI posture, §2.6). Plus
   `STREAMING_ENDPOINT_DECISIONS_TOTAL{reason}` over the seven
   `semantic_endpointer.REASON_*` tags, and `STREAMING_VAD_DEGRADED_TOTAL{stage}` from
   §3.3.
4. In the same change, **wire or retire the two dead VAD metrics**:
   `VAD_SEGMENTS_DETECTED` (`metrics.py:164`) and `VAD_PROCESSING_LATENCY` (`:169`) are
   declared and **incremented nowhere in the service** (D2-N3). A dashboard panel on
   `stt_vad_segments_total` reads "no VAD activity" when the truth is "never
   instrumented". `stt_streaming_utterances_total{reason}` supersedes the first; the
   second should either wrap `process_chunk` or be deleted.
5. One INFO `stt.streaming.session_summary` line at finalize with the per-session reason
   histogram — that is what makes a single scorecard run explicable without Prometheus,
   and it is what BP-4's `fragment_rate` / `clause_break_rate` counters hang off.

### 4.3 Where the `fragment_rate` link closes

§2.5 class 2 (54 % of finals ≤ 3 words) has three candidate mechanisms and the reason
histogram separates them in one run: a `silence_timer`-dominated histogram says the
350/500 ms gap is too short; a `semantic`-dominated one says the punctuation heuristic is
cutting mid-clause (class 9's "terminal punctuation on every commit" feeding the
endpointer); a `max_utterance`-dominated one says the opposite problem. Today all three
look identical from outside. This is the cheapest single instrument in the whole D2 area.

---

## 4b. M-29 — the segmentation half of the tail race

M-29 belongs mostly to QW-1 and the transport lanes, but two of its consequences are the
preprocessor's and belong in this dossier.

**The tail never reaches the segmenter.** `_on_frame` returns at
`session_manager.py:3294-3295` the instant `session.status != ACTIVE`, *before*
`preprocessor.feed`. So audio that is already in `stt:audio` when FINALIZE flips the
status is not merely un-decoded — it never enters `utterance_buffer` at all, and
`flush()` (`preprocessor.py:583-637`) then flushes a buffer that is short by whatever was
in flight. Draining to the current stream id before `finalize()` is the transport lane's
fix; from the segmenter's side the requirement is simply that `feed()` be called for every
frame that was accepted, and that the flush happen after the last such call.

**`flush()` discards a word that began less than 64 ms before the cut.** The pending-onset
branch requires `state.speech_onset_frames >= 2` (`:627`, with the reason at `:625-626`:
one above-threshold blip must not ship a ring of ambient noise to ASR). That guard is
correct in kind, and after QW-13 it is also **cheaper than it looks**: once the energy gate
measures raw amplitude, a lone ambient blip can no longer produce an above-threshold frame
in the first place, so the guard could safely drop to `>= 1`. I do **not** propose changing
it in the QW-13 change — it is a second behaviour change riding on the first — but it
should be revisited once MR-1 has the room-tone number, since `>= 2` is 64 ms of a final
word thrown away on every stop-after-speech.

**In-band `final=1`.** QW-1 proposes marking the last audio frame (`frame.final`), which
would route finalize through `_on_frame`'s own `:3352` branch — after `feed()`, in order,
on the same loop. That is the shape the preprocessor wants, and it is the only variant of
QW-1 that makes the tail flush deterministic rather than a race. D2 supports it; the
gateway change (`stt-ws.gateway.ts:1341`, which writes `final='0'` unconditionally) is not
mine.

---

## 5. M-40 — `maxUtteranceSec` 60 → 20–25

### 5.1 What the 60 actually does

`25-agents.ts:297` sets `maxUtteranceSec: 60`; `session_manager.py:527-529` converts it to
`max_utterance_duration_ms` and applies it **last, so it wins** over
`VadConfig.force_emit_after_ms` (25 000, `dto.py:605`) and over the preprocessor's own
`_DEFAULT_MAX_UTTERANCE_DURATION_MS` (25 000, `preprocessor.py:46`). The engine default is
**25 s** and the agent widens it to 60 — the mirror image of M-13, where a profile literal
narrowed an agent value.

Worst case: 60 s of continuous speech with no gap that clears the offset gate ⇒ the first
final arrives 60 s + decode after the utterance began. On the energy path with VAD off and
a 500 ms timer that is unlikely but unbounded; a clinical read-out ("the patient's
medications are X, Y, Z…") is exactly the shape that does it.

### 5.2 The two seams are different and the README conflates them

- **Force-emit carry seam** (M-40's "doubly decoded seam"): `_emit_utterance(carry_buffer=...)`
  re-seeds the next utterance with 120 ms (`_SMART_SPLIT_OVERLAP_MS`, `:57`) on a smart
  split or 500 ms (`_FORCE_EMIT_OVERLAP_MS`, `:48`) on the fallback. That audio is decoded
  **twice** and cleaned by `_dedup_force_emit_boundary` (`inference.py:980-1010`), capped
  at 3 words.
- **Span-cut seam**: `WhisperCppAsrAdapter._split_spans` (`whisper_cpp_asr.py:552-584`)
  cuts a long final into ≤ `maxDecodeWindowSec` (7 s) spans at the quietest 30 ms frame,
  with `i = cut` — i.e. **zero overlap**. That is §2.5 class 3's mechanism (orphan
  sub-word fragments) and it is *independent of `maxUtteranceSec`*.

Consequences for the 60 → 20 change:
- span-cut seams per minute of continuous speech: **unchanged** (60/7 ≈ 8 either way);
- force-emit carry seams per minute: **1 → 3**, i.e. 3× more doubly-decoded overlaps and
  3× more chances for the ≤3-word dedup to be wrong — and it *is* wrong today, because
  `overlap_s = self._last_final_end - utterance.start_time` (`inference.py:993`) is
  computed from a `start_time` that systematically under-states the utterance's true span
  (D2-N4 below).

### 5.3 Recommendation

**Do not move the cap in this wave.** Sequence:

1. QW-13, then M-13 (§1, §2).
2. Fix `start_time` (D2-N4) so the boundary dedup measures the overlap it is given.
3. ST-2 lands and the reason histogram (§4) shows how often `max_utterance` fires *at all*.
   On a VAD-gated stream with 350 ms silences it should be rare; if it is rare, the cap is
   a latency backstop and 20–25 s is free.
4. Then set **20 s** (matching the engine default's neighbourhood, and inside ST-2's
   15–20 s band) on a Global sibling, measured by MR-4.
5. Independently of all of the above: the `> 60 s` continuous-speech fixture the README
   asks for must exist, because **no fixture in the repo exercises the force-emit path at
   all** at the served cap. Any claim about the 60 s path today, including mine, is
   unverified.

---

## 6. Ordering against the other lanes

### 6.1 What D2 needs from other lanes

| From | What | Why |
|---|---|---|
| **Session lane** (`session_manager.py`) | **CL-1** — the `_build_preprocessor_vad_kwargs` rewrite (§2.2) and deletion of `ExecutionProfile.vad_silence_threshold_ms` | I own the preprocessor that consumes the kwargs; I do not own the builder. Nothing else in D2 works until the agent's numbers arrive. |
| **Session lane** | **CL-2** — log `preprocessor.effective_segmentation` on the existing `stt.streaming.windows` line (§2.3) | the property is mine; the log line is theirs |
| **Session lane** | **CL-4** — `session._vad_active` (`:1271`) should follow `runtime.vad_service is not None`, not `runtime.vad_enabled` | a session whose Silero load failed currently reports `vad_active=True` |
| **Decode lane** (`inference.py`) | **CL-5** — `_is_hallucination` (`:1187`) divides by `utterance.normalizer_gain` | the field is mine; the gate is theirs. One line. Default `1.0` keeps the batch path and every existing test byte-identical. |
| **Decode lane** | **CL-6** — once `start_time` is fixed (D2-N4), re-check `overlap_s` at `:993` and the 3-word cap at `:999`: the overlap it measures will grow by the pre-roll, which is the *correct* number but a behaviour change | otherwise D2's fix silently widens their dedup window |
| **Shared** (`core/metrics.py`) | **CL-3** — three new counters, and wire-or-retire the two dead VAD metrics (§4.2) | metrics.py has no named owner in this wave |
| **Contract lane** (`spec.py` / `packages/types`) | **CL-7** — `endpointing: 'vad'` literal (§3.6) and the pad decision (§3.5 option (a) needs no contract change; option (b) does) | `AsrSpecStreaming` and the committed fixture are cross-language |
| **Seed lane** (`25-agents.ts`) | **CL-8** — when ST-2 flips `vad.enabled`, state `threshold`, `minSpeechMs`, `minSilenceMs` **and** the pad in the same edit | §2.1 shows two of them move silently otherwise |

### 6.2 What D2 must not collide with

- **`whisper_cpp_asr.py` is not mine.** ST-2 changes *where* utterance boundaries fall,
  which changes what `_split_spans` receives — but I propose **no edit** to the span
  cutter. The zero-overlap seam (§5.2) is the decode lane's to fix and should be raised
  there, not folded into ST-2.
- **`commit_policy.py` is not mine**, and D2-N4 (the `start_time` bug) lands squarely in
  its input. `_absorb_slide` treats any `window_start_time > prev_start + 1e-3`
  (`commit_policy.py:256-259`) as a genuine window slide. Fixing `start_time` **changes
  the commit policy's slide detection** on every session. The two changes must land
  together or the commit lane must be told the number moved. This is the single most
  dangerous interaction in the D2 area and it is flagged, not fixed, here.
- **QW-3 also promises to "forward `min_silence`/`min_speech` regardless of `vad.enabled`
  and delete `vad_silence_threshold_ms`"** (README line 247). That is the *same edit* as
  §2.2. One lane must own it — D2 recommends QW-3 keeps it (it is a knob-honesty sweep and
  the profile-field deletion touches five literals), and D2 consumes the result. Whichever
  way it goes, **it must not be done twice.**
- **BP-2's `vad.enabled {false, true}` arm doubles as BP-7's Silero arm** (README line
  232). MR-2 below is written to be that arm, not a second one.
- **No SYSTEM writes.** Every arm runs on a Global-playground sibling agent
  (`50000000-…`), per BP-2's rule and the §"content is cloned" rule.

---

## 7. Test plan

### 7.1 Unit tests (mine to write; hermetic, no infra)

In `apps/stt/tests/unit/test_streaming_preprocessor.py` and
`apps/stt/tests/unit/streaming/test_preprocessor_normalize_resample.py`:

| # | Test | Shape | RED today |
|---|---|---|---|
| U-1 | `test_room_tone_does_not_open_an_utterance_with_normalize_on` | feed 200 frames of Gaussian noise at raw RMS 0.0025 (-52 dBFS), `normalize=True`, no VAD service; assert `pp.in_speech is False` and zero finals | **yes** — this is M-07 |
| U-2 | `test_energy_gate_is_scale_invariant_under_the_normalizer` | same speech frames at raw RMS 0.03, run once with `normalize=True` and once `False`; assert identical onset frame index | **yes** |
| U-3 | `test_energy_gate_measures_raw_amplitude` | parametrize raw RMS ∈ {0.0005, 0.001, 0.0025, 0.005, 0.02, 0.05}; assert the onset boundary sits where §1.6's table says, independent of `normalize` | yes |
| U-4 | `test_utterance_carries_the_normalizer_gain` | `normalize=True` on quiet input; assert `utt.normalizer_gain == pytest.approx(20.0)`; with `normalize=False` assert `1.0` | yes |
| U-5 | `test_hallucination_gate_uses_raw_rms` (decode lane, but written here as the contract) | `AudioUtterance(samples=0.045-RMS, normalizer_gain=20.0)` + 2-word text ⇒ `_is_hallucination` True | yes |
| U-6 | `test_agent_vad_tuning_reaches_the_preprocessor_when_vad_is_off` | replaces `test_preprocessor_wiring_kwargs.py:61-69 test_vad_disabled_uses_profile_silence_threshold`, which **pins the defect**; assert `min_silence_duration_ms == 350`, `threshold == 0.5`, `min_speech_duration_ms == 100` with `vad_enabled=False` | yes |
| U-7 | `test_effective_segmentation_reports_what_ran` | assert the dict's `min_silence_ms` equals the constructor arg and `segmenter == "energy"` with no VAD service | yes |
| U-8 | `test_every_emit_path_stamps_a_reason` | drive all five paths (semantic, timer, force-emit smart, force-emit fallback, flush) and assert `endpoint_reason` is the expected tag; assert no path emits `"unknown"` | yes |
| U-9 | `test_endpoint_decision_reason_is_recorded_when_it_does_not_cut` | stub endpointer returning `REASON_LOW_CONFIDENCE`; assert the counter moved and no final was cut | yes |
| U-10 | `test_vad_inference_error_warns_once_and_counts_every_frame` | VAD service raising on every `process_chunk`; assert 1 warning / N counter increments over N frames | **yes** — D2-N2 |
| U-11 | `test_fragmentation_rate_on_a_synthetic_dialogue` | deterministic prob sequence encoding six utterances with 400 ms inter-word gaps and 800 ms turn gaps; assert finals == 6 (not 20) and `mean(words per final)` above a floor. Runs at both `min_silence` 350 and 600 as a parametrize, so the unit suite states the direction before the live A/B measures the size | n/a (new) |
| U-12 | `test_start_time_describes_the_emitted_samples` | any onset-confirmed final; assert `end_time - start_time == approx(len(samples)/sr)` | **yes** — D2-N4 |
| U-13 | `test_split_prefers_the_lowest_vad_probability_frame` | force-emit with a probability ring where the energy minimum and the probability minimum are different frames; assert the probability one wins when Silero is active and the energy one when it is not | n/a (ST-2) |

Existing tests that must be **rewritten, not deleted**:
`test_normalizer_never_amplifies_noise_floor` (`test_streaming_preprocessor.py:1746`) —
rename to `test_normalizer_gain_is_capped_at_20x` and keep the assertion, which is true and
worth keeping; the misleading name is what let M-07 hide.
`test_vad_disabled_uses_profile_silence_threshold`
(`test_preprocessor_wiring_kwargs.py:61-69`) — replaced by U-6; its docstring asserts the
defect is intended behaviour and must go with it.

### 7.2 Live measurements — for the orchestrator only

I have run none of these and am not permitted to. Each is stated with arms, fixture, metric
and the decision it settles.

**MR-1 — BP-7 room-tone A/B (settles: QW-13 merges or does not; feeds OD-C).**
- Arms (4): `{QW-13 patch: out, in} × {audioFrontEnd.normalize: true, false}`, VAD **off**
  (energy path) throughout. Global sibling agent per arm; no SYSTEM write.
- Fixture: **20 s of real room tone, then 40 s of the three English clinical reads**, one
  WAV, through the WS harness at real-time pacing. Room tone must be a real recording at a
  stated dBFS, not synthetic silence — Whisper's hallucination behaviour differs
  (F9-V2). Record the clip's raw RMS and peak in the scorecard fingerprint.
- Metrics: `stt_streaming_utterances_total{reason}` during the first 20 s (**target: 0**);
  finals published during the first 20 s (**target: 0**); then on the speech half,
  `medical_wer`, `keyterm_recall`, `first_partial_ms`, `commit_latency_ms` p50 — all
  **unchanged within the baseline's own spread**, which is the safety half of the test.
- N ≥ 5 per arm, quiet stack, model pre-warmed by a preceding session (README §2.3's cold
  load absorbed 4.6 s into clip 1 and must not repeat).
- Decision: QW-13 merges iff arm `{in, true}` shows 0 utterances during room tone **and**
  no WER regression. If `{out, false}` is also clean, that is evidence the normalizer is
  the whole story and is worth recording either way.

**MR-2 — ST-2 / BP-2's VAD arm (settles: OD-C, and §3.4's energy veto).**
- Arms (4), all with QW-13 and M-13 in: (1) `vad.enabled:false` (control, energy);
  (2) `vad.enabled:true`, threshold 0.5, minSpeech 100, minSilence 350, pre-roll 300;
  (3) as (2) **plus** the §3.4 energy veto; (4) as (2) with pre-roll 500 (the value that
  flips silently today — measure it rather than inherit it).
- Fixtures: MR-1's room-tone+speech clip; the three English reads; the 24 ml-en clips
  under `STT_MLEN_EVAL_DIR`; and the BP-4 encounter replay once the owner supplies audio.
- Metrics: utterances during room tone; `fragment_rate` and `clause_break_rate` (§2.5
  class 2) with their reference-label rates beside them; `orphan_fragment_rate` (class 3);
  `medical_wer` / `keyterm_recall` (English) and CER (ml-en); `commit_latency_ms` p50/p95;
  `first_partial_ms`; the `endpoint_reason` histogram per arm; STT CPU % and event-loop
  lag.
- Decision: OD-C. Recommend Silero ON if arm 2 or 3 halves `fragment_rate` with
  `medical_wer` no worse than control + its spread and commit p50 within +300 ms. The
  veto ships only if arm 3 beats arm 2 on room tone without costing recall.

**MR-3 — Silero cost on the ingestion loop (settles: whether `feed()` needs frame
batching; gates ST-2's rollout to the full fleet).**
- Arms: concurrent streams N ∈ {1, 2, 4, 8, 20} with VAD on, and the same curve with VAD
  off as the control. Cluster, not MPS.
- Metrics: per-frame `process_chunk` wall time (p50/p95/p99) — the 189 µs docstring claim
  is unverified on this image; ingestion-loop iteration latency; `commit_latency_ms` p50;
  `stt_streaming_inference_queue_dropped_total`; pod CPU.
- Decision: if VAD adds > 10 % to commit p50 at N=20, batch the frames of one `feed()`
  chunk into one ORT run before enabling fleet-wide. If it adds < 2 %, the question is
  closed and never re-asked.

**MR-4 — `maxUtteranceSec` (settles M-40; run only after ST-2).**
- Arms (3): 60 (control), 25, 20 — on a Global sibling, with ST-2 in.
- Fixture: **a new > 60 s continuous-speech clinical read** (does not exist in the repo
  today; MR-4 cannot run without it), plus the three English reads as the regression half.
- Metrics: `commit_latency_ms` **p99** (the point of the change); `max_utterance` share of
  the `endpoint_reason` histogram; `echo_rate` and `repeat_rate` at the carry seam (§5.2
  predicts these rise 3×); `medical_wer`.
- Decision: adopt the lowest cap whose p99 improves without `echo_rate` exceeding the
  reference labels' own rate by more than 1 point.

**MR-5 — BP-4b arm (2): `minSilenceMs` 350 vs 600 with VAD ON (the owed D-1(b) listening
pass).**
- Arms (3): 350 (the agent's stated value, live for the first time after M-13), 500
  (today's *effective* value — the profile literal, so the A/B has a bridge to the
  existing baseline), 600.
- Fixture: BP-4 encounter replay + the 24 ml-en clips + the three English reads.
- Metrics: `fragment_rate` (target: halves vs 350), `clause_break_rate`,
  `commit_latency_ms` p50 (budget: **+ ≤ 300 ms**), `seq_gap` 0, `audio_coverage ≥ 0.994`,
  `medical_wer` / CER.
- Decision: the served `minSilenceMs`. **Note for the orchestrator:** this arm is
  *meaningless before M-13 merges* — today all three values produce the identical 500 ms
  run, so a null result would be mis-read as "the knob does not matter."

---

## 8. New defects

| Id | Claim | Evidence | Sev | Suggested fix |
|---|---|---|---|---|
| **D2-N1** | The agent's `speechPadMs` is **inert on the streaming path**, and the knob that actually governs streaming pre-roll (`pre_speech_context_ms`) has **no agent field at all** — it silently moves 300 → 500 ms the moment `vad.enabled` flips, because the preprocessor default and the `VadConfig` default disagree | `spec.py:676-677` → `dto.py:603` `padding_ms`, whose only readers are `transcription/preprocessing.py:211,234` and `silero_service.py:146` (both batch); streaming reads `pre_speech_context_ms` (`dto.py:604` → `session_manager.py:515-516` → `preprocessor.py:160`), forwarded **only** inside the `vad.enabled` branch; preprocessor default `_PRE_SPEECH_CONTEXT_MS = 300` (`preprocessor.py:32`) vs `VadConfig` 500 | med | §3.5 option (a): map `speech_pad_ms` → `pre_speech_context_ms` in the kwargs builder; align the two defaults; state the value on the agent row |
| **D2-N2** | A persistently failing Silero session logs a **WARNING every 32 ms** (≈ 31 lines/s/session) with no counter, so a broken VAD is a log flood that looks like noise rather than a metric | `preprocessor.py:657-663` — `logger.warning` inside the per-frame `except`, no latch, no counter | med | §3.3: latch the warning per session per stage; add `stt_streaming_vad_degraded_total{stage}` |
| **D2-N3** | `VAD_SEGMENTS_DETECTED` and `VAD_PROCESSING_LATENCY` are **declared and never incremented** anywhere in the service — two Prometheus series permanently at zero, so a dashboard reads "no VAD activity" where the truth is "never instrumented" | `core/metrics.py:164-173`; the only other hits in `apps/stt/src` are `segment_merger.merge_vad_segments` and `batch_service` (unrelated names) | low | wire them, or delete them in the §4.2 change and let `stt_streaming_utterances_total{reason}` carry it |
| **D2-N4** | `AudioUtterance.start_time` **does not describe `samples`** on any onset-confirmed utterance: the buffer is seeded with the pre-speech ring but `start_time` is computed from the onset frame, so `end_time - start_time` under-states the emitted audio by `pre_speech_context_ms` + the dip frames — **~320 ms every time** on the served path. It also jumps discontinuously by that amount at the first trimmed partial | buffer = `list(pre_speech_ring)` + current frame (`preprocessor.py:466-467`), ring capacity = `pre_speech_frames + min_speech_frames` (`:228`) = 9 + 3 = 12 frames at the served defaults; `utterance_start_time = (total_fed − frame×speech_onset_frames)/sr` (`:461-463`), which counts only the K onset frames. Trimmed partials instead use `end_time − len(samples)/sr` (`:788-790`), which is correct — so the two disagree by the ring. The dataclass docstring claims the opposite (`:99-103`) | **high** | derive `utterance_start_time` from the buffer: `end_time − (sum(len(f) for f in buffer))/sr` at emit, the same rule the carry path already uses (`:880`) |
| **D2-N5** | D2-N4 corrupts the commit policy: a **320 ms phantom slide** is reported to `_absorb_slide` at the first trimmed partial of every utterance, well past `_SLIDE_EPSILON_S = 1e-3`, so `_slide_offsets` freezes tokens whose audio never left the window | `commit_policy.py:256-259, 283-306`; fed from `result.start_time` at `session_manager.py:3189-3193`, which is `utterance.start_time` (`inference.py:652`) | **high** | fixed by D2-N4; **must land with the commit lane**, since it moves a number that lane's tests pin (§6.2) |
| **D2-N6** | `SileroVADService.process_chunk(threshold=...)` accepts a `threshold` argument, documents it as "Override default threshold", and **never references it** — the preprocessor passes `self._threshold` on every frame to no effect | `silero_service.py:198-250`; the parameter appears at `:202` and nowhere in the body; caller `preprocessor.py:651-655` | low | drop the parameter, or return a thresholded decision. Knob-honesty family (QW-3) |
| **D2-N7** | `SemanticEndpointer.decide(min_silence_ms=...)` is likewise **accepted and never used** — the caller computes and passes `self._min_silence_duration_ms` (`preprocessor.py:712-716`) and the body only ever reads `self._config.min_endpoint_silence_ms`. Consequence for M-13: forwarding `minSilenceMs` 350 changes the fixed backstop but **not** the semantic cut point, which stays pinned at 200 ms | `semantic_endpointer.py:189` signature vs body `:196-219` | med | either use it (clamp the semantic floor below the fixed backstop, which is the documented intent at `dto.py:655-657`) or remove it |
| **D2-N8** | `EndpointDecision.reason` is documented as telemetry and **discarded at the only call site** — the four negative tags that would show whether "semantic" endpointing ever fires are never recorded | `semantic_endpointer.py:122-129` vs `preprocessor.py:717` (`return bool(decision.should_endpoint)`) | med | §4.2 item 2 |
| **D2-N9** | `_ENERGY_FLOOR = 1e-4` is used as an **amplitude** floor in `_run_energy_fallback` (`:696`) and as a **mean-square (power)** floor in `_find_best_split_point` (`:813-815`, where `mean_energy` is a mean of squares ⇒ the comparison is really "RMS < 0.01"). One constant, two incompatible units | `preprocessor.py:33, 696, 813-815` | low | split into `_ENERGY_FLOOR_RMS` and `_SPLIT_ENERGY_FLOOR_MS`, naming the unit in each |
| **D2-N10** | After a force-emit **smart** split, `last_partial_emitted_at` is reset to `0.0` (`:887`) while `in_speech` stays `True`, so the very next frame emits a partial over the carry buffer alone — which, on a smart split, is everything after the split point plus 120 ms and can exceed the `_PARTIAL_MIN_AUDIO_S = 0.5` floor. A partial over audio that was just published as a final | `preprocessor.py:875-887` vs `:759-769`; the onset path sets the timer to `time.monotonic()` (`:475`) precisely to avoid this, and the carry path does not | low | set `state.last_partial_emitted_at = time.monotonic()` on the carry branch too |
| **D2-N12** | `_maybe_emit_partial`'s minimum-audio gate mixes two sample-rate domains: it multiplies the buffered frame COUNT by `self._frame_size` (the **input**-rate frame size) and divides by `self._target_sr`. The buffered frames are post-resample, so on any session whose input rate differs from the target the computed duration is overstated by `sample_rate / target_sr` — 3× for a 48 kHz uplink, which makes partials fire on 0.17 s of audio instead of the intended 0.5 s. Dormant today only because the browser resamples to 16 kHz before sending (`STTProcessor.ts:788`), so `_resample_frame` is a no-op (`preprocessor.py:363-364`) | `preprocessor.py:767` (`len(buffer) * self._frame_size / self._target_sr`) against `self._frame_size = int(vad_frame_size * (sample_rate / self._target_sr))` (`:206-207`); contrast `max_window_samples` at `:772`, which uses `_target_sr` consistently and is correct | low | use `sum(len(f) for f in state.utterance_buffer) / self._target_sr`, which is domain-free |
| **D2-N11** | `session._vad_active` is set from the **declared** flag, not from whether Silero loaded — a session whose VAD load failed persists and reports `vad_active=True` while running the energy fallback. The sibling log line two hundred lines later gets it right (`has_vad = runtime.vad_service is not None`), which is how the inconsistency stayed invisible | `session_manager.py:1271` vs `:1350`; loader swallows and returns `None` at `:1919-1925` | low | CL-4 |

---

## 9. Summary of what D2 recommends, in order

1. **QW-13** (§1) — `preprocessor.py` only, plus one line in `inference.py` (CL-5). Gated by MR-1.
2. **M-13** (§2) — `session_manager.py` (CL-1), coordinated with QW-3 so it is done once.
   Ships with the effective-values log (CL-2).
3. **D2-N4 + D2-N5** (§8) — `start_time` derived from the buffer, landed **with** the
   commit lane.
4. **M-39 telemetry** (§4) — `preprocessor.py` + `semantic_endpointer.py` + three counters
   (CL-3). Cheapest instrument in the area; unblocks the §2.5 class-2 attribution.
5. **ST-2** (§3) — after 1–4, on a Global sibling first, gated by MR-2 and MR-3.
6. **M-40** (§5) — last, after ST-2 and after the > 60 s fixture exists, gated by MR-4.

Nothing in 1–6 adds a code literal or an env var: every value moves onto the agent row
(`audioFrontEnd.vad.*`, `streaming.*`) or stays a declared engine default in
`pipeline/dto.py`, which is the existing "the dataclass is the one source of engine
defaults" rule (`spec.py:396-397, 647-648`).
