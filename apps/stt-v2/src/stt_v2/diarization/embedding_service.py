"""Pyannote speaker embedding extraction service.

Extracts 512-dimensional speaker embeddings using ``pyannote/embedding``.
The model is loaded once per worker process and cached.

Design decisions:
- GPU when available for real-time performance
- Thread-safe via lock (pyannote Inference is not thread-safe)
- Supports both full-file and segment-based extraction
- In-memory tensor input (no temp file I/O) for maximum throughput
- Model loaded lazily on first use
- Accepts optional ``hf_model_id`` for pipeline-defined model override
"""

import asyncio
import logging
import threading
from typing import Any
import warnings

import numpy as np

from ..core.config.settings import get_settings
from ..core.exceptions import EmbeddingExtractionError
from .dto import SpeakerEmbedding

logger = logging.getLogger(__name__)


class EmbeddingService:
    """Extract speaker embeddings using pyannote/embedding.

    Thread-safe: uses a lock to serialise access to the pyannote Inference
    object which maintains internal state.

    Args:
        hf_model_id: Optional HuggingFace model ID override.  When set,
            this takes precedence over the ``diarization_hf_model_id``
            setting, allowing pipeline YAML to select a specific
            embedding model.
    """

    def __init__(self, hf_model_id: str | None = None) -> None:
        self._model: Any = None  # pyannote.audio.Model
        self._inference: Any = None  # pyannote.audio.Inference
        self._loaded = False
        self._lock = threading.Lock()
        self._hf_model_id = hf_model_id  # Pipeline override

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def initialize(self) -> None:
        """Load pyannote embedding model. Safe to call multiple times."""
        if self._loaded:
            return

        # Model loading is CPU-intensive — run in thread
        await asyncio.to_thread(self._load_model)

    def _load_model(self) -> None:
        """Synchronous model loading (called via asyncio.to_thread)."""
        if self._loaded:
            return

        try:
            Inference, Model = self._import_pyannote_audio()

            settings = get_settings()

            # Pipeline-defined model takes precedence over settings default
            model_id = self._hf_model_id or settings.diarization_hf_model_id

            token = settings.huggingface_token
            if not token:
                try:
                    from huggingface_hub import get_token as hf_get_token
                    token = hf_get_token()
                except Exception:
                    pass

            self._model = Model.from_pretrained(
                model_id,
                use_auth_token=token,
            )

            self._inference = Inference(self._model, window="whole")

            # Move to GPU if available and configured
            device = self._resolve_device(settings.diarization_device)
            if device != "cpu":
                import torch

                self._inference.to(torch.device(device))

            self._loaded = True
            logger.info(
                "Pyannote embedding model loaded: %s (device=%s)",
                model_id,
                device,
            )

        except ImportError as e:
            raise EmbeddingExtractionError(
                f"pyannote.audio is required for diarization. Install with: "
                f"pip install pyannote.audio. Error: {e}"
            ) from e
        except Exception as e:
            raise EmbeddingExtractionError(
                f"Failed to load pyannote embedding model: {e}"
            ) from e

    @staticmethod
    def _import_pyannote_audio() -> tuple[Any, Any]:
        """Import pyannote audio classes while suppressing known non-fatal warning."""
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore",
                message=(
                    r"(?s).*torchcodec is not installed correctly so built-in audio decoding will fail.*"
                ),
                category=UserWarning,
            )
            from pyannote.audio import Inference, Model

        return Inference, Model

    async def shutdown(self) -> None:
        """Release model resources."""
        self._model = None
        self._inference = None
        self._loaded = False
        logger.info("Pyannote embedding service shut down")

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    # ------------------------------------------------------------------
    # Extraction API
    # ------------------------------------------------------------------

    async def extract_from_samples(
        self,
        samples: np.ndarray,
        sample_rate: int = 16000,
        start_time: float = 0.0,
        end_time: float | None = None,
    ) -> SpeakerEmbedding:
        """Extract embedding from numpy audio samples.

        Uses in-memory torch tensors passed directly to pyannote
        Inference (no temp file I/O).

        Args:
            samples: Float32 mono audio.
            sample_rate: Sample rate.
            start_time: Segment start time for metadata.
            end_time: Segment end time for metadata.

        Returns:
            SpeakerEmbedding with 512-dim vector.
        """
        if not self._loaded:
            raise EmbeddingExtractionError(
                "EmbeddingService not initialised — call initialize() first"
            )

        if end_time is None:
            end_time = len(samples) / sample_rate

        # Write to temp WAV and run inference in a thread
        embedding = await asyncio.to_thread(
            self._extract_sync, samples, sample_rate
        )

        return SpeakerEmbedding(
            embedding=embedding,
            segment_start=start_time,
            segment_end=end_time,
        )

    async def extract_from_segments(
        self,
        samples: np.ndarray,
        sample_rate: int,
        segments: list[tuple[float, float]],
    ) -> list[SpeakerEmbedding]:
        """Extract embeddings for multiple audio segments.

        Args:
            samples: Full audio as float32 numpy array.
            sample_rate: Sample rate.
            segments: List of (start_time, end_time) tuples in seconds.

        Returns:
            List of SpeakerEmbedding, one per segment.
        """
        embeddings: list[SpeakerEmbedding] = []
        for start, end in segments:
            start_sample = int(start * sample_rate)
            end_sample = int(end * sample_rate)
            segment_samples = samples[start_sample:end_sample]

            if len(segment_samples) < sample_rate:  # Skip segments < 1 second
                continue

            emb = await self.extract_from_samples(
                segment_samples, sample_rate, start, end
            )
            embeddings.append(emb)

        return embeddings

    # ------------------------------------------------------------------
    # Batch extraction API
    # ------------------------------------------------------------------

    async def extract_batch(
        self,
        segment_samples: list[np.ndarray],
        sample_rate: int,
        segment_times: list[tuple[float, float]],
    ) -> list[SpeakerEmbedding | None]:
        """Extract embeddings for multiple segments in a single thread dispatch.

        Acquires the inference lock once for the entire batch, avoiding
        per-segment thread dispatch and lock contention overhead.

        Args:
            segment_samples: List of float32 mono audio arrays.
            sample_rate: Sample rate (same for all segments).
            segment_times: List of (start_time, end_time) for metadata.

        Returns:
            List of SpeakerEmbedding (or None for failed segments).
        """
        if not self._loaded:
            raise EmbeddingExtractionError(
                "EmbeddingService not initialised — call initialize() first"
            )

        raw = await asyncio.to_thread(
            self._extract_batch_sync, segment_samples, sample_rate
        )

        results: list[SpeakerEmbedding | None] = []
        for emb, (start, end) in zip(raw, segment_times):
            if emb is not None:
                results.append(
                    SpeakerEmbedding(embedding=emb, segment_start=start, segment_end=end)
                )
            else:
                results.append(None)
        return results

    # ------------------------------------------------------------------
    # Synchronous helpers (called via asyncio.to_thread)
    # ------------------------------------------------------------------

    def _extract_batch_sync(
        self,
        segment_samples: list[np.ndarray],
        sample_rate: int,
    ) -> list[list[float] | None]:
        """Extract embeddings for multiple segments under a single lock."""
        import torch

        with self._lock:
            results: list[list[float] | None] = []
            for samples in segment_samples:
                try:
                    waveform = torch.from_numpy(samples).float().unsqueeze(0)
                    input_dict = {"waveform": waveform, "sample_rate": sample_rate}
                    embedding = self._inference(input_dict)
                    if hasattr(embedding, "tolist"):
                        results.append(embedding.flatten().tolist())
                    else:
                        results.append(list(embedding.flatten()))
                except Exception as e:
                    logger.warning("Embedding extraction failed for segment: %s", e)
                    results.append(None)
            return results

    def _extract_sync(
        self,
        samples: np.ndarray,
        sample_rate: int,
    ) -> list[float]:
        """Synchronous embedding extraction (thread-safe via lock).

        Uses in-memory torch tensors — pyannote Inference accepts a dict
        with ``waveform`` (shape ``(1, num_samples)``) and ``sample_rate``.
        This eliminates all temp-file I/O.
        """
        import torch

        with self._lock:
            try:
                waveform = torch.from_numpy(samples).float().unsqueeze(0)  # (1, N)
                input_dict = {"waveform": waveform, "sample_rate": sample_rate}

                embedding = self._inference(input_dict)  # shape: (512,) or (1, 512)

                if hasattr(embedding, "tolist"):
                    return embedding.flatten().tolist()
                return list(embedding.flatten())

            except Exception as e:
                raise EmbeddingExtractionError(
                    f"Embedding extraction failed: {e}"
                ) from e

    # ------------------------------------------------------------------
    # Device resolution
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_device(requested: str) -> str:
        """Resolve device string, checking availability."""
        if requested == "auto":
            try:
                import torch

                if torch.cuda.is_available():
                    return "cuda"
                elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                    return "mps"
                return "cpu"
            except ImportError:
                return "cpu"
        return requested


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_service: EmbeddingService | None = None


def get_embedding_service() -> EmbeddingService:
    """Get singleton embedding service."""
    global _service
    if _service is None:
        _service = EmbeddingService()
    return _service
