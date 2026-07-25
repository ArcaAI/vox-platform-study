"""Redis Pub/Sub publisher for real-time transcription events.

Publishes SSE-compatible JSON events to per-job Redis channels so that
the NestJS API Gateway can subscribe and relay them to clients via SSE.

Channel format: ``{settings.pubsub_channel_prefix}{job_id}``
  e.g. ``stt:transcription:01234567-89ab-cdef-0123-456789abcdef``

Uses ``redis.asyncio`` for non-blocking I/O.  The publisher is designed
to be created per-worker-invocation (Dramatiq actors run in separate
processes) and closed after each job completes.

Event types (matching the SSE schema):
- ``status``     — job lifecycle transitions
- ``progress``   — processing percentage
- ``chunk``      — partial transcript as each audio segment completes
- ``transcript`` — full final result
- ``error``      — failure notification
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import structlog

from stt.core.config.settings import get_settings

logger = structlog.get_logger(__name__)


def _channel_key(job_id: str) -> str:
    """Build the Redis Pub/Sub channel for a job."""
    return f"{get_settings().pubsub_channel_prefix}{job_id}"


def _utc_iso() -> str:
    """Current UTC time in ISO 8601 format."""
    return datetime.now(UTC).isoformat()


class TranscriptionEventPublisher:
    """Publishes real-time transcription events to Redis Pub/Sub.

    Lifecycle:
        1. ``await publisher.connect()``
        2. Publish events during transcription
        3. ``await publisher.close()`` in finally-block

    The publisher gracefully degrades when Redis is unavailable —
    publish methods log a warning and return without raising, since
    the gateway API calls (start/progress/complete/fail) already
    persist state.  Real-time events are best-effort.
    """

    def __init__(self) -> None:
        self._redis: Any | None = None  # redis.asyncio.Redis
        self._connected = False

    @property
    def is_connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        """Open a dedicated Redis connection for Pub/Sub publishing."""
        if self._connected:
            return

        settings = get_settings()
        if not settings.pubsub_enabled:
            logger.info("Pub/Sub publishing is disabled via settings")
            return

        try:
            import redis.asyncio as aioredis

            self._redis = aioredis.from_url(
                settings.redis_url,
                decode_responses=True,
            )
            # Verify connectivity
            await self._redis.ping()
            self._connected = True
            logger.info("TranscriptionEventPublisher connected to Redis")
        except Exception as exc:
            logger.warning(
                "Failed to connect TranscriptionEventPublisher to Redis — "
                "real-time events will be skipped",
                error=str(exc),
            )
            self._redis = None
            self._connected = False

    async def close(self) -> None:
        """Close the Redis connection."""
        if self._redis is not None:
            try:
                await self._redis.aclose()
            except Exception as exc:
                logger.warning(
                    "Failed to close Redis Pub/Sub connection",
                    error=str(exc),
                )
            finally:
                self._redis = None
        self._connected = False

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _publish(self, job_id: str, event: dict[str, Any]) -> None:
        """Publish a JSON event to the job's Redis channel.

        Silently returns on failure — real-time events are best-effort.
        """
        if not self._connected or self._redis is None:
            return

        channel = _channel_key(job_id)
        try:
            message = json.dumps(event, default=str)
            await self._redis.publish(channel, message)
            logger.debug(
                "Published event",
                channel=channel,
                event_type=event.get("type"),
            )
        except Exception as exc:
            logger.warning(
                "Failed to publish event to Redis",
                channel=channel,
                event_type=event.get("type"),
                error=str(exc),
            )

    # ------------------------------------------------------------------
    # Public publish methods
    # ------------------------------------------------------------------

    async def publish_status(
        self,
        job_id: str,
        status: str,
        *,
        worker_id: str | None = None,
    ) -> None:
        """Publish a job lifecycle status event.

        Args:
            job_id: Transcription job ID.
            status: Job status (QUEUED, PROCESSING, COMPLETED, FAILED).
            worker_id: Optional worker identifier.
        """
        data: dict[str, Any] = {
            "jobId": job_id,
            "status": status,
            "timestamp": _utc_iso(),
        }
        if worker_id:
            data["workerId"] = worker_id

        await self._publish(job_id, {"type": "status", "data": data})

    async def publish_progress(
        self,
        job_id: str,
        progress: int,
        stage: str = "",
    ) -> None:
        """Publish a progress update event.

        Args:
            job_id: Transcription job ID.
            progress: Processing percentage (0-100).
            stage: Optional stage name (e.g. "inference", "diarization").
        """
        data: dict[str, Any] = {
            "jobId": job_id,
            "progress": progress,
        }
        if stage:
            data["stage"] = stage

        await self._publish(job_id, {"type": "progress", "data": data})

    async def publish_chunk(
        self,
        job_id: str,
        chunk: Any,
    ) -> None:
        """Publish a partial transcript chunk event.

        Args:
            job_id: Transcription job ID.
            chunk: A ``ChunkTranscriptionResult`` instance. Uses
                ``chunk.to_dict()`` for serialization.
        """
        chunk_dict = chunk.to_dict() if hasattr(chunk, "to_dict") else dict(chunk)
        data: dict[str, Any] = {
            "jobId": job_id,
            "chunkIndex": chunk_dict.get("chunk_index", 0),
            "text": chunk_dict.get("text", ""),
            "startTime": chunk_dict.get("start_time", 0.0),
            "endTime": chunk_dict.get("end_time", 0.0),
            "isFinal": chunk_dict.get("is_final", False),
        }
        # Include speaker diarization fields when available
        speaker_id = chunk_dict.get("speaker_id")
        if speaker_id is not None:
            data["speakerId"] = speaker_id
        speaker_confidence = chunk_dict.get("speaker_confidence")
        if speaker_confidence is not None:
            data["speakerConfidence"] = speaker_confidence
        # Include word timestamps when available
        word_ts = chunk_dict.get("word_timestamps")
        if word_ts:
            data["wordTimestamps"] = [
                {
                    "word": w.get("word", ""),
                    "start": w.get("start_time", w.get("start", 0.0)),
                    "end": w.get("end_time", w.get("end", 0.0)),
                    "confidence": w.get("confidence", 1.0),
                }
                for w in word_ts
            ]

        await self._publish(job_id, {"type": "chunk", "data": data})

    async def publish_transcript(
        self,
        job_id: str,
        result: Any,
    ) -> None:
        """Publish the full final transcript event.

        Args:
            job_id: Transcription job ID.
            result: A ``TranscriptionResult`` instance. Uses
                ``result.to_dict()`` for serialization.
        """
        result_dict = result.to_dict() if hasattr(result, "to_dict") else dict(result)

        data: dict[str, Any] = {
            "jobId": job_id,
            "text": result_dict.get("text", ""),
            "language": result_dict.get("language"),
            "languageProbability": result_dict.get("language_probability"),
            "durationSeconds": result_dict.get("duration_seconds", 0.0),
            "processingTimeSeconds": result_dict.get("processing_time_seconds", 0.0),
            # Use "start"/"end" to match TypeScript WordTimestamp interface
            # (consistent with chunk word timestamps)
            "wordTimestamps": [
                {
                    "word": w.get("word", ""),
                    "start": w.get("start_time", w.get("start", 0.0)),
                    "end": w.get("end_time", w.get("end", 0.0)),
                    "confidence": w.get("confidence", 1.0),
                }
                for w in result_dict.get("word_timestamps", [])
            ],
            "sentenceTimestamps": [
                {
                    "text": s.get("text", ""),
                    "startTime": s.get("start_time", 0.0),
                    "endTime": s.get("end_time", 0.0),
                    "englishText": s.get("english_text"),
                }
                for s in result_dict.get("sentence_timestamps", [])
            ],
            "metadata": result_dict.get("metadata", {}),
        }

        await self._publish(job_id, {"type": "transcript", "data": data})

    async def publish_error(
        self,
        job_id: str,
        error_code: str,
        message: str,
    ) -> None:
        """Publish an error event.

        Args:
            job_id: Transcription job ID.
            error_code: Machine-readable error code.
            message: Human-readable error description.
        """
        data: dict[str, Any] = {
            "jobId": job_id,
            "errorCode": error_code,
            "message": message,
        }

        await self._publish(job_id, {"type": "error", "data": data})
