"""TASK-890 §3.14 — guardrail opt-out precedence, cross-language parity (Python half).

``tests/contracts/guardrail-optout.fixture.json`` is folded here AND by
``tests/contracts/guardrail-optout-parity.contract.test.ts``. The gateway folds the decision for
the realtime ``core.agent`` lane and for the publish-time ``GUARDRAIL_OPTED_OUT`` finding; this
half folds it for the durable lane. Both execute the SAME node, so a divergence means one lane
screens a call the other does not — a safety difference no suite outside this fixture would see.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from harness.temporal.interpreter.guardrail_optout import (
    GUARDRAIL_DECISION_SOURCES,
    guardrail_opt_out_of,
    resolve_guardrail_decision,
)

_FIXTURE_PATH = (
    Path(__file__).resolve().parents[8] / "tests" / "contracts" / "guardrail-optout.fixture.json"
)


def _load() -> dict:
    with _FIXTURE_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


_CASES = _load()["cases"]


def test_fixture_is_not_vacuous() -> None:
    assert len(_CASES) == 8
    names = [case["name"] for case in _CASES]
    assert len(set(names)) == 8
    inputs = {json.dumps(case["input"], sort_keys=True) for case in _CASES}
    assert len(inputs) == 8
    assert {case["expected"]["enabled"] for case in _CASES} == {True, False}
    assert {case["expected"]["source"] for case in _CASES} == set(GUARDRAIL_DECISION_SOURCES)


@pytest.mark.parametrize("case", _CASES, ids=[case["name"] for case in _CASES])
def test_resolve_matches_the_fixture(case: dict) -> None:
    decision = resolve_guardrail_decision(
        node=case["input"]["node"],
        workflow=case["input"]["workflow"],
        agent=case["input"]["agent"],
    )
    assert {"enabled": decision.enabled, "source": decision.source} == case["expected"]


def test_a_non_boolean_is_no_opinion_never_an_opt_out() -> None:
    """A malformed value must never read as `false`. Publish refuses one (the node schema); a
    runtime that saw one anyway screens the call."""
    decision = resolve_guardrail_decision(node="no", workflow=None, agent=True)
    assert (decision.enabled, decision.source) == (True, "agent")


def test_reads_the_opinion_off_an_authored_node_config() -> None:
    assert guardrail_opt_out_of({"guardrail": {"enabled": False}}) is False
    assert guardrail_opt_out_of({"guardrail": {}}) is None
    assert guardrail_opt_out_of({"agentRef": {"slug": "summarizer"}}) is None
    assert guardrail_opt_out_of(None) is None
    assert guardrail_opt_out_of({"guardrail": {"enabled": "no"}}) is None
