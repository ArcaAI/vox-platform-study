"""Transcription DTOs and data structures."""

import io
import wave
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import numpy as np


@dataclass
class WordTimestamp:
    """Word with timing information."""

    word: str
    start_time: float  # seconds
    end_time: float  # seconds
    confidence: float = 1.0


@dataclass
class SentenceTimestamp:
    """Sentence with timing information."""

    text: str
    start_time: float
    end_time: float
    english_text: str | None = None
    words: list[WordTimestamp] = field(default_factory=list)


@dataclass
class AudioSegment:
    """Audio segment from VAD."""

    start_time: float
    end_time: float
    is_speech: bool = True
    confidence: float = 1.0
    speaker_id: str | None = None
    speaker_confidence: float | None = None

    @property
    def duration(self) -> float:
        """Get segment duration in seconds."""
        return self.end_time - self.start_time


@dataclass
class ProcessedAudio:
    """Result of audio preprocessing."""

    samples: Any  # numpy array
    sample_rate: int
    duration_seconds: float
    segments: list[AudioSegment] = field(default_factory=list)
    was_resampled: bool = False
    was_normalized: bool = False
    vad_applied: bool = False
    denoise_applied: bool = False

    # ------------------------------------------------------------------
    # Audio conversion helpers
    # ------------------------------------------------------------------

    def to_wav_bytes(self) -> bytes:
        """Convert the processed samples to 16-bit PCM WAV bytes.

        Returns:
            WAV file content as ``bytes``.
        """
        samples = np.asarray(self.samples, dtype=np.float32)
        pcm_int16 = (samples * 32767).clip(-32768, 32767).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(self.sample_rate)
            wf.writeframes(pcm_int16.tobytes())
        return buf.getvalue()

    def get_vad_merged_wav_bytes(self, silence_padding_ms: int = 0) -> bytes | None:
        """Extract and concatenate only the VAD speech segments as WAV.

        If VAD was not applied or no speech segments exist, returns
        ``None``.

        When *silence_padding_ms* is greater than zero, a block of silence
        (zeros) of the specified duration is inserted **before** and
        **after** each speech segment.  This is typically used when
        diarization is enabled so that speaker turns have natural gaps in
        the stored audio.

        Args:
            silence_padding_ms: Milliseconds of silence to insert before
                and after each speech segment.  Defaults to ``0`` (no
                padding — preserves legacy behaviour).

        Returns:
            WAV bytes of merged speech segments, or ``None``.
        """
        if not self.vad_applied or not self.segments:
            return None

        samples = np.asarray(self.samples, dtype=np.float32)
        merged_parts: list[np.ndarray] = []

        # Pre-compute silence block (empty when padding is 0)
        silence: np.ndarray | None = None
        if silence_padding_ms > 0:
            silence_samples = int(silence_padding_ms * self.sample_rate / 1000)
            silence = np.zeros(silence_samples, dtype=np.float32)

        for seg in self.segments:
            if not seg.is_speech:
                continue
            start_idx = int(seg.start_time * self.sample_rate)
            end_idx = int(seg.end_time * self.sample_rate)
            # Clamp to array bounds
            start_idx = max(0, start_idx)
            end_idx = min(len(samples), end_idx)
            if end_idx > start_idx:
                if silence is not None:
                    merged_parts.append(silence)
                merged_parts.append(samples[start_idx:end_idx])
                if silence is not None:
                    merged_parts.append(silence)

        if not merged_parts:
            return None

        merged = np.concatenate(merged_parts)
        pcm_int16 = (merged * 32767).clip(-32768, 32767).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(self.sample_rate)
            wf.writeframes(pcm_int16.tobytes())
        return buf.getvalue()


@dataclass
class RawTranscription:
    """Raw output from ASR model."""

    text: str
    language: str | None = None
    language_probability: float | None = None
    segments: list[dict[str, Any]] = field(default_factory=list)
    word_timestamps: list[dict[str, Any]] = field(default_factory=list)
    model_output: Any = None  # Raw model output for debugging


