"""StreamSession — Redis-backed streaming session with two-tier persistence.

**Tier 1 (Redis Hash)** — durable metadata persisted every N seconds via
:meth:`persist_if_needed`. Survives process restarts.

**Tier 2 (in-memory)** — ephemeral state (RNNoise, VAD, ring buffer,
current utterance) that is rebuilt on recovery by replaying the last ~2 s
of audio from the Redis Stream.

This module only contains the session *data object* and its persistence
logic.  Session *lifecycle* orchestration (create, recovery, reaping) is
in :mod:`stt_v2.streaming.session_manager`.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime
from typing import Any

import structlog

from stt_v2.core.config.settings import get_settings
from stt_v2.streaming.schemas import (
    SegmentResult,
    SessionMetadata,
    SessionStatus,
)

logger = structlog.get_logger(__name__)

_OVERFLOW_THROTTLE_S = 30.0


class StreamSession:
    """State for a single real-time streaming session.

    Holds both Tier-1 (Redis-persisted) and Tier-2 (in-memory) state.
    The ``redis`` parameter is an ``redis.asyncio.Redis`` instance used
    for persistence.

    Parameters
    ----------
    metadata:
        Tier-1 metadata (restored from Redis on recovery, or freshly
        created for a new session).
    redis:
        Async Redis client for Tier-1 persistence.
    persist_interval_s:
        Minimum seconds between Tier-1 writes (default from settings).
    """

    def __init__(
        self,
        metadata: SessionMetadata,
        redis: Any,  # redis.asyncio.Redis — Any to avoid import at module level
        persist_interval_s: float | None = None,
        result_stream_expire_s: int | None = None,
        session_metadata_expire_s: int | None = None,
    ) -> None:
        self._metadata = metadata
        self._redis = redis

        # Resolve defaults from settings once at construction time so that
        # methods like ``close()`` never need to call ``get_settings()``
        # (which can fail in unit tests if env vars are not perfectly set).
        try:
            _settings = get_settings()
            _default_persist = _settings.streaming_session_persist_interval_s
            _default_stream_ttl = _settings.streaming_result_stream_expire_s
            _default_meta_ttl = _settings.streaming_session_metadata_expire_s
            _default_max_audio = _settings.streaming_max_audio_buffer_bytes
        except Exception:
            _default_persist = 5.0
            _default_stream_ttl = 3600
            _default_meta_ttl = 86400
            _default_max_audio = 500_000_000

        self._persist_interval_s = (
            persist_interval_s if persist_interval_s is not None else _default_persist
        )
        self._result_stream_expire_s = (
            result_stream_expire_s if result_stream_expire_s is not None else _default_stream_ttl
        )
        self._session_metadata_expire_s = (
            session_metadata_expire_s
            if session_metadata_expire_s is not None
            else _default_meta_ttl
        )
        self._max_audio_buffer_bytes: int = _default_max_audio
        self._audio_buffer_warned: bool = False
        self._last_persisted_at: float = 0.0

        # ---- Tier-2: in-memory ephemeral state ----
        # These are *not* persisted. They are rebuilt on recovery by
        # replaying the tail of the audio stream.
        self.ring_buffer: bytearray = bytearray()
        self.current_utterance: bytearray = bytearray()
        self.utterance_start_time: float = 0.0
        self.silence_counter_ms: int = 0
        self.results: list[SegmentResult] = []
        self.pending_segments: asyncio.Queue[Any] = asyncio.Queue()

        # Full-session audio accumulator (append-only, never trimmed)
        self.audio_buffer: bytearray = bytearray()

        # Ring buffer overflow throttle state
        self._overflow_window_start: float = 0.0
        self._overflow_acc_bytes: int = 0
        self._overflow_acc_events: int = 0

    # ------------------------------------------------------------------
    # Tier-1 accessors (delegate to metadata)
    # ------------------------------------------------------------------

    @property
    def session_id(self) -> str:
        return self._metadata.session_id

    @property
    def tenant_id(self) -> str:
        return self._metadata.tenant_id

    @property
    def pipeline_id(self) -> str:
        return self._metadata.pipeline_id

    @property
    def consultation_id(self) -> str | None:
        return self._metadata.consultation_id

    @property
    def status(self) -> SessionStatus:
        return self._metadata.status

    @status.setter
    def status(self, value: SessionStatus) -> None:
        self._metadata.status = value

    @property
    def created_at(self) -> str:
        return self._metadata.created_at

    @property
    def last_activity(self) -> str:
        return self._metadata.last_activity

    @property
    def total_samples_received(self) -> int:
        return self._metadata.total_samples_received

    @property
    def total_duration_seconds(self) -> float:
        return self._metadata.total_duration_seconds

    @property
    def utterance_count(self) -> int:
        return self._metadata.utterance_count

    @utterance_count.setter
    def utterance_count(self, value: int) -> None:
        self._metadata.utterance_count = value

    @property
    def last_seq(self) -> int:
        return self._metadata.last_seq

    @property
    def sample_rate(self) -> int:
        return self._metadata.sample_rate

    @property
    def metadata(self) -> SessionMetadata:
        """Direct access to the underlying Tier-1 metadata."""
        return self._metadata

    # ------------------------------------------------------------------
    # Frame processing
    # ------------------------------------------------------------------

    def record_frame(self, seq: int, data: bytes, sample_rate: int) -> None:
        """Record receipt of an audio frame (Tier-2 bookkeeping).

        Updates sequence tracking, sample counts, duration, and
        last-activity timestamp. Does **not** trigger Redis persistence —
        call :meth:`persist_if_needed` separately.
        """
        self._metadata.last_seq = seq
        num_samples = len(data) // 2  # pcm_s16le: 2 bytes per sample
        self._metadata.total_samples_received += num_samples
        self._metadata.total_duration_seconds += num_samples / sample_rate
        self._metadata.last_activity = datetime.utcnow().isoformat()
        self._metadata.sample_rate = sample_rate

        # Append to full-session accumulator (cap enforced)
        if len(self.audio_buffer) + len(data) <= self._max_audio_buffer_bytes:
            self.audio_buffer.extend(data)
        elif not self._audio_buffer_warned:
            self._audio_buffer_warned = True
            logger.warning(
                "Audio buffer cap reached — new frames will be dropped",
                session_id=self.session_id,
                buffer_bytes=len(self.audio_buffer),
                cap_bytes=self._max_audio_buffer_bytes,
            )

        # Append to ring buffer (cap at ~30 s of 16 kHz mono 16-bit = ~960 KB)
        max_ring_bytes = sample_rate * 2 * 30  # 30 seconds per TASK-014 design
        self.ring_buffer.extend(data)
        if len(self.ring_buffer) > max_ring_bytes:
            overflow = len(self.ring_buffer) - max_ring_bytes
            del self.ring_buffer[:overflow]

            now = time.monotonic()
            if self._overflow_acc_events == 0:
                logger.info(
                    "Ring buffer overflow, trimming oldest frames",
                    session_id=self.session_id,
                    overflow_bytes=overflow,
                    throttle_window_s=_OVERFLOW_THROTTLE_S,
                )
                self._overflow_window_start = now
                self._overflow_acc_bytes = overflow
                self._overflow_acc_events = 1
            elif (now - self._overflow_window_start) >= _OVERFLOW_THROTTLE_S:
                logger.info(
                    "Ring buffer overflow (throttled summary)",
                    session_id=self.session_id,
                    window_events=self._overflow_acc_events,
                    window_bytes=self._overflow_acc_bytes,
                    throttle_window_s=_OVERFLOW_THROTTLE_S,
                )
                self._overflow_window_start = now
                self._overflow_acc_bytes = overflow
                self._overflow_acc_events = 1
            else:
                self._overflow_acc_bytes += overflow
                self._overflow_acc_events += 1

    def _flush_overflow_summary_if_pending(self) -> None:
        """Emit a final overflow summary if throttled stats are pending."""
        if self._overflow_acc_events == 0:
            return

        logger.info(
            "Ring buffer overflow (final summary)",
            session_id=self.session_id,
            window_events=self._overflow_acc_events,
            window_bytes=self._overflow_acc_bytes,
            throttle_window_s=_OVERFLOW_THROTTLE_S,
        )
        self._overflow_window_start = 0.0
        self._overflow_acc_bytes = 0
        self._overflow_acc_events = 0

    def add_result(self, result: SegmentResult) -> None:
<<<<<<< HEAD
        """Append a completed transcription segment (finals only)."""
=======
        """Append a completed transcription segment.

        Only final results are persisted; partial (non-final) results are
        discarded since they will be superseded by a final result.
        """
>>>>>>> 82b5860e1c638f793db6899acebc39cecf34f854
        if not result.is_final:
            return
        self.results.append(result)

    # ------------------------------------------------------------------
    # Audio encoding
    # ------------------------------------------------------------------

    def encode_wav(self) -> bytes:
        """Encode the full ``audio_buffer`` as a WAV file.

        The buffer contains raw PCM s16le samples, so no sample
        conversion is needed — frames are written directly.

        Returns:
            WAV file bytes (empty WAV if buffer is empty).
        """
        import io
        import wave

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(self.sample_rate)
            wf.writeframes(bytes(self.audio_buffer))
        return buf.getvalue()

    def build_transcript_json(self) -> bytes:
        """Build a JSON transcript from accumulated results.

        Returns:
            UTF-8 encoded JSON bytes with session metadata and segments.
        """
        import json

        segments = []
        for r in self.results:
            seg: dict[str, Any] = {
                "text": r.text,
                "start_time": round(r.start_time, 4),
                "end_time": round(r.end_time, 4),
                "is_final": r.is_final,
            }
            if r.english_text:
                seg["english_text"] = r.english_text
            if r.speaker_id:
                seg["speaker_id"] = r.speaker_id
                seg["speaker_confidence"] = round(r.speaker_confidence, 4)
            if r.word_timestamps:
                seg["word_timestamps"] = r.word_timestamps
            segments.append(seg)

        transcript = {
            "session_id": self.session_id,
            "tenant_id": self.tenant_id,
            "consultation_id": self.consultation_id,
            "total_duration_seconds": round(self.total_duration_seconds, 4),
            "segment_count": len(segments),
            "segments": segments,
        }
        return json.dumps(transcript, ensure_ascii=False).encode("utf-8")

    def build_metadata_json(self) -> bytes:
        """Build a JSON metadata document for the session.

        Returns:
            UTF-8 encoded JSON bytes with session metadata and pipeline config.
        """
        import json

        metadata: dict[str, Any] = {
            "session_id": self.session_id,
            "tenant_id": self.tenant_id,
            "pipeline_id": self.pipeline_id,
            "consultation_id": self.consultation_id,
            "sample_rate": self.sample_rate,
            "total_duration_seconds": round(self.total_duration_seconds, 4),
            "total_samples_received": self.total_samples_received,
            "utterance_count": self.utterance_count,
            "created_at": self.created_at,
            "last_activity": self.last_activity,
            "audio_buffer_bytes": len(self.audio_buffer),
        }
        return json.dumps(metadata, ensure_ascii=False).encode("utf-8")

    # ------------------------------------------------------------------
    # Tier-1 persistence
    # ------------------------------------------------------------------

    async def persist_if_needed(self) -> bool:
        """Persist Tier-1 state to Redis if the interval has elapsed.

        Returns ``True`` if a write was performed, ``False`` otherwise.
        """
        now = time.monotonic()
        if now - self._last_persisted_at < self._persist_interval_s:
            return False
        await self._persist()
        self._last_persisted_at = now
        return True

    async def force_persist(self) -> None:
        """Immediately write Tier-1 state to Redis (ignoring interval)."""
        await self._persist()
        self._last_persisted_at = time.monotonic()

    async def _persist(self) -> None:
        """Write the current metadata to the Redis Hash."""
        key = f"stt:session:{self.session_id}"
        mapping = self._metadata.to_redis_dict()
        await self._redis.hset(key, mapping=mapping)
        logger.debug("Session persisted", session_id=self.session_id, key=key)

    # ------------------------------------------------------------------
    # Finalization
    # ------------------------------------------------------------------

    async def finalize(self) -> None:
        """Mark the session as finalizing, persist, and set stream TTLs.

        After calling this method, the caller should:
        1. Wait for ``pending_segments`` to drain.
        2. Upload audio / transcript to MinIO.
        3. Call :meth:`close` when everything is done.
        """
        self.status = SessionStatus.FINALIZING
        await self.force_persist()
        logger.info("Session finalizing", session_id=self.session_id)

    async def close(
        self,
        raw_audio_uri: str | None = None,
        processed_audio_uri: str | None = None,
        transcript_uri: str | None = None,
    ) -> None:
        """Close the session — update Redis metadata and set key TTLs.

        Parameters
        ----------
        raw_audio_uri:
            MinIO URI for the raw audio recording.
        processed_audio_uri:
            MinIO URI for the processed audio recording.
        transcript_uri:
            MinIO URI for the final transcript JSON.
        """
        self._flush_overflow_summary_if_pending()

        self.status = SessionStatus.CLOSED
        self._metadata.closed_at = datetime.utcnow().isoformat()
        self._metadata.raw_audio_uri = raw_audio_uri
        self._metadata.processed_audio_uri = processed_audio_uri
        self._metadata.transcript_uri = transcript_uri
        await self.force_persist()

        # Set TTL on stream keys (1 hour default)
        stream_ttl = self._result_stream_expire_s
        for key in (
            f"stt:audio:{self.session_id}",
            f"stt:result:{self.session_id}",
            f"stt:control:{self.session_id}",
        ):
            await self._redis.expire(key, stream_ttl)

        # Session metadata key — longer TTL (24 hours default)
        meta_ttl = self._session_metadata_expire_s
        await self._redis.expire(f"stt:session:{self.session_id}", meta_ttl)

        logger.info(
            "Session closed",
            session_id=self.session_id,
            stream_ttl_s=stream_ttl,
            metadata_ttl_s=meta_ttl,
        )

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        """Snapshot for health/status endpoints."""
        return {
            "session_id": self.session_id,
            "tenant_id": self.tenant_id,
            "pipeline_id": self.pipeline_id,
            "consultation_id": self.consultation_id,
            "status": self.status.value,
            "created_at": self.created_at,
            "last_activity": self.last_activity,
            "total_samples_received": self.total_samples_received,
            "total_duration_seconds": round(self.total_duration_seconds, 2),
            "utterance_count": self.utterance_count,
            "last_seq": self.last_seq,
            "sample_rate": self.sample_rate,
            "results_count": len(self.results),
            "ring_buffer_bytes": len(self.ring_buffer),
            "audio_buffer_bytes": len(self.audio_buffer),
            "pending_segments": self.pending_segments.qsize(),
        }
