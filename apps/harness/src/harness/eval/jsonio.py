"""Tolerant JSON extraction from LLM responses.

Models — reasoning and non-reasoning alike — wrap their JSON answer in prose,
markdown code fences, ``<think>`` blocks, OpenAI *harmony* channels, or Gemma
``<unused94>thought`` leaks. These helpers strip that scaffolding and pull the
model's FINAL balanced JSON object/array out of the noise.

Centralised here (and reused by the PDSQI-9 judge) so the stripping/extraction
rules cannot diverge between call sites.
"""

from __future__ import annotations

import json
import re

# Closed ``<think>…</think>`` reasoning blocks (Qwen-style and the generic case).
_THINK_BLOCK = re.compile(r"<think\b[^>]*>.*?</think\s*>", re.DOTALL | re.IGNORECASE)

# OpenAI *harmony* (gpt-oss) channels. When the server does NOT parse harmony the
# raw text looks like::
#
#     <|channel|>analysis<|message|>…cot, maybe with { braces }…<|end|>
#     <|start|>assistant<|channel|>final<|message|>{ …json… }
#
# The analysis channel can contain ``{`` that is NOT the answer, so we keep ONLY
# the body after the LAST ``final`` channel header and drop analysis/commentary.
_HARMONY_FINAL_HEADER = re.compile(
    r"<\|channel\|>\s*final\b[^<]*?<\|message\|>", re.DOTALL | re.IGNORECASE
)
_HARMONY_NONFINAL_BLOCK = re.compile(
    r"<\|channel\|>\s*(?:analysis|commentary)\b.*?"
    r"(?=<\|channel\|>|<\|start\|>|<\|end\|>|<\|return\|>|\Z)",
    re.DOTALL | re.IGNORECASE,
)
# Stray harmony control tokens to remove once channels are resolved.
_HARMONY_CONTROL = re.compile(
    r"<\|(?:start|end|message|channel|constrain|call|return)\|>", re.IGNORECASE
)

# Gemma-style "thought" leaks (reasoning bled into ``content`` with an EMPTY
# ``reasoning_content``). There is no reliable closing tag, so we strip from the
# opener to the model's first ``{`` (the start of the JSON answer).
_THOUGHT_MARKER = re.compile(
    r"<unused94>(?:thought)?|<unused95>|<\|channel\|>\s*thought\b|<\|think\|>",
    re.IGNORECASE,
)


def _strip_thought_leak(text: str) -> str:
    """Drop a leaked Gemma ``thought`` region (opener → first ``{``)."""
    # Bounded loop: each pass removes at least the marker, so it terminates.
    for _ in range(8):
        match = _THOUGHT_MARKER.search(text)
        if match is None:
            return text
        brace = text.find("{", match.start())
        text = text[: match.start()] + (text[brace:] if brace != -1 else "")
    return text


def strip_reasoning(text: str) -> str:
    """Strip reasoning scaffolding, returning text centred on the JSON answer.

    Handles, in order: closed ``<think>…</think>`` blocks; OpenAI *harmony*
    channels (keep only the final-channel body; drop analysis/commentary CoT);
    Gemma ``<unused94>thought`` / ``<|think|>`` leaks; leftover harmony control
    tokens; a dangling/unclosed ``<think>`` (truncated reasoning).
    """
    text = _THINK_BLOCK.sub("", text)

    # Harmony: keep only the LAST final-channel body, else drop analysis/commentary.
    final_headers = list(_HARMONY_FINAL_HEADER.finditer(text))
    if final_headers:
        text = text[final_headers[-1].end() :]
    else:
        text = _HARMONY_NONFINAL_BLOCK.sub("", text)

    # Run BEFORE stripping control tokens so the ``<|channel|>thought`` /
    # ``<|think|>`` markers are still present for detection.
    text = _strip_thought_leak(text)
    text = _HARMONY_CONTROL.sub("", text)

    # A dangling, unclosed <think> (truncated reasoning) — drop up to the JSON.
    if "<think" in text.lower():
        brace = text.find("{")
        if brace != -1:
            text = text[brace:]
    return text.strip()


def _balanced_spans(text: str, open_ch: str, close_ch: str) -> list[str]:
    """Every TOP-LEVEL balanced ``open_ch…close_ch`` substring (braces in strings
    ignored). An unbalanced opener is skipped, so a stray ``{`` in leaked
    chain-of-thought never swallows the real answer that follows it.
    """
    spans: list[str] = []
    i, n = 0, len(text)
    while i < n:
        if text[i] != open_ch:
            i += 1
            continue
        depth = 0
        in_string = False
        escape = False
        matched_end = -1
        for j in range(i, n):
            ch = text[j]
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
                    matched_end = j
                    break
        if matched_end != -1:
            spans.append(text[i : matched_end + 1])
            i = matched_end + 1
        else:
            i += 1
    return spans


def extract_last_object(text: str) -> str | None:
    """Return the LAST balanced top-level ``{…}`` (the final answer), or ``None``.

    Reasoning precedes the answer for every model family we serve, so the LAST
    top-level object is the score JSON; falling back to the only object when a
    single one is present is the same value.
    """
    objects = _balanced_spans(text, "{", "}")
    return objects[-1] if objects else None


def loads_json(text: str) -> object:
    """Extract and parse the model's final JSON object (or first array) from ``text``."""
    cleaned = strip_reasoning(text)
    obj = extract_last_object(cleaned)
    arrays = _balanced_spans(cleaned, "[", "]")
    arr = arrays[0] if arrays else None
    if obj is not None and arr is not None:
        # Prefer whichever starts earlier; an object that *contains* the array
        # (e.g. ``{"claims": [...]}``) starts first and wins.
        candidate = obj if cleaned.find(obj) <= cleaned.find(arr) else arr
    else:
        candidate = obj or arr
    if candidate is None:
        raise ValueError("no JSON object/array found in response")
    return json.loads(candidate)
