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
import inspect
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import structlog

from stt.core.initial_prompt import compose_prompt
from stt.core.metrics import observe_streaming_inference, streaming_script_mismatch
from stt.pipeline.dto import InferenceConfig, PostprocessingConfig
from stt.pipeline.language_modes import (
    SCRIPT_MISMATCH_LATIN_RATIO,
    SCRIPT_MISMATCH_MIN_LETTERS,
    is_latin_script_language,
    latin_letter_ratio,
)
from stt.postprocessing.lexicon import LexiconCorrector
from stt.streaming.engine_switch import SWITCHABLE_ASR_ERRORS
from stt.streaming.preprocessor import AudioUtterance
from stt.streaming.redis_streams import ResultPublisher
from stt.streaming.schemas import SegmentResult

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
        prev_text_context_words: int | None = None,
        max_words_per_second: float | None = None,
        max_segment_text_chars: int | None = None,
        hallucination_rms_threshold: float | None = None,
        hallucination_short_word_count: int | None = None,
        gloss_callable: Any = None,
        gloss_timeout_s: float | None = None,
        embedding_service: Any = None,  # per-pipeline embedding model
        active_pipeline_id: str | None = None,
        max_decode_window_sec: float | None = None,
        language: str | None = None,
    ) -> None:
        self._publisher = result_publisher
        self._asr_pipeline = asr_pipeline
        # The ASR pipeline id that ``_asr_pipeline`` belongs to,
        # stamped onto every SegmentResult this worker constructs. It is
        # reassigned IN THE SAME function body as ``_asr_pipeline`` by the
        # engine-switch seam (``SessionManager._make_switch_controller._apply``)
        # so the two can never disagree about which engine produced a result.
        self._active_pipeline_id = active_pipeline_id
        self._tenant_id = tenant_id
        self._consultation_id = consultation_id
        self._diarization_config = diarization_config
        self._postprocessing_config = postprocessing_config
        self._punctuation_config = (
            postprocessing_config.punctuation if postprocessing_config else None
        )
        # TASK-935 (OD-2 a) — the clinical-vocabulary corrector, built ONCE per session:
        # construction is where every term is keyed and masked, and the partial path
        # cannot afford to redo it per utterance. `None` when the stage cannot fire
        # (disabled, or no configured terms), which is also the fast path.
        self._lexicon_corrector = self._build_lexicon_corrector(postprocessing_config)
        # One INFO record per session naming what the stage was built with: the
        # counter below only proves corrections that fired, and a session whose
        # spec lost its terms upstream would otherwise be indistinguishable from a
        # session with nothing to correct.
        _lex = postprocessing_config.lexicon if postprocessing_config else None
        logger.info(
            "stt.streaming.lexicon.configured",
            pipeline_id=active_pipeline_id,
            enabled=bool(_lex.enabled) if _lex is not None else False,
            term_count=len(_lex.terms) if _lex is not None else 0,
            max_distance=_lex.max_distance if _lex is not None else None,
            active=self._lexicon_corrector is not None,
        )
        #: Corrections applied this session, across partials and finals. Public in the
        #: shape of `cumulative_processing_seconds` — a counter the session manager may
        #: read at teardown; nothing in this class branches on it.
        self.lexicon_correction_count: int = 0
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
            if isinstance(gloss_timeout_s, (int, float)) and not isinstance(gloss_timeout_s, bool)
            else _GLOSS_TIMEOUT_S
        )
        # TASK-946 — the session's PINNED language (`InferenceConfig.language`, which
        # `_language_from_mode` resolved from the agent's language mode). `None` means
        # auto-detect or an unpinned code-switch pair: no pin, so nothing a decode can
        # contradict, and the script guard below stays entirely inert.
        self._language: str | None = (
            language.strip() if isinstance(language, str) and language.strip() else None
        )
        self._expects_latin_script: bool = is_latin_script_language(self._language)
        #: The `status: degraded` frame is sent ONCE per session — the caller needs to
        #: know the session went wrong, not to be told again on every utterance for the
        #: next forty minutes. The metric and the log line still fire per occurrence.
        self._script_mismatch_reported: bool = False
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
        # TASK-934 — the session's own decode window
        # (`AiModel._metadata.asr.maxDecodeWindowSec` →
        # `InferenceConfig.max_decode_window_sec`), asked for per CALL rather
        # than frozen into the engine adapter. `None` = the row declared
        # nothing, so the adapter's own default stands and no window is passed.
        self._max_decode_window_sec: float | None = (
            float(max_decode_window_sec)
            if isinstance(max_decode_window_sec, (int, float))
            and not isinstance(max_decode_window_sec, bool)
            else None
        )
        # Memoised "does this engine accept a per-call window?", re-probed
        # whenever the engine-switch seam swaps `_asr_pipeline` underneath us.
        self._window_probe_target: Any = None
        self._window_probe_result: bool = False
        if isinstance(prev_text_context_words, int) and not isinstance(
            prev_text_context_words, bool
        ):
            self._prev_text_context_words = max(0, prev_text_context_words)
        else:
            self._prev_text_context_words = InferenceConfig().prev_text_context_words
        # Running total of ASR-only processing time across
        # every utterance this worker has transcribed. Read by SessionManager
        # at teardown (`_build_teardown_summary`) to compute the streaming
        # real-time factor. Only successful `_run_inference` calls add to it
        # (a raised exception never reaches that call's own timing code).
        self.cumulative_processing_seconds: float = 0.0
        # TASK-959 §4.2 — bytes the CLOUD ASR adapters reported moving, in the
        # same public shape: monotonic counters the session manager snapshots at
        # every engine-switch boundary and at teardown, so a fallback leg's
        # network cost lands on the engine that incurred it. A self-hosted engine
        # never writes them, which is why they stay 0 with `last_byte_source`
        # None — the accumulator reads that absence as "made no third-party call"
        # and emits null byte counts rather than a measured-looking zero.
        self.cumulative_request_bytes: int = 0
        self.cumulative_response_bytes: int = 0
        #: `wire` | `app` — whichever the LIVE engine last reported. Only the
        #: engine currently serving writes it, so the value observed while a span
        #: was open is that span's.
        self.last_byte_source: str | None = None

    @staticmethod
    def _build_lexicon_corrector(
        postprocessing_config: PostprocessingConfig | None,
    ) -> LexiconCorrector | None:
        """Build the session's clinical-vocabulary corrector, or ``None``.

        TASK-935 — the terms are the resolved hotwords (``instruction.hotwords``,
        bound onto the config by ``pipeline_spec_from_resolved``), so a session with
        no configured vocabulary builds nothing and pays nothing.
        """
        lexicon = postprocessing_config.lexicon if postprocessing_config else None
        if lexicon is None or not lexicon.active:
            return None
        if lexicon.max_distance is not None:
            return LexiconCorrector(lexicon.terms, max_distance=lexicon.max_distance)
        return LexiconCorrector(lexicon.terms)

    def _apply_lexicon(self, text: str, session_id: str, utterance: AudioUtterance) -> str:
        """Snap configured clinical terms in *text*; log every change.

        The stage returns its corrections rather than logging them (it has no session
        id), so this is where they become observable. DEBUG per correction is
        deliberate: on a busy consultation the stage fires on most utterances, and an
        INFO line per corrected drug name would drown the streaming log.
        """
        corrector = self._lexicon_corrector
        if corrector is None or not text.strip():
            return text
        corrected, corrections = corrector.correct(text)
        if not corrections:
            return text
        self.lexicon_correction_count += len(corrections)
        for correction in corrections:
            logger.debug(
                "stt.postprocessing.lexicon.correction",
                session_id=session_id,
                utterance_index=utterance.utterance_index,
                is_final=utterance.is_final,
                original=correction.original,
                replacement=correction.replacement,
                score=round(correction.score, 4),
            )
        return corrected

    def _is_script_mismatch(self, text: str) -> bool:
        """Does *text* contradict the session's pinned language?

        Only ever true for a session pinned to a Latin-script language (`en`, `vi`) whose
        decode came back mostly in another script. A Malayalam session is CORRECT in
        Malayalam, and an unpinned session declared no expectation to contradict — both
        return False without looking at the text.

        The length floor matters: below it one foreign proper noun swings the ratio, and
        a one-word final is exactly where a foreign name is legitimate. The ratio floor
        is deliberately generous — the measured failure is 2 % Latin, while a genuinely
        code-mixed clinical line sits far above 50 %.
        """
        if not self._expects_latin_script:
            return False
        if sum(1 for ch in text if ch.isalpha()) < SCRIPT_MISMATCH_MIN_LETTERS:
            return False
        return latin_letter_ratio(text) < SCRIPT_MISMATCH_LATIN_RATIO

    async def _report_script_mismatch(
        self, session_id: str, text: str, utterance: AudioUtterance
    ) -> None:
        """Count it, log it, and tell the caller once.

        Deliberately does NOT carry the text: the log is the only place a transcript can
        be read without decrypting a `ContextItem`, and a WARNING that reproduced the
        garbage would put PHI in it on every bad final. The `latin_ratio` and the
        utterance ordinal are enough to say how bad and from when.
        """
        streaming_script_mismatch()
        logger.warning(
            "stt.streaming.script_mismatch",
            session_id=session_id,
            language=self._language,
            expected_script="latin",
            latin_ratio=round(latin_letter_ratio(text), 3),
            utterance_index=utterance.utterance_index,
            reported=not self._script_mismatch_reported,
        )
        if self._script_mismatch_reported or self._publisher is None:
            return
        self._script_mismatch_reported = True
        publish_degraded = getattr(self._publisher, "publish_degraded", None)
        if publish_degraded is None:
            # A publisher that predates TASK-946 (or a test double) still gets the log
            # and the metric; the session must never fail over a diagnostic.
            return
        try:
            await publish_degraded(
                reason="script_mismatch", utterance_index=utterance.utterance_index
            )
        except Exception as exc:
            logger.warning(
                "stt.streaming.script_mismatch.publish_failed",
                session_id=session_id,
                error=str(exc),
            )

    def _resolve_uses_cadence_fast(self) -> bool:
        """Does the session's punctuation model resolve to the direct-load
        ``cadence-fast`` option (exact name match)?

        TASK-877 — the SPEC's ``models.punctuation.slug`` is the only source. The
        `punctuation_model_name` settings fallback that used to answer this when the
        spec named nothing is deleted: it duplicated the agent's own binding, and
        with no model bound there is no model to characterise. Wrapper spellings
        ('Cadence', 'Cadence-Fast') never match — they keep legacy behavior.
        """
        if not self._punctuation_config or not self._punctuation_config.enabled:
            return False
        model = self._punctuation_config.model
        if not model:
            return False
        try:
            from stt.punctuation.cadence_fast import MODEL_NAME as cadence_fast_name
        except Exception:
            return False
        return bool(model == cadence_fast_name)

    @staticmethod
    def _resolve_punctuation_timeout() -> float:
        """Resolve the Cadence-Fast punctuation budget.

        ``streaming_punctuation_timeout_s`` bounds how long a final may wait
        for punctuation before the raw text is published. Invalid or
        unavailable settings fall back to the built-in default.
        """
        try:
            from stt.core.config.settings import get_settings

            value = get_settings().streaming_punctuation_timeout_s
        except Exception:
            return _PUNCTUATION_TIMEOUT_S
        if isinstance(value, (int, float)) and not isinstance(value, bool) and float(value) > 0:
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
            from stt.core.config.settings import get_settings

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
        except SWITCHABLE_ASR_ERRORS as exc:
            # An ASR-ENGINE failure (cloud auth/quota, model error)
            # must PROPAGATE. The inference loop's handler is the only path to
            # ``EngineSwitchController.record_failure``, i.e. the only way the
            # automatic fallback ever arms; degrading it to an empty transcript
            # here left the session silently quiet on exactly the failure class
            # auto-switch exists for. The loop keeps the session alive either
            # way — it catches this, and on a switch re-runs the utterance on
            # the new engine.
            logger.error(
                "ASR inference failed — propagating for engine-switch evaluation",
                session_id=session_id,
                utterance_index=utterance.utterance_index,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            raise
        except Exception as exc:
            # Everything else still degrades to an empty transcript: swapping
            # engines would not fix it, so raising would only lose utterances
            # that survive today.
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

        # TASK-946 — the decoder carry-forward, with two rules the 2026-09-10 trial paid
        # for. It is taken from FINALS ONLY (a partial is a guess at an utterance still
        # in flight, and priming the next decode with a guess is how a bad hypothesis
        # becomes the session's context), and NEVER from a final that contradicts its own
        # pinned language: once one decode came back in the wrong script, carrying it
        # forward primed the next decode with that script and the collapse sustained
        # itself. Clearing is the intervention — the text itself still publishes.
        script_mismatch = False
        if utterance.is_final and text.strip():
            script_mismatch = self._is_script_mismatch(text)
            if script_mismatch:
                await self._report_script_mismatch(session_id, text, utterance)
            if script_mismatch or self._prev_text_context_words <= 0:
                self._previous_text = ""
            else:
                words = text.strip().split()
                self._previous_text = " ".join(words[-self._prev_text_context_words :])

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
            from stt.postprocessing.disfluency import remove_disfluencies

            text = remove_disfluencies(text)

        # Step 2c: clinical-vocabulary correction. LAST of the
        # text-editing stages, and after disfluency removal on purpose: the corrector
        # must see the words that will actually publish, not tokens a later pass will
        # delete. Lowercasing still runs after it, so a case-folding pipeline folds the
        # correction too.
        text = self._apply_lexicon(text, session_id, utterance)

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
            word_timestamps = self._trim_dedup_word_timestamps(word_timestamps, dedup_dropped_words)

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
            language=inference_out.language,
            start_time=utterance.start_time,
            end_time=utterance.end_time,
            is_final=utterance.is_final,
            word_timestamps=word_timestamps,
            inference_ms=round(elapsed * 1000, 1),
            utterance_index=utterance.utterance_index,
            pipeline_id=self._active_pipeline_id,
        )

        # Step 3: Speaker Diarization
        if utterance.is_final:
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
                embedding,
                result.text,
                samples=utterance.samples,
                sample_rate=utterance.sample_rate,
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
                # Inherit the ORIGINATING final's stamp, not the
                # live worker's: the gloss is fire-and-forget after the final
                # was published, so an engine switch can land in between, and
                # the transcript this gloss republishes came from the final's
                # engine.
                pipeline_id=final_result.pipeline_id,
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

    def _decode_window_kwargs(self, utterance: AudioUtterance) -> dict[str, float]:
        """The decode window to ask this engine for, for THIS utterance.

        TASK-934 — the two windows are independent knobs and they are measured
        apart: on the ml-en fine-tune a FINAL wants short spans (Malayalam CER
        0.381 at 7 s against 0.645 at 30 s) while a PARTIAL wants a long one
        (garbage rate 31 % at 6 s, 0 % at 15 s). The A5 comment that said they
        "MUST match so the last partial and the final decode the SAME audio" is
        therefore retired: they decode different audio on purpose, and the
        handover is covered by `test_task934_decode_window_decoupling.py`.

        * final   → the model's ``maxDecodeWindowSec``: a final carries the whole
          utterance, which is unbounded, and this fine-tune truncates past ~7 s.
        * partial → ``0`` (one span): the preprocessor already trimmed it to the
          model's ``partialWindowSec``, so re-splitting it at the FINAL's window
          would silently reimpose the short window the measurement rejected.

        Empty when the row declared no window or the engine takes no such
        argument — then the adapter's own default stands, unchanged.
        """
        if self._max_decode_window_sec is None:
            return {}
        if not self._asr_accepts_decode_window():
            return {}
        window = self._max_decode_window_sec if utterance.is_final else 0.0
        if utterance.is_final:
            logger.debug(
                "stt.streaming.decode_window",
                component="INFERENCE",
                utterance_index=utterance.utterance_index,
                audio_s=round(utterance.end_time - utterance.start_time, 2),
                max_decode_window_sec=window,
            )
        return {"max_decode_window_sec": window}

    def _asr_accepts_decode_window(self) -> bool:
        """Whether the CURRENT engine callable takes ``max_decode_window_sec``.

        Probed by signature rather than by catching ``TypeError``, which cannot
        tell "this engine has no such argument" from a ``TypeError`` raised
        inside a decode. Re-probed when the engine-switch seam swaps the
        callable.
        """
        pipeline = self._asr_pipeline
        if self._window_probe_target is not pipeline:
            self._window_probe_target = pipeline
            self._window_probe_result = False
            try:
                params = inspect.signature(pipeline).parameters
            except (TypeError, ValueError):
                return False
            self._window_probe_result = "max_decode_window_sec" in params or any(
                p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()
            )
        return self._window_probe_result

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
        window_kwargs = self._decode_window_kwargs(utterance)
        # Time the per-utterance ASR inference
        # (stt_streaming_inference_latency_seconds).
        _asr_start = time.monotonic()
        try:
            result = self._asr_pipeline(
                utterance.samples,
                utterance.sample_rate,
                prompt=prompt,
                **window_kwargs,
            )
        except TypeError:
            result = self._asr_pipeline(utterance.samples, utterance.sample_rate)

        if hasattr(result, "__await__"):
            result = await result
        _elapsed = max(0.0, time.monotonic() - _asr_start)
        observe_streaming_inference(_elapsed)
        self.cumulative_processing_seconds += _elapsed

        # Extract text and word timestamps from pipeline result
        if isinstance(result, dict):
            # TASK-959 §4.2 — a cloud adapter reports what it moved over the wire
            # (or, for the Azure SDK, its application-level proxy). Accumulated
            # here rather than returned on `_InferenceResult` because the consumer
            # is the teardown summary, not the caption path.
            self._accumulate_network_bytes(result)
            return _InferenceResult(
                text=result.get("text") or "",
                english_text=result.get("english_text"),
                language=result.get("language"),
                word_timestamps=result.get("word_timestamps") or [],
            )
        if isinstance(result, str):
            return _InferenceResult(text=result)

        return _InferenceResult(text=str(result))

    def _accumulate_network_bytes(self, result: dict[str, Any]) -> None:
        """Fold one utterance's reported byte counts into the session counters.

        A result with no ``byte_source`` moved nothing over a third-party link
        (every self-hosted engine). The cumulative totals are left alone — they
        are never rewound — but the LABEL is CLEARED, because it names what the
        LIVE engine reports: a session that switches cloud -> self-hosted would
        otherwise hand the self-hosted span a stale ``wire`` at the next boundary
        snapshot, which reads as "a third-party call that moved nothing" instead
        of "no such call". A malformed count is ignored rather than allowed to
        poison a billing counter.
        """
        byte_source = result.get("byte_source")
        if not isinstance(byte_source, str):
            self.last_byte_source = None
            return
        request_bytes = result.get("request_bytes")
        response_bytes = result.get("response_bytes")
        if isinstance(request_bytes, int) and not isinstance(request_bytes, bool):
            self.cumulative_request_bytes += max(0, request_bytes)
        if isinstance(response_bytes, int) and not isinstance(response_bytes, bool):
            self.cumulative_response_bytes += max(0, response_bytes)
        self.last_byte_source = byte_source

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
                result.append(
                    {
                        "word": word,
                        "start": round(w_start, 4),
                        "end": round(w_end, 4),
                        "confidence": confidence,
                    }
                )
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

        from stt.postprocessing.overlap import dedup_overlap

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
            cleaned = cleaned[: self._max_segment_text_chars].rstrip()

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
            # TASK-887 — the session's own embedding service, or nothing. The settings
            # singleton that used to stand in here embedded into a space no agent had
            # chosen and no enrolled profile need live in; a session with embedding
            # diarization on always carries one (`buildResolvedAsrSpec` refuses an agent
            # that enables it without naming a model).
            emb_service = self._embedding_service
            if emb_service is None:
                return None
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
            rms = float(np.sqrt(np.mean(utterance.samples**2)))
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
            from stt.punctuation import service as punctuation_service

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
        model_name = self._punctuation_config.model if self._punctuation_config else None
        try:
            from stt.punctuation import service as punctuation_service

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
        log = logger.debug if self._punctuation_fallback_warned else logger.warning
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

        # TASK-935 (OD-2 a) — the correction runs on partials too. A partial is
        # what the clinician is reading while the utterance is still open, so
        # leaving it mis-heard until the final lands (option (c)) leaves the live
        # view wrong for exactly as long as anyone is watching it. Punctuation and
        # disfluency stay finals-only above; this stage does not.
        text = self._apply_lexicon(text, session_id, utterance)

        # NOTE: Do NOT update self._previous_text for partials

        elapsed = time.monotonic() - start_ts

        return SegmentResult(
            text=text,
            start_time=utterance.start_time,
            end_time=utterance.end_time,
            is_final=False,
            # Partials are never diarized: embedding diarization labels finals only.
            speaker_id=None,
            speaker_confidence=0.0,
            inference_ms=round(elapsed * 1000, 1),
            utterance_index=utterance.utterance_index,
            pipeline_id=self._active_pipeline_id,
        )
