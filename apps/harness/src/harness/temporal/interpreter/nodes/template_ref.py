"""N-2 — prompt.template_ref (safety class: optional).

Resolves ``config.promptTemplateId`` through the gateway's
``GET /internal/harness/prompt-templates/:id/resolved`` (``ApiClient.get_resolved_prompt_template``)
to the pinned APPROVED ``PromptVersion`` content — NEVER the mutable ``PromptTemplate.content``
column  — resolution serves the version an approval pinned, not the latest edit).
``config.variableBindings`` (literal, tenant-authored string values — NOT references into the
run's context, see the node's config schema) fills ``{{var}}`` placeholders in the resolved
content, mirroring `PromptManagementService`'s own `interpolateTemplate` substitution syntax
(`{{\\s*name\\s*}}`, unmatched placeholders left intact).

Registry: ``critical=False`` (this node is optional in the palette). A resolution failure here
does not itself fail the run — it surfaces as a missing bound input to ``generate.text``, whose
OWN critical path fails when it has no prompt content to generate from (palette.md's "criticality
is a property of what a node's absence-of-output means for the run" rationale).
"""

from __future__ import annotations

import re
from typing import Any

from temporalio import activity

from harness.core.config import get_settings
from harness.services.api_client import ApiServiceError
from harness.temporal.activities import _api_client
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._shared import (
    STATUS_DEGRADED,
    STATUS_ERROR,
    STATUS_OK,
    now,
    record_and_flush,
)

_PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}")


def _interpolate(content: str, variable_bindings: dict[str, Any]) -> str:
    """`{{var}}` substitution with the caller-supplied literal values; an unmatched placeholder
    (no matching key in `variable_bindings`) is left intact, exactly like the TS-side
    `interpolateTemplate`."""

    def _replace(match: re.Match[str]) -> str:
        key = match.group(1)
        return str(variable_bindings[key]) if key in variable_bindings else match.group(0)

    return _PLACEHOLDER_RE.sub(_replace, content)


@activity.defn(name="interpreter.template_ref")
async def interpreter_template_ref(payload: NodeActivityInput) -> NodeActivityResult:
    started = now()
    template_id = payload.config.get("promptTemplateId")
    variable_bindings = payload.config.get("variableBindings") or {}

    if not template_id:
        await record_and_flush(
            payload,
            status=STATUS_DEGRADED,
            started=started,
            error_code="missing_prompt_template_id",
        )
        return NodeActivityResult(status="DEGRADED", reason="config.promptTemplateId is required")

    client = _api_client(get_settings())
    try:
        resolved = await client.get_resolved_prompt_template(
            template_id, tenant_id=payload.tenant_id
        )
    except ApiServiceError as exc:
        await record_and_flush(
            payload,
            status=STATUS_DEGRADED,
            started=started,
            error_code="prompt_resolution_unreachable",
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"prompt template resolution unreachable: {exc}"
        )

    if not resolved.found or not resolved.approved:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="prompt_template_not_approved"
        )
        reason = "not found" if not resolved.found else "has no approved version"
        return NodeActivityResult(
            status="DEGRADED", reason=f"prompt template {template_id} {reason}"
        )

    content = _interpolate(resolved.content, variable_bindings)
    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={
            "content": content,
            "promptTemplateId": template_id,
            "versionNumber": resolved.version_number,
        },
    )
