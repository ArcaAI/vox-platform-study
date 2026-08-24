"""Speaker embedding extraction service.

Base class with shared extraction logic (threading, async dispatch, batch).
Subclasses only implement model loading and raw inference dispatch.

- ``PyannoteEmbeddingService``: see ``pyannote_embedding.py``
- ``SpeechBrainEmbeddingService``: see ``speechbrain_embedding.py``

Use ``create_embedding_service()`` to get the right implementation
based on the HuggingFace model ID prefix.
"""

import asyncio
import logging
import threading
from abc import ABC, abstractmethod
from typing import Any, cast

import numpy as np

from ..core.config.settings import get_settings
from ..core.exceptions import EmbeddingExtractionError
from .dto import SpeakerEmbedding

logger = logging.getLogger(__name__)


def _resolve_hf_token(settings: Any) -> str | None:
    """The HuggingFace token for a PLATFORM diarization model.

    TASK-799 — the token is no longer an environment variable. Speaker
    embedding/segmentation weights are platform infrastructure with no tenant
    owner, so they resolve the SYSTEM tier (``owner_tenant_of(None)``): a model
    every tenant shares is fetched with the PLATFORM's credential, never with
    the quota of whichever tenant's job happened to trigger the load first.

    Synchronous by necessity: this runs inside ``asyncio.to_thread`` under the
    model constructors, so there is no loop to await on. ``asyncio.run`` on a
    worker thread is safe here precisely because that thread has no running loop.

    Falls back to the local ``huggingface_hub`` cache when no tier has an
    opinion, unchanged — that is a machine-local artifact of a prior interactive
    login, not a platform credential, and it is what lets an offline developer
    box keep working.
    """
    del settings  # the token has not come from settings since TASK-799
    token: str | None = None
    try:
        from stt.core.model_credentials import resolve_hf_token as _resolve

        token = asyncio.run(_resolve(None))
    except Exception:
        # A control-plane fault must not take diarization down: a public
        # pyannote/speechbrain repo loads anonymously, and a GATED one fails
        # later with the hub's own explicit 401 rather than a config error here.
        logger.warning(
            "Could not resolve the platform HuggingFace token; continuing unauthenticated"
        )

    if not token:
        try:
            from huggingface_hub import get_token as hf_get_token

            token = hf_get_token()
        except Exception:
            pass
    return token


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


