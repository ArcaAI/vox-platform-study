"""TASK-1036 OD-10 — nullable variables and empty-block dropping, Python half (lane B1).

Runs ``tests/contracts/compose-messages.v2.fixture.json``, the file
``packages/workflow-contract/src/__tests__/compose-messages.v2.test.ts`` runs. Both behaviours are
OPT-IN (``variable_declarations`` / ``drop_empty_blocks``); the v1 fixture keeps running unchanged
in ``test_compose_messages_parity.py``, which is the proof that the defaults keep today's bytes.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from harness.temporal.interpreter.compose_messages import (
    ComposeDataBlockKeyError,
    ComposeOutputContractConflictError,
    compose_messages,
    platform_rules,
)
from harness.temporal.interpreter.prompt_composition import (
    PromptCompositionEmpty,
    build_prompt_scope,
)
from harness.temporal.interpreter.templating import PromptVariableUnresolved

_FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[8]
        / "tests"
        / "contracts"
        / "compose-messages.v2.fixture.json"
    ).read_text(encoding="utf-8")
)
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
        template_ref=parts.get("templateRef"),
        variable_declarations=parts.get("variableDeclarations"),
    )


def test_the_v2_fixture_is_not_vacuous() -> None:
    assert len(_FIXTURE["cases"]) >= 8
    assert len(_FIXTURE["scopeCases"]) >= 6


@pytest.mark.parametrize("case", _FIXTURE["scopeCases"], ids=lambda c: c["name"])
def test_scope(case: dict[str, Any]) -> None:
    parts = copy.deepcopy(case["parts"])
    if "expected" in case:
        assert _scope(parts) == case["expected"]
        return
    with pytest.raises(_ERRORS[case["error"]["name"]]) as excinfo:
        _scope(parts)
    assert list(excinfo.value.paths) == case["error"]["paths"]  # type: ignore[attr-defined]


@pytest.mark.parametrize("case", _FIXTURE["cases"], ids=lambda c: c["name"])
def test_compose(case: dict[str, Any]) -> None:
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
        assert list(excinfo.value.paths) == error["paths"]  # type: ignore[attr-defined]
