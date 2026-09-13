"""One neutral reasoning posture, ten engine vocabularies (TASK-970).

An admin turns "Enable reasoning" off on an agent. The posture resolves
correctly on the gateway, travels here on ``GenerateRequest.reasoning`` — and
then has to become something an engine understands. There are ten engines and
no two spell it the same way:

===============  =========================================================
adapter          what "off" actually is on that wire
===============  =========================================================
openai / azure   ``reasoning_effort: "none"``
openai_compat    an effort rung only — no off value a generic server promises
lmstudio         the same; LM Studio documents low|medium|high and no off
vllm             ``chat_template_kwargs: {"enable_thinking": false}``
ollama           ``think: false``
anthropic        ``thinking: {"type": "disabled"}`` (thinking is opt-IN)
vertex           ``thinking_config.thinking_budget = 0``
llama.cpp        nothing — the native ``/completion`` endpoint has no such knob
bedrock          nothing normalized — Converse passes a free-form Document
                 through to each model family's OWN vocabulary
===============  =========================================================

Before this module the posture reached THREE of those ten: only
``openai_compat`` (and its two subclasses) read ``request.extra`` at all, and
the posture rode along as a pre-rendered OpenAI ``reasoning_effort``. The other
seven dropped it with no record, while the console told the admin *"the engine
is instructed not to reason and reasoning tokens are never billed"*.

**The three rules this module exists to hold.**

1. *Declare, don't drop.* Every adapter carries ``reasoning_support`` /
   ``reasoning_parameter`` / ``reasoning_effort_parameter``, pinned against the
   committed cross-language contract
   ``tests/contracts/reasoning-posture.fixture.json`` by
   ``test_task970_reasoning_posture.py``. A new adapter that declares nothing
   fails that test — default-deny, exactly like ``CredentialPosture``.

2. *Unenforceable is LOGGED, never silent and never fatal* (owner decision,
   2026-09-13). An engine that cannot express the posture sends nothing,
   records provider + model + the posture on the generation's telemetry, and
   the call RUNS. No 422: a tuning knob must not become an outage risk on a
   provider swap. The defect being fixed is the silent drop, so the fix is a
   RECORD — not an error.

3. *Never approximate OFF onto a low effort.* That lossy mapping is what the
   contract was written to remove; re-introducing it one layer down would just
   move the lie. An adapter that cannot say "off" says so.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

import structlog
from opentelemetry import trace

from text.core.metrics import REASONING_UNENFORCEABLE_TOTAL
from text.models.requests import GenerateRequest, ReasoningPosture

logger = structlog.get_logger(__name__)


class ReasoningSupport(StrEnum):
    """What an ADAPTER can express — not what a vendor could theoretically accept.

    The distinction is load-bearing. Bedrock's Converse API *can* carry a
    reasoning directive, but only inside ``additionalModelRequestFields``, a
    free-form passthrough into the bound model's own vocabulary — which differs
    by family and generation, and where a key the family does not know is a
    ValidationException, i.e. a failed generation. An adapter that cannot render
    the posture SAFELY for every model of its engine declares ``UNSUPPORTED``
    and records, rather than guessing and occasionally taking generation down.
    """

    #: A true off-switch this adapter renders. ``reasoning_effort_parameter``
    #: says whether it can also drive an effort dial.
    NATIVE_OFF = "native-off"
    #: An effort can be expressed but OFF cannot. ``enabled: false`` is RECORDED,
    #: never approximated onto a low effort (rule 3 above).
    EFFORT_ONLY = "effort-only"
    #: The transport cannot express the posture at all — log and proceed.
    UNSUPPORTED = "unsupported"


#: The engine expresses no part of the posture (``UNSUPPORTED`` adapters).
REASON_ENGINE_CANNOT_EXPRESS = "engine_cannot_express_posture"
#: The engine has an effort dial but no off value this adapter can promise.
REASON_OFF_NOT_EXPRESSIBLE = "off_not_expressible"
#: "On" landed, but the named budget has no rung in this engine's vocabulary.
REASON_EFFORT_NOT_EXPRESSIBLE = "effort_not_expressible"

#: structlog event name — one dotted name so a Loki query finds every engine.
UNENFORCEABLE_EVENT = "text.reasoning.unenforceable"


def posture_to_render(request: GenerateRequest) -> ReasoningPosture | None:
    """The posture this adapter must render, or ``None`` to send nothing.

    ``None`` has two causes and neither is an error:

    * the request carries no posture — nobody had an opinion at any tier, so the
      engine decides and nothing is synthesized here;
    * the caller PINNED the raw ``extra.reasoning_effort`` ride-along. CALLER
      WINS, per key (the rule ``TextRequestEnrichmentService`` documents), so the
      adapter renders nothing of its own and the pin travels exactly as far as it
      does today — through ``extra_body`` on the OpenAI-compatible family, and
      nowhere else. A call site that pins the raw key is not second-guessed.
    """
    if request.extra and request.extra.get("reasoning_effort") is not None:
        return None
    return request.reasoning


def record_unenforceable(
    *,
    provider: str,
    model: str,
    posture: ReasoningPosture,
    reason: str,
) -> None:
    """Record a posture the engine could not honour. NEVER raises.

    Three places, because the three readers are different people: a structlog
    warning for whoever is reading this generation's logs, a span attribute so
    the trace of the call that was over-billed says why, and a counter so
    "which engines are quietly ignoring our admins?" is a dashboard question
    rather than an archaeology exercise.
    """
    logger.warning(
        UNENFORCEABLE_EVENT,
        provider=provider,
        model=model,
        reasoning_enabled=posture.enabled,
        reasoning_effort=posture.effort,
        reason=reason,
    )
    span = trace.get_current_span()
    span.set_attribute("gen_ai.request.reasoning.enabled", posture.enabled)
    if posture.effort is not None:
        span.set_attribute("gen_ai.request.reasoning.effort", posture.effort)
    span.set_attribute("gen_ai.request.reasoning.unenforceable", reason)
    REASONING_UNENFORCEABLE_TOTAL.labels(provider=provider, model=model, reason=reason).inc()


def record_unsupported_posture(
    request: GenerateRequest, *, provider: str, model: str | None
) -> None:
    """The whole body of ``_apply_reasoning`` for an ``UNSUPPORTED`` adapter.

    Sends nothing (there is nothing to send) and records the posture that could
    not be honoured. An absent posture records nothing — there was no intent to
    fail to honour.
    """
    posture = posture_to_render(request)
    if posture is None:
        return
    record_unenforceable(
        provider=provider,
        model=model or "",
        posture=posture,
        reason=REASON_ENGINE_CANNOT_EXPRESS,
    )


def apply_openai_wire_reasoning(
    kwargs: dict[str, Any],
    request: GenerateRequest,
    *,
    provider: str,
    model: str | None,
    off_is_expressible: bool,
) -> None:
    """Render the posture onto the OpenAI chat-completions wire.

    ``reasoning_effort`` is a typed parameter of the pinned SDK
    (``openai==3.1.0``: ``Literal['none','minimal','low','medium','high',
    'xhigh','max']``), so it goes in as a first-class kwarg rather than riding in
    ``extra_body``.

    ``off_is_expressible`` is the one thing that differs across the five
    OpenAI-wire adapters, and it is derived from the declared
    ``reasoning_support`` at each call site rather than restated here.
    ``'none'`` is a genuine rung of that literal — but only ``openai`` and
    ``azure_openai`` talk to a server that is guaranteed to know it. A generic
    OpenAI-compatible server (and LM Studio, whose docs list only
    low|medium|high) may reject an enum value it has never heard of, and a 400
    is a failed generation — so those adapters record OFF instead of guessing.

    "On" with no named effort deliberately sends NOTHING: this wire has no
    on-flag separate from the effort dial, and a reasoning model reasons by
    default, so "on, engine picks the budget" IS the absence of the parameter.
    """
    posture = posture_to_render(request)
    if posture is None:
        return
    if posture.enabled:
        if posture.effort is not None:
            kwargs["reasoning_effort"] = posture.effort
        return
    if off_is_expressible:
        kwargs["reasoning_effort"] = "none"
        return
    record_unenforceable(
        provider=provider,
        model=model or "",
        posture=posture,
        reason=REASON_OFF_NOT_EXPRESSIBLE,
    )
