"""Silero VAD v5 ONNX service.

Production-ready Voice Activity Detection using Silero VAD v5 with
ONNX Runtime for maximum performance (~189μs per frame on CPU).

Key design decisions:
- ONNX over PyTorch JIT: ~1.7x faster, lower memory, no torch dependency
- Single-threaded ONNX: model optimised for single-thread CPU execution
- Per-session state: LSTM state isolated per streaming session via VADSessionState
- Separate batch/streaming APIs to match different usage patterns
"""

import logging
from pathlib import Path
from typing import Any

import numpy as np

from ..core.config.settings import get_settings
from .dto import SpeechSegment, VADResult, VADSessionState

logger = logging.getLogger(__name__)

# Silero v5 constants
_SILERO_FRAME_SIZE_16K = 512  # v5 frame size for 16 kHz
_SILERO_FRAME_SIZE_8K = 256  # v5 frame size for 8 kHz
_SILERO_STATE_SHAPE = (2, 1, 128)  # LSTM hidden state


class SileroVADService:
    """Silero VAD v5 ONNX service for speech/silence detection.

    The service wraps a single ONNX Runtime session. The model itself is
    stateless — all streaming state lives in ``VADSessionState`` objects
    managed externally (one per streaming session).

    For batch processing, call ``detect_speech`` which handles state
    internally. For streaming, call ``process_chunk`` with a session state.
    """

    def __init__(self, model_path: str | None = None) -> None:
        self._session: Any = None  # onnxruntime.InferenceSession
        self._model_path = model_path
        self._loaded = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def initialize(self) -> None:
        """Load the ONNX model. Safe to call multiple times."""
        if self._loaded:
            return

        import onnxruntime

        model_path = self._resolve_model_path()

        opts = onnxruntime.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL

        self._session = onnxruntime.InferenceSession(
            str(model_path),
            sess_options=opts,
            providers=["CPUExecutionProvider"],
        )
        self._loaded = True
        logger.info("Silero VAD v5 ONNX model loaded from %s", model_path)

    async def shutdown(self) -> None:
        """Release ONNX session resources."""
        self._session = None
        self._loaded = False
        logger.info("Silero VAD service shut down")

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    # ------------------------------------------------------------------
    # Batch API — full-file VAD
    # ------------------------------------------------------------------

    def detect_speech(
        self,
        samples: np.ndarray,
        sample_rate: int = 16000,
        threshold: float | None = None,
        min_speech_duration_ms: int | None = None,
        min_silence_duration_ms: int | None = None,
        speech_pad_ms: int | None = None,
    ) -> VADResult:
        """Run VAD on a complete audio buffer.

        Args:
            samples: Float32 mono audio normalised to [-1, 1].
            sample_rate: 16000 or 8000.
            threshold: Override default speech threshold.
            min_speech_duration_ms: Override minimum speech duration.
            min_silence_duration_ms: Override minimum silence to end speech.
            speech_pad_ms: Override speech onset padding.

        Returns:
            VADResult with speech segments.
        """
        if not self._loaded:
            raise RuntimeError("SileroVADService not initialised — call initialize() first")

        settings = get_settings()
        threshold = threshold or settings.vad_threshold
        min_speech_ms = min_speech_duration_ms or settings.vad_min_speech_duration_ms
        min_silence_ms = min_silence_duration_ms or settings.vad_min_silence_duration_ms
        pad_ms = speech_pad_ms or settings.vad_speech_pad_ms

        frame_size = _SILERO_FRAME_SIZE_16K if sample_rate == 16000 else _SILERO_FRAME_SIZE_8K
        audio_duration = len(samples) / sample_rate

        # Fresh LSTM state for batch
        state = np.zeros(_SILERO_STATE_SHAPE, dtype=np.float32)
        sr_array = np.array(sample_rate, dtype=np.int64)

        # Collect per-frame probabilities
        probs: list[float] = []
        for offset in range(0, len(samples), frame_size):
            chunk = samples[offset: offset + frame_size]
            if len(chunk) < frame_size:
                chunk = np.pad(chunk, (0, frame_size - len(chunk)))

            input_data = chunk.reshape(1, -1).astype(np.float32)
            ort_out = self._session.run(
                None,
                {"input": input_data, "state": state, "sr": sr_array},
            )
            prob = float(ort_out[0][0][0])
            state = ort_out[1]
            probs.append(prob)

        # Convert probabilities → segments using threshold + timing rules
        segments = self._probs_to_segments(
            probs=probs,
            frame_size=frame_size,
            sample_rate=sample_rate,
            threshold=threshold,
            min_speech_ms=min_speech_ms,
            min_silence_ms=min_silence_ms,
            pad_ms=pad_ms,
            total_samples=len(samples),
        )

        speech_duration = sum(s.duration for s in segments)

        return VADResult(
            segments=segments,
            speech_duration=speech_duration,
            audio_duration=audio_duration,
            applied=True,
        )

    # ------------------------------------------------------------------
    # Streaming API — per-chunk processing
    # ------------------------------------------------------------------

    def process_chunk(
        self,
        chunk: np.ndarray,
        session_state: VADSessionState,
        threshold: float | None = None,
    ) -> float:
        """Process a single audio chunk and return speech probability.

        The LSTM state in ``session_state`` is updated in-place so it
        persists across consecutive calls for the same streaming session.

        Args:
            chunk: Audio frame (512 samples for 16 kHz, 256 for 8 kHz).
            session_state: Per-session LSTM state.
            threshold: Override default threshold.

        Returns:
            Speech probability for this frame (0.0–1.0).
        """
        if not self._loaded:
            raise RuntimeError("SileroVADService not initialised — call initialize() first")

        frame_size = (
            _SILERO_FRAME_SIZE_16K
            if session_state.sample_rate == 16000
            else _SILERO_FRAME_SIZE_8K
        )

        # Pad if too short
        if len(chunk) < frame_size:
            chunk = np.pad(chunk, (0, frame_size - len(chunk)))
        elif len(chunk) > frame_size:
            chunk = chunk[:frame_size]

        # Ensure state is initialised
        if session_state.h_state is None:
            session_state.h_state = np.zeros(_SILERO_STATE_SHAPE, dtype=np.float32)

        input_data = chunk.reshape(1, -1).astype(np.float32)
        sr_array = np.array(session_state.sample_rate, dtype=np.int64)

        ort_out = self._session.run(
            None,
            {"input": input_data, "state": session_state.h_state, "sr": sr_array},
        )

        prob = float(ort_out[0][0][0])
        session_state.h_state = ort_out[1]  # Carry forward LSTM state
        session_state.samples_processed += frame_size

        from datetime import datetime, timezone

        session_state.last_activity = datetime.now(timezone.utc)

        return prob

    def create_session_state(self, session_id: str, sample_rate: int = 16000) -> VADSessionState:
        """Create a fresh session state for a new streaming session."""
        state = VADSessionState(session_id=session_id, sample_rate=sample_rate)
        state.h_state = np.zeros(_SILERO_STATE_SHAPE, dtype=np.float32)
        return state

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _resolve_model_path(self) -> Path:
        """Resolve the ONNX model path: explicit setting > HuggingFace download."""
        if self._model_path:
            path = Path(self._model_path)
            if path.exists():
                return path

        # Auto-download from HuggingFace
        try:
            from huggingface_hub import hf_hub_download

            settings = get_settings()
            cached_path = hf_hub_download(
                repo_id="onnx-community/silero-vad",
                filename="onnx/model.onnx",
                cache_dir=settings.huggingface_cache_dir,
                token=settings.huggingface_token,
            )
            return Path(cached_path)
        except ImportError:
            raise RuntimeError(
                "huggingface_hub is required to auto-download Silero VAD. "
                "Install it or set VAD_MODEL_PATH to a local file."
            )

    @staticmethod
    def _probs_to_segments(
        probs: list[float],
        frame_size: int,
        sample_rate: int,
        threshold: float,
        min_speech_ms: int,
        min_silence_ms: int,
        pad_ms: int,
        total_samples: int,
    ) -> list[SpeechSegment]:
        """Convert per-frame probabilities into merged speech segments.

        Implements the same logic as Silero's ``get_speech_timestamps``:
        - A frame above *threshold* triggers speech onset.
        - Speech ends after *min_silence_ms* of consecutive below-threshold frames.
        - Segments shorter than *min_speech_ms* are discarded.
        - *pad_ms* is added before segment start and after segment end.
        """
        min_speech_frames = int(min_speech_ms * sample_rate / 1000 / frame_size)
        min_silence_frames = int(min_silence_ms * sample_rate / 1000 / frame_size)
        pad_samples = int(pad_ms * sample_rate / 1000)

        segments: list[SpeechSegment] = []
        speech_start: int | None = None
        silence_count = 0
        speech_frame_count = 0

        for i, prob in enumerate(probs):
            if prob >= threshold:
                if speech_start is None:
                    speech_start = i
                    speech_frame_count = 0
                silence_count = 0
                speech_frame_count += 1
            else:
                if speech_start is not None:
                    silence_count += 1
                    if silence_count >= min_silence_frames:
                        # End of speech
                        if speech_frame_count >= min_speech_frames:
                            start_sample = max(0, speech_start * frame_size - pad_samples)
                            end_sample = min(total_samples, (i - silence_count + 1) * frame_size + pad_samples)

                            avg_prob = (
                                sum(probs[speech_start: i - silence_count + 1])
                                / (i - silence_count + 1 - speech_start)
                                if (i - silence_count + 1 - speech_start) > 0
                                else 0.0
                            )

                            segments.append(
                                SpeechSegment(
                                    start_time=start_sample / sample_rate,
                                    end_time=end_sample / sample_rate,
                                    probability=avg_prob,
                                )
                            )
                        speech_start = None
                        silence_count = 0

        # Handle trailing speech
        if speech_start is not None and speech_frame_count >= min_speech_frames:
            start_sample = max(0, speech_start * frame_size - pad_samples)
            end_sample = total_samples

            trailing_probs = probs[speech_start:]
            avg_prob = sum(trailing_probs) / len(trailing_probs) if trailing_probs else 0.0

            segments.append(
                SpeechSegment(
                    start_time=start_sample / sample_rate,
                    end_time=end_sample / sample_rate,
                    probability=avg_prob,
                )
            )

        return segments


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_service: SileroVADService | None = None


def get_vad_service() -> SileroVADService:
    """Get singleton Silero VAD service instance."""
    global _service
    if _service is None:
        settings = get_settings()
        _service = SileroVADService(model_path=settings.vad_model_path)
    return _service
