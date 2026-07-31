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

Concurrency + Metal recovery
----------------------------
A single ``pywhispercpp.model.Model`` (one ggml/whisper context) is loaded once
into the shared by-slug model cache and reused across every streaming session —
and, within a session, by both the main and the ``english_gloss`` callables.
whisper.cpp's ``whisper_full`` uses the context's single internal state and is
NOT concurrency-safe: two decodes on one context at the same time collide on
the ggml backend and, on Metal, corrupt the command buffer:

    ggml_metal_graph_compute: backend is in error state from a previous
        command buffer failure - recreate the backend to recover
    whisper_full_with_state: failed to encode

Once poisoned the backend stays in the error state for the life of the context,
so every subsequent ``whisper_full`` returns ZERO segments (empty text) — and
``pywhispercpp`` does not surface that failure (it discards ``whisper_full``'s
return code), so it is silently indistinguishable from genuine silence at the
Python level. This adapter therefore:

1. Serializes every ``transcribe`` on a per-context lock (keyed by ``model_id``,
   shared by all adapters wrapping the same ``LoadedModel``), removing the
   concurrent-command-buffer trigger.
2. Captures whisper.cpp's native log via ``whisper_log_set`` into a thread-local
   buffer, and on the poison markers recreates the context in place (mutating
   the shared ``LoadedModel.model`` so every sharer recovers) and retries once.
