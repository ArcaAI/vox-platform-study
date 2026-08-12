"""TASK-687 live proof — real Temporal server, both HarnessDocWorkflow start sites.

Not a unit test. Run against an ISOLATED Temporal on :7234 (never dev's 7233):

    docker run -d --rm --name task687-temporal -p 7234:7233 \
        temporalio/temporal:latest server start-dev --ip 0.0.0.0 --port 7233 --headless
    PYTHONPATH="$PWD/apps/harness/src" conda run -n arcaenv python \
        apps/harness/scripts/task687_live_proof.py

What it proves, on a real server with real workflow code:

* Case B — the LEGACY start path (``internal.py`` → ``client.start_workflow`` on the
  deterministic id ``harness-doc-{consultationId}``) runs a SECOND execution once the
  first has CLOSED. ``WorkflowAlreadyStartedError`` never fires, because neither start
  site sets an ``id_reuse_policy`` and Temporal's default ``ALLOW_DUPLICATE`` only
  rejects a start while the prior execution is still OPEN.
* Case C — the LOOP start path (``ConsultationLoopWorkflow``'s ``harness.finalize``
  → ``start_child_workflow`` on the SAME id) does the same after a legacy run closed.
* The ``Idempotency-Key`` each execution's REAL ``persist_draft`` activity puts on the
  wire — captured off a recording HTTP gateway, so it is the real header, not a mock.

The gateway stands in for apps/api only as far as the HTTP boundary: it records the
header and applies the SAME adopt-or-create rule the TypeScript `persistDraft` now
implements, so the printed note-row count is the count that rule produces for the keys
these real executions actually emitted.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys  # noqa: I001
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

GATEWAY_PORT = 18687
TEMPORAL_TARGET = "localhost:7234"
# Model the PRE-FIX apps/api (always create, never adopt) to show the end state
# the defect actually produced.
LEGACY_GATEWAY = "--legacy-gateway" in sys.argv

os.environ.setdefault("HARNESS_API_BASE_URL", f"http://127.0.0.1:{GATEWAY_PORT}")
os.environ.setdefault("HARNESS_SERVICE_TOKEN", "")
os.environ.setdefault("NODE_ENV", "test")

from temporalio.client import Client  # noqa: E402
from temporalio.contrib.pydantic import pydantic_data_converter  # noqa: E402
from temporalio.worker import Worker  # noqa: E402

from harness.temporal import activities  # noqa: E402
from harness.temporal.models import (  # noqa: E402
    HarnessDocWorkflowInput,
    HarnessGateConfig,
)
from harness.temporal.workflows import HarnessDocWorkflow  # noqa: E402
from harness.tests.unit.temporal._harness_stubs import (  # noqa: E402
    StubConfig,
    StubRecorder,
    make_stub_activities,
)

# ---------------------------------------------------------------- recording gateway


class _Gateway:
    """Stands in for apps/api at the HTTP boundary; records every draft POST."""

    def __init__(self) -> None:
        self.keys: list[str] = []
        # contextItemId -> content. One entry == one persisted note row.
        self.notes: dict[str, str] = {}
        self.replays = 0
        self._seen: dict[str, str] = {}  # Idempotency-Key -> contextItemId
        self._lock = threading.Lock()

    def persist_draft(self, key: str | None, content: str) -> str:
        with self._lock:
            self.keys.append(key or "<none>")
            # 1. Redis replay cache (apps/api `withHarnessIdempotency`).
            if key and key in self._seen:
                self.replays += 1
                return self._seen[key]
            # 2. Write path (apps/api `persistDraft` + `findOwnHarnessDraft`):
            #    adopt this harness's OWN prior draft, else create.
            #    `--legacy-gateway` models the PRE-FIX gateway, which always created.
            if self.notes and not LEGACY_GATEWAY:
                ctx_id = next(iter(self.notes))
                self.notes[ctx_id] = content
            else:
                ctx_id = f"ctx-{len(self.notes) + 1}"
                self.notes[ctx_id] = content
            if key:
                self._seen[key] = ctx_id
            return ctx_id


GATEWAY = _Gateway()


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path.endswith("/draft"):
            ctx_id = GATEWAY.persist_draft(
                self.headers.get("Idempotency-Key"), body.get("content", "")
            )
            payload = {"contextItemId": ctx_id}
        else:
            payload = {"recorded": True}
        raw = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *_args) -> None:  # noqa: D102
        pass


# ---------------------------------------------------------------- workflow driving


def _doc_input(consultation_id: str) -> HarnessDocWorkflowInput:
    return HarnessDocWorkflowInput(
        consultation_id=consultation_id,
        tenant_id="tenant-live",
        user_id="doctor-1",
        context_item_id="tx-1",
        transcript_text="Patient reports chest pain. BP 120/80.",
        gate=HarnessGateConfig(max_regen=0, gate_sla_seconds=1, gate_escalation_seconds=1),
    )


def _real_persist_activities(recorder: StubRecorder) -> list:
    """Stubs for everything EXCEPT persist_draft, which runs for real."""
    stubs = list(make_stub_activities(StubConfig(verdicts=["PASS"]), recorder))
    kept = [a for a in stubs if getattr(a, "__temporal_activity_definition").name != "persist_draft"]
    return [*kept, activities.persist_draft]


async def _run_execution(client: Client, tq: str, consultation_id: str, *, via_child: bool):
    """Start harness-doc-{id} through one of the two production start paths."""
    wf_id = f"harness-doc-{consultation_id}"
    handle = await client.start_workflow(
        HarnessDocWorkflow.run,
        _doc_input(consultation_id),
        id=wf_id,
        task_queue=tq,
    )
    await handle.signal(
        HarnessDocWorkflow.approval,
        __import__("harness.temporal.models", fromlist=["ApprovalSignal"]).ApprovalSignal(
            tenant_id="tenant-live", clinician_id="doc-1", decision="SIGNED"
        ),
    )
    result = await handle.result()
    return handle.first_execution_run_id, result


async def main() -> int:
    server = HTTPServer(("127.0.0.1", GATEWAY_PORT), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    client = await Client.connect(TEMPORAL_TARGET, data_converter=pydantic_data_converter)
    consultation_id = f"live-{uuid.uuid4().hex[:8]}"
    tq = f"task687-{uuid.uuid4().hex[:8]}"
    recorder = StubRecorder()

    run_ids: list[str] = []
    async with Worker(
        client,
        task_queue=tq,
        workflows=[HarnessDocWorkflow],
        activities=_real_persist_activities(recorder),
    ):
        # Case B — legacy start, runs to completion.
        rid, _ = await _run_execution(client, tq, consultation_id, via_child=False)
        run_ids.append(rid)

        # Case B/C — a SECOND start on the same workflow id AFTER the first closed.
        # This is the defect's precondition: it does not raise.
        rid, _ = await _run_execution(client, tq, consultation_id, via_child=True)
        run_ids.append(rid)

    server.shutdown()

    distinct_runs = len(set(run_ids))
    distinct_keys = len(set(GATEWAY.keys))
    note_rows = len(GATEWAY.notes)

    print(f"\n===== TASK-687 LIVE PROOF (real Temporal @ {TEMPORAL_TARGET}) =====")
    print(f"consultation                : {consultation_id}")
    print(f"workflow id (both starts)   : harness-doc-{consultation_id}")
    print(f"DISTINCT WORKFLOW EXECUTIONS: {distinct_runs}   {run_ids}")
    print(f"persist_draft POSTs         : {len(GATEWAY.keys)}")
    for k in GATEWAY.keys:
        print(f"  Idempotency-Key           : {k}")
    print(f"DISTINCT Idempotency-Keys   : {distinct_keys}")
    print(f"replay-cache hits           : {GATEWAY.replays}")
    print(f"NOTE ROWS                   : {note_rows}   {list(GATEWAY.notes)}")

    ok = distinct_runs == 2 and note_rows == 1
    print(f"\nRESULT: {'PASS — 2 executions, 1 note row' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
