"""TASK-1009 — one CROSS-STREAM batch through faster-whisper / CTranslate2.

Every streaming decode on the faster-whisper engine goes through
``BatchedInferencePipeline.transcribe`` with a single window of under 30 s and
``vad_filter`` off (the streaming preprocessor already ran VAD). For such a
window that pipeline is: mel features → (language detection when unpinned) →
ONE encoder pass → ONE ``generate`` → timestamp split → word alignment →
speech-timestamp restore. This module runs that same sequence for N windows
from N DIFFERENT sessions at once, so the encoder and decoder see a batch of N
instead of N batches of one.

What is preserved, and what is not
----------------------------------
The per-call semantics this reproduces are the ones actually in force on the
live path (``BatchedInferencePipeline``), which are NOT all of the adapter's
declared knobs: that pipeline decodes at the FIRST temperature only, with no
fallback, forces ``condition_on_previous_text`` off, and does not apply the
compression-ratio / log-prob / no-speech gates. The batched decode inherits
exactly that — it neither adds nor removes behaviour.

* Each window keeps ITS OWN prompt (the session's priming + carry-forward text)
  and ITS OWN language. CTranslate2 takes one prompt per batch item, but
  refuses a batch whose ``<|startoftranscript|>`` positions differ, so windows
  are sub-grouped by prompt SHAPE for ``generate`` — while the encoder, the
  expensive half, still runs once for the whole flush.
* Unpinned (auto-LID) windows are detected in one batched pass using the same
  input the per-call path builds (features plus its one-frame ``-1.5`` pad),
  then partitioned by detected language; alignment needs one start sequence
  per call, so it runs once per language partition.
* Word timings restart at ``last_speech_timestamp = 0`` for every window, as
  each per-call decode does. Carrying it across windows of different sessions
  would bend one clinician's word timings by another's speech.
* Batch composition can change floating-point results in the last bits, so a
  batched greedy decode is expected, not guaranteed, to be token-identical to
  the serial one; the bench (``apps/stt/scripts/bench_fw_cross_stream_batch.py``)
  reports the agreement.

The ``faster_whisper`` helpers are reached through an ``ops`` namespace that is
imported lazily, so this module imports without the package (CI installs no
``ml`` extra) and the unit tests can substitute fakes.
"""

from __future__ import annotations

import inspect
from collections.abc import Hashable, Mapping
from dataclasses import dataclass
from math import ceil
from types import SimpleNamespace
from typing import Any

import numpy as np
import structlog

logger = structlog.get_logger(__name__)

_SAMPLE_RATE = 16000
#: The value BatchedInferencePipeline appends as one extra mel frame before
#: language detection ("add a dummy feature to account for empty audio").
_LID_PAD_VALUE = -1.5


def _multi_gpu(ct2: Any) -> bool:
    """WhisperModel.encode's rule: spread over GPUs → hand the encoding back on CPU."""
    return ct2.device == "cuda" and len(ct2.device_index) > 1


def _freeze(value: Any) -> Hashable:
    if isinstance(value, list | tuple):
        return tuple(_freeze(v) for v in value)
    if isinstance(value, dict):
        return tuple(sorted((k, _freeze(v)) for k, v in value.items()))
    return value


@dataclass(frozen=True)
class FwBatchKey:
    """What must be identical for two windows to share one batched decode."""

    task: str
    language: str | None
    decode: tuple[tuple[str, Hashable], ...]

    @classmethod
    def build(cls, *, task: str, language: str | None, decode: Mapping[str, Any]) -> FwBatchKey:
        return cls(
            task=task,
            language=language,
            decode=tuple(sorted((k, _freeze(v)) for k, v in decode.items())),
        )


@dataclass(frozen=True)
class FwBatchItem:
    """One session's window: 16 kHz float32 audio under 30 s, and its prompt."""

    audio: np.ndarray
    prompt: str | None


@dataclass
class FwDecodedWindow:
    """The decode of one window, shaped like ``transcribe``'s ``(segments, info)``."""

    segments: list[Any]
    language: str


def _default_ops() -> SimpleNamespace:
    """The faster-whisper helpers the batched decode reuses verbatim."""
    from faster_whisper.audio import pad_or_trim
    from faster_whisper.tokenizer import Tokenizer
    from faster_whisper.transcribe import (
        BatchedInferencePipeline,
        Segment,
        WhisperModel,
        Word,
        get_compression_ratio,
        get_ctranslate2_storage,
        get_suppressed_tokens,
        restore_speech_timestamps,
    )

    # The per-call path's defaults, read from the library rather than copied, so a
    # faster-whisper upgrade that moves one moves both paths together.
    params = inspect.signature(BatchedInferencePipeline.transcribe).parameters
    defaults = {
        name: p.default for name, p in params.items() if p.default is not inspect.Parameter.empty
    }
    return SimpleNamespace(
        Tokenizer=Tokenizer,
        pad_or_trim=pad_or_trim,
        get_ctranslate2_storage=get_ctranslate2_storage,
        get_suppressed_tokens=get_suppressed_tokens,
        get_compression_ratio=get_compression_ratio,
        add_word_timestamps=WhisperModel.add_word_timestamps,
        restore_speech_timestamps=restore_speech_timestamps,
        Segment=Segment,
        Word=Word,
        transcribe_defaults=defaults,
    )


