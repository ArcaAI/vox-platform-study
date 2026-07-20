"""AD-1 per-call generation stats — guardrail-local mirror.

Guardrail is a SEPARATE service and MUST NOT import from smr, so this module
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
# vLLM, Azure OpenAI and the generic OpenAI-compat gateway all speak this wire.
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


def _client_tokens_per_second(
    predicted_tokens: int, total_ms: int | None, ttft_ms: int | None
) -> float | None:
    """Client-computed throughput fallback: predicted / decode-time.

    Decode time excludes TTFT when known (prefill vs decode), otherwise uses the
    whole request wall-clock. Returns ``None`` when there is nothing to divide —
    never invents a number.
    """
    if not predicted_tokens or not total_ms or total_ms <= 0:
        return None
    decode_ms = total_ms
    if ttft_ms is not None and total_ms > ttft_ms:
        decode_ms = total_ms - ttft_ms
    if decode_ms <= 0:
        return None
    return round(predicted_tokens / (decode_ms / 1000.0), 3)


def stats_from_openai_response(
    *,
    provider: str,
    model: str,
    data: dict[str, Any] | None,
    total_ms: int,
    ttft_ms: int | None = None,
) -> GuardrailCallStats:
    """Build stats from an OpenAI-wire chat-completion body.

    Reads ``usage`` (prompt/completion/total tokens) and
    ``choices[0].finish_reason``; captures an LM Studio native ``stats`` blob into
    ``engine_native`` when present. Non-streaming guardrail calls have no TTFT
    unless the caller measured one, so ``ttft_ms`` defaults to ``None``.
    """
    data = data or {}
    usage = data.get("usage") or {}

    finish_reason: str | None = None
    choices = data.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        finish_reason = choices[0].get("finish_reason")

    prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
    predicted_tokens = int(usage.get("completion_tokens", 0) or 0)
    total = usage.get("total_tokens")
    total_tokens = int(total) if total is not None else prompt_tokens + predicted_tokens
    total_ms_int = int(total_ms or 0)

    # LM Studio surfaces a native ``stats`` object; keep it verbatim for audit.
    native = data.get("stats")
    engine_native = dict(native) if isinstance(native, dict) and native else None

    return GuardrailCallStats(
        stop_reason=normalize_stop_reason(finish_reason),
        stop_reason_raw=finish_reason or "",
        total_ms=total_ms_int,
        ttft_ms=ttft_ms,
        tokens_per_second=_client_tokens_per_second(predicted_tokens, total_ms_int, ttft_ms),
        prompt_tokens=prompt_tokens,
        predicted_tokens=predicted_tokens,
        total_tokens=total_tokens,
        provider=provider,
        model=model,
        engine_native=engine_native,
    )
