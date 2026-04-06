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
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import structlog

from stt_v2.pipeline.dto import PostprocessingConfig
from stt_v2.streaming.preprocessor import AudioUtterance
from stt_v2.streaming.redis_streams import ResultPublisher
from stt_v2.streaming.schemas import SegmentResult

logger = structlog.get_logger(__name__)
_MAX_SEGMENT_TEXT_CHARS = 1200

# Hallucination filter constants
_HALLUCINATION_RMS_THRESHOLD = 0.01  # ~-40 dBFS -- below this is near-silence
_HALLUCINATION_SHORT_WORD_COUNT = 3  # texts with <= N words on low energy are suspect
_HALLUCINATION_MAX_WPS = 8.0  # max plausible words-per-second (normal speech ~2-4 wps)
_CONTEXT_CARRY_MAX_WORDS = 20  # max words from previous utterance as prompt context
_PARTIAL_TAIL_WINDOW_S = 10.0  # cap Whisper input for partials to last 10s
_FILLER_PATTERN = re.compile(
    r"^\s*(?:uh|um|ah|oh|hmm|huh|mhm|mm|oh\s*,?\s*man|\.\..+|,|\s)*\.?\s*$",
    re.IGNORECASE,
)
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
        self._punctuation_model: Any = None
        self._previous_text: str = ""

    @property
    def has_pipeline(self) -> bool:
        """Whether an ASR pipeline is configured."""
        return self._asr_pipeline is not None

    async def process_utterance(
        self,
        session_id: str,
        utterance: AudioUtterance,
    ) -> SegmentResult:
        """Run the per-utterance pipeline: embed -> ASR -> diarize -> publish.

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

        # Step 1+2: Speaker Embedding + ASR in parallel (no data dependency)
        logger.debug(
            "Running embedding + ASR in parallel",
            session_id=session_id,
            component="INFERENCE",
            duration_s=utt_duration,
            utterance_index=utterance.utterance_index,
        )
        try:
            embedding, inference_out = await asyncio.gather(
                self._extract_embedding(utterance),
                self._run_inference(utterance),
            )
        except Exception as exc:
            logger.error(
                "Parallel embedding+ASR failed",
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

        if text.strip():
            words = text.strip().split()
            self._previous_text = " ".join(words[-_CONTEXT_CARRY_MAX_WORDS:])

        # Step 2b: Punctuation restoration (postprocessor)
        if self._punctuation_config and self._punctuation_config.enabled:
            logger.debug(
                "Restoring punctuation on transcript",
                session_id=session_id,
                component="POSTPROCESSOR",
                utterance_index=utterance.utterance_index,
            )
            text = await self._apply_punctuation(text)

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
        )

        # Step 3: Speaker Diarization (Qdrant lookup with precomputed embedding)
        logger.debug(
            "Identifying speaker from embedding",
            session_id=session_id,
            component="SPEAKER_DIARIZATION",
            utterance_index=utterance.utterance_index,
        )
        diarization_enabled = bool(
            self._diarization_config and getattr(self._diarization_config, "enabled", False)
        )
        speaker_id, speaker_confidence = await self._identify_with_embedding(embedding, result.text)
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

        return result

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
        prompt = self._previous_text or None
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

        if len(cleaned) > _MAX_SEGMENT_TEXT_CHARS:
            logger.warning(
                "Streaming segment text exceeded max length, truncating",
                original_length=len(cleaned),
                max_length=_MAX_SEGMENT_TEXT_CHARS,
            )
            cleaned = cleaned[:_MAX_SEGMENT_TEXT_CHARS].rstrip()

        return cleaned

    async def _identify_speaker(
        self,
        utterance: AudioUtterance,
        text: str,
    ) -> tuple[str | None, float | None]:
        """Identify speaker for this utterance when diarization is enabled.

        Legacy method -- delegates to _extract_embedding + _identify_with_embedding.
        """
        embedding = await self._extract_embedding(utterance)
        return await self._identify_with_embedding(embedding, text)

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

    async def _identify_with_embedding(
        self,
        embedding: Any,
        text: str,
    ) -> tuple[str | None, float | None]:
        """Identify speaker using a precomputed embedding."""
        if embedding is None:
            return None, None
        if not text.strip():
            return None, None
        if not self._tenant_id:
            return None, None
        if self._diarization_config is None:
            return None, None

        try:
            from stt_v2.diarization.speaker_identifier import get_speaker_identifier

            identifier = get_speaker_identifier()
            match = await identifier.identify_with_embedding(
                embedding=embedding,
                tenant_id=self._tenant_id,
                consultation_id=self._consultation_id,
                config=self._diarization_config,
            )
            return match.speaker_id, match.confidence
        except Exception as exc:
            logger.warning(
                "Streaming speaker identification failed",
                tenant_id=self._tenant_id,
                error=str(exc),
            )
            return None, None

    @staticmethod
    def _is_hallucination(text: str, utterance: AudioUtterance) -> bool:
        """Detect likely hallucinated output from silence or near-silence audio.

        Returns True when the text appears to be a Whisper hallucination
        rather than genuine speech.  Two conditions trigger rejection:

        1. Text is *only* filler words / disfluencies ("uh", "um", "...", etc.)
           regardless of energy level.
        2. Text is very short (<= 3 real words) AND utterance audio energy
           (RMS) is below the silence threshold.
        """
        stripped = text.strip()
        if not stripped:
            return False  # already empty, nothing to filter

        # Condition 1: pure filler pattern
        if _FILLER_PATTERN.match(stripped):
            return True

        # Condition 2: short text on near-silence audio
        word_count = len(stripped.split())
        if word_count <= _HALLUCINATION_SHORT_WORD_COUNT:
            rms = float(np.sqrt(np.mean(utterance.samples ** 2)))
            if rms < _HALLUCINATION_RMS_THRESHOLD:
                return True

        # Condition 3: implausible word density (e.g. 50 words from 1.2s audio)
        audio_duration_s = len(utterance.samples) / utterance.sample_rate
        if audio_duration_s > 0:
            words_per_sec = word_count / audio_duration_s
            if words_per_sec > _HALLUCINATION_MAX_WPS:
                return True

        return False

    async def _apply_punctuation(self, text: str) -> str:
        """Postprocessor: Punctuation restoration using Cadence."""
        if not text.strip():
            return text
        if not self._punctuation_config or not self._punctuation_config.enabled:
            return text

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

        # Defense-in-depth: crop to tail window
        max_samples = int(_PARTIAL_TAIL_WINDOW_S * utterance.sample_rate)
        if len(utterance.samples) > max_samples:
            cropped_samples = utterance.samples[-max_samples:]
            utterance = AudioUtterance(
                samples=cropped_samples,
                sample_rate=utterance.sample_rate,
                start_time=utterance.start_time,
                end_time=utterance.end_time,
                utterance_index=utterance.utterance_index,
                is_final=False,
            )

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

        elapsed = time.monotonic() - start_ts

        return SegmentResult(
            text=text,
            start_time=utterance.start_time,
            end_time=utterance.end_time,
            is_final=False,
            speaker_id=None,
            speaker_confidence=0.0,
            inference_ms=round(elapsed * 1000, 1),
        )
