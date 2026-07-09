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

from stt_v2.vad.dto import VADSessionState

logger = structlog.get_logger(__name__)

# Silero v5 constants
_FRAME_SIZE_16K = 512  # 512 samples = 32 ms at 16 kHz
_FRAME_SIZE_8K = 256
_PRE_SPEECH_CONTEXT_MS = 300
_ENERGY_FLOOR = 1e-4
_ENERGY_MULTIPLIER = 2.5
_FALLBACK_NOISE_FLOOR_MAX = 0.015
_NOISE_FLOOR_COOLDOWN_FRAMES = 15
# TASK-451 C2-06/I-1: TOTAL sub-threshold "dip" frames tolerated across a
# single onset attempt (cumulative — NOT reset by intervening speech frames).
# One mild VAD-jitter dip must not discard a real utterance, but once the
# budget is spent the onset attempt resets — so consecutive dips AND periodic
# near-threshold noise (cleanly alternating above/below threshold) are rejected
# rather than accreting a false onset.
_ONSET_HANGOVER_FRAMES = 1
_DEFAULT_MAX_UTTERANCE_DURATION_MS = 25000
_FORCE_EMIT_LOOKBACK_MS = 1500
_FORCE_EMIT_OVERLAP_MS = 500
_SPLIT_ENERGY_RATIO = 0.3

_PARTIAL_INTERVAL_S = 1.0
_PARTIAL_MIN_AUDIO_S = 0.5
# TASK-351 P0-4 (C2) — tail window decoded for partials. Bounds per-partial
# decode cost on long utterances; finals always carry the full buffer.
_DEFAULT_PARTIAL_WINDOW_S = 8.0


@dataclass
class AudioUtterance:
    """A complete speech utterance extracted by the preprocessor.

    Contains float32 mono PCM samples normalised to [-1, 1] at the
    session's sample rate, plus timing metadata.
    """

    samples: np.ndarray  # float32 mono, normalised [-1, 1]
    sample_rate: int
    start_time: float  # seconds from session start
    end_time: float  # seconds from session start
    utterance_index: int  # 0-based within the session
    is_final: bool = False  # True for confirmed segments (silence-detected or flush)


