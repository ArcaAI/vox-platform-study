"""The ``system_prompt`` size envelope is the request envelope, not a smaller class.

A governed live running-note call composes platform rules, the agent's tenant-authored
instruction fragments and the document template's section instructions into the SYSTEM
message (bulky per-flush data stays in the user message). For a 14-section department
template that is ~53.5 kB — far inside a 32k-token window, yet the old 50 000-char cap
on ``system_prompt`` (inherited verbatim from the first commit) refused it with a 422,
so every live flush degraded and the running note stayed empty.

The real limit is the model's context window, enforced by the engine and surfaced as
``CONTEXT_WINDOW_EXCEEDED`` — never by truncation. The character envelope only guards
request size, and the system half of one prompt gets the same envelope as the user half.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from text.models import requests as requests_module
from text.models.requests import GenerateRequest

# The measured size of the live Breast & Endocrine new-visit system message (bytes of the
# composed system prompt behind the recorded ciphertext), rounded up.
LIVE_RUNNING_NOTE_SYSTEM_CHARS = 54_000


def _max_length(field: str) -> int | None:
    metadata = GenerateRequest.model_fields[field].metadata
    return next(
        (m.max_length for m in metadata if getattr(m, "max_length", None) is not None), None
    )


def test_live_running_note_system_prompt_is_accepted() -> None:
    req = GenerateRequest(
        provider="lm-studio",
        prompt="transcript",
        system_prompt="s" * LIVE_RUNNING_NOTE_SYSTEM_CHARS,
    )
    assert len(req.system_prompt or "") == LIVE_RUNNING_NOTE_SYSTEM_CHARS


def test_system_prompt_shares_the_prompt_envelope() -> None:
    MAX_PROMPT_CHARS = requests_module.MAX_PROMPT_CHARS
    assert _max_length("system_prompt") == _max_length("prompt") == MAX_PROMPT_CHARS
    req = GenerateRequest(provider="lm-studio", prompt="p", system_prompt="s" * MAX_PROMPT_CHARS)
    assert len(req.system_prompt or "") == MAX_PROMPT_CHARS


def test_system_prompt_over_the_envelope_is_refused_not_truncated() -> None:
    MAX_PROMPT_CHARS = requests_module.MAX_PROMPT_CHARS
    with pytest.raises(ValidationError) as exc_info:
        GenerateRequest(
            provider="lm-studio", prompt="p", system_prompt="s" * (MAX_PROMPT_CHARS + 1)
        )
    assert any(
        e["type"] == "string_too_long" and e["loc"] == ("system_prompt",)
        for e in exc_info.value.errors()
    )
