"""TASK-947 §4.1 — prompt COMPOSITION's CROSS-LANGUAGE parity guard (Python half).

``tests/contracts/prompt-composition.fixture.json`` is composed here AND by
``tests/contracts/prompt-composition-parity.contract.test.ts``. The two composers are
hand-written mirrors — ``composePrompt`` (``@arcaai/workflow-contract``) serves the invocation
route, the draft bench and the realtime ``core.agent`` lane; ``compose_prompt`` serves the
durable Temporal lane — so this file is the only thing that proves a fragment selected on one
lane is selected on the other, and that the two prompts come out byte-identical.

``excluded`` entries are compared on ``key`` + ``reason`` ONLY: ``detail`` is the evaluator's
own message and is deliberately not pinned across languages (the fixture says so too).

The suite also asserts the fixture is NOT VACUOUS — an emptied fixture would leave both loaders
green while proving nothing — carrying the SAME required case names the TypeScript loader does,
so dropping a case fails BOTH suites.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from harness.temporal.interpreter.prompt_composition import (
    PROMPT_COMPOSITION_JOIN,
    PromptCompositionEmpty,
    compose_prompt,
    static_projection,
)

_FIXTURE_PATH = (
    Path(__file__).resolve().parents[8] / "tests" / "contracts" / "prompt-composition.fixture.json"
)

# §4.1's minimum case list, by name — the same tuple `prompt-composition-parity.contract.test.ts`
# carries as `REQUIRED_CASE_NAMES`.
_REQUIRED_CASE_NAMES = (
    "null-prompt",
    "single-template-unchanged",
    "inline-unchanged",
    "base-only",
    "condition-true",
    "condition-false",
    "condition-error-excluded",
    "has-guard",
    "order-preserved",
    "per-fragment-render-no-cross-boundary",
    "inline-and-template-mixed",
    "bound-name-is-string",
    "input-root",
    "join-missing-defaults",
    "empty-raises",
)


def _load() -> dict[str, Any]:
    with _FIXTURE_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


_FIXTURE = _load()
_CASES: list[dict[str, Any]] = _FIXTURE["cases"]


def test_fixture_is_not_vacuous() -> None:
    names = [case["name"] for case in _CASES]
    assert len(set(names)) == len(names)
    for required in _REQUIRED_CASE_NAMES:
        assert required in names, f"fixture lost the `{required}` case"
    reasons = {
        exclusion["reason"]
        for case in _CASES
        for exclusion in case.get("expected", {}).get("excluded", [])
    }
    assert reasons == {"condition_false", "condition_error"}
    assert sum(1 for case in _CASES if isinstance(case.get("error"), str)) >= 1


def test_every_case_declares_exactly_one_outcome() -> None:
    for case in _CASES:
        assert ("expected" in case) ^ isinstance(case.get("error"), str), case["name"]


@pytest.mark.parametrize("case", _CASES, ids=[case["name"] for case in _CASES])
def test_compose_prompt_matches_the_fixture(case: dict[str, Any]) -> None:
    # The scope is cloned per case: a composer that mutated it would leak into the next case.
    scope = copy.deepcopy(case["scope"])
    template_ref = f"fixture:{case['name']}"

    if "expected" in case:
        result = compose_prompt(case["resolvedPrompt"], scope, template_ref=template_ref)
        assert result.prompt == case["expected"]["prompt"]
        assert result.selected == case["expected"]["selected"]
        assert [
            {"key": exclusion.key, "reason": exclusion.reason} for exclusion in result.excluded
        ] == case["expected"]["excluded"]
        # The scope is READ, never written.
        assert scope == case["scope"]
        return

    assert case["error"] == "PromptCompositionEmpty"
    with pytest.raises(PromptCompositionEmpty):
        compose_prompt(case["resolvedPrompt"], scope, template_ref=template_ref)


def test_the_empty_composition_error_names_the_ref_and_the_exclusions() -> None:
    """OD-6's defensive path: publish enforced a base fragment, so this is unreachable in
    production — which is exactly why it must fail by NAME rather than render an empty prompt."""
    resolved = {
        "source": "composite",
        "content": "",
        "join": PROMPT_COMPOSITION_JOIN,
        "fragments": [
            {"key": "only", "source": "inline", "content": "X", "when": "context.age > 99"}
        ],
    }

    with pytest.raises(PromptCompositionEmpty) as excinfo:
        compose_prompt(resolved, {"context": {"age": 12}}, template_ref="agent:writer")

    assert excinfo.value.template_ref == "agent:writer"
    assert [(x.key, x.reason) for x in excinfo.value.excluded] == [("only", "condition_false")]


def test_static_projection_is_the_unconditional_fragments_joined() -> None:
    """OD-3 — what publish stamps as `content`, so a reader that predates fragments renders the
    base prompt rather than no prompt at all."""
    fragments = [
        {"key": "base", "source": "inline", "content": "Base.", "when": None},
        {"key": "revisit", "source": "inline", "content": "Revisit.", "when": "vars.revisit"},
        {"key": "closing", "source": "inline", "content": "Close.", "when": None},
    ]

    assert static_projection(fragments) == "Base.\n\nClose."
    assert static_projection(fragments, join=" ") == "Base. Close."
    assert static_projection([]) == ""
