"""Shared helpers for the summarization-palette node activities (TASK-720 Task 5).

Not itself an activity module — imported by the five ``interpreter.*`` activities under this
package. Keeps the trajectory-recording boilerplate (identical to
``interpreter/activities.py``'s own ``_record_and_flush``) and the small, dependency-free dotted-
path resolver (used by N-1's ``bindings[].from`` and, generically, by any node that wants to read
a nested value out of ``bound_inputs``) in one place rather than five near-duplicate copies.
"""

from __future__ import annotations

from typing import Any

from harness.core.config import get_settings
from harness.temporal.activities import STATUS_ERROR, STATUS_OK, STEP_NODE, _now
from harness.temporal.activities import (
    _TrajectoryBatch as TrajectoryBatch,  # reuse, never a second emitter — noqa: SLF001
)
from harness.temporal.interpreter.models import NodeActivityInput

__all__ = ["MISSING", "STATUS_ERROR", "STATUS_OK", "now", "record_and_flush", "resolve_dotted_path"]

now = _now

# Sentinel distinct from `None` — a bound value can legitimately BE `None`/absent-shaped JSON;
# `MISSING` means "the path did not resolve at all".
MISSING = object()


async def record_and_flush(
    payload: NodeActivityInput, *, status: str, started: Any, error_code: str | None = None
) -> None:
    """One NODE trajectory step per node activity (mirrors `interpreter/activities.py`'s own
    seed-node helper — deliberately not imported from there to keep this package's five node
    modules free of a dependency on the seed noop/passthrough module)."""
    batch = TrajectoryBatch(get_settings(), payload.trajectory)
    batch.record(
        step_type=STEP_NODE,
        name=payload.node_type,
        status=status,
        started=started,
        error_code=error_code,
    )
    await batch.flush()


def resolve_dotted_path(root: dict[str, Any], path: str) -> Any:
    """Walk ``path`` (dot-separated, e.g. ``'payload.text'``) into ``root``.

    Returns ``MISSING`` (not ``None``) when any segment is absent or the value at a
    non-terminal segment is not itself a ``dict`` — so "the field is `null`" and "the field does
    not exist" stay distinguishable to the caller.
    """
    current: Any = root
    for segment in path.split("."):
        if not isinstance(current, dict) or segment not in current:
            return MISSING
        current = current[segment]
    return current
