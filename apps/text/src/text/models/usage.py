"""Usage passthrough — what the gateway needs to write a ledger row.

SMR is the only process that knows three things the billing plane cannot
reconstruct afterwards: WHICH provider actually served the call, WHICH API shape
it spoke, and the provider's OWN usage object (the one with the cache and
reasoning breakdown in it). ``UsageDetail`` carries exactly those, and nothing
else — no prompt, no completion, no patient-adjacent text. It is a billing
artifact and must stay PHI-free.

The gateway hands ``raw`` straight to its provider-usage normalizer, which
branches on ``endpoint_kind``. That is why the field is an ENDPOINT shape and not
a provider name: Gemini and Vertex serve the same models over the same wire
format and disagree about whether ``candidatesTokenCount`` already contains the
thinking tokens. A provider-name heuristic gets one of the two wrong every time.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field

# SMR provider key → the API shape that provider speaks.
#
# Keys are the registry keys registered in ``text.main`` (including the
# ``azure``/``openai_compat`` aliases), so a lookup never has to guess.
_ENDPOINT_KIND_BY_PROVIDER: dict[str, str] = {
    "openai": "openai.chat",
    "azure-openai": "openai.chat",
    "azure": "openai.chat",
    "azure_openai": "openai.chat",
    "vllm": "openai.chat",
    "openai_compat": "openai.chat",
    # LM Studio speaks the OpenAI wire plus a non-standard ``stats`` block; the
    # normalizer has a dedicated kind for it so that blob is ignored explicitly
    # rather than by accident.
    "lm-studio": "lmstudio.chat",
    "lmstudio": "lmstudio.chat",
    "anthropic": "anthropic.messages",
    "bedrock": "bedrock.converse",
    "aws_bedrock": "bedrock.converse",
    "vertex": "vertex.generate",
    "ollama": "ollama.native",
    "llama-cpp": "llamacpp.native",
    "llama_cpp": "llamacpp.native",
    "llamacpp": "llamacpp.native",
}

# Unknown providers fall back to the OpenAI chat wire — the portability layer
# every new self-hosted server in this platform implements, and the same default
# ``normalize_stop_reason`` already applies to an unrecognised engine.
_DEFAULT_ENDPOINT_KIND = "openai.chat"


def endpoint_kind_for(provider: str | None) -> str:
    """Map an SMR provider key onto the API shape it speaks."""
    return _ENDPOINT_KIND_BY_PROVIDER.get((provider or "").strip().lower(), _DEFAULT_ENDPOINT_KIND)


class UsageDetail(BaseModel):
    """One generation's billable usage, as the gateway needs to see it.

    Emitted twice for a streaming call — once on the terminal SSE frame of a
    completed stream, once on the terminal ``error`` frame of an interrupted one
    — and both carry the SAME ``task_id``. That is deliberate: the gateway keys
    its ledger idempotency on the task id, so an abort followed by a late
    completion converges on one billed event instead of two.
    """

    # The generation's identity. ``task_id`` is stable across the completion and
    # abort paths and is what the gateway's idempotency key is derived from;
    # ``request_id`` is the correlation id for log/trace joins.
    task_id: str
    request_id: str | None = None

    provider: str
    model: str
    endpoint_kind: str

    # True when this row was produced by the abort/teardown path rather than a
    # clean completion. The tokens were still spent — this only marks how the
    # stream ended.
    interrupted: bool = False
    # True when the call ran on a tenant-supplied (BYOK) credential. The gateway
    # turns this into `costBasis: BYOK_NOTIONAL`; it is reported here rather than
    # re-derived at the gateway because only SMR knows whether the injected
    # override was actually USED (a malformed override degrades to the platform
    # credential).
    byok: bool = False
    service_tier: str | None = None

    # When the work happened. The rater resolves the price row as of this
    # instant, so a late-delivered abort event is still priced at the rate that
    # was in force while the tokens were burning.
    occurred_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())

    # Headline counts (already normalized by the provider adapters).
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

    # The provider's OWN usage object, in its wire shape. This is where the
    # cache-read / cache-write / reasoning breakdown lives; the headline counts
    # above cannot express it.
    raw: dict[str, Any] | None = None


def _int_or_none(source: Any, name: str) -> int | None:
    """Read one integer count off an SDK object or dict; ``None`` when absent.

    Absent is NOT zero: "the provider reported no cache breakdown" and "the
    provider reported zero cached tokens" are different facts, and only the
    second one should ever appear in a usage object.
    """
    value = source.get(name) if isinstance(source, dict) else getattr(source, name, None)
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _put(target: dict[str, Any], key: str, value: Any) -> None:
    if value is not None:
        target[key] = value


def openai_usage_dict(usage: Any) -> dict[str, Any]:
    """The OpenAI-wire usage object, breakdown INTACT.

    The three headline fields alone cannot express a prompt-cache hit or a
    reasoning-token split, and both are priced differently from plain input /
    output. Detail sub-objects are copied only when the provider sent them.
    """
    out: dict[str, Any] = {
        "prompt_tokens": _int_or_none(usage, "prompt_tokens") or 0,
        "completion_tokens": _int_or_none(usage, "completion_tokens") or 0,
        "total_tokens": _int_or_none(usage, "total_tokens") or 0,
    }
    if usage is None:
        return out

    prompt_details = (
        usage.get("prompt_tokens_details")
        if isinstance(usage, dict)
        else getattr(usage, "prompt_tokens_details", None)
    )
    if prompt_details is not None:
        block: dict[str, Any] = {}
        _put(block, "cached_tokens", _int_or_none(prompt_details, "cached_tokens"))
        _put(block, "cache_write_tokens", _int_or_none(prompt_details, "cache_write_tokens"))
        if block:
            out["prompt_tokens_details"] = block

    completion_details = (
        usage.get("completion_tokens_details")
        if isinstance(usage, dict)
        else getattr(usage, "completion_tokens_details", None)
    )
    if completion_details is not None:
        block = {}
        _put(block, "reasoning_tokens", _int_or_none(completion_details, "reasoning_tokens"))
        if block:
            out["completion_tokens_details"] = block

    # OpenAI and Azure echo the tier the request was actually served at (asking
    # for `fast` reads back `priority`); a batch tier is ~50% off at every lab,
    # so the rater needs the tier that was USED, not the one requested.
    tier = (
        usage.get("service_tier")
        if isinstance(usage, dict)
        else getattr(usage, "service_tier", None)
    )
    if isinstance(tier, str) and tier:
        out["service_tier"] = tier

    return out


def vertex_usage_dict(usage: Any) -> dict[str, Any]:
    """Google's usage metadata in its JSON WIRE spelling.

    The Python SDK exposes ``prompt_token_count``; the wire (and every
    normalizer written against Google's docs) says ``promptTokenCount``. This is
    the translation, done once, at the only place that knows it is an SDK object.
    """
    out: dict[str, Any] = {}
    _put(out, "promptTokenCount", _int_or_none(usage, "prompt_token_count"))
    _put(out, "candidatesTokenCount", _int_or_none(usage, "candidates_token_count"))
    _put(out, "totalTokenCount", _int_or_none(usage, "total_token_count"))
    # Vertex reports thinking tokens OUTSIDE `candidatesTokenCount` (the Gemini
    # API reports them inside) — the normalizer branches on that, so the field
    # must survive the trip.
    _put(out, "thoughtsTokenCount", _int_or_none(usage, "thoughts_token_count"))
    _put(out, "cachedContentTokenCount", _int_or_none(usage, "cached_content_token_count"))
    return out


def anthropic_usage_dict(usage: Any) -> dict[str, Any]:
    """Anthropic's usage object, cache fields and TTL split preserved.

    ``input_tokens`` here EXCLUDES the cache counts, so the cache fields are not
    an optional detail — without them the input total is simply wrong (by up to
    the whole cached prefix). The TTL split matters too: a 5-minute cache write
    costs x1.25 of base input, a 1-hour write x2.00, and the flat
    ``cache_creation_input_tokens`` cannot tell them apart.
    """
    out: dict[str, Any] = {
        "input_tokens": _int_or_none(usage, "input_tokens") or 0,
        "output_tokens": _int_or_none(usage, "output_tokens") or 0,
    }
    if usage is None:
        return out

    _put(out, "cache_read_input_tokens", _int_or_none(usage, "cache_read_input_tokens"))
    _put(out, "cache_creation_input_tokens", _int_or_none(usage, "cache_creation_input_tokens"))

    creation = (
        usage.get("cache_creation")
        if isinstance(usage, dict)
        else getattr(usage, "cache_creation", None)
    )
    if creation is not None:
        block: dict[str, Any] = {}
        _put(
            block, "ephemeral_5m_input_tokens", _int_or_none(creation, "ephemeral_5m_input_tokens")
        )
        _put(
            block, "ephemeral_1h_input_tokens", _int_or_none(creation, "ephemeral_1h_input_tokens")
        )
        if block:
            out["cache_creation"] = block

    tier = (
        usage.get("service_tier")
        if isinstance(usage, dict)
        else getattr(usage, "service_tier", None)
    )
    if isinstance(tier, str) and tier:
        out["service_tier"] = tier

    return out


def raw_usage_from_stats(stats: Any) -> dict[str, Any] | None:
    """Pull the provider-wire usage blob out of a ``GenerationStats``-shaped value.

    Adapters stash it under ``engine_native.usage``. Accepts either the model or
    its ``model_dump()`` because the streaming path only ever sees the dump.
    Returns ``None`` rather than raising on any unexpected shape — a missing
    breakdown degrades the row to headline counts, which is recoverable; an
    exception in a teardown handler is not.
    """
    if stats is None:
        return None
    native = (
        stats.get("engine_native")
        if isinstance(stats, dict)
        else getattr(stats, "engine_native", None)
    )
    if not isinstance(native, dict):
        return None
    usage = native.get("usage")
    return usage if isinstance(usage, dict) else None


def build_usage_detail(
    *,
    task_id: str,
    request_id: str | None,
    provider: str,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    total_tokens: int | None = None,
    raw: dict[str, Any] | None = None,
    interrupted: bool = False,
    byok: bool = False,
    service_tier: str | None = None,
    occurred_at: datetime | None = None,
) -> UsageDetail:
    """Assemble a ``UsageDetail``. Null-safe on every count."""
    prompt = int(prompt_tokens or 0)
    completion = int(completion_tokens or 0)
    return UsageDetail(
        task_id=task_id,
        request_id=request_id,
        provider=provider,
        model=model,
        endpoint_kind=endpoint_kind_for(provider),
        interrupted=interrupted,
        byok=byok,
        service_tier=service_tier,
        occurred_at=(occurred_at or datetime.now(UTC)).isoformat(),
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=int(total_tokens) if total_tokens is not None else prompt + completion,
        raw=raw,
    )


def guardrail_usage_from_verdict(verdict: dict[str, Any] | None) -> UsageDetail | None:
    """Lift guardrail's own per-call stats out of a validate() verdict.

    Guardrail is a peer service with no gateway in front of it, so the ONLY way
    its LLM spend reaches the billing plane is by riding back on the SMR response
    that triggered it. A verdict without stats (validation disabled, a fail-closed
    outage verdict, an older guardrail build) yields ``None`` — silence, not zeros,
    because a zero row is indistinguishable from a free call.
    """
    if not isinstance(verdict, dict):
        return None
    raw = verdict.get("raw")
    stats = raw.get("stats") if isinstance(raw, dict) else None
    if not isinstance(stats, dict):
        return None

    provider = str(stats.get("provider") or "")
    if not provider:
        return None

    return build_usage_detail(
        task_id=str(stats.get("request_id") or ""),
        request_id=str(stats.get("request_id")) if stats.get("request_id") else None,
        provider=provider,
        model=str(stats.get("model") or ""),
        prompt_tokens=int(stats.get("prompt_tokens") or 0),
        completion_tokens=int(stats.get("predicted_tokens") or stats.get("completion_tokens") or 0),
        total_tokens=int(stats["total_tokens"]) if stats.get("total_tokens") is not None else None,
        raw=raw_usage_from_stats(stats),
    )
