"""TASK-510 (Phase 2D) — harness Prometheus metrics for the ordered trajectory.

The harness had no Prometheus registry of its own (only SMR did). These are the
fleet aggregates for the ordered spine: per-step wall-clock duration (labelled by
``step_type``/``name``), the bounded-regen counter, and the gate-verdict counter.

Defined as module-level singletons on the default registry so importing this
module registers them; ``/metrics`` (mounted by ``main.py`` via
``prometheus_fastapi_instrumentator``) then exposes them with no further wiring.
The ``observe_*`` / ``inc_*`` helpers are the only write surface — the trajectory
emitter in ``temporal/activities.py`` calls them as each step is emitted.
"""

from __future__ import annotations

from prometheus_client import Counter, Histogram

# Per-step duration. Buckets span a sub-millisecond pure-compute sensor step up to
# the long inferential/generate steps (the 900s inferential start-to-close bound).
STEP_DURATION_SECONDS = Histogram(
    "harness_step_duration_seconds",
    "Per-trajectory-step wall-clock duration in seconds, by step type and name.",
    ["step_type", "name"],
    buckets=[0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 300.0, 900.0],
)

# Bounded-regen counter — incremented once per regeneration iteration (the loop's
# self-correction pressure; a healthy fleet keeps this low relative to sessions).
REGEN_TOTAL = Counter(
    "harness_regen_total",
    "Total bounded-regen iterations across harness document sessions.",
)

# Gate-verdict counter — the aggregate loop decision (PASS/REGEN/FLAG) stamped onto
# the draft. Counted exactly once per completed session (at draft persist / finalize
# / retract), so the ratio of decisions is the fleet's assurance-outcome mix.
GATE_DECISION_TOTAL = Counter(
    "harness_gate_decision_total",
    "Harness gate verdicts by decision (PASS/REGEN/FLAG).",
    ["decision"],
)


def observe_step_duration(step_type: str, name: str, seconds: float) -> None:
    """Observe one trajectory step's wall-clock duration (seconds)."""
    STEP_DURATION_SECONDS.labels(step_type=step_type, name=name).observe(max(0.0, seconds))


def inc_regen() -> None:
    """Count one bounded-regen iteration."""
    REGEN_TOTAL.inc()


def inc_gate_decision(decision: str) -> None:
    """Count one gate verdict (by normalized decision label)."""
    GATE_DECISION_TOTAL.labels(decision=decision or "UNKNOWN").inc()
