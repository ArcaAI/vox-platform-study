from __future__ import annotations

import logging
from typing import Any

import numpy as np

from ..pipeline.dto import AiModelFormat
from .base_loader import LoadedModel

logger = logging.getLogger(__name__)


class NemoAsrAdapter:
    """Synchronous, thread-safe callable wrapping a NeMo ASR model."""

    def __init__(self, loaded_model: LoadedModel, inference_config: Any) -> None:
        if loaded_model.format != AiModelFormat.NEMO:
            raise ValueError(
                f"NemoAsrAdapter requires a NEMO LoadedModel, got " f"{loaded_model.format}"
            )
        self._loaded = loaded_model
        self._inference_config = inference_config
        extra = loaded_model.extra or {}
        self._target_lang: str | None = extra.get("target_lang")
        self._supports_word_ts: bool = bool(extra.get("supports_word_timestamps", True))

    def __call__(
        self,
        samples: np.ndarray,
        sample_rate: int,  # noqa: ARG002 (NeMo handles resampling internally)
        *,
        prompt: str | None = None,
    ) -> dict[str, Any]:
        if prompt:
            logger.debug(
                "NemoAsrAdapter: ignoring unsupported prompt for model %s",
                self._loaded.model_slug,
            )

        audio = np.asarray(samples, dtype=np.float32)

        try:
            hypotheses = self._loaded.model.transcribe(
                audio=[audio],
                batch_size=1,
                timestamps=True,
                return_hypotheses=True,
                verbose=False,
            )
        except TypeError:
            # Older NeMo signatures may not accept all kwargs; retry minimal.
            hypotheses = self._loaded.model.transcribe(
                audio=[audio],
                return_hypotheses=True,
            )

        if not hypotheses:
            return {
                "text": "",
                "language": self._target_lang,
                "word_timestamps": [],
                "segments": [],
            }

        hyp = hypotheses[0]
        text = (getattr(hyp, "text", "") or "").strip()
        timestamp = getattr(hyp, "timestamp", None) or {}
        language = getattr(hyp, "language", None) or self._target_lang

        word_timestamps: list[dict[str, Any]] = []
        if self._supports_word_ts:
            for w in timestamp.get("word", []) or []:
                word = w.get("word") or w.get("text") or ""
                if not word:
                    continue
                word_timestamps.append(
                    {
                        "word": word,
                        "start": float(w.get("start", 0.0) or 0.0),
                        "end": float(w.get("end", 0.0) or 0.0),
                        "confidence": float(w.get("confidence", 1.0) or 1.0),
                    }
                )

        segments: list[dict[str, Any]] = []
        for s in timestamp.get("segment", []) or []:
            seg_text = s.get("segment") or s.get("text") or ""
            segments.append(
                {
                    "text": seg_text,
                    "start": float(s.get("start", 0.0) or 0.0),
                    "end": float(s.get("end", 0.0) or 0.0),
                }
            )

        return {
            "text": text,
            "language": language,
            "word_timestamps": word_timestamps,
            "segments": segments,
        }
