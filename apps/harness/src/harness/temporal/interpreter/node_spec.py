"""``NodeSpec`` — one entry of the interpreter's node-type registry (TASK-893: its own module).

Carved out of ``registry.py`` so that ``action_catalogue.py`` can build ``NodeSpec`` entries
without importing the registry (which imports the catalogue) — the same reason the TypeScript
side keeps ``action-catalogue.ts`` free of ``node-registry.ts``. ``registry.py`` re-exports both
names, so every existing import keeps working.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from temporalio import activity as temporal_activity


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
    (contracts/ compares against this field, never the callable
    itself, and never re-derives the name inside the sandboxed workflow module. ``kind`` is
    reserved for a future ``child_workflow`` dispatch (mirroring ``LoopActionSpec.kind``); v1 only
    ever uses ``"activity"``. ``critical``/``external_write`` are code-owned safety properties,
    never tenant-configurable (contracts/execution-semantics.md)

    output_keys is (option A), and it is the ONE piece of the port contract
    that is SHARED with the TypeScript side rather than TS-only. A port NAME is an authoring
    handle — ``out``, ``entities``, ``verdict``, what the Studio canvas draws and what a graph
    edge's ``fromPort``/``toPort`` names — but this interpreter threads values by reading a KEY
    out of the producing activity's own ``NodeActivityResult.output`` dict, and no activity in
    this platform emits a key called ``"out"``. Until OD-15 the only bridge was
    ``_resolve_bound_inputs``' whole-object fallback, which is precisely the untyped bundle the
    port vocabulary exists to abolish (a bundle cannot be typed as "contains a document", so
    generated prose could reach NER again).

    So each entry maps EVERY declared output port name to the output key it carries, or to
    ``None`` for a ``control`` port, which carries no payload at all. That ``None`` is
    load-bearing: it is what lets ``_resolve_bound_inputs`` tell a legitimate ORDERING edge
    (skip, contribute nothing) apart from an edge naming a port that does not exist (raise).

    Authored here by hand and asserted against the SAME committed fixture the TypeScript
    projection is asserted against (``node-registry.snapshot.json``) — see
    ``test_node_registry_parity.py``. Never add it to one side only.

    lane is the SECOND shared field ( lane A, item 17/7), and it is shared for the
    same kind of reason: it changes what this interpreter DOES. "realtime" means
    live executor owns the node, so ``_dispatch_node`` SKIPS it with ``reason="realtime_lane"``
    rather than running it a second time. Before this, ``descriptor.lane`` said ``durable`` on
    every node while ``REALTIME_NODE_TYPES`` (a hand-kept set in the applications layer) said
    otherwise for three of them — two sources of truth for one fact, and the durable interpreter
    read neither. The failure that made it urgent is concrete: ``consultation.realtimeSummary`` is
    ``external_write``, so both runtimes executing it means two engines writing one consultation's
    document.

    Skipping loses nothing that was working. In the DURABLE lane
    ``consultation.captureBinding`` emits no transcript at all, so ``consultation.extractEntities``
    and ``consultation.realtimeSummary`` already degraded on ``no_bound_text`` every time. The skip
    turns a silent degrade into an OBSERVABLE one and names the runtime that owns the work.
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
    output_keys: Mapping[str, str | None] = field(default_factory=dict)
    lane: str = "durable"

    def __post_init__(self) -> None:
        # frozen dataclass: use object.__setattr__ for the derived field.
        object.__setattr__(self, "activity_name", _registered_activity_name(self.activity))
