"""Pyannote speaker embedding extraction.

Works with: ``pyannote/embedding``, ``pyannote/wespeaker-*``.
"""

import logging
import warnings
from typing import Any

from ..core.exceptions import EmbeddingExtractionError
from .embedding_service import EmbeddingService, _resolve_device, _resolve_hf_token

logger = logging.getLogger(__name__)


class PyannoteEmbeddingService(EmbeddingService):
    """Speaker embeddings via pyannote Inference."""

    def __init__(self, hf_model_id: str | None = None) -> None:
        super().__init__(hf_model_id)
        self._inference: Any = None

    def _load_model_sync(self, model_id: str, settings: Any) -> None:
        try:
            with warnings.catch_warnings():
                warnings.filterwarnings(
                    "ignore",
                    message=r"(?s).*torchcodec is not installed correctly.*",
                    category=UserWarning,
                )
                from pyannote.audio import Inference, Model

            token = _resolve_hf_token(settings)
            model = Model.from_pretrained(model_id, use_auth_token=token)
            if model is None:
                raise EmbeddingExtractionError(
                    f"Failed to load pyannote model (returned None): {model_id}"
                )
            self._inference = Inference(model, window="whole")

            device = _resolve_device(settings.diarization_device)
            if device != "cpu":
                import torch

                self._inference.to(torch.device(device))

            logger.info("Pyannote embedding model loaded: %s (device=%s)", model_id, device)

        except ImportError as e:
            raise EmbeddingExtractionError(
                f"pyannote.audio is required. pip install pyannote.audio. Error: {e}"
            ) from e

    def _run_inference_sync(self, waveform: Any, sample_rate: int) -> Any:
        return self._inference({"waveform": waveform, "sample_rate": sample_rate})

    async def shutdown(self) -> None:
        self._inference = None
        self._loaded = False
