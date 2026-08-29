"""N-3 — ``generate.text`` (TASK-720 Task 5, safety class: mandatory, critical).

**Correction to this ticket's own README §2** (recorded here, not silently applied): README §2
reads N-3 as required to call the gateway's JWT-guarded, tenant-scoped
``POST /api/v1/text/generate``. Verified at implementation time that no such call path exists
from a Python harness activity (the existing ``ApiClient`` only reaches the
``X-Service-Token``-guarded ``/internal/harness/*`` routes) — but the CORRECT fix is not inventing
one. ``apps/harness/src/harness/temporal/activities.py``'s own, already-shipped ``generate``
activity (the one ``HarnessDocWorkflow`` uses for the exact same purpose) already establishes the
sanctioned pattern: fetch the effective policy via ``ApiClient.get_policy``, then call
``TextClient.generate`` DIRECTLY — never through the gateway.

**``config.taskKey`` SELECTS the model (TASK-740 D-1).** This node used to validate ``taskKey``
and then ignore it, resolving from the ``HarnessPolicy`` provider/model columns — so every
``generate.text`` node in every workflow resolved the SAME model whatever its task key, and the
seeded ``AiTaskDefault`` rows were inert on this path (they were honoured only on the TypeScript
path). The key is now threaded to ``get_policy`` as ``taskKey``, and the gateway overlays
``textProvider``/``textModel`` from the ``AiTaskDefault`` row for that key, tenant → SYSTEM. An
unresolved key leaves the policy columns in place, so a tenant with no opinion still runs. This activity reuses exactly that
pattern rather than a second, gateway-routed one. Rule `06-python-services.md` §Gateway
Integration sanctions direct peer calls to `apps/text` from a Python service.

**No default provider/model** — mirrors the text service's own fail-closed 422 (`generate.py:315-320`,
cited in README §2): an unresolved ``textProvider``/``textModel`` degrades this node rather than
guessing one.

**Prompt assembly** reads ``bound_inputs`` (threaded from upstream nodes via the compiled
``inputs`` edges — see ``NodeActivityInput.bound_inputs``'s docstring). A ``prompt.template_ref``
upstream (N-2) contributes its resolved, already-interpolated ``content``; an
``input.context_binding`` upstream (N-1) contributes its bound context kinds' string values.
Deliberately GENERIC (not keyed off a fixed port name) because port names are graph-author-chosen,
not fixed by this node's own config — see ``_assemble_prompt``'s docstring.

**PHI egress**: the assembled prompt is screened through the SAME fail-closed guard the existing
``generate`` activity uses (`harness.guards.phi.egress.ensure_egress_safe`) before any call —
local (non-cloud) providers pass through untouched; a cloud provider gets a fail-closed
redact+confirm, exactly matching the ``AiProviderConnection`` posture this palette's own
provider/model selection already routes through.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.core.config import get_settings
from harness.guards.phi.egress import ensure_egress_safe
from harness.guards.phi.redactor import PhiEgressBlocked
from harness.services.api_client import ApiServiceError
from harness.services.text_client import TextServiceError
from harness.temporal.activities import _api_client, _phi_redactor, _text_client
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._shared import (
    STATUS_DEGRADED,
    STATUS_OK,
    now,
    read_model_slug,
    record_and_flush,
)
from harness.temporal.models import HarnessPolicy

_ALLOWED_TASK_KEYS = {"text.finalize", "text.live", "text.test"}


def _assemble_prompt(bound_inputs: dict[str, Any]) -> str | None:
    """Fold every bound upstream value into one user prompt.

    Deliberately generic rather than assuming a fixed port name (e.g. ``'in'``): a
    ``prompt.template_ref`` node's output carries a well-known ``content`` key (its already-
    interpolated template text); anything else contributes its own string-valued fields (an
    ``input.context_binding`` node's output is ``{kindKey: value, ...}``). Concatenation order
    follows ``bound_inputs``' own iteration order, which is itself the compiled ``inputs`` list's
    order (`toPort`-sorted at compile time — deterministic, not re-sorted here).
    """
    template_text: str | None = None
    context_parts: list[str] = []
    for value in bound_inputs.values():
        if (
            isinstance(value, dict)
            and isinstance(value.get("content"), str)
            and "promptTemplateId" in value
        ):
            template_text = value["content"]
            continue
        if isinstance(value, dict):
            context_parts.extend(v for v in value.values() if isinstance(v, str) and v)
        elif isinstance(value, str) and value:
            context_parts.append(value)

    parts = [p for p in (template_text, "\n\n".join(context_parts)) if p]
    return "\n\n".join(parts) if parts else None


@activity.defn(name="interpreter.text_generate")
async def interpreter_text_generate(payload: NodeActivityInput) -> NodeActivityResult:
    started = now()
    config = payload.config
    task_key = config.get("taskKey")
    if task_key not in _ALLOWED_TASK_KEYS:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="invalid_task_key"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"config.taskKey {task_key!r} is not a recognized text task key",
        )

    user_prompt = _assemble_prompt(payload.bound_inputs)
    if not user_prompt:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_text"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="no text bound from an upstream node to generate from"
        )

    settings = get_settings()
    api_client = _api_client(settings)
    try:
        # TASK-816 (DD-10) — the node's OWN model binding, when it declares one. Read off the
        # SAME `payload.config` `task_key` comes from, and threaded to the gateway rather than
        # resolved here so one model resolution serves both runtimes. Unbound ⇒ `None` ⇒ the
        # tenant's `taskKey` AiTaskDefault, byte-identical to every run before this ticket.
        raw_policy = await api_client.get_policy(
            payload.tenant_id, task_key=task_key, model_slug=read_model_slug(payload.config)
        )
    except ApiServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="policy_fetch_unreachable"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"effective policy fetch unreachable: {exc}"
        )

    policy = HarnessPolicy.from_api(raw_policy)
    provider, model = policy.text_provider, policy.text_model
    if not provider or not model:
        # Mirrors the text service's own fail-closed 422 ("no default model") — never substitute one.
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_text_selection"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="no text provider/model resolved for this tenant"
        )

    redactor = _phi_redactor()
    system_prompt = config.get("systemPrompt")
    try:
        safe_prompt = ensure_egress_safe(
            user_prompt,
            provider=provider,
            settings=settings,
            phi_enabled=policy.phi_enabled,
            phi_fail_closed=policy.phi_fail_closed,
            redactor=redactor,
        )
        safe_system_prompt = (
            ensure_egress_safe(
                system_prompt,
                provider=provider,
                settings=settings,
                phi_enabled=policy.phi_enabled,
                phi_fail_closed=policy.phi_fail_closed,
                redactor=redactor,
            )
            if system_prompt
            else None
        )
    except PhiEgressBlocked as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="phi_egress_blocked"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"phi egress blocked: {exc}")

    text_client = _text_client(settings)
    try:
        result = await text_client.generate(
            # TASK-737 — `NodeActivityInput.tenant_id` is required on the interpreter's
            # own input model, so it is always available here; forwarding it is the
            # whole fix. The client raises on a blank value.
            tenant_id=payload.tenant_id,
            prompt=safe_prompt,
            system_prompt=safe_system_prompt,
            provider=provider,
            model=model,
            temperature=config.get("temperature"),
            max_tokens=config.get("maxTokens"),
            top_p=config.get("topP"),
            response_format=config.get("responseFormat"),
        )
    except TextServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="text_generate_failed"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"text generate failed: {exc}")

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={
            "text": result.content,
            "provider": result.provider or provider,
            "model": result.model or model,
        },
    )
