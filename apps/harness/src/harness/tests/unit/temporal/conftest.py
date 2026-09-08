"""Test-only interpreter scaffolding (TASK-893 Phase 4).

``noop`` and ``passthrough`` were the interpreter's two SEED node types: inert activities with a
``config["raise_error"]`` hook, registered so a test could exercise dispatch, ordering, retry,
skip and failure semantics without standing up a real clinical node. They were never authorable —
no palette offered them and no seeded graph used them — so Phase 4 retired them from
``NODE_REGISTRY`` along with the rest of the legacy vocabulary, and ``NODE_ACTIVITIES`` now serves
exactly what the interpreter dispatches.

The SUITES that used them are still testing real semantics, so the scaffolding moves here instead
of being deleted with the vocabulary or, worse, kept in the shipped registry where it would be an
activity the worker serves that no graph can reach — the precise drift
``test_every_registered_node_activity_is_served_by_the_worker`` exists to catch.

The fixture is OPT-IN, not autouse. A session-scoped autouse version would put the two specs into
``NODE_REGISTRY`` for every test in the tree, including the census guards that assert the SHIPPED
registry is exactly the eleven ``core.*`` types — which would make those guards pass against a
registry no deploy ever has. A suite that needs the scaffolding declares it:

    pytestmark = pytest.mark.usefixtures("interpreter_scaffolding")

and adds ``SCAFFOLD_ACTIVITIES`` to any worker it builds.
"""

from __future__ import annotations

import pytest

from harness.temporal.interpreter.activities import interpreter_noop, interpreter_passthrough
from harness.temporal.interpreter.node_spec import NodeSpec
from harness.temporal.interpreter.registry import NODE_REGISTRY

#: The activities the scaffold specs dispatch to. Worker-building suites spread this alongside
#: `INTERPRETER_ACTIVITIES`; the production list deliberately does not carry them.
SCAFFOLD_ACTIVITIES = [interpreter_noop, interpreter_passthrough]

_SCAFFOLD_SPECS = {
    "noop": NodeSpec(
        key="noop", implemented=True, activity=interpreter_noop, output_keys={"next": None}
    ),
    "passthrough": NodeSpec(
        key="passthrough",
        implemented=True,
        activity=interpreter_passthrough,
        output_keys={"out": "text", "next": None},
    ),
}


@pytest.fixture
def interpreter_scaffolding() -> None:
    for key, spec in _SCAFFOLD_SPECS.items():
        NODE_REGISTRY.setdefault(key, spec)
    yield
    for key in _SCAFFOLD_SPECS:
        NODE_REGISTRY.pop(key, None)
