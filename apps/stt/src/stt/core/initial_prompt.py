"""Compose the Whisper ``initial_prompt`` from its parts.

TASK-1006 — the prompt TEXT arrives on the resolved spec
(``inference.initial_prompt_text``); the by-UUID ``PromptTemplate`` lookup that
used to live here was a Postgres read for the pre-agent pipeline path and went
with it.
"""

from __future__ import annotations


def compose_prompt(
    initial_prompt: str | None,
    previous_text: str | None,
) -> str | None:
    """Concatenate initial prompt text with previous transcription carry-forward."""
    parts: list[str] = []
    if initial_prompt and initial_prompt.strip():
        parts.append(initial_prompt.strip())
    if previous_text and previous_text.strip():
        parts.append(previous_text.strip())
    return " ".join(parts) if parts else None
