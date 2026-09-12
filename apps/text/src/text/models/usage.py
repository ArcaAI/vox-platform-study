"""Usage passthrough — what the gateway needs to write a ledger row.

Text is the only process that knows three things the billing plane cannot
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
from typing import Any, Literal

from pydantic import BaseModel, Field, SerializerFunctionWrapHandler, model_serializer

CostBasis = Literal["INTERNAL", "BYOK_NOTIONAL"]
"""Whether the money on this row is REAL platform cost or an informational figure.

Mirrors the ledger's ``AiCostBasis`` enum (``packages/database`` —
``usage-ledger.prisma``). It is DERIVED from ``byok`` in ``build_usage_detail``
and is deliberately not a parameter anywhere: a call site that could stamp its
own cost basis is a call site that can convert tenant-funded spend into platform
COGS (or hide platform COGS as never-invoiced notional) with one wrong literal.
"""

# Text provider key → the API shape that provider speaks.
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
    "llama-cpp": "llamacpp.native",
    "llama_cpp": "llamacpp.native",
    "llamacpp": "llamacpp.native",
}

# Unknown providers fall back to the OpenAI chat wire — the portability layer
# every new self-hosted server in this platform implements, and the same default
# ``normalize_stop_reason`` already applies to an unrecognised engine.
_DEFAULT_ENDPOINT_KIND = "openai.chat"


def endpoint_kind_for(provider: str | None) -> str:
    """Map an Text provider key onto the API shape it speaks."""
    return _ENDPOINT_KIND_BY_PROVIDER.get((provider or "").strip().lower(), _DEFAULT_ENDPOINT_KIND)


#: The TASK-959 fields whose ABSENCE is meaningful ("nothing measured it") and
#: which are therefore omitted rather than serialized as `null`. `total_ms` is
#: not among them: a wall clock always exists.
_OMIT_WHEN_UNMEASURED = ("engine_ms", "request_bytes", "response_bytes")


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
    # re-derived at the gateway because only Text knows whether the injected
    # override was actually USED (a malformed override degrades to the platform
    # credential).
    byok: bool = False
    # TASK-958 — WHICH `AiProviderConnection` was spent. `provider` names the vendor,
    # and a tenant may hold several accounts of one vendor, so this is the only field
    # that separates their spend on a cost surface. Nullable: a platform env credential
    # has no row, and a gateway that predates the field stamps none.
    connection_id: str | None = None
    # DERIVED from ``byok`` (never passed in): a tenant-funded call is
    # ``BYOK_NOTIONAL`` — metered and rated for visibility, never invoiced,
    # excluded from platform-spend aggregates — and everything else is real
    # platform spend (``INTERNAL``). Stated explicitly on the wire so the
    # gateway meters the safety plane's own judgement calls (which ride back on
    # a guardrail verdict rather than on the tenant's own generation) without
    # re-deriving the rule a second time in TypeScript.
    cost_basis: CostBasis = "INTERNAL"
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

    # ── Compute and network (TASK-959 M-3 / M-4) ─────────────────────────────
    #
    # The gateway turns these into unit rows on the SAME ledger batch as the
    # tokens above: occupancy seconds for the engine that ran (or the platform's
    # own CPU when the call went to a vendor), and body bytes for the network
    # the call consumed. Text is the only process that can report them, for the
    # same reason it is the only one that can report `provider`: it is the one
    # that made the call.

    #: Wall clock for the call, client-measured — `GenerationStats.total_ms`.
    #: ALWAYS present, because there is always a clock: `0` means "not measured",
    #: which is a number a rater can see rather than a field it must guess at.
    total_ms: int = 0
    #: The engine's OWN reported time, when it reports one (llama.cpp's
    #: `prompt_ms + predicted_ms`, Ollama's `total_duration - load_duration`).
    #: `None` — not zero, and not `total_ms` — when the engine reports nothing:
    #: a client clock relabelled as engine time would over-count every cloud
    #: call by the round trip.
    engine_ms: int | None = None
    #: Body bytes put on the wire and read back, from the pooled transport.
    #: `None` when the adapter is off the pool (nothing observed it) rather than
    #: `0`, which would claim a call sent nothing.
    request_bytes: int | None = None
    response_bytes: int | None = None

    @model_serializer(mode="wrap")
    def _omit_unmeasured(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        """Drop the THREE new optional fields when they are `None`.

        Scoped to the fields TASK-959 adds, deliberately: a blanket
        `exclude_none` would also stop emitting `connection_id`, `service_tier`
        and `raw`, which existing consumers have always seen as explicit nulls.
        "An older gateway sees an unchanged shape" has to mean unchanged.
        """
        data: dict[str, Any] = handler(self)
        for name in _OMIT_WHEN_UNMEASURED:
            if data.get(name, 0) is None:
                data.pop(name, None)
        return data


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


def engine_ms_from_stats(stats: Any) -> int | None:
    """The ENGINE's own reported time, in milliseconds, or ``None``.

    Read off ``engine_native``, which is the only place a native timing
    survives the mapping into ``GenerationStats``. Two shapes report one:

    * ``timings.prompt_ms + timings.predicted_ms`` — llama.cpp, already in ms.
      Prefill plus decode IS the engine's time on the request; the wall clock
      around it additionally contains the queue and the HTTP round trip.
    * ``total_duration - load_duration`` — Ollama, in NANOSECONDS. Subtracting
      the load is what makes it comparable: a cold model's 4-second load is a
      platform cost shared by every request after it, not this tenant's compute.

    Matched by SHAPE rather than by provider name, so a self-hosted server
    registered under a new key still reports its native time and nothing has to
    be added to a table to make that happen. Accepts a ``GenerationStats`` or
    its ``model_dump()`` (the streaming ``usage`` chunk only ever carries the
    dump), and returns ``None`` on every unexpected shape: a missing engine time
    degrades the row to wall clock, which is recoverable.

    A derivation that comes out negative — a reported load longer than the
    reported total — is refused rather than clamped to zero: it says the engine's
    own numbers disagree, and inventing 0 ms of compute would hide that.
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

    timings = native.get("timings")
    if isinstance(timings, dict):
        prefill = _float_or_none(timings.get("prompt_ms"))
        decode = _float_or_none(timings.get("predicted_ms"))
        if prefill is not None or decode is not None:
            return _non_negative_ms((prefill or 0.0) + (decode or 0.0))

    total_ns = _float_or_none(native.get("total_duration"))
    if total_ns is not None:
        load_ns = _float_or_none(native.get("load_duration")) or 0.0
        return _non_negative_ms((total_ns - load_ns) / 1_000_000)

    return None