"""

from __future__ import annotations

import gc
import math
import re
import threading
from typing import Any

import numpy as np
import structlog

from stt.core.config.settings import get_settings
from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat, primary_language_subtag
from stt.pipeline.language_modes import LANGUAGE_MODES_BY_ID

logger = structlog.get_logger(__name__)

# --- Clinical-consultation priming prompt (language-derived) ------------------
# whisper.cpp's ``initial_prompt`` is decoder prior-context (≤224 tokens), NOT a
# chat instruction. A short domain-context line in the target language biases
# decoding toward clinical-consultation vocabulary and, for a code-switch GGUF,
# frames the ml/en mixture — without the instruction-style degradation that took
# the old priming prompt offline (see
# ``stt.pipeline.language_modes.WHISPER_CPP_PRIMING_PROMPT_ENABLED``). The prompt
# is keyed on the pipeline's configured ``inference.language``.
_CONSULTATION_PROMPT_ML = (
    "ഇത് ഒരു consultation ആണ്, ഒരു doctor നും ഒരു രോഗിക്കും തമ്മിലുള്ളത്."
)
_CONSULTATION_PROMPT_EN = "This is a consultation between a doctor and a patient"


def consultation_prompt_for_language(language: str | None) -> str:
    """Clinical-consultation priming prompt for whisper.cpp, keyed on the
    pipeline's configured language.

    Malayalam (``"ml"``) gets the Malayalam line; English (``"en"``) or an
    unset/auto language gets the English line. The comparison uses the primary
    subtag only (e.g. ``"ml-en"`` → ``"ml"``).
    """
    if language and language.split("-")[0].lower() == "ml":
        return _CONSULTATION_PROMPT_ML
    return _CONSULTATION_PROMPT_EN


# Substrings that mark a poisoned ggml/Metal backend in whisper.cpp's native log.
_POISON_MARKERS = (
    "failed to encode",
    "error state",
    "command buffer failure",
)

# whisper.cpp logs on the thread running the native call; a thread-local buffer
# therefore isolates each decode's messages with no cross-thread bleed.
_tls = threading.local()

# One lock per whisper context (keyed by model_id) so the main and gloss
# adapters over one shared LoadedModel serialize against each other.
_model_locks_guard = threading.Lock()
_model_locks: dict[str, threading.Lock] = {}

_log_install_guard = threading.Lock()
_log_installed = False


def _dispatch_log(level: int, text: str) -> None:
    """whisper.cpp log sink (registered process-wide via ``whisper_log_set``).

    Appends to the active thread-local capture buffer when a decode is in
    flight; otherwise routes only the poison markers to the logger (dropping
    the verbose per-init ggml chatter that would otherwise flood stderr).
    """
    buffer = getattr(_tls, "buffer", None)
    if buffer is not None:
        buffer.append(text)
        return
    if any(marker in text for marker in _POISON_MARKERS):
        logger.warning("whisper.cpp native log", message=text.strip())


def _ensure_log_capture_installed() -> None:
    global _log_installed
    if _log_installed:
        return
    with _log_install_guard:
        if _log_installed:
            return
        try:
            import _pywhispercpp as pw

            pw.whisper_log_set(_dispatch_log)
        except Exception as exc:  # noqa: BLE001 — capture is best-effort
            # Without the callback we lose poison auto-recovery, but the lock
            # (the primary fix) still prevents the corruption in the first place.
            logger.warning(
                "whisper.cpp log capture unavailable; Metal poison "
                "auto-recovery disabled",
                error=str(exc),
            )
        _log_installed = True


def _get_model_lock(model_id: str) -> threading.Lock:
    with _model_locks_guard:
        lock = _model_locks.get(model_id)
        if lock is None:
            lock = threading.Lock()
            _model_locks[model_id] = lock
        return lock


def _construct_whisper_model(model_path: str, num_threads: int | None, use_gpu: bool) -> Any:
    """Instantiate a fresh ``pywhispercpp.model.Model`` (a new ggml/Metal
    backend). Isolated for recovery + test seams."""
    from pywhispercpp.model import Model

    kwargs: dict[str, Any] = {
        "model": model_path,
        "context_params": {"use_gpu": use_gpu},
        "print_progress": False,
        "print_realtime": False,
    }
    if num_threads is not None:
        kwargs["n_threads"] = num_threads
    return Model(**kwargs)


def _is_poisoned(logs: list[str]) -> bool:
    return any(any(marker in line for marker in _POISON_MARKERS) for line in logs)


class WhisperCppAsrAdapter:
    """Synchronous callable wrapping a loaded whisper.cpp (pywhispercpp) model."""

    def __init__(
        self,
        loaded_model: LoadedModel,
        inference_config: Any,
        *,
        want_word_timestamps: bool = False,
    ) -> None:
        if loaded_model.format != AiModelFormat.WHISPER_CPP:
            raise ValueError(
                "WhisperCppAsrAdapter requires a WHISPER_CPP LoadedModel, "
                f"got {loaded_model.format}"
            )
        self._loaded = loaded_model
        # Decode language. A code-switch PAIR (``"ml-en"`` / ``"vi-en"``) resolves
        # to None (auto) — measured to beat pinning the primary subtag on the
        # in-house code-switch fine-tune (pinning ``ml`` over-biases toward the
        # Malayalam script and degrades the English spans). A genuine single
        # language (``"ml"`` / ``"en"``) or a region-tagged single (``"ml-IN"`` →
        # ``"ml"``) is still pinned. Code-switch pairs are recognized from the
        # closed language-mode catalog, matching ``resolve_mode_for_engine``.
        raw_language = getattr(inference_config, "language", None)
        mode = LANGUAGE_MODES_BY_ID.get(raw_language) if raw_language else None
        if mode is not None and mode.kind == "code_switch":
            self._language = None
        else:
            self._language = primary_language_subtag(raw_language)
        # Whether this pipeline consumes per-word timestamps. When False (the
        # default / the ml-en pipeline) whisper.cpp runs a CLEAN sentence-level
        # decode and the transcript is rebuilt by native concatenation — the
        # ``max_len=1`` word-splitting is a lossy, script-corrupting hack we only
        # incur when word timings are actually needed.
        self._want_word_timestamps = want_word_timestamps
        # Language-derived consultation context, fed as whisper.cpp's
        # ``initial_prompt`` (prepended before any per-utterance carry-forward
        # text) — an exemplar prior-context line, NOT an instruction. Gated by
        # ``whisper_cpp_consultation_prompt_enabled`` (default OFF: measured to
        # inject spurious tokens and break grapheme clusters on the code-switch
        # fine-tune). A/B-togglable; kept off until an eval shows it helps.
        self._context_prompt: str = (
            consultation_prompt_for_language(self._language)
            if get_settings().whisper_cpp_consultation_prompt_enabled
            else ""
        )
        # Shared per-context lock — the main and english-gloss adapters over one
        # cached LoadedModel MUST serialize (same underlying whisper context).
        self._lock = _get_model_lock(loaded_model.model_id)
        _ensure_log_capture_installed()

    def __call__(
        self,
        samples: np.ndarray,
        sample_rate: int,
        *,
        prompt: str | None = None,
    ) -> dict[str, Any]:
        audio = np.asarray(samples, dtype=np.float32)

        with self._lock:
            segments, logs = self._decode_capturing(audio, prompt)
            if _is_poisoned(logs):
                logger.warning(
                    "whisper.cpp Metal backend poisoned; recreating context",
                    model_slug=self._loaded.model_slug,
                )
                if self._rebuild_locked():
                    segments, logs = self._decode_capturing(audio, prompt)
                    if _is_poisoned(logs):
                        logger.error(
                            "whisper.cpp still failing after backend recreate; "
                            "returning empty transcription",
                            model_slug=self._loaded.model_slug,
                        )
                        segments = []
                else:
                    segments = []

        return self._build_result(segments, audio, sample_rate)

    def _decode_capturing(
        self, audio: np.ndarray, prompt: str | None
    ) -> tuple[list[Any], list[str]]:
        """Run one decode while capturing whisper.cpp's native log for this
        thread. Must be called with ``self._lock`` held."""
        model = self._loaded.model
        # The language-derived consultation context (when enabled) leads; any
        # per-utterance carry-forward/template ``prompt`` follows it as additional
        # prior context. Join only the non-empty parts so a disabled context prompt
        # leaves the carry-forward prompt untouched (no leading space).
        effective_prompt = " ".join(p for p in (self._context_prompt, prompt) if p)
        # Word-timestamp mode forces near-word-sized segments (``max_len=1``,
        # ``split_on_word``) so each segment carries its own (t0, t1). This is
        # only requested when the pipeline consumes word timings; otherwise a
        # clean sentence-level decode is both faster and avoids the space-joining
        # corruption of non-space-delimited scripts (Malayalam).
        word_ts_kwargs: dict[str, Any] = (
            {"token_timestamps": True, "split_on_word": True, "max_len": 1}
            if self._want_word_timestamps
            else {}
        )
        prev = getattr(_tls, "buffer", None)
        _tls.buffer = []
        try:
            segments = model.transcribe(
                audio,
                extract_probability=True,
                # Pure greedy, NO temperature fallback. whisper.cpp's default
                # fallback (temperature_inc=0.2) re-decodes with rising temperature
                # when a segment fails its entropy/logprob check — on this
                # code-switch fine-tune that reliably spirals into SAMPLED GARBAGE
                # (e.g. "eurysmbalination …") rather than recovering. Disabling the
                # fallback keeps the deterministic greedy hypothesis, which is
                # measured strictly better on real ml-en clinical audio.
                temperature=0.0,
                temperature_inc=0.0,
                **word_ts_kwargs,
                **({"language": self._language} if self._language else {}),
                **({"initial_prompt": effective_prompt} if effective_prompt else {}),
            )
        finally:
            logs = _tls.buffer
            _tls.buffer = prev
        return list(segments or []), logs

    def _rebuild_locked(self) -> bool:
        """Recreate the whisper context in place (shared ``LoadedModel.model``,
        so every adapter over it recovers). Returns ``False`` when the reload
        params are unavailable. Must be called with ``self._lock`` held."""
        extra = self._loaded.extra or {}
        model_path = extra.get("model_path")
        if not model_path:
            logger.error(
                "cannot recreate whisper.cpp context — no model_path recorded",
                model_slug=self._loaded.model_slug,
            )
            return False
        try:
            new_model = _construct_whisper_model(
                model_path,
                extra.get("num_threads"),
                self._loaded.device != "cpu",
            )
        except Exception as exc:  # noqa: BLE001 — recovery must not crash the hot path
            logger.error(
                "failed to recreate whisper.cpp context",
                model_slug=self._loaded.model_slug,
                error=str(exc),
            )
            return False
        old = self._loaded.model
        self._loaded.model = new_model
        del old
        gc.collect()
        return True

    def _build_result(
        self, segments: list[Any], audio: np.ndarray, sample_rate: int
    ) -> dict[str, Any]:
        duration = len(audio) / float(sample_rate) if sample_rate else 0.0

        if self._want_word_timestamps:
            # Word-timestamp mode: each segment is one space-trimmed word (from
            # ``split_on_word``/``max_len=1``). Emit per-word timings AND rebuild
            # the transcript by SPACE-joining the trimmed words — the correct
            # reconstruction for this segmentation (whisper.cpp consumed the
            # boundary whitespace as the split point).
            word_timestamps: list[dict[str, Any]] = []
            for seg in segments:
                word = str(seg.text or "").strip()
                if not word:
                    continue
                probability = seg.probability
                confidence = (
                    1.0 if probability is None or math.isnan(probability) else float(probability)
                )
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
            start = word_timestamps[0]["start"] if word_timestamps else 0.0
            end = word_timestamps[-1]["end"] if word_timestamps else duration
        else:
            # Clean sentence-level decode: rebuild the transcript by NATIVE
            # concatenation of segment text, preserving whisper's own spacing (its
            # byte-BPE attaches a leading space to word-initial tokens). This is the
            # ONLY correct reconstruction for non-space-delimited scripts like
            # Malayalam — space-joining segments would inject spurious spaces and
            # split grapheme clusters. No per-word timings in this mode.
            text = re.sub(r"\s+", " ", "".join(str(seg.text or "") for seg in segments)).strip()
            word_timestamps = []
            start, end = 0.0, duration

        return {
            "text": text,
            "language": self._language,
            "word_timestamps": word_timestamps,
            "segments": ([{"text": text, "start": start, "end": end}] if text else []),
        }
