"""whisper.cpp per-utterance streaming adapter.

Wraps a loaded ``pywhispercpp.model.Model`` behind the streaming ASR callable
contract ``(samples, sample_rate, *, prompt) -> {text, language,
word_timestamps, segments}`` (see ``parakeet_cpp_asr.py``/``faster_whisper_asr.py``).
Per-utterance re-run, matching the parakeet.cpp integration style — whisper.cpp
has no native incremental-streaming API either.

``pywhispercpp``'s public ``Model.transcribe()`` only returns SEGMENT-level
``Segment(t0, t1, text, probability)`` objects — no per-word breakdown. Real
word-level timestamps are obtained with the well-known whisper.cpp technique
of forcing near-word-sized segments (``token_timestamps=True,
split_on_word=True, max_len=1``), so this adapter gets true (not
approximated) per-word timing from a SINGLE inference pass, then reconstructs
a single whole-utterance ``segments`` entry — the same "one coarse span"
simplification ``ParakeetCppAsrAdapter`` uses for an engine without native
sentence-level segmentation.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import structlog

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat

logger = structlog.get_logger(__name__)


class WhisperCppAsrAdapter:
    """Synchronous callable wrapping a loaded whisper.cpp (pywhispercpp) model."""

    def __init__(
        self,
        loaded_model: LoadedModel,
        inference_config: Any,
    ) -> None:
        if loaded_model.format != AiModelFormat.WHISPER_CPP:
            raise ValueError(
                "WhisperCppAsrAdapter requires a WHISPER_CPP LoadedModel, "
                f"got {loaded_model.format}"
            )
        self._loaded = loaded_model
        self._model = loaded_model.model
        lang = getattr(inference_config, "language", None)
        self._language: str | None = lang.split("-")[0].lower() if lang else None

    def __call__(
        self,
        samples: np.ndarray,
        sample_rate: int,
        *,
        prompt: str | None = None,
    ) -> dict[str, Any]:
        audio = np.asarray(samples, dtype=np.float32)

        segments = self._model.transcribe(
            audio,
            extract_probability=True,
            token_timestamps=True,
            split_on_word=True,
            max_len=1,
            **({"language": self._language} if self._language else {}),
            **({"initial_prompt": prompt} if prompt else {}),
        )

        word_timestamps: list[dict[str, Any]] = []
        for seg in segments:
            word = str(seg.text or "").strip()
            if not word:
                continue
            probability = seg.probability
            confidence = 1.0 if probability is None or math.isnan(probability) else float(probability)
            word_timestamps.append(
                {
                    "word": word,
                    # pywhispercpp t0/t1 are whisper.cpp's raw 10ms units.
                    "start": seg.t0 / 100.0,
                    "end": seg.t1 / 100.0,
                    "confidence": confidence,
                }
            )

        text = " ".join(w["word"] for w in word_timestamps)
        duration = len(audio) / float(sample_rate) if sample_rate else 0.0
        start = word_timestamps[0]["start"] if word_timestamps else 0.0
        end = word_timestamps[-1]["end"] if word_timestamps else duration

        return {
            "text": text,
            "language": self._language,
            "word_timestamps": word_timestamps,
            "segments": (
                [{"text": text, "start": start, "end": end}] if text else []
            ),
        }
