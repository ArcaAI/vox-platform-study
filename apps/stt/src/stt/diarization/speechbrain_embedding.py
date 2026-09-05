"""SpeechBrain speaker embedding extraction.

Works with: ``speechbrain/spkrec-ecapa-voxceleb`` and similar
SpeechBrain ``EncoderClassifier`` models.
"""

import logging
import os
from typing import Any

from ..core.exceptions import EmbeddingExtractionError
from .embedding_service import EmbeddingService, _resolve_device, _resolve_hf_token

logger = logging.getLogger(__name__)


class SpeechBrainEmbeddingService(EmbeddingService):
    """Speaker embeddings via SpeechBrain EncoderClassifier."""

    def __init__(self, hf_model_id: str) -> None:
        super().__init__(hf_model_id)
        self._classifier: Any = None

    def _load_model_sync(self, model_id: str, settings: Any) -> None:
        try:
            from speechbrain.inference.speaker import (
                EncoderClassifier,
            )
            from speechbrain.utils.fetching import FetchConfig

            device = _resolve_device(settings.diarization_device)
            token = _resolve_hf_token(settings)

            # SpeechBrain only supports cpu/cuda in from_hparams.
            # MPS is not supported -- fall back to cpu.
            sb_device = device if device in ("cpu",) or device.startswith("cuda") else "cpu"

            fetch_config = FetchConfig(token=token) if token else FetchConfig()
            from_hparams_kwargs: dict[str, Any] = {
                "source": model_id,
                "run_opts": {"device": sb_device},
                "fetch_config": fetch_config,
            }
            # TASK-860: a LOCAL source (the published bucket prefix the registry
            # row's `localPath` derives to) is used IN PLACE. Without `savedir`
            # SpeechBrain still "fetches" each hparams/checkpoint file into
            # `pretrained_models/<hash>/` — a copy/symlink step that fails on a
            # read-only mount and trips the 1.0.x offline-fetch defect
            # (speechbrain#2817). Pointing `savedir` at the source directory
            # makes the fetch a no-op: nothing is copied, nothing is downloaded.
            if os.path.isdir(model_id):
                from_hparams_kwargs["savedir"] = model_id
            self._classifier = EncoderClassifier.from_hparams(**from_hparams_kwargs)

            logger.info("SpeechBrain embedding model loaded: %s (device=%s)", model_id, sb_device)

        except ImportError as e:
            raise EmbeddingExtractionError(
                f"speechbrain is required. pip install speechbrain. Error: {e}"
            ) from e

    def _run_inference_sync(self, waveform: Any, sample_rate: int) -> Any:
        # EncoderClassifier.encode_batch -> (batch, 1, embed_dim)
        return self._classifier.encode_batch(waveform).squeeze()

    async def shutdown(self) -> None:
        self._classifier = None
        self._loaded = False
