"""SessionManager — streaming session lifecycle orchestration.

Responsibilities:
* **Create** sessions — validate capacity, persist metadata, start consumers
* **Get / list** sessions — for health endpoints and diagnostics
* **Remove** sessions — clean up resources (consumers, capacity slot, memory)
* **Recovery on startup** — scan ``stt:session:*`` for ``status: active``,
  replay last ~2 s of audio to warm RNNoise / VAD state, resume consuming
* **Background reaper** — every N minutes, finalize sessions with no
  activity for the configured timeout
* **Worker heartbeat** — register ``stt:worker:{worker_id}`` with TTL,
  extend periodically so other workers can detect crashes
"""

from __future__ import annotations

import asyncio
import importlib
import os
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any

import numpy as np
import structlog

from stt_v2.core.config.settings import get_settings
from stt_v2.storage.blob_service import BlobService
from stt_v2.streaming.capacity_guard import CapacityGuard
from stt_v2.streaming.denoiser import StreamingDenoiser
from stt_v2.streaming.execution_profile import ExecutionProfile
from stt_v2.streaming.inference import StreamingInferenceWorker
from stt_v2.streaming.preprocessor import AudioUtterance, StreamingPreprocessor
from stt_v2.streaming.redis_streams import (
    ControlListener,
    IngestionConsumer,
    ResultPublisher,
    worker_key,
)
from stt_v2.streaming.schemas import (
    AudioFrame,
    ControlAction,
    SessionControl,
    SessionMetadata,
    SessionStatus,
)
from stt_v2.streaming.session import StreamSession
from stt_v2.transcription.batch_service import BatchTranscriptionService

logger = structlog.get_logger(__name__)

StreamingAsrCallable = Callable[[np.ndarray, int], Awaitable[dict[str, Any]]]


