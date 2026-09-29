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

import concurrent.futures
import threading
from dataclasses import dataclass
from typing import Any

import numpy as np
import structlog

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat
from stt.streaming.cross_stream_batcher import CrossStreamBatcher
from stt.streaming.faster_whisper_batch_decoder import (
    FasterWhisperBatchDecoder,
    FwBatchItem,
    FwBatchKey,
    FwDecodedWindow,
)

logger = structlog.get_logger(__name__)

_TARGET_SAMPLE_RATE = 16000

#: Stamped on :attr:`FasterWhisperAsrAdapter.unsupported_decode_knobs` for a knob
#: the config carries that this engine cannot honour. Same shape as
#: ``decoding.sources``'s tier names, so a caller merges the two maps and reads one
#: answer per knob. Per-ENGINE, not per-key: the same wire block means a different
#: set of live knobs on each adapter.
UNSUPPORTED_SOURCE = "unsupported:faster-whisper"

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


# ---------------------------------------------------------------------------
# TASK-1009 — cross-stream batching
# ---------------------------------------------------------------------------

#: ``LoadedModel.extra`` slots: the model's shared batcher, and the limits it
#: was last configured with.
_BATCHER_SLOT = "cross_stream_batcher"
_BATCHING_SLOT = "cross_stream_batching"
_batcher_guard = threading.Lock()


@dataclass(frozen=True)
class CrossStreamBatching:
    """Limits for the model's shared :class:`CrossStreamBatcher`."""

    max_batch_size: int
    max_wait_ms: float
    max_queue: int

    @classmethod
    def from_settings(cls, settings: Any) -> CrossStreamBatching | None:
        """The configured batching, or ``None`` (off) — which is the default.

        A served limit that is not a positive number turns batching OFF for the
        session with a warning rather than failing it: the per-call path is the
        known-good fallback, and a bad control-plane write must not stop
        transcription.
        """
        if getattr(settings, "faster_whisper_batch_enabled", False) is not True:
            return None
        size = getattr(settings, "faster_whisper_batch_max_batch_size", None)
        wait = getattr(settings, "faster_whisper_batch_max_wait_ms", None)
        queue = getattr(settings, "faster_whisper_batch_max_queue", None)
        numbers = (size, wait, queue)
        if not all(isinstance(v, int | float) and not isinstance(v, bool) for v in numbers) or not (
            size >= 1 and wait >= 0 and queue >= 1
        ):
            logger.warning(
                "stt.asr_batch.invalid_limits_batching_off",
                max_batch_size=size,
                max_wait_ms=wait,
                max_queue=queue,
            )
            return None
        return cls(max_batch_size=int(size), max_wait_ms=float(wait), max_queue=int(queue))


class _BatchMetrics:
    """Prometheus observer for one model's batcher."""

    def __init__(self, model: str) -> None:
        self._model = model

    def batch_decoded(self, *, size: int, queue_waits_s: list[float], decode_s: float) -> None:
        from stt.core.metrics import record_asr_batch

        record_asr_batch(
            model=self._model, size=size, queue_waits_s=queue_waits_s, decode_s=decode_s
        )

    def queue_depth(self, depth: int) -> None:
        from stt.core.metrics import set_asr_batch_queue_depth

        set_asr_batch_queue_depth(model=self._model, depth=depth)


def get_model_batcher(
    loaded_model: LoadedModel, batching: CrossStreamBatching
) -> CrossStreamBatcher:
    """The ONE batcher every session on *loaded_model* shares, created on first use.

    A later session carrying different limits (a control-plane change) re-applies
    them to the shared batcher; they govern every flush from then on.
    """
    with _batcher_guard:
        batcher = loaded_model.extra.get(_BATCHER_SLOT)
        if batcher is None:
            batcher = CrossStreamBatcher(
                FasterWhisperBatchDecoder(loaded_model.model),
                max_batch_size=batching.max_batch_size,
                max_wait_ms=batching.max_wait_ms,
                max_queue=batching.max_queue,
                name=loaded_model.model_slug,
                observer=_BatchMetrics(loaded_model.model_slug),
            )
            loaded_model.extra[_BATCHER_SLOT] = batcher
            loaded_model.extra[_BATCHING_SLOT] = batching
            logger.info(
                "stt.asr_batch.enabled",
                model=loaded_model.model_slug,
                max_batch_size=batching.max_batch_size,
                max_wait_ms=batching.max_wait_ms,
                max_queue=batching.max_queue,
            )
        elif loaded_model.extra.get(_BATCHING_SLOT) != batching:
            batcher.configure(
                max_batch_size=batching.max_batch_size,
                max_wait_ms=batching.max_wait_ms,
                max_queue=batching.max_queue,
            )
            loaded_model.extra[_BATCHING_SLOT] = batching
        return batcher


