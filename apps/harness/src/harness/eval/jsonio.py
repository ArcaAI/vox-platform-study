"""Tolerant JSON extraction from LLM responses.

Models often wrap JSON in prose, code fences, or reasoning blocks. These helpers
pull the first balanced JSON object/array out of arbitrary text.
"""

from __future__ import annotations

import json
import re

_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def strip_reasoning(text: str) -> str:
    """Remove ``<think>…</think>`` blocks (and a dangling open tag)."""
    text = _THINK_BLOCK.sub("", text)
    if "<think>" in text.lower():
        brace = text.find("{")
        if brace != -1:
            text = text[brace:]
    return text.strip()


def _extract_balanced(text: str, open_ch: str, close_ch: str) -> str | None:
    start = text.find(open_ch)
    if start == -1:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def loads_json(text: str) -> object:
    """Extract and parse the first JSON object or array from ``text``."""
    cleaned = strip_reasoning(text)
    obj = _extract_balanced(cleaned, "{", "}")
    arr = _extract_balanced(cleaned, "[", "]")
    # Prefer whichever appears first.
    candidate = None
    if obj is not None and arr is not None:
        candidate = obj if cleaned.find("{") < cleaned.find("[") else arr
    else:
        candidate = obj or arr
    if candidate is None:
        raise ValueError("no JSON object/array found in response")
    return json.loads(candidate)
