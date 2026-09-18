"""Streaming audio preprocessor — real-time VAD and utterance extraction.

Receives raw PCM audio incrementally (via :meth:`feed`) and uses
Silero VAD v5 ONNX to detect speech onset/offset.  When a complete
utterance is detected (speech → silence transition), it is emitted as
an :class:`AudioUtterance` ready for ASR inference.

Key design:
- VAD runs per 512-sample frame (32 ms at 16 kHz) using Silero ONNX
- Speech onset: ``probability > threshold`` for ``min_speech_duration_ms``
- Speech offset: ``probability < threshold`` for ``min_silence_duration_ms``
- On offset → extract utterance from buffer, yield as AudioUtterance
- Buffer keeps 300 ms pre-speech context for natural boundaries
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, cast

import numpy as np
import structlog

from stt.vad.dto import VADSessionState

# TASK-985 (M-39, CL-3): the three counters these call — `stt_streaming_
# utterances_total{reason,is_final}`, `stt_streaming_endpoint_decisions_total
# {reason}` and `stt_streaming_vad_degraded_total{stage}` — are declared in the
# SHARED `stt.core.metrics`, which this lane does not own. Binding them behind
# an ImportError keeps the two halves independent: the call sites below are
# written against the names that lane adds and no-op until it lands, so neither
# half can break the audio loop on its own. Delete this fallback block — never
# the call sites — once the counters exist.
try:  # pragma: no cover - exercised by whichever half of the pair is present
    from stt.core.metrics import streaming_endpoint_decision as _record_endpoint_decision
    from stt.core.metrics import streaming_utterance_emitted as _record_utterance_emitted
    from stt.core.metrics import streaming_vad_degraded as _record_vad_degraded
except ImportError:

    def _record_utterance_emitted(*, reason: str, is_final: bool) -> None:
        return None

    def _record_endpoint_decision(*, reason: str) -> None:
        return None

    def _record_vad_degraded(*, stage: str) -> None:
        return None


logger = structlog.get_logger(__name__)

# Silero v5 constants
_FRAME_SIZE_16K = 512  # 512 samples = 32 ms at 16 kHz
_FRAME_SIZE_8K = 256
_PRE_SPEECH_CONTEXT_MS = 300
# TASK-985 (D2-N9) — one constant used to mean two incompatible things. The
# energy gate compares an AMPLITUDE (RMS); the force-emit split search compares
# a MEAN SQUARE (power). 1e-4 of amplitude is -80 dBFS; 1e-4 of power is an RMS
# of 0.01, i.e. -40 dBFS. Both values are unchanged — only the names now say
# which unit they are in.
_ENERGY_FLOOR_RMS = 1e-4  # amplitude (RMS); divide-by-zero floor for the gate
_SPLIT_ENERGY_FLOOR_MS = 1e-4  # mean square (power) == RMS 0.01
_ENERGY_MULTIPLIER = 2.5
# TASK-985 (M-07 / QW-13) — 0.015 RAW amplitude (about -36.5 dBFS): the loudest
# room whose floor we still track, above which the EMA is clamped so it cannot
# chase speech. It was ALWAYS a raw-amplitude number, but until QW-13 it clamped
# a NORMALIZED measurement, so in any room quieter than 0.015 x 0.05 = -62 dBFS
# it saturated and the "adaptive" gate became an absolute one at -53 dBFS of
# room tone. `_run_energy_fallback` now measures in raw amplitude, which is the
# unit this ceiling is written in.
_FALLBACK_NOISE_FLOOR_MAX = 0.015
_NOISE_FLOOR_COOLDOWN_FRAMES = 15
# TOTAL sub-threshold "dip" frames tolerated across a
# single onset attempt (cumulative — NOT reset by intervening speech frames).
# One mild VAD-jitter dip must not discard a real utterance, but once the
# budget is spent the onset attempt resets — so consecutive dips AND periodic
# near-threshold noise (cleanly alternating above/below threshold) are rejected
# rather than accreting a false onset.
# Raised 1 → 3. A single 32 ms dip budget meant two jitter dips
# inside a real word onset reset the counter and the word never confirmed.
_ONSET_HANGOVER_FRAMES = 3
_DEFAULT_MAX_UTTERANCE_DURATION_MS = 25000
_FORCE_EMIT_LOOKBACK_MS = 1500
_FORCE_EMIT_OVERLAP_MS = 500
_SPLIT_ENERGY_RATIO = 0.3
# Hysteresis gap for the speech-OFF decision (upstream Silero uses
# neg_threshold = threshold - 0.15). Trailing unvoiced phones hover between
# the two thresholds and must extend the utterance, not count as silence.
_NEG_THRESHOLD_GAP = 0.15
# Overlap carried into the continuation when the force-emit smart
# split cuts at a low-energy frame — a stop-consonant closure IS low-energy,
# so a zero-overlap cut splits the word across two ASR calls.
_SMART_SPLIT_OVERLAP_MS = 120
# Bounded window for the causal peak normalizer. The previous
# exponential decay (0.9997/frame ≈ 107 s time constant) let one transient
# (door slam, cough) suppress speech below the VAD threshold for minutes.
_NORMALIZER_WINDOW_MS = 3000
# Divisor floor (gain ceiling 20×): without it, any pause
# longer than the window collapses the divisor to the ambient-noise peak and
# amplifies room noise to full scale (false onsets via the energy fallback;
# defeats the RMS hallucination gate downstream).
_NORMALIZER_MIN_PEAK = 0.05
# TASK-985 (ST-2, D2 3.4) — pre-VAD noise-floor VETO, purely subtractive: a
# frame whose RAW energy sits at or below the adapted floor cannot be speech
# however confidently Silero scores it, so its probability is zeroed BEFORE the
# state machine sees it. It can never OPEN an utterance. 0.2 is the probability
# a frame AT the adapted floor produces (floor / (2 * 2.5 * floor)), so the veto
# bites only on frames the energy path itself calls room tone. Off by default
# (`energy_veto_enabled`): whether it earns its place at all is MR-2 arm 3, and
# a denoiser in "vad_only" scope can legitimately attenuate the gated frame.
_ENERGY_VETO_PROB = 0.2

# TASK-985 (M-39) — stable, PHI-free tags for WHY an utterance was cut. Five
# distinct decisions reached `_emit_utterance` and recorded which one nowhere,
# so a fragmented session and an over-long one looked identical from outside.
REASON_SEMANTIC = "semantic"
REASON_SILENCE_TIMER = "silence_timer"
REASON_MAX_UTTERANCE_SMART = "max_utterance_smart"
REASON_MAX_UTTERANCE_OVERLAP = "max_utterance_overlap"
REASON_FLUSH = "flush"
REASON_FLUSH_PENDING_ONSET = "flush_pending_onset"
REASON_PARTIAL = "partial"

# Default minimum wall-clock interval between successive PARTIAL
# emissions. Lowered from the legacy hardcoded 1.0 s so newly-spoken words
# surface in near-real-time as a tentative tail; a constructor default, overridden
# per session by `ResolvedAsrSpec.streaming.partialIntervalMs`
# (SessionManager._build_preprocessor_vad_kwargs). The commit policy stays
# conservative — only the not-yet-committed tail's *visibility* changes.
_PARTIAL_INTERVAL_S = 0.4
# Minimum buffered speech (seconds) before ANY partial — the floor is unchanged
# (only the cadence dropped): a partial still needs >= 0.5 s of audio.
_PARTIAL_MIN_AUDIO_S = 0.5
# Tail window decoded for partials. Bounds per-partial
# decode cost on long utterances; finals always carry the full buffer.
# TASK-880 — 6.0, not the 8.0 this constant carried while it was dead.
# `stt.streaming.partialWindowS` defaulted to 6.0 and `SessionManager` passed it on
# EVERY session, so 8.0 was never the effective value; with that key deleted the
# constructor default is what a model row that declares no `partialWindowSec` gets,
# and it must be the number sessions actually ran on. 6s matches the whisper.cpp
# force-emit window, so the last partial and the final decode the same audio.
_DEFAULT_PARTIAL_WINDOW_S = 6.0


@dataclass
class AudioUtterance:
    """A complete speech utterance extracted by the preprocessor.

    Contains float32 mono PCM samples normalised to [-1, 1] at the
    session's sample rate, plus timing metadata.
    """

    samples: np.ndarray  # float32 mono, normalised [-1, 1]
    sample_rate: int
    # Session-relative span of ``samples``. For a partial that outgrew
    # ``partial_window_s`` this is the start of the DECODED WINDOW, not of the
    # utterance — the tail was trimmed, and that offset is what anchors the
    # commit policy's hypotheses to the same audio span (TASK-935).
    start_time: float  # seconds from session start
    end_time: float  # seconds from session start
    utterance_index: int  # 0-based within the session
    is_final: bool = False  # True for confirmed segments (silence-detected or flush)
    # TASK-985 (M-07 / QW-13) — the peak-normalizer gain in force when `samples`
    # was emitted (1.0 when the stage is off, so the batch path and every
    # pre-existing caller are byte-identical). `samples` is AMPLIFIED for the
    # decoder; every downstream ENERGY threshold is a statement about the ROOM
    # and must divide by this first, or a 20x-boosted quiet room measures as
    # speech (the hallucination RMS gate in `inference.py` is the live case).
    normalizer_gain: float = 1.0
    # TASK-985 (M-39) — which decision cut this utterance; one of the module's
    # `REASON_*` tags. PHI-free and bounded, so it is safe as a metric label.
    endpoint_reason: str = "unknown"


@dataclass
class _PreprocessorState:
    """Internal mutable state for the preprocessor."""

    pcm_remainder: bytearray = field(default_factory=bytearray)
    in_speech: bool = False
    speech_onset_frames: int = 0
    onset_gap: int = 0  # cumulative dip frames spent this onset attempt
    silence_frames: int = 0
    noise_floor_cooldown: int = 0
    utterance_buffer: list[np.ndarray] = field(default_factory=list)
    utterance_start_time: float = 0.0
    pre_speech_ring: list[np.ndarray] = field(default_factory=list)
    last_partial_emitted_at: float = 0.0
    total_samples_fed: int = 0
    utterance_count: int = 0
    # TASK-985 (ST-2, D2 3.7) — speech probabilities for the buffered frames,
    # aligned with `utterance_buffer` FROM THE END and bounded to the force-emit
    # lookback. With Silero active the split search can then cut at a real pause
    # (lowest probability) instead of at the lowest-energy frame, which is just
    # as often a stop-consonant closure inside a word. Empty on the energy path.
    vad_prob_ring: Any = None


class StreamingPreprocessor:
    """Real-time VAD + utterance extraction for a single streaming session.

    Parameters
    ----------
    session_id:
        Streaming session identifier (for logging).
    sample_rate:
        Audio sample rate in Hz (16000 or 8000).
    vad_service:
        Initialized :class:`SileroVADService` instance.
    threshold:
        VAD probability threshold for speech detection.
    min_speech_duration_ms:
        Minimum speech duration before confirming onset.
    min_silence_duration_ms:
        Minimum silence duration to confirm speech offset.
    """

    def __init__(
        self,
        session_id: str,
        sample_rate: int = 16000,
        vad_service: Any = None,  # SileroVADService
        threshold: float = 0.6,
        min_speech_duration_ms: int = 100,  # keep short confirmations (was 250)
        min_silence_duration_ms: int = 700,
        target_sample_rate: int | None = None,
        normalize: bool = False,
        resample_enabled: bool = True,
        denoiser: Any | None = None,
        denoise_scope: str = "vad_only",  # vad_only | full
        max_utterance_duration_ms: int = _DEFAULT_MAX_UTTERANCE_DURATION_MS,
        pre_speech_context_ms: int = _PRE_SPEECH_CONTEXT_MS,
        force_emit_lookback_ms: int = _FORCE_EMIT_LOOKBACK_MS,
        force_emit_overlap_ms: int = _FORCE_EMIT_OVERLAP_MS,
        partial_window_s: float = _DEFAULT_PARTIAL_WINDOW_S,
        partial_interval_s: float = _PARTIAL_INTERVAL_S,
        endpointer: Any | None = None,
        energy_veto_enabled: bool = False,
    ) -> None:
        self.session_id = session_id
        self.sample_rate = sample_rate
        self._vad_service = vad_service
        self._threshold = threshold
        # Hysteresis: speech is HELD down to neg_threshold.
        self._neg_threshold = max(threshold - _NEG_THRESHOLD_GAP, 0.01)
        self._min_speech_duration_ms = min_speech_duration_ms
        self._min_silence_duration_ms = min_silence_duration_ms
        # Optional self-hosted semantic endpointer. When present
        # AND enabled, it may cut a final EARLIER than the fixed silence timer at
        # the offset gate below; None/disabled preserves the exact fixed
        # behavior. Duck-typed (SemanticEndpointer) to keep this module import-
        # light; every consult is defensively wrapped (never crashes feed()).
        self._endpointer = endpointer
        self._target_sr = target_sample_rate if target_sample_rate else sample_rate
        self._normalize = normalize
        # TASK-977 (D-5) — `PreprocessingConfig.resample_enabled`, which never
        # reached this preprocessor before. Same posture the batch path has always
        # had (`transcription/preprocessing.py`): the skip is honoured only when it
        # is a NO-OP, because VAD and ASR require the target rate. Both rates are
        # fixed for the session, so the refusal is decided ONCE here rather than per
        # 32 ms frame — `_resample_frame` stays unconditional, which is what makes
        # the override forced rather than merely warned about.
        self._resample_enabled = resample_enabled
        if not resample_enabled and sample_rate != self._target_sr:
            logger.warning(
                "resample.enabled=false but the input rate does not match the target "
                "— resampling anyway (VAD/ASR require the target rate)",
                session_id=session_id,
                input_sample_rate=sample_rate,
                target_sample_rate=self._target_sr,
            )
        self._denoiser = denoiser
        # Dual-path: "vad_only" (default) — the denoised
        # frame only gates the VAD decision; the buffered/emitted audio (what
        # ASR consumes) stays raw. "full" keeps the legacy denoised flow.
        self._denoise_scope = denoise_scope
        self._peak_tracker = 0.0001
        # TASK-985 (M-07 / QW-13) — gain the peak normalizer applied to the most
        # recent frame; 1.0 whenever `normalize` is off, so nothing moves on that
        # path. The energy gate and the downstream hallucination RMS gate are
        # thresholds on the ROOM and divide by it; the gain itself stays on the
        # samples the DECODER sees, which is what the normalizer exists for.
        self._normalizer_gain: float = 1.0
        # TASK-985 (ST-2, D2 3.4) — the pre-VAD energy veto. Deliberately NOT
        # wired to an agent field yet: MR-2 arm 3 decides whether it ships at
        # all, and shipping a knob before the measurement that justifies it is
        # how `speechPadMs` became inert (D2-N1). If MR-2 adopts it, it needs an
        # `audioFrontEnd.vad.*` field and a mapping, not a literal here.
        self._energy_veto_enabled = energy_veto_enabled
        vad_frame_size = _FRAME_SIZE_16K if self._target_sr >= 16000 else _FRAME_SIZE_8K
        if sample_rate != self._target_sr:
            self._frame_size = int(vad_frame_size * (sample_rate / self._target_sr))
        else:
            self._frame_size = vad_frame_size
        self._frame_duration_ms = (self._frame_size / sample_rate) * 1000

        # Pre-speech context: how many frames to keep
        self._pre_speech_frames = max(
            1,
            int(pre_speech_context_ms / self._frame_duration_ms),
        )

        # Minimum speech frames for onset confirmation
        self._min_speech_frames = max(
            1,
            int(min_speech_duration_ms / self._frame_duration_ms),
        )

        # The ring holds onset-confirmation frames AND true
        # pre-speech context. Capping it at pre-context alone meant the
        # confirmation lag evicted the utterance's own first frames (clipped
        # word onsets whenever min_speech approached pre_speech_context).
        self._ring_capacity = self._pre_speech_frames + self._min_speech_frames

        # Minimum silence frames for offset confirmation
        self._min_silence_frames = max(
            1,
            int(min_silence_duration_ms / self._frame_duration_ms),
        )

        # Maximum utterance duration frames — force-emit to prevent WebSocket termination
        self._max_utterance_frames = max(
            1,
            int(max_utterance_duration_ms / self._frame_duration_ms),
        )

        # Partial tail window and force-emit split config
        self._force_emit_lookback_ms = force_emit_lookback_ms
        self._force_emit_overlap_ms = force_emit_overlap_ms
        self._partial_window_s = partial_window_s
        # Configurable partial cadence (lowered default).
        self._partial_interval_s = partial_interval_s

        # Bounded peak window for the causal normalizer.
        from collections import deque

        self._peak_window: Any = deque(
            maxlen=max(1, int(_NORMALIZER_WINDOW_MS / self._frame_duration_ms))
        )

        # Stateful anti-aliased resampler (polyphase with context
        # carry). Per-frame np.interp had no low-pass: 48 kHz browser audio
        # folded HF content into the VAD/ASR band.
        from math import gcd

        _g = gcd(self._target_sr, sample_rate)
        self._resample_up = self._target_sr // _g
        self._resample_down = sample_rate // _g
        _ctx = 20 * max(self._resample_up, self._resample_down)
        # Context multiple of `down` → the leading trim is sample-exact.
        self._resample_ctx = -(-_ctx // self._resample_down) * self._resample_down
        self._resample_carry = np.zeros(0, dtype=np.float32)

        # VAD session state (LSTM hidden state)
        self._vad_state = VADSessionState(
            session_id=session_id,
            sample_rate=self._target_sr,
        )
        self._vad_state.reset()
        self._fallback_noise_floor = 0.002

        # Internal state
        self._state = _PreprocessorState()
        self._reset_prob_ring()

        self._processed_samples: list[np.ndarray] = []

        # TASK-985 (M-39) — per-session cut-reason and endpoint-decision
        # histograms. They answer §2.5 class 2 ("54 % of finals are <= 3 words")
        # without Prometheus: a `silence_timer`-dominated session says the gap is
        # too short, a `semantic`-dominated one says the punctuation heuristic is
        # cutting mid-clause, a `max_utterance`-dominated one says the opposite.
        from collections import Counter

        self._cut_reasons: Any = Counter()
        self._endpoint_decisions: Any = Counter()
        self._vad_degraded: Any = Counter()
        # Stages already warned about this session. TASK-985 (D2-N2): a
        # persistently failing Silero logged a WARNING per 32 ms frame — ~31
        # lines/s/session into Loki — which reads as noise rather than as the
        # metric it should have been. Warn once, count every time.
        self._vad_degraded_warned: set[str] = set()
        self._summary_logged = False

    def reset(self) -> None:
        """Reset all accumulated state."""
        self._state = _PreprocessorState()
        self._reset_prob_ring()
        self._processed_samples.clear()
        self._peak_tracker = 0.0001
        self._normalizer_gain = 1.0
        self._cut_reasons.clear()
        self._endpoint_decisions.clear()
        self._vad_degraded.clear()
        self._vad_degraded_warned.clear()
        self._summary_logged = False
        self._peak_window.clear()
        self._resample_carry = np.zeros(0, dtype=np.float32)
        self._fallback_noise_floor = 0.002
        self._vad_state.reset()
        self._reset_endpointer()

    @property
    def utterance_count(self) -> int:
        """Number of utterances emitted so far."""
        return self._state.utterance_count

    @property
    def in_speech(self) -> bool:
        """Whether VAD currently detects active speech."""
        return self._state.in_speech

    @property
    def has_denoiser(self) -> bool:
        return self._denoiser is not None

    @property
    def target_sample_rate(self) -> int:
        return self._target_sr

    @property
    def resample_enabled(self) -> bool:
        """The stage as DECLARED; honoured only when it is a no-op (see ``__init__``)."""
        return self._resample_enabled

    @property
    def endpointer(self) -> Any | None:
        """The attached semantic endpointer (or None)."""
        return self._endpointer

    @property
    def partial_window_s(self) -> float:
        """Tail window (seconds) each partial is decoded from.

        TASK-934 — readable so a session can LOG the window it actually got:
        the 2026-09-09 experiment set the model row to 15 s and could not tell,
        from outside, that the 6 s default had run instead.
        """
        return self._partial_window_s

    @property
    def normalizer_gain(self) -> float:
        """Gain the peak normalizer is currently applying (1.0 when off)."""
        return self._normalizer_gain

    @property
    def effective_segmentation(self) -> dict[str, Any]:
        """The numbers this preprocessor is ACTUALLY running on.

        TASK-985 (M-13). The agent row said ``minSilenceMs: 350`` and the
        sessions ran on 500, because the builder read the agent's tuning only
        inside ``if vad.enabled`` and substituted a hardware-profile literal
        otherwise. Nothing in the session log could tell you. Rather than
        duplicate the numbers at the call site — which is how they drifted —
        the object that APPLIES them answers for them.

        ``segmenter`` deliberately reports what LOADED, not what was declared:
        a session whose Silero load failed runs on the energy fallback however
        the agent is configured. Bounded keys, no PHI — safe to log verbatim.
        """
        endpointer = self._endpointer
        endpointer_enabled = endpointer is not None and bool(getattr(endpointer, "enabled", False))
        endpoint_config = getattr(endpointer, "config", None)
        silero_active = self._vad_service is not None and bool(self._vad_service.is_loaded)
        if endpointer_enabled:
            endpointing = "semantic"
        elif silero_active:
            # `fixed` on Silero and `fixed` on the energy fallback are two
            # different products — the silence run is anchored on the model's
            # own neg-threshold hysteresis in one and on an energy proxy in the
            # other. Report which one governed (D2 3.6).
            endpointing = "vad"
        else:
            endpointing = "fixed"
        return {
            "segmenter": "silero" if silero_active else "energy",
            "threshold": self._threshold,
            "neg_threshold": self._neg_threshold,
            "min_speech_ms": self._min_speech_duration_ms,
            "min_silence_ms": self._min_silence_duration_ms,
            "pre_speech_context_ms": round(self._pre_speech_frames * self._frame_duration_ms),
            "max_utterance_ms": round(self._max_utterance_frames * self._frame_duration_ms),
            "partial_window_s": self._partial_window_s,
            "partial_interval_s": self._partial_interval_s,
            "normalize": self._normalize,
            "energy_veto": self._energy_veto_enabled,
            "endpointing": endpointing,
            "endpoint_min_silence_ms": getattr(endpoint_config, "min_endpoint_silence_ms", None),
            "endpoint_min_words": getattr(endpoint_config, "min_words", None),
        }

    @property
    def segmentation_summary(self) -> dict[str, Any]:
        """Per-session cut-reason / decision histograms (TASK-985 M-39)."""
        return {
            "utterances": dict(self._cut_reasons),
            "endpoint_decisions": dict(self._endpoint_decisions),
            "vad_degraded": dict(self._vad_degraded),
        }

    def drain_processed_samples(self) -> bytes:
        """Drain accumulated processed samples as int16 PCM bytes."""
        if not self._processed_samples:
            return b""
        samples = np.concatenate(self._processed_samples)
        self._processed_samples.clear()
        return (samples * 32767).clip(-32768, 32767).astype(np.int16).tobytes()

    def _normalize_frame(self, frame: np.ndarray) -> np.ndarray:
        """Bounded-window peak normalization (causal).

        The divisor is the max frame peak over the last
        ``_NORMALIZER_WINDOW_MS`` — attack stays instantaneous (current frame
        is in the window) but a loud transient leaves the window after a few
        seconds instead of suppressing speech for minutes (the previous
        exponential decay had a ~107 s time constant, sinking VAD
        probabilities below threshold long after a door slam).
        """
        frame_peak = float(np.abs(frame).max()) if len(frame) > 0 else 0.0
        self._peak_window.append(frame_peak)
        self._peak_tracker = max(max(self._peak_window), _NORMALIZER_MIN_PEAK)
        # TASK-985 (QW-13): remember the scalar so the energy gates can undo it
        # exactly. Bounded by the divisor floor, so it never exceeds 20x.
        self._normalizer_gain = 1.0 / self._peak_tracker
        return frame / self._peak_tracker

    def _resample_frame(self, frame: np.ndarray) -> np.ndarray:
        """Resample one frame to the target rate (stateful, anti-aliased).

        Polyphase resampling with a carried input-context tail so
        consecutive frames form one continuous filtered stream. The previous
        per-frame ``np.interp`` applied no low-pass filter — content above the
        target Nyquist aliased into the speech band and degraded both Silero
        probabilities and ASR audio.
        """
        if self.sample_rate == self._target_sr:
            return frame

        from scipy.signal import resample_poly

        x = np.concatenate([self._resample_carry, frame.astype(np.float32)])
        y = resample_poly(x, self._resample_up, self._resample_down).astype(np.float32)
        # Context length is a multiple of `down`, so this trim is exact.
        lead = len(self._resample_carry) * self._resample_up // self._resample_down
        out = y[lead:]
        # Keep the carry a multiple of `down` even during warm-up (before the
        # buffer reaches _resample_ctx) so the lead trim stays sample-exact
        # for non-integer ratios (e.g. 44.1 kHz → 16 kHz).
        carry_len = min(
            self._resample_ctx,
            (len(x) // self._resample_down) * self._resample_down,
        )
        self._resample_carry = x[len(x) - carry_len :].copy()
        return cast(np.ndarray, out)

    async def feed(self, pcm_data: bytes) -> list[AudioUtterance]:
        """Feed raw PCM bytes (16-bit signed LE). Returns 0+ complete utterances.

        This method:
        1. Converts PCM bytes → float32 frames (512 samples each)
        2. Runs Silero VAD on each frame
        3. Detects speech onset/offset transitions
        4. On offset → extracts utterance and appends to result

        Parameters
        ----------
        pcm_data:
            Raw PCM audio bytes (int16 LE, mono).

        Returns
        -------
        list[AudioUtterance]
            Zero or more complete utterances detected in this chunk.
        """
        state = self._state
        utterances: list[AudioUtterance] = []

        # Accumulate with any leftover from previous call
        state.pcm_remainder.extend(pcm_data)

        # Convert accumulated bytes to float32 samples
        bytes_per_frame = self._frame_size * 2  # 2 bytes per int16 sample

        while len(state.pcm_remainder) >= bytes_per_frame:
            # Extract one frame worth of bytes
            frame_bytes = bytes(state.pcm_remainder[:bytes_per_frame])
            del state.pcm_remainder[:bytes_per_frame]

            # Convert int16 → float32 normalised to [-1, 1]
            frame_int16 = np.frombuffer(frame_bytes, dtype=np.int16)
            frame_f32 = frame_int16.astype(np.float32) / 32768.0

            # ---- Stage 1: Preprocessor (normalize + resample) ----
            if self._normalize:
                frame_f32 = self._normalize_frame(frame_f32)
            frame_f32 = self._resample_frame(frame_f32)

            # ---- Stage 2: Denoise ----
            # Dual-path: with scope "vad_only" the denoised
            # frame feeds ONLY the VAD decision; the buffered audio stays raw.
            vad_frame = frame_f32
            if self._denoiser is not None:
                if self._denoise_scope == "full":
                    frame_f32 = self._denoiser.process(frame_f32)
                    vad_frame = frame_f32
                else:
                    vad_frame = self._denoiser.process(frame_f32.copy())

            # NOTE: Processed audio collection is deferred to the VAD
            # state machine below so that only speech frames (plus
            # pre-speech context) end up in the processed output.

            # ---- Stage 3: VAD ----
            state.total_samples_fed += len(frame_f32)

            # Suppress VAD during denoiser fade-in to prevent onset
            # detection on near-silence audio (causes Whisper hallucination).
            if self._denoiser is not None and getattr(self._denoiser, "in_fade_in", False):
                prob = 0.0
            else:
                prob = self._apply_energy_veto(self._run_vad(vad_frame), vad_frame)

            # State machine: speech detection
            is_speech = prob >= self._threshold

            if not state.in_speech:
                # Not in speech — track onset
                if is_speech:
                    state.speech_onset_frames += 1
                    if state.speech_onset_frames >= self._min_speech_frames:
                        # Speech confirmed — start collecting
                        state.in_speech = True
                        state.silence_frames = 0

                        # Include pre-speech context + current onset frame
                        state.utterance_buffer = list(state.pre_speech_ring)
                        state.utterance_buffer.append(frame_f32.copy())
                        # TASK-985 (D2-N4): the buffer is SEEDED with the
                        # pre-speech ring, so the onset frame is not where the
                        # emitted audio begins — deriving the start from the
                        # onset frame under-stated every utterance by the ring
                        # (~320 ms on the served defaults) and made
                        # `end_time - start_time` disagree with `len(samples)`.
                        # The buffer is the only thing that knows.
                        state.utterance_start_time = self._buffer_start_time(
                            state.utterance_buffer,
                            state.total_samples_fed / self._target_sr,
                        )
                        self._reset_prob_ring()
                        state.vad_prob_ring.append(prob)

                        # Collect pre-speech context + onset frame for processed audio
                        self._processed_samples.extend(state.pre_speech_ring)
                        self._processed_samples.append(frame_f32.copy())
                        state.pre_speech_ring.clear()

                        # Initialize partial timer (no immediate partial)
                        state.last_partial_emitted_at = time.monotonic()

                        logger.debug(
                            "Speech onset detected",
                            session_id=self.session_id,
                            component="VAD",
                            time_s=round(state.utterance_start_time, 3),
                        )
                    else:
                        # Still tracking onset — keep frame in pre-speech ring
                        state.pre_speech_ring.append(frame_f32.copy())
                        if len(state.pre_speech_ring) > self._ring_capacity:
                            state.pre_speech_ring.pop(0)
                else:
                    # Sub-threshold frame. Tolerate up to _ONSET_HANGOVER_FRAMES
                    # dips TOTAL across this onset attempt so a jittery but real
                    # utterance still confirms; once the cumulative dip
                    # budget is spent, reset the onset attempt — this rejects
                    # both consecutive dips and periodic near-threshold noise,
                    # not just lone transients.
                    if state.speech_onset_frames > 0 and state.onset_gap < _ONSET_HANGOVER_FRAMES:
                        state.onset_gap += 1
                    else:
                        state.speech_onset_frames = 0
                        state.onset_gap = 0

                    # Maintain pre-speech ring buffer (only during non-speech)
                    state.pre_speech_ring.append(frame_f32.copy())
                    if len(state.pre_speech_ring) > self._ring_capacity:
                        state.pre_speech_ring.pop(0)
            else:
                # In speech — track offset
                frame_copy = frame_f32.copy()
                state.utterance_buffer.append(frame_copy)
                self._processed_samples.append(frame_copy)
                state.vad_prob_ring.append(prob)

                # Force-emit if utterance exceeds max duration to prevent websocket
                # Whisper accuracy degradation on oversized segments.
                if len(state.utterance_buffer) >= self._max_utterance_frames:
                    split_idx = self._find_best_split_point(state.utterance_buffer)
                    if split_idx is not None:
                        # Smart split: found low-energy point. The
                        # low-energy frame is often a stop-consonant closure
                        # INSIDE a word; carry overlap from before the split so
                        # the continuation retains the word intact.
                        smart_overlap = int(_SMART_SPLIT_OVERLAP_MS / self._frame_duration_ms)
                        carry_start = max(0, split_idx - smart_overlap)
                        carry = list(state.utterance_buffer[carry_start:])
                        state.utterance_buffer = list(state.utterance_buffer[:split_idx])
                        logger.debug(
                            "Force-emit smart split at low-energy frame",
                            session_id=self.session_id,
                            component="VAD",
                            split_idx=split_idx,
                            carry_frames=len(carry),
                        )
                        utt = self._emit_utterance(
                            is_final=True,
                            reason=REASON_MAX_UTTERANCE_SMART,
                            carry_buffer=carry,
                        )
                    else:
                        # Fallback: hard split with overlap
                        overlap_frames = int(self._force_emit_overlap_ms / self._frame_duration_ms)
                        carry = list(state.utterance_buffer[-overlap_frames:])
                        logger.debug(
                            "Force-emit overlap fallback",
                            session_id=self.session_id,
                            component="VAD",
                            overlap_frames=overlap_frames,
                        )
                        utt = self._emit_utterance(
                            is_final=True,
                            reason=REASON_MAX_UTTERANCE_OVERLAP,
                            carry_buffer=carry,
                        )
                    if utt is not None:
                        utterances.append(utt)
                else:
                    # Hysteresis with upstream Silero run semantics:
                    # the silence run is anchored at the first sub-neg_threshold
                    # frame and counts WALL-CLOCK frames from there; only a
                    # frame >= threshold clears it. Mid-band frames
                    # (neg..threshold — unvoiced word tails) hold speech while
                    # no run is open but must NOT clear an open run, or
                    # probabilities hovering around neg_threshold defer the
                    # final all the way to the 25 s force-emit.
                    if prob >= self._threshold:
                        state.silence_frames = 0
                    elif prob < self._neg_threshold or state.silence_frames > 0:
                        state.silence_frames += 1

                    if state.silence_frames > 0:
                        # Semantic endpoint: consult the
                        # endpointer first. When it signals a confident complete
                        # turn it cuts the final EARLIER than the fixed timer
                        # (or captures a tail the timer would strand); otherwise
                        # fall through to the fixed silence-offset backstop.
                        # Defensive (never raises); False when absent/disabled.
                        should_cut, endpoint_reason = self._should_semantic_endpoint(
                            state.silence_frames
                        )
                        # TASK-985 (M-39 / D2-N8): record the endpointer's own
                        # PHI-free tag EVEN WHEN IT DOES NOT CUT. The four
                        # negative tags are the only evidence that says whether
                        # semantic endpointing ever fires on the served pipeline
                        # — where the punctuation model is finals-only, so a
                        # partial may carry no terminal punctuation at all.
                        if endpoint_reason is not None:
                            self._record_endpoint_reason(endpoint_reason)
                        if should_cut:
                            utt = self._emit_utterance(is_final=True, reason=REASON_SEMANTIC)
                            if utt is not None:
                                utterances.append(utt)
                        elif state.silence_frames >= self._min_silence_frames:
                            # Speech ended — emit confirmed utterance
                            utt = self._emit_utterance(is_final=True, reason=REASON_SILENCE_TIMER)
                            if utt is not None:
                                utterances.append(utt)
                    else:
                        # Check for partial emission
                        partial = self._maybe_emit_partial()
                        if partial is not None:
                            utterances.append(partial)

        return utterances

    async def flush(self) -> AudioUtterance | None:
        """Flush any remaining audio as a final utterance.

        Called when the session is being finalized (stop signal or timeout).
        Returns the remaining audio as an utterance, or None if empty.
        """
        state = self._state

        # Process any remaining PCM bytes (may be less than a full frame)
        if len(state.pcm_remainder) > 0:
            # Pad to frame size
            remainder_bytes = bytes(state.pcm_remainder)
            padded = remainder_bytes + b"\x00" * (self._frame_size * 2 - len(remainder_bytes))
            frame_int16 = np.frombuffer(padded[: self._frame_size * 2], dtype=np.int16)
            frame_f32 = frame_int16.astype(np.float32) / 32768.0
            state.pcm_remainder.clear()

            if self._normalize:
                frame_f32 = self._normalize_frame(frame_f32)
            frame_f32 = self._resample_frame(frame_f32)
            if self._denoiser is not None and self._denoise_scope == "full":
                frame_f32 = self._denoiser.process(frame_f32)

            state.total_samples_fed += len(frame_f32)

            if state.in_speech:
                state.utterance_buffer.append(frame_f32)
                self._processed_samples.append(frame_f32.copy())
            elif state.speech_onset_frames > 0:
                # The remainder belongs to the pending
                # unconfirmed onset below; dropping it loses the last <32 ms
                # of the final word and shifts its timing.
                state.pre_speech_ring.append(frame_f32)

        # Emit whatever is in the utterance buffer
        if state.in_speech and state.utterance_buffer:
            result = self._emit_utterance(is_final=True, reason=REASON_FLUSH)
        # Pending unconfirmed onset: the session stopped less than
        # min_speech_duration after the last word began. Those frames sit in
        # the pre-speech ring; discarding them loses the final word of the
        # consultation. Emit them as the final utterance.
        # Guard: >= 2 onset frames (64 ms) so a single above-threshold noise
        # blip at session stop does not ship a ring of ambient noise to ASR.
        # (TASK-985: once the energy gate measures RAW amplitude — QW-13 — a
        # lone ambient blip can no longer clear the threshold at all, so this
        # guard could safely drop to >= 1 and stop discarding 64 ms of a final
        # word. That is a SECOND behaviour change riding on the first and is
        # deliberately not taken here; revisit once MR-1 has the room-tone
        # number.)
        elif state.speech_onset_frames >= 2 and state.pre_speech_ring:
            state.utterance_buffer = list(state.pre_speech_ring)
            state.pre_speech_ring.clear()
            self._processed_samples.extend(state.utterance_buffer)
            state.utterance_start_time = self._buffer_start_time(
                state.utterance_buffer, state.total_samples_fed / self._target_sr
            )
            result = self._emit_utterance(is_final=True, reason=REASON_FLUSH_PENDING_ONSET)
        else:
            result = None

        self._log_session_summary()
        return result

    def _run_vad(self, frame: np.ndarray) -> float:
        """Run VAD on a single frame, returning speech probability.

        If no VAD service is available, uses a lightweight energy-based
        fallback to preserve utterance segmentation.
        """
        if self._vad_service is None:
            # No service was ever attached: the DECLARED configuration, not a
            # degradation — `effective_segmentation["segmenter"]` already
            # reports "energy" for it. A service that was MEANT to load and did
            # not is counted where that is knowable, at the loader (CL-3).
            return self._run_energy_fallback(frame)
        if not self._vad_service.is_loaded:
            self._note_vad_degraded("not_loaded", latch_count=True)
            return self._run_energy_fallback(frame)

        try:
            return cast(
                float,
                self._vad_service.process_chunk(
                    chunk=frame,
                    session_state=self._vad_state,
                    threshold=self._threshold,
                ),
            )
        except Exception as exc:
            self._note_vad_degraded("inference", exc)
            return self._run_energy_fallback(frame)

    def _note_vad_degraded(
        self, stage: str, exc: Exception | None = None, *, latch_count: bool = False
    ) -> None:
        """Count a degraded frame; warn ONCE per stage per session.

        TASK-985 (D2-N2). The per-frame ``logger.warning`` this replaces fired
        every 32 ms — about 31 lines/s/session — so a broken Silero arrived as a
        log flood rather than as a number anyone could alert on. Fail-open to
        the energy path is still the right posture for a consultation, but only
        because QW-13 made that path safe first: before it, degrading meant
        degrading INTO the room-tone bug.

        ``latch_count`` separates a SESSION fact from a per-frame FAULT RATE: an
        unloaded model is one true statement about the session, counted once;
        an ONNX exception is counted on every frame it happens, because how
        often it happens is the whole signal.
        """
        already = stage in self._vad_degraded_warned
        if not (latch_count and already):
            self._vad_degraded[stage] += 1
            _record_vad_degraded(stage=stage)
        if already:
            return
        self._vad_degraded_warned.add(stage)
        logger.warning(
            "stt.streaming.vad_degraded",
            session_id=self.session_id,
            component="VAD",
            stage=stage,
            error=str(exc) if exc is not None else None,
            detail="segmenting on the energy fallback for the rest of this session",
        )

    def _apply_energy_veto(self, prob: float, frame: np.ndarray) -> float:
        """Zero a Silero probability on a frame the energy path calls room tone.

        TASK-985 (ST-2, D2 3.4). Purely SUBTRACTIVE — it can never open an
        utterance, only refuse one. Runs solely when Silero is the active
        segmenter: on the fallback path ``prob`` already IS the energy
        probability, and re-running the gate would double-step the noise-floor
        EMA and its cooldown. Off unless ``energy_veto_enabled`` (MR-2 arm 3).
        """
        if not self._energy_veto_enabled:
            return prob
        if self._vad_service is None or not self._vad_service.is_loaded:
            return prob
        if self._run_energy_fallback(frame) < _ENERGY_VETO_PROB:
            return 0.0
        return prob

    def _run_energy_fallback(self, frame: np.ndarray) -> float:
        """Estimate speech probability from frame energy.

        This fallback is intentionally simple but avoids unbounded utterances
        when Silero VAD is disabled or unavailable.

        Noise floor adaptation is frozen when onset detection is in progress
        (``speech_onset_frames > 0``) or during a cooldown period after
        utterance emission, preventing the noise floor from tracking speech
        energy and creating a detection death-spiral.
        """
        if frame.size == 0:
            return 0.0

        # TASK-985 (M-07 / QW-13) — measure in RAW amplitude. `frame` has been
        # through the peak normalizer, which boosts a quiet room by up to 20x;
        # the noise-floor ceiling this gate adapts against has always been a raw
        # number, so comparing the two made the "adaptive" floor saturate in
        # exactly the quiet rooms it was meant to adapt to and turned the gate
        # into an absolute detector at about -53 dBFS of room tone. Dividing by
        # the gain is an exact undo of a known scalar, applied AFTER resample
        # and denoise so the gate keeps both (gating the pre-normalization frame
        # instead would re-admit the out-of-band HF energy the anti-alias filter
        # removes, and throw away the whole point of denoise_scope="vad_only").
        rms = float(np.sqrt(np.mean(np.square(frame)))) / max(self._normalizer_gain, 1e-9)
        if not np.isfinite(rms):
            return 0.0

        state = self._state

        if (
            not state.in_speech
            and state.speech_onset_frames == 0
            and state.noise_floor_cooldown == 0
        ):
            self._fallback_noise_floor = (0.95 * self._fallback_noise_floor) + (0.05 * rms)
            self._fallback_noise_floor = min(self._fallback_noise_floor, _FALLBACK_NOISE_FLOOR_MAX)

        if state.noise_floor_cooldown > 0:
            state.noise_floor_cooldown -= 1

        adaptive_threshold = max(_ENERGY_FLOOR_RMS, self._fallback_noise_floor * _ENERGY_MULTIPLIER)
        probability = rms / (adaptive_threshold * 2.0)
        return float(np.clip(probability, 0.0, 1.0))

    def _should_semantic_endpoint(self, silence_frames: int) -> tuple[bool, str | None]:
        """Ask the semantic endpointer whether to cut now.

        Returns ``(should_cut, reason)``. ``should_cut`` is True only when an
        attached, ENABLED endpointer signals a confident complete turn for the
        current trailing silence. Fail-safe: no endpointer / disabled / any
        error → False, so the caller falls through to the fixed silence-offset
        backstop. NEVER raises out of ``feed()``.

        TASK-985 (M-39 / D2-N8): ``reason`` is the endpointer's own PHI-free
        tag, which used to be computed and thrown away at this one call site —
        ``None`` only when no endpointer object exists and therefore nothing was
        decided. The four NEGATIVE tags are what says whether semantic
        endpointing ever fires at all on the served pipeline.
        """
        endpointer = self._endpointer
        if endpointer is None:
            return False, None
        if not getattr(endpointer, "enabled", False):
            return False, "disabled"
        try:
            trailing_silence_ms = silence_frames * self._frame_duration_ms
            decision = endpointer.decide(
                trailing_silence_ms=trailing_silence_ms,
                min_silence_ms=self._min_silence_duration_ms,
            )
            return bool(decision.should_endpoint), str(decision.reason)
        except Exception as exc:  # noqa: BLE001 — degrade to the fixed timer
            logger.warning(
                "Semantic endpoint decision failed, using fixed silence timer",
                session_id=self.session_id,
                component="ENDPOINT",
                error=str(exc),
            )
            return False, "error"

    def _record_endpoint_reason(self, reason: str) -> None:
        """Record one endpoint decision — cut or not (TASK-985 M-39)."""
        self._endpoint_decisions[reason] += 1
        _record_endpoint_decision(reason=reason)

    def _reset_endpointer(self) -> None:
        """Clear the endpointer's observed hypothesis at an utterance boundary."""
        endpointer = self._endpointer
        if endpointer is None:
            return
        try:
            endpointer.reset()
        except Exception as exc:  # noqa: BLE001 — reset must never break the loop
            logger.warning(
                "Semantic endpointer reset failed",
                session_id=self.session_id,
                component="ENDPOINT",
                error=str(exc),
            )

    def _maybe_emit_partial(self) -> AudioUtterance | None:
        """Emit a non-final partial utterance if the timer interval has elapsed.

        Returns an ``AudioUtterance(is_final=False)`` containing a
        tail-window snapshot of the current buffer, or ``None`` if
        conditions are not yet met.  The buffer is *not* cleared.

        The snapshot is bounded to the last
        ``partial_window_s`` seconds so per-partial decode cost stops growing
        with utterance length. Finals are unaffected (full buffer).

        Once trimming starts, ``start_time`` is the window's own start rather
        than the utterance's: it is the offset the commit policy needs to tell
        a slid window from a revised hypothesis (TASK-935).
        """
        state = self._state

        if not state.in_speech or not state.utterance_buffer:
            return None

        now = time.monotonic()
        if now - state.last_partial_emitted_at < self._partial_interval_s:
            return None

        # Check minimum audio duration.
        # TASK-985 (D2-N12): count SAMPLES, not frames x the INPUT-rate frame
        # size. The buffered frames are post-resample, so the old expression
        # overstated the duration by sample_rate/target_sr — 3x on a 48 kHz
        # uplink, firing partials on 0.17 s of audio instead of 0.5 s. Dormant
        # only because the browser resamples to 16 kHz before sending.
        buffer_duration_s = sum(len(f) for f in state.utterance_buffer) / self._target_sr
        if buffer_duration_s < _PARTIAL_MIN_AUDIO_S:
            return None

        # Bound the snapshot to the tail window (whole frames from the end).
        max_window_samples = max(1, int(self._partial_window_s * self._target_sr))
        window_frames: list[np.ndarray] = []
        window_samples = 0
        for frame in reversed(state.utterance_buffer):
            if window_samples + len(frame) > max_window_samples and window_frames:
                break
            window_frames.append(frame)
            window_samples += len(frame)
            if window_samples >= max_window_samples:
                break
        window_frames.reverse()

        samples = np.concatenate(window_frames)

        end_time = state.total_samples_fed / self._target_sr
        # TASK-985 (D2-N4): ONE rule for both branches. The trimmed branch was
        # already correct; the untrimmed one reported the onset frame, which is
        # ~320 ms after the buffered audio actually starts — so `start_time`
        # JUMPED by the pre-speech ring at the first trimmed partial and fed a
        # phantom window slide into the commit policy on every utterance.
        start_time = self._buffer_start_time(window_frames, end_time)

        partial = AudioUtterance(
            samples=samples,
            sample_rate=self._target_sr,
            start_time=start_time,
            end_time=end_time,
            utterance_index=state.utterance_count,
            is_final=False,
            normalizer_gain=self._normalizer_gain,
            endpoint_reason=REASON_PARTIAL,
        )

        state.last_partial_emitted_at = now
        return partial

    def _buffer_start_time(self, buffer: list[np.ndarray], end_time: float) -> float:
        """Session time at which ``buffer``'s FIRST sample was fed.

        TASK-985 (D2-N4) — the one rule every emit path uses, so that
        ``end_time - start_time`` always equals ``len(samples) / sample_rate``.
        Deriving a start from the onset frame instead ignores the pre-speech
        ring the buffer is seeded with, which is ~320 ms on the served defaults
        and is read downstream as a real window slide.
        """
        buffered = sum(len(f) for f in buffer)
        return max(0.0, end_time - buffered / self._target_sr)

    def _prob_ring_maxlen(self) -> int:
        return max(1, int(self._force_emit_lookback_ms / self._frame_duration_ms))

    def _reset_prob_ring(self) -> None:
        """Drop the probability ring at an utterance boundary (TASK-985 ST-2)."""
        from collections import deque

        self._state.vad_prob_ring = deque(maxlen=self._prob_ring_maxlen())

    def _trim_prob_ring(self, keep: int) -> None:
        """Keep only the last ``keep`` probabilities, preserving end-alignment."""
        from collections import deque

        ring = self._state.vad_prob_ring
        tail = list(ring)[-keep:] if keep > 0 else []
        self._state.vad_prob_ring = deque(tail, maxlen=self._prob_ring_maxlen())

    def _find_lowest_probability_pause(
        self, buffer: list[np.ndarray], search_start: int
    ) -> int | None:
        """Lowest-probability frame in the lookback, if it is a genuine pause.

        The ring is aligned with ``buffer`` FROM THE END, so a ring shorter than
        the buffer (the pre-speech frames carry no probability of their own)
        maps cleanly. Returns None when Silero is not the active segmenter or
        when no frame in the window is below the off-threshold — on the energy
        path the probabilities ARE the energy measure, so preferring their
        minimum would only restate the energy search less legibly.
        """
        if self._vad_service is None or not self._vad_service.is_loaded:
            return None
        ring = self._state.vad_prob_ring
        if not ring:
            return None
        probs = list(ring)
        offset = len(buffer) - len(probs)
        if offset < 0:
            return None

        # Never index 0: `buffer[:0]` is empty, so a split there emits nothing
        # and silently drops the whole utterance. (The energy search below can
        # still return 0 whenever the buffer is shorter than the lookback — a
        # pre-existing hazard this lane reports rather than widens.)
        first_valid = max(search_start, 1)

        best_idx: int | None = None
        best_prob = float("inf")
        for i, prob in enumerate(probs):
            buf_idx = offset + i
            if buf_idx < first_valid or buf_idx >= len(buffer):
                continue
            if prob < self._neg_threshold and prob < best_prob:
                best_prob = prob
                best_idx = buf_idx
        return best_idx

    def _log_session_summary(self) -> None:
        """One INFO line per session with the segmentation it actually ran.

        TASK-985 (M-39). This is what makes a single scorecard run explicable
        without Prometheus: a `silence_timer`-dominated histogram says the
        silence gap is too short, a `semantic`-dominated one says the
        punctuation heuristic is cutting mid-clause, a `max_utterance`-dominated
        one says the opposite problem. Emitted once, even if flush is retried.
        """
        if self._summary_logged:
            return
        self._summary_logged = True
        logger.info(
            "stt.streaming.session_summary",
            session_id=self.session_id,
            component="VAD",
            **self.effective_segmentation,
            **self.segmentation_summary,
        )

    def _find_best_split_point(self, buffer: list[np.ndarray]) -> int | None:
        """Find the best frame in the last lookback window to cut at.

        Returns the buffer index to split at, or None if no good point found.

        TASK-985 (ST-2, D2 3.7): when Silero is the active segmenter, prefer the
        lowest SPEECH PROBABILITY frame that is actually below the off-threshold
        — a real pause. A low-ENERGY frame is just as often a stop-consonant
        closure INSIDE a word, which is why the energy split pays 120 ms of
        carry to compensate. The probability search is gated on a frame the
        model itself calls non-speech, so a plateau of uniformly high
        probabilities (no pause in the window) falls through to the energy
        search unchanged rather than cutting at an arbitrary minimum.
        """
        lookback_frames = int(self._force_emit_lookback_ms / self._frame_duration_ms)
        search_start = max(0, len(buffer) - lookback_frames)

        pause_idx = self._find_lowest_probability_pause(buffer, search_start)
        if pause_idx is not None:
            return pause_idx

        # Compute mean energy of full buffer for comparison
        mean_energy = float(np.mean([np.mean(f**2) for f in buffer]))
        if mean_energy < _SPLIT_ENERGY_FLOOR_MS:
            return None

        threshold = mean_energy * _SPLIT_ENERGY_RATIO
        best_idx = None
        best_energy = float("inf")

        for i in range(search_start, len(buffer)):
            energy = float(np.mean(buffer[i] ** 2))
            if energy <= threshold and energy < best_energy:
                best_energy = energy
                best_idx = i

        return best_idx

    def _emit_utterance(
        self,
        is_final: bool,
        *,
        reason: str,
        carry_buffer: list[np.ndarray] | None = None,
    ) -> AudioUtterance | None:
        """Concatenate buffered frames into an AudioUtterance and reset state.

        ``reason`` is required and PHI-free: five distinct decisions reach this
        method and until TASK-985 (M-39) none of them was recorded, so a
        fragmented session and an over-long one were indistinguishable from
        outside the process.
        """
        state = self._state

        if not state.utterance_buffer:
            return None

        # Concatenate all buffered frames
        samples = np.concatenate(state.utterance_buffer)

        end_time = state.total_samples_fed / self._target_sr
        utt_index = state.utterance_count
        # TASK-985 (D2-N4): `start_time` must DESCRIBE `samples`. Derived from
        # the buffer, the same rule the carry path below already used — the
        # onset-frame arithmetic it replaces ignored the pre-speech ring the
        # buffer is seeded with and under-stated every utterance by ~320 ms.
        start_time = self._buffer_start_time(state.utterance_buffer, end_time)

        utterance = AudioUtterance(
            samples=samples,
            sample_rate=self._target_sr,
            start_time=start_time,
            end_time=end_time,
            utterance_index=utt_index,
            is_final=is_final,
            normalizer_gain=self._normalizer_gain,
            endpoint_reason=reason,
        )

        self._cut_reasons[reason] += 1
        _record_utterance_emitted(reason=reason, is_final=is_final)

        if self._denoiser is not None:
            logger.debug(
                "Applied RNNoise denoising to utterance",
                session_id=self.session_id,
                component="NOISE_SUPPRESSION",
                index=utt_index,
            )

        logger.debug(
            "Utterance emitted",
            session_id=self.session_id,
            component="VAD",
            index=utt_index,
            start_s=round(start_time, 3),
            end_s=round(end_time, 3),
            duration_s=round(end_time - start_time, 3),
            samples=len(samples),
            is_final=is_final,
            reason=reason,
        )

        # Reset for next utterance
        state.utterance_buffer.clear()
        if carry_buffer:
            # Seed next utterance with carry-forward audio (force-emit split)
            state.utterance_buffer = carry_buffer
            state.in_speech = True
            carry_duration = sum(len(f) for f in carry_buffer) / self._target_sr
            state.utterance_start_time = end_time - carry_duration
            # The ring stays aligned with the buffer FROM THE END, and every
            # carry ends where the emitted buffer did, so keeping its tail is
            # enough — no slicing of a parallel per-utterance list.
            self._trim_prob_ring(len(carry_buffer))
            # TASK-985 (D2-N10): the onset path arms this timer for exactly this
            # reason. Leaving it at 0.0 while `in_speech` stays True made the
            # very next frame emit a partial over the carry alone — audio that
            # was just published as a final.
            state.last_partial_emitted_at = time.monotonic()
        else:
            state.in_speech = False
            state.speech_onset_frames = 0
            state.onset_gap = 0
            state.utterance_start_time = start_time
            self._reset_prob_ring()
            state.last_partial_emitted_at = 0.0
        state.silence_frames = 0
        state.noise_floor_cooldown = _NOISE_FLOOR_COOLDOWN_FRAMES
        state.utterance_count += 1

        # Drop the observed hypothesis at the utterance boundary;
        # the next partial re-populates it for the following utterance.
        self._reset_endpointer()

        return utterance
