"""TASK-1036 §3.1 — "Derive v2": ``derive_variable_declarations``, Python mirror of
``derive-variable-declarations.ts``. Held to ``tests/contracts/derive-variables.fixture.json``.

Roots only; existing declarations kept verbatim and in order; new ones appended sorted; never
delete (unreferenced ones are reported ``stale``); namespace roots and the eleven platform
variables declare nothing; ``required = not hasDefault`` (AND over every occurrence). Pure.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from hope_workflow_contract.consultation_read_schema import PLATFORM_CONTEXT_ALIASES
from hope_workflow_contract.template import collect_placeholders

PROMPT_VARIABLE_NAMESPACE_ROOTS: tuple[str, ...] = (
    "context",
    "trigger",
    "input",
    "vars",
    "nodes",
    "variables",
    "consultation",
    "run",
)

#: The eleven flat platform variables, as bare names (`context.safe_age` → `safe_age`).
_PLATFORM_VARIABLE_NAMES = frozenset(
    name[name.index(".") + 1 :] for name in PLATFORM_CONTEXT_ALIASES
)
_NAMESPACE_ROOTS = frozenset(PROMPT_VARIABLE_NAMESPACE_ROOTS)


def derive_variable_declarations(
    content: str | Sequence[str | None], existing: Sequence[Any] | None = None
) -> dict[str, list[Any]]:
    kept = [
        d
        for d in (existing if isinstance(existing, list) else [])
        if isinstance(d, dict) and isinstance(d.get("name"), str)
    ]
    roots: dict[str, dict[str, bool]] = {}
    for reference in collect_placeholders(content):
        path: str = reference["path"]
        dot = path.find(".")
        root = path if dot < 0 else path[:dot]
        seen = roots.get(root)
        roots[root] = {
            "required": (seen["required"] if seen else False) or not reference["hasDefault"],
            "dotted": (seen["dotted"] if seen else False) or dot >= 0,
        }
    declared = {d["name"] for d in kept}
    added = sorted(
        root
        for root in roots
        if root not in declared
        and root not in _NAMESPACE_ROOTS
        and root not in _PLATFORM_VARIABLE_NAMES
    )
    derived = [
        {
            "name": name,
            "type": "json" if roots[name]["dotted"] else "string",
            "required": roots[name]["required"],
        }
        for name in added
    ]
    return {
        "declarations": [*kept, *derived],
        "added": added,
        "stale": [d["name"] for d in kept if d["name"] not in roots],
    }
