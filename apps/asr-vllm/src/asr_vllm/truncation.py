"""The vllm-project/vllm#53144 hook: flag output that looks truncated for its audio.

#53144 reports vLLM's Whisper DROPPING audio silently when the decoder emits end-of-text
early inside a chunk — the response is well-formed, just short. Nothing in the response
says so, so this service estimates it and says so itself:

* ``token_budget_exhausted`` — ``finish_reason == "length"``: the decoder ran out of
  context. Certain, not a heuristic.
* ``short_output_for_voiced_audio`` — fewer non-space characters than
  ``voiced_seconds × min_chars_per_voiced_second`` (floored). A HEURISTIC: conversational
  English runs ~12–15 chars/s and Malayalam script is of the same order, so the spike
  default (3 chars per VOICED second) only fires on grossly short output. It must be
  calibrated on the TASK-994 ml-en fixtures during the GPU run before anything acts on it.

The flag is information for the caller and the bench — this service never retries or
alters a transcript because of it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class TruncationAssessment:
    suspected: bool
    reason: str | None
    voiced_seconds: float
    chars: int


def assess_truncation(
    text: str,
    *,
    finish_reason: str | None,
    voiced_seconds: float,
    min_chars_per_voiced_second: float,
) -> TruncationAssessment:
    chars = sum(1 for ch in text if not ch.isspace())
    if finish_reason == "length":
        return TruncationAssessment(True, "token_budget_exhausted", voiced_seconds, chars)
    expected = math.floor(voiced_seconds * min_chars_per_voiced_second)
    if expected >= 1 and chars < expected:
        return TruncationAssessment(True, "short_output_for_voiced_audio", voiced_seconds, chars)
    return TruncationAssessment(False, None, voiced_seconds, chars)
