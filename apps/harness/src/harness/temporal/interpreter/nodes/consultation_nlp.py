"""N-3 ``consultation.extractEntities`` and N-4 ``consultation.bindTerminology``.

Compile targets per ``contracts/palette-contract.md`` §1 rows 6a/6b: ``extract_entities`` plus
``persist_entities`` as the persist leg, and ``call_mcp_tool`` bound to the READ-ONLY
``validate_codes`` terminology tool.

**Why N-3 is ``external_write: true``** even though extraction itself writes nothing: the
persist leg does (``contracts/node-types.md``'s `critical` rationale, third bullet — "declare
``external_write=True`` on every consultation node that writes a ContextItem"). The flag is
declared for the node as a whole rather than finely split, which is also what makes the
interpreter's sandbox suppression correct for free: a sandboxed run skips this node entirely
rather than running the extraction and silently persisting.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.core.config import get_settings
from harness.sensors.base import NEREntity
from harness.services.api_client import ApiServiceError
from harness.services.nlp_client import NlpServiceError
from harness.temporal.activities import (
    _api_client,  # noqa: SLF001 — the sanctioned accessor, same as nodes/text_generate.py
    call_mcp_tool,
    extract_entities,
    persist_entities,
)
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._consultation_shared import (
    bound_entities,
    bound_text,
    run_identity,
)
from harness.temporal.interpreter.nodes._shared import (
    STATUS_DEGRADED,
    STATUS_OK,
    now,
    record_and_flush,
)
from harness.temporal.models import (
    CallMcpToolInput,
    ExtractEntitiesInput,
    HarnessPolicy,
    McpServerConfig,
    PersistEntitiesInput,
)

#: The one READ-ONLY terminology tool this node may call. Same constant value as
#: ``workflows.py``'s ``MCP_TERMINOLOGY_TOOL`` — restated rather than imported so an activity
#: module never imports a workflow module.
_TERMINOLOGY_TOOL = "validate_codes"


@activity.defn(name="interpreter.consultation_extract_entities")
async def interpreter_consultation_extract_entities(
    payload: NodeActivityInput,
) -> NodeActivityResult:
    """N-3 — medical NER over the bound transcript/text, then the persist leg.

    ``config.persist`` (default ``true``) controls the second leg only; extraction always runs.
    A persist failure DEGRADES but still returns the extracted entities, so a downstream
    ``bindTerminology``/``retrieveEvidence`` node is not starved by a persistence outage.
    """
    started = now()
    text = bound_text(payload.bound_inputs)
    if not text:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_text"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="no text bound from an upstream node to extract from"
        )

    identity = run_identity(payload.run_payload)
    try:
        extracted = await extract_entities(
            ExtractEntitiesInput(
                text=text,
                language=str(payload.config.get("language") or "en"),
                tenant_id=payload.tenant_id,
                consultation_id=identity.consultation_id,
            )
        )
    except NlpServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="nlp_extract_failed"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"entity extraction failed: {exc}")

    entities_json = [entity.model_dump(mode="json") for entity in extracted.entities]
    output: dict[str, Any] = {"entities": entities_json, "count": len(entities_json)}

    if not payload.config.get("persist", True):
        await record_and_flush(payload, status=STATUS_OK, started=started)
        return NodeActivityResult(status="SUCCEEDED", output={**output, "persisted": 0})

    if not identity.consultation_id:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_consultation_id"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason="entities extracted but not persisted — run payload carries no consultationId",
            output=output,
        )

    try:
        persisted = await persist_entities(
            PersistEntitiesInput(
                consultation_id=identity.consultation_id,
                tenant_id=payload.tenant_id,
                entities=extracted.entities,
                user_id=identity.user_id,
            )
        )
    except ApiServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="persist_entities_failed"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"entities extracted but not persisted: {exc}",
            output=output,
        )

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED", output={**output, "persisted": persisted.saved_count}
    )


def _select_terminology_server(servers: list[McpServerConfig]) -> McpServerConfig | None:
    """First ENABLED server whose allowlist carries the terminology tool.

    Mirrors ``workflows.py``'s ``_select_mcp_server`` (a pure, 5-line selection restated here
    rather than imported, so this activity module never imports a workflow module). Selection is
    NOT the security boundary — ``call_mcp_tool`` itself enforces the
    ``policy_tool_allowlist ∩ server.tool_allowlist`` intersection and the fail-closed PHI
    egress screen before any network call.
    """
    for server in servers:
        if server.enabled and _TERMINOLOGY_TOOL in (server.tool_allowlist or []):
            return server
    return None


def _terminology_args(entities: list[NEREntity]) -> dict[str, list[str]]:
    """READ-ONLY validation args: resolved ontology codes plus the surface terms.
    Mirrors ``workflows.py``'s ``_terminology_args``; stable order from the entity list."""
    codes: list[str] = []
    for entity in entities:
        for code in (
            entity.snomed_code,
            entity.icd_code,
            entity.rxnorm_code,
            entity.loinc_code,
            entity.umls_cui,
        ):
            if code:
                codes.append(code)
    return {"codes": codes, "terms": [entity.text for entity in entities]}


