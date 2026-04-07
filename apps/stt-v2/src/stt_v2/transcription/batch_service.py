"""Batch transcription service.

Orchestrates the full transcription pipeline:
    Preprocessing → VAD → ASR Inference → Diarization → Postprocessing

ASR engines supported:
- Whisper family (ONNX via HuggingFace)
- NeMo Parakeet family (HuggingFace)
- Azure Speech Service (per-pipeline API key)
"""

import asyncio
import io
import json
import logging
import os
import tempfile
import threading
import time
import wave
from collections.abc import Callable
from typing import Any

import numpy as np
from azure.cognitiveservices.speech import (
    CancellationReason,
    ResultReason,
    SpeechConfig,
    audio,
    transcription,
)

from ..core.config.settings import get_settings
from ..core.exceptions import (
    CloudASRAuthError,
    CloudASRQuotaError,
    CloudASRTranscriptionError,
    TranscriptionError,
)
from ..core.initial_prompt import compose_prompt, get_initial_prompt
from ..models.azure_speech_loader import normalize_language_for_azure
from ..models.base_loader import LoadedModel
from ..models.cache import get_model_cache
from ..pipeline.config_reader import get_model_reader
from ..pipeline.dto import AiModelFormat, ModelTaskType, PipelineConfig
from .dto import (
    AudioSegment,
    ChunkTranscriptionResult,
    RawTranscription,
    SentenceTimestamp,
    TimingMetrics,
    TranscriptionResult,
    WordTimestamp,
)
from .preprocessing import get_preprocessor

logger = logging.getLogger(__name__)

_CONTEXT_CARRY_MAX_WORDS = 20  # max words from previous segment as prompt context