class FasterWhisperBatchDecoder:
    """``decode_batch`` for :class:`~stt.streaming.cross_stream_batcher.CrossStreamBatcher`.

    Called with one :class:`FwBatchKey` and the windows that share it; returns
    one :class:`FwDecodedWindow` (or an exception, for a window that failed on
    its own) per window, in order.
    """

    def __init__(self, whisper_model: Any, *, ops: SimpleNamespace | None = None) -> None:
        self._model = whisper_model
        self._ops = ops
        self._english_only_warned = False

    @property
    def ops(self) -> SimpleNamespace:
        if self._ops is None:
            self._ops = _default_ops()
        return self._ops

    def __call__(self, key: FwBatchKey, items: list[FwBatchItem]) -> list[Any]:
        ops = self.ops
        model = self._model
        opts = {**ops.transcribe_defaults, **dict(key.decode)}

        out: list[Any] = [None] * len(items)
        feats: dict[int, np.ndarray] = {}
        for i, item in enumerate(items):
            try:
                feats[i] = model.feature_extractor(item.audio)[..., :-1]
            except Exception as exc:  # noqa: BLE001 — this window fails alone
                out[i] = exc
        live = [i for i in range(len(items)) if i in feats]
        if not live:
            return out

        languages = self._languages(key, feats, live)
        tokenizers = {
            lang: ops.Tokenizer(
                model.hf_tokenizer, model.model.is_multilingual, task=key.task, language=lang
            )
            for lang in dict.fromkeys(languages[i] for i in live)
        }
        prompts = {
            i: model.get_prompt(
                tokenizers[languages[i]],
                previous_tokens=(
                    tokenizers[languages[i]].encode(items[i].prompt)
                    if items[i].prompt is not None
                    else []
                ),
                without_timestamps=opts["without_timestamps"],
                hotwords=None,
            )
            for i in live
        }

        # generate() needs <|startoftranscript|> at one position per call.
        generate_groups: dict[tuple[str, int], list[int]] = {}
        for i in live:
            sot_at = prompts[i].index(tokenizers[languages[i]].sot)
            generate_groups.setdefault((languages[i], sot_at), []).append(i)
        split = len(generate_groups) > 1

        ct2 = model.model
        multi_gpu = _multi_gpu(ct2)
        features = np.stack([ops.pad_or_trim(feats[i]) for i in live])
        encoder_output = ct2.encode(
            ops.get_ctranslate2_storage(features), to_cpu=split or multi_gpu
        )
        rows = np.asarray(encoder_output) if split else None
        row_of = {i: r for r, i in enumerate(live)}

        def encoded(indices: list[int]) -> Any:
            if rows is None or indices == live:
                return encoder_output
            return ops.get_ctranslate2_storage(rows[[row_of[i] for i in indices]])

        scored: dict[int, dict[str, Any]] = {}
        for (lang, _sot_at), indices in generate_groups.items():
            tokenizer = tokenizers[lang]
            max_new_tokens = opts["max_new_tokens"]
            first_prompt = prompts[indices[0]]
            max_length = (
                len(first_prompt) + max_new_tokens
                if max_new_tokens is not None
                else model.max_length
            )
            suppress = opts["suppress_tokens"]
            temperature = opts["temperature"]
            results = ct2.generate(
                encoded(indices),
                [prompts[i] for i in indices],
                beam_size=opts["beam_size"],
                patience=opts["patience"],
                length_penalty=opts["length_penalty"],
                max_length=max_length,
                suppress_blank=opts["suppress_blank"],
                suppress_tokens=(
                    ops.get_suppressed_tokens(tokenizer, list(suppress)) if suppress else suppress
                ),
                return_scores=True,
                return_no_speech_prob=True,
                sampling_temperature=(
                    temperature[0] if isinstance(temperature, list | tuple) else temperature
                ),
                repetition_penalty=opts["repetition_penalty"],
                no_repeat_ngram_size=opts["no_repeat_ngram_size"],
            )
            for i, result in zip(indices, results, strict=True):
                # Same scoring as BatchedInferencePipeline.generate_segment_batched.
                seq_len = len(result.sequences_ids[0])
                cum_logprob = result.scores[0] * (seq_len ** opts["length_penalty"])
                scored[i] = {
                    "tokens": result.sequences_ids[0],
                    "avg_logprob": cum_logprob / (seq_len + 1),
                    "no_speech_prob": result.no_speech_prob,
                    "temperature": (
                        temperature[0] if isinstance(temperature, list | tuple) else temperature
                    ),
                }

        partitions: dict[str, list[int]] = {}
        for i in live:
            partitions.setdefault(languages[i], []).append(i)
        for lang, indices in partitions.items():
            decoded = self._segments(
                opts, tokenizers[lang], items, indices, scored, encoded(indices)
            )
            for i, segments in decoded.items():
                out[i] = FwDecodedWindow(segments=segments, language=lang)
        return out

    # ── stages ──────────────────────────────────────────────────────────────

    def _languages(
        self, key: FwBatchKey, feats: dict[int, np.ndarray], live: list[int]
    ) -> dict[int, str]:
        model = self._model
        if not model.model.is_multilingual:
            if key.language not in (None, "en") and not self._english_only_warned:
                self._english_only_warned = True
                logger.warning(
                    "stt.asr_batch.english_only_model",
                    requested_language=key.language,
                    detail="model is not multilingual; decoding as 'en', as the per-call path does",
                )
            return dict.fromkeys(live, "en")
        if key.language is not None:
            return dict.fromkeys(live, key.language)

        ops = self.ops
        n_mels = feats[live[0]].shape[0]
        pad = np.full((n_mels, 1), _LID_PAD_VALUE, dtype="float32")
        lid_input = np.stack(
            [ops.pad_or_trim(np.concatenate([feats[i], pad], axis=1)) for i in live]
        )
        detected = model.model.detect_language(
            model.model.encode(
                ops.get_ctranslate2_storage(lid_input), to_cpu=_multi_gpu(model.model)
            )
        )
        # One segment per window: the per-call detector returns its top language
        # whether or not it clears the threshold.
        return {i: ranked[0][0][2:-2] for i, ranked in zip(live, detected, strict=True)}

    def _segments(
        self,
        opts: dict[str, Any],
        tokenizer: Any,
        items: list[FwBatchItem],
        indices: list[int],
        scored: dict[int, dict[str, Any]],
        encoder_output: Any,
    ) -> dict[int, list[Any]]:
        ops = self.ops
        model = self._model
        segmented: dict[int, list[dict[str, Any]]] = {}
        sizes: dict[int, int] = {}
        for i in indices:
            duration = len(items[i].audio) / _SAMPLE_RATE
            sizes[i] = int(ceil(duration) * model.frames_per_second)
            subsegments, _seek, _single = model._split_segments_by_timestamps(
                tokenizer=tokenizer,
                tokens=scored[i]["tokens"],
                time_offset=0.0,
                segment_size=sizes[i],
                segment_duration=duration,
                seek=0,
            )
            segmented[i] = [
                {
                    "text": tokenizer.decode(sub["tokens"]),
                    "tokens": sub["tokens"],
                    "start": sub["start"],
                    "end": sub["end"],
                    "seek": 0,
                }
                for sub in subsegments
            ]

        word_timestamps = bool(opts["word_timestamps"])
        if word_timestamps:
            # The expensive half (cross-attention alignment) runs once for the
            # partition; the per-window heuristics then run window by window.
            text_tokens = [
                [t for sub in segmented[i] for t in sub["tokens"] if t < tokenizer.eot]
                for i in indices
            ]
            alignments = model.find_alignment(
                tokenizer, text_tokens, encoder_output, [sizes[i] for i in indices]
            )
            for i, alignment in zip(indices, alignments, strict=True):
                shim = SimpleNamespace(
                    find_alignment=lambda *_a, _al=alignment, **_k: [_al],
                    frames_per_second=model.frames_per_second,
                )
                ops.add_word_timestamps(
                    shim,
                    [segmented[i]],
                    tokenizer,
                    encoder_output,
                    [sizes[i]],
                    opts["prepend_punctuations"],
                    opts["append_punctuations"],
                    0.0,
                )

        result: dict[int, list[Any]] = {}
        for i in indices:
            segments = [
                ops.Segment(
                    id=n + 1,
                    seek=seg["seek"],
                    start=round(seg["start"], 3),
                    end=round(seg["end"], 3),
                    text=seg["text"],
                    tokens=seg["tokens"],
                    avg_logprob=scored[i]["avg_logprob"],
                    compression_ratio=ops.get_compression_ratio(seg["text"]),
                    no_speech_prob=scored[i]["no_speech_prob"],
                    words=(
                        [ops.Word(**w) for w in seg.get("words", [])] if word_timestamps else None
                    ),
                    temperature=scored[i]["temperature"],
                )
                for n, seg in enumerate(segmented[i])
            ]
            result[i] = list(
                ops.restore_speech_timestamps(
                    segments, [{"start": 0, "end": len(items[i].audio)}], _SAMPLE_RATE
                )
            )
        return result
