"""AD-1 per-call generation stats — guardrail-local mirror.

Guardrail no longer speaks the OpenAI wire itself (TASK-735 Phase 2b delegates
judgement to ``apps/text``), so the former ``stats_from_openai_response`` builder
went with the engine adapters. The SHAPE stays: it is what
``services/external_text_client`` maps ``text``'s ``GenerationStats`` onto, and
what rides back to the billing plane on a verdict.

Guardrail is a SEPARATE service and MUST NOT import from text, so this module
mirrors the AD-1 ``GenerationStats`` field names locally. It captures the same
shape (stop reason normalized + raw, timings, token counts, provider identity,
engine-native audit blob) that the Agentic SOTA program standardizes across
every LLM/judge call.

Null-safety is the contract: a missing/broken ``usage`` payload must NEVER fail
a guardrail call — counts fall back to zero, ``tokens_per_second`` /
``engine_native`` to ``None``, and an unknown finish reason normalizes to
``"other"`` rather than raising.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

# Raw OpenAI-wire ``finish_reason`` → AD-1 ``stop_reason`` vocabulary. LM Studio,
# vLLM, Azure OpenAI and the generic OpenAI-compat gateway all speak this wire,
# which is every engine guardrail supports.
_OPENAI_WIRE: dict[str, str] = {
    "stop": "stop",
    "eos": "stop",
    "end_turn": "stop",
    "length": "length",
    "max_tokens": "length",
    "content_filter": "content_filter",
    "tool_calls": "tool_call",
    "function_call": "tool_call",
}


def normalize_stop_reason(raw: str | None) -> str:
    """Map an OpenAI-wire finish reason onto the AD-1 stop-reason set.

    Case-insensitive; empty or unknown values normalize to ``"other"`` so a novel
    engine token never crashes the mapper.
    """
    if not raw:
        return "other"
    return _OPENAI_WIRE.get(raw.strip().lower(), "other")


@dataclass
class GuardrailCallStats:
    """Guardrail-local mirror of AD-1 ``GenerationStats`` (field names identical)."""

    stop_reason: str = "other"
    stop_reason_raw: str = ""
    total_ms: int = 0
    ttft_ms: int | None = None
    tokens_per_second: float | None = None
    prompt_tokens: int = 0
    predicted_tokens: int = 0  # = completion tokens (llama.cpp naming)
    total_tokens: int = 0
    provider: str = ""
    model: str = ""
    engine_native: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
