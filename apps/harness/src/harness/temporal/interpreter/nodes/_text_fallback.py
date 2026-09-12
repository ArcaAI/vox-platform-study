"""TASK-876 — the `textFallback` block of a resolved TEXT_GENERATION agent.

``GET /internal/agents/resolve`` answers a TEXT_GENERATION agent with, beside TASK-863's
``ResolvedAgent``, the agent's fallback governance and the ORDERED chain the gateway already
resolved (`packages/applications` ``TextAgentResolverService``): the explicit
``parameters.fallback.agentSlug`` agent, else the agent's own ``AgentModelFallback`` chain, then
the SYSTEM-assigned agent as the platform default. Every candidate carries its provider (as
apps/text registers it), its provider-native model id, its resolved instruction and parameters,
and the funding tier DERIVED from the row that serves it.

This module only READS that block. It resolves nothing — the whole point of carrying the chain on
the wire is that the activity walks it without a second resolution (rule 16: no adapter here may
build its own selection from graph data, and funding is derived from the serving row, so a
locally-built candidate would mis-bill silently rather than fail).

``autoSwitch`` is the tenant's per-agent HA toggle (owner decision #4 — ON by default): the
activity switches to the next candidate on a ``TextServiceError`` only while it is on.
"""

from __future__ import annotations

import time
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from temporalio import activity

from harness.temporal.interpreter.models import ResolvedAgent, ResolvedPrompt

__all__ = [
    "ActivityBudget",
    "TextFallbackBlock",
    "TextFallbackCandidate",
    "candidate_as_resolved_agent",
    "chain_candidates",
    "read_text_fallback",
    "read_text_primary",
    "wire_provider",
]

#: The contract default (`AGENT_FALLBACK_DEFAULTS.autoSwitch` in `@arcaai/workflow-contract`),
#: mirrored for an answer that predates the block — never a second source of truth for a block
#: that carries it.
_DEFAULT_AUTO_SWITCH = True


def wire_provider(provider: str | None) -> str | None:
    """The provider name apps/text registers: the catalogue seeds ``azure``, the text service
    registers ``azure-openai`` (the same alias every TypeScript text caller applies)."""
    if provider == "azure":
        return "azure-openai"
    return provider


