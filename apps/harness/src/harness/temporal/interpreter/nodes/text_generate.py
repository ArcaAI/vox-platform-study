"""N-3 — generate.text (safety class: mandatory, critical).

**Correction to ** (recorded here, not silently applied):
reads N-3 as required to call the gateway's JWT-guarded, tenant-scoped
``POST /api/v1/text/generate``. Verified at implementation time that no such call path exists
from a Python harness activity (the existing ``ApiClient`` only reaches the
``X-Service-Token``-guarded ``/internal/harness/*`` routes) — but the CORRECT fix is not inventing
one. ``apps/harness/src/harness/temporal/activities.py``'s own, already-shipped ``generate``
activity (the one ``HarnessDocWorkflow`` uses for the exact same purpose) already establishes the
sanctioned pattern: fetch the effective policy via ``ApiClient.get_policy``, then call
``TextClient.generate`` DIRECTLY — never through the gateway.

**Where the selection comes from.** This node used to validate ``config.taskKey`` and then
ignore it, resolving from the ``HarnessPolicy`` provider/model columns — so every
``generate.text`` node in every workflow resolved the SAME model whatever its task key. The key
is still threaded to ``get_policy`` as ``taskKey`` (it names the capability and is validated
against ``_ALLOWED_TASK_KEYS``), but since TASK-876 the gateway overlays
``textProvider``/``textModel`` from the tenant's ASSIGNED ``TEXT_GENERATION`` agent
(department → tenant → SYSTEM), not from a per-task-key row: ``AgentAssignment``'s key carries no
role dimension, so a task key never chose which agent serves. With no agent assigned at any tier
both fields are NULLED and this node degrades ``no_text_selection``. This activity reuses exactly
that pattern rather than a second, gateway-routed one. Rule `06-python-services.md` §Gateway
Integration sanctions direct peer calls to `apps/text` from a Python service.

**No default provider/model** — mirrors the text service's own fail-closed 422 (`generate.py:315-320`,
cited in : an unresolved textProvider/textModel degrades this node rather than
guessing one.

**Prompt assembly** reads ``bound_inputs`` (threaded from upstream nodes via the compiled
``inputs`` edges — see ``NodeActivityInput.bound_inputs``'s docstring). A ``prompt.template_ref``
upstream (N-2) contributes its resolved, already-interpolated ``content``; an
``input.context_binding`` upstream (N-1) contributes its bound context kinds' string values.
Deliberately GENERIC (not keyed off a fixed port name) because port names are graph-author-chosen,
not fixed by this node's own config — see ``_assemble_prompt``'s docstring.

**PHI egress** (TASK-1035): ``apps/text`` owns it — it pseudonymizes for a cloud provider,
re-identifies the answer and fails CLOSED. The prompt is sent verbatim with the identity this run
holds as ``known_phi``. No ``provider_locality`` is stamped: this lane knows the provider only by
NAME (the policy overlay), and text classifies a name itself.

**System prompt** (TASK-1035 lane G): when an upstream ``consultation.assemblePrompt`` is bound,
its ``systemPrompt`` IS this call's system prompt; ``config.systemPrompt`` is an explicit
override of it.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.core.config import get_settings
from harness.core.llm_egress import known_phi_from
from harness.services.api_client import ApiServiceError
from harness.services.text_client import TextServiceError
from harness.temporal.activities import _api_client, _text_client
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._shared import (
    STATUS_DEGRADED,
    STATUS_OK,
    now,
    record_and_flush,
)
from harness.temporal.models import HarnessPolicy

_ALLOWED_TASK_KEYS = {"text.finalize", "text.live", "text.test"}


def _is_assembled_prompt(value: Any) -> bool:
    """``consultation.assemblePrompt``'s output: ``{text, systemPrompt, promptTemplateId, …}``."""
    return (
        isinstance(value, dict) and "systemPrompt" in value and isinstance(value.get("text"), str)
    )


def _assemble_prompt(bound_inputs: dict[str, Any]) -> tuple[str | None, str | None]:
    """Fold every bound upstream value into ``(user_prompt, assembled_system_prompt)``.

    Deliberately generic rather than assuming a fixed port name (e.g. ``'in'``): a
    ``prompt.template_ref`` node's output carries a well-known ``content`` key (its already-
    interpolated template text); a ``consultation.assemblePrompt`` output contributes its
    ``text`` to the user prompt and its ``systemPrompt`` as the system prompt — never its
    metadata (template id, version, resolution source); anything else contributes its own
    string-valued fields (an ``input.context_binding`` node's output is ``{kindKey: value, ...}``).
    Concatenation order follows ``bound_inputs``' own iteration order, which is itself the
    compiled ``inputs`` list's order (`toPort`-sorted at compile time — deterministic, not
    re-sorted here).
    """
    template_text: str | None = None
    assembled_system: str | None = None
    context_parts: list[str] = []
    for value in bound_inputs.values():
        if (
            isinstance(value, dict)
            and isinstance(value.get("content"), str)
            and "promptTemplateId" in value
        ):
            template_text = value["content"]
            continue
        if _is_assembled_prompt(value):
            if value["text"]:
                context_parts.append(value["text"])
            system = value.get("systemPrompt")
            if isinstance(system, str) and system:
                assembled_system = system
            continue
        if isinstance(value, dict):
            context_parts.extend(v for v in value.values() if isinstance(v, str) and v)
        elif isinstance(value, str) and value:
            context_parts.append(value)

    parts = [p for p in (template_text, "\n\n".join(context_parts)) if p]
    return ("\n\n".join(parts) if parts else None), assembled_system


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

    user_prompt, assembled_system = _assemble_prompt(payload.bound_inputs)
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
        # TASK-876: the gateway overlays the tenant's ASSIGNED TEXT_GENERATION agent on the
        # policy for this task key (the node `llmBinding` is retired; the key is telemetry).
        raw_policy = await api_client.get_policy(payload.tenant_id, task_key=task_key)
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

    # Lane G — the assembled system prompt is bound; `config.systemPrompt` explicitly overrides it.
    config_system = config.get("systemPrompt")
    system_prompt = (
        config_system if isinstance(config_system, str) and config_system else assembled_system
    )

    text_client = _text_client(settings)
    try:
        result = await text_client.generate(
            # `NodeActivityInput.tenant_id` is required on the interpreter's
            # own input model, so it is always available here; forwarding it is the
            # whole fix. The client raises on a blank value.
            tenant_id=payload.tenant_id,
            prompt=user_prompt,
            system_prompt=system_prompt or None,
            provider=provider,
            model=model,
            temperature=config.get("temperature"),
            max_tokens=config.get("maxTokens"),
            top_p=config.get("topP"),
            response_format=config.get("responseFormat"),
            known_phi=known_phi_from(payload.run_payload),
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
