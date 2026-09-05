"""Silero VAD v5 ONNX service.

Production-ready Voice Activity Detection using Silero VAD v5 with
ONNX Runtime for maximum performance (~189μs per frame on CPU).

Key design decisions:
- ONNX over PyTorch JIT: ~1.7x faster, lower memory, no torch dependency
- Single-threaded ONNX: model optimised for single-thread CPU execution
- Per-session state: LSTM state isolated per streaming session via VADSessionState
- Separate batch/streaming APIs to match different usage patterns
"""

import asyncio
import logging
from datetime import UTC
from pathlib import Path
from typing import Any

import numpy as np

from ..core.config.settings import get_settings
from ..core.metrics import track_model_inference
from ..pipeline.dto import VadConfig
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
        # Single-flight guard so a lazy first-use load happens
        # exactly once even under concurrent callers.
        self._init_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def initialize(self) -> None:
        """Load the ONNX model lazily. Idempotent and concurrency-safe.

        The model is loaded on first use (not at process boot).
        The double-checked ``_init_lock`` ensures concurrent first-use
        callers load the ONNX session exactly once.
        """
        if self._loaded:
            return

        async with self._init_lock:
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
        # `is not None` (not `or`): an explicit 0 override is valid
        # (e.g. speech_pad_ms=0 for exact boundaries) and must not silently
        # fall back to settings.
        threshold = threshold if threshold is not None else settings.vad_threshold
        min_speech_ms = (
            min_speech_duration_ms
            if min_speech_duration_ms is not None
            else settings.vad_min_speech_duration_ms
        )
        min_silence_ms = (
            min_silence_duration_ms
            if min_silence_duration_ms is not None
            else settings.vad_min_silence_duration_ms
        )
        # TASK-880 — `stt.vad.speechPadMs` is deleted. Padding is an AGENT tuning
        # choice (`audioFrontEnd.vad.speechPadMs` -> `VadConfig.padding_ms`), which both
        # pipeline callers already pass explicitly; a caller that passes nothing gets the
        # dataclass default rather than a per-process setting.
        pad_ms = speech_pad_ms if speech_pad_ms is not None else VadConfig.padding_ms

        frame_size = _SILERO_FRAME_SIZE_16K if sample_rate == 16000 else _SILERO_FRAME_SIZE_8K
        audio_duration = len(samples) / sample_rate

        # Fresh LSTM state for batch
        state = np.zeros(_SILERO_STATE_SHAPE, dtype=np.float32)
        sr_array = np.array(sample_rate, dtype=np.int64)

        # Collect per-frame probabilities. Count this full-file VAD
        # pass as one silero-vad-v5 inference (running gauge + latency).
        probs: list[float] = []
        with track_model_inference("silero-vad-v5"):
            for offset in range(0, len(samples), frame_size):
                chunk = samples[offset : offset + frame_size]
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
            _SILERO_FRAME_SIZE_16K if session_state.sample_rate == 16000 else _SILERO_FRAME_SIZE_8K
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

        from datetime import datetime

        session_state.last_activity = datetime.now(UTC)

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
            # Silero VAD is a PLATFORM model with no tenant owner, so
            # its token resolves the SYSTEM tier. The repo is public, so `None`
            # (no tier has an opinion) is the normal, working case.
            from stt.diarization.embedding_service import _resolve_hf_token

            cached_path = hf_hub_download(
                repo_id="onnx-community/silero-vad",
                filename="onnx/model.onnx",
                cache_dir=settings.huggingface_cache_dir,
                token=_resolve_hf_token(settings),
            )
            return Path(cached_path)
        except ImportError:
            raise RuntimeError(
                "huggingface_hub is required to auto-download Silero VAD. "
                "Install it or set VAD_MODEL_PATH to a local file."
            ) from None

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
        neg_threshold: float | None = None,
    ) -> list[SpeechSegment]:
        """Convert per-frame probabilities into merged speech segments.

        Implements the same logic as Silero's ``get_speech_timestamps``:
        - A frame above *threshold* triggers speech onset.
        - Speech is HELD while the probability stays at or above
          *neg_threshold* (default ``threshold - 0.15``, floored at 0.01) —
          the upstream Silero hysteresis. Trailing unvoiced phones (/s/, /f/,
          /t/) hover between the two thresholds and were previously counted
          as silence, clipping word tails.
        - Speech ends after *min_silence_ms* of consecutive sub-neg-threshold
          frames.
        - Segments shorter than *min_speech_ms* are discarded.
        - *pad_ms* is added before segment start and after segment end.
        """
        if neg_threshold is None:
            neg_threshold = max(threshold - 0.15, 0.01)
        min_speech_frames = int(min_speech_ms * sample_rate / 1000 / frame_size)
        min_silence_frames = int(min_silence_ms * sample_rate / 1000 / frame_size)
        pad_samples = int(pad_ms * sample_rate / 1000)

        # Pass 1 — RAW frame boundaries (no padding). Silence-run semantics
        # follow upstream Silero: the run is anchored at the first sub-
        # neg_threshold frame and counts WALL-CLOCK frames from there; only a
        # frame >= threshold clears it. Mid-band frames (neg..threshold) hold
        # speech while no run is open, but do NOT clear an open run —
        # otherwise probabilities hovering around neg_threshold keep the
        # segment open forever.
        raw: list[tuple[int, int, float]] = []  # (start_frame, end_frame_excl, avg_prob)
        speech_start: int | None = None
        silence_count = 0
        speech_frame_count = 0

        def _close_segment(end_frame: int) -> None:
            nonlocal speech_start
            if speech_start is not None and speech_frame_count >= min_speech_frames:
                seg_probs = probs[speech_start:end_frame]
                avg_prob = sum(seg_probs) / len(seg_probs) if seg_probs else 0.0
                raw.append((speech_start, end_frame, avg_prob))
            speech_start = None

        for i, prob in enumerate(probs):
            if speech_start is None:
                if prob >= threshold:
                    speech_start = i
                    speech_frame_count = 1
                    silence_count = 0
                continue

            if prob >= threshold:
                silence_count = 0
                speech_frame_count += 1
            elif prob < neg_threshold or silence_count > 0:
                silence_count += 1
            else:
                # Mid-band with no open silence run — speech hold.
                speech_frame_count += 1

            if silence_count >= min_silence_frames:
                # End of speech at the start of the silence run.
                _close_segment(i - silence_count + 1)
                silence_count = 0

        # Handle trailing speech (segment still open at end of audio).
        if speech_start is not None:
            _close_segment(len(probs))

        # Pass 2 — apply padding with the upstream neighbor clamp: when two
        # raw segments are closer than 2*pad, split the raw gap at its
        # midpoint so padded segments never overlap (overlap duplicates audio
        # in the merged WAV and hands non-monotonic turns to diarization).
        segments: list[SpeechSegment] = []
        for idx, (s_frame, e_frame, avg_prob) in enumerate(raw):
            start_sample = max(0, s_frame * frame_size - pad_samples)
            end_sample = min(total_samples, e_frame * frame_size + pad_samples)
            if e_frame == len(probs):
                # Trailing segment historically extends to the end of audio.
                end_sample = total_samples
            if idx > 0:
                gap_mid = (raw[idx - 1][1] * frame_size + s_frame * frame_size) // 2
                start_sample = max(start_sample, gap_mid)
            if idx < len(raw) - 1:
                gap_mid = (e_frame * frame_size + raw[idx + 1][0] * frame_size) // 2
                end_sample = min(end_sample, gap_mid)
            segments.append(
                SpeechSegment(
                    start_time=start_sample / sample_rate,
                    end_time=end_sample / sample_rate,
                    probability=avg_prob,
                )
            )

        return segments

    @staticmethod
    def probs_to_segments(
        probs: list[float],
        frame_size: int,
        sample_rate: int,
        threshold: float,
        min_speech_ms: int,
        min_silence_ms: int,
        pad_ms: int,
        total_samples: int,
        neg_threshold: float | None = None,
    ) -> list[SpeechSegment]:
        """Public wrapper for converting VAD frame probabilities to segments."""
        return SileroVADService._probs_to_segments(
            probs=probs,
            frame_size=frame_size,
            sample_rate=sample_rate,
            threshold=threshold,
            min_speech_ms=min_speech_ms,
            min_silence_ms=min_silence_ms,
            pad_ms=pad_ms,
            total_samples=total_samples,
            neg_threshold=neg_threshold,
        )


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_service: SileroVADService | None = None


def get_vad_service(model_path: str | None = None) -> SileroVADService:
    """The process-wide Silero VAD service.

    TASK-880 — ``stt.vad.modelPath`` is deleted. The weights are an ``AiModel`` row
    (``VOICE_ACTIVITY_DETECTION``), and its ``localPath`` already travels on every
    session's ``ResolvedAsrSpec`` as ``models.vad.localPath``; the session manager passes
    it here. ``None`` (every batch/enrollment caller, and any session whose row stages no
    local copy) resolves the weights the way the platform key's own default did — auto,
    from the HuggingFace cache.

    The service is a SINGLETON because the ONNX session is stateless and shared; the
    first caller that supplies a path therefore decides it, and a later, different path
    is refused with a warning rather than silently ignored — two agents on genuinely
    different VAD weights need a per-path cache, not a quiet first-wins.
    """
    global _service
    if _service is None:
        _service = SileroVADService(model_path=model_path)
    elif model_path and _service._model_path and model_path != _service._model_path:
        logger.warning(
            "Ignoring a second Silero VAD model path (%s); the singleton is already "
            "loaded from %s",
            model_path,
            _service._model_path,
        )
    return _service
