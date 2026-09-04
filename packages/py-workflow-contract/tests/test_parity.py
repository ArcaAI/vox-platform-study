"""Python <-> TypeScript parity for the compiledConfig contract (b).

This is the artifact that stops the fourth twin-drift ( The
normative machine artifact is
``packages/workflow-contract/schemas/compiled-config.schema.json``;
the TypeScript producer is ``packages/workflow-contract/src/compiler.ts``. This
package is the CONSUMER half in Python. Three independent things are asserted here:

1. **Field-set parity** — every model's property names, required set and
   ``additionalProperties: false`` posture must agree with the normative schema,
   definition for definition. Adding a field to ONE side fails this test. That is
   the whole point; if it is ever skipped, the format has three implementations
   again (contracts/README.md ).
2. **Shared-example round trip** — the SAME bytes the TypeScript test asserts
   (``packages/workflow-contract/src/__tests__/fixtures/example-compiled-config.json``,
   kept honest on the TS side by ``example-fixture-parity.test.ts``), not a
   hand-typed near-copy.
3. **Checksum byte-compatibility** — ``verify_checksum`` recomputes the sha256 the
   TypeScript ``compile()`` wrote into that fixture. A canonicalizer that is
   "structurally reviewed" but never checked against real TS output is exactly the
   gap ``apps/harness/.../interpreter/compiled_config.py`` names in its own
   docstring; this test closes it with a real, TS-produced digest.

Plus the two normative consumer rules that are behaviour, not shape: an unknown
``formatVersion`` is REFUSED (never best-effort parsed), and ``onTimeout`` may
never be the literal ``APPROVED``.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from pydantic import BaseModel, ValidationError

import hope_workflow_contract
from hope_workflow_contract import (
    COMPILED_CONFIG_FORMAT_VERSION,
    CompiledBranchGuard,
    CompiledCaps,
    CompiledDocumentTemplateRef,
    CompiledGate,
    CompiledInputBinding,
    CompiledLoop,
    CompiledLoopBody,
    CompiledNode,
    CompiledPolicyBindings,
    CompiledPromptTemplateRef,
    CompiledRetryPolicy,
    CompiledStage,
    CompiledWorkflowConfig,
    UnsupportedFormatVersionError,
    canonical_json,
    verify_checksum,
)

PACKAGE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_DIR.parents[1]
SCHEMA_PATH = (
    REPO_ROOT / "packages" / "workflow-contract" / "schemas" / "compiled-config.schema.json"
)
FIXTURE_PATH = (
    REPO_ROOT
    / "packages"
    / "workflow-contract"
    / "src"
    / "__tests__"
    / "fixtures"
    / "example-compiled-config.json"
)

SCHEMA: dict[str, Any] = json.loads(SCHEMA_PATH.read_text())
FIXTURE: dict[str, Any] = json.loads(FIXTURE_PATH.read_text())

#: The digest the TypeScript compiler actually produced for the shared fixture.
#: Pinned as a literal so a canonicalizer regression cannot be masked by
#: recomputing both sides of the comparison with the same broken function.
TS_PRODUCED_CHECKSUM = "dc3e088adff522cfdbac86379df35e1ac41cb79f23e1030c2d1971f5e61bb688"


# ---------------------------------------------------------------------------
# Worktree hazard: this package is editable-installed in the shared conda env
# (`arcaenv`), so an agent running in a git worktree can silently exercise the
# MAIN checkout's copy instead of the one it just edited. Fail loudly instead.
# ---------------------------------------------------------------------------


def test_the_module_under_test_is_the_one_next_to_this_test() -> None:
    module_file = hope_workflow_contract.__file__
    assert module_file is not None, (
        "hope_workflow_contract resolved as a namespace package (no __file__) — a stale "
        "editable-install .pth is shadowing the real package"
    )
    assert Path(module_file).resolve().is_relative_to(PACKAGE_DIR / "src"), (
        f"imported hope_workflow_contract from {module_file}, "
        f"expected it under {PACKAGE_DIR / 'src'}"
    )


# ---------------------------------------------------------------------------
# 1. Field-set parity against the normative JSON Schema
# ---------------------------------------------------------------------------

PROMPT_TEMPLATE_REF_SCHEMA = SCHEMA["$defs"]["policyBindings"]["properties"]["promptTemplateRefs"][
    "items"
]
# — the document-shape binding, structurally identical to the prompt
#: ref but a DIFFERENT pin: `promptTemplateRefs` pins WHAT the model is told,
#: `documentTemplateRefs` pins WHAT SHAPE it is decoded into.
DOCUMENT_TEMPLATE_REF_SCHEMA = SCHEMA["$defs"]["policyBindings"]["properties"][
    "documentTemplateRefs"
]["items"]

#: (label, pydantic model, normative schema node). Every object in the normative
#: schema appears exactly once — a new `$defs` entry with no model here is itself
#: a parity failure, asserted by `test_every_normative_definition_has_a_model`.
PAIRS: list[tuple[str, type[BaseModel], dict[str, Any]]] = [
    ("<root>", CompiledWorkflowConfig, SCHEMA),
    ("stage", CompiledStage, SCHEMA["$defs"]["stage"]),
    ("node", CompiledNode, SCHEMA["$defs"]["node"]),
    ("retryPolicy", CompiledRetryPolicy, SCHEMA["$defs"]["retryPolicy"]),
    ("inputBinding", CompiledInputBinding, SCHEMA["$defs"]["inputBinding"]),
    ("gate", CompiledGate, SCHEMA["$defs"]["gate"]),
    ("policyBindings", CompiledPolicyBindings, SCHEMA["$defs"]["policyBindings"]),
    ("caps", CompiledCaps, SCHEMA["$defs"]["caps"]),
    ("promptTemplateRef", CompiledPromptTemplateRef, PROMPT_TEMPLATE_REF_SCHEMA),
    ("documentTemplateRef", CompiledDocumentTemplateRef, DOCUMENT_TEMPLATE_REF_SCHEMA),
    # TASK-864 — branch guards and loop bodies (both OPTIONAL on the artifact; omitted when empty).
    ("branchGuard", CompiledBranchGuard, SCHEMA["$defs"]["branchGuard"]),
    ("loopBody", CompiledLoopBody, SCHEMA["$defs"]["loopBody"]),
    ("loop", CompiledLoop, SCHEMA["$defs"]["loop"]),
]


def test_the_normative_schema_is_a_valid_draft_2020_12_document() -> None:
    Draft202012Validator.check_schema(SCHEMA)


@pytest.mark.parametrize(("label", "model", "node"), PAIRS, ids=[p[0] for p in PAIRS])
def test_property_names_match_the_normative_schema(
    label: str, model: type[BaseModel], node: dict[str, Any]
) -> None:
    """A field present on one side and missing on the other fails HERE."""
    generated = model.model_json_schema()
    assert set(generated["properties"]) == set(node["properties"]), label


@pytest.mark.parametrize(("label", "model", "node"), PAIRS, ids=[p[0] for p in PAIRS])
def test_required_fields_match_the_normative_schema(
    label: str, model: type[BaseModel], node: dict[str, Any]
) -> None:
    generated = model.model_json_schema()
    assert set(generated.get("required", [])) == set(node.get("required", [])), label


@pytest.mark.parametrize(("label", "model", "node"), PAIRS, ids=[p[0] for p in PAIRS])
def test_both_sides_forbid_unknown_properties(
    label: str, model: type[BaseModel], node: dict[str, Any]
) -> None:
    """`additionalProperties: false` throughout — an unknown key is a rejected
    document, not a tolerated one."""
    generated = model.model_json_schema()
    assert generated.get("additionalProperties") is False, f"{label} (pydantic side)"
    assert node.get("additionalProperties") is False, f"{label} (normative side)"


def test_every_normative_definition_has_a_model() -> None:
    """Guards the PAIRS table itself: a new `$defs` entry must be mirrored."""
    assert set(SCHEMA["$defs"]) == {
        "stage",
        "node",
        "retryPolicy",
        "inputBinding",
        "gate",
        "policyBindings",
        "caps",
        # TASK-864
        "branchGuard",
        "loopBody",
        "loop",
    }


def _allowed_values(node: dict[str, Any]) -> set[Any]:
    """Read a closed value set written either as `enum` or as a single `const`."""
    if "enum" in node:
        return set(node["enum"])
    return {node["const"]}


@pytest.mark.parametrize(
    ("label", "model", "node", "field"),
    [
        ("<root>", CompiledWorkflowConfig, SCHEMA, "formatVersion"),
        ("node", CompiledNode, SCHEMA["$defs"]["node"], "onError"),
        ("node", CompiledNode, SCHEMA["$defs"]["node"], "emitsTrajectory"),
        (
            "policyBindings",
            CompiledPolicyBindings,
            SCHEMA["$defs"]["policyBindings"],
            "guardrailProfile",
        ),
    ],
    ids=["formatVersion", "onError", "emitsTrajectory", "guardrailProfile"],
)
def test_closed_value_sets_match_the_normative_schema(
    label: str, model: type[BaseModel], node: dict[str, Any], field: str
) -> None:
    generated = model.model_json_schema()["properties"][field]
    assert _allowed_values(generated) == _allowed_values(node["properties"][field]), (
        f"{label}.{field}"
    )


def test_the_format_version_constant_agrees_with_the_schema() -> None:
    assert COMPILED_CONFIG_FORMAT_VERSION == SCHEMA["properties"]["formatVersion"]["const"]


# ---------------------------------------------------------------------------
# 2. The shared worked example — the SAME bytes the TypeScript test asserts
# ---------------------------------------------------------------------------


def test_the_shared_fixture_validates_against_the_normative_schema() -> None:
    """Independent ground truth: jsonschema, not this package, judges the fixture."""
    Draft202012Validator(SCHEMA).validate(FIXTURE)


def test_the_shared_fixture_round_trips_without_mutating_a_single_value() -> None:
    """Parse -> dump must be the identity on the wire document.

    This is stricter than "it parses", and deliberately so: a `float` where the
    schema says `number`, or a `datetime` where it says a date-time STRING, both
    survive parsing and then silently change the bytes the checksum is computed
    over (`1` -> `1.0`, `...T00:00:00.000Z` -> `...T00:00:00Z`).
    """
    parsed = CompiledWorkflowConfig.model_validate(FIXTURE)
    assert parsed.model_dump(mode="json", by_alias=True) == FIXTURE


def test_a_document_with_an_unknown_key_is_rejected() -> None:
    document = copy.deepcopy(FIXTURE)
    document["surpriseField"] = 1
    with pytest.raises(ValidationError):
        CompiledWorkflowConfig.model_validate(document)


# ---------------------------------------------------------------------------
# 3. Checksum — byte-compatible with the TypeScript producer
# ---------------------------------------------------------------------------


def test_verify_checksum_accepts_the_real_typescript_produced_fixture() -> None:
    assert FIXTURE["checksum"] == TS_PRODUCED_CHECKSUM
    assert verify_checksum(FIXTURE) is True


def test_verify_checksum_accepts_a_parsed_model_too() -> None:
    assert verify_checksum(CompiledWorkflowConfig.model_validate(FIXTURE)) is True


def _mutate_slug(document: dict[str, Any]) -> None:
    document["slug"] = "summarization-tampered"


def _mutate_node_timeout(document: dict[str, Any]) -> None:
    document["stages"][1]["nodes"][0]["timeoutSeconds"] = 599


def _mutate_gate_on_timeout(document: dict[str, Any]) -> None:
    document["gates"][0]["onTimeout"] = "ESCALATED"


def _mutate_cap(document: dict[str, Any]) -> None:
    document["caps"]["maxAttempts"] = 6


def _mutate_nested_config(document: dict[str, Any]) -> None:
    document["stages"][1]["nodes"][0]["config"]["onError"] = "degrade"


def _reorder_stages(document: dict[str, Any]) -> None:
    # Array order is authored intent, not a formatting accident: reordering MUST
    # break the digest (canonical-json.ts sorts keys, never arrays).
    document["stages"].reverse()


def _drop_a_field(document: dict[str, Any]) -> None:
    del document["ruleSetVersion"]


@pytest.mark.parametrize(
    "mutate",
    [
        _mutate_slug,
        _mutate_node_timeout,
        _mutate_gate_on_timeout,
        _mutate_cap,
        _mutate_nested_config,
        _reorder_stages,
        _drop_a_field,
    ],
    ids=[
        "slug",
        "node-timeout",
        "gate-onTimeout",
        "caps",
        "nested-config",
        "reordered-stages",
        "dropped-field",
    ],
)
def test_verify_checksum_rejects_a_mutated_document(mutate: Any) -> None:
    document = copy.deepcopy(FIXTURE)
    mutate(document)
    assert verify_checksum(document) is False


def test_verify_checksum_rejects_a_document_with_no_checksum() -> None:
    document = copy.deepcopy(FIXTURE)
    del document["checksum"]
    assert verify_checksum(document) is False


def test_canonical_json_sorts_keys_and_preserves_array_order() -> None:
    assert canonical_json({"b": 1, "a": 2}) == '{"a":2,"b":1}'
    assert canonical_json([3, 1, 2]) == "[3,1,2]"
    assert canonical_json({"a": [{"z": 1, "y": [2, 1]}]}) == '{"a":[{"y":[2,1],"z":1}]}'


def test_canonical_json_matches_javascript_json_stringify_on_primitives() -> None:
    assert canonical_json(None) == "null"
    assert canonical_json(True) == "true"
    assert canonical_json(1) == "1"
    assert canonical_json(1.5) == "1.5"
    assert canonical_json('a"b\n') == '"a\\"b\\n"'
    # JSON.stringify does NOT escape non-ASCII; ensure_ascii=True would produce
    # different bytes and therefore a different sha256.
    assert canonical_json("é") == '"é"'


# ---------------------------------------------------------------------------
# Normative consumer rules that are behaviour, not shape
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_version", [0, 2, 99, -1])
def test_an_unknown_format_version_is_refused(bad_version: int) -> None:
    """Normative rule 3: REFUSE, never best-effort parse."""
    document = copy.deepcopy(FIXTURE)
    document["formatVersion"] = bad_version
    with pytest.raises(UnsupportedFormatVersionError):
        CompiledWorkflowConfig.model_validate(document)


def test_the_format_version_error_reports_the_version_it_saw() -> None:
    document = copy.deepcopy(FIXTURE)
    document["formatVersion"] = 2
    with pytest.raises(UnsupportedFormatVersionError) as excinfo:
        CompiledWorkflowConfig.model_validate(document)
    assert excinfo.value.format_version == 2
    assert "2" in str(excinfo.value)


def test_a_gate_may_never_time_out_into_approval() -> None:
    """Normative rule 2 / INV-001, INV-147, INV-181 — the mechanical tripwire.

    The schema's `not: {const: "APPROVED"}` is exactly this and no more; a human
    must still confirm the gate-type enum grows no synonym (`AUTO_APPROVE`, ...).
    """
    document = copy.deepcopy(FIXTURE)
    document["gates"][0]["onTimeout"] = "APPROVED"
    with pytest.raises(ValidationError):
        CompiledWorkflowConfig.model_validate(document)


def _property_names(node: Any) -> set[str]:
    """Every property NAME anywhere in a JSON Schema document.

    Names only — the normative schema's prose deliberately says "No activity here
    writes SIGNED", so a substring search over the whole document would match the
    very sentence that promises the field does not exist.
    """
    names: set[str] = set()
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "properties" and isinstance(value, dict):
                names |= set(value)
            names |= _property_names(value)
    elif isinstance(node, list):
        for item in node:
            names |= _property_names(item)
    return names


def test_there_is_no_signed_field_anywhere_in_the_contract() -> None:
    """Normative rule 1: no node type can write SIGNED — the format has no such
    field, so approval cannot be expressed inside the substrate at all."""
    for label, names in (
        ("normative schema", _property_names(SCHEMA)),
        ("pydantic models", _property_names(CompiledWorkflowConfig.model_json_schema())),
    ):
        offenders = {name for name in names if "sign" in name.lower()}
        assert offenders == set(), f"{label}: {offenders}"
