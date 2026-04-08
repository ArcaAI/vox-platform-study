"""Regex-based disfluency removal for transcription postprocessing."""

from __future__ import annotations

import re

# Standalone filler words/phrases. Word-boundary delimited to avoid
# matching inside real words (e.g., "umbrella", "uh-huh").
_FILLER_WORDS = [
    r"\buh+\b",
    r"\bum+\b",
    r"\bah+\b",
    r"\beh+\b",
    r"\ber+\b",
    r"\bhmm+\b",
    r"\bhuh\b",
    r"\bmhm+\b",
    r"\bmm+\b",
    r"\boh\b",
    r",\s*you know\b",
    r",\s*i mean\b",
    r",\s*sort of\b",
    r",\s*kind of\b",
    r",\s*like\b",  # only "like" after comma (filler usage)
]

_FILLER_PATTERN = re.compile(
    r"(?:" + "|".join(_FILLER_WORDS) + r")(?:\s*,)?",
    re.IGNORECASE,
)

_MULTI_SPACE = re.compile(r"\s{2,}")
_ORPHAN_PUNCT = re.compile(r"(?:^[,;]\s*|\s*[,;]\s*$)")
_DOUBLE_PUNCT = re.compile(r"[,;]\s*[,;]")


def remove_disfluencies(text: str) -> str:
    """Remove standalone filler words/phrases from transcript text.

    Preserves fillers inside real words (e.g., "umbrella").
    Collapses resulting whitespace artifacts.
    """
    if not text:
        return text
    result = _FILLER_PATTERN.sub(" ", text)
    result = _MULTI_SPACE.sub(" ", result)
    result = _ORPHAN_PUNCT.sub("", result)
    result = _DOUBLE_PUNCT.sub(",", result)
    return result.strip()