def _float_or_none(value: Any) -> float | None:
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _non_negative_ms(value: float) -> int | None:
    return int(round(value)) if value >= 0 else None


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
    connection_id: str | None = None,
    service_tier: str | None = None,
    occurred_at: datetime | None = None,
    total_ms: int = 0,
    engine_ms: int | None = None,
    request_bytes: int | None = None,
    response_bytes: int | None = None,
) -> UsageDetail:
    """Assemble a ``UsageDetail``. Null-safe on every count.

    ``cost_basis`` is derived here and ONLY here — there is no parameter for it,
    so no call site can stamp one.
    """
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
        # TASK-958 — WHICH key; `cost_basis` below still derives from `byok` alone,
        # because which key was spent never decides whose money it was.
        connection_id=connection_id,
        cost_basis="BYOK_NOTIONAL" if byok else "INTERNAL",
        service_tier=service_tier,
        occurred_at=(occurred_at or datetime.now(UTC)).isoformat(),
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=int(total_tokens) if total_tokens is not None else prompt + completion,
        raw=raw,
        # Null-safe like every count above: a clock that came back negative (a
        # monotonic source that isn't, a stats object built from a bad delta) is
        # reported as unmeasured rather than as time travel.
        total_ms=max(0, int(total_ms or 0)),
        engine_ms=engine_ms,
        request_bytes=request_bytes,
        response_bytes=response_bytes,
    )


