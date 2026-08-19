"""Platform caps for the interpreter — a defense-in-depth re-clamp, not the primary enforcement.

Per-node ``timeoutSeconds``/``retry`` on ``compiledConfig`` are ALREADY clamped to platform
ceilings at compile time by the TypeScript compiler (``packages/workflow-contract/src/compiler.ts``
— see ``docs/implementation/TASK-716-Workflow-Compiler-Validator/contracts/README.md``, normative
rule "Platform ceilings materialized at compile time ... applied HERE, not read again at
runtime"). This module is a SECOND, independent, tighten-only clamp the interpreter applies to
whatever the compiled config claims — the same "independent defence" posture as
``worker.py``'s ``_assert_claim_check_store_is_deployable``. No ``GlobalSetting`` (or any other
I/O) is read here: every value is a module constant, so this module is safe to import and call
from the deterministic workflow body.

See docs/implementation/TASK-718-Workflow-Interpreter/contracts/execution-semantics.md §7 for the
rationale behind each concrete value.
"""

from __future__ import annotations

# Per-node ceilings.
MAX_NODE_TIMEOUT_SECONDS = 900
MAX_NODE_ATTEMPTS = 5

# Whole-run / whole-config ceilings.
MAX_TOTAL_SECONDS = 3600
MAX_STAGES = 50
MAX_NODES_PER_STAGE = 32
# Deliberately tighter than MAX_STAGES * MAX_NODES_PER_STAGE (1,600) so this is an
# independent bound, not a restatement of the other two.
MAX_TOTAL_NODES = 500
# HITL gates per run (TASK-731 Phase B). One durable human wait, matching the validator's own
# SINGLE_ENTRY rule on the gate node type; a second gate would need a second child workflow id
# and a second approve route, neither of which exists.
MAX_GATES = 1


def clamp_timeout(requested_seconds: int) -> int:
    """Tighten-only: a tenant may request less than the platform ceiling, never more."""
    return min(requested_seconds, MAX_NODE_TIMEOUT_SECONDS)


def clamp_attempts(requested_attempts: int) -> int:
    """Tighten-only: a tenant may request fewer attempts than the platform ceiling, never more."""
    return min(requested_attempts, MAX_NODE_ATTEMPTS)
