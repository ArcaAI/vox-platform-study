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
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, is_dataclass
from typing import Any

import numpy as np
import structlog

from stt.core import metrics as _metrics
from stt.core.initial_prompt import compose_prompt
from stt.core.metrics import (
    observe_streaming_inference,
    streaming_script_mismatch,
    track_model_inference,
)
from stt.pipeline.dto import InferenceConfig, PostprocessingConfig
from stt.pipeline.language_modes import (
    SCRIPT_MISMATCH_LATIN_RATIO,
    SCRIPT_MISMATCH_MIN_LETTERS,
    is_latin_script_language,
    latin_letter_ratio,
)
from stt.postprocessing.lexicon import LexiconCorrector
from stt.postprocessing.repeat_guard import RepeatGuardConfig, collapse_repeats, config_from_mapping
from stt.streaming.engine_switch import SWITCHABLE_ASR_ERRORS
from stt.streaming.local_agreement_streamer import SEAM_WINDOW_S, seam_repeat_len
from stt.streaming.preprocessor import AudioUtterance
from stt.streaming.redis_streams import ResultPublisher
from stt.streaming.schemas import SegmentResult

logger = structlog.get_logger(__name__)
_MAX_SEGMENT_TEXT_CHARS = 1200

# TASK-985 §7 — call sites for series the observability lane (D7) defines. Resolved
# by name so this file never fails to import against a metrics module that has not
# landed them yet, and never DEFINES one (a metric with two definitions has two
# label sets). `None` means "not defined yet": the structured log line beside each
# call site carries the same facts in the meantime.
_record_prompt_budget = getattr(_metrics, "streaming_prompt_budget", None)
_record_repeat_guard = getattr(_metrics, "streaming_repeat_guard", None)
_record_seam_dedup = getattr(_metrics, "streaming_seam_dedup", None)
_record_lexicon_correction = getattr(_metrics, "streaming_lexicon_correction", None)
_record_punctuation_fallback = getattr(_metrics, "streaming_punctuation_fallback", None)

_HALLUCINATION_RMS_THRESHOLD = 0.01
_HALLUCINATION_SHORT_WORD_COUNT = 3
# Ceiling for the post-final English-gloss translate pass.
_GLOSS_TIMEOUT_S = 15.0
# Default budget a final may wait for Cadence-Fast
# punctuation before the raw text is published (settings-overridable).
_PUNCTUATION_TIMEOUT_S = 0.4
# TASK-985 M-41 — consecutive punctuation time-outs after which the stage is
# stood down for the rest of the session. `asyncio.wait_for` abandons the WAIT,
# never the thread: a model that misses its budget keeps a CPU thread running to
# completion behind every subsequent final, on the same cores the decoder needs.
# The 2026-09-19 run timed out on EVERY final, so a session that has missed three
# in a row is paying that cost for a result that never arrives.
_PUNCTUATION_TIMEOUT_STAND_DOWN = 3

# TASK-985 M-09 / D3 §4.3 — the prompt window, in TOKENS.
#
# Whisper's decoder reserves half its text context for the prompt:
# `sample_len = n_text_ctx // 2` and `max_prefix_len = n_ctx // 2 - sample_len`
# (openai/whisper `decoding.py`), and `n_text_ctx` is 448 on every Whisper
# checkpoint size — so the budget is 224. That is an ARCHITECTURE fact about the
# model, not a configuration value, which is why it may be stated here at all;
# it is nevertheless only the FALLBACK. When the engine adapter can answer from
# the loaded context (`whisper_n_text_ctx(ctx) // 2`) that answer wins, because a
# derived number cannot go stale against a model that changes it.
_WHISPER_N_TEXT_CTX = 448

# Fallback token estimate, used ONLY when the engine exposes no tokenizer. Whisper's
# BPE is byte-level, so a strict upper bound is one token per UTF-8 byte; that bound
# is far too pessimistic for Latin text, which merges heavily. These two rates are
# calibrated against the measurement in TASK-985 M-09 (50 Malayalam words composed
# to ~833 tokens, i.e. ~0.9 tokens per UTF-8 byte) and against Whisper's published
# ~4-characters-per-token for English. Both OVER-estimate on purpose: the budget is
# a safety net, and an over-estimate evicts carry-forward that would have fitted,
# while an under-estimate evicts the priming prompt the session was configured with.
_ASCII_TOKENS_PER_CHAR = 0.25
_NON_ASCII_TOKENS_PER_BYTE = 1.0

# Declared range of `prevTextContextWords` (`asr-model-profile.ts`), restated so an
# out-of-range value coming from an older resolver is clamped with a named cause
# rather than silently composing a 200-word carry-forward.
_PREV_TEXT_CONTEXT_WORDS_MAX = 200

