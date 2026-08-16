"""Node-type -> activity routing registry (S-4, S-6).

Mirrors ``LoopActionSpec``/``LOOP_ACTION_REGISTRY`` (``workflows.py:1628-1693``) in shape and in
the ``implemented`` discipline: a node type with NO entry, or an entry with ``implemented=False``,
dispatches as an OBSERVABLE skip (``unsupported_node_type``) — never a silent no-op (see
contracts/execution-semantics.md §10 for the full dispatch/security rationale, including why the
workflow always calls ``spec.activity`` directly and only cross-checks the wire's ``activity``
string, never trusts it for routing).

The registry starts EMPTY of palette nodes — TASK-720 populates it with the summarization
palette's five node types. This ticket ships only the ``noop``/``passthrough`` entries this
package's own tests need (ticket §4 Task 4).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from temporalio import activity as temporal_activity
from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from harness.temporal.interpreter.activities import (
        interpreter_noop,
        interpreter_passthrough,
    )


def _registered_activity_name(fn: Callable[..., Any]) -> str:
    """The Temporal-registered name of an ``@activity.defn`` callable.

    Uses ``activity._Definition.from_callable`` — the same SDK-internal helper the Worker itself
    uses to introspect an activity list at registration time; there is no public accessor in this
    SDK version. Computed HERE (registry.py, a plain module the workflow only ever
    pass-through-imports) rather than inside ``workflow.py``'s own sandboxed module namespace —
    calling into ``temporalio.activity`` internals directly from sandboxed workflow code tripped
    the sandbox's import restrictions during workflow validation (observed: a
    ``urllib.request.Request.__mro_entries__`` restriction fired at ``prepare_workflow`` time).
    Doing the introspection in a pass-through module and storing the plain string result on
    ``NodeSpec`` sidesteps that entirely.
    """
    defn = temporal_activity._Definition.from_callable(fn)  # noqa: SLF001 - no public API
    if defn is None or defn.name is None:
        raise ValueError(f"{fn!r} is not a valid @activity.defn callable with a fixed name")
    return defn.name


@dataclass(frozen=True)
class NodeSpec:
    """One entry in the node-type registry.

    ``activity`` is a CALLABLE reference (never a string) — see the module docstring.
    ``activity_name`` is the same activity's Temporal-registered name, precomputed at registry-
    build time (see ``_registered_activity_name``) — the workflow's S-4 cross-check
    (contracts/execution-semantics.md §10) compares against this field, never the callable
    itself, and never re-derives the name inside the sandboxed workflow module. ``kind`` is
    reserved for a future ``child_workflow`` dispatch (mirroring ``LoopActionSpec.kind``); v1 only
    ever uses ``"activity"``. ``critical``/``external_write`` are code-owned safety properties,
    never tenant-configurable (contracts/execution-semantics.md §5/§9).
    """

    key: str
    implemented: bool
    activity: Callable[..., Any]
    activity_name: str = field(init=False)
    kind: str = "activity"
    critical: bool = False
    external_write: bool = False
    default_timeout_seconds: int = 60
    default_max_attempts: int = 1
    entitlement_key: str | None = None

    def __post_init__(self) -> None:
        # frozen dataclass: use object.__setattr__ for the derived field.
        object.__setattr__(self, "activity_name", _registered_activity_name(self.activity))


NODE_REGISTRY: dict[str, NodeSpec] = {
    "noop": NodeSpec(key="noop", implemented=True, activity=interpreter_noop),
    "passthrough": NodeSpec(key="passthrough", implemented=True, activity=interpreter_passthrough),
}
