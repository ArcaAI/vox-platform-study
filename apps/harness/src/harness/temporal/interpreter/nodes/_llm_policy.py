"""Shared LLM-JUDGEMENT plumbing for the two Lane N capabilities.

Both capabilities the owner specified are the same shape and neither is a heuristic:

* ``agent.important_findings`` mines findings from the consultation context *"following a set of
  instructions defined/declared/overwriten by tenant admin"*;
* ``guard.groundedness`` evaluates the redacted transcript, the redacted summary and those
  findings against *"a set of policies defined/declared/overwriten by tenant admin"*.

So both need exactly this: resolve a tenant-authored instruction, resolve a model tenant ->
SYSTEM, screen the payload for PHI egress, call ``apps/text``, and parse a JSON reply strictly.
That is one shape, and it lives here rather than being written twice.

## Why a new module rather than importing ``consultation_realtime``'s private helpers

``nodes/consultation_realtime.py`` already has near-identical helpers, but they close over ITS
module-level ``_text_client``/``_api_client`` names — which is what its tests patch
(``monkeypatch.setattr(rt, "_text_client", ...)``). Importing them here would give this module
helpers no test could redirect, and monkeypatching them THERE would silently change that module's
behaviour. Each module binds its own client accessors; that is the established pattern in this
package (``text_generate.py`` and ``consultation_realtime.py`` each import ``_text_client``), not
duplication to be tidied away.

## No second inference stack, and no hardcoded selection

Nothing here hosts a model. LLM judgement goes to ``apps/text`` through the same ``TextClient``
every other node uses, and provider/model SELECTION resolves tenant -> SYSTEM through
``get_policy(task_key=...)`` and **fails CLOSED** — an unresolved selection degrades the node
rather than substituting an env default (00-project-context.md Principles).

## The instruction is never a literal

``resolve_instruction`` reads an APPROVED ``PromptVersion`` through the gateway, exactly as
``nodes/template_ref.py`` does, and RAISES when there is none. It has no fallback string, and it
must never grow one: a governed prompt that silently becomes an in-code default is the precise
failure the configuration rules exist to prevent, and it is worse here than elsewhere because the
prompt IS the tenant's definition of what "important" and "grounded" mean.
"""

from __future__ import annotations

import json
import re
from typing import Any

from harness.core.config import get_settings
from harness.guards.phi.egress import ensure_egress_safe
from harness.services.api_client import ApiServiceError
from harness.temporal.activities import (
    _api_client,  # noqa: SLF001 — the sanctioned accessor, same as nodes/text_generate.py
    _phi_redactor,  # noqa: SLF001
    _text_client,  # noqa: SLF001
)
from harness.temporal.models import HarnessPolicy

__all__ = [
    "InstructionUnavailable",
    "LlmJudgement",
    "generate_json",
    "parse_json_object",
    "resolve_instruction",
    "resolve_text_selection",
    "screen",
]

#: Task keys these nodes may select under. Mirrors ``nodes/consultation_realtime.py``'s own set —
#: the value still SELECTS the model through the ``AiTaskDefault`` overlay; this only rejects a
#: typo'd key before a pointless gateway round trip.
ALLOWED_TASK_KEYS = {"text.finalize", "text.live", "text.test"}

_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


class InstructionUnavailable(Exception):
    """The tenant's instruction/policy template could not be resolved to APPROVED content.

    Carries an ``error_code`` the caller stamps on the degrade, so "this tenant never bound a
    findings prompt" and "the gateway was unreachable" are distinguishable in a run trace rather
    than both looking like a model that found nothing.
    """

    def __init__(self, error_code: str, reason: str) -> None:
        super().__init__(reason)
        self.error_code = error_code
        self.reason = reason


class LlmJudgement:
    """One resolved model selection, reused across several policy evaluations in one node run."""

    __slots__ = ("model", "policy", "provider")

    def __init__(self, policy: HarnessPolicy, provider: str, model: str) -> None:
        self.policy = policy
        self.provider = provider
        self.model = model


def parse_json_object(content: str) -> dict[str, Any] | None:
    """Best-effort parse of a model's JSON reply; ``None`` when nothing parses.

    Tolerates the common ```json fence / prose-preamble shapes by falling back to the first
    balanced-looking ``{...}`` span. Returning ``None`` rather than a guess is the point: the
    caller DEGRADES, because a fabricated finding or a fabricated grounding verdict is worse than
    an absent one.
    """
    candidates = [content]
    match = _JSON_BLOCK.search(content or "")
    if match is not None:
        candidates.append(match.group(0))
    for candidate in candidates:
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


