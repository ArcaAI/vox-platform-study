"""Transcription domain module.

This module handles audio transcription services and workers.
"""

from .batch_service import BatchTranscriptionService, get_batch_service
from .dto import (
    AudioSegment,
    ProcessedAudio,
    RawTranscription,
    SentenceTimestamp,
    StreamingChunkResult,
    StreamingSession,
    TranscriptionJobContext,
    TranscriptionResult,
    WordTimestamp,
)
from .preprocessing import AudioPreprocessor, get_preprocessor
from .workers import (
    transcribe_file,
)

__all__ = [
    # DTOs
    "WordTimestamp",
    "SentenceTimestamp",
    "AudioSegment",
    "ProcessedAudio",
    "RawTranscription",
    "TranscriptionResult",
    "StreamingChunkResult",
    "StreamingSession",
    "TranscriptionJobContext",
    # Services
    "BatchTranscriptionService",
    "get_batch_service",
    "AudioPreprocessor",
    "get_preprocessor",
    # Workers
    "transcribe_file",
]