@dataclass
class TimingMetrics:
    """Pipeline timing breakdown for observability.

    Captures per-step latency and Time To First Word (TTFW) so that
    callers can evaluate pipeline performance and identify bottlenecks.
    """

    # Time To First Word — elapsed seconds from pipeline start to the
    # moment the first transcribed word is available.
    ttfw_seconds: float = 0.0

    # Per-pipeline-step breakdown (seconds)
    model_loading_seconds: float = 0.0
    preprocessing_seconds: float = 0.0
    embedding_seconds: float = 0.0
    inference_seconds: float = 0.0
    diarization_seconds: float = 0.0
    postprocessing_seconds: float = 0.0

    # Total end-to-end (should equal processing_time_seconds)
    total_seconds: float = 0.0

    # Per-segment latency when VAD + per-segment ASR is used.
    # Each entry: {"segment_index", "start_time", "end_time",
    #              "duration_s", "inference_time_s"}
    segment_latencies: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a JSON-friendly dictionary.

        All numeric fields are coerced to ``float`` so that
        ``round(int_value, 4)`` does not return ``int`` (Python quirk).
        """
        return {
            "ttfw_seconds": round(float(self.ttfw_seconds), 4),
            "model_loading_seconds": round(float(self.model_loading_seconds), 4),
            "preprocessing_seconds": round(float(self.preprocessing_seconds), 4),
            "embedding_seconds": round(float(self.embedding_seconds), 4),
            "inference_seconds": round(float(self.inference_seconds), 4),
            "diarization_seconds": round(float(self.diarization_seconds), 4),
            "postprocessing_seconds": round(float(self.postprocessing_seconds), 4),
            "total_seconds": round(float(self.total_seconds), 4),
            "segment_latencies": self.segment_latencies,
        }


@dataclass
class TranscriptionResult:
    """Final transcription result."""

    text: str
    language: str | None = None
    language_probability: float | None = None
    duration_seconds: float = 0.0
    processing_time_seconds: float = 0.0
    word_timestamps: list[WordTimestamp] = field(default_factory=list)
    sentence_timestamps: list[SentenceTimestamp] = field(default_factory=list)
    segments: list[AudioSegment] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    # Storage URIs (populated after audio/transcript upload)
    raw_audio_uri: str | None = None
    processed_audio_uri: str | None = None
    transcript_uri: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        # Serialize timing metrics if present
        metadata_serializable: dict[str, Any] = {}
        for k, v in self.metadata.items():
            if isinstance(v, TimingMetrics):
                metadata_serializable[k] = v.to_dict()
            else:
                metadata_serializable[k] = v

        result: dict[str, Any] = {
            "text": self.text,
            "language": self.language,
            "language_probability": self.language_probability,
            "duration_seconds": self.duration_seconds,
            "processing_time_seconds": self.processing_time_seconds,
            "word_timestamps": [
                {
                    "word": w.word,
                    "start_time": w.start_time,
                    "end_time": w.end_time,
                    "confidence": w.confidence,
                }
                for w in self.word_timestamps
            ],
            "sentence_timestamps": [
                {
                    "text": s.text,
                    "start_time": s.start_time,
                    "end_time": s.end_time,
                    "english_text": s.english_text,
                }
                for s in self.sentence_timestamps
            ],
            "segments": [
                {
                    "start_time": seg.start_time,
                    "end_time": seg.end_time,
                    "duration": seg.duration,
                    "is_speech": seg.is_speech,
                    "confidence": seg.confidence,
                    "speaker_id": seg.speaker_id,
                    "speaker_confidence": seg.speaker_confidence,
                }
                for seg in self.segments
            ],
            "metadata": metadata_serializable,
        }
        # Include storage URIs when present
        if self.raw_audio_uri:
            result["raw_audio_uri"] = self.raw_audio_uri
        if self.processed_audio_uri:
            result["processed_audio_uri"] = self.processed_audio_uri
        if self.transcript_uri:
            result["transcript_uri"] = self.transcript_uri
        return result


@dataclass
class ChunkTranscriptionResult:
    """Result of transcribing a single sliding-window chunk.

    Emitted via the optional ``chunk_callback`` in inference methods so
    that callers can display near-real-time partial results as each chunk
    completes, rather than waiting for the entire file to finish.
    """

    chunk_index: int
    text: str
    start_time: float  # seconds (global audio timeline)
    end_time: float  # seconds (global audio timeline)
    is_final: bool = False  # True if this is the last chunk
    word_timestamps: list[dict[str, Any]] = field(default_factory=list)
    # Optional: which VAD segment this chunk belongs to (-1 = full-audio)
    vad_segment_index: int = -1
    speaker_id: str | None = None
    speaker_confidence: float | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize to JSON-friendly dictionary."""
        d: dict[str, Any] = {
            "chunk_index": self.chunk_index,
            "text": self.text,
            "start_time": round(self.start_time, 4),
            "end_time": round(self.end_time, 4),
            "is_final": self.is_final,
            "word_timestamps": self.word_timestamps,
            "vad_segment_index": self.vad_segment_index,
        }
        if self.speaker_id is not None:
            d["speaker_id"] = self.speaker_id
        if self.speaker_confidence is not None:
            d["speaker_confidence"] = self.speaker_confidence
        return d


@dataclass
class StreamingChunkResult:
    """Result of processing a streaming chunk."""

    text: str  # Partial or final text
    is_final: bool = False  # True if this is a final segment
    segment_id: int = 0
    start_time: float = 0.0
    end_time: float = 0.0
    confidence: float = 1.0


@dataclass
class StreamingSession:
    """State for a streaming transcription session."""

    session_id: str
    pipeline_id: str
    tenant_id: str
    consultation_id: str | None = None
    created_at: datetime = field(default_factory=datetime.utcnow)
    last_activity: datetime = field(default_factory=datetime.utcnow)
    audio_buffer: bytes = b""
    total_duration_seconds: float = 0.0
    chunk_count: int = 0
    segments: list[StreamingChunkResult] = field(default_factory=list)
    final_text: str = ""
    is_active: bool = True

    def add_chunk(self, chunk: bytes, duration_seconds: float) -> None:
        """Add audio chunk to buffer."""
        self.audio_buffer += chunk
        self.total_duration_seconds += duration_seconds
        self.chunk_count += 1
        self.last_activity = datetime.utcnow()

    def add_result(self, result: StreamingChunkResult) -> None:
        """Add transcription result."""
        self.segments.append(result)
        if result.is_final:
            self.final_text += " " + result.text if self.final_text else result.text
        self.last_activity = datetime.utcnow()

    def finalize(self) -> TranscriptionResult:
        """Finalize session and return complete result."""
        self.is_active = False

        # Combine all segments
        all_text = self.final_text.strip()

        return TranscriptionResult(
            text=all_text,
            duration_seconds=self.total_duration_seconds,
            metadata={
                "session_id": self.session_id,
                "chunk_count": self.chunk_count,
                "segment_count": len(self.segments),
            },
        )


@dataclass
class TranscriptionJobContext:
    """Context for a transcription job."""

    job_id: str
    tenant_id: str
    pipeline_id: str
    consultation_id: str | None = None
    media_id: str | None = None
    audio_uri: str | None = None
    worker_id: str | None = None
    started_at: datetime | None = None
    max_retries: int = 3
    retry_count: int = 0