async def resolve_text_selection(
    tenant_id: str, task_key: str, model_slug: str | None = None
) -> tuple[LlmJudgement | None, str | None]:
    """``(judgement, error_code)`` — provider/model resolved tenant -> SYSTEM, FAIL-CLOSED.

    ``error_code`` non-``None`` means the caller must degrade. There is deliberately no env
    fallback: selection is ``failMode: closed``.

    (DD-10): model_slug is the node's own llmBinding.modelSlug and outranks
    ``task_key``. It is threaded to the gateway rather than resolved here — one model resolution,
    shared with every TypeScript caller. A bound slug that resolves to nothing 400s there and
    arrives as ``no_text_selection`` here, so the node DEGRADES with a named code instead of
    silently generating on the tenant default.
    """
    if task_key not in ALLOWED_TASK_KEYS:
        return None, "invalid_task_key"
    try:
        raw_policy = await _api_client(get_settings()).get_policy(
            tenant_id, task_key=task_key, model_slug=model_slug
        )
    except ApiServiceError:
        return None, "policy_fetch_unreachable"

    policy = HarnessPolicy.from_api(raw_policy)
    if not policy.text_provider or not policy.text_model:
        return None, "no_text_selection"
    return LlmJudgement(policy, policy.text_provider, policy.text_model), None


async def resolve_instruction(
    template_id: Any, tenant_id: str, *, missing_code: str, api: Any | None = None
) -> str:
    """The tenant's instruction text, from an APPROVED ``PromptVersion``. Never a default.

    ``missing_code`` names the caller's own "nothing was bound" error code so the degrade reads as
    the configuration gap it is.

    api lets a caller in ANOTHER module pass its OWN api-client accessor. This
    module's docstring explains why each module binds its own: the accessors are what its tests
    redirect, so a helper that closed over THIS module's ``_api_client`` would be unpatchable from
    a caller's suite, and — worse in production terms — one activity would resolve its selection
    through one client object and its instruction through another. The APPROVAL BAR itself stays
    here in one place, which is the thing that must not be copied.
    """
    if not isinstance(template_id, str) or not template_id:
        raise InstructionUnavailable(missing_code, "no instruction template is bound to this node")

    client = api if api is not None else _api_client(get_settings())
    try:
        resolved = await client.get_resolved_prompt_template(template_id, tenant_id=tenant_id)
    except ApiServiceError as exc:
        raise InstructionUnavailable(
            "instruction_resolution_unreachable",
            f"instruction template resolution unreachable: {exc}",
        ) from exc

    if not resolved.found or not resolved.approved:
        reason = "not found" if not resolved.found else "has no approved version"
        raise InstructionUnavailable(
            "instruction_not_approved", f"instruction template {template_id} {reason}"
        )

    content = (resolved.content or "").strip()
    if not content:
        raise InstructionUnavailable(
            "instruction_empty", f"instruction template {template_id} resolved to empty content"
        )
    return content


def screen(text: str, *, judgement: LlmJudgement, settings: Any, redactor: Any) -> str:
    """The same fail-closed PHI egress chokepoint ``nodes/text_generate.py`` uses."""
    return ensure_egress_safe(
        text,
        provider=judgement.provider,
        settings=settings,
        phi_enabled=judgement.policy.phi_enabled,
        phi_fail_closed=judgement.policy.phi_fail_closed,
        redactor=redactor,
    )


async def generate_json(
    *,
    tenant_id: str,
    judgement: LlmJudgement,
    system_prompt: str,
    user_payload: dict[str, Any],
    max_tokens: Any = None,
) -> dict[str, Any] | None:
    """Screen, call ``apps/text``, parse. ``None`` means the reply did not parse.

    Both halves of the request are screened, not just the data: an instruction a tenant authored
    is tenant text and can carry PHI exactly as a transcript can.
    """
    settings = get_settings()
    redactor = _phi_redactor()
    safe_prompt = screen(
        json.dumps(user_payload, ensure_ascii=False),
        judgement=judgement,
        settings=settings,
        redactor=redactor,
    )
    safe_system = screen(system_prompt, judgement=judgement, settings=settings, redactor=redactor)

    result = await _text_client(settings).generate(
        tenant_id=tenant_id,
        prompt=safe_prompt,
        system_prompt=safe_system,
        provider=judgement.provider,
        model=judgement.model,
        max_tokens=max_tokens,
    )
    return parse_json_object(result.content)