class BatchTranscriptionService:
    """Service for batch (file) transcription.

    Pipeline: Preprocess → VAD → ASR → Diarization → Postprocess
    """

    # ------------------------------------------------------------------
    # Chunk overlap de-duplication
    # ------------------------------------------------------------------

    @staticmethod
    def _dedup_overlap(
        previous_text: str,
        current_text: str,
        max_overlap_words: int = 12,
    ) -> str:
        """Remove overlapping words between consecutive chunk texts.

        When audio is split with a stride overlap, the ASR engine often
        transcribes the same words at the end of chunk *N* and the start
        of chunk *N+1*.  This method finds the longest matching suffix of
        *previous_text* that matches a prefix of *current_text* and
        returns *current_text* with that prefix stripped.

        Args:
            previous_text: Transcribed text from the previous chunk.
            current_text: Transcribed text from the current chunk.
            max_overlap_words: Maximum number of trailing/leading words to
                compare.  Capped to the stride duration worth of words
                (typically ~12 words for a 6-second stride).

        Returns:
            *current_text* with any duplicated leading words removed.
        """
        if not previous_text or not current_text:
            return current_text

        prev_words = previous_text.split()
        curr_words = current_text.split()

        if not prev_words or not curr_words:
            return current_text

        # Only look at the tail of previous and head of current
        tail = prev_words[-max_overlap_words:]
        head = curr_words[:max_overlap_words]

        # Find longest suffix of tail that matches a prefix of head
        best_overlap = 0
        for length in range(1, min(len(tail), len(head)) + 1):
            suffix = tail[-length:]
            prefix = head[:length]
            # Case-insensitive comparison, strip punctuation for matching
            if [w.lower().rstrip(".,!?;:") for w in suffix] == [
                w.lower().rstrip(".,!?;:") for w in prefix
            ]:
                best_overlap = length

        if best_overlap > 0:
            return " ".join(curr_words[best_overlap:])
        return current_text

    @staticmethod
    def _split_vad_segments_for_embedding(
        segments: list[Any],
        max_window_s: float = 5.0,
    ) -> list[tuple[float, float]]:
        """Split long speech segments into embedding-sized windows.

        Non-speech segments are excluded. Segments shorter than
        *max_window_s* are returned as-is. Longer segments are split
        into consecutive windows of *max_window_s*.
        """
        result: list[tuple[float, float]] = []
        for seg in segments:
            if not getattr(seg, "is_speech", True):
                continue
            start = seg.start_time
            end = seg.end_time
            duration = end - start
            if duration <= max_window_s:
                result.append((start, end))
            else:
                cursor = start
                while cursor < end:
                    window_end = min(cursor + max_window_s, end)
                    result.append((cursor, window_end))
                    cursor = window_end
        return result

    async def transcribe(
        self,
        job_id: str,
        audio_bytes: bytes,
        pipeline_config: PipelineConfig,
        progress_callback: Callable[[int], None] | None = None,
        tenant_id: str | None = None,
        consultation_id: str | None = None,
        chunk_callback: Callable[[ChunkTranscriptionResult], None] | None = None,
        blob_service: Any = None,
    ) -> TranscriptionResult:
        """
        Transcribe audio file with optional speaker diarization.

        Steps:
        1. Load required models
        2. Preprocess audio (resample, normalize, denoise, VAD)
        3. Run ASR inference (per-segment when VAD active, full-audio otherwise)
        4. Run speaker diarization (if enabled)
        5. Postprocess (timestamps, punctuation)
        6. Return result with timing metrics

        Args:
            job_id: Job ID for tracking
            audio_bytes: Raw audio bytes
            pipeline_config: Pipeline configuration
            progress_callback: Optional callback for progress updates (0-100)
            tenant_id: Tenant for diarization scope (required if diarization enabled)
            consultation_id: Optional consultation context for diarization
            chunk_callback: Optional callback invoked after each sliding-window
                chunk is transcribed, enabling near-real-time partial results.

        Returns:
            TranscriptionResult with timing metrics in metadata["timing"]
        """
        pipeline_start = time.time()
        spec = pipeline_config.spec
        timing = TimingMetrics()

        def update_progress(pct: int) -> None:
            if progress_callback:
                progress_callback(pct)

        try:
            update_progress(5)

            # ----------------------------------------------------------
            # Step 1: Load models
            # ----------------------------------------------------------
            logger.info(f"[{job_id}] Loading models...")
            model_start = time.time()
            models = await self._load_models(pipeline_config)
            timing.model_loading_seconds = time.time() - model_start

            asr_model = models.get("asr")
            vad_model = models.get("vad")
            denoise_model = models.get("denoise")

            if asr_model is None:
                raise TranscriptionError(
                    f"ASR model not loaded for pipeline {pipeline_config.slug}"
                )

            update_progress(20)

            # ----------------------------------------------------------
            # Step 2: Preprocess audio
            # ----------------------------------------------------------
            logger.info(f"[{job_id}] Preprocessing audio...")
            preprocess_start = time.time()
            preprocessor = get_preprocessor()
            processed = await preprocessor.process(
                audio_bytes=audio_bytes,
                config=spec.preprocessing,
                vad_model=vad_model,
                denoise_model=denoise_model,
            )
            timing.preprocessing_seconds = time.time() - preprocess_start

            update_progress(35)

            # ----------------------------------------------------------
            # Step 2b: Pre-extract speaker embeddings (if diarization enabled)
            # ----------------------------------------------------------
            if spec.diarization.enabled and tenant_id and processed.vad_applied and processed.segments:
                try:
                    from ..diarization.embedding_service import EmbeddingService

                    embedding_windows = self._split_vad_segments_for_embedding(
                        processed.segments, max_window_s=5.0,
                    )
                    if embedding_windows:
                        emb_svc = EmbeddingService()
                        batch_audio = []
                        batch_times = []
                        for w_start, w_end in embedding_windows:
                            s_idx = int(w_start * processed.sample_rate)
                            e_idx = int(w_end * processed.sample_rate)
                            batch_audio.append(processed.samples[s_idx:e_idx])
                            batch_times.append((w_start, w_end))
                        await emb_svc.extract_batch(
                            batch_audio, processed.sample_rate, batch_times,
                        )
                except Exception as e:
                    logger.warning(f"[{job_id}] Pre-extraction of embeddings failed (non-fatal): {e}")

            # ----------------------------------------------------------
            # Step 3: Run ASR inference
            # ----------------------------------------------------------
            logger.info(f"[{job_id}] Running ASR inference...")
            inference_start = time.time()

            # Resolve initial prompt from DB if configured
            initial_prompt: str | None = None
            initial_prompt_id = getattr(spec.inference, "initial_prompt", None)
            if initial_prompt_id:
                initial_prompt = await get_initial_prompt(initial_prompt_id)
                if initial_prompt:
                    logger.info(
                        "[%s] Resolved initial_prompt (template=%s, %d chars)",
                        job_id,
                        initial_prompt_id,
                        len(initial_prompt),
                    )

            # TTFW tracker: records wall-clock time when the first
            # transcribed word becomes available (set inside inference).
            first_word_time: list[float] = []  # mutable container for closure

            def _on_first_word() -> None:
                """Record TTFW once, on the first non-empty chunk."""
                if not first_word_time:
                    first_word_time.append(time.time())

            if processed.vad_applied and processed.segments:
                # Per-segment ASR — transcribe each speech segment independently
                # with sub-splitting for segments > chunk_length_s
                raw_result = await self._run_per_segment_inference(
                    processed.samples,
                    processed.sample_rate,
                    processed.segments,
                    asr_model,
                    spec.inference,
                    job_id=job_id,
                    progress_callback=lambda p: update_progress(35 + int(p * 0.4)),
                    chunk_callback=chunk_callback,
                    first_word_hook=_on_first_word,
                    initial_prompt=initial_prompt,
                )
            else:
                # Full-audio ASR (no VAD or no segments detected)
                raw_result = await self._run_inference(
                    processed.samples,
                    processed.sample_rate,
                    asr_model,
                    spec.inference,
                    progress_callback=lambda p: update_progress(35 + int(p * 0.4)),
                    chunk_callback=chunk_callback,
                    first_word_hook=_on_first_word,
                    prompt=compose_prompt(initial_prompt, None),
                )

            timing.inference_seconds = time.time() - inference_start

            # Compute TTFW — actual time from pipeline start to first word
            if first_word_time:
                timing.ttfw_seconds = first_word_time[0] - pipeline_start
            else:
                # Fallback: no text produced — TTFW = total inference
                timing.ttfw_seconds = time.time() - pipeline_start

            # Extract per-segment latencies if available (from per-segment ASR)
            if raw_result.model_output is not None and isinstance(raw_result.model_output, dict):
                timing.segment_latencies = raw_result.model_output.get("segment_latencies", [])

            update_progress(75)

            # ----------------------------------------------------------
            # Step 4: Speaker diarization (if enabled)
            # ----------------------------------------------------------
            diarization_meta: dict[str, Any] = {}
            diarization_start = time.time()

            if spec.diarization.enabled and tenant_id:
                # Build segments list for diarization:
                # Prefer VAD segments, then fallback Silero, then ASR segments
                diarization_segments = raw_result.segments  # default: ASR segments

                if processed.vad_applied and processed.segments:
                    # Use VAD speech segments (more accurate boundaries)
                    diarization_segments = [
                        {
                            "start": seg.start_time,
                            "end": seg.end_time,
                            "text": "",
                            "is_speech": seg.is_speech,
                        }
                        for seg in processed.segments
                        if seg.is_speech
                    ]
                elif not processed.vad_applied:
                    # VAD was not applied — run Silero fallback for diarization
                    logger.warning(
                        f"[{job_id}] Diarization requires VAD but VAD was not applied. "
                        f"Running Silero VAD fallback..."
                    )
                    try:
                        from ..vad.silero_service import get_vad_service

                        vad_svc = get_vad_service()
                        if not vad_svc.is_loaded:
                            await vad_svc.initialize()
                        vad_result = vad_svc.detect_speech(
                            processed.samples,
                            processed.sample_rate,
                        )
                        # USE the fallback segments (not discarded)
                        diarization_segments = [
                            {
                                "start": s.start_time,
                                "end": s.end_time,
                                "text": "",
                                "is_speech": True,
                            }
                            for s in vad_result.segments
                        ]
                        logger.info(
                            f"[{job_id}] Silero VAD fallback: "
                            f"{len(diarization_segments)} segments for diarization"
                        )
                    except Exception as e:
                        logger.warning(f"[{job_id}] VAD fallback failed: {e}")

                logger.info(f"[{job_id}] Running speaker diarization...")
                diarization_raw = RawTranscription(text="", segments=diarization_segments)
                try:
                    diarization_meta = await self._run_diarization(
                        processed.samples,
                        processed.sample_rate,
                        diarization_raw,
                        tenant_id,
                        consultation_id,
                        spec.diarization,
                        pipeline_config,
                    )
                    if diarization_segments is not raw_result.segments:
                        self._attach_speaker_metadata_to_segments(
                            raw_result.segments, diarization_raw.segments
                        )
                except Exception as e:
                    logger.warning(f"[{job_id}] Diarization failed (non-fatal): {e}")

            timing.diarization_seconds = time.time() - diarization_start

            update_progress(85)

            # ----------------------------------------------------------
            # Step 4b: Upload processed audio (before postprocessing)
            # ----------------------------------------------------------
            if blob_service is not None:
                try:
                    await blob_service.upload_processed_audio(
                        audio_bytes=processed.to_bytes() if hasattr(processed, "to_bytes") else audio_bytes,
                        tenant_id=tenant_id,
                        job_id=job_id,
                    )
                except Exception as e:
                    logger.warning(f"[{job_id}] Processed audio upload failed (non-fatal): {e}")

            # ----------------------------------------------------------
            # Step 5: Postprocess
            # ----------------------------------------------------------
            logger.info(f"[{job_id}] Postprocessing...")
            postprocess_start = time.time()
            result = self._postprocess(
                raw_result,
                spec.postprocessing,
                processed.duration_seconds,
            )
            timing.postprocessing_seconds = time.time() - postprocess_start

            # ----------------------------------------------------------
            # Finalize timing and metadata
            # ----------------------------------------------------------
            timing.total_seconds = time.time() - pipeline_start
            result.processing_time_seconds = timing.total_seconds
            result.metadata["job_id"] = job_id
            result.metadata["pipeline"] = pipeline_config.slug
            result.metadata["timing"] = timing
            if diarization_meta:
                result.metadata["diarization"] = diarization_meta

            # Include per-segment results when available (Phase 2.2)
            if (
                raw_result.model_output is not None
                and isinstance(raw_result.model_output, dict)
                and "per_segment_results" in raw_result.model_output
            ):
                per_segment_results = raw_result.model_output["per_segment_results"]
                if isinstance(per_segment_results, list):
                    self._attach_speaker_metadata_to_segments(
                        per_segment_results, raw_result.segments
                    )
                result.metadata["per_segment_results"] = per_segment_results

            update_progress(100)

            logger.info(
                f"[{job_id}] Transcription complete: {len(result.text)} chars, "
                f"{result.processing_time_seconds:.2f}s "
                f"(TTFW={timing.ttfw_seconds:.2f}s, "
                f"preprocess={timing.preprocessing_seconds:.2f}s, "
                f"inference={timing.inference_seconds:.2f}s, "
                f"diarization={timing.diarization_seconds:.2f}s)"
            )

            return result

        except Exception as e:
            logger.error(f"[{job_id}] Transcription failed: {e}")
            raise TranscriptionError(f"Transcription failed: {e}") from e

    async def _run_diarization(
        self,
        samples: np.ndarray,
        sample_rate: int,
        raw_result: RawTranscription,
        tenant_id: str,
        consultation_id: str | None,
        config: Any,
        pipeline_config: PipelineConfig | None = None,
    ) -> dict[str, Any]:
        """Run speaker diarization on transcription segments.

        Uses the pipeline-defined diarization model when available,
        otherwise falls back to the default singleton embedding service.

        Returns metadata dict with speaker info.
        """
        from ..diarization.embedding_service import EmbeddingService
        from ..diarization.speaker_identifier import SpeakerIdentifier, get_speaker_identifier

        # Resolve diarization model — pipeline inline takes precedence
        hf_model_id: str | None = None
        if pipeline_config and pipeline_config.spec.models.diarization:
            diar_ref = pipeline_config.spec.models.diarization
            if diar_ref.is_inline and diar_ref.inline:
                hf_model_id = diar_ref.inline.hf_model_id

        if hf_model_id:
            # Pipeline-specific embedding service
            logger.info("Using pipeline diarization model: %s", hf_model_id)
            emb_service = EmbeddingService(hf_model_id=hf_model_id)
            await emb_service.initialize()
            identifier = SpeakerIdentifier(embedding_service=emb_service)
        else:
            identifier = get_speaker_identifier()

        result = await identifier.diarize_segments(
            samples=samples,
            sample_rate=sample_rate,
            segments=raw_result.segments,
            tenant_id=tenant_id,
            consultation_id=consultation_id,
            config=config,
        )

        if result.applied:
            # Annotate raw_result segments with speaker IDs
            for i, seg in enumerate(result.segments):
                if i < len(raw_result.segments) and seg.speaker_id:
                    raw_result.segments[i]["speaker_id"] = seg.speaker_id
                    raw_result.segments[i]["speaker_confidence"] = seg.speaker_confidence

            return {
                "speakers_detected": result.speakers_detected,
                "new_speakers_created": result.new_speakers_created,
                "speaker_ids": result.get_speaker_ids(),
            }

        return {}

    @staticmethod
    def _segment_overlap(
        start_a: float,
        end_a: float,
        start_b: float,
        end_b: float,
    ) -> float:
        """Return overlap duration (seconds) between two time intervals."""
        return max(0.0, min(end_a, end_b) - max(start_a, start_b))

    def _attach_speaker_metadata_to_segments(
        self,
        per_segment_results: list[dict[str, Any]],
        diarized_segments: list[dict[str, Any]],
    ) -> None:
        """Attach best-effort speaker metadata to per-segment results.

        Diarization annotates ``raw_result.segments`` with ``speaker_id`` and
        ``speaker_confidence``. This helper projects those annotations into
        ``per_segment_results`` by selecting the speaker with the largest time
        overlap for each segment interval.
        """
        if not per_segment_results or not diarized_segments:
            return

        for per_seg in per_segment_results:
            seg_start = float(per_seg.get("start_time", 0.0))
            seg_end = float(per_seg.get("end_time", seg_start))
            if seg_end <= seg_start:
                continue

            best_speaker: str | None = None
            best_overlap = 0.0
            best_confidence: float | None = None

            for diarized in diarized_segments:
                speaker_id = diarized.get("speaker_id")
                if not isinstance(speaker_id, str) or not speaker_id:
                    continue

                diarized_start = float(diarized.get("start", 0.0))
                diarized_end = float(diarized.get("end", diarized_start))
                overlap = self._segment_overlap(
                    seg_start,
                    seg_end,
                    diarized_start,
                    diarized_end,
                )
                if overlap <= 0:
                    continue

                confidence_raw = diarized.get("speaker_confidence")
                confidence: float | None = None
                if isinstance(confidence_raw, (int, float)):
                    confidence = float(confidence_raw)

                if overlap > best_overlap:
                    best_overlap = overlap
                    best_speaker = speaker_id
                    best_confidence = confidence

            if best_speaker:
                per_seg["speaker_id"] = best_speaker
                if best_confidence is not None:
                    per_seg["speaker_confidence"] = round(best_confidence, 4)

    async def _load_models(self, pipeline: PipelineConfig) -> dict[str, LoadedModel | None]:
        """
        Load all models required by pipeline.

        Handles both slug references (from database) and inline model definitions.
        """
        cache = get_model_cache()
        model_reader = get_model_reader()
        model_refs = pipeline.spec.models

        # Get model configs from database for slug references
        slug_refs = model_refs.get_all_slugs()
        model_configs = {}
        if slug_refs:
            model_configs = await model_reader.get_models_for_pipeline(pipeline)

        models: dict[str, LoadedModel | None] = {}

        # Load ASR model (required)
        asr_ref = model_refs.asr
        if asr_ref.is_inline and asr_ref.inline:
            # Inline model definition
            logger.info(f"Loading inline ASR model: {asr_ref.inline.hf_model_id}")
            models["asr"] = await cache.get_or_load_inline(
                asr_ref.inline, ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION
            )
        elif asr_ref.slug:
            # Slug reference from database
            if asr_ref.slug in model_configs:
                models["asr"] = await cache.get_or_load(model_configs[asr_ref.slug])
            else:
                raise TranscriptionError(f"ASR model '{asr_ref.slug}' not found in registry")
        else:
            raise TranscriptionError("ASR model is required but not specified")

        # Load VAD model (optional)
        if model_refs.vad:
            vad_ref = model_refs.vad
            try:
                if vad_ref.is_inline and vad_ref.inline:
                    logger.info(f"Loading inline VAD model: {vad_ref.inline.hf_model_id}")
                    models["vad"] = await cache.get_or_load_inline(
                        vad_ref.inline, ModelTaskType.VOICE_ACTIVITY_DETECTION
                    )
                elif vad_ref.slug and vad_ref.slug in model_configs:
                    models["vad"] = await cache.get_or_load(model_configs[vad_ref.slug])
                else:
                    logger.warning(f"VAD model '{vad_ref.identifier}' not found")
                    models["vad"] = None
            except Exception as e:
                logger.warning(f"Failed to load VAD model: {e}")
                models["vad"] = None
        else:
            models["vad"] = None

        # Load denoise model (optional)
        if model_refs.denoise:
            denoise_ref = model_refs.denoise
            try:
                if denoise_ref.is_inline and denoise_ref.inline:
                    logger.info(f"Loading inline denoise model: {denoise_ref.inline.hf_model_id}")
                    models["denoise"] = await cache.get_or_load_inline(
                        denoise_ref.inline, ModelTaskType.AUDIO_TO_AUDIO
                    )
                elif denoise_ref.slug and denoise_ref.slug in model_configs:
                    models["denoise"] = await cache.get_or_load(model_configs[denoise_ref.slug])
                else:
                    logger.warning(f"Denoise model '{denoise_ref.identifier}' not found")
                    models["denoise"] = None
            except Exception as e:
                logger.warning(f"Failed to load denoise model: {e}")
                models["denoise"] = None
        else:
            models["denoise"] = None

        return models

    @staticmethod
    def _normalize_whisper_offsets(
        offsets: list[dict],
        time_offset: float = 0.0,
    ) -> list[dict[str, Any]]:
        """Convert Whisper offset format to standard word timestamp dicts.

        Whisper's ``processor.decode(output_offsets=True)`` returns::

            [{"text": "Hello", "timestamp": (0.0, 2.5)}, ...]

        But ``_postprocess()`` expects::

            [{"text": "Hello", "start": 0.0, "end": 2.5}, ...]

        This method normalises the format and applies an optional
        ``time_offset`` (used when transcribing audio in chunks so that
        timestamps reflect the position in the full audio, not the chunk).

        Args:
            offsets: List of Whisper offset dicts with ``"timestamp"`` tuples.
            time_offset: Seconds to add to every timestamp (chunk start time).

        Returns:
            List of normalised word timestamp dicts.
        """
        normalized: list[dict[str, Any]] = []
        for entry in offsets:
            ts = entry.get("timestamp", (0.0, 0.0))
            if isinstance(ts, (list, tuple)) and len(ts) == 2:
                start, end = ts
            else:
                start, end = 0.0, 0.0
            # Whisper may return None for the last chunk boundary
            start = (start if start is not None else 0.0) + time_offset
            end = (end if end is not None else start) + time_offset
            word_text = (entry.get("text", "") or "").strip()
            normalized.append(
                {
                    "text": word_text,
                    "word": word_text,
                    "start": start,
                    "end": end,
                    "confidence": 1.0,
                }
            )
        return normalized

    @staticmethod
    def _build_single_segment(
        text: str,
        start_time: float,
        end_time: float,
        english_text: str | None = None,
    ) -> list[dict[str, Any]]:
        """Build a single sentence/segment entry when only full-text output exists."""
        cleaned = text.strip()
        if not cleaned:
            return []

        segment: dict[str, Any] = {
            "text": cleaned,
            "start": start_time,
            "end": end_time,
        }
        if english_text:
            segment["english_text"] = english_text.strip()
        return [segment]

    @staticmethod
    def _decode_whisper_text(processor: Any, generated_ids: Any) -> str:
        """Decode generated token IDs into plain text."""
        return processor.batch_decode(generated_ids, skip_special_tokens=True)[0].strip()

    def _generate_english_translation(
        self,
        model: Any,
        processor: Any,
        inputs: dict[str, Any],
        base_generate_kwargs: dict[str, Any],
    ) -> str | None:
        """Best-effort Whisper translation to English for one segment/chunk."""
        translate_kwargs = {k: v for k, v in base_generate_kwargs.items() if k != "language"}
        translate_kwargs["task"] = "translate"
        translate_kwargs["language"] = "en"

        try:
            translated_ids = model.generate(
                **inputs,
                **translate_kwargs,
            )
            translated = self._decode_whisper_text(processor, translated_ids)
        except Exception as e:
            logger.debug("English translation generation failed: %s", e)
            return None

        return translated or None

    async def _run_per_segment_inference(
        self,
        samples: np.ndarray,
        sample_rate: int,
        segments: list[AudioSegment],
        model: LoadedModel,
        config: Any,
        job_id: str = "",
        progress_callback: Callable[[float], None] | None = None,
        chunk_callback: Callable[[ChunkTranscriptionResult], None] | None = None,
        first_word_hook: Callable[[], None] | None = None,
        initial_prompt: str | None = None,
    ) -> RawTranscription:
        """Run ASR inference on each VAD speech segment independently.

        When a speech segment is longer than ``chunk_length_s``, it is
        sub-split into overlapping sliding windows before transcription.
        This ensures every piece of audio sent to the ASR engine is
        under the Whisper context window limit, and enables near-real-
        time partial results via *chunk_callback*.

        Adjacent chunk texts are de-duplicated to remove repeated words
        caused by the stride overlap.

        Args:
            samples: Full audio as float32 numpy array.
            sample_rate: Sample rate.
            segments: VAD-detected speech segments (``AudioSegment``).
            model: ASR model.
            config: Inference configuration.
            job_id: Job ID for logging.
            progress_callback: Progress reporter (0.0–1.0).
            chunk_callback: Optional callback for near-real-time partial
                results after each chunk.
            first_word_hook: Called once when the first non-empty text is
                produced (for TTFW measurement).

        Returns:
            Merged ``RawTranscription`` with per-segment results.
            ``model_output`` contains ``{"segment_latencies": [...]}``.
        """
        settings = get_settings()
        chunk_length_s = float(settings.transcription_chunk_length_s)
        stride_parts = [int(s.strip()) for s in settings.transcription_stride_length_s.split(",")]
        stride_left = stride_parts[0] if len(stride_parts) >= 1 else 4
        stride_right = stride_parts[1] if len(stride_parts) >= 2 else 2

        all_segments: list[dict[str, Any]] = []
        all_word_timestamps: list[dict[str, Any]] = []
        all_text_parts: list[str] = []
        segment_latencies: list[dict[str, Any]] = []
        per_segment_results: list[dict[str, Any]] = []
        detected_language: str | None = None
        detected_lang_prob: float | None = None
        global_chunk_idx = 0
        first_word_fired = False
        previous_segment_text: str = ""  # carry-forward across segments

        speech_segments = [s for s in segments if s.is_speech]
        original_count = len(speech_segments)

        # TASK-017: Merge adjacent short segments to reduce generate() calls.
        # Each Whisper generate() incurs ~6s encoder overhead regardless of
        # audio length.  Merging 28 segments into ~4-5 chunks cuts total
        # inference time from ~180s to ~40s for 60s audio.
        merge_gap = settings.segment_merge_gap_threshold_s
        if merge_gap > 0 and len(speech_segments) > 1:
            from .segment_merger import merge_vad_segments

            speech_segments = merge_vad_segments(
                speech_segments,
                max_duration_s=chunk_length_s,
                gap_threshold_s=merge_gap,
            )
            if len(speech_segments) < original_count:
                logger.info(
                    "[%s] Segment merge: %d VAD segments → %d inference chunks "
                    "(gap_threshold=%.1fs, max_duration=%.0fs)",
                    job_id,
                    original_count,
                    len(speech_segments),
                    merge_gap,
                    chunk_length_s,
                )

        total = max(len(speech_segments), 1)

        for idx, seg in enumerate(speech_segments):
            start_sample = int(seg.start_time * sample_rate)
            end_sample = int(seg.end_time * sample_rate)
            segment_audio = samples[start_sample:end_sample]

            # Skip segments shorter than 0.25 seconds
            if len(segment_audio) < sample_rate // 4:
                continue

            seg_start_time = time.time()
            seg_text_parts: list[str] = []
            seg_word_ts: list[dict[str, Any]] = []
            seg_segments: list[dict[str, Any]] = []
            previous_chunk_text = ""

            # Compose prompt for this segment (predefined + carry-forward)
            segment_prompt = compose_prompt(initial_prompt, previous_segment_text or None)

            # ---- Sub-split long segments using sliding window ----
            seg_duration_s = seg.duration
            if seg_duration_s > chunk_length_s:
                # Segment exceeds chunk_length_s → sub-split
                stride_s = stride_left + stride_right
                step_s = chunk_length_s - stride_s
                chunk_samples = int(chunk_length_s * sample_rate)
                step_samples = int(step_s * sample_rate)
                sub_offset = 0

                logger.info(
                    "[%s] VAD segment %d (%.1f–%.1fs, %.1fs) exceeds "
                    "chunk_length_s=%.0fs — sub-splitting into ~%d chunks",
                    job_id,
                    idx,
                    seg.start_time,
                    seg.end_time,
                    seg_duration_s,
                    chunk_length_s,
                    max(1, int(np.ceil((len(segment_audio) - chunk_samples) / step_samples)) + 1),
                )

                while sub_offset < len(segment_audio):
                    sub_end = min(sub_offset + chunk_samples, len(segment_audio))
                    sub_audio = segment_audio[sub_offset:sub_end]

                    # Skip sub-chunks shorter than 0.5s
                    if len(sub_audio) < sample_rate // 2:
                        break

                    try:
                        sub_result = await self._run_inference(
                            sub_audio, sample_rate, model, config,
                            prompt=segment_prompt,
                        )
                    except Exception as e:
                        logger.warning(
                            "[%s] ASR failed for sub-chunk of segment %d: %s",
                            job_id,
                            idx,
                            e,
                        )
                        sub_offset += step_samples
                        continue

                    chunk_text = sub_result.text.strip()

                    # Capture language from sub-chunk result
                    if detected_language is None and sub_result.language:
                        detected_language = sub_result.language
                        detected_lang_prob = sub_result.language_probability

                    # De-duplicate overlap with previous chunk
                    if chunk_text and previous_chunk_text:
                        chunk_text = self._dedup_overlap(previous_chunk_text, chunk_text)

                    # Track TTFW
                    if chunk_text and not first_word_fired:
                        first_word_fired = True
                        if first_word_hook:
                            first_word_hook()

                    # Sub-chunk time in global audio timeline
                    sub_start_global = seg.start_time + sub_offset / sample_rate
                    sub_end_global = seg.start_time + sub_end / sample_rate

                    if chunk_text:
                        seg_text_parts.append(chunk_text)
                        previous_chunk_text = (
                            sub_result.text.strip()
                        )  # use original for dedup matching
                        # Update prompt for next sub-chunk with latest text
                        words = sub_result.text.strip().split()
                        carry = " ".join(words[-_CONTEXT_CARRY_MAX_WORDS:])
                        segment_prompt = compose_prompt(initial_prompt, carry)
                        sub_seg: dict[str, Any] = {
                            "text": chunk_text,
                            "start": sub_start_global,
                            "end": sub_end_global,
                        }
                        # Carry english_text from the sub-result segment when code-switching
                        if sub_result.segments:
                            for _s in sub_result.segments:
                                if isinstance(_s, dict) and _s.get("english_text"):
                                    sub_seg["english_text"] = _s["english_text"]
                                    break
                        seg_segments.append(sub_seg)

                    # Offset word timestamps to global timeline
                    time_offset = sub_start_global
                    for wt in sub_result.word_timestamps:
                        if isinstance(wt, dict):
                            wt["start"] = wt.get("start", wt.get("start_time", 0.0)) + time_offset
                            wt["end"] = wt.get("end", wt.get("end_time", 0.0)) + time_offset
                            wt["start_time"] = wt["start"]
                            wt["end_time"] = wt["end"]
                            seg_word_ts.append(wt)

                    # Emit chunk callback
                    is_last_sub = (sub_offset + step_samples) >= len(segment_audio)
                    if chunk_callback:
                        chunk_callback(
                            ChunkTranscriptionResult(
                                chunk_index=global_chunk_idx,
                                text=chunk_text,
                                start_time=sub_start_global,
                                end_time=sub_end_global,
                                is_final=is_last_sub,
                                word_timestamps=sub_result.word_timestamps,
                                vad_segment_index=idx,
                            )
                        )

                    global_chunk_idx += 1
                    sub_offset += step_samples

            else:
                # ---- Short segment: single inference call ----
                try:
                    seg_result = await self._run_inference(
                        segment_audio, sample_rate, model, config,
                        prompt=segment_prompt,
                    )
                except Exception as e:
                    logger.warning(
                        "[%s] ASR failed for segment [%.1f–%.1f]: %s",
                        job_id,
                        seg.start_time,
                        seg.end_time,
                        e,
                    )
                    continue

                chunk_text = seg_result.text.strip()

                # Track TTFW
                if chunk_text and not first_word_fired:
                    first_word_fired = True
                    if first_word_hook:
                        first_word_hook()

                if chunk_text:
                    seg_text_parts.append(chunk_text)

                # Capture language from segment result
                if detected_language is None and seg_result.language:
                    detected_language = seg_result.language
                    detected_lang_prob = seg_result.language_probability

                # Offset segment timestamps to global audio timeline
                time_offset = seg.start_time
                for s in seg_result.segments:
                    if isinstance(s, dict):
                        s["start"] = s.get("start", 0.0) + time_offset
                        s["end"] = s.get("end", 0.0) + time_offset
                        seg_segments.append(s)

                for wt in seg_result.word_timestamps:
                    if isinstance(wt, dict):
                        wt["start"] = wt.get("start", wt.get("start_time", 0.0)) + time_offset
                        wt["end"] = wt.get("end", wt.get("end_time", 0.0)) + time_offset
                        wt["start_time"] = wt["start"]
                        wt["end_time"] = wt["end"]
                        seg_word_ts.append(wt)

                # Emit chunk callback
                if chunk_callback:
                    chunk_callback(
                        ChunkTranscriptionResult(
                            chunk_index=global_chunk_idx,
                            text=chunk_text,
                            start_time=seg.start_time,
                            end_time=seg.end_time,
                            is_final=True,
                            word_timestamps=seg_result.word_timestamps,
                            vad_segment_index=idx,
                        )
                    )
                global_chunk_idx += 1

            # ---- Merge per-segment results ----
            seg_elapsed = time.time() - seg_start_time
            seg_merged_text = " ".join(seg_text_parts)

            segment_latencies.append(
                {
                    "segment_index": idx,
                    "start_time": round(seg.start_time, 4),
                    "end_time": round(seg.end_time, 4),
                    "duration_s": round(seg.duration, 4),
                    "inference_time_s": round(seg_elapsed, 4),
                    "sub_chunks": max(
                        1, global_chunk_idx - (global_chunk_idx - len(seg_text_parts))
                    ),
                }
            )

            # Per-segment result for metadata
            per_segment_results.append(
                {
                    "segment_index": idx,
                    "start_time": round(seg.start_time, 4),
                    "end_time": round(seg.end_time, 4),
                    "text": seg_merged_text,
                    "chunks": len(seg_text_parts),
                }
            )

            if seg_merged_text:
                all_text_parts.append(seg_merged_text)
                # Carry forward last N words for next segment's prompt
                words = seg_merged_text.strip().split()
                previous_segment_text = " ".join(words[-_CONTEXT_CARRY_MAX_WORDS:])
            all_segments.extend(seg_segments)
            all_word_timestamps.extend(seg_word_ts)

            # Language detection is captured in the short-segment path
            # and from sub-chunk results (language comes from _run_inference)

            if progress_callback:
                progress_callback((idx + 1) / total)

        merged_text = " ".join(all_text_parts)

        result = RawTranscription(
            text=merged_text,
            language=detected_language,
            language_probability=detected_lang_prob,
            segments=all_segments,
            word_timestamps=all_word_timestamps,
        )

        # Stash per-segment latencies and results for timing/metadata
        result.model_output = {
            "segment_latencies": segment_latencies,
            "per_segment_results": per_segment_results,
        }

        logger.info(
            "[%s] Per-segment ASR: %d/%d segments transcribed, %d chars, " "%d total chunks",
            job_id,
            len(segment_latencies),
            len(speech_segments),
            len(merged_text),
            global_chunk_idx,
        )

        return result

    async def _run_inference(
        self,
        samples: np.ndarray,
        sample_rate: int,
        model: LoadedModel,
        config: Any,
        progress_callback: Callable[[float], None] | None = None,
        chunk_callback: Callable[[ChunkTranscriptionResult], None] | None = None,
        first_word_hook: Callable[[], None] | None = None,
        prompt: str | None = None,
    ) -> RawTranscription:
        """Run ASR model inference.

        For engines that support sliding-window chunking (Optimum ONNX),
        *chunk_callback* and *first_word_hook* are forwarded so that
        callers receive near-real-time partial results.
        """

        if model.format == AiModelFormat.AZURE_SPEECH:
            return await self._run_azure_speech_inference(
                samples, sample_rate, model, config, progress_callback
            )
        elif model.format in [
            AiModelFormat.SAFETENSOR,
            AiModelFormat.PYTORCH,
            AiModelFormat.CTRANSLATE2,
        ]:
            return await self._run_transformers_inference(
                samples, sample_rate, model, config, progress_callback,
                prompt=prompt,
            )
        elif model.format in [AiModelFormat.ONNX, AiModelFormat.ONNX_OPTIMUM]:
            # Check if loaded with Optimum (has proper processor)
            if model.extra.get("optimum") or model.processor is not None:
                return await self._run_optimum_onnx_inference(
                    samples,
                    sample_rate,
                    model,
                    config,
                    progress_callback,
                    chunk_callback=chunk_callback,
                    first_word_hook=first_word_hook,
                    prompt=prompt,
                )
            return await self._run_onnx_inference(
                samples, sample_rate, model, config, progress_callback
            )
        elif model.format == AiModelFormat.NEMO:
            return await self._run_nemo_inference(
                samples, sample_rate, model, config, progress_callback
            )
        else:
            raise TranscriptionError(f"Unsupported model format: {model.format}")

    async def _run_azure_speech_inference(
        self,
        samples: np.ndarray,
        sample_rate: int,
        model: LoadedModel,
        config: Any,
        progress_callback: Callable[[float], None] | None = None,
    ) -> RawTranscription:
        """Run inference via Azure Cognitive Services Speech API.

        The Azure SDK's ``ConversationTranscriber`` is synchronous and
        thread-blocking, so the heavy work runs inside
        ``asyncio.to_thread`` to avoid stalling the event loop.

        Args:
            samples: Audio as float32 numpy array (normalised to [-1, 1]).
            sample_rate: Sample rate of *samples*.
            model: ``LoadedModel`` whose ``.model`` is a ``SpeechConfig``.
            config: ``InferenceConfig`` from the pipeline spec.
            progress_callback: Optional progress reporter (0.0 – 1.0).

        Returns:
            ``RawTranscription`` with text, language, word timestamps and
            sentence-level segments.

        Raises:
            CloudASRAuthError: Invalid credentials.
            CloudASRQuotaError: Rate-limited / quota exceeded.
            CloudASRTranscriptionError: Any other Azure error.
        """
        speech_config: SpeechConfig = model.model
        code_switching = getattr(config, "code_switching", False)

        # Resolve language from pipeline config
        language = normalize_language_for_azure(getattr(config, "language", None))

        # Run the synchronous Azure transcription in a background thread
        # so we don't block the asyncio event loop.
        result = await asyncio.to_thread(
            self._azure_transcribe_sync,
            speech_config,
            samples,
            sample_rate,
            language,
            code_switching,
        )

        if progress_callback:
            progress_callback(1.0)

        return result

    # ------------------------------------------------------------------
    # Azure helpers (synchronous — called via asyncio.to_thread)
    # ------------------------------------------------------------------

    @staticmethod
    def _azure_transcribe_sync(
        speech_config: Any,
        samples: np.ndarray,
        sample_rate: int,
        language: str,
        code_switching: bool = False,
    ) -> RawTranscription:
        """Synchronous Azure conversation transcription.

        Converts numpy audio to a temporary WAV file, feeds it to the
        Azure ``ConversationTranscriber``, and collects results until
        the session ends.

        When *code_switching* is ``True``, an
        ``AutoDetectSourceLanguageConfig`` is used so Azure can detect
        and switch between languages within the same audio.
        """
        # ---- Convert float32 numpy → in-memory 16-bit PCM WAV -----
        pcm_int16 = (samples * 32767).clip(-32768, 32767).astype(np.int16)
        wav_buffer = io.BytesIO()
        with wave.open(wav_buffer, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(sample_rate)
            wf.writeframes(pcm_int16.tobytes())
        wav_buffer.seek(0)
        wav_bytes = wav_buffer.read()

        # ---- Write WAV to a temp file (Azure SDK requires a path) ---
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.write(wav_bytes)
        tmp.flush()
        tmp.close()

        try:
            # ---- Configure Azure transcriber -----------------------
            speech_config.request_word_level_timestamps()
            speech_config.enable_dictation()

            azure_audio_config = audio.AudioConfig(filename=tmp.name)

            auto_detect_config = None
            if code_switching:
                # Use Azure's auto-detect language feature for code-switching.
                # This allows the transcriber to detect and switch between
                # multiple languages within the same audio stream.
                from azure.cognitiveservices.speech import (
                    AutoDetectSourceLanguageConfig,
                )

                auto_detect_config = AutoDetectSourceLanguageConfig()
                logger.info("Azure code-switching: using AutoDetectSourceLanguageConfig")
            else:
                speech_config.speech_recognition_language = language

            transcriber = transcription.ConversationTranscriber(
                speech_config=speech_config,
                audio_config=azure_audio_config,
                auto_detect_source_language_config=auto_detect_config,
            )

            # ---- Collect results via callbacks ---------------------
            segments: list[dict[str, Any]] = []
            word_timestamps: list[dict[str, Any]] = []
            recognition_done = threading.Event()
            error_holder: list[str] = []

            def _on_transcribed(evt: Any) -> None:
                if evt.result.reason == ResultReason.RecognizedSpeech and evt.result.text.strip():
                    offset_ms = getattr(evt.result, "offset", 0) / 10_000  # ticks → ms
                    duration_ms = getattr(evt.result, "duration", 0) / 10_000

                    seg: dict[str, Any] = {
                        "text": evt.result.text,
                        "start": offset_ms / 1000.0,
                        "end": (offset_ms + duration_ms) / 1000.0,
                        "speaker_id": getattr(evt.result, "speaker_id", None),
                        "confidence": None,
                    }

                    # Try to extract NBest confidence from JSON payload
                    try:
                        if hasattr(evt.result, "json") and evt.result.json:
                            parsed = json.loads(evt.result.json)
                            nbest = parsed.get("NBest", [])
                            if nbest:
                                seg["confidence"] = nbest[0].get("Confidence")
                                # Extract word-level timestamps from NBest
                                for w in nbest[0].get("Words", []):
                                    word_timestamps.append(
                                        {
                                            "text": w.get("Word", ""),
                                            "word": w.get("Word", ""),
                                            "start": w.get("Offset", 0) / 10_000_000,
                                            "end": (w.get("Offset", 0) + w.get("Duration", 0))
                                            / 10_000_000,
                                            "start_time": w.get("Offset", 0) / 10_000_000,
                                            "end_time": (w.get("Offset", 0) + w.get("Duration", 0))
                                            / 10_000_000,
                                            "confidence": w.get("Confidence", 1.0),
                                        }
                                    )
                    except Exception:
                        pass

                    segments.append(seg)

            def _on_session_stopped(evt: Any) -> None:
                recognition_done.set()

            def _on_canceled(evt: Any) -> None:
                if evt.reason == CancellationReason.Error:
                    error_holder.append(
                        f"Azure transcription error: {getattr(evt, 'error_details', 'unknown')}"
                    )
                recognition_done.set()

            transcriber.transcribed.connect(_on_transcribed)
            transcriber.session_stopped.connect(_on_session_stopped)
            transcriber.canceled.connect(_on_canceled)

            # ---- Run transcription --------------------------------
            logger.info(
                "Starting Azure conversation transcription " "(language=%s, code_switching=%s)",
                language,
                code_switching,
            )
            transcriber.start_transcribing_async()

            # Wait with a generous timeout (30 min for very long files)
            if not recognition_done.wait(timeout=1800):
                transcriber.stop_transcribing_async()
                raise CloudASRTranscriptionError("Azure transcription timed out after 30 minutes")

            transcriber.stop_transcribing_async()

            # ---- Handle errors ------------------------------------
            if error_holder:
                err_msg = error_holder[0]
                if "401" in err_msg or "Unauthorized" in err_msg:
                    raise CloudASRAuthError(err_msg)
                if "429" in err_msg or "throttl" in err_msg.lower():
                    raise CloudASRQuotaError(err_msg)
                raise CloudASRTranscriptionError(err_msg)

            # ---- Build result -------------------------------------
            full_text = " ".join(s["text"] for s in segments if s["text"].strip())

            # Compute average confidence
            confidences = [s["confidence"] for s in segments if s["confidence"] is not None]
            avg_confidence = sum(confidences) / len(confidences) if confidences else None

            return RawTranscription(
                text=full_text,
                language=language,
                language_probability=avg_confidence,
                segments=segments,
                word_timestamps=word_timestamps,
            )

        finally:
            os.unlink(tmp.name)

    async def _run_transformers_inference(
        self,
        samples: np.ndarray,
        sample_rate: int,
        model: LoadedModel,
        config: Any,
        progress_callback: Callable[[float], None] | None = None,
        prompt: str | None = None,
    ) -> RawTranscription:
        """Run inference using Transformers/HuggingFace model."""
        import torch

        asr_model = model.model
        processor = model.processor or model.feature_extractor

        if processor is None:
            raise TranscriptionError("Model processor not available")

        # Prepare input
        inputs = processor(
            samples,
            sampling_rate=sample_rate,
            return_tensors="pt",
        )

        # Move to device
        device = model.device
        model_dtype = getattr(asr_model, "dtype", torch.float32)

        # Safety: fp16 / bf16 causes crashes on CPU (dtype mismatch) and
        # on MPS (out-of-range integral conversion in Whisper's generate()).
        # Force float32 for stable autoregressive decoding on non-CUDA.
        # The cast is done IN-PLACE on the LoadedModel so subsequent
        # requests use the already-converted model (no repeated 6 GB copies).
        needs_fp32 = model_dtype in (torch.float16, torch.bfloat16) and str(
            device
        ) in ("cpu", "mps")
        if needs_fp32:
            logger.warning(
                "Model dtype %s on %s is unsafe for generation — "
                "casting model to float32 for stable inference.",
                model_dtype,
                device,
            )
            asr_model = asr_model.float()  # cast all parameters to float32
            model.model = asr_model  # persist in LoadedModel so cache is updated
            model_dtype = torch.float32

        inputs = {
            k: (
                v.to(device=device, dtype=model_dtype)
                if v.is_floating_point()
                else v.to(device=device)
            )
            for k, v in inputs.items()
        }

        outputs = None

        # Generate
        with torch.no_grad():
            # Check if model supports generate (Whisper, Seq2Seq)
            if hasattr(asr_model, "generate"):
                code_switching = getattr(config, "code_switching", False)
                lang = getattr(config, "language", None)

                generate_kwargs: dict[str, Any] = {
                    "task": "transcribe",
                    "return_timestamps": True,
                }

                # When code-switching is enabled, omit language to let
                # Whisper auto-detect per generation, enabling multilingual output.
                if not code_switching and lang is not None:
                    generate_kwargs["language"] = lang

                # Beam search configuration
                beam_size = getattr(config, "beam_size", None)
                if beam_size and beam_size > 1:
                    generate_kwargs["num_beams"] = beam_size

                # Temperature / sampling configuration
                temperature = getattr(config, "temperature", None)
                if temperature is not None and temperature == 0.0:
                    generate_kwargs["do_sample"] = False
                elif temperature is not None:
                    generate_kwargs["do_sample"] = True
                    generate_kwargs["temperature"] = temperature

                # Remove None values
                generate_kwargs = {k: v for k, v in generate_kwargs.items() if v is not None}

                # Inject prompt_ids for Whisper conditioning
                if prompt and hasattr(processor, "get_prompt_ids"):
                    try:
                        prompt_ids = processor.get_prompt_ids(prompt, return_tensors="pt")
                        generate_kwargs["prompt_ids"] = prompt_ids.to(device)
                    except Exception:
                        logger.debug(
                            "Failed to encode prompt_ids for transformers inference",
                            exc_info=True,
                        )

                outputs = asr_model.generate(
                    **inputs,
                    **generate_kwargs,
                )

                # Decode
                transcription = self._decode_whisper_text(processor, outputs)
                english_text: str | None = None
                if code_switching:
                    english_text = self._generate_english_translation(
                        asr_model,
                        processor,
                        inputs,
                        generate_kwargs,
                    )

                # Extract word timestamps
                word_timestamps: list[dict[str, Any]] = []
                try:
                    decoded = processor.decode(
                        outputs[0],
                        skip_special_tokens=False,
                        output_offsets=True,
                    )
                    word_timestamps = self._normalize_whisper_offsets(
                        decoded.get("offsets", []),
                    )
                except Exception:
                    pass

                duration_seconds = len(samples) / sample_rate
                segments = self._build_single_segment(
                    transcription,
                    0.0,
                    duration_seconds,
                    english_text=english_text,
                )

            else:
                # CTC model (Wav2Vec2)
                logits = asr_model(**inputs).logits
                predicted_ids = torch.argmax(logits, dim=-1)
                transcription = processor.batch_decode(predicted_ids)[0]
                word_timestamps = []
                segments = self._build_single_segment(
                    transcription,
                    0.0,
                    len(samples) / sample_rate,
                )

        if progress_callback:
            progress_callback(1.0)

        return RawTranscription(
            text=transcription,
            segments=segments,
            word_timestamps=word_timestamps,
            model_output=outputs if torch.is_tensor(outputs) else None,
        )

    async def _run_onnx_inference(
        self,
        samples: np.ndarray,
        sample_rate: int,
        model: LoadedModel,
        config: Any,
        progress_callback: Callable[[float], None] | None = None,
    ) -> RawTranscription:
        """Run inference using standard ONNX Runtime (for raw ONNX sessions)."""
        session = model.model

        # Get input/output names
        input_name = session.get_inputs()[0].name
        output_name = session.get_outputs()[0].name

        # Prepare input (may need preprocessing based on model)
        input_data = samples.reshape(1, -1).astype(np.float32)

        # Run inference
        outputs = session.run([output_name], {input_name: input_data})

        # Decode output (implementation depends on model)
        # This is a simplified version
        transcription = str(outputs[0])

        if progress_callback:
            progress_callback(1.0)

        return RawTranscription(text=transcription)

    async def _run_optimum_onnx_inference(
        self,
        samples: np.ndarray,
        sample_rate: int,
        model: LoadedModel,
        config: Any,
        progress_callback: Callable[[float], None] | None = None,
        chunk_callback: Callable[[ChunkTranscriptionResult], None] | None = None,
        first_word_hook: Callable[[], None] | None = None,
        prompt: str | None = None,
    ) -> RawTranscription:
        """Run inference using Optimum ONNX with manual sliding-window chunking.

        Whisper's feature extractor truncates audio to its 30-second
        context window.  For audio longer than ``chunk_length_s`` (default
        30 s) this method splits the waveform into overlapping chunks,
        transcribes each via ``generate()``, and merges results with
        correct global timestamps.

        Adjacent chunk texts are de-duplicated to eliminate repeated
        words caused by the stride overlap.

        For short audio (<= chunk_length_s) a single ``generate()`` call
        is used.

        Args:
            samples: Audio waveform as float32 numpy array.
            sample_rate: Sample rate of *samples*.
            model: Optimum ONNX ``LoadedModel`` (processor required).
            config: Inference configuration (carries ``language`` etc.).
            progress_callback: Optional progress reporter (0.0 – 1.0).
            chunk_callback: Optional callback for near-real-time partial
                results after each chunk.
            first_word_hook: Called once when first non-empty text is
                produced (for TTFW measurement).

        Returns:
            ``RawTranscription`` with text, word timestamps, and segments.
        """
        import torch

        onnx_model = model.model
        processor = model.processor

        if processor is None:
            raise TranscriptionError("Optimum ONNX model requires a processor")

        audio_duration_s = len(samples) / sample_rate
        settings = get_settings()
        chunk_length_s = float(settings.transcription_chunk_length_s)

        # Parse stride from settings (e.g. "4,2" -> left=4, right=2)
        stride_parts = [int(s.strip()) for s in settings.transcription_stride_length_s.split(",")]
        stride_left = stride_parts[0] if len(stride_parts) >= 1 else 4
        stride_right = stride_parts[1] if len(stride_parts) >= 2 else 2
        stride_s = stride_left + stride_right
        step_s = chunk_length_s - stride_s  # non-overlapping advance

        # Build generate kwargs (reused per chunk).
        # IMPORTANT: We use return_timestamps=False for the generate() call.
        # Setting return_timestamps=True triggers Whisper's internal
        # sequential long-form decoding which is extremely slow (~20x).
        # Instead, timestamps are extracted via processor.decode(output_offsets=True)
        # which reads the timestamp tokens from the generated sequence.
        generate_kwargs: dict[str, Any] = {
            "task": "transcribe",
            "return_timestamps": False,
        }
        code_switching = getattr(config, "code_switching", False)
        lang = getattr(config, "language", None)

        if code_switching:
            # Code-switching mode: omit language to let Whisper auto-detect
            # per chunk, enabling multilingual transcription.
            logger.info("Code-switching enabled — language will be auto-detected per chunk")
        elif lang is not None:
            generate_kwargs["language"] = lang

        # Beam search configuration
        beam_size = getattr(config, "beam_size", None)
        if beam_size and beam_size > 1:
            generate_kwargs["num_beams"] = beam_size

        # Temperature / sampling configuration
        temperature = getattr(config, "temperature", None)
        if temperature is not None and temperature == 0.0:
            generate_kwargs["do_sample"] = False
        elif temperature is not None:
            generate_kwargs["do_sample"] = True
            generate_kwargs["temperature"] = temperature

        # Whisper initial_prompt conditioning (prompt_ids)
        if prompt:
            try:
                prompt_ids = processor.get_prompt_ids(prompt, return_tensors="pt")
                generate_kwargs["prompt_ids"] = prompt_ids
                logger.debug("Optimum ONNX: injected prompt_ids (%d tokens)", len(prompt_ids))
            except Exception:
                logger.warning("Optimum ONNX: failed to encode prompt_ids, skipping", exc_info=True)

        device = model.device

        # --- Short audio: single-pass -----------------------------------
        if audio_duration_s <= chunk_length_s:
            logger.info(
                "Running single-pass Optimum inference on %.1fs audio "
                "(language=%s, code_switching=%s)",
                audio_duration_s,
                lang,
                code_switching,
            )
            result = await self._optimum_single_pass(
                samples,
                sample_rate,
                onnx_model,
                processor,
                device,
                generate_kwargs,
                progress_callback,
                code_switching=code_switching,
            )
            # Fire TTFW and chunk callback for single-pass
            if result.text.strip():
                if first_word_hook:
                    first_word_hook()
                if chunk_callback:
                    chunk_callback(
                        ChunkTranscriptionResult(
                            chunk_index=0,
                            text=result.text.strip(),
                            start_time=0.0,
                            end_time=audio_duration_s,
                            is_final=True,
                            word_timestamps=result.word_timestamps,
                        )
                    )
            return result

        # --- Long audio: chunked path -----------------------------------
        chunk_samples = int(chunk_length_s * sample_rate)
        step_samples = int(step_s * sample_rate)
        num_chunks = max(1, int(np.ceil((len(samples) - chunk_samples) / step_samples)) + 1)

        logger.info(
            "Running chunked Optimum inference on %.1fs audio "
            "(%d chunks of %.0fs, stride=%.0fs, language=%s, code_switching=%s)",
            audio_duration_s,
            num_chunks,
            chunk_length_s,
            stride_s,
            lang,
            code_switching,
        )

        all_text_parts: list[str] = []
        all_word_timestamps: list[dict[str, Any]] = []
        all_segments: list[dict[str, Any]] = []
        chunk_idx = 0
        offset = 0
        previous_chunk_text = ""
        first_word_fired = False

        while offset < len(samples):
            chunk_start_s = offset / sample_rate
            end_sample = min(offset + chunk_samples, len(samples))
            chunk_audio = samples[offset:end_sample]

            # Skip chunks shorter than 0.5 s
            if len(chunk_audio) < sample_rate // 2:
                break

            # Process this chunk
            inputs = processor(
                chunk_audio,
                sampling_rate=sample_rate,
                return_tensors="pt",
            )
            if device != "cpu":
                inputs = {k: v.to(device) for k, v in inputs.items()}

            with torch.no_grad():
                generated_ids = onnx_model.generate(
                    **inputs,
                    **generate_kwargs,
                )

            raw_chunk_text = self._decode_whisper_text(processor, generated_ids)
            chunk_english_text: str | None = None
            if code_switching and raw_chunk_text:
                chunk_english_text = self._generate_english_translation(
                    onnx_model,
                    processor,
                    inputs,
                    generate_kwargs,
                )

            # ---- Word timestamps via output_offsets (Phase 3.1) ----
            chunk_word_timestamps: list[dict[str, Any]] = []
            chunk_end_s = min(
                chunk_start_s + len(chunk_audio) / sample_rate,
                audio_duration_s,
            )
            try:
                decoded = processor.decode(
                    generated_ids[0],
                    skip_special_tokens=False,
                    output_offsets=True,
                )
                raw_offsets = decoded.get("offsets", [])
                if raw_offsets:
                    chunk_word_timestamps = self._normalize_whisper_offsets(
                        raw_offsets,
                        time_offset=chunk_start_s,
                    )
            except Exception:
                pass  # Fall through to proportional estimation

            # De-duplicate overlap with previous chunk
            chunk_text = raw_chunk_text
            if chunk_text and previous_chunk_text:
                chunk_text = self._dedup_overlap(previous_chunk_text, chunk_text)

            # Accumulate results
            if chunk_text:
                # Fire TTFW hook on first non-empty chunk
                if not first_word_fired:
                    first_word_fired = True
                    if first_word_hook:
                        first_word_hook()

                all_text_parts.append(chunk_text)
                previous_chunk_text = raw_chunk_text  # use raw for dedup matching
                all_segments.append(
                    {
                        "text": chunk_text,
                        "start": chunk_start_s,
                        "end": chunk_end_s,
                    }
                )
                if chunk_english_text:
                    all_segments[-1]["english_text"] = chunk_english_text

                # Use offset-based timestamps if available, else proportional
                if chunk_word_timestamps:
                    all_word_timestamps.extend(chunk_word_timestamps)
                else:
                    words = chunk_text.split()
                    if words:
                        word_duration = (chunk_end_s - chunk_start_s) / len(words)
                        for wi, word in enumerate(words):
                            w_start = chunk_start_s + wi * word_duration
                            w_end = w_start + word_duration
                            all_word_timestamps.append(
                                {
                                    "word": word,
                                    "start": round(w_start, 3),
                                    "end": round(w_end, 3),
                                    "confidence": 1.0,
                                }
                            )

            is_last_chunk = (offset + step_samples) >= len(samples)

            # Emit chunk callback for near-real-time output
            if chunk_callback:
                chunk_callback(
                    ChunkTranscriptionResult(
                        chunk_index=chunk_idx,
                        text=chunk_text,
                        start_time=chunk_start_s,
                        end_time=chunk_end_s,
                        is_final=is_last_chunk,
                        word_timestamps=chunk_word_timestamps or [],
                    )
                )

            chunk_idx += 1
            if progress_callback:
                progress_callback(min(chunk_idx / num_chunks, 1.0))

            offset += step_samples

        merged_text = " ".join(all_text_parts)

        logger.info(
            "Chunked Optimum inference: %d chunks (%.0fs each, %.0fs stride), "
            "%d chars, %d word timestamps, %d segments",
            chunk_idx,
            chunk_length_s,
            stride_s,
            len(merged_text),
            len(all_word_timestamps),
            len(all_segments),
        )

        if progress_callback:
            progress_callback(1.0)

        return RawTranscription(
            text=merged_text,
            word_timestamps=all_word_timestamps,
            segments=all_segments,
        )

    async def _optimum_single_pass(
        self,
        samples: np.ndarray,
        sample_rate: int,
        onnx_model: Any,
        processor: Any,
        device: str,
        generate_kwargs: dict[str, Any],
        progress_callback: Callable[[float], None] | None = None,
        code_switching: bool = False,
    ) -> RawTranscription:
        """Single-pass Optimum inference for short audio (<= chunk_length_s)."""
        import torch

        inputs = processor(
            samples,
            sampling_rate=sample_rate,
            return_tensors="pt",
        )
        if device != "cpu":
            inputs = {k: v.to(device) for k, v in inputs.items()}

        with torch.no_grad():
            generated_ids = onnx_model.generate(**inputs, **generate_kwargs)

        full_text = self._decode_whisper_text(processor, generated_ids)
        english_text: str | None = None
        if code_switching and full_text:
            english_text = self._generate_english_translation(
                onnx_model,
                processor,
                inputs,
                generate_kwargs,
            )

        audio_duration_s = len(samples) / sample_rate

        # Try to get actual word timestamps via output_offsets first,
        # then fall back to proportional distribution.
        word_timestamps: list[dict[str, Any]] = []
        try:
            decoded = processor.decode(
                generated_ids[0],
                skip_special_tokens=False,
                output_offsets=True,
            )
            raw_offsets = decoded.get("offsets", [])
            if raw_offsets:
                word_timestamps = self._normalize_whisper_offsets(raw_offsets)
        except Exception:
            pass

        if not word_timestamps:
            # Proportional fallback
            words = full_text.split()
            if words:
                word_dur = audio_duration_s / len(words)
                for wi, word in enumerate(words):
                    w_start = wi * word_dur
                    w_end = w_start + word_dur
                    word_timestamps.append(
                        {
                            "word": word,
                            "start": round(w_start, 3),
                            "end": round(w_end, 3),
                            "confidence": 1.0,
                        }
                    )

        segments: list[dict[str, Any]] = []
        if full_text:
            segments.append(
                {
                    "text": full_text,
                    "start": 0.0,
                    "end": audio_duration_s,
                }
            )
            if english_text:
                segments[0]["english_text"] = english_text

        if progress_callback:
            progress_callback(1.0)

        return RawTranscription(
            text=full_text,
            word_timestamps=word_timestamps,
            segments=segments,
        )

    async def _run_nemo_inference(
        self,
        samples: np.ndarray,
        sample_rate: int,
        model: LoadedModel,
        config: Any,
        progress_callback: Callable[[float], None] | None = None,
    ) -> RawTranscription:
        """Run inference using NeMo model."""
        import torch

        if getattr(config, "code_switching", False):
            logger.warning(
                "Code-switching was requested but NeMo Parakeet models do "
                "not support multilingual code-switching. The setting will "
                "be ignored for this inference."
            )

        nemo_model = model.model

        # Convert to tensor
        audio_tensor = torch.from_numpy(samples).float().unsqueeze(0)
        audio_length = torch.tensor([len(samples)])

        # Run transcription
        with torch.no_grad():
            transcription = nemo_model.transcribe(
                paths2audio_files=None,
                audio_signal=audio_tensor,
                audio_signal_len=audio_length,
            )[0]

        if progress_callback:
            progress_callback(1.0)

        return RawTranscription(text=transcription)

    def _postprocess(
        self,
        raw: RawTranscription,
        config: Any,
        duration_seconds: float,
    ) -> TranscriptionResult:
        """Postprocess raw transcription."""
        text = raw.text.strip()

        # Punctuation restoration (sync -- batch runs in worker thread already)
        if getattr(config, "punctuation", None) and getattr(config.punctuation, "enabled", False):
            try:
                from stt_v2.punctuation.service import punctuate_sync

                texts_to_punctuate = [text]

                # Also punctuate segment texts
                segment_texts = []
                if config.timestamps.sentence_timestamps and raw.segments:
                    segment_texts = [
                        seg.get("text", "") if isinstance(seg, dict) else ""
                        for seg in raw.segments
                    ]
                    texts_to_punctuate.extend(segment_texts)

                punct_model = getattr(config.punctuation, "model", None)
                results = punctuate_sync(texts_to_punctuate, batch_size=8, model_name=punct_model)
                text = results[0]

                if segment_texts:
                    for i, seg in enumerate(raw.segments):
                        if isinstance(seg, dict):
                            seg["text"] = results[i + 1]
            except Exception:
                logger.warning("Batch punctuation failed, using original text", exc_info=True)

        # Remove disfluencies
        if getattr(config, "remove_disfluencies", False):
            from stt_v2.postprocessing.disfluency import remove_disfluencies

            text = remove_disfluencies(text)

        # Apply lowercase if configured
        if config.lowercase:
            text = text.lower()

        # Extract word timestamps
        word_timestamps = []
        if config.timestamps.word_timestamps and raw.word_timestamps:
            for wt in raw.word_timestamps:
                if isinstance(wt, dict):
                    word_timestamps.append(
                        WordTimestamp(
                            word=wt.get("text", wt.get("word", "")),
                            start_time=wt.get("start", wt.get("start_time", 0.0)),
                            end_time=wt.get("end", wt.get("end_time", 0.0)),
                            confidence=wt.get("confidence", 1.0),
                        )
                    )

        # Extract sentence timestamps (if available)
        sentence_timestamps = []
        if config.timestamps.sentence_timestamps and raw.segments:
            for seg in raw.segments:
                if isinstance(seg, dict):
                    sentence_timestamps.append(
                        SentenceTimestamp(
                            text=seg.get("text", ""),
                            start_time=seg.get("start", 0.0),
                            end_time=seg.get("end", 0.0),
                            english_text=seg.get("english_text"),
                        )
                    )

        return TranscriptionResult(
            text=text,
            language=raw.language,
            language_probability=raw.language_probability,
            duration_seconds=duration_seconds,
            word_timestamps=word_timestamps,
            sentence_timestamps=sentence_timestamps,
            metadata={},
        )


# Singleton instance
_service: BatchTranscriptionService | None = None


def get_batch_service() -> BatchTranscriptionService:
    """Get singleton batch transcription service."""
    global _service
    if _service is None:
        _service = BatchTranscriptionService()
    return _service
