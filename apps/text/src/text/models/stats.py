"""One normalized generation-stats contract for every LLM call.

``GenerationStats`` is the single shape the Agentic SOTA program relies on
everywhere: SMR responses, trajectory ``LLM_CALL`` steps,
Prometheus aggregates, and OTel GenAI spans. It captures stop reason (normalized
+ raw), total time, time-to-first-token, tokens/second, token counts, provider
identity, and a raw engine-native timings/usage blob for audit.

The per-provider ``stats_from_*`` builders map each engine's native fields into
this shape. They are deliberately null-safe: a missing/broken stats payload
must NEVER fail a generation — counts fall back to zero, ``engine_native`` to
``None``, and tokens/second is computed from client timing only when the engine
omits its own throughput number (never invented from nothing).
"""

from __future__ import annotations

from typing import Any, Literal, get_args

from pydantic import BaseModel, Field

StopReason = Literal[
    "stop",
    "length",
    "content_filter",
    "tool_call",
    "abort",
    "error",
    "other",
]

STOP_REASONS: tuple[str, ...] = get_args(StopReason)

# --- Per-wire normalization tables (raw provider-native token → AD-1 stop_reason) ---

# OpenAI chat-completions wire (LM Studio, vLLM, Azure OpenAI, generic compat).
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

# Bedrock converse ``stopReason``.
_BEDROCK: dict[str, str] = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "content_filtered": "content_filter",
    "guardrail_intervened": "content_filter",
    "tool_use": "tool_call",
}

# llama.cpp server (native ``/completion``) — reference engine for AD-1 naming.
_LLAMA_CPP: dict[str, str] = {
    "stopped_eos": "stop",
    "stopped_word": "stop",
    "stop": "stop",
    "stopped_limit": "length",
    "limit": "length",
}

# Which wire table each SMR provider key resolves to. vLLM and LM Studio speak
# the OpenAI wire; llama.cpp has its own. Unknown providers default to the
# OpenAI-wire table (the portability layer).
_PROVIDER_TABLES: dict[str, dict[str, str]] = {
    "lm-studio": _OPENAI_WIRE,
    "lmstudio": _OPENAI_WIRE,
    "openai_compat": _OPENAI_WIRE,
    "openai": _OPENAI_WIRE,
    "vllm": _OPENAI_WIRE,
    "azure-openai": _OPENAI_WIRE,
    "azure_openai": _OPENAI_WIRE,
    "azure": _OPENAI_WIRE,
    "bedrock": _BEDROCK,
    "aws_bedrock": _BEDROCK,
    "llama-cpp": _LLAMA_CPP,
    "llama_cpp": _LLAMA_CPP,
    "llamacpp": _LLAMA_CPP,
}


def normalize_stop_reason(provider: str, raw: str | None) -> str:
    """Map a provider-native stop/finish reason onto the AD-1 ``StopReason`` set.

    Case-insensitive; unknown or empty raw values normalize to ``"other"`` so a
    novel engine token never crashes the mapper.
    """
    if not raw:
        return "other"
    table = _PROVIDER_TABLES.get((provider or "").lower(), _OPENAI_WIRE)
    return table.get(raw.strip().lower(), "other")


class GenerationStats(BaseModel):
    """AD-1 normalized per-call generation statistics."""

    stop_reason: StopReason = "other"
    stop_reason_raw: str = ""
    total_ms: int = 0
    ttft_ms: int | None = None
    tokens_per_second: float | None = None
    prompt_tokens: int = 0
    predicted_tokens: int = 0  # = completion / eval tokens (llama.cpp naming)
    total_tokens: int = 0
    provider: str = ""
    model: str = ""
    engine_native: dict[str, Any] | None = Field(default=None)


def _client_tokens_per_second(
    predicted_tokens: int, total_ms: int | None, ttft_ms: int | None
) -> float | None:
    """Client-computed throughput fallback: predicted / decode-time.

    Decode time excludes TTFT when it is known (prefill vs decode), otherwise
    uses the whole request wall-clock. Returns ``None`` when there is nothing to
    divide (no predicted tokens / no elapsed time) — never invents a number.
    """
    if not predicted_tokens or not total_ms or total_ms <= 0:
        return None
    decode_ms = total_ms
    if ttft_ms is not None and total_ms > ttft_ms:
        decode_ms = total_ms - ttft_ms
    if decode_ms <= 0:
        return None
    return round(predicted_tokens / (decode_ms / 1000.0), 3)


def build_generation_stats(
    *,
    provider: str,
    model: str,
    raw_stop_reason: str | None,
    prompt_tokens: int,
    predicted_tokens: int,
    total_tokens: int | None = None,
    total_ms: int,
    ttft_ms: int | None = None,
    tokens_per_second: float | None = None,
    engine_native: dict[str, Any] | None = None,
) -> GenerationStats:
    """Assemble a ``GenerationStats`` from already-extracted native fields.

    ``tokens_per_second`` is used verbatim when the engine reports it; otherwise
    it is computed from client timing.
    """
    prompt_tokens = int(prompt_tokens or 0)
    predicted_tokens = int(predicted_tokens or 0)
    total = int(total_tokens) if total_tokens is not None else prompt_tokens + predicted_tokens
    total_ms_int = int(total_ms or 0)

    tps = tokens_per_second
    if tps is None:
        tps = _client_tokens_per_second(predicted_tokens, total_ms_int, ttft_ms)

    return GenerationStats(
        stop_reason=normalize_stop_reason(provider, raw_stop_reason),  # type: ignore[arg-type]
        stop_reason_raw=raw_stop_reason or "",
        total_ms=total_ms_int,
        ttft_ms=ttft_ms,
        tokens_per_second=tps,
        prompt_tokens=prompt_tokens,
        predicted_tokens=predicted_tokens,
        total_tokens=total,
        provider=provider,
        model=model,
        engine_native=engine_native,
    )


