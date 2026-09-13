"""Deterministic Temporal workflow-id prefixes — the SOURCE OF TRUTH for all three.

These strings are a CONTRACT, not a naming convention. The workflow id is how a run is
addressed after the fact: `api/endpoints/internal.py` and `admin.py` rebuild it to signal,
query and cancel; the gateway joins `WorkflowRun` on it; and since TASK-957 the compute meter
reads its PREFIX to decide what a worker-CPU sample was burned FOR (`compute_metering.py`).

A LEAF module on purpose — constants and nothing else, no harness imports at all. The two
interpreter prefixes previously lived in the workflow modules that build them, and the meter
runs on the ACTIVITY path: importing `interpreter.workflow` to read one string would drag the
whole interpreter graph (its activities, compiled config and the core-loop workflow, all
imported under `workflow.unsafe.imports_passed_through()`) into the worker's activity path and
into the workflow sandbox that validates it. So the definition moved down here and both sides
import it; re-spelling the strings in the meter was the alternative, and a drifted copy of an
addressing contract is how a run becomes unaddressable.

STILL SPELLED LITERALLY, and not converged by the ticket that created this module (each is in
another lane's file): `temporal/workflows.py` and `api/endpoints/internal.py` both build
`f"harness-doc-{consultation_id}"` by hand.
"""

from __future__ import annotations

#: `WorkflowInterpreter` runs — one per `WorkflowRun` row (`interpreter/workflow.py`).
INTERPRETER_WORKFLOW_ID_PREFIX = "workflow-interpreter-"

#: Child core-loop workflows of an interpreter run (`interpreter/core_loop_workflow.py`).
#: Its CPU belongs to the same `WorkflowRun` as its parent's.
CORE_LOOP_WORKFLOW_ID_PREFIX = "core-loop-"

#: The clinical documentation workflow, one per consultation
#: (`api/endpoints/internal.py`, `temporal/workflows.py`, `api/endpoints/admin.py`).
DOC_WORKFLOW_ID_PREFIX = "harness-doc-"