@activity.defn(name="interpreter.consultation_bind_terminology")
async def interpreter_consultation_bind_terminology(
    payload: NodeActivityInput,
) -> NodeActivityResult:
    """N-4 — validate the extracted entities' codes against a registered terminology server.

    ``config.purposeScope`` (CR-03/WF-CONS-013) and ``config.unmappedOutputKey``
    (CR-19/WF-CONS-016) are required BY THE VALIDATOR, not re-checked here — the validator is
    the gate and a second copy of one rule is exactly what drifts. This activity only READS
    ``unmappedOutputKey`` to name the output key it publishes the unmapped terms under, so the
    coverage gap is surfaced rather than silently dropped.

    Best-effort by design (CR-14): no registered server, a blocked tool, or a server error all
    DEGRADE with the entities passed through unchanged — a terminology outage must not stop a
    consultation from producing a note.
    """
    started = now()
    unmapped_key = payload.config.get("unmappedOutputKey")
    unmapped_key = unmapped_key if isinstance(unmapped_key, str) and unmapped_key else "unmapped"

    entities = bound_entities(payload.bound_inputs)
    if not entities:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_entities"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="no entities bound from an upstream extraction node"
        )

    entities_json = [entity.model_dump(mode="json") for entity in entities]
    passthrough: dict[str, Any] = {"entities": entities_json, unmapped_key: []}

    try:
        raw_policy = await _api_client(get_settings()).get_policy(payload.tenant_id)
    except ApiServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="policy_fetch_unreachable"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"effective policy fetch unreachable: {exc}",
            output=passthrough,
        )

    policy = HarnessPolicy.from_api(raw_policy)
    server = _select_terminology_server(policy.mcp_servers)
    if server is None:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_terminology_server"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"no enabled MCP server offers {_TERMINOLOGY_TOOL!r} for this tenant",
            output=passthrough,
        )

    identity = run_identity(payload.run_payload)
    try:
        result = await call_mcp_tool(
            CallMcpToolInput(
                server=server,
                tool=_TERMINOLOGY_TOOL,
                args=_terminology_args(entities),
                policy_tool_allowlist=policy.tool_allowlist,
                phi_enabled=policy.phi_enabled,
                phi_fail_closed=policy.phi_fail_closed,
                tenant_id=payload.tenant_id,
                external_patient_id=identity.external_patient_id,
                consultation_id=identity.consultation_id,
            )
        )
    except Exception as exc:  # noqa: BLE001 — allowlist/PHI blocks raise non-retryably here
        # Same posture as `workflows.py`'s own `except ActivityError` around this call: the
        # terminology hop is best-effort, so it degrades rather than failing the run.
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="mcp_tool_blocked"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"terminology validation blocked or unreachable: {exc}",
            output=passthrough,
        )

    output = {**passthrough, "validation": result.content, "server": result.server}
    if result.degraded or not result.ok:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="mcp_tool_degraded"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="terminology server returned a degraded result", output=output
        )

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED", output=output)
