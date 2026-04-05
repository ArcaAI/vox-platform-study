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

import re
import time
from dataclasses import dataclass, field
from typing import Any

import structlog

from stt_v2.streaming.preprocessor import AudioUtterance
from stt_v2.streaming.redis_streams import ResultPublisher
from stt_v2.streaming.schemas import SegmentResult

logger = structlog.get_logger(__name__)
_MAX_SEGMENT_TEXT_CHARS = 1200


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
        punctuation_config: Any = None,
    ) -> None:
        self._publisher = result_publisher
        self._asr_pipeline = asr_pipeline
        self._tenant_id = tenant_id
        self._consultation_id = consultation_id
        self._diarization_config = diarization_config
        self._punctuation_config = punctuation_config
        self._punctuation_model: Any | None = None

    @property
    def has_pipeline(self) -> bool:
        """Whether an ASR pipeline is configured."""
        return self._asr_pipeline is not None

    async def process_utterance(
        self,
        session_id: str,
        utterance: AudioUtterance,
    ) -> SegmentResult:
        """Run ASR inference on a single utterance and publish the result.

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
        embedding = None

        try:
            embedding = await self._extract_embedding(utterance)
        except Exception as exc:
            logger.warning(
                "Streaming embedding extraction failed",
                session_id=session_id,
                utterance_index=utterance.utterance_index,
                error=str(exc),
            )

        try:
            inference_out = await self._run_inference(utterance)
        except Exception as exc:
            logger.error(
                "ASR inference failed",
                session_id=session_id,
                utterance_index=utterance.utterance_index,
                error=str(exc),
            )
            inference_out = _InferenceResult()

        text = self._sanitize_text(inference_out.text)
        text = await self._apply_punctuation(text)

        split_timestamps = self._split_phrase_timestamps(
            inference_out.word_timestamps,
        )

        word_timestamps = self._offset_word_timestamps(
            split_timestamps,
            utterance.start_time,
        )

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
        diarization_enabled = bool(
            self._diarization_config and getattr(self._diarization_config, "enabled", False)
        )
        speaker_id, speaker_confidence = await self._identify_with_embedding(embedding, result.text)
        if diarization_enabled and result.text.strip() and not speaker_id:
            # Preserve a speaker marker even when identification cannot
            # confidently resolve to a known profile.
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

        # Publish to Redis result stream
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
        result = self._asr_pipeline(utterance.samples, utterance.sample_rate)

        if hasattr(result, "__await__"):
            result = await result

        # Extract text and word timestamps from pipeline result
        if isinstance(result, dict):
            return _InferenceResult(
                text=result.get("text") or "",
                english_text=result.get("english_text") or result.get("englishText"),
                language=result.get("language") or result.get("detected_language"),
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
            for key in ("start", "start_time"):
                if key in entry and isinstance(entry[key], (int, float)):
                    entry[key] = round(entry[key] + time_offset, 4)
            for key in ("end", "end_time"):
                if key in entry and isinstance(entry[key], (int, float)):
                    entry[key] = round(entry[key] + time_offset, 4)
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
                # Already a single word — pass through as-is
                entry = dict(wt)
                entry["word"] = text
                result.append(entry)
                continue

            # Multi-word phrase — split proportionally
            start = float(wt.get("start", wt.get("start_time", 0.0)))
            end = float(wt.get("end", wt.get("end_time", start)))
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
                        "start_time": round(w_start, 4),
                        "end_time": round(w_end, 4),
                        "confidence": confidence,
                    }
                )
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

        if len(cleaned) > _MAX_SEGMENT_TEXT_CHARS:
            logger.warning(
                "Streaming segment text exceeded max length, truncating",
                original_length=len(cleaned),
                max_length=_MAX_SEGMENT_TEXT_CHARS,
            )
            cleaned = cleaned[:_MAX_SEGMENT_TEXT_CHARS].rstrip()

        return cleaned

    async def _apply_punctuation(self, text: str) -> str:
        """Apply punctuation restoration when configured.

        Current streaming behavior is intentionally a no-op passthrough.
        """
        if text == "":
            return ""
        if text.isspace():
            return text
        if not self._punctuation_config:
            return text
        if not getattr(self._punctuation_config, "enabled", False):
            return text
        return text

    async def _extract_embedding(self, utterance: AudioUtterance) -> Any | None:
        """Extract a speaker embedding for the utterance when diarization is enabled."""
        if not self._tenant_id:
            return None
        if not self._diarization_config or not getattr(self._diarization_config, "enabled", False):
            return None

        min_duration = float(getattr(self._diarization_config, "min_segment_duration_s", 1.0))
        if (utterance.end_time - utterance.start_time) < min_duration:
            return None

        from stt_v2.diarization.embedding_service import get_embedding_service

        embedding_service = get_embedding_service()
        return await embedding_service.extract_from_samples(
            utterance.samples,
            utterance.sample_rate,
            utterance.start_time,
            utterance.end_time,
        )

    async def _identify_with_embedding(
        self,
        embedding: Any | None,
        text: str,
    ) -> tuple[str | None, float | None]:
        """Identify a speaker from a precomputed embedding when possible."""
        if not embedding:
            return None, None
        if not text.strip():
            return None, None
        if not self._tenant_id:
            return None, None
        if not self._diarization_config or not getattr(self._diarization_config, "enabled", False):
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
            if match is None:
                return None, None
            return match.speaker_id, match.confidence
        except Exception as exc:
            logger.warning(
                "Streaming speaker identification with embedding failed",
                tenant_id=self._tenant_id,
                error=str(exc),
            )
            return None, None

    async def _identify_speaker(
        self,
        utterance: AudioUtterance,
        text: str,
    ) -> tuple[str | None, float | None]:
        """Identify speaker for this utterance when diarization is enabled."""
        if not text.strip():
            return None, None
        if not self._tenant_id:
            return None, None
        if not self._diarization_config or not getattr(self._diarization_config, "enabled", False):
            return None, None

        min_duration = float(getattr(self._diarization_config, "min_segment_duration_s", 1.0))
        if (utterance.end_time - utterance.start_time) < min_duration:
            return None, None

        try:
            from stt_v2.diarization.speaker_identifier import get_speaker_identifier

            identifier = get_speaker_identifier()
            match = await identifier.identify_speaker(
                samples=utterance.samples,
                sample_rate=utterance.sample_rate,
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
