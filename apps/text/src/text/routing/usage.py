"""Token-usage and stats coercion for a provider result.

Moved verbatim from `api/endpoints/generate.py` ( Wave 0.4). These are
pure functions over a provider's return value: nothing here performs I/O, reads
configuration or touches request state.
"""

from __future__ import annotations

from typing import Any

from text.models.requests import GenerateRequest
from text.models.stats import GenerationStats, build_generation_stats

__all__ = [
    "_coerce_stats",
    "_extract_stream_usage",
    "_extract_usage",
    "_credential_attribution",
]


def _extract_usage(result: Any) -> tuple[int, int, int]:
    """Return ``(prompt, completion, total)`` token counts from a provider result.

    The AD-1 provider contract returns a ``GenerationStats`` as the third tuple
    element (``predicted_tokens`` = completion). A legacy usage ``dict`` (still
    produced by some test doubles for the deprecated wire) is tolerated so a
    dedup/telemetry path never crashes on shape.
    """
    if isinstance(result, GenerationStats):
        return result.prompt_tokens, result.predicted_tokens, result.total_tokens
    data = result or {}
    prompt = int(data.get("prompt_tokens", 0) or 0)
    completion = int(data.get("completion_tokens", 0) or 0)
    total = data.get("total_tokens")
    return prompt, completion, int(total) if total is not None else prompt + completion


def _coerce_stats(result: Any, *, provider: str, model: str, latency_ms: int) -> GenerationStats:
    """Normalize a provider result into ``GenerationStats``.

    A provider that already returns ``GenerationStats`` (the AD-1 contract) is
    passed through with its REAL stop reason preserved; only empty identity /
    timing fields are backfilled from the endpoint. A legacy usage ``dict`` is
    mapped with the wire-compat ``"stop"`` reason (the pre-AD-1 behavior).
    """
    if isinstance(result, GenerationStats):
        updates: dict[str, Any] = {}
        if not result.model:
            updates["model"] = model
        if result.total_ms == 0:
            updates["total_ms"] = latency_ms
        return result.model_copy(update=updates) if updates else result
    prompt, completion, total = _extract_usage(result)
    return build_generation_stats(
        provider=provider,
        model=model,
        raw_stop_reason="stop",
        prompt_tokens=prompt,
        predicted_tokens=completion,
        total_tokens=total,
        total_ms=latency_ms,
        ttft_ms=None,
    )


def _credential_attribution(request_body: GenerateRequest) -> tuple[bool, str | None]:
    """``(byok, connection_id)`` for the credential that served this call.

    The presence of an override entry is no longer the answer:
    the gateway can inject a credential from the SYSTEM-tenant platform default
    as well as from the caller's own connection row, and those are identical on
    the wire. A platform-funded call is ordinary platform vendor spend and must
    reach the COGS rollups (OD-2 — it meters as ``CLOUD``/``INTERNAL``); stamped
    ``BYOK``/``BYOK_NOTIONAL`` it would contribute zero and never be invoiced.

    So the entry for the RESOLVED provider is read, and it says who paid.
    Absent entry ⇒ platform env credential ⇒ not BYOK. Absent ``funding``
    ⇒ ``"tenant"`` (a sender with no platform tier can only inject the
    caller's own key), which keeps an older gateway byte-for-byte unchanged.

    TASK-958 — the same entry also names WHICH of the tenant's connections for that
    provider was spent, and the two answers are returned TOGETHER rather than from two
    functions: they describe one credential, and a second lookup is how "who paid" and
    "with which key" start disagreeing about the same call. ``None`` means the sender
    stamped no connection id (a gateway that predates the field, or a platform env
    credential with no row behind it) — never a provider name standing in for one,
    because a provider name is exactly what two connections share.
    """
    overrides = request_body.provider_overrides or {}
    entry = overrides.get(request_body.provider)
    if entry is None:
        return False, None
    return entry.funding == "tenant", entry.connection_id


def _extract_stream_usage(data: dict[str, Any]) -> tuple[int, int, int | None]:
    """Read ``(prompt, completion, total)`` off one streamed ``usage`` chunk.

    Accepts both the AD-1 ``predicted_tokens`` naming and the wire-compat
    ``completion_tokens``.
    """
    prompt = int(data.get("prompt_tokens", 0) or 0)
    completion = int(data.get("completion_tokens", data.get("predicted_tokens", 0)) or 0)
    total = data.get("total_tokens")
    return prompt, completion, int(total) if total is not None else None
