"""``compose_messages`` / ``build_prompt_scope`` CROSS-LANGUAGE parity guard (Python half).

``tests/contracts/compose-messages.fixture.json`` is composed here AND by
``tests/contracts/compose-messages-parity.contract.test.ts``. The two composers are hand-written
mirrors — ``composeMessages`` (``@arcaai/workflow-contract``) serves the gateway lanes,
``compose_messages`` the durable lane — so this file is what proves the FINAL system and user
messages come out byte-identical in both runtimes, not merely that the template grammar agrees.

``excluded`` entries are compared on ``key`` + ``reason`` only (``detail`` is the evaluator's own
message). The suite also asserts the fixture is NOT VACUOUS.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from harness.temporal.interpreter.compose_messages import (
    EXTERNAL_DATA_MARKER_REPLACEMENT,
    EXTERNAL_DATA_TRUNCATION_MARKER,
    PLATFORM_RULES_VERSION,
    ComposeDataBlockKeyError,
    ComposeOutputContractConflictError,
    compose_messages,
    output_language_step,
    platform_rules,
)
from harness.temporal.interpreter.prompt_composition import (
    PromptCompositionEmpty,
    build_prompt_scope,
)
from harness.temporal.interpreter.templating import PromptVariableUnresolved

_FIXTURE_PATH = (
    Path(__file__).resolve().parents[8] / "tests" / "contracts" / "compose-messages.fixture.json"
)


def _load() -> dict[str, Any]:
    with _FIXTURE_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


_FIXTURE = _load()
_CASES: list[dict[str, Any]] = _FIXTURE["cases"]
_SCOPE_CASES: list[dict[str, Any]] = _FIXTURE["scopeCases"]

_ERRORS: dict[str, type[Exception]] = {
    "PromptVariableUnresolved": PromptVariableUnresolved,
    "PromptCompositionEmpty": PromptCompositionEmpty,
    "ComposeDataBlockKeyError": ComposeDataBlockKeyError,
    "ComposeOutputContractConflictError": ComposeOutputContractConflictError,
}


def _scope(parts: dict[str, Any]) -> dict[str, Any]:
    return build_prompt_scope(
        variables=parts.get("variables"),
        trigger=parts.get("trigger"),
        context=parts.get("context"),
        input=parts.get("input"),
        vars=parts.get("vars"),
        nodes=parts.get("nodes"),
    )


def test_fixture_is_not_vacuous() -> None:
    names = [case["name"] for case in _CASES]
    assert len(set(names)) == len(names)
    assert len(_CASES) >= 12
    sources = {(case["input"]["resolvedPrompt"] or {}).get("source") for case in _CASES}
    assert {"template", "inline", "composite", None} <= sources
    assert any(
        block["truncated"]
        for case in _CASES
        for block in case.get("expected", {}).get("blocks", [])
    )
    assert any(len(case.get("error", {}).get("paths", [])) > 1 for case in _CASES)
    assert {
        "data-block-injected-markers-neutralised",
        "data-block-invalid-key-raises",
        "data-block-label-sanitised",
    } <= set(names)
    assert any(
        EXTERNAL_DATA_MARKER_REPLACEMENT in case.get("expected", {}).get("user", "")
        for case in _CASES
    )
    # TASK-1047 FC-1 / FC-2 — governed rendering is pinned, every piece kind is exercised.
    assert all("error" in case or "governance" in case["expected"] for case in _CASES)
    assert {
        "governed-pointer-every-placeholder",
        "governed-block-aliases",
        "governed-block-order-placeholders-then-caller",
        "governed-defaults-empty-values-and-collapsed-names",
        "governed-composite-fragment-pieces",
        "governed-output-contract-parts",
        "governed-output-contract-conflict-raises",
    } <= set(names)
    kinds = {
        piece["kind"]
        for case in _CASES
        for piece in case.get("expected", {}).get("governance", {}).get("pieces", [])
    }
    assert {"PLATFORM", "TEMPLATE_BODY", "FRAGMENT", "LANGUAGE", "CONTRACT"} <= kinds
    scope_names = {case["name"] for case in _SCOPE_CASES}
    assert {
        "trigger-only-aliases-context",
        "context-only-aliases-trigger",
        "both-kept-as-given",
    } <= scope_names


def test_platform_rules_and_language_step_match_the_fixture() -> None:
    assert platform_rules() == _FIXTURE["platformRules"]["text"]
    assert PLATFORM_RULES_VERSION == _FIXTURE["platformRules"]["version"]
    step = _FIXTURE["outputLanguageStep"]
    assert output_language_step(step["name"]) == step["text"]
    assert EXTERNAL_DATA_TRUNCATION_MARKER == "\n[…truncated]"


@pytest.mark.parametrize("case", _SCOPE_CASES, ids=[case["name"] for case in _SCOPE_CASES])
def test_build_prompt_scope_matches_the_fixture(case: dict[str, Any]) -> None:
    parts = copy.deepcopy(case["parts"])
    if "expected" in case:
        assert _scope(parts) == case["expected"]
        return
    with pytest.raises(PromptVariableUnresolved) as excinfo:
        _scope(parts)
    assert list(excinfo.value.paths) == case["error"]["paths"]


@pytest.mark.parametrize("case", _CASES, ids=[case["name"] for case in _CASES])
def test_compose_messages_matches_the_fixture(case: dict[str, Any]) -> None:
    given = copy.deepcopy(case["input"])

    def run() -> Any:
        return compose_messages(
            platform_rules=(
                platform_rules()
                if given.get("usePlatformRules")
                else given.get("platformRules", "")
            ),
            resolved_prompt=given["resolvedPrompt"],
            scope=_scope(given["scopeParts"]),
            output_language=given.get("outputLanguage"),
            output_contract=given.get("outputContract"),
            data_blocks=given.get("dataBlocks"),
            template_ref=given.get("templateRef"),
            drop_empty_blocks=given.get("dropEmptyBlocks", False),
            block_aliases=given.get("blockAliases"),
            output_contract_parts=given.get("outputContractParts"),
        )

    if "expected" in case:
        result = run()
        expected = case["expected"]
        assert result.system == expected["system"]
        assert result.user == expected["user"]
        assert result.selected == expected["selected"]
        assert [{"key": x.key, "reason": x.reason} for x in result.excluded] == expected["excluded"]
        assert [
            {"key": b.key, "chars": b.chars, "truncated": b.truncated} for b in result.blocks
        ] == expected["blocks"]
        # TASK-1047 FC-2 — pieces + digests, snake_case on this side.
        assert result.governance == {
            "pieces": expected["governance"]["pieces"],
            "composed_digest": expected["governance"]["composedDigest"],
        }
        return

    error = case["error"]
    with pytest.raises(_ERRORS[error["name"]]) as excinfo:
        run()
    if "paths" in error:
        assert list(excinfo.value.paths) == error["paths"]
    if "key" in error:
        assert excinfo.value.key == error["key"]
