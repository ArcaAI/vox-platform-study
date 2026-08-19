"""N-2 — ``consultation.captureBinding`` (mandatory safety class, not ``critical``).

A **binding** node, never a loop: it starts or stops the live-documentation session and
returns; the debounce/retrigger behaviour stays in ``LiveDocumentationService`` where
``contracts/palette-contract.md`` §3 puts it ("realtime, per-frame, or debounced-retrigger
behaviour never enters a Temporal workflow's deterministic execution model; only the durable,
one-shot checkpoints do"). Compile target per §1 row 4: ``livedoc_start`` / ``livedoc_stop``.

``config.action`` selects which. There is no default — a node that does not say which end of the
capture it binds is an authoring error, and guessing ``start`` would silently leave sessions
open.
"""

from __future__ import annotations

from temporalio import activity

from harness.services.api_client import ApiServiceError
from harness.temporal.activities import livedoc_start, livedoc_stop
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._consultation_shared import run_identity
from harness.temporal.interpreter.nodes._shared import (
    STATUS_ERROR,
    STATUS_OK,
    now,
    record_and_flush,
)
from harness.temporal.models import LiveDocControlInput

_ACTIONS = ("start", "stop")


@activity.defn(name="interpreter.consultation_capture_binding")
async def interpreter_consultation_capture_binding(
    payload: NodeActivityInput,
) -> NodeActivityResult:
    started = now()
    action = payload.config.get("action")
    if action not in _ACTIONS:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="invalid_action"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"config.action {action!r} is not 'start' or 'stop'"
        )

    identity = run_identity(payload.run_payload)
    if not identity.consultation_id:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="no_consultation_id"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="run payload carries no consultationId to bind capture to"
        )

    control = LiveDocControlInput(
        consultation_id=identity.consultation_id,
        tenant_id=payload.tenant_id,
        user_id=identity.user_id,
        session_id=identity.session_id,
        persist_snapshot=bool(payload.config.get("persistSnapshot", True)),
    )
    try:
        result = await livedoc_start(control) if action == "start" else await livedoc_stop(control)
    except ApiServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="livedoc_unreachable"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"live documentation {action} unreachable: {exc}"
        )

    if not result.ok:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="livedoc_refused"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"live documentation refused the {action} request"
        )

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={"action": action, "consultationId": identity.consultation_id},
    )