class EmbeddingService(ABC):
    """Base class for speaker embedding extraction.

    Handles threading, async dispatch, and batch extraction.
    Subclasses implement ``_load_model_sync`` and ``_run_inference_sync``.
    """

    def __init__(self, hf_model_id: str | None = None) -> None:
        self._hf_model_id = hf_model_id
        self._loaded = False
        self._lock = threading.Lock()
        # Single-flight guard so a lazy first-use load happens
        # exactly once even under concurrent extract callers.
        self._init_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def initialize(self) -> None:
        """Load embedding model lazily. Idempotent and concurrency-safe.

        The model is loaded on first use (not at process boot).
        The double-checked ``_init_lock`` ensures concurrent first-use
        callers load the model exactly once.
        """
        if self._loaded:
            return
        async with self._init_lock:
            if self._loaded:
                return
            await asyncio.to_thread(self._do_load)

    def _do_load(self) -> None:
        if self._loaded:
            return
        settings = get_settings()
        model_id = self._hf_model_id or settings.diarization_hf_model_id
        self._load_model_sync(model_id, settings)
        self._loaded = True

    @abstractmethod
    def _load_model_sync(self, model_id: str, settings: Any) -> None:
        """Load the model. Called once from a worker thread."""
        ...

    @abstractmethod
    def _run_inference_sync(self, waveform: Any, sample_rate: int) -> Any:
        """Run inference on a single waveform tensor ``(1, N)``.

        Must be called under ``self._lock``. Return value is flattened
        to a 1-D embedding by the caller.
        """
        ...

    async def shutdown(self) -> None:
        """Release model resources."""
        self._loaded = False

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
        """Extract embedding from numpy audio samples."""
        # Lazy load on first use instead of eager boot init.
        await self.initialize()

        if end_time is None:
            end_time = len(samples) / sample_rate

        embedding = await asyncio.to_thread(self._extract_sync, samples, sample_rate)

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
        """Extract embeddings for multiple audio segments."""
        embeddings: list[SpeakerEmbedding] = []
        for start, end in segments:
            start_sample = int(start * sample_rate)
            end_sample = int(end * sample_rate)
            segment_samples = samples[start_sample:end_sample]

            if len(segment_samples) < sample_rate:
                continue

            emb = await self.extract_from_samples(segment_samples, sample_rate, start, end)
            embeddings.append(emb)

        return embeddings

    async def extract_batch(
        self,
        segment_samples: list[np.ndarray],
        sample_rate: int,
        segment_times: list[tuple[float, float]],
    ) -> list[SpeakerEmbedding | None]:
        """Extract embeddings for multiple segments in a single thread dispatch."""
        # Lazy load on first use instead of eager boot init.
        await self.initialize()

        raw = await asyncio.to_thread(self._extract_batch_sync, segment_samples, sample_rate)

        results: list[SpeakerEmbedding | None] = []
        for emb, (start, end) in zip(raw, segment_times, strict=False):
            if emb is not None:
                results.append(
                    SpeakerEmbedding(embedding=emb, segment_start=start, segment_end=end)
                )
            else:
                results.append(None)
        return results

    # ------------------------------------------------------------------
    # Synchronous helpers
    # ------------------------------------------------------------------

    def _extract_sync(self, samples: np.ndarray, sample_rate: int) -> list[float]:
        import torch

        with self._lock:
            try:
                waveform = torch.from_numpy(samples).float().unsqueeze(0)
                embedding = self._run_inference_sync(waveform, sample_rate)
                if hasattr(embedding, "tolist"):
                    return cast(list[float], embedding.flatten().tolist())
                return list(embedding.flatten())
            except Exception as e:
                raise EmbeddingExtractionError(f"Embedding extraction failed: {e}") from e

    def _extract_batch_sync(
        self,
        segment_samples: list[np.ndarray],
        sample_rate: int,
    ) -> list[list[float] | None]:
        import torch

        with self._lock:
            results: list[list[float] | None] = []
            for samples in segment_samples:
                try:
                    waveform = torch.from_numpy(samples).float().unsqueeze(0)
                    embedding = self._run_inference_sync(waveform, sample_rate)
                    if hasattr(embedding, "tolist"):
                        results.append(embedding.flatten().tolist())
                    else:
                        results.append(list(embedding.flatten()))
                except Exception as e:
                    logger.warning("Embedding extraction failed for segment: %s", e)
                    results.append(None)
            return results


# ---------------------------------------------------------------------------
# Factory + singleton
# ---------------------------------------------------------------------------

_SPEECHBRAIN_PREFIXES = ("speechbrain/",)


def create_embedding_service(
    hf_model_id: str | None = None,
) -> EmbeddingService:
    """Create the right EmbeddingService based on model ID prefix.

    - ``speechbrain/*`` -> ``SpeechBrainEmbeddingService``
    - anything else -> ``PyannoteEmbeddingService``
    """
    if hf_model_id and hf_model_id.startswith("speechbrain/"):
        from .speechbrain_embedding import SpeechBrainEmbeddingService

        return SpeechBrainEmbeddingService(hf_model_id=hf_model_id)
    else:
        from .pyannote_embedding import PyannoteEmbeddingService

        return PyannoteEmbeddingService(hf_model_id=hf_model_id)


_service: EmbeddingService | None = None


def get_embedding_service() -> EmbeddingService:
    """Get singleton embedding service (uses settings-based model)."""
    global _service
    if _service is None:
        settings = get_settings()
        _service = create_embedding_service(hf_model_id=settings.diarization_hf_model_id)
    return _service
