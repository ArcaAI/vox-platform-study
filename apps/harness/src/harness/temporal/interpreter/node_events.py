"""TASK-1038 R6 / TASK-1036 §10.3 (lane B1) — the per-node run-protocol v2 events an ACTIVITY emits.

The workflow emits the control facts it owns (``run.*``, ``node.started`` at dispatch,
``node.completed`` / ``node.failed`` at settle). Everything only the node's own activity knows is
emitted here, from inside the node-activity envelope (``activities.node_activity_envelope``), so
no Temporal command is added:

* ``node.started`` again with ``attempt > 1`` when Temporal RETRIES the activity — the client then
  discards that node's earlier partial outputs;
* ``data.bound`` (each bound input, its source, its resolved value, its PHI class) and
  ``binding.warning`` (a binding that resolved to nothing);
* at completion, ``output.data { visibility: 'admin' }`` for EVERY declared output of the node, and
  the PUBLIC outputs of a node wired into End or flagged ``stream`` (OD-24): text as
  ``output.text.delta``, any other value as ``output.data``.

All of it is gated on ``payload.protocol == 2`` (set by the walk only under the
``task-1038-run-protocol-v2`` marker) and is best-effort: the stream mirrors Temporal and an
append failure never fails a node.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.temporal.interpreter.data_contract import (
    binding_source,
    declared_output_fields,
    outputs_view,
    phi_class_of,
)
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.run_events import RunEventProducer, v2_node_key

#: NodeIO outputs of type `text` (they go out on the public plane as `output.text.delta`).
TEXT_OUTPUT_FIELDS = frozenset({"text", "transcript", "language", "document"})

#: Data-block input names whose value is TEXT for the `empty` flag of `data.bound`.
_PRIMARY_TEXT_INPUTS = frozenset({"message", "text", "in"})


def is_v2(payload: NodeActivityInput) -> bool:
    return payload.protocol == 2 and bool(payload.run_id)


def attempt_of() -> int:
    """The Temporal activity attempt (1 outside an activity, e.g. a direct unit call)."""
    return activity.info().attempt if activity.in_activity() else 1


def _key(payload: NodeActivityInput, attempt: int, intent: str) -> str:
    return v2_node_key(payload.run_id, payload.node_id, attempt, intent, payload.event_scope or "")


async def emit_prelude(
    producer: RunEventProducer,
    payload: NodeActivityInput,
    bound: dict[str, Any],
    attempt: int,
) -> None:
    """``node.started`` on a retry, then ``data.bound`` / ``binding.warning``."""
    if attempt > 1:
        await producer.append(
            run_id=payload.run_id,
            type="node.started",
            node_id=payload.node_id,
            data={"kind": payload.node_type, "attempt": attempt},
            dedupe_key=_key(payload, attempt, "started"),
        )
    bindings = payload.bindings or {}
    if not bindings:
        return
    inputs: list[dict[str, Any]] = []
    for name, binding in bindings.items():
        if not isinstance(binding, dict):
            continue
        if name not in bound:
            await producer.append(
                run_id=payload.run_id,
                type="binding.warning",
                node_id=payload.node_id,
                data={
                    "input": name,
                    "code": "BINDING_UNRESOLVED",
                    "message": f"`{name}` resolved to nothing; the step runs without it.",
                },
                dedupe_key=_key(payload, attempt, f"warning:{name}"),
            )
            continue
        entry: dict[str, Any] = {"input": name, "source": binding_source(binding)}
        value = bound[name]
        entry["value"] = value
        if value == "":
            entry["empty"] = True
        path = entry["source"].get("path")
        phi = phi_class_of(path) if isinstance(path, str) else None
        if phi is not None:
            entry["phiClass"] = phi
        inputs.append(entry)
    await producer.append(
        run_id=payload.run_id,
        type="data.bound",
        node_id=payload.node_id,
        data={"inputs": inputs},
        dedupe_key=_key(payload, attempt, "bound"),
    )


def node_outputs(payload: NodeActivityInput, result: NodeActivityResult) -> dict[str, Any]:
    """The node's NodeIO ``outputs`` (projected from its legacy output — never a second copy)."""
    task = (result.io or {}).get("task") if isinstance(result.io, dict) else None
    router_input: Any = payload.bound_inputs.get("in", _ABSENT)
    kwargs: dict[str, Any] = {"task": task if isinstance(task, str) else None}
    if router_input is not _ABSENT:
        kwargs["router_input"] = router_input
    view = outputs_view(payload.node_type, result.output, **kwargs)
    declared = set(declared_output_fields(payload.node_type, kwargs["task"]))
    return {name: value for name, value in view.items() if name in declared or name == "input"}


_ABSENT = object()


async def emit_outputs(
    producer: RunEventProducer,
    payload: NodeActivityInput,
    result: NodeActivityResult,
    attempt: int,
    streamed: set[str],
) -> None:
    """The node's outputs: public (OD-24) where it is wired into End / flagged ``stream``, and the
    admin trace's final value of every declared output (protocol-v2.md §5)."""
    if result.output is None:
        return
    outputs = node_outputs(payload, result)
    delivery = payload.delivery or {}
    public = set(delivery.get("publicFields") or [])
    if delivery.get("stream") is True:
        public |= set(outputs)
    public_data: set[str] = set()
    for name, value in outputs.items():
        if name not in public or name in streamed:
            continue
        if name in TEXT_OUTPUT_FIELDS and isinstance(value, str):
            await producer.text_delta(
                run_id=payload.run_id, node_id=payload.node_id, field=name, text=value
            )
            continue
        await producer.append(
            run_id=payload.run_id,
            type="output.data",
            node_id=payload.node_id,
            data={"field": name, "value": value},
            dedupe_key=_key(payload, attempt, f"public:{name}"),
        )
        public_data.add(name)
    for name, value in outputs.items():
        if name in public_data:
            continue
        await producer.append(
            run_id=payload.run_id,
            type="output.data",
            node_id=payload.node_id,
            data={"field": name, "value": value, "visibility": "admin"},
            dedupe_key=_key(payload, attempt, f"output:{name}"),
        )


def usage_of(output: dict[str, Any] | None) -> dict[str, int] | None:
    """Token counts from a node output's ``usage`` block (text-service shapes), or ``None``."""
    usage = (output or {}).get("usage")
    if not isinstance(usage, dict):
        return None

    def first_int(*names: str) -> int | None:
        for name in names:
            value = usage.get(name)
            if isinstance(value, int) and not isinstance(value, bool):
                return value
        return None

    tokens_in = first_int("prompt_tokens", "input_tokens", "promptTokens", "inputTokens")
    tokens_out = first_int("completion_tokens", "output_tokens", "completionTokens", "outputTokens")
    if tokens_in is None and tokens_out is None:
        total = first_int("total_tokens", "totalTokens")
        if total is None:
            return None
        return {"in": 0, "out": total}
    return {"in": tokens_in or 0, "out": tokens_out or 0}
