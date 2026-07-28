"""faster-whisper (CTranslate2) streaming ASR engine adapter.

Exposes the same ASR-callable contract as the other streaming engines
(``(samples, sample_rate, *, prompt) -> {text, language, word_timestamps,
segments}``) on top of ``faster_whisper.WhisperModel`` +
``BatchedInferencePipeline``.

The ``faster_whisper`` package is imported LAZILY (by
:class:`stt.models.faster_whisper_loader.FasterWhisperLoader`), so this
module imports — and all unit tests pass — without the package installed.

CT2 model conversion runbook
----------------------------
``hf_model_id`` for ``engine: faster_whisper`` must point to a
CTranslate2-converted model directory or HuggingFace repo (e.g. the official
``Systran/faster-whisper-large-v3``). To convert a fine-tuned Transformers
Whisper checkpoint yourself::

    pip install ctranslate2 transformers[torch]

    ct2-transformers-converter \\
        --model openai/whisper-large-v3 \\
        --output_dir whisper-large-v3-ct2 \\
        --copy_files tokenizer.json preprocessor_config.json \\
        --quantization float16

Quantization choice:

- ``float16``  — GPU (CUDA) deployments. Best accuracy/speed trade-off on
  Ampere+; matches ``ExecutionProfile.asr_compute_type`` defaults.
- ``int8_float16`` — GPU when VRAM-constrained (weights int8, compute fp16).
- ``int8``     — CPU deployments. ~2x faster than float32 with negligible
  WER impact; the loader auto-coerces fp16 requests to a CPU-safe type.

A model converted WITH ``--quantization float16`` can still be loaded with
``compute_type: int8`` (CT2 re-quantizes at load), so converting once with
``float16`` is the recommended default. Upload the output directory to your
model registry / HF org and reference it via ``hf_model_id``.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import structlog

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat

logger = structlog.get_logger(__name__)

_TARGET_SAMPLE_RATE = 16000

# Compute types CTranslate2 accepts, per device family. "auto"/"default"
# delegate selection to CT2 itself.
_CT2_COMPUTE_TYPES: set[str] = {
    "auto",
    "default",
    "int8",
    "int8_float16",
    "int8_bfloat16",
    "int8_float32",
    "int16",
    "float16",
    "bfloat16",
    "float32",
}

# fp16-family types are unsupported on CPU; coerce to a CPU-safe equivalent.
_CPU_COMPUTE_COERCIONS: dict[str, str] = {
    "float16": "float32",
    "bfloat16": "float32",
    "int8_float16": "int8",
    "int8_bfloat16": "int8",
}


def resolve_ct2_device(device: str) -> tuple[str, int]:
    """Map a torch-style device string to CTranslate2 ``(device, index)``.

    CTranslate2 supports only ``cpu`` and ``cuda``; MPS (Apple Silicon)
    falls back to CPU.
    """
    dev = (device or "cpu").lower()
    if dev.startswith("cuda"):
        index = 0
        if ":" in dev:
            try:
                index = int(dev.split(":", 1)[1])
            except ValueError:
                index = 0
        return "cuda", index
    if dev == "mps":
        logger.info(
            "CTranslate2 has no MPS backend — faster-whisper will run on CPU",
        )
        return "cpu", 0
    return "cpu", 0


def resolve_ct2_compute_type(compute_type: str | None, device: str) -> str:
    """Validate and coerce *compute_type* for the target CT2 *device*.

    ``None``/empty resolves to ``"auto"``. Unsupported values raise
    ``ValueError``; fp16-family values on CPU are coerced to safe types.
    """
    requested = (compute_type or "auto").lower()
    if requested not in _CT2_COMPUTE_TYPES:
        raise ValueError(
            f"Unsupported CTranslate2 compute_type '{compute_type}'. "
            f"Valid values: {', '.join(sorted(_CT2_COMPUTE_TYPES))}"
        )
    if device == "cpu" and requested in _CPU_COMPUTE_COERCIONS:
        coerced = _CPU_COMPUTE_COERCIONS[requested]
        logger.warning(
            "CT2 compute_type %s is not supported on CPU — using %s",
            requested,
            coerced,
        )
        return coerced
    return requested


def _resample_to_16k(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """Linear-resample *samples* to 16 kHz (faster-whisper's expected rate)."""
    if sample_rate == _TARGET_SAMPLE_RATE or len(samples) == 0:
        return samples
    duration_s = len(samples) / float(sample_rate)
    target_len = max(1, int(round(duration_s * _TARGET_SAMPLE_RATE)))
    src_t = np.linspace(0.0, duration_s, num=len(samples), endpoint=False)
    dst_t = np.linspace(0.0, duration_s, num=target_len, endpoint=False)
    resampled = np.interp(dst_t, src_t, samples)
    return np.asarray(resampled, dtype=np.float32)


class FasterWhisperAsrAdapter:
    """Synchronous callable wrapping a loaded faster-whisper model.

    Built once per streaming session by
    ``SessionManager._make_asr_callable`` and invoked from a worker thread
    (``asyncio.to_thread``) per utterance.

    Parameters
    ----------
    loaded_model:
        ``LoadedModel`` with ``format == FASTER_WHISPER``. ``model`` is the
        ``WhisperModel``; ``extra["batched_pipeline"]`` optionally carries a
        ``BatchedInferencePipeline`` (preferred when present).
    inference_config:
        Pipeline ``InferenceConfig``. Language semantics: a
        configured ``language`` is always pinned (even with code_switching
        enabled); ``language: null`` → auto-LID. BCP-47 tags are normalized
        to the primary subtag.
    batch_size:
        Per-call batch size for the batched pipeline (from
        ``ExecutionProfile.asr_max_batch_size``). ``None`` uses the
        library default.
    """

    def __init__(
        self,
        loaded_model: LoadedModel,
        inference_config: Any,
        batch_size: int | None = None,
        task: str = "transcribe",
    ) -> None:
        if loaded_model.format != AiModelFormat.FASTER_WHISPER:
            raise ValueError(
                "FasterWhisperAsrAdapter requires a FASTER_WHISPER "
                f"LoadedModel, got {loaded_model.format}"
            )
        # "translate" builds the English-gloss variant.
        self._task = task
        self._loaded = loaded_model
        self._model = loaded_model.model
        extra = loaded_model.extra or {}
        self._batched = extra.get("batched_pipeline")
        self._batch_size = (
            batch_size
            if isinstance(batch_size, int) and not isinstance(batch_size, bool) and batch_size > 0
            else None
        )

        # A configured language is always pinned (passed to
        # the engine), including when code_switching is enabled. language:
        # null keeps auto-LID.
        lang = getattr(inference_config, "language", None)
        if lang:
            # Pin the configured language; normalize "ml-IN" → "ml".
            self._language: str | None = lang.split("-")[0].lower()
        else:
            # Auto language identification.
            self._language = None

        self._decode_kwargs = self._build_decode_kwargs(inference_config)

    @staticmethod
    def _build_decode_kwargs(inference_config: Any) -> dict[str, Any]:
        """Translate InferenceConfig decode params to faster-whisper kwargs."""
        kwargs: dict[str, Any] = {}

        beam_size = getattr(inference_config, "beam_size", None)
        if isinstance(beam_size, int) and beam_size >= 1:
            kwargs["beam_size"] = beam_size

        temperature = getattr(inference_config, "temperature", None)
        if isinstance(temperature, (int, float)) and not isinstance(temperature, bool):
            kwargs["temperature"] = float(temperature)
        elif isinstance(temperature, (list, tuple)) and len(temperature) > 0:
            kwargs["temperature"] = [float(t) for t in temperature]

        crt = getattr(inference_config, "compression_ratio_threshold", None)
        if isinstance(crt, (int, float)) and not isinstance(crt, bool):
            kwargs["compression_ratio_threshold"] = float(crt)

        # faster-whisper names this log_prob_threshold
        lpt = getattr(inference_config, "logprob_threshold", None)
        if isinstance(lpt, (int, float)) and not isinstance(lpt, bool):
            kwargs["log_prob_threshold"] = float(lpt)

        nst = getattr(inference_config, "no_speech_threshold", None)
        if isinstance(nst, (int, float)) and not isinstance(nst, bool):
            kwargs["no_speech_threshold"] = float(nst)

        condition = getattr(inference_config, "condition_on_prev_tokens", False)
        kwargs["condition_on_previous_text"] = bool(condition)

        return kwargs

    def __call__(
        self,
        samples: np.ndarray,
        sample_rate: int,
        *,
        prompt: str | None = None,
    ) -> dict[str, Any]:
        audio = np.asarray(samples, dtype=np.float32)
        audio = _resample_to_16k(audio, sample_rate)

        kwargs: dict[str, Any] = {
            "task": self._task,
            "language": self._language,
            "word_timestamps": True,
            # VAD already ran in the streaming preprocessor.
            "vad_filter": False,
            **self._decode_kwargs,
        }
        if prompt:
            kwargs["initial_prompt"] = prompt

        if self._batched is not None:
            if self._batch_size is not None:
                kwargs["batch_size"] = self._batch_size
            segments, info = self._batched.transcribe(audio, **kwargs)
        else:
            segments, info = self._model.transcribe(audio, **kwargs)

        texts: list[str] = []
        word_timestamps: list[dict[str, Any]] = []
        out_segments: list[dict[str, Any]] = []
        for segment in segments:
            # Per-segment isolation: one malformed segment must not lose
            # the rest of the utterance.
            try:
                seg_text = (segment.text or "").strip()
                seg_words = segment.words or []
                seg_entry = {
                    "text": seg_text,
                    "start": float(getattr(segment, "start", 0.0) or 0.0),
                    "end": float(getattr(segment, "end", 0.0) or 0.0),
                }
                mapped_words = [
                    {
                        "word": (w.word or "").strip(),
                        "start": float(w.start),
                        "end": float(w.end),
                        "confidence": float(getattr(w, "probability", 1.0) or 1.0),
                    }
                    for w in seg_words
                ]
            except Exception as exc:
                logger.warning(
                    "Skipping malformed faster-whisper segment",
                    model_slug=self._loaded.model_slug,
                    error=str(exc),
                )
                continue
            if seg_text:
                texts.append(seg_text)
            word_timestamps.extend(mapped_words)
            out_segments.append(seg_entry)

        language = self._language or getattr(info, "language", None)

        return {
            "text": " ".join(texts).strip(),
            "language": language,
            "word_timestamps": word_timestamps,
            "segments": out_segments,
        }