@dataclass
class _PreprocessorState:
    """Internal mutable state for the preprocessor."""

    pcm_remainder: bytearray = field(default_factory=bytearray)
    in_speech: bool = False
    speech_onset_frames: int = 0
    onset_gap: int = 0  # cumulative dip frames spent this onset attempt (C2-06/I-1)
    silence_frames: int = 0
    noise_floor_cooldown: int = 0
    utterance_buffer: list[np.ndarray] = field(default_factory=list)
    utterance_start_time: float = 0.0
    pre_speech_ring: list[np.ndarray] = field(default_factory=list)
    last_partial_emitted_at: float = 0.0
    total_samples_fed: int = 0
    utterance_count: int = 0


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
        min_speech_duration_ms: int = 250,  # C2-06: clinical default (Silero ref)
        min_silence_duration_ms: int = 700,
        target_sample_rate: int | None = None,
        normalize: bool = False,
        denoiser: Any | None = None,
        max_utterance_duration_ms: int = _DEFAULT_MAX_UTTERANCE_DURATION_MS,
        pre_speech_context_ms: int = _PRE_SPEECH_CONTEXT_MS,
        force_emit_lookback_ms: int = _FORCE_EMIT_LOOKBACK_MS,
        force_emit_overlap_ms: int = _FORCE_EMIT_OVERLAP_MS,
        partial_window_s: float = _DEFAULT_PARTIAL_WINDOW_S,
    ) -> None:
        self.session_id = session_id
        self.sample_rate = sample_rate
        self._vad_service = vad_service
        self._threshold = threshold
        self._min_speech_duration_ms = min_speech_duration_ms
        self._min_silence_duration_ms = min_silence_duration_ms
        self._target_sr = target_sample_rate if target_sample_rate else sample_rate
        self._normalize = normalize
        self._denoiser = denoiser
        self._peak_tracker = 0.0001
        self._peak_decay = 0.9997
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

        # VAD session state (LSTM hidden state)
        self._vad_state = VADSessionState(
            session_id=session_id,
            sample_rate=self._target_sr,
        )
        self._vad_state.reset()
        self._fallback_noise_floor = 0.002

        # Internal state
        self._state = _PreprocessorState()

        self._processed_samples: list[np.ndarray] = []

    def reset(self) -> None:
        """Reset all accumulated state."""
        self._state = _PreprocessorState()
        self._processed_samples.clear()
        self._peak_tracker = 0.0001
        self._fallback_noise_floor = 0.002
        self._vad_state.reset()

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

    def drain_processed_samples(self) -> bytes:
        """Drain accumulated processed samples as int16 PCM bytes."""
        if not self._processed_samples:
            return b""
        samples = np.concatenate(self._processed_samples)
        self._processed_samples.clear()
        return (samples * 32767).clip(-32768, 32767).astype(np.int16).tobytes()

    def _normalize_frame(self, frame: np.ndarray) -> np.ndarray:
        """Peak-tracking normalization with exponential decay (causal)."""
        frame_peak = float(np.abs(frame).max()) if len(frame) > 0 else 0.0
        if frame_peak > self._peak_tracker:
            self._peak_tracker = frame_peak  # fast attack
        else:
            self._peak_tracker *= self._peak_decay  # slow decay
        if self._peak_tracker > 1e-6:
            return frame / self._peak_tracker
        return frame

    def _resample_frame(self, frame: np.ndarray) -> np.ndarray:
        """Resample single frame from sample_rate to target_sample_rate."""
        if self.sample_rate == self._target_sr:
            return frame
        ratio = self._target_sr / self.sample_rate
        n_out = int(len(frame) * ratio)
        indices = np.linspace(0, len(frame) - 1, n_out)
        return cast(np.ndarray, np.interp(indices, np.arange(len(frame)), frame).astype(np.float32))

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
            if self._denoiser is not None:
                frame_f32 = self._denoiser.process(frame_f32)

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
                prob = self._run_vad(frame_f32)

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
                        state.utterance_start_time = (
                            state.total_samples_fed - len(frame_f32) * state.speech_onset_frames
                        ) / self._target_sr

                        # Include pre-speech context + current onset frame
                        state.utterance_buffer = list(state.pre_speech_ring)
                        state.utterance_buffer.append(frame_f32.copy())

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
                        if len(state.pre_speech_ring) > self._pre_speech_frames:
                            state.pre_speech_ring.pop(0)
                else:
                    # Sub-threshold frame. Tolerate up to _ONSET_HANGOVER_FRAMES
                    # dips TOTAL across this onset attempt so a jittery but real
                    # utterance still confirms (C2-06); once the cumulative dip
                    # budget is spent, reset the onset attempt — this rejects
                    # both consecutive dips and periodic near-threshold noise
                    # (I-1), not just lone transients.
                    if (
                        state.speech_onset_frames > 0
                        and state.onset_gap < _ONSET_HANGOVER_FRAMES
                    ):
                        state.onset_gap += 1
                    else:
                        state.speech_onset_frames = 0
                        state.onset_gap = 0

                    # Maintain pre-speech ring buffer (only during non-speech)
                    state.pre_speech_ring.append(frame_f32.copy())
                    if len(state.pre_speech_ring) > self._pre_speech_frames:
                        state.pre_speech_ring.pop(0)
            else:
                # In speech — track offset
                frame_copy = frame_f32.copy()
                state.utterance_buffer.append(frame_copy)
                self._processed_samples.append(frame_copy)

                # Force-emit if utterance exceeds max duration to prevent websocket
                # Whisper accuracy degradation on oversized segments.
                if len(state.utterance_buffer) >= self._max_utterance_frames:
                    split_idx = self._find_best_split_point(state.utterance_buffer)
                    if split_idx is not None:
                        # Smart split: found low-energy point
                        carry = list(state.utterance_buffer[split_idx:])
                        state.utterance_buffer = list(state.utterance_buffer[:split_idx])
                        logger.debug(
                            "Force-emit smart split at low-energy frame",
                            session_id=self.session_id,
                            component="VAD",
                            split_idx=split_idx,
                            carry_frames=len(carry),
                        )
                        utt = self._emit_utterance(is_final=True, carry_buffer=carry)
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
                        utt = self._emit_utterance(is_final=True, carry_buffer=carry)
                    if utt is not None:
                        utterances.append(utt)
                elif not is_speech:
                    state.silence_frames += 1
                    if state.silence_frames >= self._min_silence_frames:
                        # Speech ended — emit confirmed utterance
                        utt = self._emit_utterance(is_final=True)
                        if utt is not None:
                            utterances.append(utt)
                else:
                    state.silence_frames = 0
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
            if self._denoiser is not None:
                frame_f32 = self._denoiser.process(frame_f32)

            state.total_samples_fed += len(frame_f32)

            if state.in_speech:
                state.utterance_buffer.append(frame_f32)
                self._processed_samples.append(frame_f32.copy())

        # Emit whatever is in the utterance buffer
        if state.in_speech and state.utterance_buffer:
            return self._emit_utterance(is_final=True)

        return None

    def _run_vad(self, frame: np.ndarray) -> float:
        """Run VAD on a single frame, returning speech probability.

        If no VAD service is available, uses a lightweight energy-based
        fallback to preserve utterance segmentation.
        """
        if self._vad_service is None or not self._vad_service.is_loaded:
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
            logger.warning(
                "VAD inference error, using energy fallback",
                session_id=self.session_id,
                error=str(exc),
            )
            return self._run_energy_fallback(frame)

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

        rms = float(np.sqrt(np.mean(np.square(frame))))
        if not np.isfinite(rms):
            return 0.0

        state = self._state

        if (
            not state.in_speech
            and state.speech_onset_frames == 0
            and state.noise_floor_cooldown == 0
        ):
            self._fallback_noise_floor = (0.95 * self._fallback_noise_floor) + (0.05 * rms)
            self._fallback_noise_floor = min(
                self._fallback_noise_floor, _FALLBACK_NOISE_FLOOR_MAX
            )

        if state.noise_floor_cooldown > 0:
            state.noise_floor_cooldown -= 1

        adaptive_threshold = max(_ENERGY_FLOOR, self._fallback_noise_floor * _ENERGY_MULTIPLIER)
        probability = rms / (adaptive_threshold * 2.0)
        return float(np.clip(probability, 0.0, 1.0))

    def _maybe_emit_partial(self) -> AudioUtterance | None:
        """Emit a non-final partial utterance if the timer interval has elapsed.

        Returns an ``AudioUtterance(is_final=False)`` containing a
        tail-window snapshot of the current buffer, or ``None`` if
        conditions are not yet met.  The buffer is *not* cleared.

        TASK-351 P0-4 (C2): the snapshot is bounded to the last
        ``partial_window_s`` seconds so per-partial decode cost stops growing
        with utterance length. Finals are unaffected (full buffer).
        """
        state = self._state

        if not state.in_speech or not state.utterance_buffer:
            return None

        now = time.monotonic()
        if now - state.last_partial_emitted_at < _PARTIAL_INTERVAL_S:
            return None

        # Check minimum audio duration
        buffer_duration_s = len(state.utterance_buffer) * self._frame_size / self._target_sr
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
        trimmed = len(window_frames) < len(state.utterance_buffer)
        start_time = (
            end_time - (len(samples) / self._target_sr)
            if trimmed
            else state.utterance_start_time
        )

        partial = AudioUtterance(
            samples=samples,
            sample_rate=self._target_sr,
            start_time=start_time,
            end_time=end_time,
            utterance_index=state.utterance_count,
            is_final=False,
        )

        state.last_partial_emitted_at = now
        return partial

    def _find_best_split_point(self, buffer: list[np.ndarray]) -> int | None:
        """Find lowest-energy frame in the last lookback window.

        Returns the buffer index to split at, or None if no good point found.
        """
        lookback_frames = int(self._force_emit_lookback_ms / self._frame_duration_ms)
        search_start = max(0, len(buffer) - lookback_frames)

        # Compute mean energy of full buffer for comparison
        mean_energy = float(np.mean([np.mean(f ** 2) for f in buffer]))
        if mean_energy < _ENERGY_FLOOR:
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

    def _emit_utterance(self, is_final: bool, carry_buffer: list[np.ndarray] | None = None) -> AudioUtterance | None:
        """Concatenate buffered frames into an AudioUtterance and reset state."""
        state = self._state

        if not state.utterance_buffer:
            return None

        # Concatenate all buffered frames
        samples = np.concatenate(state.utterance_buffer)

        end_time = state.total_samples_fed / self._target_sr
        utt_index = state.utterance_count

        utterance = AudioUtterance(
            samples=samples,
            sample_rate=self._target_sr,
            start_time=state.utterance_start_time,
            end_time=end_time,
            utterance_index=utt_index,
            is_final=is_final,
        )

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
            start_s=round(state.utterance_start_time, 3),
            end_s=round(end_time, 3),
            duration_s=round(end_time - state.utterance_start_time, 3),
            samples=len(samples),
            is_final=is_final,
        )

        # Reset for next utterance
        state.utterance_buffer.clear()
        if carry_buffer:
            # Seed next utterance with carry-forward audio (force-emit split)
            state.utterance_buffer = carry_buffer
            state.in_speech = True
            carry_duration = sum(len(f) for f in carry_buffer) / self._target_sr
            state.utterance_start_time = end_time - carry_duration
        else:
            state.in_speech = False
            state.speech_onset_frames = 0
            state.onset_gap = 0
        state.silence_frames = 0
        state.noise_floor_cooldown = _NOISE_FLOOR_COOLDOWN_FRAMES
        state.last_partial_emitted_at = 0.0
        state.utterance_count += 1

        return utterance
