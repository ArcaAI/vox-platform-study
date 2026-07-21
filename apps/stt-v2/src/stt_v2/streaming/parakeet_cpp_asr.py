"""parakeet.cpp per-utterance streaming adapter.

Wraps a loaded parakeet.cpp handle behind the streaming ASR callable contract
``(samples, sample_rate, *, prompt) -> {text, language, word_timestamps,
segments}`` (see ``faster_whisper_asr.py``). This is the MINIMAL per-utterance
integration: the model family (cache-aware FastConformer-RNNT,
nemotron-3.5-asr-streaming) also supports true stateful incremental streaming,
which does NOT fit the current per-utterance contract — that native mode is a
future integration (per-utterance first, stateful later).

The binding is duck-typed: any object exposing ``transcribe(samples,
sample_rate, num_threads=...) -> {text, words?[{word,start,end,confidence?}],
language?}`` works (a vendored Python binding, or a thin cffi shim over
``libparakeet``). Raw ctypes handles (dict with ``library``) are rejected with
a clear error — driving the C API directly needs the shim.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import structlog

from stt_v2.models.base_loader import LoadedModel
from stt_v2.pipeline.dto import AiModelFormat

logger = structlog.get_logger(__name__)


class ParakeetCppAsrAdapter:
    """Synchronous callable wrapping a loaded parakeet.cpp model."""

    def __init__(
        self,
        loaded_model: LoadedModel,
        inference_config: Any,
    ) -> None:
        if loaded_model.format != AiModelFormat.PARAKEET_CPP:
            raise ValueError(
                "ParakeetCppAsrAdapter requires a PARAKEET_CPP LoadedModel, "
                f"got {loaded_model.format}"
            )
        handle = loaded_model.model
        if isinstance(handle, dict) and "library" in handle:
            raise RuntimeError(
                "parakeet.cpp raw ctypes handle cannot be driven directly — "
                "install a Python binding exposing transcribe() (see "
                "models/parakeet_cpp_loader.py)."
            )
        self._loaded = loaded_model
        self._handle = handle
        self._num_threads = int(
            (loaded_model.extra or {}).get("num_threads", 4) or 4
        )
        lang = getattr(inference_config, "language", None)
        self._language: str | None = lang.split("-")[0].lower() if lang else None

    def __call__(
        self,
        samples: np.ndarray,
        sample_rate: int,
        *,
        prompt: str | None = None,  # noqa: ARG002 — no text conditioning (RNNT)
    ) -> dict[str, Any]:
        audio = np.asarray(samples, dtype=np.float32)

        result = self._handle.transcribe(
            audio,
            sample_rate,
            num_threads=self._num_threads,
            **({"language": self._language} if self._language else {}),
        )

        text = str(result.get("text", "") or "").strip()
        word_timestamps: list[dict[str, Any]] = []
        for w in result.get("words") or []:
            try:
                word_timestamps.append(
                    {
                        "word": str(w.get("word", "") or "").strip(),
                        "start": float(w.get("start", 0.0) or 0.0),
                        "end": float(w.get("end", 0.0) or 0.0),
                        "confidence": float(w.get("confidence", 1.0) or 1.0),
                    }
                )
            except Exception:
                logger.warning(
                    "Skipping malformed parakeet.cpp word entry",
                    model_slug=self._loaded.model_slug,
                )

        duration = len(audio) / float(sample_rate) if sample_rate else 0.0
        return {
            "text": text,
            "language": result.get("language") or self._language,
            "word_timestamps": word_timestamps,
            "segments": (
                [{"text": text, "start": 0.0, "end": duration}] if text else []
            ),
        }
