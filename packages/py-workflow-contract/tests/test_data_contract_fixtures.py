"""TASK-1036 (lane B1) — the Python half of the cross-language data-contract fixtures.

The TypeScript half is ``packages/workflow-contract/src/__tests__/data-contract-fixtures.task1036
.test.ts`` (+ ``derive-variable-declarations.test.ts``). Both read the SAME files under
``tests/contracts/``, so neither runtime can drift from the other about node I/O, bindings,
settings, the consultation read schema or prompt-variable derivation.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from hope_workflow_contract.bindings import binding_issues, compiled_bindings
from hope_workflow_contract.consultation_read_schema import (
    CONSULTATION_READ_SCHEMA_V1,
    CONSULTATION_READ_SCHEMA_VERSION,
    PLATFORM_CONTEXT_ALIASES,
    consultation_read_paths,
    declared_consultation_reads,
)
from hope_workflow_contract.derive_variables import (
    PROMPT_VARIABLE_NAMESPACE_ROOTS,
    derive_variable_declarations,
)
from hope_workflow_contract.node_io import (
    IO_BASE_TYPES,
    IO_ELEMENT_TYPES,
    NODE_IO,
    agent_node_io,
    io_type_of_json_schema,
    type_fits,
)
from hope_workflow_contract.template import template_references
from hope_workflow_contract.workflow_settings import (
    WORKFLOW_CONNECTIONS,
    WORKFLOW_SOURCES,
    effective_settings,
    settings_implications,
    workflow_settings_problems,
)

CONTRACTS = Path(__file__).resolve().parents[3] / "tests" / "contracts"


def _load(name: str) -> Any:
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------------------------
# node-io.fixture.json
# ---------------------------------------------------------------------------------------------

NODE_IO_FIXTURE = _load("node-io.fixture.json")


def test_node_io_pins_the_vocabulary_and_the_eleven_declarations() -> None:
    assert NODE_IO_FIXTURE["ioBaseTypes"] == list(IO_BASE_TYPES)
    assert NODE_IO_FIXTURE["ioElementTypes"] == list(IO_ELEMENT_TYPES)
    assert NODE_IO_FIXTURE["nodeIO"] == NODE_IO
    assert len(NODE_IO_FIXTURE["nodeIO"]) == 11


@pytest.mark.parametrize(
    "entry", NODE_IO_FIXTURE["agentNodeIO"], ids=[e["name"] for e in NODE_IO_FIXTURE["agentNodeIO"]]
)
def test_agent_node_io(entry: dict[str, Any]) -> None:
    assert agent_node_io(entry["task"], entry.get("outputSchema")) == entry["expected"]


def test_type_fits_over_the_whole_matrix() -> None:
    verdicts = {entry["expected"] for entry in NODE_IO_FIXTURE["typeFits"]}
    assert verdicts == {"match", "convert", "blocked"}
    for entry in NODE_IO_FIXTURE["typeFits"]:
        got = type_fits(entry["target"], entry["source"])
        assert got == entry["expected"], f"{entry['target']} <- {entry['source']}"


def test_io_type_of_json_schema() -> None:
    for entry in NODE_IO_FIXTURE["ioTypeOfJsonSchema"]:
        assert io_type_of_json_schema(entry["schema"]) == entry["expected"], entry["schema"]


# ---------------------------------------------------------------------------------------------
# bindings.fixture.json
# ---------------------------------------------------------------------------------------------

BINDINGS_FIXTURE = _load("bindings.fixture.json")


def test_bindings_fixture_is_not_vacuous() -> None:
    codes = {i["code"] for c in BINDINGS_FIXTURE["cases"] for i in c["expected"]["issues"]}
    assert codes == {
        "BINDING_UNKNOWN_PATH",
        "BINDING_NOT_ANCESTOR",
        "BINDING_TYPE_MISMATCH",
        "BINDING_TYPE_CONVERTED",
        "BINDING_UNKNOWN_INPUT",
        "REQUIRED_INPUT_UNBOUND",
        "INPUT_MULTIPLE_PRODUCERS",
        "CONSULTATION_SCOPE_UNAVAILABLE",
        "AGENT_NOTHING_BOUND",
    }


@pytest.mark.parametrize(
    "entry", BINDINGS_FIXTURE["cases"], ids=[c["name"] for c in BINDINGS_FIXTURE["cases"]]
)
def test_binding_case(entry: dict[str, Any]) -> None:
    agents = entry.get("agents")
    assert compiled_bindings(entry["graph"], agents) == entry["expected"]["compiledBindings"]
    issues = [
        {
            "nodeId": issue.node_id,
            "code": issue.code,
            "severity": issue.severity,
            "input": issue.input,
            "path": issue.path,
        }
        for issue in binding_issues(
            entry["graph"],
            agents=agents,
            context_payload_schema=entry.get("contextPayloadSchema"),
            sources=entry.get("sources"),
        )
    ]
    assert issues == entry["expected"]["issues"]


# ---------------------------------------------------------------------------------------------
# workflow-settings.fixture.json
# ---------------------------------------------------------------------------------------------

SETTINGS_FIXTURE = _load("workflow-settings.fixture.json")


def test_settings_vocabularies() -> None:
    assert SETTINGS_FIXTURE["connections"] == list(WORKFLOW_CONNECTIONS)
    assert SETTINGS_FIXTURE["sources"] == list(WORKFLOW_SOURCES)


def test_settings_shape_validator_by_pointer() -> None:
    assert any(not e["expectedPointers"] for e in SETTINGS_FIXTURE["shape"])
    assert any(e["expectedPointers"] for e in SETTINGS_FIXTURE["shape"])
    for entry in SETTINGS_FIXTURE["shape"]:
        pointers = [p[: p.index(":")] for p in workflow_settings_problems(entry["value"])]
        assert pointers == entry["expectedPointers"], entry["value"]


@pytest.mark.parametrize(
    "entry", SETTINGS_FIXTURE["effective"], ids=[e["name"] for e in SETTINGS_FIXTURE["effective"]]
)
def test_effective_settings(entry: dict[str, Any]) -> None:
    assert effective_settings(entry["graph"]) == entry["expected"]


@pytest.mark.parametrize(
    "entry",
    SETTINGS_FIXTURE["implications"],
    ids=[e["name"] for e in SETTINGS_FIXTURE["implications"]],
)
def test_settings_implications(entry: dict[str, Any]) -> None:
    found = [
        {"ruleId": i["ruleId"], "requires": i["requires"], "nodeId": i["nodeId"]}
        for i in settings_implications(
            entry["graph"], entry["settings"], entry.get("context") or {}
        )
    ]
    assert found == entry["expected"]


# ---------------------------------------------------------------------------------------------
# consultation-read-schema.fixture.json
# ---------------------------------------------------------------------------------------------

CONSULTATION_FIXTURE = _load("consultation-read-schema.fixture.json")


def test_the_versioned_schema_paths_and_aliases() -> None:
    assert CONSULTATION_FIXTURE["version"] == CONSULTATION_READ_SCHEMA_VERSION
    assert CONSULTATION_FIXTURE["schema"] == CONSULTATION_READ_SCHEMA_V1
    assert CONSULTATION_FIXTURE["paths"] == consultation_read_paths()
    assert CONSULTATION_FIXTURE["aliases"] == PLATFORM_CONTEXT_ALIASES
    assert len(PLATFORM_CONTEXT_ALIASES) == 11


@pytest.mark.parametrize(
    "entry",
    CONSULTATION_FIXTURE["declaredReads"],
    ids=[e["name"] for e in CONSULTATION_FIXTURE["declaredReads"]],
)
def test_declared_reads(entry: dict[str, Any]) -> None:
    assert declared_consultation_reads(entry["graph"]) == entry["expected"]


# ---------------------------------------------------------------------------------------------
# derive-variables.fixture.json + the template reference reader it stands on
# ---------------------------------------------------------------------------------------------

DERIVE_FIXTURE = _load("derive-variables.fixture.json")


def test_namespace_roots() -> None:
    assert list(PROMPT_VARIABLE_NAMESPACE_ROOTS) == DERIVE_FIXTURE["namespaceRoots"]


@pytest.mark.parametrize(
    "entry", DERIVE_FIXTURE["cases"], ids=[e["name"] for e in DERIVE_FIXTURE["cases"]]
)
def test_derive_variable_declarations(entry: dict[str, Any]) -> None:
    assert derive_variable_declarations(entry["content"], entry["existing"]) == entry["expected"]


def test_derive_never_mutates_its_arguments() -> None:
    existing = [{"name": "a", "type": "string", "required": True}]
    snapshot = json.loads(json.dumps(existing))
    derive_variable_declarations("{{b}}", existing)
    assert existing == snapshot


@pytest.mark.parametrize(
    "entry",
    _load("prompt-template.fixture.json")["references"],
    ids=lambda e: e["name"],
)
def test_template_references(entry: dict[str, Any]) -> None:
    got = [
        {"path": r.path, "hasDefault": r.has_default, "offset": r.offset}
        for r in template_references(entry["template"])
    ]
    assert got == entry["expected"]
