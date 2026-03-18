"""Transcription workers module.

Dramatiq actors for batch transcription.
"""

from .transcribe_file import transcribe_file

__all__ = [
    "transcribe_file",
]
