"""VAD DTOs and data structures."""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any


@dataclass
class SpeechSegment:
    """A detected speech segment with timing and probability."""

    start_time: float  # seconds
    end_time: float  # seconds
    probability: float = 1.0

    @property
    def duration(self) -> float:
        """Duration in seconds."""
        return self.end_time - self.start_time


@dataclass
class VADResult:
    """Result of VAD processing on an audio buffer."""

    segments: list[SpeechSegment] = field(default_factory=list)
    # Total speech duration in seconds
    speech_duration: float = 0.0
    # Total audio duration in seconds
    audio_duration: float = 0.0
    # Whether VAD was actually applied (False if model unavailable)
    applied: bool = False

    @property
    def speech_ratio(self) -> float:
        """Ratio of speech to total audio duration."""
        if self.audio_duration == 0:
            return 0.0
        return self.speech_duration / self.audio_duration

    @property
    def has_speech(self) -> bool:
        """Whether any speech was detected."""
        return len(self.segments) > 0


@dataclass
class VADSessionState:
    """Per-session ONNX state for streaming VAD.

    Silero VAD v5 maintains LSTM hidden state (shape: [2, 1, 128])
    that must persist across chunks within a single streaming session.
    """

    session_id: str
    # ONNX LSTM state — shape (2, 1, 128), float32
    h_state: Any = None  # numpy array
    # Tracking
    sample_rate: int = 16000
    samples_processed: int = 0
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    last_activity: datetime = field(default_factory=lambda: datetime.now(UTC))
    # Speech detection state (for streaming segment assembly)
    is_speech_active: bool = False
    speech_start_sample: int = 0
    pending_segments: list[SpeechSegment] = field(default_factory=list)

    def reset(self) -> None:
        """Reset LSTM state and detection state for reuse."""
        import numpy as np

        self.h_state = np.zeros((2, 1, 128), dtype=np.float32)
        self.samples_processed = 0
        self.is_speech_active = False
        self.speech_start_sample = 0
        self.pending_segments = []
        self.last_activity = datetime.now(UTC)
