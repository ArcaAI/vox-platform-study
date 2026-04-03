"""Streaming data models for Redis Stream communication.

Defines the wire-format schemas for audio frames, transcription results,
session control commands, and session metadata persisted in Redis.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class AudioEncoding(StrEnum):
    """Supported audio encodings for streaming frames."""

    PCM_S16LE = "pcm_s16le"  # 16-bit signed little-endian PCM
    PCM_F32LE = "pcm_f32le"  # 32-bit float little-endian PCM


class SessionStatus(StrEnum):
    """Streaming session lifecycle states."""

    ACTIVE = "active"
    FINALIZING = "finalizing"
    CLOSED = "closed"


class ControlAction(StrEnum):
    """Session control commands sent via ``stt:control:{session_id}``."""

    FINALIZE = "finalize"
    PAUSE = "pause"
    RESUME = "resume"
    CANCEL = "cancel"


# ---------------------------------------------------------------------------
# Audio Frame — written by API Gateway, read by IngestionConsumer
# ---------------------------------------------------------------------------


@dataclass
class AudioFrame:
    """A single audio frame from the Redis audio stream.

    Written by the API Gateway via ``XADD stt:audio:{session_id}``.
    Read by the ``IngestionConsumer`` in the streaming process.

    Fields map directly to Redis Stream hash fields.
    """

    seq: int  # monotonic sequence number
    sr: int  # sample rate (e.g. 16000)
    enc: AudioEncoding  # encoding (pcm_s16le, pcm_f32le)
    ch: int  # channels (1 = mono)
    data: bytes  # raw audio bytes (NOT base64)
    final: bool  # True if this is the last frame
    ts: float  # client-side timestamp (epoch seconds)

    def to_redis_dict(self) -> dict[str, str | bytes]:
        """Serialize to Redis Stream field dict for ``XADD``.

        Binary ``data`` is stored as-is (Redis Streams support binary values).
        All other fields are stringified for Redis compatibility.
        """
        return {
            "seq": str(self.seq),
            "sr": str(self.sr),
            "enc": self.enc.value,
            "ch": str(self.ch),
            "data": self.data,
            "final": "1" if self.final else "0",
            "ts": str(self.ts),
        }

    @classmethod
    def from_redis_dict(cls, d: dict[str | bytes, str | bytes]) -> AudioFrame:
        """Deserialize from Redis Stream entry dict.

        Redis returns field names and values as ``bytes`` when using
        ``redis.asyncio``; this method handles both ``str`` and ``bytes`` keys.
        """
        def _get(key: str) -> str | bytes:
            # Try str key first, then bytes key.
            # Use `is None` instead of truthiness to handle b"" correctly.
            val = d.get(key)
            if val is None:
                val = d.get(key.encode())
            if val is None:
                raise KeyError(f"Missing required field: {key}")
            return val

        def _str(val: str | bytes) -> str:
            return val.decode() if isinstance(val, bytes) else val

        seq = int(_str(_get("seq")))
        sr = int(_str(_get("sr")))
        enc = AudioEncoding(_str(_get("enc")))
        ch = int(_str(_get("ch")))
        raw_data = _get("data")
        data = raw_data if isinstance(raw_data, bytes) else raw_data.encode()
        final = _str(_get("final")) == "1"
        ts = float(_str(_get("ts")))

        return cls(
            seq=seq,
            sr=sr,
            enc=enc,
            ch=ch,
            data=data,
            final=final,
            ts=ts,
        )


# ---------------------------------------------------------------------------
# Segment Result — written by streaming process, read by API Gateway
# ---------------------------------------------------------------------------


@dataclass
class SegmentResult:
    """A transcription segment result published to ``stt:result:{session_id}``.

    Represents one utterance (speech segment delimited by VAD silence).

    ``word_timestamps`` carries per-word timing when the ASR engine
    provides it (Whisper SAFETENSOR / ONNX).  Each entry is a dict::

        {"word": str, "start_time": float, "end_time": float,
         "confidence": float | None}

    Timestamps are session-relative (offset by the utterance start time).
    Confidence is ``None`` for Whisper (no per-word confidence available).
    """

    text: str
    english_text: str | None = None
    speaker_id: str | None = None
    speaker_confidence: float = 0.0
    start_time: float = 0.0
    end_time: float = 0.0
    is_final: bool = False
    word_timestamps: list[dict[str, Any]] = field(default_factory=list)
    inference_ms: float = 0.0

    def to_redis_dict(self) -> dict[str, str]:
        """Serialize to Redis Stream field dict for ``XADD``."""
        d: dict[str, str] = {
            "type": "segment",
            "text": self.text,
            "speaker_id": self.speaker_id or "",
            "speaker_confidence": str(round(self.speaker_confidence, 4)),
            "start_time": str(round(self.start_time, 4)),
            "end_time": str(round(self.end_time, 4)),
            "is_final": "1" if self.is_final else "0",
            "inference_ms": str(round(self.inference_ms, 1)),
        }
        if self.english_text:
            d["english_text"] = self.english_text
        if self.word_timestamps:
            d["word_timestamps_json"] = json.dumps(
                self.word_timestamps, ensure_ascii=False,
            )
        return d

    @classmethod
    def from_redis_dict(cls, d: dict[str | bytes, str | bytes]) -> SegmentResult:
        """Deserialize from Redis Stream entry dict."""

        def _str(val: str | bytes) -> str:
            return val.decode() if isinstance(val, bytes) else val

        def _get(key: str) -> str:
            val = d.get(key)
            if val is None:
                val = d.get(key.encode())
            if val is None:
                return ""
            return _str(val)

        speaker_id = _get("speaker_id") or None

        word_timestamps: list[dict[str, Any]] = []
        wt_json = _get("word_timestamps_json")
        if wt_json:
            try:
                word_timestamps = json.loads(wt_json)
            except (json.JSONDecodeError, TypeError):
                pass

        return cls(
            text=_get("text"),
            english_text=_get("english_text") or None,
            speaker_id=speaker_id,
            speaker_confidence=float(_get("speaker_confidence") or "0"),
            start_time=float(_get("start_time") or "0"),
            end_time=float(_get("end_time") or "0"),
            is_final=_get("is_final") == "1",
            word_timestamps=word_timestamps,
            inference_ms=float(_get("inference_ms") or "0"),
        )


# ---------------------------------------------------------------------------
# Session Control — sent by API Gateway or admin to control session
# ---------------------------------------------------------------------------


@dataclass
class SessionControl:
    """A control command sent via ``stt:control:{session_id}``.

    Actions: finalize, pause, resume, cancel.
    """

    action: ControlAction

    def to_redis_dict(self) -> dict[str, str]:
        """Serialize to Redis Stream field dict for ``XADD``."""
        return {"action": self.action.value}

    @classmethod
    def from_redis_dict(cls, d: dict[str | bytes, str | bytes]) -> SessionControl:
        """Deserialize from Redis Stream entry dict."""

        def _str(val: str | bytes) -> str:
            return val.decode() if isinstance(val, bytes) else val

        raw = d.get("action")
        if raw is None:
            raw = d.get(b"action")
        if raw is None:
            raise KeyError("Missing required field: action")
        return cls(action=ControlAction(_str(raw)))


# ---------------------------------------------------------------------------
# Session Metadata — persisted in Redis Hash ``stt:session:{session_id}``
# ---------------------------------------------------------------------------


@dataclass
class SessionMetadata:
    """Tier 1 session state persisted as a Redis Hash.

    Survives process restarts. Ephemeral state (RNNoise, VAD, ring buffer)
    is rebuilt by replaying the last ~2 seconds from the audio stream.
    """

    session_id: str
    tenant_id: str
    pipeline_id: str
    consultation_id: str | None = None
    microphone_id: str | None = None
    status: SessionStatus = SessionStatus.ACTIVE
    created_at: str = ""  # ISO-8601
    last_activity: str = ""  # ISO-8601
    total_samples_received: int = 0
    total_duration_seconds: float = 0.0
    utterance_count: int = 0
    last_seq: int = -1
    sample_rate: int = 16000
    pipeline_config_json: str = ""  # serialized PreprocessingConfig
    closed_at: str | None = None  # ISO-8601 (set when status=closed)
    raw_audio_uri: str | None = None
    processed_audio_uri: str | None = None
    transcript_uri: str | None = None
    worker_id: str | None = None
    diarization: bool = False  # Resolved from pipeline config at session creation

    def __post_init__(self) -> None:
        if not self.created_at:
            self.created_at = datetime.utcnow().isoformat()
        if not self.last_activity:
            self.last_activity = datetime.utcnow().isoformat()

    def to_redis_dict(self) -> dict[str, str]:
        """Serialize to a flat dict for ``HSET``."""
        d: dict[str, str] = {
            "session_id": self.session_id,
            "tenant_id": self.tenant_id,
            "pipeline_id": self.pipeline_id,
            "consultation_id": self.consultation_id or "",
            "microphone_id": self.microphone_id or "",
            "status": self.status.value,
            "created_at": self.created_at,
            "last_activity": self.last_activity,
            "total_samples_received": str(self.total_samples_received),
            "total_duration_seconds": str(round(self.total_duration_seconds, 4)),
            "utterance_count": str(self.utterance_count),
            "last_seq": str(self.last_seq),
            "sample_rate": str(self.sample_rate),
            "pipeline_config_json": self.pipeline_config_json,
            "diarization": "1" if self.diarization else "0",
        }
        if self.closed_at:
            d["closed_at"] = self.closed_at
        if self.raw_audio_uri:
            d["raw_audio_uri"] = self.raw_audio_uri
        if self.processed_audio_uri:
            d["processed_audio_uri"] = self.processed_audio_uri
        if self.transcript_uri:
            d["transcript_uri"] = self.transcript_uri
        if self.worker_id:
            d["worker_id"] = self.worker_id
        return d

    @classmethod
    def from_redis_dict(cls, d: dict[str | bytes, str | bytes]) -> SessionMetadata:
        """Deserialize from a Redis Hash (``HGETALL`` result)."""

        def _str(val: str | bytes | None) -> str:
            if val is None:
                return ""
            return val.decode() if isinstance(val, bytes) else val

        def _get(key: str) -> str:
            val = d.get(key)
            if val is None:
                val = d.get(key.encode())
            return _str(val)

        consultation_id = _get("consultation_id") or None
        microphone_id = _get("microphone_id") or None
        closed_at = _get("closed_at") or None
        raw_audio_uri = _get("raw_audio_uri") or None
        processed_audio_uri = _get("processed_audio_uri") or None
        transcript_uri = _get("transcript_uri") or None
        worker_id = _get("worker_id") or None
        diarization = _get("diarization") == "1"

        return cls(
            session_id=_get("session_id"),
            tenant_id=_get("tenant_id"),
            pipeline_id=_get("pipeline_id"),
            consultation_id=consultation_id,
            microphone_id=microphone_id,
            status=SessionStatus(_get("status") or "active"),
            created_at=_get("created_at"),
            last_activity=_get("last_activity"),
            total_samples_received=int(_get("total_samples_received") or "0"),
            total_duration_seconds=float(_get("total_duration_seconds") or "0"),
            utterance_count=int(_get("utterance_count") or "0"),
            last_seq=int(_get("last_seq") or "-1"),
            sample_rate=int(_get("sample_rate") or "16000"),
            pipeline_config_json=_get("pipeline_config_json"),
            closed_at=closed_at,
            raw_audio_uri=raw_audio_uri,
            processed_audio_uri=processed_audio_uri,
            transcript_uri=transcript_uri,
            worker_id=worker_id,
            diarization=diarization,
        )
