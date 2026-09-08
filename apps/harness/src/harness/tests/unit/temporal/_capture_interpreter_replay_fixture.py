"""Capture the `WorkflowInterpreter` v1 replay-compat fixtures.

Runs one scenario in Temporal's time-skipping environment against the CURRENTLY IMPORTED
workflow definition and writes the resulting history JSON. Not collected by pytest (does not
match ``test_*``) — mirrors ``_capture_replay_fixture.py``'s own convention exactly.

The scenario covers, in a single run, the three command shapes a future interpreter change is
most likely to break:

1. A multi-stage walk (three stages).
2. A fan-out stage (three concurrent nodes).
3. One DEGRADED node alongside SUCCEEDED siblings in the SAME stage, proving the all-settled
   join's command shape is captured too.

## TASK-893 — the graph is now `core.*`

The original fixtures were recorded against the ``noop``/``passthrough`` SEED node types. Phase 4
retired those from ``NODE_REGISTRY``, so the recorded histories stopped replaying: the current
definition walks them, finds no registered spec, SKIPs every node, completes early, and Temporal
reports ``[TMPRL1100] Nondeterminism error`` on the first recorded ``ActivityTaskScheduled``.

Under the owner ruling of 2026-09-08 (TASK-930 README §4.5) those histories are no longer
evidence — the vocabulary they replay is gone by decision, and the deploy precondition in
``docs/operations/deprecation-register.md`` (drain in-flight harness workflows before deploying)
is what carries the risk they used to. So the scenario is re-authored on the SHIPPED vocabulary,
using ``test_core_interpreter.py``'s own compiled-config builders and its two activity stubs —
exactly as ``_capture_core_replay_fixture.py`` does, and for the same reason: activity BODIES are
never replayed, so a stub changes nothing about what the fixture proves.

## Two eras, one scenario

``--no-stream`` suppresses the run-event mirror for the duration of the capture, producing a
history with NO ``interpreter.emit_run_events`` commands and NO ``task-849-run-event-stream``
marker. That is the BACKWARD guard's fixture: replaying it through the shipped definition proves
``workflow.patched(_STREAM_PATCH)`` still returns False and still skips the emits. It is a
SYNTHESISED era rather than a historical recording — the shipped definition emits a run-completed
event on every run, so no capture of it can ever omit the marker — and it is synthesised because
the genuine pre-stream recordings used the retired vocabulary above.

Without the flag the shipped definition is captured verbatim: marker present, emits recorded.
That is the FORWARD guard's fixture.

Neither scenario carries a ``core.humanReview`` or a ``core.loop``, which is deliberate: those are
the only two types whose dispatch consults ``_CORE_PATCH``, so
``TestCoreVocabularyReplayCompatibility::test_every_pre_core_history_still_replays_with_the_patch_never_consulted``
keeps asserting exactly what it always asserted.

Usage (from the repo root, conda env `arcaenv`):

    PYTHONPATH=apps/harness/src python -m harness.tests.unit.temporal._capture_interpreter_replay_fixture \
        --no-stream apps/harness/src/harness/tests/unit/temporal/fixtures/interpreter_v1_history.json

    PYTHONPATH=apps/harness/src python -m harness.tests.unit.temporal._capture_interpreter_replay_fixture \
        apps/harness/src/harness/tests/unit/temporal/fixtures/interpreter_stream_v1_history.json
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
import uuid
from pathlib import Path
from typing import Any

from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from harness.temporal.claim_check import _MEMORY_STORE, store_blob
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.models import InterpreterInput
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal.interpreter.test_core_interpreter import (
    _ACTIVITIES,
    _body,
    _edge,
    _node,
    _output,
    _trigger,
)

_BUCKET = "harness-claim-check"
_TENANT = "22222222-2222-2222-2222-222222222222"


def _agent(node_id: str, *, fail: bool = False, inputs: list[dict] | None = None) -> dict:
    config: dict[str, Any] = {"agentRef": {"slug": "fixture-agent"}}
    if fail:
        config["_stub_fail"] = True
    return _node(node_id, "core.agent", "interpreter.core_agent", config=config, inputs=inputs)


def _v1_body() -> dict:
    return _body(
        [
            {"stageIndex": 0, "nodes": [_trigger()]},
            {
                "stageIndex": 1,
                "nodes": [
                    _agent("fanout-a", inputs=[_edge("n_trigger", "out", "in")]),
                    _agent("fanout-b", inputs=[_edge("n_trigger", "out", "in")]),
                    # The DEGRADED sibling: the stub raises, the node is not critical, and the
                    # all-settled join still settles the stage.
                    _agent("fanout-degraded", fail=True, inputs=[_edge("n_trigger", "out", "in")]),
                ],
            },
            {"stageIndex": 2, "nodes": [_output([_edge("fanout-a", "out", "in")])]},
        ]
    )


async def capture(out_path: Path, *, stream: bool) -> None:
    body = _v1_body()
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    ref = await store_blob(
        json.dumps({**body, "checksum": checksum}), store=_MEMORY_STORE, bucket=_BUCKET
    )

    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"interpreter-capture-{uuid.uuid4()}"
        worker_kwargs: dict[str, Any] = {}
        if not stream:
            # See the module docstring: the shipped definition emits on every run, so the only
            # way to record a marker-free history is to suppress the mirror for the capture
            # itself. The patch has to be applied to the class the WORKFLOW sees, which means
            # running the capture unsandboxed — the sandbox re-imports the module and would
            # otherwise hand the workflow the shipped method back. Replay always runs against
            # the real method, which is the whole point of the fixture.
            async def _no_emit(self: Any, inp: Any, events: Any) -> None:  # noqa: ANN401
                return None

            WorkflowInterpreter._emit_run_events = _no_emit  # type: ignore[method-assign]
            worker_kwargs["workflow_runner"] = UnsandboxedWorkflowRunner()

        async with Worker(
            env.client,
            task_queue=tq,
            workflows=[WorkflowInterpreter],
            activities=_ACTIVITIES,
            **worker_kwargs,
        ):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-fixture-1",
                    workflow_version_id="v-fixture-1",
                    config_ref=ref,
                    # A REAL uuid: the run-event mirror builds an `AsyncEnvelope`, whose
                    # `tenantId` is uuid-typed. A placeholder id would make every emit reject its
                    # own envelope, and the fixture would then record a command shape no
                    # production run can ever produce.
                    tenant_id=_TENANT,
                    run_id="run-fixture-1",
                    sandbox=False,
                ),
                id=f"interpreter-fixture-{uuid.uuid4()}",
                task_queue=tq,
            )
            result = await handle.result()
            print(f"status={result.status} stages={len(result.stages)}")
            history = await handle.fetch_history()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(history.to_json())
    print(f"wrote {out_path}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--no-stream"]
    stream_era = "--no-stream" not in sys.argv[1:]
    default = "interpreter_stream_v1_history" if stream_era else "interpreter_v1_history"
    target = (
        Path(args[0])
        if args
        else Path(f"apps/harness/src/harness/tests/unit/temporal/fixtures/{default}.json")
    )
    asyncio.run(capture(target, stream=stream_era))
