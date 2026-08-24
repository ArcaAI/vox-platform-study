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

The active platform values live in module state rather than being threaded
through every adapter signature, mirroring how `apply_provider_retention`
(`services/runtime_limits.py`) pushes the retention TTL into live providers: one
refresh updates the process, and an adapter reads whatever is current.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from text.models.requests import GenerateRequest

#: Last-resort floors. Deliberately conservative: near-deterministic sampling and
#: a generous-but-bounded output ceiling, chosen so that sending them to an engine
#: nobody profiled cannot produce a surprising bill or a truncated clinical note.
GENERATION_FLOOR: dict[str, float | int] = {
    "temperature": 0.1,
    "max_tokens": 16_384,
    "top_p": 0.95,
}

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
    """Return resolved hyperparameters, using defaults only for None values."""
    defaults = active_generation_defaults()
    values: dict[str, Any] = {
        "temperature": request.temperature,
        "max_tokens": request.max_tokens,
        "top_p": request.top_p,
    }
    return {name: defaults[name] if value is None else value for name, value in values.items()}