class SessionManager:
    """Manages the full lifecycle of streaming sessions.

    Parameters
    ----------
    redis:
        ``redis.asyncio.Redis`` client instance.
    profile:
        The detected ``ExecutionProfile`` (provides ``max_concurrent_streams``).
    worker_id:
        Unique identifier for this worker process (auto-generated if not
        provided).
    """

    def __init__(
        self,
        redis: Any,
        profile: ExecutionProfile,
        worker_id: str | None = None,
    ) -> None:
        self._redis = redis
        self._profile = profile
        self._worker_id = worker_id or f"worker-{uuid.uuid4().hex[:8]}-{os.getpid()}"
        self._capacity_guard = CapacityGuard(profile.max_concurrent_streams)
        self._sessions: dict[str, StreamSession] = {}
        self._consumers: dict[str, IngestionConsumer] = {}
        self._control_listeners: dict[str, ControlListener] = {}
        self._publishers: dict[str, ResultPublisher] = {}
        self._preprocessors: dict[str, StreamingPreprocessor] = {}
        self._inference_workers: dict[str, StreamingInferenceWorker] = {}
        self._inference_queues: dict[str, asyncio.Queue[AudioUtterance | None]] = {}
        self._inference_tasks: dict[str, asyncio.Task[None]] = {}
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._reaper_task: asyncio.Task[None] | None = None
        self._snapshot_task: asyncio.Task[None] | None = None
        self._blob_service: BlobService | None = None
        self._last_snapshot_at: dict[str, float] = {}
        self._chunk_indices: dict[str, int] = {}
        self._processed_chunk_indices: dict[str, int] = {}
        self._chunk_offsets: dict[str, int] = {}
        self._processed_chunk_offsets: dict[str, int] = {}
        self._partial_tasks: dict[str, asyncio.Task[None]] = {}
        self._running = False

        # Cache settings values at init time to avoid calling get_settings()
        # in methods that may run during unit tests with incomplete env.
        try:
            _settings = get_settings()
            self._reaper_interval_s = _settings.streaming_reaper_interval_s
            self._session_timeout_s = _settings.streaming_session_timeout_s
            self._heartbeat_interval_s = _settings.streaming_worker_heartbeat_s
            self._heartbeat_ttl_s = _settings.streaming_worker_heartbeat_ttl_s
            self._inference_queue_maxsize = int(
                getattr(_settings, "streaming_inference_queue_maxsize", 64)
            )
            self._inference_drain_timeout_s = float(
                getattr(_settings, "streaming_inference_drain_timeout_s", 60.0)
            )
            self._inference_stop_timeout_s = float(
                getattr(_settings, "streaming_inference_stop_timeout_s", 30.0)
            )
            self._snapshot_interval_s = _settings.streaming_snapshot_interval_s
        except Exception:
            self._reaper_interval_s = 300
            self._session_timeout_s = 60
            self._heartbeat_interval_s = 10
            self._heartbeat_ttl_s = 30
            self._inference_queue_maxsize = 64
            self._inference_drain_timeout_s = 60.0
            self._inference_stop_timeout_s = 30.0
            self._snapshot_interval_s = 30.0

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def worker_id(self) -> str:
        return self._worker_id

    @property
    def capacity_guard(self) -> CapacityGuard:
        return self._capacity_guard

    @property
    def active_session_count(self) -> int:
        return len(self._sessions)

    @property
    def profile(self) -> ExecutionProfile:
        return self._profile

    # ------------------------------------------------------------------
    # Startup / Shutdown
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Start the session manager: recover sessions, start heartbeat and reaper."""
        self._running = True

        # Register worker heartbeat
        await self._register_worker()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop(), name="worker-heartbeat")

        # Recover active sessions from Redis
        await self._recover_sessions()

        # Start background reaper
        self._reaper_task = asyncio.create_task(self._reaper_loop(), name="session-reaper")

        # Start audio snapshot loop
        self._snapshot_task = asyncio.create_task(self._snapshot_loop(), name="audio-snapshot")

        logger.info(
            "SessionManager started",
            worker_id=self._worker_id,
            recovered_sessions=len(self._sessions),
            max_streams=self._profile.max_concurrent_streams,
        )

    async def stop(self) -> None:
        """Gracefully shut down: stop consumers, persist state, unregister worker."""
        self._running = False

        # Cancel background tasks
        for task in (self._heartbeat_task, self._reaper_task, self._snapshot_task):
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        # Stop all consumers and listeners
        for consumer in self._consumers.values():
            await consumer.stop()
        for listener in self._control_listeners.values():
            await listener.stop()

        for sid in list(self._inference_queues):
            await self._drain_inference_queue(sid)
            await self._stop_inference_loop(sid, force_cancel=True)

        # Persist all sessions one final time
        for session in self._sessions.values():
            try:
                await session.force_persist()
            except Exception as exc:
                logger.error(
                    "Failed to persist session on shutdown",
                    session_id=session.session_id,
                    error=str(exc),
                )

        # Unregister worker
        await self._unregister_worker()

        self._sessions.clear()
        self._consumers.clear()
        self._control_listeners.clear()
        self._publishers.clear()
        self._preprocessors.clear()
        self._inference_workers.clear()
        self._inference_queues.clear()
        self._inference_tasks.clear()

        logger.info("SessionManager stopped", worker_id=self._worker_id)

    # ------------------------------------------------------------------
    # Session CRUD
    # ------------------------------------------------------------------

    async def create_session(
        self,
        session_id: str,
        tenant_id: str,
        pipeline_id: str,
        consultation_id: str | None = None,
        sample_rate: int = 16000,
    ) -> StreamSession | None:
        """Create a new streaming session.

        Returns the ``StreamSession`` if admitted, or ``None`` if at
        capacity.

        Args:
            session_id: Unique session identifier.
            tenant_id: Tenant identifier.
            pipeline_id: Pipeline UUID or slug.
            consultation_id: Optional consultation context.
            sample_rate: Audio sample rate in Hz.
        """
        # Check capacity
        if not await self._capacity_guard.try_acquire(session_id):
            return None
        try:
            # Build metadata
            metadata = SessionMetadata(
                session_id=session_id,
                tenant_id=tenant_id,
                pipeline_id=pipeline_id,
                consultation_id=consultation_id,
                status=SessionStatus.ACTIVE,
                sample_rate=sample_rate,
                worker_id=self._worker_id,
            )

            # Create session object
            session = StreamSession(metadata=metadata, redis=self._redis)
            await session.force_persist()

            # Load pipeline config for VAD and ASR model wiring
            pipeline_config = await self._load_pipeline_config(pipeline_id)

            # Create result publisher (needed by inference worker)
            publisher = ResultPublisher(redis=self._redis, session_id=session_id)

            # Load VAD service from pipeline config (B1: Wire VAD)
            vad_service = await self._load_vad_service(pipeline_config, session_id)

            # Create streaming preprocessor (VAD + utterance extraction)
            vad_kwargs: dict[str, Any] = {}
            vad_enabled = bool(pipeline_config and pipeline_config.preprocessing.vad.enabled)
            if vad_enabled:
                vad_cfg = pipeline_config.preprocessing.vad
                vad_kwargs["threshold"] = vad_cfg.threshold
                vad_kwargs["min_speech_duration_ms"] = vad_cfg.min_speech_duration_ms
                vad_kwargs["min_silence_duration_ms"] = vad_cfg.min_silence_duration_ms
                if hasattr(vad_cfg, "pre_speech_context_ms"):
                    vad_kwargs["pre_speech_context_ms"] = vad_cfg.pre_speech_context_ms

            target_sr = (
                pipeline_config.preprocessing.target_sample_rate
                if pipeline_config and pipeline_config.preprocessing.target_sample_rate
                else sample_rate
            )

            # Noise suppression setup
            denoiser = None
            if pipeline_config:
                denoise_enabled = pipeline_config.preprocessing.denoise.enabled
            else:
                denoise_enabled = self._profile.denoise_enabled_default
            if denoise_enabled:
                strength = (
                    pipeline_config.preprocessing.denoise.strength if pipeline_config else 1.0
                )
                denoiser = StreamingDenoiser(input_sr=target_sr, strength=strength)
                if not denoiser.initialize():
                    denoiser = None  # pyrnnoise unavailable, degrade gracefully
            normalize = pipeline_config.preprocessing.normalize if pipeline_config else False

            preprocessor = StreamingPreprocessor(
                session_id=session_id,
                sample_rate=sample_rate,
                vad_service=vad_service,
                target_sample_rate=target_sr,
                normalize=normalize,
                denoiser=denoiser,
                **vad_kwargs,
            )

            session.processed_sample_rate = target_sr
            session._vad_active = vad_enabled

            # Load ASR pipeline from pipeline config (B2: Wire ASR)
            asr_pipeline = await self._load_asr_pipeline(
                pipeline_config,
                session_id,
            )

            diarization_config = pipeline_config.diarization if pipeline_config else None
            effective_diarization = (
                bool(getattr(diarization_config, "enabled", False)) if diarization_config else False
            )

            metadata.diarization = effective_diarization
            await session.force_persist()

            # Create inference worker (per-utterance ASR)
            punctuation_config = None
            if pipeline_config and hasattr(pipeline_config, "postprocessing"):
                pp_cfg = getattr(pipeline_config.postprocessing, "punctuation", None)
                if pp_cfg and getattr(pp_cfg, "enabled", False):
                    punctuation_config = pp_cfg

            inference_worker = StreamingInferenceWorker(
                result_publisher=publisher,
                asr_pipeline=asr_pipeline,
                tenant_id=tenant_id,
                consultation_id=consultation_id,
                diarization_config=diarization_config,
                punctuation_config=punctuation_config,
            )

            self._register_inference_runtime(session, inference_worker)

            # Wire up Redis consumers and listeners
            consumer = IngestionConsumer(
                redis=self._redis,
                session_id=session_id,
                on_frame=self._make_frame_handler(session, preprocessor),
            )
            control_listener = ControlListener(
                redis=self._redis,
                session_id=session_id,
                on_control=self._make_control_handler(session, preprocessor),
            )

            self._sessions[session_id] = session
            self._consumers[session_id] = consumer
            self._control_listeners[session_id] = control_listener
            self._publishers[session_id] = publisher
            self._preprocessors[session_id] = preprocessor
            self._inference_workers[session_id] = inference_worker

            # Start consuming
            await consumer.start()
            await control_listener.start()

            logger.info(
                "Session created",
                session_id=session_id,
                tenant_id=tenant_id,
                pipeline_id=pipeline_id,
                has_vad=vad_service is not None,
                has_asr=asr_pipeline is not None,
                has_denoiser=denoiser is not None,
                active_sessions=self.active_session_count,
            )
            return session
        except Exception as exc:
            logger.error(
                "Failed to create session, rolling back",
                session_id=session_id,
                tenant_id=tenant_id,
                pipeline_id=pipeline_id,
                error=str(exc),
            )
            await self.remove_session(session_id)
            raise

    def get_session(self, session_id: str) -> StreamSession | None:
        """Retrieve an active session by ID, or ``None``."""
        return self._sessions.get(session_id)

    def get_publisher(self, session_id: str) -> ResultPublisher | None:
        """Retrieve the result publisher for a session."""
        return self._publishers.get(session_id)

    async def end_session(self, session_id: str) -> None:
        """Gracefully end a session — finalize (upload artifacts) then remove.

        This is the public entry-point for API routes (DELETE, POST end).
        It flushes any pending utterance, drains the inference queue, and
        calls ``_finalize_session`` which uploads remaining PCM chunks,
        ``complete.wav``, ``transcript.json``, and ``metadata.json``
        before cleaning up.
        """
        session = self._sessions.get(session_id)
        if session is None:
            return

        try:
            await self._flush_final_utterance(
                session=session,
                preprocessor=self._preprocessors.get(session_id),
            )
            await self._drain_inference_queue(session_id)
            await self._finalize_session(session)
        except Exception as exc:
            logger.error(
                "Failed to end session gracefully; forcing removal",
                session_id=session_id,
                error=str(exc),
            )
            await self.remove_session(session_id)

    async def remove_session(self, session_id: str) -> None:
        """Remove a session, stopping its consumers and releasing capacity."""
        # Stop consumer and listener
        consumer = self._consumers.pop(session_id, None)
        if consumer:
            try:
                await consumer.stop()
            except Exception as exc:
                logger.error(
                    "Failed to stop ingestion consumer during session removal",
                    session_id=session_id,
                    error=str(exc),
                )
        listener = self._control_listeners.pop(session_id, None)
        if listener:
            try:
                await listener.stop()
            except Exception as exc:
                logger.error(
                    "Failed to stop control listener during session removal",
                    session_id=session_id,
                    error=str(exc),
                )

        try:
            await self._stop_inference_loop(session_id, force_cancel=True)
        except Exception as exc:
            logger.error(
                "Failed to stop inference loop during session removal",
                session_id=session_id,
                error=str(exc),
            )

        self._publishers.pop(session_id, None)
        self._preprocessors.pop(session_id, None)
        self._inference_workers.pop(session_id, None)
        self._inference_queues.pop(session_id, None)
        self._inference_tasks.pop(session_id, None)
        self._sessions.pop(session_id, None)
        self._last_snapshot_at.pop(session_id, None)
        self._chunk_indices.pop(session_id, None)
        self._processed_chunk_indices.pop(session_id, None)
        self._chunk_offsets.pop(session_id, None)
        self._processed_chunk_offsets.pop(session_id, None)

        partial_task = self._partial_tasks.pop(session_id, None)
        if partial_task and not partial_task.done():
            partial_task.cancel()

        # Release capacity (must happen even if other cleanup fails)
        try:
            await self._capacity_guard.release(session_id)
        except Exception as exc:
            logger.error(
                "Failed to release capacity during session removal",
                session_id=session_id,
                error=str(exc),
            )

        logger.info(
            "Session removed",
            session_id=session_id,
            active_sessions=self.active_session_count,
        )

    async def force_end_all_sessions(self) -> list[str]:
        """Force-end all active sessions and return removed session IDs."""
        session_ids = list(self._sessions.keys())
        for session_id in session_ids:
            await self.remove_session(session_id)
        return session_ids

    def list_sessions(self) -> list[dict[str, Any]]:
        """Return diagnostic snapshots for all active sessions."""
        return [s.to_dict() for s in self._sessions.values()]

    # ------------------------------------------------------------------
    # Model loading helpers (B1/B2: VAD + ASR pipeline wiring)
    # ------------------------------------------------------------------

    async def _load_pipeline_config(self, pipeline_id: str) -> Any:
        """Load pipeline spec from the pipeline reader.

        Returns the ``PipelineSpec`` if found, or ``None`` on failure.
        """
        try:
            from stt_v2.pipeline.config_reader import get_pipeline_reader

            reader = get_pipeline_reader()
            pipeline = await reader.get_pipeline(pipeline_id)
            return pipeline.spec if pipeline else None
        except Exception as exc:
            logger.warning(
                "Failed to load pipeline config for streaming session",
                pipeline_id=pipeline_id,
                error=str(exc),
            )
            return None

    async def _load_vad_service(
        self,
        pipeline_config: Any,
        session_id: str,
    ) -> Any:
        """Load Silero VAD service for the streaming preprocessor.

        Uses the singleton ``get_vad_service()`` which shares a single
        ONNX session across all streaming sessions (the model is
        stateless — per-session LSTM state lives in ``VADSessionState``).

        Returns ``None`` if VAD is disabled, not configured, or fails to
        load. The preprocessor degrades gracefully by using an
        energy-based fallback VAD.
        """
        if pipeline_config is None:
            return None

        if not pipeline_config.preprocessing.vad.enabled:
            logger.debug(
                "VAD disabled in pipeline config",
                session_id=session_id,
            )
            return None

        try:
            from stt_v2.vad.silero_service import get_vad_service

            vad_service = get_vad_service()
            if not vad_service.is_loaded:
                await vad_service.initialize()

            logger.info(
                "VAD service loaded for streaming session",
                session_id=session_id,
            )
            return vad_service
        except Exception as exc:
            logger.warning(
                "Failed to load VAD for streaming, proceeding without VAD",
                session_id=session_id,
                error=str(exc),
            )
            return None

    async def _load_asr_pipeline(
        self,
        pipeline_config: Any,
        session_id: str,
    ) -> StreamingAsrCallable | None:
        """Load ASR model and create a callable pipeline for streaming inference.

        Returns a callable ``(samples: np.ndarray, sample_rate: int) -> dict[str, Any]``
        that runs inference on a single utterance, or ``None`` on failure.

        The callable reuses ``BatchTranscriptionService._run_inference()``
        to ensure streaming and batch use the same ASR code path.
        """
        if pipeline_config is None:
            return None

        try:
            from stt_v2.models import get_model_cache
            from stt_v2.pipeline.dto import ModelTaskType

            model_cache = get_model_cache()
            asr_ref = pipeline_config.models.asr

            # Load ASR model via the model cache
            asr_model = await model_cache.get_or_load_from_ref(
                model_ref=asr_ref,
                task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            )

            # Use pipeline inference config directly
            inference_config = pipeline_config.inference

            # Create the callable ASR pipeline
            asr_pipeline = self._make_asr_callable(asr_model, inference_config)

            logger.info(
                "ASR pipeline loaded for streaming session",
                session_id=session_id,
                model_slug=asr_model.model_slug,
                model_format=asr_model.format.value,
                language=inference_config.language,
            )
            return asr_pipeline
        except Exception as exc:
            logger.warning(
                "Failed to load ASR for streaming, inference will return empty text",
                session_id=session_id,
                error=str(exc),
            )
            return None

    def _make_asr_callable(
        self,
        asr_model: Any,
        inference_config: Any,
    ) -> StreamingAsrCallable:
        """Create a callable ASR pipeline for streaming inference.

        Returns an async function:
            ``(samples: np.ndarray, sample_rate: int) -> dict[str, Any]``

        Reuses ``BatchTranscriptionService._run_inference()`` to ensure
        streaming and batch share the same ASR code path, reducing
        maintenance burden and ensuring consistency.
        """
        batch_service_module = importlib.import_module("stt_v2.transcription.batch_service")
        batch_service_cls = getattr(
            batch_service_module,
            "BatchTranscriptionService",
            BatchTranscriptionService,
        )
        batch_svc = batch_service_cls()

        async def run_inference(samples: np.ndarray, sample_rate: int) -> dict[str, Any]:
            result = await batch_svc._run_inference(
                samples=samples,
                sample_rate=sample_rate,
                model=asr_model,
                config=inference_config,
            )
            if not result:
                return {"text": "", "word_timestamps": []}
            text = (result.text or "").strip()
            english_text = None
            if result.segments:
                translated_segments = [
                    segment
                    for segment in result.segments
                    if isinstance(segment, dict) and segment.get("english_text")
                ]
                if translated_segments:
                    matched_segment = next(
                        (
                            segment
                            for segment in translated_segments
                            if (segment.get("text") or "").strip() == text
                        ),
                        None,
                    )
                    english_text = (
                        matched_segment.get("english_text")
                        if matched_segment is not None
                        else translated_segments[-1].get("english_text")
                    )
            language = getattr(result, "language", None)
            return {
                "text": result.text,
                **({"english_text": english_text} if english_text else {}),
                **({"language": language} if isinstance(language, str) and language else {}),
                "word_timestamps": result.word_timestamps or [],
            }

        return run_inference

    # ------------------------------------------------------------------
    # Frame and control handlers (wired to consumers)
    # ------------------------------------------------------------------

    def _register_inference_runtime(
        self,
        session: StreamSession,
        inference_worker: StreamingInferenceWorker,
    ) -> None:
        """Create and register queue/task for per-session ASR inference."""
        inference_queue: asyncio.Queue[AudioUtterance | None] = asyncio.Queue(
            maxsize=self._inference_queue_maxsize
        )
        self._inference_queues[session.session_id] = inference_queue
        inference_task = self._start_inference_loop(session, inference_worker, inference_queue)
        self._inference_tasks[session.session_id] = inference_task

    def _start_inference_loop(
        self,
        session: StreamSession,
        inference_worker: StreamingInferenceWorker,
        queue: asyncio.Queue[AudioUtterance | None],
    ) -> asyncio.Task[None]:
        """Spawn a background task that drains *queue* and runs ASR inference.

        The loop terminates when it receives ``None`` (a sentinel) from the
        queue.  Results are recorded on the session as they complete.
        """

        async def _loop() -> None:
            while True:
                utt = await queue.get()
                if utt is None:
                    queue.task_done()
                    break
                try:
                    result = await inference_worker.process_utterance(session.session_id, utt)
                    session.add_result(result)
                    session.utterance_count = utt.utterance_index + 1
                except Exception as exc:
                    logger.error(
                        "Background inference failed",
                        session_id=session.session_id,
                        utterance_index=utt.utterance_index,
                        error=str(exc),
                    )
                finally:
                    queue.task_done()

        return asyncio.create_task(_loop(), name=f"inference-{session.session_id}")

    async def _drain_inference_queue(self, session_id: str) -> None:
        """Wait for all pending utterances in the inference queue to finish."""
        queue = self._inference_queues.get(session_id)
        if queue is None:
            return
        try:
            await asyncio.wait_for(queue.join(), timeout=self._inference_drain_timeout_s)
        except TimeoutError:
            logger.warning(
                "Inference queue drain timed out",
                session_id=session_id,
                remaining=queue.qsize(),
                timeout_s=self._inference_drain_timeout_s,
            )

    async def _stop_inference_loop(self, session_id: str, force_cancel: bool = False) -> None:
        """Send sentinel and cancel the background inference task."""
        queue = self._inference_queues.pop(session_id, None)
        if queue is not None:
            try:
                queue.put_nowait(None)  # sentinel
            except asyncio.QueueFull:
                if not force_cancel:
                    try:
                        await asyncio.wait_for(queue.put(None), timeout=1.0)
                    except TimeoutError:
                        logger.warning(
                            "Timed out enqueueing inference sentinel",
                            session_id=session_id,
                            timeout_s=1.0,
                        )
                else:
                    logger.warning(
                        "Inference queue full during forced stop; proceeding to cancellation",
                        session_id=session_id,
                        remaining=queue.qsize(),
                    )

        task = self._inference_tasks.pop(session_id, None)
        if task is not None and not task.done():
            try:
                await asyncio.wait_for(task, timeout=self._inference_stop_timeout_s)
            except TimeoutError:
                if force_cancel:
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
                else:
                    logger.warning(
                        "Inference task stop timed out",
                        session_id=session_id,
                        timeout_s=self._inference_stop_timeout_s,
                    )

    def _make_frame_handler(
        self,
        session: StreamSession,
        preprocessor: StreamingPreprocessor | None = None,
    ) -> Any:
        """Create an async callback for incoming audio frames.

        When a preprocessor is provided, the handler feeds PCM data
        through VAD → utterance extraction and enqueues detected
        utterances for background ASR inference.  Without one, it
        only records the frame for bookkeeping.
        """
        inference_queue = self._inference_queues.get(session.session_id)

        async def _on_frame(frame: AudioFrame) -> None:
            if session.status != SessionStatus.ACTIVE:
                return

            session.record_frame(seq=frame.seq, data=frame.data, sample_rate=frame.sr)

            # Feed audio through preprocessor for real-time VAD + utterance extraction
            if preprocessor is not None:
                utterances = await preprocessor.feed(frame.data)

                processed_pcm = preprocessor.drain_processed_samples()
                if processed_pcm:
                    session.processed_audio_buffer.extend(processed_pcm)
                    if session.processed_sample_rate is None:
                        session.processed_sample_rate = preprocessor.target_sample_rate

                # Enqueue utterances for background ASR inference
                if inference_queue is not None:
                    for utt in utterances:
                        await inference_queue.put(utt)

            # Periodic Tier-1 persistence
            await session.persist_if_needed()

            # If final frame, trigger finalization
            if frame.final:
                logger.info(
                    "Final frame received",
                    session_id=session.session_id,
                    seq=frame.seq,
                )
                try:
                    await self._flush_final_utterance(
                        session=session,
                        preprocessor=preprocessor,
                    )
                    await self._drain_inference_queue(session.session_id)
                    await self._finalize_session(session)
                except Exception as exc:
                    logger.error(
                        "Final frame finalization failed; forcing session removal",
                        session_id=session.session_id,
                        seq=frame.seq,
                        error=str(exc),
                    )
                    await self.remove_session(session.session_id)

        return _on_frame

    def _make_control_handler(
        self,
        session: StreamSession,
        preprocessor: StreamingPreprocessor | None = None,
    ) -> Any:
        """Create an async callback for session control commands.

        On FINALIZE: flush the preprocessor, drain the inference queue,
        then finalize the session.
        """

        async def _on_control(control: SessionControl) -> None:
            if control.action == ControlAction.FINALIZE:
                if session.status == SessionStatus.CLOSED:
                    return

                if session.status == SessionStatus.ACTIVE:
                    await session.finalize()
                    publisher = self._publishers.get(session.session_id)
                    if publisher:
                        await publisher.publish_status("finalizing")

                try:
                    await self._flush_final_utterance(
                        session=session,
                        preprocessor=preprocessor,
                    )
                    await self._drain_inference_queue(session.session_id)
                    await self._finalize_session(session)
                except Exception as exc:
                    logger.error(
                        "Control finalize failed; forcing session removal",
                        session_id=session.session_id,
                        error=str(exc),
                    )
                    await self.remove_session(session.session_id)
            elif control.action == ControlAction.CANCEL:
                await self._cancel_session(session)
            elif control.action in (ControlAction.PAUSE, ControlAction.RESUME):
                logger.info(
                    "Control action received (not yet implemented)",
                    session_id=session.session_id,
                    action=control.action.value,
                )
            else:
                logger.warning(
                    "Unknown control action",
                    session_id=session.session_id,
                    action=control.action.value,
                )

        return _on_control

    async def _run_inline_inference(
        self,
        session: StreamSession,
        utterance: AudioUtterance,
    ) -> None:
        """Run ASR inference inline (fallback when queue is unavailable)."""
        worker = self._inference_workers.get(session.session_id)
        if worker is None:
            logger.warning(
                "No inference worker for inline fallback",
                session_id=session.session_id,
            )
            return
        try:
            result = await worker.process_utterance(session.session_id, utterance)
            session.add_result(result)
            session.utterance_count = utterance.utterance_index + 1
        except Exception as exc:
            logger.warning(
                "Inline inference failed",
                session_id=session.session_id,
                error=str(exc),
            )

    async def _flush_final_utterance(
        self,
        session: StreamSession,
        preprocessor: StreamingPreprocessor | None,
    ) -> None:
        """Flush preprocessor and enqueue any remaining audio for inference."""
        if preprocessor is None:
            return

        try:
            final_utt = await preprocessor.flush()

            remaining_pcm = preprocessor.drain_processed_samples()
            if remaining_pcm:
                session.processed_audio_buffer.extend(remaining_pcm)
                if session.processed_sample_rate is None:
                    session.processed_sample_rate = preprocessor.target_sample_rate

            if final_utt is None:
                return

            queue = self._inference_queues.get(session.session_id)
            if queue is not None:
                try:
                    await asyncio.wait_for(
                        queue.put(final_utt), timeout=self._inference_stop_timeout_s
                    )
                except TimeoutError:
                    logger.warning(
                        "Timed out enqueueing final utterance; falling back to inline",
                        session_id=session.session_id,
                        timeout_s=self._inference_stop_timeout_s,
                    )
                    await self._run_inline_inference(session, final_utt)
            else:
                logger.warning(
                    "Inference queue gone; falling back to inline",
                    session_id=session.session_id,
                )
                await self._run_inline_inference(session, final_utt)
        except Exception as exc:
            logger.warning(
                "Failed to flush final utterance during finalization",
                session_id=session.session_id,
                error=str(exc),
            )

    def _get_blob_service(self) -> BlobService:
        """Lazy-init BlobService singleton."""
        if self._blob_service is None:
            self._blob_service = BlobService()
        return self._blob_service

    async def _finalize_session(self, session: StreamSession) -> None:
        """Finalize a session — mark finalizing, upload recordings, close, and clean up.

        Callers must drain the inference queue *before* calling this
        method so that all utterances have been transcribed.
        """
        if session.status == SessionStatus.CLOSED and session.session_id not in self._sessions:
            return

        publisher = self._publishers.get(session.session_id)
        raw_audio_uri: str | None = None
        processed_audio_uri: str | None = None
        transcript_uri: str | None = None

        try:
            if session.status == SessionStatus.ACTIVE:
                await session.finalize()

                # Publish status update
                if publisher:
                    await publisher.publish_status("finalizing")

            # Upload audio + transcript + metadata
            has_processed = len(session.processed_audio_buffer) > 0
            has_raw = len(session.audio_buffer) > 0

            if has_raw or has_processed:
                blob = self._get_blob_service()

                # Upload any remaining raw PCM chunk
                if has_raw:
                    raw_offset = self._chunk_offsets.get(session.session_id, 0)
                    if raw_offset < len(session.audio_buffer):
                        try:
                            remaining = bytes(session.audio_buffer[raw_offset:])
                            chunk_idx = self._chunk_indices.get(session.session_id, 0)
                            await blob.upload_streaming_raw_chunk(
                                chunk_bytes=remaining,
                                tenant_id=session.tenant_id,
                                session_id=session.session_id,
                                chunk_index=chunk_idx,
                            )
                            self._chunk_indices[session.session_id] = chunk_idx + 1
                        except Exception as exc:
                            logger.error(
                                "Failed to upload remaining raw PCM chunk (non-fatal)",
                                session_id=session.session_id,
                                error=str(exc),
                            )

                # Upload raw complete WAV (always — browser PCM, no server processing)
                if has_raw:
                    try:
                        raw_wav_bytes = session.encode_wav()
                        raw_audio_uri = await blob.upload_streaming_raw_complete(
                            wav_bytes=raw_wav_bytes,
                            tenant_id=session.tenant_id,
                            session_id=session.session_id,
                        )
                    except Exception as exc:
                        logger.error(
                            "Failed to upload raw complete WAV (non-fatal)",
                            session_id=session.session_id,
                            error=str(exc),
                        )

                # Upload processed complete WAV (post-preprocess) when available
                if has_processed:
                    try:
                        processed_wav_bytes = session.encode_wav(
                            audio_data=bytes(session.processed_audio_buffer),
                            sample_rate=session.processed_sample_rate,
                        )
                        processed_audio_uri = await blob.upload_streaming_processed_complete(
                            wav_bytes=processed_wav_bytes,
                            tenant_id=session.tenant_id,
                            session_id=session.session_id,
                        )
                    except Exception as exc:
                        logger.error(
                            "Failed to upload processed complete WAV (non-fatal)",
                            session_id=session.session_id,
                            error=str(exc),
                        )

                # Upload transcript
                try:
                    transcript_bytes = session.build_transcript_json()
                    transcript_uri = await blob.upload_streaming_transcript(
                        transcript_bytes=transcript_bytes,
                        tenant_id=session.tenant_id,
                        session_id=session.session_id,
                    )
                except Exception as exc:
                    logger.error(
                        "Failed to upload transcript (non-fatal)",
                        session_id=session.session_id,
                        error=str(exc),
                    )

                # Upload metadata
                try:
                    metadata_bytes = session.build_metadata_json()
                    await blob.upload_streaming_metadata(
                        metadata_bytes=metadata_bytes,
                        tenant_id=session.tenant_id,
                        session_id=session.session_id,
                    )
                except Exception as exc:
                    logger.error(
                        "Failed to upload metadata (non-fatal)",
                        session_id=session.session_id,
                        error=str(exc),
                    )

                if raw_audio_uri or processed_audio_uri or transcript_uri:
                    logger.info(
                        "Session recordings uploaded",
                        session_id=session.session_id,
                        raw_audio_uri=raw_audio_uri,
                        processed_audio_uri=processed_audio_uri,
                        transcript_uri=transcript_uri,
                    )
        except Exception as exc:
            logger.error(
                "Session finalization failed; will still attempt close",
                session_id=session.session_id,
                status=session.status.value,
                error=str(exc),
            )
        finally:
            # session.close() must always execute, regardless of errors above.
            try:
                await session.close(
                    raw_audio_uri=raw_audio_uri,
                    processed_audio_uri=processed_audio_uri,
                    transcript_uri=transcript_uri,
                )
                if publisher:
                    await publisher.publish_status("closed")
            except Exception as close_exc:
                logger.error(
                    "session.close() itself failed",
                    session_id=session.session_id,
                    error=str(close_exc),
                )
            # Always clean up in-memory and capacity state, even if graceful close failed.
            await self.remove_session(session.session_id)

    def _fire_partial(
        self,
        session_id: str,
        utterance: AudioUtterance,
        worker: StreamingInferenceWorker,
        publisher: ResultPublisher,
    ) -> None:
        """Launch (or skip if busy) a background task for partial utterance inference."""
        existing = self._partial_tasks.get(session_id)
        if existing and not existing.done():
            return

        async def _run() -> None:
            try:
                result = await worker.process_partial(session_id, utterance)
                if result and publisher:
                    await publisher.publish(result)
            except Exception as exc:
                logger.warning(
                    "Partial inference failed",
                    session_id=session_id,
                    error=str(exc),
                )
            finally:
                self._partial_tasks.pop(session_id, None)

        self._partial_tasks[session_id] = asyncio.create_task(_run())

    def _cancel_partial(self, session_id: str) -> None:
        """Cancel an in-flight partial inference task."""
        task = self._partial_tasks.pop(session_id, None)
        if task and not task.done():
            task.cancel()

    async def _cancel_session(self, session: StreamSession) -> None:
        """Cancel a session — immediate cleanup, no finalization."""
        session.status = SessionStatus.CLOSED
        session._metadata.closed_at = datetime.utcnow().isoformat()
        await session.force_persist()

        publisher = self._publishers.get(session.session_id)
        if publisher:
            await publisher.publish_status("cancelled")

        await self.remove_session(session.session_id)
        logger.info("Session cancelled", session_id=session.session_id)

    # ------------------------------------------------------------------
    # Recovery on startup
    # ------------------------------------------------------------------

    async def _recover_sessions(self) -> None:
        """Scan Redis for active sessions and rebuild them.

        For each session with ``status: active``:
        1. Restore Tier-1 metadata from Redis Hash
        2. Load VAD + ASR models from the session's pipeline config
        3. Rebuild preprocessor and inference worker with live models
        4. Resume consuming from ``last_seq + 1``

        Note: VAD will start cold after recovery — it stabilizes within
        1-2 s.  Full audio replay for state warming is deferred.
        """
        cursor: int | bytes = 0
        recovered = 0

        while True:
            cursor, keys = await self._redis.scan(
                cursor=cursor,
                match="stt:session:*",
                count=100,
            )
            for key in keys:
                key_str = key.decode() if isinstance(key, bytes) else key
                session_id_for_cleanup: str | None = None
                acquired_capacity_slot = False
                try:
                    data = await self._redis.hgetall(key_str)
                    if not data:
                        continue
                    meta = SessionMetadata.from_redis_dict(data)
                    session_id_for_cleanup = meta.session_id

                    # Only recover active sessions assigned to this worker (or unassigned)
                    if meta.status != SessionStatus.ACTIVE:
                        continue
                    if meta.worker_id and meta.worker_id != self._worker_id:
                        # Check if the other worker is still alive
                        other_alive = await self._redis.exists(worker_key(meta.worker_id))
                        if other_alive:
                            continue  # another worker owns this session

                    # Claim the session
                    meta.worker_id = self._worker_id

                    # Acquire capacity slot
                    if not await self._capacity_guard.try_acquire(meta.session_id):
                        logger.warning(
                            "Cannot recover session — at capacity",
                            session_id=meta.session_id,
                        )
                        continue
                    acquired_capacity_slot = True

                    session = StreamSession(metadata=meta, redis=self._redis)

                    # Load pipeline config and models for recovered session
                    pipeline_config = await self._load_pipeline_config(meta.pipeline_id)

                    # Load VAD service
                    vad_service = await self._load_vad_service(pipeline_config, meta.session_id)

                    # Build preprocessor with VAD config from pipeline
                    vad_kwargs: dict[str, Any] = {}
                    vad_enabled = bool(
                        pipeline_config and pipeline_config.preprocessing.vad.enabled
                    )
                    if vad_enabled:
                        vad_cfg = pipeline_config.preprocessing.vad
                        vad_kwargs["threshold"] = vad_cfg.threshold
                        vad_kwargs["min_speech_duration_ms"] = vad_cfg.min_speech_duration_ms
                        vad_kwargs["min_silence_duration_ms"] = vad_cfg.min_silence_duration_ms
                        if hasattr(vad_cfg, "pre_speech_context_ms"):
                            vad_kwargs["pre_speech_context_ms"] = vad_cfg.pre_speech_context_ms

                    target_sr = (
                        pipeline_config.preprocessing.target_sample_rate
                        if pipeline_config and pipeline_config.preprocessing.target_sample_rate
                        else meta.sample_rate
                    )

                    denoiser = None
                    if pipeline_config:
                        denoise_enabled = pipeline_config.preprocessing.denoise.enabled
                    else:
                        denoise_enabled = self._profile.denoise_enabled_default
                    if denoise_enabled:
                        strength = (
                            pipeline_config.preprocessing.denoise.strength
                            if pipeline_config
                            else 1.0
                        )
                        denoiser = StreamingDenoiser(input_sr=target_sr, strength=strength)
                        if not denoiser.initialize():
                            denoiser = None

                    normalize = (
                        pipeline_config.preprocessing.normalize if pipeline_config else False
                    )

                    preprocessor = StreamingPreprocessor(
                        session_id=meta.session_id,
                        sample_rate=meta.sample_rate,
                        vad_service=vad_service,
                        target_sample_rate=target_sr,
                        normalize=normalize,
                        denoiser=denoiser,
                        **vad_kwargs,
                    )
                    session.processed_sample_rate = target_sr
                    session._vad_active = vad_enabled

                    # Load ASR pipeline
                    asr_pipeline = await self._load_asr_pipeline(
                        pipeline_config,
                        meta.session_id,
                    )

                    publisher = ResultPublisher(redis=self._redis, session_id=meta.session_id)

                    recovery_punct_config = None
                    if pipeline_config and hasattr(pipeline_config, "postprocessing"):
                        pp_cfg = getattr(pipeline_config.postprocessing, "punctuation", None)
                        if pp_cfg and getattr(pp_cfg, "enabled", False):
                            recovery_punct_config = pp_cfg

                    inference_worker = StreamingInferenceWorker(
                        result_publisher=publisher,
                        asr_pipeline=asr_pipeline,
                        tenant_id=meta.tenant_id,
                        consultation_id=meta.consultation_id,
                        diarization_config=(
                            pipeline_config.diarization if pipeline_config else None
                        ),
                        punctuation_config=recovery_punct_config,
                    )

                    # TODO: Replay last ~2 s of audio from Redis Stream to
                    # warm VAD state.  Deferred — VAD starts cold but
                    # stabilizes within 1-2 s of new audio.

                    self._register_inference_runtime(session, inference_worker)

                    # Wire up consumers — resume from last processed entry
                    last_id = "0-0"
                    if meta.last_seq >= 0:
                        # We can't directly map last_seq to a Redis Stream ID
                        # without additional tracking, so we read from the start
                        # and skip already-processed entries via seq comparison.
                        last_id = "0-0"

                    consumer = IngestionConsumer(
                        redis=self._redis,
                        session_id=meta.session_id,
                        on_frame=self._make_frame_handler(session, preprocessor),
                        last_id=last_id,
                    )
                    control_listener = ControlListener(
                        redis=self._redis,
                        session_id=meta.session_id,
                        on_control=self._make_control_handler(session, preprocessor),
                    )

                    self._sessions[meta.session_id] = session
                    self._consumers[meta.session_id] = consumer
                    self._control_listeners[meta.session_id] = control_listener
                    self._publishers[meta.session_id] = publisher
                    self._preprocessors[meta.session_id] = preprocessor
                    self._inference_workers[meta.session_id] = inference_worker

                    await consumer.start()
                    await control_listener.start()
                    await session.force_persist()

                    recovered += 1
                    logger.info(
                        "Session recovered",
                        session_id=meta.session_id,
                        tenant_id=meta.tenant_id,
                        last_seq=meta.last_seq,
                        has_vad=vad_service is not None,
                        has_asr=asr_pipeline is not None,
                    )
                except Exception as exc:
                    logger.error(
                        "Failed to recover session",
                        key=key_str,
                        error=str(exc),
                    )
                    if acquired_capacity_slot:
                        sid = session_id_for_cleanup or key_str.rsplit(":", 1)[-1]
                        await self.remove_session(sid)

            if cursor == 0:
                break

        if recovered:
            logger.info("Session recovery complete", recovered_sessions=recovered)

    # ------------------------------------------------------------------
    # Background reaper
    # ------------------------------------------------------------------

    async def _reaper_loop(self) -> None:
        """Periodically finalize sessions that have been idle too long."""
        try:
            while self._running:
                await asyncio.sleep(self._reaper_interval_s)
                await self._reap_expired_sessions(self._session_timeout_s)
        except asyncio.CancelledError:
            pass

    async def reap_expired_sessions(self, timeout_s: int) -> int:
        """Public helper to reap sessions on-demand."""
        return await self._reap_expired_sessions(timeout_s)

    async def _reap_expired_sessions(self, timeout_s: int) -> int:
        """Finalize sessions with no activity for ``timeout_s`` seconds.

        Returns the number of reaped sessions.
        """
        now = datetime.utcnow()
        to_reap: list[str] = []

        for session_id, session in list(self._sessions.items()):
            if session.status != SessionStatus.ACTIVE:
                continue
            try:
                last = datetime.fromisoformat(session.last_activity)
                idle_seconds = (now - last).total_seconds()
                if idle_seconds > timeout_s:
                    to_reap.append(session_id)
            except (ValueError, TypeError):
                continue

        for session_id in to_reap:
            session = self._sessions.get(session_id)
            if session:
                logger.info(
                    "Reaping idle session",
                    session_id=session_id,
                    timeout_s=timeout_s,
                )
                try:
                    await self._flush_final_utterance(
                        session=session,
                        preprocessor=self._preprocessors.get(session_id),
                    )
                    await self._drain_inference_queue(session_id)
                    await self._finalize_session(session)
                except Exception as exc:
                    logger.error(
                        "Failed to reap session gracefully; forcing removal",
                        session_id=session_id,
                        error=str(exc),
                    )
                    await self.remove_session(session_id)

        return len(to_reap)

    # ------------------------------------------------------------------
    # Audio snapshot loop
    # ------------------------------------------------------------------

    async def _snapshot_loop(self) -> None:
        """Periodically upload raw PCM chunks for active sessions."""
        try:
            while self._running:
                await asyncio.sleep(self._snapshot_interval_s)
                for session_id, session in list(self._sessions.items()):
                    if session.status != SessionStatus.ACTIVE:
                        continue
                    if len(session.processed_audio_buffer) > 0:
                        p_offset = self._processed_chunk_offsets.get(session_id, 0)
                        if p_offset >= len(session.processed_audio_buffer):
                            continue
                    else:
                        offset = self._chunk_offsets.get(session_id, 0)
                        if offset >= len(session.audio_buffer):
                            continue
                    last = self._last_snapshot_at.get(session_id, 0.0)
                    if (time.monotonic() - last) < self._snapshot_interval_s:
                        continue
                    await self._upload_snapshot(session)
        except asyncio.CancelledError:
            pass

    async def _upload_snapshot(self, session: StreamSession) -> None:
        """Upload the next raw PCM chunk of new audio since last snapshot.

        When processed audio is available, prefer the processed buffer
        so that uploaded audio matches what was actually transcribed.
        """
        try:
            if len(session.processed_audio_buffer) > 0:
                p_offset = self._processed_chunk_offsets.get(session.session_id, 0)
                chunk_data = bytes(session.processed_audio_buffer[p_offset:])
                if not chunk_data:
                    return
                chunk_idx = self._processed_chunk_indices.get(session.session_id, 0)
                blob = self._get_blob_service()
                await blob.upload_streaming_processed_chunk(
                    chunk_bytes=chunk_data,
                    tenant_id=session.tenant_id,
                    session_id=session.session_id,
                    chunk_index=chunk_idx,
                )
                self._processed_chunk_offsets[session.session_id] = len(
                    session.processed_audio_buffer
                )
                self._processed_chunk_indices[session.session_id] = chunk_idx + 1
            else:
                offset = self._chunk_offsets.get(session.session_id, 0)
                chunk_data = bytes(session.audio_buffer[offset:])
                if not chunk_data:
                    return
                chunk_idx = self._chunk_indices.get(session.session_id, 0)
                blob = self._get_blob_service()
                await blob.upload_streaming_raw_chunk(
                    chunk_bytes=chunk_data,
                    tenant_id=session.tenant_id,
                    session_id=session.session_id,
                    chunk_index=chunk_idx,
                )
                self._chunk_offsets[session.session_id] = len(session.audio_buffer)
                self._chunk_indices[session.session_id] = chunk_idx + 1
            self._last_snapshot_at[session.session_id] = time.monotonic()
            logger.info(
                "Audio chunk uploaded",
                session_id=session.session_id,
                chunk_index=chunk_idx,
                chunk_bytes=len(chunk_data),
            )
        except Exception as exc:
            logger.warning(
                "Audio chunk upload failed (non-fatal)",
                session_id=session.session_id,
                error=str(exc),
            )

    # ------------------------------------------------------------------
    # Worker heartbeat
    # ------------------------------------------------------------------

    async def _register_worker(self) -> None:
        """Register this worker in Redis with a TTL."""
        key = worker_key(self._worker_id)
        value = {
            "pid": str(os.getpid()),
            "started_at": datetime.utcnow().isoformat(),
            "max_streams": str(self._profile.max_concurrent_streams),
        }
        await self._redis.hset(key, mapping=value)
        await self._redis.expire(key, self._heartbeat_ttl_s)
        logger.info("Worker registered", worker_id=self._worker_id, key=key)

    async def _unregister_worker(self) -> None:
        """Remove this worker's heartbeat key from Redis."""
        key = worker_key(self._worker_id)
        await self._redis.delete(key)
        logger.info("Worker unregistered", worker_id=self._worker_id)

    async def _heartbeat_loop(self) -> None:
        """Periodically extend the worker heartbeat TTL."""
        try:
            while self._running:
                await asyncio.sleep(self._heartbeat_interval_s)
                await self._reconcile_capacity_guard()
                key = worker_key(self._worker_id)
                # Update session list and extend TTL
                session_ids = list(self._sessions.keys())
                await self._redis.hset(
                    key,
                    mapping={
                        "sessions": ",".join(session_ids),
                        "active_sessions": str(len(session_ids)),
                        "last_heartbeat": datetime.utcnow().isoformat(),
                    },
                )
                await self._redis.expire(key, self._heartbeat_ttl_s)
        except asyncio.CancelledError:
            pass

    async def _reconcile_capacity_guard(self) -> None:
        """Self-heal leaked capacity slots that are not present in session maps."""
        guard_ids = set(self._capacity_guard.active_session_ids)
        tracked_ids = set(self._sessions.keys())
        leaked_ids = guard_ids - tracked_ids
        if not leaked_ids:
            return

        for leaked_session_id in leaked_ids:
            await self._capacity_guard.release(leaked_session_id)

        logger.warning(
            "Reconciled leaked capacity slots",
            leaked_count=len(leaked_ids),
            leaked_session_ids=sorted(leaked_ids),
        )

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        """Snapshot for health/status endpoints."""
        return {
            "worker_id": self._worker_id,
            "active_sessions": self.active_session_count,
            "capacity": self._capacity_guard.to_dict(),
            "profile": {
                "platform": self._profile.platform.value,
                "device_name": self._profile.device_name,
                "max_concurrent_streams": self._profile.max_concurrent_streams,
                "asr_device": self._profile.asr_device,
                "asr_max_batch_size": self._profile.asr_max_batch_size,
                "embedding_device": self._profile.embedding_device,
            },
            "sessions": self.list_sessions(),
        }
