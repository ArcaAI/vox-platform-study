"""Generation hyperparameter defaults — applied only when a request omits them.

These three numbers (`temperature`, `max_tokens`, `top_p`) had NO config surface
at all: they were literals in this module, applied at `openai_compat.py`,
`ollama.py` and `bedrock.py`, and there was no way to change them short of a
redeploy. They are also the most obviously per-deployment values in the service —
a summarisation profile and a clinical-extraction profile want different ones.

They have a home now. The gateway's ``applyTextRuntimeProfile``
(`packages/applications/.../text-request-enrichment.service.ts`) already fills
`temperature` / `top_p` / `max_tokens` from `AiRuntimeProfile` onto the request
body when it can resolve one, so a request that carried a profile never reaches
the fallback below. What is added here is the case it CANNOT cover: a caller with
no resolvable `(provider, model)` profile, whose values now come from the
platform generation profile on the PULL channel instead of from a literal.

Resolution order, most specific first:

1. the request's own value (a caller that set it always wins),
2. the platform generation profile from `/internal/effective-config`,
3. the in-code floor — a conservative, low-variance setting that is safe to send
   to any engine, not a preference anyone expressed.

The repetition penalties (`frequency_penalty`, `presence_penalty` — TASK-1001
OD-10) follow steps 1 and 2 and then STOP: there is no step 3 for them. They are
optional end to end. ABSENT and ``0`` both mean "send nothing" — ``0`` is the
neutral value on every engine that honours a penalty, and it is the descriptor's
shipped default — so a deployment where nobody set one sends byte-identical
provider requests. Each adapter then either forwards a non-zero value through
`penalty_kwargs` (its engine documents the parameter) or drops it with
`record_dropped_penalties` (its engine does not) — never an error.

ORIGIN decides reach. A penalty the REQUEST carried was authored for that
call's model (an agent's value, which the publish gate checks against the
model's declared parameter set), so any adapter that supports penalties sends
it. A penalty that came from the PLATFORM default was chosen without knowing the
model, so only the self-hosted OpenAI-compatible engines in
`PLATFORM_DEFAULT_PENALTY_PROVIDERS` send it — a managed endpoint such as a
GPT-5-class Azure deployment refuses penalties with a 400, and one admin setting
must not be able to break every call to it.

The active platform values live in module state rather than being threaded
through every adapter signature, mirroring how `apply_provider_retention`
(`services/runtime_limits.py`) pushes the retention TTL into live providers: one
refresh updates the process, and an adapter reads whatever is current.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

import structlog

if TYPE_CHECKING:
    from text.models.requests import GenerateRequest

logger = structlog.get_logger(__name__)

#: Last-resort floors. Deliberately conservative: near-deterministic sampling and
#: a generous-but-bounded output ceiling, chosen so that sending them to an engine
#: nobody profiled cannot produce a surprising bill or a truncated clinical note.
#:
#: The repetition penalties are deliberately NOT here. A floor is a value SENT
#: when nobody expressed one; a penalty nobody expressed must not be sent at all.
GENERATION_FLOOR: dict[str, float | int] = {
    "temperature": 0.1,
    "max_tokens": 16_384,
    "top_p": 0.95,
}

#: The decode-time repetition penalties (TASK-1001 OD-10), by their OpenAI-wire
#: names — which are also the `GenerateRequest` fields and the resolved keys.
PENALTY_PARAMS: tuple[str, str] = ("frequency_penalty", "presence_penalty")

#: Neutral: "Defaults to 0" (OpenAI chat-completions reference), "0.0 = disabled"
#: (llama.cpp server `/completion`). Sending it is indistinguishable from not
#: sending it on an engine that honours penalties — and an error on some that do
#: not — so it is never sent.
PENALTY_NEUTRAL = 0.0

#: Bounds, identical to `frequencyPenalty` / `presencePenalty` in
#: `GENERATION_PROPERTY` (`packages/workflow-contract/src/agent-schemas.ts`);
#: pinned cross-language by `tests/unit/test_task1001_repetition_penalties.py`.
PENALTY_MIN = -2.0
PENALTY_MAX = 2.0

#: The adapters (by the provider identity they report) that may send a penalty
#: which came from the PLATFORM default. Self-hosted OpenAI-compatible engines
#: only: each documents both penalties for every model it serves, so a value
#: chosen without knowing the model cannot turn into a refusal there. Every other
#: adapter sends only a penalty the request itself carried.
PLATFORM_DEFAULT_PENALTY_PROVIDERS: frozenset[str] = frozenset(
    {"lm-studio", "openai_compat", "vllm", "llama-cpp"}
)

#: Stable event name for a penalty an adapter did not send.
PENALTY_DROPPED_EVENT = "text.generation.penalty_dropped"
#: The engine has no penalty parameter (or refuses it per model).
REASON_ENGINE_CANNOT_TAKE = "engine_cannot_take_penalty"
#: The penalty came from the platform default and this adapter is not in
#: `PLATFORM_DEFAULT_PENALTY_PROVIDERS`.
REASON_PLATFORM_DEFAULT_NOT_FORWARDED = "platform_default_not_forwarded"

#: `(provider, penalty)` pairs already warned about in this process. A drop is
#: warned ONCE per pair: the platform default applies to every request, so a
#: per-call warning would flood the log with one fact.
_WARNED_DROPS: set[tuple[str, str]] = set()

#: The platform generation profile currently served by the control plane.
#: Replaced wholesale by `apply_generation_defaults`; empty until the first
#: successful effective-config refresh, and left untouched when the gateway is
#: unreachable (the negative-cache path) so a down control plane behaves exactly
#: like a control plane with no opinion.
_ACTIVE: dict[str, float | int] = {}


def apply_generation_defaults(served: dict[str, float | int]) -> None:
    """Adopt the platform generation profile. Called on every config refresh."""
    _ACTIVE.clear()
    _ACTIVE.update(served)


def active_generation_defaults() -> dict[str, float | int]:
    """The effective defaults: control-plane values over the in-code floors."""
    return {**GENERATION_FLOOR, **_ACTIVE}


def resolve_request_defaults(request: GenerateRequest) -> dict[str, float | int]:
    """Return resolved hyperparameters, using defaults only for None values.

    The three floored keys are ALWAYS present. A penalty key is present ONLY
    when it resolves to a non-neutral value, so an adapter forwards exactly what
    `penalty_kwargs` returns and an unset penalty never reaches a payload.
    """
    defaults = active_generation_defaults()
    values: dict[str, Any] = {
        "temperature": request.temperature,
        "max_tokens": request.max_tokens,
        "top_p": request.top_p,
    }
    resolved = {name: defaults[name] if value is None else value for name, value in values.items()}

    penalties: dict[str, float | None] = {
        "frequency_penalty": request.frequency_penalty,
        "presence_penalty": request.presence_penalty,
    }
    for name, value in penalties.items():
        # A caller's explicit 0 is a real value ("neutral"), not "unset" — it
        # must not fall through to the platform default, exactly as
        # `temperature=0.0` does not.
        chosen = defaults.get(name) if value is None else value
        if chosen is not None and chosen != PENALTY_NEUTRAL:
            resolved[name] = chosen
    return resolved


def penalty_kwargs(
    resolved: Mapping[str, float | int],
    request: GenerateRequest,
    *,
    provider: str,
    model: str | None,
) -> dict[str, float]:
    """The penalties an adapter that SUPPORTS them puts on the wire.

    ORIGIN is read off the request, with no second channel: a resolved penalty
    whose request field is ``None`` can only have come from the platform
    default (`resolve_request_defaults` has no other source). Such a penalty is
    sent only by a provider in `PLATFORM_DEFAULT_PENALTY_PROVIDERS`; anywhere
    else it is dropped and warned. A penalty the request carried is always sent.

    Empty unless a non-neutral penalty resolved — `resolve_request_defaults`
    never carries a neutral one — so ``kwargs.update(penalty_kwargs(...))``
    leaves an untouched request byte-identical.
    """
    sent: dict[str, float] = {}
    for name in PENALTY_PARAMS:
        if name not in resolved:
            continue
        value = float(resolved[name])
        from_platform_default = getattr(request, name) is None
        if from_platform_default and provider not in PLATFORM_DEFAULT_PENALTY_PROVIDERS:
            _warn_dropped_once(
                provider, name, value, model, reason=REASON_PLATFORM_DEFAULT_NOT_FORWARDED
            )
            continue
        sent[name] = value
    return sent


def record_dropped_penalties(
    resolved: Mapping[str, float | int], *, provider: str, model: str | None
) -> None:
    """The whole penalty story for an adapter whose engine cannot take one.

    Sends nothing and FAILS nothing: a non-zero penalty is a tuning knob, and a
    provider swap must not turn it into an outage. Silent when there was nothing
    to drop.
    """
    for name in PENALTY_PARAMS:
        if name in resolved:
            _warn_dropped_once(
                provider, name, float(resolved[name]), model, reason=REASON_ENGINE_CANNOT_TAKE
            )


def _warn_dropped_once(
    provider: str, name: str, value: float, model: str | None, *, reason: str
) -> None:
    """WARNING, once per ``(provider, penalty)`` per process — visible in
    production without repeating on every call the platform default reaches."""
    if (provider, name) in _WARNED_DROPS:
        return
    _WARNED_DROPS.add((provider, name))
    logger.warning(
        PENALTY_DROPPED_EVENT,
        provider=provider,
        model=model or "",
        penalty=name,
        value=value,
        reason=reason,
    )