class TextFallbackAgentRef(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    slug: str
    version_id: str | None = Field(default=None, alias="versionId")
    version_number: int = Field(default=0, alias="versionNumber")
    tenant_id: str | None = Field(default=None, alias="tenantId")
    source: str | None = None


class TextFallbackCandidate(BaseModel):
    """One runnable candidate of the chain — `ResolvedTextCandidate` on the TS side."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    kind: str
    agent: TextFallbackAgentRef
    model_slug: str = Field(alias="modelSlug")
    provider: str
    #: The provider-native model id (`AiModel.sourceUri`) — what goes on the wire.
    model: str
    resolved_prompt: ResolvedPrompt | None = Field(default=None, alias="resolvedPrompt")
    instruction: dict[str, Any] | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)
    funding_tier: str | None = Field(default=None, alias="fundingTier")
    #: TASK-958 G3 — THIS candidate's one-hop cloud credential
    #: (`ResolvedTextCandidate.providerOverride`), resolved gateway-side from the model row's
    #: `sourceConnectionId`. It is per CANDIDATE because a chain can name two accounts of one
    #: vendor — or two vendors — and the primary's credential is not the fallback's. Dropping
    #: it here sent the fallback down `TextClient`'s by-NAME lookup, which answers with the
    #: tenant's DEFAULT connection for that provider: the wrong key and the wrong invoice.
    #: Never persisted — it lives in an activity local, like every other credential here.
    provider_override: dict[str, Any] | None = Field(default=None, alias="providerOverride")


class TextFallbackBlock(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    #: The EFFECTIVE switch decision — the gateway funding-gates it (a tenant may disable
    #: platform HA only for a primary it funds), so nothing here re-derives funding.
    auto_switch: bool = Field(default=_DEFAULT_AUTO_SWITCH, alias="autoSwitch")
    #: No `switchAfterConsecutiveFailures`: both TEXT lanes are per-call and switch on the FIRST
    #: failure, so a threshold would have no reader. It stays on the ASR block, whose session
    #: manager does count across calls.
    chain: list[TextFallbackCandidate] = Field(default_factory=list)


def read_text_fallback(raw: Any) -> TextFallbackBlock:
    """The ``textFallback`` block of a raw resolve answer, with the contract defaults applied.

    Tolerant on purpose: an answer without the block (an older gateway, or a non-text agent)
    reads as "ON, nothing to switch to"; a malformed candidate is dropped rather
    than failing the run — the gateway's own validation is where a bad shape is refused, and a
    node that degraded over a fallback it could not parse would be resilience configuration
    blocking the primary.
    """
    block = raw.get("textFallback") if isinstance(raw, dict) else None
    if not isinstance(block, dict):
        return TextFallbackBlock()
    candidates: list[TextFallbackCandidate] = []
    raw_chain = block.get("chain")
    for entry in raw_chain if isinstance(raw_chain, list) else []:
        if not isinstance(entry, dict):
            continue
        try:
            candidates.append(TextFallbackCandidate.model_validate(entry))
        except ValueError:
            continue
    governance = {k: v for k, v in block.items() if k != "chain"}
    try:
        parsed = TextFallbackBlock.model_validate(governance)
    except ValueError:
        parsed = TextFallbackBlock()
    parsed.chain = candidates
    return parsed


def read_text_primary(raw: Any) -> TextFallbackCandidate | None:
    """The ``textPrimary`` candidate of a raw resolve answer, or ``None``.

    The primary's funding tier is DERIVED by the gateway from the row that serves it, exactly as
    every chain candidate's is. Bare ``ResolvedAgent.fundingTier`` is not that: it is populated
    only when TASK-862's credential resolver returned a CLOUD override, so a self-hosted
    PLATFORM primary reports ``None`` there while its own fallback reports ``"platform"`` — the
    same call metering two different ways depending on which candidate served. Reading the
    primary from here removes that split.

    ``None`` (an older gateway, or a non-text agent) leaves the previous attribution in place.
    """
    block = raw.get("textPrimary") if isinstance(raw, dict) else None
    if not isinstance(block, dict):
        return None
    try:
        return TextFallbackCandidate.model_validate(block)
    except ValueError:
        return None


def candidate_as_resolved_agent(candidate: TextFallbackCandidate) -> ResolvedAgent:
    """Project a chain candidate onto the ``ResolvedAgent`` shape ``_run_text_generation`` reads,
    so ONE generation path serves the primary and every fallback alike (same prompt
    interpolation, same parameter merge, same PHI egress gate)."""
    return ResolvedAgent.model_validate(
        {
            "agentId": candidate.agent.version_id or candidate.agent.slug,
            "agentVersionId": candidate.agent.version_id,
            "slug": candidate.agent.slug,
            "versionNumber": candidate.agent.version_number,
            "task": "TEXT_GENERATION",
            "tenantId": candidate.agent.tenant_id,
            "source": candidate.agent.source,
            "instruction": candidate.instruction,
            "resolvedPrompt": (
                candidate.resolved_prompt.model_dump(by_alias=True)
                if candidate.resolved_prompt is not None
                else None
            ),
            "parameters": candidate.parameters,
            "model": {
                "slug": candidate.model_slug,
                "provider": candidate.provider,
                "sourceUri": candidate.model,
            },
            "fundingTier": candidate.funding_tier,
            # TASK-958 G3 — carried onto the projection so the ONE generation path spends the
            # account THIS candidate is bound to. Omitted when the candidate names none, which
            # leaves `TextClient`'s by-name resolution exactly as it was.
            **(
                {"providerOverride": candidate.provider_override}
                if candidate.provider_override
                else {}
            ),
        }
    )


def chain_candidates(block: TextFallbackBlock | None) -> list[TextFallbackCandidate]:
    """The fallback candidates a call may run, in order — EMPTY when the switch is off.

    The ONE place both text lanes (the `core.agent` activity and the durable `generate`
    activity) ask "may I switch, and to what?". ``auto_switch`` on the block is already the
    EFFECTIVE decision: the gateway funding-gates it (a tenant may disable platform HA only for
    a primary it funds), so nothing here re-derives funding to second-guess it.

    A candidate with no wire provider or no model id is dropped: it could only 503.
    """
    if block is None or not block.auto_switch:
        return []
    return [c for c in block.chain if wire_provider(c.provider) and c.model]


class ActivityBudget:
    """Whether ANOTHER candidate's call can still finish inside this activity's budget.

    The whole chain walk runs inside ONE activity's ``start_to_close_timeout``. Without this
    guard a switch late in the budget is started anyway, the activity times out mid-call, and
    Temporal re-runs it FROM THE PRIMARY — re-billing a generation that already completed and
    losing the fallback's work. So a candidate is only STARTED when its own per-call timeout
    still fits in what is left; on exhaustion the walker stops and the node degrades, never
    raises (a raise is what makes Temporal retry).

    The FIRST candidate is always allowed: the budget governs SWITCHING, not the attempt the
    activity exists to make. Outside an activity context (unit fixtures) there is no declared
    budget and the guard is inert.
    """

    def __init__(self, per_call_seconds: float, total_seconds: float | None) -> None:
        self._per_call = per_call_seconds
        self._total = total_seconds
        self._start = time.monotonic()

    @classmethod
    def for_activity(cls, per_call_seconds: float) -> ActivityBudget:
        total: float | None = None
        try:
            timeout = activity.info().start_to_close_timeout
        except RuntimeError:
            timeout = None
        if timeout is not None:
            total = timeout.total_seconds()
        return cls(per_call_seconds, total)

    @property
    def remaining_seconds(self) -> float | None:
        if self._total is None:
            return None
        return self._total - (time.monotonic() - self._start)

    def allows_another(self) -> bool:
        remaining = self.remaining_seconds
        return remaining is None or remaining >= self._per_call
