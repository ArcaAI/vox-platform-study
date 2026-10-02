"""``schema_variable_paths`` CROSS-LANGUAGE parity guard (Python half).

``tests/contracts/schema-variable-paths.fixture.json`` is derived here AND by
``tests/contracts/schema-variable-paths-parity.contract.test.ts`` (``schemaVariablePaths`` in
``@arcaai/workflow-contract``), so the paths the console offers, the paths the gateway publish gate
accepts and the paths the harness derives cannot drift apart.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from harness.temporal.interpreter.schema_variable_paths import schema_variable_paths

_FIXTURE_PATH = (
    Path(__file__).resolve().parents[8]
    / "tests"
    / "contracts"
    / "schema-variable-paths.fixture.json"
)

with _FIXTURE_PATH.open(encoding="utf-8") as _handle:
    _CASES: list[dict[str, Any]] = json.load(_handle)["cases"]


def test_fixture_is_not_vacuous() -> None:
    names = [case["name"] for case in _CASES]
    assert len(set(names)) == len(names)
    assert {
        "sole-context-kind-collapses-under-context",
        "sole-context-kind-keeps-envelope-under-trigger",
        "inline-payload-schema",
    } <= set(names)
    entries = [entry for case in _CASES for entry in case["expected"]]
    assert {entry["phiClass"] for entry in entries} == {"PHI", "NON_PHI", None}
    assert any(entry["deprecated"] for entry in entries)
    assert any(not case["expected"] for case in _CASES)


@pytest.mark.parametrize("case", _CASES, ids=[case["name"] for case in _CASES])
def test_schema_variable_paths_matches_the_fixture(case: dict[str, Any]) -> None:
    result = schema_variable_paths(copy.deepcopy(case["definition"]), case["root"])
    assert [entry.as_dict() for entry in result] == case["expected"]


def test_root_defaults_to_context() -> None:
    definition = {"kinds": [{"key": "a", "primitive": "TEXT"}]}
    assert [entry.path for entry in schema_variable_paths(definition)] == ["context.a"]
