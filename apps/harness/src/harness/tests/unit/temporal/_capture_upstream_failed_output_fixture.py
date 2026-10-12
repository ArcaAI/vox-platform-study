"""Capture the replay guards for ``upstream-failed-output``.

One run: a trigger, a REQUIRED ``core.agent`` (``onError: 'fail'``) that fails with nothing
stored, and a ``core.output`` fed by it. Recorded twice:

* against the definition BEFORE the marker (the output activity IS scheduled) —
  ``interpreter_upstream_failed_pre_marker_history`` — the BACKWARD guard: a run in flight when the
  marker deploys must replay without the new short-circuit;
* against the definition AFTER it (the output settles FAILED, no output activity) —
  ``interpreter_upstream_failed_marker_history`` — the FORWARD guard.

Not collected by pytest (no ``test_`` prefix), mirroring the other ``_capture_*`` scripts.

Usage (from ``apps/harness``, conda env ``arcaenv``)::

    PYTHONPATH=src python -m harness.tests.unit.temporal._capture_upstream_failed_output_fixture \\
        src/harness/tests/unit/temporal/fixtures <fixture-name>
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from harness.temporal.interpreter.registry import NODE_REGISTRY
from harness.tests.unit.temporal.conftest import _SCAFFOLD_SPECS
from harness.tests.unit.temporal.interpreter import _task1038_harness as h


def scenario() -> dict:
    finalize = h.agent(
        "n_finalize", _stub="client_error", inputs=[h.edge("n_trigger", "out", "in")]
    )
    finalize["onError"] = "fail"
    return h.body(
        [
            {"stageIndex": 0, "nodes": [h.trigger()]},
            {"stageIndex": 1, "nodes": [finalize]},
            {"stageIndex": 2, "nodes": [h.output([h.edge("n_finalize", "data", "in")])]},
        ]
    )


async def _main(out_dir: Path, name: str) -> None:
    for key, spec in _SCAFFOLD_SPECS.items():
        NODE_REGISTRY.setdefault(key, spec)
    _, _, history = await h.run_graph(scenario(), run_id=f"run-{name}")
    (out_dir / f"{name}.json").write_text(history.to_json())


if __name__ == "__main__":
    asyncio.run(_main(Path(sys.argv[1]), sys.argv[2]))
