"""TASK-995 — the LLM call budget must nest inside its Temporal activity budget.

The defect this pins (measured on the dev cluster, 2026-09-21): `generate` ran
under `_ACTIVITY_TIMEOUT` (150s) while the inner per-call LLM bound
(`HARNESS_LLM_REQUEST_TIMEOUT_S`) defaulted to 120s. Raising only the inner
value to 300s — the obvious reading of "make the timeout 5 minutes" — inverts
the nesting: Temporal cancels the activity at 150s BEFORE the inner timeout can
fire, so `LlmCallTimeout` (a terminal, deliberately non-reissued error) is
replaced by `ActivityTaskTimedOut`, which `_GENERATE_RETRY` then retries. On a
GPU box already at 67-80% utilisation that doubles the load and still returns no
summary.

So the budget is an ORDERING invariant, not two independent numbers:

    inner per-call LLM timeout  <  activity start_to_close  <  hope-text ceiling

`generate` therefore gets its OWN start-to-close rather than the shared
`_ACTIVITY_TIMEOUT`, exactly as the inferential pass already does — raising the
shared constant would loosen the budget for the ~15 other activities that use
it, which is a different decision with a different blast radius.
"""

from __future__ import annotations

from datetime import timedelta

from harness.core.llm_concurrency import get_llm_governor_config
from harness.temporal import workflows


def test_generate_has_its_own_start_to_close_budget() -> None:
    """`generate` must not share the generic activity budget."""
    assert hasattr(workflows, "_GENERATE_TIMEOUT"), (
        "`generate` needs its own start-to-close constant; sharing "
        "`_ACTIVITY_TIMEOUT` couples it to ~15 unrelated activities."
    )
    assert workflows._GENERATE_TIMEOUT != workflows._ACTIVITY_TIMEOUT


def test_llm_per_call_timeout_nests_inside_the_generate_activity() -> None:
    """The inner LLM bound must fire BEFORE Temporal cancels the activity.

    If this inverts, a slow generation surfaces as a retried
    `ActivityTaskTimedOut` instead of a single terminal `LlmCallTimeout`.
    """
    per_call_s = get_llm_governor_config().request_timeout_s
    assert per_call_s > 0, "an unbounded per-call timeout cannot nest inside anything"

    activity_s = workflows._GENERATE_TIMEOUT.total_seconds()
    assert per_call_s < activity_s, (
        f"per-call LLM timeout ({per_call_s}s) must be strictly less than the "
        f"`generate` start-to-close ({activity_s}s), or Temporal cancels and "
        f"retries the activity before the inner bound can fail it terminally."
    )


def test_generate_budget_admits_a_five_minute_llm_call() -> None:
    """Owner directive 2026-09-21: the LLM gets a 5-minute per-call budget.

    Measured latencies that motivated it (hope-text `generation.audit`, ~12k
    prompt tokens): 70.9s -> 102.9s -> 195.7s -> 179.3s, climbing under GPU
    contention. A 120s bound discarded every completed generation past 03:28.
    """
    assert workflows._GENERATE_TIMEOUT >= timedelta(seconds=300), (
        "the activity budget must leave room for a full 5-minute LLM call"
    )


def test_generate_activity_is_invoked_with_its_own_timeout() -> None:
    """Guard the WIRING, not just the constant — an unused constant fixes nothing."""
    import inspect
    import re

    source = inspect.getsource(workflows)

    # Anchor on the execute_activity call whose FIRST positional argument is the
    # bare `generate` activity, then read the start_to_close that call passes.
    # Anchoring on `execute_activity(` (rather than the bare name) is what keeps
    # this off the other activities whose names merely contain "generate".
    call = re.search(
        r"execute_activity\(\s*\n\s*generate,\n(?P<body>.*?^\s{12,16}\)\n)",
        source,
        re.DOTALL | re.MULTILINE,
    )
    assert call is not None, "could not locate the `generate` activity call site"

    timeouts = re.findall(r"start_to_close_timeout=(\w+)", call.group("body"))
    assert timeouts == ["_GENERATE_TIMEOUT"], (
        f"`generate` is wired to {timeouts}, expected exactly ['_GENERATE_TIMEOUT']"
    )