def degraded_stats(
    *, provider: str, model: str, total_ms: int, stop_reason: StopReason = "error"
) -> GenerationStats:
    """Best-effort stats for the degraded path — a mapping failure must never
    fail a generation, only produce a null-safe, clearly-marked stats object."""
    return GenerationStats(
        stop_reason=stop_reason,
        stop_reason_raw=stop_reason,
        total_ms=int(total_ms or 0),
        provider=provider,
        model=model,
        engine_native=None,
    )


def stats_from_openai_usage(
    *,
    provider: str,
    model: str,
    usage: dict[str, Any] | None,
    finish_reason: str | None,
    total_ms: int,
    ttft_ms: int | None = None,
    engine_native: dict[str, Any] | None = None,
) -> GenerationStats:
    """Map OpenAI-wire ``usage`` + ``finish_reason`` (LM Studio / vLLM / Azure)."""
    usage = usage or {}
    total = usage.get("total_tokens")
    return build_generation_stats(
        provider=provider,
        model=model,
        raw_stop_reason=finish_reason,
        prompt_tokens=usage.get("prompt_tokens", 0) or 0,
        predicted_tokens=usage.get("completion_tokens", 0) or 0,
        total_tokens=total,
        total_ms=total_ms,
        ttft_ms=ttft_ms,
        engine_native=engine_native,
    )


def stats_from_llama_cpp(
    *,
    provider: str,
    model: str,
    data: dict[str, Any],
    total_ms: int,
    ttft_ms: int | None = None,
) -> GenerationStats:
    """Map a llama.cpp server ``/completion`` response object.

    llama.cpp is the AD-1 REFERENCE engine — its ``timings`` block is the
    source of truth for the owner-named metrics:

    - ``timings.prompt_n``      → ``prompt_tokens``
    - ``timings.predicted_n``   → ``predicted_tokens``
    - ``timings.predicted_per_second`` → ``tokens_per_second`` (engine-preferred,
      used verbatim; the client-computed fallback only applies when absent)
    - ``timings.prompt_ms``     → engine-native ``ttft_ms`` (prefill time) when a
      client-measured TTFT was not supplied
    - ``stopped_eos``/``stopped_word``/``stopped_limit`` → raw stop reason, then
      normalized (``stopped_limit → "length"``)

    Falls back to the flat ``tokens_evaluated``/``tokens_predicted`` fields when
    ``timings`` is absent, and never raises on a missing block.
    """
    data = data or {}
    timings = data.get("timings") or {}

    prompt_n = int(timings.get("prompt_n", data.get("tokens_evaluated", 0)) or 0)
    predicted_n = int(timings.get("predicted_n", data.get("tokens_predicted", 0)) or 0)

    pps = timings.get("predicted_per_second")
    tps = float(pps) if pps is not None else None

    if data.get("stopped_limit"):
        raw_stop = "stopped_limit"
    elif data.get("stopped_word"):
        raw_stop = "stopped_word"
    elif data.get("stopped_eos"):
        raw_stop = "stopped_eos"
    else:
        raw_stop = "stop"

    if ttft_ms is None and timings.get("prompt_ms") is not None:
        ttft_ms = int(round(timings["prompt_ms"]))

    engine_native: dict[str, Any] = {"timings": timings} if timings else {}
    for flag in ("stopped_eos", "stopped_word", "stopped_limit", "stopping_word"):
        if flag in data:
            engine_native[flag] = data[flag]

    return build_generation_stats(
        provider=provider,
        model=model,
        raw_stop_reason=raw_stop,
        prompt_tokens=prompt_n,
        predicted_tokens=predicted_n,
        total_tokens=prompt_n + predicted_n,
        total_ms=total_ms,
        ttft_ms=ttft_ms,
        tokens_per_second=tps,
        engine_native=engine_native or None,
    )


def stats_from_bedrock(
    *,
    provider: str,
    model: str,
    usage: dict[str, Any] | None,
    stop_reason: str | None,
    total_ms: int,
    ttft_ms: int | None = None,
    engine_native: dict[str, Any] | None = None,
) -> GenerationStats:
    """Map a Bedrock ``converse[_stream]`` ``usage`` + ``stopReason``."""
    usage = usage or {}
    input_tokens = int(usage.get("inputTokens", 0) or 0)
    output_tokens = int(usage.get("outputTokens", 0) or 0)
    total = usage.get("totalTokens")
    return build_generation_stats(
        provider=provider,
        model=model,
        raw_stop_reason=stop_reason,
        prompt_tokens=input_tokens,
        predicted_tokens=output_tokens,
        total_tokens=int(total) if total is not None else input_tokens + output_tokens,
        total_ms=total_ms,
        ttft_ms=ttft_ms,
        engine_native=engine_native,
    )
