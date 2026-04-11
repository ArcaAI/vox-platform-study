"""Diarization DTOs and data structures."""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class SpeakerEmbedding:
    """A speaker embedding extracted from an audio segment."""

    embedding: list[float]  # 512-dimensional vector
    segment_start: float = 0.0  # seconds
    segment_end: float = 0.0  # seconds

    @property
    def dimension(self) -> int:
        return len(self.embedding)


@dataclass
class SpeakerIdentification:
    """Result of identifying a speaker from an embedding."""

    speaker_id: str
    confidence: float | None = None  # Cosine similarity (0-1)
    is_new_speaker: bool = False

    @property
    def is_known(self) -> bool:
        """Whether this is a previously-seen speaker."""
        return not self.is_new_speaker


@dataclass
class DiarizedSegment:
    """A transcription segment annotated with speaker identity."""

    text: str
    start_time: float  # seconds
    end_time: float  # seconds
    speaker_id: str | None = None
    speaker_confidence: float | None = None
    word_timestamps: list[dict[str, Any]] = field(default_factory=list)

    @property
    def duration(self) -> float:
        return self.end_time - self.start_time


@dataclass
class DiarizationResult:
    """Full diarization result for a transcription job."""

    segments: list[DiarizedSegment] = field(default_factory=list)
    speakers_detected: int = 0
    new_speakers_created: int = 0
    applied: bool = False

    def get_speaker_ids(self) -> list[str]:
        """Get unique speaker IDs from segments."""
        return list({s.speaker_id for s in self.segments if s.speaker_id})