# TASK-985 QW-10 (a) — longest leading n-gram the FINAL-publish seam guard will
# drop. The truly duplicated audio at a force-emit boundary is the carry overlap
# (120 ms smart split / 500 ms hard split, ~1-3 words); a longer match across a
# seam is a phrase the speaker repeated, which is content.
_SEAM_MAX_WORDS = 3

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
        # TASK-985 D5-N7 — the PARTIAL path gets a width-1 corrector: single-token
        # terms only. `_best_at` prefers wider windows first, so a single-word
        # correction made at partial N can be superseded by a phrase correction at
        # N+1, mutating characters the commit policy has already counted as stable.
        # Phrase terms are therefore corrected on FINALS only. When the configured
        # list holds no phrase term (every seeded term today is single-token) the
        # two correctors are the SAME object and the partial path pays nothing new.
        self._partial_lexicon_corrector = self._build_lexicon_corrector(
            postprocessing_config, single_token_only=True
        )
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
        # TASK-985 M-41 — stand-down state for a punctuation model that never
        # meets its budget. Counted, not guessed: a single slow final is normal.
        self._punctuation_consecutive_timeouts: int = 0
        self._punctuation_stood_down: bool = False
        # TASK-985 M-41 — publish the final RAW, then republish it punctuated as a
        # follow-up frame (the `gloss` shape). OFF unless the resolved spec asks
        # for it: the follow-up is a NEW wire frame, and every consumer of
        # `stt:result:{id}` — gateway relay, SDK, playground — has to know the
        # type before it can be emitted, which is a contract change no lane in
        # this wave owns. With it off the final path is byte-identical to today.
        # Read strictly: only a real `True` turns it on. `getattr` on a test
        # double answers a truthy stand-in for every name, and a wire contract
        # that can be switched on by accident is not a contract.
        _republish = getattr(self._punctuation_config, "republish_after_publish", False)
        self._republish_punctuated: bool = _republish is True
        # TASK-985 QW-10 (c) — the n-gram repeat guard. Absent config means "the
        # spec said nothing", which is the module default, never "off".
        _guard_raw = getattr(postprocessing_config, "repeat_guard", None)
        _guard_typed = is_dataclass(_guard_raw) or isinstance(_guard_raw, Mapping)
        self._repeat_guard: RepeatGuardConfig = (
            config_from_mapping(_guard_raw) if _guard_typed else None
        ) or RepeatGuardConfig()
        self.repeat_guard_drop_count: int = 0
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
        # TASK-985 N-1 — which optional kwargs the CURRENT engine callable accepts,
        # probed ONCE by signature per callable. Replaces the blanket
        # `except TypeError` that used to re-decode prompt-less and publish the
        # result as if it were normal.
        self._kwarg_probe_target: Any = None
        self._kwarg_probe_result: frozenset[str] = frozenset()
        # TASK-985 M-09 / D3 §4.3 — the prompt token budget, derived from the
        # loaded model when the adapter can answer and memoised per callable.
        self._prompt_budget_target: Any = None
        self._prompt_budget_tokens: int = 0
        self._prompt_budget_derived: bool = False
        self._prompt_budget_logged: bool = False
        self._prompt_overflow_warned: bool = False
        #: TASK-985 D4-N3 — the RAW sanitized decode of the most recent partial,
        #: before any lexicon correction. The commit policy must compare THIS: the
        #: lexicon snap is distance-bounded and context-free, so one character of
        #: whisper jitter flips a term in or out of correction between consecutive
        #: partials and the policy reads the flip as a contradiction inside its own
        #: settled region. Published text stays corrected (`apply_display_lexicon`).
        self.last_partial_raw_text: str = ""
        if isinstance(prev_text_context_words, int) and not isinstance(
            prev_text_context_words, bool
        ):
            requested = max(0, prev_text_context_words)
            # The declared range is 0-200. An older resolver, or a hand-written row,
            # can still deliver more; clamp with a named cause rather than composing
            # a carry-forward the model cannot hold (M-09).
            self._prev_text_context_words = min(requested, _PREV_TEXT_CONTEXT_WORDS_MAX)
            if requested != self._prev_text_context_words:
                logger.warning(
                    "stt.streaming.prev_text_context_words.clamped",
                    requested=requested,
                    applied=self._prev_text_context_words,
                    maximum=_PREV_TEXT_CONTEXT_WORDS_MAX,
                )
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
        # TASK-985 N-1 — probe the engine's signature HERE, at bind time, so a
        # mismatch is one WARNING at session start rather than a quiet
        # prompt-less transcript for forty minutes.
        if self._asr_pipeline is not None:
            self._asr_accepted_kwargs()

    @staticmethod
    def _build_lexicon_corrector(
        postprocessing_config: PostprocessingConfig | None,
        single_token_only: bool = False,
    ) -> LexiconCorrector | None:
        """Build the session's clinical-vocabulary corrector, or ``None``.

        TASK-935 — the terms are the resolved hotwords (``instruction.hotwords``,
        bound onto the config by ``pipeline_spec_from_resolved``), so a session with
        no configured vocabulary builds nothing and pays nothing.

        TASK-985 D5-N7 — ``single_token_only`` narrows the list to width-1 terms for
        the partial path. Narrowing the TERM LIST rather than the matcher keeps the
        matcher itself untouched: a corrector built over single-token terms can only
        ever make width-1 corrections, by construction.
        """
        lexicon = postprocessing_config.lexicon if postprocessing_config else None
        if lexicon is None or not lexicon.active:
            return None
        terms = list(lexicon.terms)
        if single_token_only:
            terms = [t for t in terms if len(str(t).split()) == 1]
            if not terms:
                return None
        if lexicon.max_distance is not None:
            return LexiconCorrector(terms, max_distance=lexicon.max_distance)
        return LexiconCorrector(terms)

    def apply_display_lexicon(self, text: str, session_id: str, utterance: AudioUtterance) -> str:
        """Correct clinical terms on text that is about to be DISPLAYED.

        TASK-985 D4-N3 — public so the session manager can run the stage AFTER the
        commit decision, on ``policy.published_text``, instead of feeding a
        fuzzily-rewritten hypothesis into the policy's exact-prefix comparison.
        Identical to the internal call; the name states where it belongs in the
        order.
        """
        return self._apply_lexicon(text, session_id, utterance)

    def _apply_lexicon(self, text: str, session_id: str, utterance: AudioUtterance) -> str:
        """Snap configured clinical terms in *text*; log every change.

        The stage returns its corrections rather than logging them (it has no session
        id), so this is where they become observable. DEBUG per correction is
        deliberate: on a busy consultation the stage fires on most utterances, and an
        INFO line per corrected drug name would drown the streaming log.

        Partials use the width-1 corrector (D5-N7); finals use the full one.
        """
        corrector = (
            self._lexicon_corrector if utterance.is_final else self._partial_lexicon_corrector
        )
        if corrector is None or not text.strip():
            return text
        corrected, corrections = corrector.correct(text)
        if not corrections:
            return text
        self.lexicon_correction_count += len(corrections)
        if _record_lexicon_correction is not None:
            _record_lexicon_correction(count=len(corrections), is_final=utterance.is_final)
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

    def _apply_repeat_guard(self, text: str, session_id: str, utterance: AudioUtterance) -> str:
        """Rewind immediate n-gram loops; log and count every rewind.

        TASK-985 QW-10 (c). The stage returns its findings rather than logging
        them (it has no session id) — the same contract as the lexicon.

        The log carries the repeated n-gram itself. That is a deliberate, bounded
        PHI exposure and it is the reason the line is DEBUG: the whole point of
        the counter is to tell a decoder loop ("the the the the") from a clinician
        repeating a drug name, and a count alone cannot. Nothing here reproduces
        the surrounding utterance.
        """
        guarded, report = collapse_repeats(text, self._repeat_guard)
        if not report.changed:
            return text
        self.repeat_guard_drop_count += report.dropped_tokens
        for finding in report.findings:
            logger.debug(
                "stt.postprocessing.repeat_guard.rewind",
                session_id=session_id,
                utterance_index=utterance.utterance_index,
                ngram=finding.ngram,
                ngram_length=finding.length,
                repeats=finding.repeats,
                dropped_tokens=finding.dropped_tokens,
            )
        for phrase in report.stock_phrases_removed:
            logger.info(
                "stt.postprocessing.repeat_guard.stock_phrase",
                session_id=session_id,
                utterance_index=utterance.utterance_index,
                phrase=phrase,
            )
        if _record_repeat_guard is not None:
            _record_repeat_guard(
                dropped_tokens=report.dropped_tokens,
                rewinds=len(report.findings),
                stock_phrases=len(report.stock_phrases_removed),
            )
        return guarded

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

        # Step 2a0: TASK-985 QW-10 (c) — rewind immediate n-gram loops in the
        # decoder's own output. Runs on FINALS only and BEFORE the hallucination
        # gate, which is deliberate on both counts: a final is what the corpus
        # measures (54 exact repeats across 22 % of them) and what persists, while
        # a partial is a re-decode of an open utterance whose text feeds the commit
        # policy's exact-prefix comparison — a new transform there is exactly the
        # instability D4-N3 is about. Collapsing first also lets the filler gate
        # below see "ഉം" rather than "ഉം ഉം ഉം ഉം".
        if utterance.is_final and text:
            text = self._apply_repeat_guard(text, session_id, utterance)

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
        if utterance.is_final:
            if not text.strip():
                # TASK-985 — a final that publishes nothing carries nothing. The
                # old code only ASSIGNED on a non-empty final, so the previous
                # final's words survived a gated or empty one and primed a decode
                # they no longer sit next to in time.
                self._previous_text = ""
            else:
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
        # TASK-985 M-41 — when `republish_after_publish` is on, a final does NOT
        # wait for punctuation at all: it publishes raw and a follow-up frame
        # carries the punctuated text (see `_publish_punctuated`). Partials are
        # unaffected — they were never punctuated by the cadence-fast path.
        defer_punctuation = (
            self._republish_punctuated and utterance.is_final and self._uses_cadence_fast
        )
        if self._punctuation_config and self._punctuation_config.enabled and not defer_punctuation:
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

        # Step 4b: TASK-985 M-41 — the deferred punctuation republish. Same
        # fire-and-forget shape as the gloss, for the same reason: punctuation is
        # a CPU model on the final's publish path, serialized behind the decoder,
        # and the next utterance's partials queue behind it.
        if defer_punctuation and self._publisher is not None and result.text.strip():
            punct_task = asyncio.create_task(
                self._publish_punctuated(session_id, utterance, result),
                name=f"punctuate-{session_id}-{utterance.utterance_index}",
            )
            self._gloss_tasks.add(punct_task)
            punct_task.add_done_callback(self._gloss_tasks.discard)

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

    async def _publish_punctuated(
        self,
        session_id: str,
        utterance: AudioUtterance,
        final_result: SegmentResult,
    ) -> None:
        """Punctuate an already-published final and republish it.

        TASK-985 M-41. The final has already reached the clinician unpunctuated,
        so this pass has no latency budget to protect and runs at the gloss
        ceiling rather than the 0.4 s one. Every failure is swallowed with a log:
        the transcript is already correct, the marks are an improvement.

        The frame is ``type: "punctuated"`` and NOT ``type: "segment"``. A second
        `segment` final with the same ``utterance_index`` would be appended as a
        new line by any consumer that does not coalesce on that ordinal, which is
        every consumer today — the follow-up shape that IS understood is the
        gloss's, and this is its sibling. That is also why the whole path is
        off unless the resolved spec asks for it: the type has to reach the
        gateway relay, the SDK and the playground before it can be emitted, and
        none of those is this lane's to change.
        """
        try:
            punctuated = await self._apply_punctuation(
                final_result.text, is_final=True, deferred=True
            )
        except Exception as exc:
            logger.warning(
                "Deferred punctuation failed (non-fatal)",
                session_id=session_id,
                utterance_index=utterance.utterance_index,
                error=str(exc),
            )
            return
        if self._postprocessing_config and self._postprocessing_config.lowercase:
            punctuated = punctuated.lower()
        if not punctuated.strip() or punctuated == final_result.text:
            return
        republished = SegmentResult(
            text=punctuated,
            english_text=final_result.english_text,
            language=final_result.language,
            start_time=final_result.start_time,
            end_time=final_result.end_time,
            is_final=True,
            word_timestamps=final_result.word_timestamps,
            utterance_index=utterance.utterance_index,
            result_type="punctuated",
            speaker_id=final_result.speaker_id,
            speaker_confidence=final_result.speaker_confidence,
            # Inherit the ORIGINATING final's stamp, not the live worker's: an
            # engine switch can land between the publish and this republish.
            pipeline_id=final_result.pipeline_id,
        )
        try:
            if self._publisher is not None:
                await self._publisher.publish(republished)
                logger.info(
                    "Punctuated final republished",
                    session_id=session_id,
                    utterance_index=utterance.utterance_index,
                )
        except Exception as exc:
            logger.warning(
                "Punctuated republish failed (non-fatal)",
                session_id=session_id,
                utterance_index=utterance.utterance_index,
                error=str(exc),
            )

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

    #: Optional kwargs `_run_inference` will send when the engine accepts them.
    _OPTIONAL_ASR_KWARGS: tuple[str, ...] = ("prompt", "pass_kind")

    def _asr_accepted_kwargs(self) -> frozenset[str]:
        """Which of :data:`_OPTIONAL_ASR_KWARGS` the CURRENT callable accepts.

        TASK-985 N-1. The previous code called the engine with every kwarg and
        caught ``TypeError`` to mean "this engine has no such argument" — but a
        ``TypeError`` raised ANYWHERE inside the decode looks identical, and the
        handler re-decoded **with no prompt and no window** and published the
        result as if it were normal. Every session whose adapter raised a
        ``TypeError`` internally therefore ran silently un-prompted.

        Probing the signature separates the two: a kwarg the engine does not
        declare is never sent, and a ``TypeError`` from inside the decode
        propagates to the caller, which logs it. A ``**kwargs`` callable is taken
        at its word.

        Probed once per callable, at BIND time (construction, and again whenever
        the engine-switch seam swaps ``_asr_pipeline``), with one WARNING naming
        exactly what will not be sent — so a signature mismatch is visible before
        the first utterance rather than inferred from a quiet transcript.
        """
        pipeline = self._asr_pipeline
        if self._kwarg_probe_target is pipeline:
            return self._kwarg_probe_result
        self._kwarg_probe_target = pipeline
        self._kwarg_probe_result = frozenset()
        if pipeline is None:
            return self._kwarg_probe_result
        try:
            params = inspect.signature(pipeline).parameters
        except (TypeError, ValueError):
            # Not introspectable (a C callable, a mock without a signature).
            # Send nothing optional rather than guess.
            logger.warning(
                "stt.streaming.asr_signature.unreadable",
                pipeline_id=self._active_pipeline_id,
                engine=type(pipeline).__name__,
            )
            return self._kwarg_probe_result
        if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
            self._kwarg_probe_result = frozenset(self._OPTIONAL_ASR_KWARGS)
        else:
            self._kwarg_probe_result = frozenset(
                name for name in self._OPTIONAL_ASR_KWARGS if name in params
            )
        missing = [n for n in self._OPTIONAL_ASR_KWARGS if n not in self._kwarg_probe_result]
        if "prompt" in missing:
            logger.warning(
                "stt.streaming.asr_signature.no_prompt",
                pipeline_id=self._active_pipeline_id,
                engine=type(pipeline).__name__,
                missing=missing,
                detail="engine takes no `prompt`; this session decodes unconditioned",
            )
        elif missing:
            logger.debug(
                "stt.streaming.asr_signature",
                pipeline_id=self._active_pipeline_id,
                accepted=sorted(self._kwarg_probe_result),
                missing=missing,
            )
        return self._kwarg_probe_result

    def _prompt_token_budget(self) -> tuple[int, bool]:
        """``(tokens, derived)`` — the prompt window this engine will honour.

        TASK-985 M-09 / D3 §4.3. Preferred source is the ENGINE: an adapter that
        holds a loaded whisper context can answer ``whisper_n_text_ctx(ctx) // 2``
        exactly, which is a derived number and cannot go stale against a model
        that changes it. Falls back to Whisper's architectural 448/2 = 224 when
        the adapter exposes no probe (``derived=False``), which is what every
        current adapter does until the decode lane lands ``prompt_token_budget``.

        Memoised per callable, so an engine switch re-derives.
        """
        pipeline = self._asr_pipeline
        if self._prompt_budget_target is pipeline and self._prompt_budget_tokens:
            return self._prompt_budget_tokens, self._prompt_budget_derived
        self._prompt_budget_target = pipeline
        self._prompt_budget_tokens = _WHISPER_N_TEXT_CTX // 2
        self._prompt_budget_derived = False
        probe = getattr(pipeline, "prompt_token_budget", None)
        if callable(probe):
            try:
                value = probe()
            except Exception as exc:  # a diagnostic must never fail a session
                logger.warning(
                    "stt.streaming.prompt_budget.probe_failed",
                    pipeline_id=self._active_pipeline_id,
                    error=str(exc),
                )
                value = None
            if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                self._prompt_budget_tokens = value
                self._prompt_budget_derived = True
        return self._prompt_budget_tokens, self._prompt_budget_derived

    def _count_prompt_tokens(self, text: str) -> int:
        """Token count for *text* in the engine's own vocabulary, or an estimate.

        Exact when the adapter exposes ``count_prompt_tokens`` (``whisper_tokenize``
        against the loaded context). Otherwise a deliberately PESSIMISTIC estimate:
        Whisper's BPE is byte-level, so non-Latin script costs roughly one token per
        UTF-8 byte while Latin text merges to about a quarter of its characters.
        Over-estimating evicts carry-forward that would have fitted; under-estimating
        evicts the priming prompt the session was configured with, which is the
        failure this whole change exists to stop.
        """
        if not text:
            return 0
        counter = getattr(self._asr_pipeline, "count_prompt_tokens", None)
        if callable(counter):
            try:
                value = counter(text)
            except Exception:
                value = None
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                return value
        ascii_chars = sum(1 for ch in text if ord(ch) < 128)
        non_ascii_bytes = len(text.encode("utf-8")) - ascii_chars
        estimate = (
            ascii_chars * _ASCII_TOKENS_PER_CHAR + non_ascii_bytes * _NON_ASCII_TOKENS_PER_BYTE
        )
        return int(estimate) + 1

    def _compose_bounded_prompt(self, utterance: AudioUtterance) -> str | None:
        """Compose the decoder prompt and hold it inside the model's own window.

        Two rules, both from TASK-985 M-09 / D3 §4.3-4.4:

        1. **Partials carry no previous text.** A partial re-decodes an utterance
           that is still open, roughly every ``partialIntervalMs``; priming each of
           those with the previous final's words is ~10 re-primings per utterance of
           context the final will get anyway, and one bad final then biases an entire
           utterance's worth of partials. (``no_context`` is NOT the lever for this —
           it suppresses the engine's own inter-window ``prompt_past``, which our
           carry-forward never travels; the lever is this argument.)
        2. **The priming/agent prompt is reserved; the carry-forward is truncated
           from the LEFT.** Whisper keeps the LAST tokens of an over-long prompt
           (``all_tokens[nignored:][-remaining_prompt_length:]``), so an over-long
           composition silently evicts its FRONT — which is exactly where the
           configured priming and agent text sit. Composed at ~922 tokens against a
           224-token window, any Malayalam-heavy final evicted the entire configured
           prompt and nothing said so. Spending the remainder on the MOST RECENT
           carry-forward words makes the eviction deterministic and keeps the part
           the tenant configured.

        A priming text that alone exceeds the budget is an author error: it is served
        whole (truncating a configured prompt mid-sentence is worse than serving it)
        and the carry-forward is dropped entirely, with one WARNING per session.
        """
        priming = (self._initial_prompt or "").strip()
        carry = "" if not utterance.is_final else (self._previous_text or "").strip()
        if not priming and not carry:
            return None

        budget, derived = self._prompt_token_budget()
        priming_tokens = self._count_prompt_tokens(priming) if priming else 0

        if priming_tokens > budget:
            if not self._prompt_overflow_warned:
                self._prompt_overflow_warned = True
                logger.warning(
                    "stt.streaming.prompt_budget.priming_over_budget",
                    pipeline_id=self._active_pipeline_id,
                    priming_tokens=priming_tokens,
                    budget_tokens=budget,
                    budget_derived=derived,
                    detail="configured prompt exceeds the model's prompt window on its own",
                )
            self._log_prompt_budget(
                utterance, priming_tokens, 0, budget, derived, evicted_words=len(carry.split())
            )
            return compose_prompt(priming, None)

        remaining = budget - priming_tokens
        words = carry.split()
        # Truncate from the LEFT: the newest words are the useful context. Token
        # count is monotone in the number of trailing words kept, so the largest
        # fitting suffix is found by bisection — ~8 counts instead of ~200, which
        # matters once `count_prompt_tokens` is the engine's real tokenizer.
        lo, hi = 0, len(words)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self._count_prompt_tokens(" ".join(words[-mid:])) <= remaining:
                lo = mid
            else:
                hi = mid - 1
        kept_words = words[-lo:] if lo else []
        evicted = len(words) - lo
        kept = " ".join(kept_words)
        carry_tokens = self._count_prompt_tokens(kept) if kept else 0
        self._log_prompt_budget(
            utterance, priming_tokens, carry_tokens, budget, derived, evicted_words=evicted
        )
        return compose_prompt(priming or None, kept or None)

    def _log_prompt_budget(
        self,
        utterance: AudioUtterance,
        priming_tokens: int,
        carry_tokens: int,
        budget: int,
        derived: bool,
        evicted_words: int,
    ) -> None:
        """One INFO line per session, then DEBUG only when something was evicted.

        The steady state is silence: a partial fires every ``partialIntervalMs``
        and a line per decode that reports "nothing was dropped" is noise. The
        first composition is worth an INFO because it names the budget and whether
        it was derived from the model or fell back.

        Deliberately carries no text: the prompt contains the previous final, which
        is PHI. Token counts and an eviction count say how much was dropped and from
        where without reproducing any of it.
        """
        fields = {
            "pipeline_id": self._active_pipeline_id,
            "utterance_index": utterance.utterance_index,
            "is_final": utterance.is_final,
            "priming_tokens": priming_tokens,
            "carry_tokens": carry_tokens,
            "budget_tokens": budget,
            "budget_derived": derived,
            "evicted_words": evicted_words,
        }
        if not self._prompt_budget_logged:
            self._prompt_budget_logged = True
            logger.info("stt.streaming.prompt_budget", **fields)
        elif evicted_words:
            logger.debug("stt.streaming.prompt_budget", **fields)
        if evicted_words and _record_prompt_budget is not None:
            _record_prompt_budget(evicted_words=evicted_words, budget_derived=derived)

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
        accepted = self._asr_accepted_kwargs()
        call_kwargs: dict[str, Any] = dict(self._decode_window_kwargs(utterance))
        if "prompt" in accepted:
            call_kwargs["prompt"] = self._compose_bounded_prompt(utterance)
        if "pass_kind" in accepted:
            # TASK-985 QW-8 — the per-pass hook. WHICH pass this is belongs to the
            # worker (it owns `is_final`); WHAT each pass decodes with belongs to the
            # engine adapter, which already holds the resolved `decoding.partial` /
            # `decoding.final` blocks and merges them over the flat block. Nothing is
            # sent until an engine declares the parameter, so an adapter that has not
            # landed its half sees today's call exactly.
            call_kwargs["pass_kind"] = "final" if utterance.is_final else "partial"

        # Time the per-utterance ASR inference. Two series on purpose:
        # `stt_streaming_inference_latency_seconds` is the unlabelled streaming
        # history, and the shared `model_inference_latency_seconds{service,model}`
        # carries the engine/model label the streaming series lacks (M-20).
        _asr_start = time.monotonic()
        # NOTE: no `except TypeError` here. It used to mean "this engine has no
        # such argument", but it caught a `TypeError` from INSIDE the decode just
        # as readily and silently re-ran the utterance with no prompt and no
        # window, publishing that as if it were normal (N-1). Acceptance is now
        # decided by signature above; a `TypeError` from within the decode
        # propagates to `process_utterance`, which logs it.
        with track_model_inference(self._active_pipeline_id or "unknown"):
            result = self._asr_pipeline(
                utterance.samples,
                utterance.sample_rate,
                **call_kwargs,
            )
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
        """Strip words this final repeats from the previous final, at the seam.

        TASK-985 QW-10 (a) + CL-6. Two changes from the force-emit-only rule this
        replaces, both of them forced by measurement:

        * **The window is a seam window, not an overlap test.** The old gate was
          ``overlap_s > 0``: the two finals' audio had to physically overlap.
          Fourteen of the owner's corpus repeats are SEAM ECHOES across finals that
          do not overlap at all, and the only rule in the repo that catches them —
          ``HypothesisBuffer.insert`` — asks a different question: is the seam
          within ``SEAM_WINDOW_S``? That rule is now shared
          (``seam_repeat_len``) rather than re-implemented, so the two can never
          drift. Beyond the window a repeat is speech that genuinely recurred.
        * **The word cap is a constant 3, not a duration scaling.** The old
          ``int(overlap_s * 4.0) + 1`` used ``overlap_s`` as a proxy for how much
          speech was decoded twice. Once the segmentation lane derives
          ``start_time`` from the emitted buffer (D2-N4) the overlap also contains
          the pre-speech ring — ~320 ms of SILENCE — so it stops being that proxy
          and would silently widen the window. 3 is the cap the scaling was
          bounded by anyway, and it is the cap QW-10 (a) states.

        Returns ``(deduped_text, dropped_words)``.
        """
        if not self._last_final_tail:
            return text, []
        # Positive = the two finals' audio overlaps; negative = a gap between them.
        overlap_s = self._last_final_end - utterance.start_time
        if overlap_s <= -SEAM_WINDOW_S:
            return text, []

        tail_words = self._last_final_tail.split()
        current_words = text.split()
        repeat = seam_repeat_len(tail_words, current_words, max_ngram=_SEAM_MAX_WORDS)
        if not repeat:
            return text, []
        if repeat >= len(current_words):
            # The guard never EMPTIES a final. A final reduced to nothing is a
            # deletion, and deletion is already this system's dominant error class
            # (TASK-985 §2.3: 51-53 deletions of ~61 reference words per clip); a
            # short final that happens to repeat the previous one entirely is far
            # more likely a clinician saying the same short thing twice than a
            # decoder echo, and the cost of being wrong is asymmetric.
            return text, []

        dropped_words = current_words[:repeat]
        deduped = " ".join(current_words[repeat:])
        logger.debug(
            "Seam repeat dropped",
            component="POSTPROCESSOR",
            overlap_s=round(overlap_s, 3),
            words_dropped=repeat,
            forced_boundary=overlap_s > 0,
        )
        if _record_seam_dedup is not None:
            _record_seam_dedup(words_dropped=repeat, forced_boundary=overlap_s > 0)
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

    @staticmethod
    def _normalizer_gain(utterance: AudioUtterance) -> float:
        """The peak-normalizer gain applied to ``utterance.samples``, or 1.0.

        TASK-985 CL-5. Read with ``getattr`` so this file does not depend on the
        segmentation lane's field having landed: an utterance without it, and the
        whole batch path, behave exactly as before. A non-positive value would
        turn the division into a sign flip or a crash, so it is refused.
        """
        gain = getattr(utterance, "normalizer_gain", 1.0)
        if isinstance(gain, (int, float)) and not isinstance(gain, bool) and gain > 0:
            return float(gain)
        return 1.0

    def _is_hallucination(self, text: str, utterance: AudioUtterance) -> bool:
        """Detect likely hallucinated output from silence or near-silence audio.

        Returns True when the text appears to be a Whisper hallucination
        rather than genuine speech. Three independent gates run; any one
        trip rejects the text:

        1. Text is *only* filler words / disfluencies ("uh", "um", "...", etc.)
           regardless of energy level. Always on.
        2. Text is very short (<= 3 real words) AND utterance audio energy
           (RMS) is below the silence threshold. Always on.

           TASK-985 CL-5 — the RMS is measured in RAW amplitude, by dividing out
           the peak normalizer's gain. ``utterance.samples`` is what the DECODER
           sees, amplified by up to 20x so a quiet mic stays decodable; this
           threshold is about the ROOM. Without the division a room-tone
           utterance in a quiet room measures ~0.045 against a 0.01 threshold and
           the gate can never fire on exactly the audio it exists to reject.
           ``normalizer_gain`` defaults to 1.0, so a batch utterance and every
           pre-existing test are byte-identical.
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
            rms = float(np.sqrt(np.mean(utterance.samples**2))) / self._normalizer_gain(utterance)
            if rms < self._hallucination_rms_threshold:
                return True

        audio_duration_s = len(utterance.samples) / utterance.sample_rate
        if audio_duration_s > 0:
            words_per_sec = word_count / audio_duration_s
            if words_per_sec > self._hallucination_max_wps:
                return True

        return False

    async def _apply_punctuation(
        self, text: str, is_final: bool = True, deferred: bool = False
    ) -> str:
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
            return await self._apply_cadence_fast_punctuation(text, is_final, deferred=deferred)

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

    async def _apply_cadence_fast_punctuation(
        self, text: str, is_final: bool, deferred: bool = False
    ) -> str:
        """Finals-only, time-boxed Cadence-Fast punctuation.

        Partials are never punctuated. The model call runs in the executor
        (off the hot path) wrapped in ``asyncio.wait_for``; on timeout or
        any exception the RAW text is returned so the final still publishes
        within its latency budget.

        ``deferred`` is the M-41 republish path: the final has already reached
        the clinician, so the pass gets the gloss ceiling instead of the publish
        budget, and it neither observes nor feeds the stand-down — the stand-down
        exists to stop the stage costing publish latency, and here it costs none.
        """
        if not is_final:
            return text
        if self._punctuation_stood_down and not deferred:
            return text
        budget = self._gloss_timeout_s if deferred else self._punctuation_timeout_s
        model_name = self._punctuation_config.model if self._punctuation_config else None
        try:
            from stt.punctuation import service as punctuation_service

            raw_result = await asyncio.wait_for(
                punctuation_service.punctuate(text, model_name=model_name),
                timeout=budget,
            )
        except TimeoutError:
            if not deferred:
                self._note_punctuation_fallback(reason="timeout")
            return text
        except Exception:
            if not deferred:
                self._note_punctuation_fallback(reason="error", exc_info=True)
            return text

        if not deferred:
            self._punctuation_consecutive_timeouts = 0
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
        """Log the raw-text fallback: warn once per session, then debug.

        TASK-985 M-41 — also counts CONSECUTIVE time-outs and stands the stage
        down after :data:`_PUNCTUATION_TIMEOUT_STAND_DOWN` of them.
        ``asyncio.wait_for`` abandons the WAIT, never the thread: the model keeps
        running to completion on a CPU core the decoder needs, behind every
        subsequent final, for a result nobody will read. One slow final is
        normal; three in a row means this model cannot meet this budget on this
        box, and the 2026-09-19 run timed out on every final of every clip.
        """
        log = logger.debug if self._punctuation_fallback_warned else logger.warning
        self._punctuation_fallback_warned = True
        log(
            "Cadence-Fast punctuation unavailable; publishing raw final text",
            reason=reason,
            timeout_s=self._punctuation_timeout_s,
            exc_info=exc_info,
        )
        if _record_punctuation_fallback is not None:
            _record_punctuation_fallback(reason=reason)
        if reason != "timeout":
            self._punctuation_consecutive_timeouts = 0
            return
        self._punctuation_consecutive_timeouts += 1
        if (
            not self._punctuation_stood_down
            and self._punctuation_consecutive_timeouts >= _PUNCTUATION_TIMEOUT_STAND_DOWN
        ):
            self._punctuation_stood_down = True
            logger.warning(
                "stt.streaming.punctuation.stood_down",
                consecutive_timeouts=self._punctuation_consecutive_timeouts,
                timeout_s=self._punctuation_timeout_s,
                model=self._punctuation_config.model if self._punctuation_config else None,
                detail="punctuation disabled for the rest of this session",
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

        # TASK-985 D4-N3 — the RAW sanitized decode, published here for the commit
        # policy. `_apply_lexicon` is a distance-bounded, context-free snap, so one
        # character of whisper jitter flips a term in or out of correction between
        # consecutive partials and `LocalAgreementPolicy` reads that flip as a
        # contradiction inside its own settled region — a rollback that has nothing
        # to do with the audio. The session manager compares THIS and corrects
        # `policy.published_text` afterwards (`apply_display_lexicon`).
        self.last_partial_raw_text = text

        # TASK-935 (OD-2 a) — the correction runs on partials too. A partial is
        # what the clinician is reading while the utterance is still open, so
        # leaving it mis-heard until the final lands (option (c)) leaves the live
        # view wrong for exactly as long as anyone is watching it. Punctuation and
        # disfluency stay finals-only above; this stage does not — but it is
        # narrowed to WIDTH-1 terms here (D5-N7): `_best_at` prefers wider windows,
        # so a single-word correction at partial N can be superseded by a phrase
        # correction at N+1, mutating characters already counted as stable.
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
