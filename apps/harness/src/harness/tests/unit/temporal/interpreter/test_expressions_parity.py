"""TASK-864 §3.2 — the expression language's CROSS-LANGUAGE parity guard (Python half).

``packages/workflow-contract/src/__tests__/fixtures/expressions.fixture.json`` is evaluated
here AND by ``expressions.test.ts``. The two evaluators are hand-written mirrors, so this file
is the only thing that proves the interpreter routes a branch on the same answer the Studio's
publish-time check computed.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from harness.temporal.interpreter.expressions import (
    EXPRESSION_CONTEXT_ROOTS,
    evaluate_condition,
    evaluate_expression,
    expression_problems,
)

_FIXTURE_PATH = (
    Path(__file__).resolve().parents[8]
    / "packages"
    / "workflow-contract"
    / "src"
    / "__tests__"
    / "fixtures"
    / "expressions.fixture.json"
)


def _load() -> dict:
    with _FIXTURE_PATH.open(encoding="utf-8") as f:
        return json.load(f)


_FIXTURE = _load()
_CASES = _FIXTURE["cases"]


def _same(a, b) -> bool:
    """JSON-level equality: an int and a whole float are the same value (`3 == 3.0`), but a
    bool is never a number — the distinction CEL keeps and JSON loses."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b, strict=True))
    if isinstance(a, dict) and isinstance(b, dict):
        return set(a) == set(b) and all(_same(a[k], b[k]) for k in a)
    return type(a) is type(b) and a == b


class TestFixtureResolves:
    def test_fixture_file_exists(self):
        assert _FIXTURE_PATH.is_file(), f"expected fixture at {_FIXTURE_PATH}"

    def test_fixture_is_not_vacuous(self):
        assert any(case.get("error") is True for case in _CASES)
        assert any(case.get("error") is not True for case in _CASES)


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_matches_the_committed_cross_language_fixture(case: dict):
    result = evaluate_expression(case["expression"], _FIXTURE["context"])
    if case.get("error") is True:
        assert result.error is not None, f"expected an error, got {result.value!r}"
        return
    assert result.error is None, f"unexpected error: {result.error}"
    assert _same(
        result.value, case["expected"]
    ), f"{case['expression']!r}: got {result.value!r}, expected {case['expected']!r}"


class TestConditionSemantics:
    def test_taken_only_on_the_boolean_true(self):
        assert evaluate_condition("1 == 1", {}) == (True, None)
        assert evaluate_condition("1 == 2", {}) == (False, None)

    def test_a_non_boolean_result_is_not_taken_and_names_the_type(self):
        taken, error = evaluate_condition("'yes'", {})
        assert taken is False
        assert error is not None and "boolean" in error

    def test_an_evaluation_error_never_routes_a_branch(self):
        taken, error = evaluate_condition("vars.missing == 1", {"vars": {}})
        assert taken is False
        assert error is not None


class TestTotality:
    @pytest.mark.parametrize(
        "source", ["", ")", "{", "[1,", "a.", "1 ? 2", "'unterminated", "\x00"]
    )
    def test_never_raises_on_garbage(self, source: str):
        result = evaluate_expression(source, {})
        assert result.error is not None

    def test_expression_problems_idiom(self):
        assert expression_problems("trigger.department == 'x'") == []
        assert expression_problems(42) == ["expression must be a string"]
        assert expression_problems("1 +")[0].startswith("expression does not parse")

    def test_roots_are_the_three_declared(self):
        assert sorted(EXPRESSION_CONTEXT_ROOTS) == ["nodes", "trigger", "vars"]