def close_model_batcher(loaded_model: LoadedModel) -> None:
    """Stop and drop *loaded_model*'s batcher (model unload). No-op without one."""
    with _batcher_guard:
        batcher = (loaded_model.extra or {}).pop(_BATCHER_SLOT, None)
        (loaded_model.extra or {}).pop(_BATCHING_SLOT, None)
    if batcher is not None:
        batcher.close()


def _chain(inner: concurrent.futures.Future, transform: Any) -> concurrent.futures.Future:
    """A future for ``transform(inner.result())``; cancelling it cancels *inner*."""
    outer: concurrent.futures.Future = concurrent.futures.Future()

    def _settle(done: concurrent.futures.Future) -> None:
        if outer.done():
            return
        try:
            if done.cancelled():
                outer.cancel()
            elif done.exception() is not None:
                outer.set_exception(done.exception())
            else:
                outer.set_result(transform(done.result()))
        except concurrent.futures.InvalidStateError:
            pass  # the caller cancelled between the check and the set
        except Exception as exc:  # noqa: BLE001 — a mapping failure is this caller's error
            if not outer.done():
                outer.set_exception(exc)

    def _propagate_cancel(done: concurrent.futures.Future) -> None:
        if done.cancelled():
            inner.cancel()

    outer.add_done_callback(_propagate_cancel)
    inner.add_done_callback(_settle)
    return outer


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
    batching:
        TASK-1009 — when set, windows this engine can hold as one batch item are
        decoded through the model's shared :class:`CrossStreamBatcher` together
        with other sessions' windows. ``None`` (the default) leaves every call
        on the per-call path, unchanged.
    """

    def __init__(
        self,
        loaded_model: LoadedModel,
        inference_config: Any,
        batch_size: int | None = None,
        task: str = "transcribe",
        batching: CrossStreamBatching | None = None,
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
        #: Knobs the caller configured that this engine cannot honour, wire name ->
        #: :data:`UNSUPPORTED_SOURCE`. PUBLIC, and named identically on the
        #: whisper.cpp adapter, so the session layer reads ONE attribute whichever
        #: engine is live.
        self.unsupported_decode_knobs: dict[str, str] = self._unsupported_knobs(inference_config)

        # TASK-1009. Everything that shapes a decode is in the key, so windows
        # from sessions configured differently never share a batch.
        self._batch_key = FwBatchKey.build(
            task=self._task,
            language=self._language,
            decode={**self._decode_kwargs, "word_timestamps": True},
        )
        self._batcher: CrossStreamBatcher | None = (
            get_model_batcher(loaded_model, batching) if batching is not None else None
        )

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

        # `InferenceConfig.no_repeat_ngram_size` is resolved by the gateway,
        # carried on the wire, landed on the config — and was then forwarded to
        # NEITHER streaming engine. whisper.cpp genuinely has no such parameter
        # (`whisper_full_params` carries no n-gram-block or repetition-penalty
        # field), but CTranslate2 does, and it is the direct decoder-level answer
        # to the repetition loops this pipeline's post-hoc string collapse exists
        # to mop up. Forwarded here so the declared value is the value that runs;
        # `0` (the wire's "off") still means off.
        nrns = getattr(inference_config, "no_repeat_ngram_size", None)
        if isinstance(nrns, int) and not isinstance(nrns, bool) and nrns >= 0:
            kwargs["no_repeat_ngram_size"] = int(nrns)

        # TASK-877 — ResolvedAsrSpec.decoding.vadFilter. The streaming preprocessor
        # has already run VAD, so the agent default is OFF and this stays a
        # deliberate per-agent opt-in rather than a hardcoded False.
        kwargs["vad_filter"] = bool(getattr(inference_config, "vad_filter", False))

        return kwargs

    @staticmethod
    def _unsupported_knobs(inference_config: Any) -> dict[str, str]:
        """Decode knobs the config carries that CTranslate2 cannot honour.

        Same shape and same purpose as the whisper.cpp adapter's map: a knob a
        tenant set that never reaches the decoder must say so, rather than leaving
        ``decoding.sources[key]`` naming a tier that decided nothing. This engine's
        list is SHORT — it honours beam size, temperature (including the ladder),
        the compression-ratio / logprob / no-speech gates, previous-text
        conditioning and n-gram blocking — which is exactly why the same wire block
        means six live knobs here and a different set on whisper.cpp, and why the
        map has to be per-engine rather than per-key.
        """
        unsupported: dict[str, str] = {}
        # whisper.cpp's token-distribution entropy gate. CTranslate2 exposes the
        # compression-ratio gate instead, which is a different quantity gating in
        # the opposite direction — so this is reported unsupported, never aliased.
        if getattr(inference_config, "entropy_threshold", None) is not None:
            unsupported["entropyThreshold"] = UNSUPPORTED_SOURCE
        return unsupported

    @property
    def batch_key(self) -> FwBatchKey:
        """What a window from this session must share with another to batch with it."""
        return self._batch_key

    def submit(
        self,
        samples: np.ndarray,
        sample_rate: int,
        *,
        prompt: str | None = None,
    ) -> concurrent.futures.Future | None:
        """Queue this window on the model's cross-stream batch; ``None`` = decode per call.

        ``None`` when batching is off, or for a window one batch item cannot hold.
        The returned future resolves to the same dict :meth:`__call__` returns.
        """
        return self._submit_prepared(self._prepare(samples, sample_rate), prompt)

    @staticmethod
    def _prepare(samples: np.ndarray, sample_rate: int) -> np.ndarray:
        audio = np.asarray(samples, dtype=np.float32)
        return _resample_to_16k(audio, sample_rate)

    def _submit_prepared(
        self, audio: np.ndarray, prompt: str | None
    ) -> concurrent.futures.Future | None:
        if self._batcher is None or not self._batchable(audio):
            return None
        inner = self._batcher.submit(self._batch_key, FwBatchItem(audio, prompt or None))
        return _chain(inner, self._decoded_result)

    def _batchable(self, audio: np.ndarray) -> bool:
        """Whether *audio* is exactly one batch item on the per-call path.

        Engine-side VAD splits a call into several chunks, and a window of the
        model's chunk length or more cannot be one chunk without it — the
        per-call path owns both, as it does an empty window.
        """
        if self._decode_kwargs.get("vad_filter"):
            return False
        chunk_length = getattr(
            getattr(self._model, "feature_extractor", None), "chunk_length", None
        )
        if isinstance(chunk_length, bool) or not isinstance(chunk_length, int | float):
            return False
        return 0 < len(audio) < chunk_length * _TARGET_SAMPLE_RATE

    def _decoded_result(self, decoded: FwDecodedWindow) -> dict[str, Any]:
        return self._to_result(decoded.segments, decoded.language)

    def __call__(
        self,
        samples: np.ndarray,
        sample_rate: int,
        *,
        prompt: str | None = None,
    ) -> dict[str, Any]:
        audio = self._prepare(samples, sample_rate)
        batched = self._submit_prepared(audio, prompt)
        if batched is not None:
            return batched.result()

        kwargs: dict[str, Any] = {
            "task": self._task,
            "language": self._language,
            "word_timestamps": True,
            # `vad_filter` arrives through `_decode_kwargs` (the agent's
            # `decoding.vadFilter`); VAD already ran in the streaming preprocessor,
            # so the spec default is False.
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

        return self._to_result(segments, getattr(info, "language", None))

    def _to_result(self, segments: Any, detected_language: str | None) -> dict[str, Any]:
        """Map engine segments to the ASR-callable result (shared by both paths)."""
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

        language = self._language or detected_language

        return {
            "text": " ".join(texts).strip(),
            "language": language,
            "word_timestamps": word_timestamps,
            "segments": out_segments,
        }
