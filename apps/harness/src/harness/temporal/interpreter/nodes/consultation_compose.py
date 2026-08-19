"""N-6 ``consultation.retrieveEvidence``, N-7 ``consultation.assemblePrompt`` and
N-8 ``consultation.synthesize``.

Compile targets per ``contracts/palette-contract.md`` §1 rows 7a/7b/7c: ``retrieve_context``
(institutional knowledge-base RAG — explicitly NOT prior-history priming, which stays deferred,
§4c), ``assemble_prompt``, and the text generation path.

**N-6 is knowledge-base retrieval, not patient history.** §4c is emphatic that binding a node
type to an activity that performs a *different* data-access pattern "would misrepresent what
runs". ``retrieve_context`` retrieves tenant-scoped APPROVED institutional chunks; it does not
load prior notes under minimum-necessary scope, and this node does not claim to.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.services.api_client import ApiServiceError
from harness.temporal.activities import assemble_prompt, retrieve_context
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._consultation_shared import (
    bound_entities,
    run_identity,
)
from harness.temporal.interpreter.nodes._shared import (
    STATUS_ERROR,
    STATUS_OK,
    now,
    record_and_flush,
)
from harness.temporal.interpreter.nodes.text_generate import interpreter_text_generate
from harness.temporal.models import AssembleInput, RetrieveContextInput


@activity.defn(name="interpreter.consultation_retrieve_evidence")
async def interpreter_consultation_retrieve_evidence(
    payload: NodeActivityInput,
) -> NodeActivityResult:
    """N-6 — hybrid retrieval over the tenant's approved knowledge chunks, keyed off the bound
    entities.

    ``config.retrievalEnabled`` is a per-node override of the policy/env flag; omitted leaves
    the activity's own resolution in place. A degraded backend yields empty evidence and
    DEGRADES the node — never an exception into the run (CR-14), and never fabricated citations.
    """
    started = now()
    identity = run_identity(payload.run_payload)
    retrieval_enabled = payload.config.get("retrievalEnabled")

    try:
        retrieved = await retrieve_context(
            RetrieveContextInput(
                tenant_id=payload.tenant_id,
                entities=bound_entities(payload.bound_inputs),
                retrieval_enabled=(
                    bool(retrieval_enabled) if isinstance(retrieval_enabled, bool) else None
                ),
                external_patient_id=identity.external_patient_id,
                consultation_id=identity.consultation_id,
            )
        )
    except ApiServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="retrieval_unreachable"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"evidence retrieval failed: {exc}")

    output: dict[str, Any] = {
        "text": retrieved.prompt_block,
        "chunkIds": [chunk.chunk_id for chunk in retrieved.chunks if chunk.chunk_id],
        "chunkCount": len(retrieved.chunks),
    }
    if retrieved.degraded:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="retrieval_degraded"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason="a retrieval backend was unavailable — evidence is incomplete",
            output=output,
        )

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED", output=output)


@activity.defn(name="interpreter.consultation_assemble_prompt")
async def interpreter_consultation_assemble_prompt(
    payload: NodeActivityInput,
) -> NodeActivityResult:
    """N-7 — build the composer prompt from the consultation's own persisted context.

    ``assemble_prompt`` reads the consultation server-side (apps/api owns template resolution,
    DNA style and segment citations), so this node's authored config carries only the SELECTION
    knobs — never prompt text.
    """
    started = now()
    identity = run_identity(payload.run_payload)
    if not identity.consultation_id:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="no_consultation_id"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="run payload carries no consultationId to assemble for"
        )

    config = payload.config
    try:
        assembled = await assemble_prompt(
            AssembleInput(
                consultation_id=identity.consultation_id,
                tenant_id=payload.tenant_id,
                user_id=identity.user_id,
                template=_optional_str(config.get("template")),
                dna_style_id=_optional_str(config.get("dnaStyleId")),
                conversation_language=_optional_str(config.get("conversationLanguage")),
            )
        )
    except ApiServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="assemble_unreachable"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"prompt assembly failed: {exc}")

    if not assembled.user_prompt:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="empty_prompt"
        )
        return NodeActivityResult(status="DEGRADED", reason="prompt assembly returned no prompt")

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={
            "text": assembled.user_prompt,
            "systemPrompt": assembled.system_prompt,
            "promptTemplateId": assembled.prompt_template_id,
            "promptVersion": assembled.prompt_version,
            "resolvedFrom": assembled.resolved_from,
        },
    )


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


@activity.defn(name="interpreter.consultation_synthesize")
async def interpreter_consultation_synthesize(payload: NodeActivityInput) -> NodeActivityResult:
    """N-8 — generate the draft note from the bound prompt.

    Delegates verbatim to ``interpreter_text_generate`` (N-3 of the summarization palette) rather
    than carrying a second copy of the same flow. That activity already implements exactly what
    §1 row 7b asks for — ``config.taskKey`` → ``get_policy`` → tenant→SYSTEM ``AiTaskDefault``
    provider/model selection → fail-closed PHI egress screen → direct ``TextClient`` call — and
    it is generic over ``bound_inputs``, so it composes with this palette's upstream nodes
    unchanged. Passing ``payload`` straight through keeps the trajectory step, the node id and
    the node type this node's own (``record_and_flush`` reads them off the payload), so the run
    trace still reads ``consultation.synthesize``.

    ``config.producesCode`` (CR-18/WF-CONS-015) is deliberately NOT re-checked here. The
    validator is the safety boundary; a second, activity-side copy of one rule is the drift the
    ``@arcaai/json-schema-subset`` README warns about, and it would be checked far too late to
    protect anything.
    """
    return await interpreter_text_generate(payload)
