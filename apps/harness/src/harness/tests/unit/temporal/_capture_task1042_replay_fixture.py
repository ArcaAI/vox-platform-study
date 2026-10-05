"""TASK-1042 OD-4a — capture the FORWARD replay guard for ``task-1042-live-audio-wait``.

Records, against the CURRENTLY IMPORTED (post-change) definition, one run bound to a live STT
session (``InterpreterInput.live_audio``): the walk polls ``interpreter.load_live_audio_state``
(``live`` twice, then ``ended``) before its first stage, then runs a trigger and a
speech-to-text ``core.agent`` reading the session. Written as
``interpreter_task1042_live_audio_history.json``; a later ungated change to the wait's command
sequence then fails ``test_task1042_live_audio_replay.py`` instead of wedging an in-flight run.

The backward guard (every history recorded BEFORE this marker carries ``live_audio = None`` and
must replay without consulting it) is the existing interpreter-family fixture set in
``test_replay_compat*.py``; add this fixture's name to that set at the gate pass.

Not collected by pytest (no ``test_`` prefix), mirroring the other ``_capture_*`` scripts. The
node activity and the state activity are stubbed; activity BODIES are never replayed, so the
stubs change nothing about what the fixture proves.

Usage (from ``apps/harness``, conda env ``arcaenv``)::

    PYTHONPATH=src python -m harness.tests.unit.temporal._capture_task1042_replay_fixture \\
        src/harness/tests/unit/temporal/fixtures
"""

from __future__ import annotations

import asyncio
import sys
import uuid
from pathlib import Path
from typing import Any

from temporalio import activity
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.interpreter.models import (
    InterpreterInput,
    LiveAudioBinding,
    LiveAudioStateRequest,
    LiveAudioStateResult,
)
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal.interpreter import _task1038_harness as h

FIXTURE_NAME = "interpreter_task1042_live_audio_history"
_STATE_ACTIVITY = "interpreter.load_live_audio_state"
_SCRIPT: list[str] = []


@activity.defn(name=_STATE_ACTIVITY)
async def _load_live_audio_state(request: LiveAudioStateRequest) -> LiveAudioStateResult:
    state = _SCRIPT.pop(0) if len(_SCRIPT) > 1 else (_SCRIPT[0] if _SCRIPT else "ended")
    return LiveAudioStateResult(state=state)


def scenario() -> dict[str, Any]:
    return h.body(
        [
            {"stageIndex": 0, "nodes": [h.trigger()]},
            {
                "stageIndex": 1,
                "nodes": [h.agent("n_asr", inputs=[h.edge("n_trigger", "out", "audio")])],
            },
        ]
    )


async def capture(out_dir: Path) -> Path:
    _SCRIPT[:] = ["live", "live", "ended"]
    ref = await h._store(scenario())  # noqa: SLF001 — the shared harness's claim-check writer
    activities = [
        a
        for a in h.ACTIVITIES
        if getattr(a, "__temporal_activity_definition").name != _STATE_ACTIVITY
    ] + [_load_live_audio_state]
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"task1042-capture-{uuid.uuid4()}"
        async with Worker(env.client, task_queue=tq, workflows=h.WORKFLOWS, activities=activities):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-task1042",
                    workflow_version_id="v-task1042",
                    config_ref=ref,
                    tenant_id=h.TENANT,
                    run_id="run-task1042-live-audio",
                    payload={"audio": {"sttSessionId": "stt-task1042"}},
                    live_audio=LiveAudioBinding(sttSessionId="stt-task1042", maxWaitSeconds=600),
                ),
                id=f"interpreter-task1042-{uuid.uuid4()}",
                task_queue=tq,
            )
            result = await handle.result()
            print(f"task1042 live audio: status={result.status}")
            history = await handle.fetch_history()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{FIXTURE_NAME}.json"
    path.write_text(history.to_json())
    print(f"wrote {path}")
    return path


if __name__ == "__main__":
    target = (
        Path(sys.argv[1]) if len(sys.argv) > 1 else Path("src/harness/tests/unit/temporal/fixtures")
    )
    asyncio.run(capture(target))
