"""Streaming inference worker — per-utterance ASR.

Receives :class:`AudioUtterance` objects from the
:class:`StreamingPreprocessor` and runs ASR inference to produce
:class:`SegmentResult` objects.

Design:
- Loads ASR model once (shared across sessions via model cache)
- Runs inference per-utterance (not per-file like batch)
- Publishes results via ``ResultPublisher`` to ``stt:result:{session_id}``
- Handles errors gracefully (publishes error result, never crashes session)
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import structlog

from stt_v2.core.initial_prompt import compose_prompt
from stt_v2.core.metrics import observe_streaming_inference
from stt_v2.pipeline.dto import InferenceConfig, PostprocessingConfig
from stt_v2.streaming.preprocessor import AudioUtterance
from stt_v2.streaming.redis_streams import ResultPublisher
from stt_v2.streaming.schemas import SegmentResult

logger = structlog.get_logger(__name__)
_MAX_SEGMENT_TEXT_CHARS = 1200

_HALLUCINATION_RMS_THRESHOLD = 0.01
_HALLUCINATION_SHORT_WORD_COUNT = 3
# Ceiling for the post-final English-gloss translate pass.
_GLOSS_TIMEOUT_S = 15.0
# Default budget a final may wait for Cadence-Fast
# punctuation before the raw text is published (settings-overridable).
_PUNCTUATION_TIMEOUT_S = 0.4

_BASE_FILLER_FORMS: tuple[str, ...] = (
    "uh",
    "um",
    "ah",
    "oh",
    "hmm",
    "huh",
    "mhm",
    "mm",
    r"oh\s*,?\s*man",
)

# Common Malayalam filler/disfluency forms. Whisper often
# emits these for breath/near-silence in Malayalam audio; on their own they
# carry no content. Multi-character real words never match because the
# pattern must consume the whole string from filler alternates alone.
_MALAYALAM_FILLER_FORMS: tuple[str, ...] = (
    "ഉം",
    "ഉഉം",
    "ഉംം",
    "ആ",
    "ആഹ്",
    "അ",
    "അഹ്",
    "ഏ",
    "ഓ",
    "ഹാ",
    "ഹും",
    "ഹ്ം",
    "മ്മ്",
)


def build_filler_pattern(extra_forms: Sequence[str] | None = None) -> re.Pattern[str]:
    """Build the hallucination filler pattern.

    Matches strings consisting solely of filler/disfluency tokens,
    punctuation, and whitespace. ``extra_forms`` appends additional regex
    alternates (configurable via the
    ``streaming_extra_filler_patterns`` setting).
    """
    forms: list[str] = [*_BASE_FILLER_FORMS, *_MALAYALAM_FILLER_FORMS]
    for form in extra_forms or ():
        stripped = form.strip()
        if stripped:
            forms.append(stripped)
    alternation = "|".join(forms)
    return re.compile(
        rf"^\s*(?:{alternation}|\.\..+|,|\s)*\.?\s*$",
        re.IGNORECASE,
    )


_FILLER_PATTERN = build_filler_pattern()
_DEVANAGARI_SCRIPT_RE = re.compile(r"[\u0900-\u097F]")


@dataclass(frozen=True)
class _InferenceResult:
    """Internal container for ASR inference output."""

    text: str = ""
    english_text: str | None = None
    language: str | None = None
    word_timestamps: list[dict[str, Any]] = field(default_factory=list)


class StreamingInferenceWorker:
    """Runs ASR inference on utterances from the StreamingPreprocessor.

    Parameters
    ----------
    result_publisher:
        :class:`ResultPublisher` instance for publishing results to Redis.
    asr_pipeline:
        An initialized ASR pipeline callable. Accepts float32 numpy array
        and sample rate, returns transcription text. This is kept generic
        to allow plugging in different ASR backends (Optimum ONNX,
        Transformers, Whisper, etc.).
    """

    def __init__(
        self,
        result_publisher: ResultPublisher | None = None,
        asr_pipeline: Any = None,
        tenant_id: str | None = None,
        consultation_id: str | None = None,
        diarization_config: Any = None,
        postprocessing_config: PostprocessingConfig | None = None,
        initial_prompt: str | None = None,
        speaker_identifier: Any = None,
        sortformer_diarizer: Any = None,
        prev_text_context_words: int | None = None,
        max_words_per_second: float | None = None,
        max_segment_text_chars: int | None = None,
        hallucination_rms_threshold: float | None = None,
        hallucination_short_word_count: int | None = None,
        gloss_callable: Any = None,
        gloss_timeout_s: float | None = None,
        embedding_service: Any = None,  # per-pipeline embedding model
    ) -> None:
        self._publisher = result_publisher
        self._asr_pipeline = asr_pipeline
        self._tenant_id = tenant_id
        self._consultation_id = consultation_id
        self._diarization_config = diarization_config
        self._postprocessing_config = postprocessing_config
        self._punctuation_config = (
            postprocessing_config.punctuation
            if postprocessing_config
            else None
        )
        # Direct Cadence-Fast punctuation (finals-only,
        # time-boxed, raw-text fallback).
        self._uses_cadence_fast: bool = self._resolve_uses_cadence_fast()
        self._punctuation_timeout_s: float = self._resolve_punctuation_timeout()
        self._punctuation_fallback_warned: bool = False
        self._hallucination_max_wps: float = (
            float(max_words_per_second)
            if isinstance(max_words_per_second, (int, float))
            and not isinstance(max_words_per_second, bool)
            else InferenceConfig().max_words_per_second
        )
        self._max_segment_text_chars: int = (
            int(max_segment_text_chars)
            if isinstance(max_segment_text_chars, (int, float))
            and not isinstance(max_segment_text_chars, bool)
            else _MAX_SEGMENT_TEXT_CHARS
        )
        self._hallucination_rms_threshold: float = (
            float(hallucination_rms_threshold)
            if isinstance(hallucination_rms_threshold, (int, float))
            and not isinstance(hallucination_rms_threshold, bool)
            else _HALLUCINATION_RMS_THRESHOLD
        )
        self._hallucination_short_word_count: int = (
            int(hallucination_short_word_count)
            if isinstance(hallucination_short_word_count, (int, float))
            and not isinstance(hallucination_short_word_count, bool)
            else _HALLUCINATION_SHORT_WORD_COUNT
        )
        self._filler_pattern = self._resolve_filler_pattern()
        # Opt-in English gloss (task=translate after finals).
        self._gloss_callable = gloss_callable
        self._gloss_timeout_s: float = (
            float(gloss_timeout_s)
            if isinstance(gloss_timeout_s, (int, float))
            and not isinstance(gloss_timeout_s, bool)
            else _GLOSS_TIMEOUT_S
        )
        self._gloss_tasks: set[asyncio.Task[None]] = set()
        self._punctuation_model: Any = None
        self._embedding_service: Any = embedding_service
        self._previous_text: str = ""
        # Force-emit boundary dedup state: the preprocessor's
        # force-emit split carries overlap audio into the continuation (120 ms
        # smart split / 500 ms hard split), so consecutive FINALS overlap in
        # time and the ASR transcribes the carried words twice.
        self._last_final_end: float = 0.0
        self._last_final_tail: str = ""
        self._initial_prompt: str | None = initial_prompt
        self._speaker_identifier = speaker_identifier
        # Self-hosted Streaming Sortformer diarizer. When
        # present (backend == "sortformer" sessions), it REPLACES the embedding
        # SpeakerIdentifier path: frame-level turns are attached to
        # ``result.speaker_id`` on both finals and partials. None keeps the
        # default embedding path byte-for-byte.
        self._sortformer_diarizer = sortformer_diarizer
        # One per-session diarizer instance is shared by the final consume loop
        # and the partial task; the underlying NeMo model is not reentrant, so
        # serialize every forward through a single-slot lock.
        self._sortformer_lock = asyncio.Lock()
        if isinstance(prev_text_context_words, int) and not isinstance(
            prev_text_context_words, bool
        ):
            self._prev_text_context_words = max(0, prev_text_context_words)
        else:
            self._prev_text_context_words = InferenceConfig().prev_text_context_words

    def _resolve_uses_cadence_fast(self) -> bool:
        """Does the effective punctuation model resolve to
        the direct-load ``cadence-fast`` option (exact name match)?

        Per-pipeline ``punctuation.model`` wins; when it is unset the global
        ``punctuation_model_name`` setting decides. Wrapper spellings
        ('Cadence', 'Cadence-Fast') never match — they keep legacy behavior.
        """
        if not self._punctuation_config or not self._punctuation_config.enabled:
            return False
        try:
            from stt_v2.punctuation.cadence_fast import MODEL_NAME as cadence_fast_name
        except Exception:
            return False
        model = self._punctuation_config.model
        if model:
            return bool(model == cadence_fast_name)
        try:
            from stt_v2.core.config.settings import get_settings

            return bool(get_settings().punctuation_model_name == cadence_fast_name)
        except Exception:
            return False

    @staticmethod
    def _resolve_punctuation_timeout() -> float:
        """Resolve the Cadence-Fast punctuation budget.

        ``streaming_punctuation_timeout_s`` bounds how long a final may wait
        for punctuation before the raw text is published. Invalid or
        unavailable settings fall back to the built-in default.
        """
        try:
            from stt_v2.core.config.settings import get_settings

            value = get_settings().streaming_punctuation_timeout_s
        except Exception:
            return _PUNCTUATION_TIMEOUT_S
        if (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and float(value) > 0
        ):
            return float(value)
        return _PUNCTUATION_TIMEOUT_S

    @staticmethod
    def _resolve_filler_pattern() -> re.Pattern[str]:
        """Resolve the hallucination filler pattern, including configured extras.

        ``streaming_extra_filler_patterns`` (pipe-separated
        regex alternates) extends the built-in English + Malayalam forms.
        Invalid patterns or unavailable settings fall back to the default.
        """
        try:
            from stt_v2.core.config.settings import get_settings

            raw = get_settings().streaming_extra_filler_patterns
        except Exception:
            return _FILLER_PATTERN
        if not raw or not isinstance(raw, str):
            return _FILLER_PATTERN
        try:
            return build_filler_pattern(raw.split("|"))
        except re.error as exc:
            logger.warning(
                "Invalid streaming_extra_filler_patterns — using defaults",
                error=str(exc),
            )
            return _FILLER_PATTERN

    @property
    def has_pipeline(self) -> bool:
        """Whether an ASR pipeline is configured."""
        return self._asr_pipeline is not None

    async def process_utterance(
        self,
        session_id: str,
        utterance: AudioUtterance,
    ) -> SegmentResult:
        """Run the per-utterance pipeline.

        Final utterances:   embed + ASR in parallel -> diarize -> publish
        Partial utterances: ASR only -> publish

        Parameters
        ----------
        session_id:
            The streaming session this utterance belongs to.
        utterance:
            The audio utterance to transcribe.

        Returns
        -------
        SegmentResult
            The transcription result (also published to Redis).
        """
        start_ts = time.monotonic()
        utt_duration = round(utterance.end_time - utterance.start_time, 1)

        # Step 1+2: Speaker Embedding + ASR
        try:
            if utterance.is_final:
                logger.debug(
                    "Running embedding + ASR in parallel",
                    session_id=session_id,
                    component="INFERENCE",
                    duration_s=utt_duration,
                    utterance_index=utterance.utterance_index,
                )
                embedding, inference_out = await asyncio.gather(
                    self._extract_embedding(utterance),
                    self._run_inference(utterance),
                )
            else:
                logger.debug(
                    "Running ASR only (partial utterance)",
                    session_id=session_id,
                    component="INFERENCE",
                    duration_s=utt_duration,
                    utterance_index=utterance.utterance_index,
                )
                embedding = None
                inference_out = await self._run_inference(utterance)
        except Exception as exc:
            logger.error(
                "Inference failed",
                session_id=session_id,
                utterance_index=utterance.utterance_index,
                error=str(exc),
            )
            embedding = None
            inference_out = _InferenceResult()

        text = self._sanitize_text(inference_out.text)

        # Step 2a: Hallucination filter — reject filler/silence artifacts
        if self._is_hallucination(text, utterance):
            logger.info(
                "Hallucination filtered",
                session_id=session_id,
                utterance_index=utterance.utterance_index,
                original_text=text,
                hallucination_filtered=True,
            )
            text = ""

        # Step 2a2: force-emit boundary dedup — strip words the
        # previous final already published when this final's audio overlaps it
        # (the carry region). Runs BEFORE the prev-text context update so the
        # Whisper conditioning context does not carry the duplicates either.
        dedup_dropped_words: list[str] = []
        if utterance.is_final and text.strip():
            text, dedup_dropped_words = self._dedup_forced_boundary(text, utterance)

        # Record the boundary state HERE, from the
        # pre-postprocessing text: the next final's dedup input is also
        # pre-postprocessing, so a tail captured after punctuation/disfluency
        # editing would break the suffix/prefix match exactly in pipelines
        # that enable postprocessing.
        if utterance.is_final:
            self._last_final_end = utterance.end_time
            self._last_final_tail = " ".join(text.split()[-12:]) if text.strip() else ""

        if text.strip():
            if self._prev_text_context_words > 0:
                words = text.strip().split()
                self._previous_text = " ".join(
                    words[-self._prev_text_context_words:]
                )
            else:
                self._previous_text = ""

        # Step 2b: Punctuation restoration (postprocessor). Runs before the
        # final is published AND before the gloss task snapshots
        # result.text, so the gloss republish carries the punctuated final.
        # The cadence-fast path is finals-only and time-boxed.
        if self._punctuation_config and self._punctuation_config.enabled:
            logger.debug(
                "Restoring punctuation on transcript",
                session_id=session_id,
                component="POSTPROCESSOR",
                utterance_index=utterance.utterance_index,
            )
            text = await self._apply_punctuation(text, is_final=utterance.is_final)

        # Remove disfluencies
        if self._postprocessing_config and self._postprocessing_config.remove_disfluencies:
            from stt_v2.postprocessing.disfluency import remove_disfluencies

            text = remove_disfluencies(text)

        # Lowercase postprocessing
        if self._postprocessing_config and self._postprocessing_config.lowercase:
            text = text.lower()

        split_timestamps = self._split_phrase_timestamps(
            inference_out.word_timestamps,
        )

        word_timestamps = self._offset_word_timestamps(
            split_timestamps,
            utterance.start_time,
        )

        # Keep word timestamps consistent with the boundary
        # dedup. Match-based (not positional): the sanitizer can delete
        # artifact tokens whose raw timestamp entries survive, so a blind
        # leading-N trim removed the wrong entries.
        if dedup_dropped_words:
            word_timestamps = self._trim_dedup_word_timestamps(
                word_timestamps, dedup_dropped_words
            )

        # Respect word_timestamps config
        if (
            self._postprocessing_config
            and not self._postprocessing_config.timestamps.word_timestamps
        ):
            word_timestamps = []

        elapsed = time.monotonic() - start_ts

        result = SegmentResult(
            text=text,
            english_text=inference_out.english_text,
            start_time=utterance.start_time,
            end_time=utterance.end_time,
            is_final=utterance.is_final,
            word_timestamps=word_timestamps,
            inference_ms=round(elapsed * 1000, 1),
            utterance_index=utterance.utterance_index,
        )

        # Step 3: Speaker Diarization
        if utterance.is_final:
            if self._sortformer_diarizer is not None:
                # Self-hosted Streaming Sortformer path. Attach the
                # longest-turn label to the existing wire field; fail-safe (no
                # crash, no label) when the diarizer degrades. Only diarize when
                # the final carries text — parity with the embedding path.
                if result.text.strip():
                    logger.debug(
                        "Diarizing final with Streaming Sortformer",
                        session_id=session_id,
                        component="SPEAKER_DIARIZATION",
                        utterance_index=utterance.utterance_index,
                    )
                    sortformer_speaker = await self._diarize_utterance_sortformer(utterance)
                    if sortformer_speaker:
                        result.speaker_id = sortformer_speaker
            else:
                logger.debug(
                    "Identifying speaker from embedding",
                    session_id=session_id,
                    component="SPEAKER_DIARIZATION",
                    utterance_index=utterance.utterance_index,
                )
                diarization_enabled = bool(
                    self._diarization_config and getattr(self._diarization_config, "enabled", False)
                )
                speaker_id, speaker_confidence = await self._identify_speaker(
                    embedding, result.text,
                    samples=utterance.samples, sample_rate=utterance.sample_rate,
                )
                if diarization_enabled and result.text.strip() and not speaker_id:
                    speaker_id = "unknown"
                if speaker_id:
                    result.speaker_id = speaker_id
                    if speaker_confidence is not None:
                        result.speaker_confidence = float(speaker_confidence)

        logger.info(
            "Utterance transcribed",
            session_id=session_id,
            utterance_index=utterance.utterance_index,
            text_len=len(text),
            duration_s=round(utterance.end_time - utterance.start_time, 3),
            inference_ms=round(elapsed * 1000, 1),
            is_final=utterance.is_final,
        )

        # Step 4: Publish to Redis result stream
        if self._publisher is not None:
            try:
                await self._publisher.publish(result)
            except Exception as exc:
                logger.error(
                    "Failed to publish result",
                    session_id=session_id,
                    error=str(exc),
                )

        # Step 5: opt-in English gloss. Fire-and-forget
        # AFTER the final is published so final latency is unaffected;
        # failures/timeouts are swallowed inside _publish_gloss.
        if (
            utterance.is_final
            and self._gloss_callable is not None
            and self._publisher is not None
            and result.text.strip()
        ):
            gloss_task = asyncio.create_task(
                self._publish_gloss(session_id, utterance, result),
                name=f"gloss-{session_id}-{utterance.utterance_index}",
            )
            self._gloss_tasks.add(gloss_task)
            gloss_task.add_done_callback(self._gloss_tasks.discard)

        return result

    async def _publish_gloss(
        self,
        session_id: str,
        utterance: AudioUtterance,
        final_result: SegmentResult,
    ) -> None:
        """Translate pass + follow-up ``type: gloss`` result.

        Runs after the final has already been published. Every failure or
        timeout is swallowed with a log — the gloss must never block or
        delay the session.
        """
        try:
            raw = self._gloss_callable(utterance.samples, utterance.sample_rate)
            if hasattr(raw, "__await__"):
                out = await asyncio.wait_for(raw, timeout=self._gloss_timeout_s)
            else:
                out = raw

            if isinstance(out, dict):
                english = str(out.get("text") or "")
            elif isinstance(out, str):
                english = out
            else:
                english = ""
            english = self._sanitize_text(english)
            if not english.strip():
                return

            gloss = SegmentResult(
                text=final_result.text,
                english_text=english,
                start_time=final_result.start_time,
                end_time=final_result.end_time,
                is_final=True,
                utterance_index=utterance.utterance_index,
                result_type="gloss",
            )
            if self._publisher is not None:
                await self._publisher.publish(gloss)
                logger.info(
                    "English gloss published",
                    session_id=session_id,
                    utterance_index=utterance.utterance_index,
                    gloss_len=len(english),
                )
        except Exception as exc:
            logger.warning(
                "Streaming gloss failed (non-fatal)",
                session_id=session_id,
                utterance_index=utterance.utterance_index,
                error=str(exc),
            )

    async def _run_inference(self, utterance: AudioUtterance) -> _InferenceResult:
        """Run the ASR pipeline on utterance samples.

        Returns an ``_InferenceResult`` containing the transcribed text
        and any word-level timestamps provided by the ASR engine.
        """
        if self._asr_pipeline is None:
            logger.debug(
                "No ASR pipeline configured, returning empty text",
                utterance_index=utterance.utterance_index,
            )
            return _InferenceResult()

        # The ASR pipeline can be sync or async. If it's a coroutine,
        # we await it; otherwise we call it directly.
        prompt = compose_prompt(self._initial_prompt, self._previous_text or None)
        # Time the per-utterance ASR inference
        # (stt_v2_streaming_inference_latency_seconds).
        _asr_start = time.monotonic()
        try:
            result = self._asr_pipeline(
                utterance.samples,
                utterance.sample_rate,
                prompt=prompt,
            )
        except TypeError:
            result = self._asr_pipeline(utterance.samples, utterance.sample_rate)

        if hasattr(result, "__await__"):
            result = await result
        observe_streaming_inference(time.monotonic() - _asr_start)

        # Extract text and word timestamps from pipeline result
        if isinstance(result, dict):
            return _InferenceResult(
                text=result.get("text") or "",
                english_text=result.get("english_text"),
                language=result.get("language"),
                word_timestamps=result.get("word_timestamps") or [],
            )
        if isinstance(result, str):
            return _InferenceResult(text=result)

        return _InferenceResult(text=str(result))

    @staticmethod
    def _offset_word_timestamps(
        word_timestamps: list[dict[str, Any]],
        time_offset: float,
    ) -> list[dict[str, Any]]:
        """Shift word timestamps by *time_offset* to make them session-relative."""
        if not word_timestamps or time_offset == 0.0:
            return word_timestamps

        adjusted: list[dict[str, Any]] = []
        for wt in word_timestamps:
            entry = dict(wt)  # shallow copy — immutability
            if "start" in entry and isinstance(entry["start"], (int, float)):
                entry["start"] = round(entry["start"] + time_offset, 4)
            if "end" in entry and isinstance(entry["end"], (int, float)):
                entry["end"] = round(entry["end"] + time_offset, 4)
            adjusted.append(entry)
        return adjusted

    @staticmethod
    def _split_phrase_timestamps(
        word_timestamps: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Split phrase-level timestamps into per-word entries."""
        if not word_timestamps:
            return word_timestamps

        result: list[dict[str, Any]] = []
        for wt in word_timestamps:
            text = (wt.get("word") or wt.get("text") or "").strip()
            words = text.split()
            if len(words) <= 1:
                # Already a single word -- pass through as-is
                entry = dict(wt)
                entry["word"] = text
                result.append(entry)
                continue

            # Multi-word phrase -- split proportionally
            start = float(wt.get("start", 0.0))
            end = float(wt.get("end", start))
            confidence = wt.get("confidence")
            span = end - start
            word_dur = span / len(words) if words else 0.0

            for i, word in enumerate(words):
                w_start = start + i * word_dur
                w_end = start + (i + 1) * word_dur
                result.append({
                    "word": word,
                    "start": round(w_start, 4),
                    "end": round(w_end, 4),
                    "confidence": confidence,
                })
        return result

    def _dedup_forced_boundary(
        self,
        text: str,
        utterance: AudioUtterance,
    ) -> tuple[str, list[str]]:
        """Strip words duplicated across a force-emit boundary.

        Applies only when this final's audio starts BEFORE the previous
        final ended (the preprocessor carry region) — silence-separated
        finals have no time overlap and pass through untouched. The word
        window is capped at 3: the truly duplicated audio is the carry
        overlap (120 ms smart split / 500 ms hard split ≈ 1-3 words), while
        ``overlap_s`` over-measures on smart splits (the previous final's
        ``end_time`` includes post-split audio), so a duration-scaled window
        could eat genuinely repeated phrases. Returns
        ``(deduped_text, dropped_words)``.
        """
        overlap_s = self._last_final_end - utterance.start_time
        if overlap_s <= 0 or not self._last_final_tail:
            return text, []

        from stt_v2.postprocessing.overlap import dedup_overlap

        max_words = min(3, max(1, int(overlap_s * 4.0) + 1))
        deduped = dedup_overlap(self._last_final_tail, text, max_overlap_words=max_words)
        dropped_count = len(text.split()) - len(deduped.split())
        dropped_words = text.split()[:dropped_count] if dropped_count > 0 else []
        if dropped_words:
            logger.debug(
                "Force-emit boundary dedup",
                component="POSTPROCESSOR",
                overlap_s=round(overlap_s, 3),
                words_dropped=len(dropped_words),
            )
        return deduped, dropped_words

    @staticmethod
    def _trim_dedup_word_timestamps(
        word_timestamps: list[dict[str, Any]],
        dropped_words: list[str],
    ) -> list[dict[str, Any]]:
        """Remove the leading timestamp entries for boundary-deduped words.

        Match-based: raw ASR timestamp entries can include artifact tokens the
        sanitizer already removed from the text, so positional trimming cut
        the wrong entries. Each dropped word removes its first matching entry
        (case/punctuation-insensitive) within a bounded leading window;
        non-matching artifact entries are left in place (pre-existing
        sanitizer/timestamp misalignment is out of scope here).
        """

        def _norm(w: str) -> str:
            return w.lower().rstrip(".,!?;:")

        out = list(word_timestamps)
        window = len(dropped_words) + 8
        for word in dropped_words:
            target = _norm(word)
            for i, entry in enumerate(out[:window]):
                if _norm(str(entry.get("word", ""))) == target:
                    del out[i]
                    break
        return out

    def _sanitize_text(self, text: str) -> str:
        """Apply lightweight normalization for streaming transcript quality."""
        cleaned = (text or "").strip()
        if not cleaned:
            return ""

        # Remove pathological chevron spam like ">> >> >> >> ..."
        cleaned = re.sub(r"(?:\s*>>\s*){4,}", " ", cleaned)
        cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()

        # Collapse excessive immediate sentence repeats from degenerate decoding.
        sentences = re.split(r"(?<=[.!?])\s+", cleaned)
        if len(sentences) > 2:
            deduped: list[str] = []
            previous = ""
            duplicate_run = 0
            for sentence in sentences:
                current = sentence.strip()
                if not current:
                    continue
                current_norm = current.lower()
                if current_norm == previous:
                    duplicate_run += 1
                    if duplicate_run >= 2:
                        continue
                else:
                    duplicate_run = 0
                deduped.append(current)
                previous = current_norm
            cleaned = " ".join(deduped) if deduped else cleaned

        # Final cleanup: collapse any remaining multiple spaces
        cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()

        if len(cleaned) > self._max_segment_text_chars:
            logger.warning(
                "Streaming segment text exceeded max length, truncating",
                original_length=len(cleaned),
                max_length=self._max_segment_text_chars,
            )
            cleaned = cleaned[:self._max_segment_text_chars].rstrip()

        return cleaned

    async def _extract_embedding(
        self,
        utterance: AudioUtterance,
    ) -> Any:
        """Extract speaker embedding from utterance audio.

        Returns a SpeakerEmbedding or None if extraction is not applicable.
        """
        if not self._tenant_id:
            return None
        if not self._diarization_config or not getattr(self._diarization_config, "enabled", False):
            return None

        min_duration = float(getattr(self._diarization_config, "min_segment_duration_s", 1.0))
        if (utterance.end_time - utterance.start_time) < min_duration:
            return None

        try:
            # Honor the per-pipeline embedding service
            # when the session assembly injected one; the settings singleton is
            # only the fallback (the per-pipeline model previously reached only
            # the segmentation-refinement path, not this primary extraction).
            emb_service = self._embedding_service
            if emb_service is None:
                from stt_v2.diarization.embedding_service import get_embedding_service

                emb_service = get_embedding_service()
            # Limit to first 5s for embedding quality
            max_samples = int(5.0 * utterance.sample_rate)
            samples = utterance.samples[:max_samples]
            embedding = await emb_service.extract_from_samples(
                samples=samples,
                sample_rate=utterance.sample_rate,
            )
            return embedding
        except Exception as exc:
            logger.warning(
                "Streaming embedding extraction failed",
                tenant_id=self._tenant_id,
                error=str(exc),
            )
            return None

    async def _identify_speaker(
        self,
        embedding: Any,
        text: str,
        samples: np.ndarray | None = None,
        sample_rate: int = 16000,
    ) -> tuple[str | None, float | None]:
        """Identify speaker using a precomputed embedding."""
        if embedding is None:
            return None, None
        if not text.strip():
            return None, None
        if self._speaker_identifier is None:
            return None, None

        try:
            match = await self._speaker_identifier.identify(
                embedding=embedding,
                samples=samples,
                sample_rate=sample_rate,
            )
            if isinstance(match, list):
                if match:
                    return match[0].speaker_id, match[0].speaker_confidence
                return None, None
            return match.speaker_id, match.confidence
        except Exception as exc:
            logger.warning(
                "Streaming speaker identification failed",
                tenant_id=self._tenant_id,
                error=str(exc),
            )
            return None, None

    async def _diarize_utterance_sortformer(
        self, utterance: AudioUtterance
    ) -> str | None:
        """Streaming Sortformer turn label for one utterance window.

        Runs the (self-hosted, injectable) diarizer over the utterance audio and
        returns the ``"S<i>"`` label of the turn with the greatest temporal
        overlap with the window, or ``None`` when the diarizer degraded
        (``applied=False``) or produced no turns. Never raises — the diarizer is
        fail-safe by contract, and this wrapper guards defensively so a wiring
        surprise can never crash the ASR hot path. The forward is offloaded to a
        worker thread (GPU/CPU-bound) to keep the event loop free.
        """
        diarizer = self._sortformer_diarizer
        if diarizer is None:
            return None
        try:
            samples = utterance.samples
            sample_rate = int(utterance.sample_rate)
            # Serialize the shared, non-reentrant diarizer across the partial and
            # final threads — only the forward needs the lock; ``to_turns``
            # runs on a fresh result and touches no shared state.
            async with self._sortformer_lock:
                diarization = await asyncio.to_thread(
                    diarizer.diarize, samples, sample_rate
                )
            if not diarization.applied:
                return None
            threshold = (
                float(getattr(self._diarization_config, "sortformer_threshold", 0.5))
                if self._diarization_config is not None
                else 0.5
            )
            turns = diarization.to_turns(threshold)
            if not turns:
                return None
            return self._max_duration_label(turns)
        except Exception as exc:  # noqa: BLE001 — never crash the hot path
            logger.warning(
                "Streaming sortformer diarization failed",
                tenant_id=self._tenant_id,
                error=type(exc).__name__,
            )
            return None

    @staticmethod
    def _max_duration_label(
        turns: list[tuple[float, float, str]],
    ) -> str | None:
        """Label of the longest turn in the set.

        ``to_turns`` yields contiguous, non-overlapping, buffer-local turns, so
        the dominant speaker of the window is simply the turn of greatest
        duration. Ranking by duration alone keeps the choice independent of the
        model frame-time base vs. the real-audio window length (M2). On a tie the
        earliest turn wins (strict ``>``); an empty set yields ``None``.
        """
        best_label: str | None = None
        best_duration = 0.0
        for start, end, label in turns:
            duration = end - start
            if duration > best_duration:
                best_duration = duration
                best_label = label
        return best_label

    def _is_hallucination(self, text: str, utterance: AudioUtterance) -> bool:
        """Detect likely hallucinated output from silence or near-silence audio.

        Returns True when the text appears to be a Whisper hallucination
        rather than genuine speech. Three independent gates run; any one
        trip rejects the text:

        1. Text is *only* filler words / disfluencies ("uh", "um", "...", etc.)
           regardless of energy level. Always on.
        2. Text is very short (<= 3 real words) AND utterance audio energy
           (RMS) is below the silence threshold. Always on.
        3. Words-per-second above ``inference.max_words_per_second``.
           The default (``1000.0``) is large enough that the gate is
           effectively off; set a realistic value (e.g. ``15.0``) to
           opt in. This avoids silently dropping legitimate fast-playback
           audio (e.g. 3x sped-up dictation) which can exceed any static
           ceiling.
        """
        stripped = text.strip()
        if not stripped:
            return False  # already empty, nothing to filter

        if self._filler_pattern.match(stripped):
            return True

        word_count = len(stripped.split())
        if word_count <= self._hallucination_short_word_count:
            rms = float(np.sqrt(np.mean(utterance.samples ** 2)))
            if rms < self._hallucination_rms_threshold:
                return True

        audio_duration_s = len(utterance.samples) / utterance.sample_rate
        if audio_duration_s > 0:
            words_per_sec = word_count / audio_duration_s
            if words_per_sec > self._hallucination_max_wps:
                return True

        return False

    async def _apply_punctuation(self, text: str, is_final: bool = True) -> str:
        """Postprocessor: Punctuation restoration.

        Legacy registry models (Cadence wrapper) punctuate partials and
        finals, unchanged. The direct ``cadence-fast`` model
        is finals-only and time-boxed: partials pass through untouched, and
        on timeout or error the raw text is returned so the final's publish
        latency budget holds.
        """
        if not text.strip():
            return text
        if not self._punctuation_config or not self._punctuation_config.enabled:
            return text
        if self._uses_cadence_fast:
            return await self._apply_cadence_fast_punctuation(text, is_final)

        try:
            from stt_v2.punctuation import service as punctuation_service

            model_name = self._punctuation_config.model
            raw_result = await punctuation_service.punctuate(text, model_name=model_name)
            result = self._normalize_punctuation_output(raw_result)
            if result != text:
                logger.debug(
                    "Punctuation applied",
                    model=model_name,
                    before=text,
                    after=result,
                )
            return result
        except Exception:
            logger.warning(
                "Punctuation restoration failed, returning original text",
                exc_info=True,
            )
            return text

    async def _apply_cadence_fast_punctuation(self, text: str, is_final: bool) -> str:
        """Finals-only, time-boxed Cadence-Fast punctuation.

        Partials are never punctuated. The model call runs in the executor
        (off the hot path) wrapped in ``asyncio.wait_for``; on timeout or
        any exception the RAW text is returned so the final still publishes
        within its latency budget.
        """
        if not is_final:
            return text
        model_name = (
            self._punctuation_config.model if self._punctuation_config else None
        )
        try:
            from stt_v2.punctuation import service as punctuation_service

            raw_result = await asyncio.wait_for(
                punctuation_service.punctuate(text, model_name=model_name),
                timeout=self._punctuation_timeout_s,
            )
        except TimeoutError:
            self._note_punctuation_fallback(reason="timeout")
            return text
        except Exception:
            self._note_punctuation_fallback(reason="error", exc_info=True)
            return text

        result = self._normalize_punctuation_output(raw_result)
        if result != text:
            logger.debug(
                "Punctuation applied",
                model=model_name or "cadence-fast",
                before=text,
                after=result,
            )
        return result

    def _note_punctuation_fallback(self, reason: str, exc_info: bool = False) -> None:
        """Log the raw-text fallback: warn once per session, then debug."""
        log = (
            logger.debug if self._punctuation_fallback_warned else logger.warning
        )
        self._punctuation_fallback_warned = True
        log(
            "Cadence-Fast punctuation unavailable; publishing raw final text",
            reason=reason,
            timeout_s=self._punctuation_timeout_s,
            exc_info=exc_info,
        )

    @staticmethod
    def _normalize_punctuation_output(text: str) -> str:
        """Normalize model punctuation artifacts for mixed-script output."""
        normalized = (text or "").strip()
        if not normalized:
            return ""

        # Cadence occasionally emits Devanagari danda for English text.
        if "\u0964" in normalized or "\u0965" in normalized:
            script_candidate = normalized.replace("\u0964", "").replace("\u0965", "")
            if not _DEVANAGARI_SCRIPT_RE.search(script_candidate):
                normalized = normalized.replace("\u0965", ".").replace("\u0964", ".")

        # Keep ellipsis while removing accidental over-punctuation.
        normalized = re.sub(r"\.{4,}", "...", normalized)
        normalized = re.sub(r"(?<!\.)\.\.(?!\.)", ".", normalized)
        normalized = re.sub(r"([!?])\.(?=\s|$)", r"\1", normalized)
        normalized = re.sub(r"\s{2,}", " ", normalized).strip()
        return normalized

    async def process_partial(
        self,
        session_id: str,
        utterance: AudioUtterance,
    ) -> SegmentResult:
        """Run ASR-only inference for a partial (non-final) utterance.

        Skips embedding extraction, diarization, punctuation, and
        context carry-forward.  Returns ``SegmentResult(is_final=False)``.
        """
        start_ts = time.monotonic()

        try:
            inference_out = await self._run_inference(utterance)
        except Exception as exc:
            logger.error(
                "Partial ASR inference failed",
                session_id=session_id,
                utterance_index=utterance.utterance_index,
                error=str(exc),
            )
            inference_out = _InferenceResult()

        text = self._sanitize_text(inference_out.text)

        if self._is_hallucination(text, utterance):
            text = ""

        # NOTE: Do NOT update self._previous_text for partials

        # The Streaming Sortformer path diarizes partials too
        # (frame-level turns are available immediately). The embedding path
        # leaves partials unlabeled (speaker_id=None), unchanged. Skip the
        # forward when the partial has no text — it is dropped by the publish
        # gate anyway, so paying a full diarizer forward would be wasted.
        speaker_id: str | None = None
        if self._sortformer_diarizer is not None and text:
            speaker_id = await self._diarize_utterance_sortformer(utterance)

        elapsed = time.monotonic() - start_ts

        return SegmentResult(
            text=text,
            start_time=utterance.start_time,
            end_time=utterance.end_time,
            is_final=False,
            speaker_id=speaker_id,
            speaker_confidence=0.0,
            inference_ms=round(elapsed * 1000, 1),
            utterance_index=utterance.utterance_index,
        )