def _usage_detail_from_blob(blob: dict[str, Any]) -> UsageDetail | None:
    """Rebuild a ``UsageDetail`` that has been round-tripped through a peer.

    Rebuilt through ``build_usage_detail`` rather than ``model_validate``d so
    ``cost_basis`` is RE-DERIVED from ``byok`` on arrival. A peer forwarding this
    blob is trusted for the counts it observed, never for the billing tier it
    claims — that is derived from the funding tier of the credential, at the one
    place that derives it.
    """
    provider = str(blob.get("provider") or "")
    if not provider:
        return None

    occurred_at: datetime | None = None
    stamped = blob.get("occurred_at")
    if isinstance(stamped, str) and stamped:
        try:
            occurred_at = datetime.fromisoformat(stamped)
        except ValueError:
            occurred_at = None

    total = blob.get("total_tokens")
    return build_usage_detail(
        task_id=str(blob.get("task_id") or ""),
        request_id=str(blob["request_id"]) if blob.get("request_id") else None,
        provider=provider,
        model=str(blob.get("model") or ""),
        prompt_tokens=int(blob.get("prompt_tokens") or 0),
        completion_tokens=int(blob.get("completion_tokens") or 0),
        total_tokens=int(total) if total is not None else None,
        raw=blob.get("raw") if isinstance(blob.get("raw"), dict) else None,
        interrupted=bool(blob.get("interrupted", False)),
        byok=bool(blob.get("byok", False)),
        connection_id=(str(blob["connection_id"]) if blob.get("connection_id") else None),
        service_tier=(
            blob.get("service_tier") if isinstance(blob.get("service_tier"), str) else None
        ),
        occurred_at=occurred_at,
        # TASK-959 — the peer is trusted for what it MEASURED (it made the call);
        # only `cost_basis` is re-derived. Dropping these would lose the compute
        # and network of every judgement that reaches the ledger by ride-back.
        total_ms=_int_or_none(blob, "total_ms") or 0,
        engine_ms=_int_or_none(blob, "engine_ms"),
        request_bytes=_int_or_none(blob, "request_bytes"),
        response_bytes=_int_or_none(blob, "response_bytes"),
    )


def guardrail_usage_from_verdict(verdict: dict[str, Any] | None) -> UsageDetail | None:
    """Lift the safety plane's own per-call usage out of a validate() verdict.

    Guardrail is a peer service with no gateway in front of it, so the ONLY way
    its LLM spend reaches the billing plane is by riding back on the Text response
    that triggered it. A verdict without usage (validation disabled, a fail-closed
    outage verdict, an older guardrail build) yields ``None`` — silence, not zeros,
    because a zero row is indistinguishable from a free call.

    Two shapes are accepted, in priority order:

    * ``raw.usage_detail`` — the CURRENT shape. Guardrail no longer runs an LLM
      of its own: it delegates to ``POST /generate/internal/judge``, which
      already produced a full ``UsageDetail`` (with the funding tier of the
      credential that served the judgement), and guardrail forwards it verbatim.
      This is the same ride-back channel, repointed at the new producer — not a
      second one.
    * ``raw.stats`` — the LEGACY shape, from a guardrail build that still ran its
      own provider and could only report ``GenerationStats``. Such a call was
      always platform-funded, so it derives ``INTERNAL``.
    """
    if not isinstance(verdict, dict):
        return None
    raw = verdict.get("raw")
    if not isinstance(raw, dict):
        return None

    delegated = raw.get("usage_detail")
    if isinstance(delegated, dict):
        return _usage_detail_from_blob(delegated)

    stats = raw.get("stats")
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
