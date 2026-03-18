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

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import structlog

from stt_v2.vad.dto import VADSessionState

logger = structlog.get_logger(__name__)

# Silero v5 constants
_FRAME_SIZE_16K = 512  # 512 samples = 32 ms at 16 kHz
_FRAME_SIZE_8K = 256  # 256 samples = 32 ms at 8 kHz
_PRE_SPEECH_CONTEXT_MS = 300  # Keep 300ms before speech onset
_ENERGY_FLOOR = 1e-4  # Lower bound for energy-based fallback VAD
_ENERGY_MULTIPLIER = 2.5  # Speech threshold multiplier above learned noise floor
_FALLBACK_NOISE_FLOOR_MAX = 0.015  # Hard cap to prevent runaway adaptation
_NOISE_FLOOR_COOLDOWN_FRAMES = 15  # ~480ms cooldown after utterance emission


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

    # PCM accumulator — incoming bytes not yet processed into frames
    pcm_remainder: bytearray = field(default_factory=bytearray)

    # Speech detection state machine
    in_speech: bool = False
    speech_onset_frames: int = 0  # consecutive frames above threshold
    silence_frames: int = 0  # consecutive frames below threshold
    noise_floor_cooldown: int = 0  # frames to skip noise floor adaptation after utterance

    # Current utterance being assembled
    utterance_buffer: list[np.ndarray] = field(default_factory=list)
    utterance_start_time: float = 0.0

    # Pre-speech context ring (keeps last N ms of audio before onset)
    pre_speech_ring: list[np.ndarray] = field(default_factory=list)

    # Counters
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
        threshold: float = 0.5,
        min_speech_duration_ms: int = 250,
        min_silence_duration_ms: int = 700,
    ) -> None:
        self.session_id = session_id
        self.sample_rate = sample_rate
        self._vad_service = vad_service
        self._threshold = threshold
        self._min_speech_duration_ms = min_speech_duration_ms
        self._min_silence_duration_ms = min_silence_duration_ms

        # Frame size depends on sample rate
        self._frame_size = _FRAME_SIZE_16K if sample_rate >= 16000 else _FRAME_SIZE_8K
        self._frame_duration_ms = (self._frame_size / sample_rate) * 1000

        # Pre-speech context: how many frames to keep
        self._pre_speech_frames = max(
            1,
            int(_PRE_SPEECH_CONTEXT_MS / self._frame_duration_ms),
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

        # VAD session state (LSTM hidden state)
        self._vad_state = VADSessionState(
            session_id=session_id,
            sample_rate=sample_rate,
        )
        self._vad_state.reset()
        self._fallback_noise_floor = 0.002

        # Internal state
        self._state = _PreprocessorState()

    @property
    def utterance_count(self) -> int:
        """Number of utterances emitted so far."""
        return self._state.utterance_count

    @property
    def in_speech(self) -> bool:
        """Whether VAD currently detects active speech."""
        return self._state.in_speech

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

            state.total_samples_fed += len(frame_f32)

            # Run VAD on this frame
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
                            state.total_samples_fed - self._frame_size * state.speech_onset_frames
                        ) / self.sample_rate

                        # Include pre-speech context
                        state.utterance_buffer = list(state.pre_speech_ring)
                        state.pre_speech_ring.clear()

                        logger.debug(
                            "Speech onset",
                            session_id=self.session_id,
                            time_s=round(state.utterance_start_time, 3),
                        )
                else:
                    state.speech_onset_frames = 0

                # Maintain pre-speech ring buffer
                state.pre_speech_ring.append(frame_f32.copy())
                if len(state.pre_speech_ring) > self._pre_speech_frames:
                    state.pre_speech_ring.pop(0)
            else:
                # In speech — track offset
                state.utterance_buffer.append(frame_f32.copy())

                if not is_speech:
                    state.silence_frames += 1
                    if state.silence_frames >= self._min_silence_frames:
                        # Speech ended — emit confirmed utterance
                        utt = self._emit_utterance(is_final=True)
                        if utt is not None:
                            utterances.append(utt)
                else:
                    state.silence_frames = 0

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

            if state.in_speech:
                state.utterance_buffer.append(frame_f32)

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
            return self._vad_service.process_chunk(
                chunk=frame,
                session_state=self._vad_state,
                threshold=self._threshold,
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

    def _emit_utterance(self, is_final: bool) -> AudioUtterance | None:
        """Concatenate buffered frames into an AudioUtterance and reset state."""
        state = self._state

        if not state.utterance_buffer:
            return None

        # Concatenate all buffered frames
        samples = np.concatenate(state.utterance_buffer)

        end_time = state.total_samples_fed / self.sample_rate
        utt_index = state.utterance_count

        utterance = AudioUtterance(
            samples=samples,
            sample_rate=self.sample_rate,
            start_time=state.utterance_start_time,
            end_time=end_time,
            utterance_index=utt_index,
            is_final=is_final,
        )

        logger.info(
            "Utterance emitted",
            session_id=self.session_id,
            index=utt_index,
            start_s=round(state.utterance_start_time, 3),
            end_s=round(end_time, 3),
            duration_s=round(end_time - state.utterance_start_time, 3),
            samples=len(samples),
            is_final=is_final,
        )

        # Reset for next utterance
        state.utterance_buffer.clear()
        state.in_speech = False
        state.speech_onset_frames = 0
        state.silence_frames = 0
        state.noise_floor_cooldown = _NOISE_FLOOR_COOLDOWN_FRAMES
        state.utterance_count += 1

        return utterance
