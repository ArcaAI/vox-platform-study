"""TASK-890 §3.2 — the prompt-template grammar's CROSS-LANGUAGE parity guard (Python half).

``tests/contracts/prompt-template.fixture.json`` is rendered here AND by
``tests/contracts/prompt-template-parity.contract.test.ts``. The two renderers are hand-written
mirrors — the gateway renders the realtime ``core.agent`` lane, this one renders the durable
lane — so this file is the only thing that proves the same node's prompt comes out the same on
both. Before this ticket it demonstrably did not (§2.4 flavours 5 and 6).

The suite also asserts the fixture is NOT VACUOUS: an emptied fixture would leave both loaders
green while proving nothing.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from harness.temporal.interpreter.templating import (
    PromptTemplateSyntaxError,
    PromptVariableUnresolved,
    render_template,
    template_references,
    template_syntax_problems,
)

_FIXTURE_PATH = (
    Path(__file__).resolve().parents[8] / "tests" / "contracts" / "prompt-template.fixture.json"
)

# §3.2's minimum case list, by name. Both loaders carry it, so dropping a case fails BOTH suites.
_REQUIRED_CASE_NAMES = (
    "dotted-resolution",
    "bare-name",
    "missing-path-errors",
    "default-applied",
    "default-not-applied-when-present",
    "escape",
    "value-with-braces-not-reparsed",
    "whitespace-tolerance",
    "object-value-json-sorted",
    "array-not-indexable",
    "null-is-missing",
    "unknown-filter-is-syntax-error",
    "unterminated-is-syntax-error",
    "prototype-key-not-variable",
    "nodes-namespace",
    "single-brace-is-literal",
)


def _load() -> dict:
    with _FIXTURE_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


_FIXTURE = _load()
_CASES = _FIXTURE["cases"]
_REFERENCE_CASES = _FIXTURE["references"]


def test_fixture_is_not_vacuous() -> None:
    names = [case["name"] for case in _CASES]
    assert len(set(names)) == len(names)
    for required in _REQUIRED_CASE_NAMES:
        assert required in names, f"fixture lost the `{required}` case"
    assert sum(1 for case in _CASES if "expected" in case) >= 10
    assert sum(1 for case in _CASES if "error" in case) >= 6
    assert len(_REFERENCE_CASES) > 0


def test_every_case_declares_exactly_one_outcome() -> None:
    for case in _CASES:
        assert ("expected" in case) ^ ("error" in case), case["name"]


@pytest.mark.parametrize("case", _CASES, ids=[case["name"] for case in _CASES])
def test_render_template_matches_the_fixture(case: dict) -> None:
    if "expected" in case:
        assert render_template(case["template"], case["scope"]) == case["expected"]
        return
    expected = (
        PromptTemplateSyntaxError
        if case["error"] == "PromptTemplateSyntaxError"
        else PromptVariableUnresolved
    )
    with pytest.raises(expected):
        render_template(case["template"], case["scope"])


@pytest.mark.parametrize("case", _REFERENCE_CASES, ids=[case["name"] for case in _REFERENCE_CASES])
def test_template_references_matches_the_fixture(case: dict) -> None:
    actual = [
        {"path": ref.path, "hasDefault": ref.has_default, "offset": ref.offset}
        for ref in template_references(case["template"])
    ]
    assert actual == case["expected"]


def test_syntax_problems_agree_with_the_error_cases() -> None:
    """A `PromptTemplateSyntaxError` case must ALSO be reported by the publish-time checker —
    the two are the same judgement at two moments (authoring vs render), never two opinions."""
    for case in _CASES:
        problems = template_syntax_problems(case["template"])
        if case.get("error") == "PromptTemplateSyntaxError":
            assert problems, case["name"]
        else:
            assert problems == [], case["name"]


def test_unresolved_error_names_the_path_and_the_template_ref() -> None:
    with pytest.raises(PromptVariableUnresolved) as excinfo:
        render_template("{{context.absent}}", {"context": {}}, template_ref="tpl-1")
    assert excinfo.value.path == "context.absent"
    assert excinfo.value.template_ref == "tpl-1"
