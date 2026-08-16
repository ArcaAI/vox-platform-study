"""N-5 — ``output.deliver`` (TASK-720 Task 5, safety class: mandatory, the palette's ONLY
``external_write=True`` node — suppressed by the interpreter in sandbox mode).

Shapes the bound upstream content (`guardrail.check`'s output — see `_extract_text`) into the
declared ``config.outputs`` (reusing the ``ContextOutputDeclaration`` shape) and writes it
out-of-band via the same claim-check mechanism ``interpreter.load_config`` already uses
(`harness.temporal.claim_check` — self-hosted MinIO, content-addressed, never a cloud bucket).

**Why this node must perform a real external write, not just reshape and return**: the
interpreter's own result surface (`NodeResult`, `InterpreterResult`) carries per-node
SUCCEEDED/DEGRADED/SKIPPED/FAILED status ONLY — no `output` field at all (see
`interpreter/models.py`). Without an external write, a run's actual generated content would be
completely unrecoverable once the run finished; that is exactly what `external_write=True`
signals this node exists to prevent.

**Known, disclosed gap (not invented here)**: there is no established callback endpoint or
`WorkflowRun` column recording a `resultRef` for a run-status caller to read this blob back from
— `WorkflowExposureService.getRunStatus()` (TASK-722) reads Temporal state only. This activity
performs the write regardless (a genuine, real external write — the registry classification is
honoured), but END-TO-END retrieval of the delivered result by an invoker is NOT wired by this
ticket; recorded in this ticket's README §7 as a gap for TASK-722/723 (runs observability) to
close, not silently invented here.
"""

from __future__ import annotations

import json
from typing import Any

from temporalio import activity

from harness.core.config import get_settings
from harness.temporal.claim_check import build_blob_store, should_offload, store_blob
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._shared import (
    STATUS_ERROR,
    STATUS_OK,
    now,
    record_and_flush,
)


def _extract_text(bound_inputs: dict[str, Any]) -> str | None:
    """Prefers `guardrail.check`'s own output shape (`{"text", "verdict", "confidence"}`);
    falls back to any bound string, matching `guardrail_check.py`'s own extraction rule so a
    graph that (mis-)wires `output.deliver` straight off `generate.text` still degrades
    gracefully rather than crashing."""
    for value in bound_inputs.values():
        text = value.get("text") if isinstance(value, dict) else None
        if isinstance(text, str) and text:
            return text
    for value in bound_inputs.values():
        if isinstance(value, str) and value:
            return value
    return None


def _shape_outputs(outputs_decl: list[dict[str, Any]], text: str) -> dict[str, Any]:
    """Every declared output currently binds to the SAME single upstream text value — v1 has
    exactly one content-producing path through this palette (see `contracts/palette.md`'s
    mandatory-subgraph rule), so there is nothing else to differentiate multiple declared
    outputs by yet. `TEXT` outputs get the raw string; `STRUCTURED` outputs get it wrapped
    (`{"text": ...}`) rather than fabricating a shape nothing declared."""
    shaped: dict[str, Any] = {}
    for decl in outputs_decl:
        key = decl.get("key")
        if not key:
            continue
        shaped[key] = text if decl.get("primitive") == "TEXT" else {"text": text}
    return shaped


@activity.defn(name="interpreter.deliver")
async def interpreter_deliver(payload: NodeActivityInput) -> NodeActivityResult:
    started = now()
    outputs_decl = payload.config.get("outputs") or []

    text = _extract_text(payload.bound_inputs)
    if not text:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="no_bound_content"
        )
        return NodeActivityResult(status="DEGRADED", reason="no bound content to deliver")

    shaped = _shape_outputs(outputs_decl, text)
    if not shaped:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="no_declared_outputs"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="config.outputs declared no keys to shape"
        )

    serialized = json.dumps(shaped, sort_keys=True, ensure_ascii=False)
    settings = get_settings()
    result_output: dict[str, Any] = {}
    if settings.claim_check.enabled and should_offload(
        serialized, min_bytes=settings.claim_check.min_bytes
    ):
        store = build_blob_store(settings.claim_check)
        ref = await store_blob(serialized, store=store, bucket=settings.claim_check.bucket)
        result_output["resultRef"] = ref.model_dump()
    else:
        result_output["outputs"] = shaped

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED", output=result_output)
