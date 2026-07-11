"""Text segmentation for incremental synthesis.

Sentence-chunking before synthesis is the biggest perceived-latency win: audio
can start after sentence 1. English uses pysbd; Malayalam and code-switched text
(pysbd has no ``ml`` model) use a punctuation-boundary fallback that splits only
on sentence-ending marks followed by whitespace — so decimals (``8.2``), ratios
(``140/90``), and Latin+Malayalam agglutination (``X-ray-യിൽ``) are never split.
"""

from __future__ import annotations

import re

try:  # pysbd is a base dependency, but stay resilient if absent.
    import pysbd
except ImportError:  # pragma: no cover
    pysbd = None  # type: ignore[assignment]

# Split after . ! ? ; or the Malayalam danda ।, only when followed by whitespace.
_BOUNDARY_RE = re.compile(r"(?<=[.!?;।])\s+")


def segment(text: str, locale: str) -> list[str]:
    """Split text into sentences for the given locale."""
    base = locale.split("-")[0]
    if base == "en" and pysbd is not None:
        seg = pysbd.Segmenter(language="en", clean=False)
        return [s.strip() for s in seg.segment(text) if s.strip()]
    return [p.strip() for p in _BOUNDARY_RE.split(text.strip()) if p.strip()]


def chunk_text(text: str, locale: str, max_chars: int) -> list[str]:
    """Segment into sentences, then hard-wrap any sentence longer than max_chars."""
    out: list[str] = []
    for sentence in segment(text, locale):
        if len(sentence) <= max_chars:
            out.append(sentence)
            continue
        current = ""
        for word in sentence.split():
            if current and len(current) + 1 + len(word) > max_chars:
                out.append(current)
                current = word
            else:
                current = f"{current} {word}".strip()
        if current:
            out.append(current)
    return out or [text.strip()]
