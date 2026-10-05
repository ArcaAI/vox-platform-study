"""TASK-1038 R-3 — how a large value travels through the interpreter BY REFERENCE (pure).

Three reserved shapes may stand in for a value inside a node output, a bound input, the run
payload or the run context. The WORKFLOW only ever moves them around (it cannot do I/O); the
node-activity envelope (``activities.py::node_activity_envelope``) turns them back into the value
before the node's own code runs, so no node activity ever sees one.

* **Claim-check marker** ``{"$hopeClaimCheck": <ClaimCheckRef>}`` — a value stored out of band
  because it was larger than the node-output threshold. Content-addressed and immutable.
* **Run-payload sentinel** ``{"$hopeRunPayload": true}`` — "the run payload this activity was
  handed". Lets the run context name the payload without carrying a second (third, fourth) copy
  of it: before TASK-1038 every ``core.*`` input carried it four times.
* **Deferred trigger** ``{"$hopeRunTrigger": {"base": <value>, "live": {...}}}`` — the run
  context's ``trigger`` view, to be rebuilt by :func:`publish_trigger` once ``base`` is resolved.

This module is imported by the deterministic workflow: no I/O, no clock, no randomness here.
"""

from __future__ import annotations

from typing import Any

MARKER_KEY = "$hopeClaimCheck"
RUN_PAYLOAD_KEY = "$hopeRunPayload"
RUN_TRIGGER_KEY = "$hopeRunTrigger"


def make_marker(ref: dict[str, Any]) -> dict[str, Any]:
    """The marker for a stored value (``ref`` is a ``ClaimCheckRef`` dump)."""
    return {MARKER_KEY: dict(ref)}


def is_marker(value: Any) -> bool:
    return isinstance(value, dict) and len(value) == 1 and isinstance(value.get(MARKER_KEY), dict)


def run_payload_sentinel() -> dict[str, Any]:
    return {RUN_PAYLOAD_KEY: True}


def is_run_payload_sentinel(value: Any) -> bool:
    return isinstance(value, dict) and len(value) == 1 and value.get(RUN_PAYLOAD_KEY) is True


def deferred_trigger(base: Any, live: dict[str, Any]) -> dict[str, Any]:
    return {RUN_TRIGGER_KEY: {"base": base, "live": dict(live)}}


def is_deferred_trigger(value: Any) -> bool:
    return (
        isinstance(value, dict) and len(value) == 1 and isinstance(value.get(RUN_TRIGGER_KEY), dict)
    )


def is_reference(value: Any) -> bool:
    """Any of the three stand-ins — something only an activity can turn into the value."""
    return is_marker(value) or is_run_payload_sentinel(value) or is_deferred_trigger(value)


def publish_trigger(trigger: dict[str, Any], live: dict[str, Any]) -> dict[str, Any]:
    """The run context's ``trigger`` view, built from the trigger's published context.

    The ONE spelling of TASK-946 D1 / OD-3 + TASK-932 R-16a (see ``workflow._run_context``): the
    flat context stays at the top level, the canonical ``trigger.context`` namespace is added (a
    single-kind ENVELOPE ``{"context": {...}}`` is unwrapped first, so a read never moves one
    level down), and the LIVE handoff's keys win in both views.
    """
    envelope = trigger.get("context")
    authored = envelope if isinstance(envelope, dict) else trigger
    return {**trigger, **live, "context": {**authored, **live}}


def reference_on_path(root: Any, path: str) -> bool:
    """Whether resolving the dotted ``path`` from ``root`` crosses a reference (pure).

    ``True`` means the workflow cannot resolve it in memory and an activity must; ``False``
    means an unresolvable path is genuinely absent.
    """
    current = root
    for segment in path.split("."):
        if is_reference(current):
            return True
        if isinstance(current, dict) and segment in current:
            current = current[segment]
        elif isinstance(current, list) and segment.isdigit() and int(segment) < len(current):
            current = current[int(segment)]
        else:
            return False
    return is_reference(current)
