"""Node-type -> activity routing registry (S-4, S-6).

Mirrors ``LoopActionSpec``/``LOOP_ACTION_REGISTRY`` (``workflows.py:1628-1693``) in shape and in
the ``implemented`` discipline: a node type with NO entry, or an entry with ``implemented=False``,
dispatches as an OBSERVABLE skip (``unsupported_node_type``) — never a silent no-op (see
contracts/ for the full dispatch/security rationale, including why the
workflow always calls ``spec.activity`` directly and only cross-checks the wire's ``activity``
string, never trusts it for routing).

The registry starts EMPTY of palette nodes — populates it with the summarization
palette's five node types. This ticket ships only the ``noop``/``passthrough`` entries this
package's own tests need ( Task 4).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from temporalio import workflow

from harness.temporal.interpreter.node_spec import NodeSpec, _registered_activity_name

with workflow.unsafe.imports_passed_through():
    from harness.temporal.interpreter.action_catalogue import ACTION_CATALOGUE
    from harness.temporal.interpreter.nodes.core import (
        interpreter_core_action,
        interpreter_core_agent,
        interpreter_core_classify,
        interpreter_core_condition,
        interpreter_core_data,
        interpreter_core_human_review,
        interpreter_core_loop,
        interpreter_core_note,
        interpreter_core_output,
        interpreter_core_trigger,
        interpreter_core_variables,
    )


__all__ = [
    "ACTION_CATALOGUE",
    "CORE_LOOP_NODE_TYPE",
    "CORE_REVIEW_NODE_TYPE",
    "NODE_REGISTRY",
    "NodeSpec",
    "_registered_activity_name",
    "effective_spec",
    "output_keys_for",
]

NODE_REGISTRY: dict[str, NodeSpec] = {
    # -----------------------------------------------------------------------------------------
    # TASK-864 — the `core` vocabulary. Mirrors `node-registry.ts`; the parity fixture pins both.
    # The router/review handles (`otherwise`, `else`, `approved`/`rejected`/`timedOut`) are
    # CONTROL ports (`None`); the per-class / per-branch handles are per-instance and never
    # resolved as inputs — an edge from one becomes a `branchGuards` entry on the target, which
    # `_resolve_bound_inputs` never sees. `core.loop`'s `each` carries the current `item`.
    # -----------------------------------------------------------------------------------------
    "core.trigger": NodeSpec(
        key="core.trigger",
        implemented=True,
        activity=interpreter_core_trigger,
        critical=True,
        external_write=False,
        default_timeout_seconds=30,
        default_max_attempts=1,
        output_keys={"out": "context", "next": None},
    ),
    "core.agent": NodeSpec(
        key="core.agent",
        implemented=True,
        activity=interpreter_core_agent,
        critical=False,
        external_write=False,
        default_timeout_seconds=300,
        default_max_attempts=2,
        output_keys={
            "out": "text",
            "data": "data",
            "transcript": "transcript",
            "audio": "audio",
            "next": None,
        },
    ),
    "core.classify": NodeSpec(
        key="core.classify",
        implemented=True,
        activity=interpreter_core_classify,
        critical=False,
        external_write=False,
        default_timeout_seconds=60,
        default_max_attempts=2,
        output_keys={"out": "classification", "otherwise": None, "next": None},
    ),
    "core.humanReview": NodeSpec(
        key="core.humanReview",
        implemented=True,
        activity=interpreter_core_human_review,
        kind="child_workflow",
        critical=False,
        external_write=True,
        default_timeout_seconds=3600,
        default_max_attempts=1,
        output_keys={
            "out": "decision",
            "approved": None,
            "rejected": None,
            "timedOut": None,
            "next": None,
        },
    ),
    "core.variable": NodeSpec(
        key="core.variable",
        implemented=True,
        activity=interpreter_core_variables,
        critical=False,
        external_write=False,
        default_timeout_seconds=30,
        default_max_attempts=2,
        output_keys={"out": "vars", "next": None},
    ),
    "core.condition": NodeSpec(
        key="core.condition",
        implemented=True,
        activity=interpreter_core_condition,
        critical=False,
        external_write=False,
        default_timeout_seconds=30,
        default_max_attempts=2,
        output_keys={"out": "evaluation", "else": None, "next": None},
    ),
    "core.loop": NodeSpec(
        key="core.loop",
        implemented=True,
        activity=interpreter_core_loop,
        kind="child_workflow",
        critical=False,
        external_write=False,
        default_timeout_seconds=3600,
        default_max_attempts=1,
        output_keys={"each": "item", "done": "result", "next": None},
    ),
    "core.note": NodeSpec(
        key="core.note",
        implemented=True,
        activity=interpreter_core_note,
        critical=False,
        external_write=False,
        default_timeout_seconds=1,
        default_max_attempts=1,
        output_keys={},
    ),
    "core.output": NodeSpec(
        key="core.output",
        implemented=True,
        activity=interpreter_core_output,
        critical=True,
        external_write=True,
        default_timeout_seconds=60,
        default_max_attempts=2,
        output_keys={},
    ),
    "core.data": NodeSpec(
        key="core.data",
        implemented=True,
        activity=interpreter_core_data,
        critical=False,
        external_write=False,
        default_timeout_seconds=30,
        default_max_attempts=2,
        output_keys={"out": "data", "next": None},
    ),
    "core.action": NodeSpec(
        key="core.action",
        implemented=True,
        activity=interpreter_core_action,
        critical=False,
        external_write=False,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={
            "out": "result",
            "text": "text",
            "entities": "entities",
            "verdict": "verdict",
            "document": "document",
            "context": "context",
            "next": None,
        },
    ),
}

# TASK-893 — the `core.action` catalogue is a first-class table (`action_catalogue.py`);
# `effective_spec` resolves a `core.action` instance through it, never through NODE_REGISTRY.

#: The node types the interpreter dispatches as CHILD WORKFLOWS under the TASK-864 patch, rather
#: than as activities. Named once so `_dispatch_node` and the registry agree.
CORE_LOOP_NODE_TYPE = "core.loop"
CORE_REVIEW_NODE_TYPE = "core.humanReview"


def effective_spec(node_type: str, config: Mapping[str, Any] | None) -> NodeSpec | None:
    """The spec whose SAFETY properties govern an instance.

    For `core.action` that is the catalogue descriptor's spec (a `consultation.persistDraft`
    action writes, so a sandbox must suppress it); for everything else it is the type's own.
    `None` for an unknown type or an unknown action key.
    """
    spec = NODE_REGISTRY.get(node_type)
    if spec is None:
        return None
    if node_type == "core.action":
        key = config.get("actionKey") if isinstance(config, Mapping) else None
        return ACTION_CATALOGUE.get(key) if isinstance(key, str) else None
    return spec


def output_keys_for(
    node_type: str, config: Mapping[str, Any] | None
) -> Mapping[str, str | None] | None:
    """The output sockets an INSTANCE publishes — a `core.action`'s are its catalogue entry's."""
    spec = effective_spec(node_type, config)
    return None if spec is None else spec.output_keys
