"""The WorkflowInterpreter package (TASK-718).

Executes a published WorkflowDefinition version's compiledConfig by walking its
stages and routing each node to an already-sanctioned Temporal activity. See
docs/implementation/TASK-718-Workflow-Interpreter/contracts/execution-semantics.md
for the full contract.

Deliberately NO eager re-exports here (unlike a typical barrel `__init__.py`):
Temporal's workflow sandbox loads `harness.temporal.interpreter.workflow` by first
running THIS file as the parent package's `__init__`, and that happens OUTSIDE any
`workflow.unsafe.imports_passed_through()` block. An eager `from
harness.temporal.interpreter.activities import ...` here would pull `httpx` (via
`harness.core.config`) into the sandboxed workflow module's own unprotected import
path and trip the sandbox's `urllib.request.Request` restriction at worker-registration
time — mirrors `harness.temporal.__init__`'s own trivial-docstring-only pattern for the
identical reason. Import the concrete submodules directly:
`harness.temporal.interpreter.workflow` (`WorkflowInterpreter`, `interpreter_workflow_id`),
`harness.temporal.interpreter.activities` (`INTERPRETER_ACTIVITIES`).
"""

from __future__ import annotations
