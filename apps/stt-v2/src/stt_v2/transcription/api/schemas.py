"""Pydantic request/response schemas for the transcription API."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class WordTimestampResponse(BaseModel):
    """A single word with timing information."""

    word: str
    start_time: float
    end_time: float
    confidence: float = 1.0


class SentenceTimestampResponse(BaseModel):
    """A single sentence with timing information."""

    text: str
    start_time: float
    end_time: float
    english_text: str | None = None


class SegmentResponse(BaseModel):
    """Audio segment (from VAD) with timing and speech flag."""

    start_time: float
    end_time: float
    duration: float
    is_speech: bool
    confidence: float


class TimingMetricsResponse(BaseModel):
    """Pipeline timing breakdown."""

    ttfw_seconds: float = 0.0
    model_loading_seconds: float = 0.0
    preprocessing_seconds: float = 0.0
    inference_seconds: float = 0.0
    diarization_seconds: float = 0.0
    postprocessing_seconds: float = 0.0
    total_seconds: float = 0.0


class TranscriptionResponse(BaseModel):
    """Full transcription result returned by ``POST /api/v1/transcribe``."""

    text: str
    language: str | None = None
    language_probability: float | None = None
    duration_seconds: float = 0.0
    processing_time_seconds: float = 0.0

    word_timestamps: list[WordTimestampResponse] = Field(default_factory=list)
    sentence_timestamps: list[SentenceTimestampResponse] = Field(default_factory=list)
    segments: list[SegmentResponse] = Field(default_factory=list)

    timing: TimingMetricsResponse | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    # Storage URIs (populated when audio is persisted)
    raw_audio_uri: str | None = None
    processed_audio_uri: str | None = None
    transcript_uri: str | None = None


class ErrorResponse(BaseModel):
    """Standard error payload."""

    error_code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class PipelineValidateRequest(BaseModel):
    """TASK-505 P2 — validate a pipeline YAML against the Python parser."""

    config_yaml: str = Field(..., description="Pipeline configuration YAML")


class PipelineValidationErrorItem(BaseModel):
    field: str
    message: str


class PipelineValidateResponse(BaseModel):
    """Authoritative validation verdict (single source of truth: the same
    PipelineYamlParser the runtime uses — the gateway proxies here instead of
    hand-duplicating rules in TypeScript)."""

    valid: bool
    errors: list[PipelineValidationErrorItem] = Field(default_factory=list)
