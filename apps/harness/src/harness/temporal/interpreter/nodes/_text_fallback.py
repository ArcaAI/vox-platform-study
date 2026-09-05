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

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from harness.temporal.interpreter.models import ResolvedAgent, ResolvedPrompt

__all__ = [
    "TextFallbackBlock",
    "TextFallbackCandidate",
    "candidate_as_resolved_agent",
    "read_text_fallback",
    "wire_provider",
]

#: The contract defaults (`AGENT_FALLBACK_DEFAULTS` in `@arcaai/workflow-contract`), mirrored for an
#: answer that predates the block — never a second source of truth for a block that carries them.
_DEFAULT_AUTO_SWITCH = True
_DEFAULT_SWITCH_AFTER = 2


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


class TextFallbackBlock(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    auto_switch: bool = Field(default=_DEFAULT_AUTO_SWITCH, alias="autoSwitch")
    switch_after_consecutive_failures: int = Field(
        default=_DEFAULT_SWITCH_AFTER, alias="switchAfterConsecutiveFailures"
    )
    chain: list[TextFallbackCandidate] = Field(default_factory=list)


def read_text_fallback(raw: Any) -> TextFallbackBlock:
    """The ``textFallback`` block of a raw resolve answer, with the contract defaults applied.

    Tolerant on purpose: an answer without the block (an older gateway, or a non-text agent)
    reads as "ON, threshold 2, nothing to switch to"; a malformed candidate is dropped rather
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
        }
    )
