"""TASK-1036 §9 (lane B1) — the interpreter's runtime data contract (``data_contract.py``).

Two kinds of assertion: the runtime TABLES are pinned to the shared fixtures (``node-io``,
``consultation-read-schema``) so the harness cannot drift from the contract, and the pure binding
resolver is exercised on the semantics the contract states (OD-19, OD-30, OD-32; the dual
``nodes.*`` scope; ``firstOf`` = first non-null path; ``run.now``; deferral across a claim-check
reference).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from harness.temporal.interpreter import payload_refs
from harness.temporal.interpreter.data_contract import (
    AGENT_TASK_OUTPUT_FIELDS,
    CONSULTATION_PATH_PHI,
    NODE_OUTPUT_FIELDS,
    OUTPUT_PHI_CLASS,
    BindingScope,
    binding_source,
    end_wired_fields,
    finish_deferred,
    is_deferred,
    is_missing,
    outputs_view,
    resolve_binding,
    resolve_bindings,
)

_CONTRACTS = Path(__file__).resolve().parents[8] / "tests" / "contracts"


def _fixture(name: str) -> Any:
    return json.loads((_CONTRACTS / name).read_text(encoding="utf-8"))


class TestTablesArePinnedToTheContract:
    def test_node_output_fields_match_node_io(self) -> None:
        node_io = _fixture("node-io.fixture.json")["nodeIO"]
        assert {k: tuple(v["outputs"]) for k, v in node_io.items()} == NODE_OUTPUT_FIELDS

    def test_agent_task_fields_match_agent_node_io(self) -> None:
        by_task: dict[str, set[str]] = {}
        for entry in _fixture("node-io.fixture.json")["agentNodeIO"]:
            by_task.setdefault(entry["task"], set()).update(entry["expected"]["outputs"])
        assert {t: set(f) for t, f in AGENT_TASK_OUTPUT_FIELDS.items()} == by_task

    def test_output_phi_classes_agree_with_node_io(self) -> None:
        node_io = _fixture("node-io.fixture.json")["nodeIO"]
        for spec in node_io.values():
            for name, output in spec["outputs"].items():
                if "phiClass" in output:
                    assert OUTPUT_PHI_CLASS[name] == output["phiClass"], name

    def test_consultation_phi_classes_match_the_read_schema(self) -> None:
        paths = _fixture("consultation-read-schema.fixture.json")["paths"]
        assert {p["path"]: p["phiClass"] for p in paths} == CONSULTATION_PATH_PHI


def _scope(**overrides: Any) -> BindingScope:
    base: dict[str, Any] = {
        "context": {"patient": {"age": 67}},
        "nodes": {
            "n_asr": {"transcript": "cough three days", "jobId": "j1"},
            "n_ner": {"data": {"entities": [{"text": "cough"}]}, "text": "cough three days"},
            "n_note": {"text": "S: cough", "provider": "lm", "data": None},
            "n_router": {"evaluation": {"branch": "a"}},
        },
        "node_types": {
            "n_asr": "core.agent",
            "n_ner": "core.agent",
            "n_note": "core.agent",
            "n_router": "core.condition",
        },
        "node_tasks": {"n_ner": "NAMED_ENTITY_RECOGNITION"},
        "router_inputs": {"n_router": "the routed text"},
        "vars": {"k": 1},
        "run": {"id": "run-1", "now": "2026-10-04T10:00:00+00:00"},
        "consultation": {"consultation.patient.age": 41},
    }
    base.update(overrides)
    return BindingScope(**base)


class TestTheResolver:
    @pytest.mark.parametrize(
        ("binding", "expected"),
        [
            ({"from": "nodes.n_asr.outputs.transcript"}, "cough three days"),
            ({"from": "nodes.n_asr.transcript"}, "cough three days"),  # legacy spelling
            ({"from": "nodes.n_ner.outputs.entities"}, [{"text": "cough"}]),
            ({"from": "nodes.n_router.outputs.input"}, "the routed text"),  # OD-19
            ({"from": "context.patient.age"}, 67),
            ({"from": "consultation.patient.age"}, 41),
            ({"from": "vars.k"}, 1),
            ({"from": "run.now"}, "2026-10-04T10:00:00+00:00"),
            ({"value": "en"}, "en"),
            ({"value": None}, None),
            (
                {"firstOf": ["nodes.n_note.outputs.data", "nodes.n_note.outputs.text"]},
                "S: cough",
            ),
            ({"template": "Note: {{nodes.n_note.outputs.text}}"}, "Note: S: cough"),
        ],
    )
    def test_resolves(self, binding: dict[str, Any], expected: Any) -> None:
        assert resolve_binding(binding, _scope()) == expected

    def test_consultation_is_not_read_from_anywhere_but_the_declared_reads(self) -> None:
        scope = _scope(consultation={})
        assert is_missing(resolve_binding({"from": "consultation.patient.age"}, scope))

    def test_a_container_read_serves_its_fields(self) -> None:
        scope = _scope(consultation={"consultation.patient": {"age": 5, "gender": "F"}})
        assert resolve_binding({"from": "consultation.patient.gender"}, scope) == "F"

    def test_ner_outputs_publish_entities_not_data(self) -> None:
        view = outputs_view(
            "core.agent",
            {"data": {"entities": [1]}, "text": "t", "agent": {}},
            task="NAMED_ENTITY_RECOGNITION",
        )
        assert view == {"entities": [1], "text": "t"}

    def test_a_loop_body_reads_the_current_item(self) -> None:
        scope = _scope(loop_item=("n_loop", {"name": "x"}))
        assert resolve_binding({"from": "nodes.n_loop.outputs.item.name"}, scope) == "x"

    def test_the_sole_context_kind_collapses(self) -> None:
        scope = _scope(context={"context": {"safe_age": "41"}})
        assert resolve_binding({"from": "context.safe_age"}, scope) == "41"

    def test_an_unresolved_binding_is_reported_not_invented(self) -> None:
        resolved = resolve_bindings(
            {"message": {"from": "nodes.n_missing.outputs.text"}, "language": {"value": "en"}},
            _scope(),
        )
        assert resolved.values == {"language": "en"}
        assert resolved.unresolved == ["message"]

    def test_a_template_with_a_missing_path_is_unbound(self) -> None:
        assert is_missing(resolve_binding({"template": "x {{nodes.n_x.outputs.text}}"}, _scope()))

    def test_a_path_through_a_reference_is_deferred_and_finished_by_the_activity(self) -> None:
        marker = payload_refs.make_marker({"bucket": "b", "key": "k", "sha256": "0" * 64})
        scope = _scope(nodes={"n_big": {"text": marker}}, node_types={"n_big": "core.agent"})
        deferred = resolve_binding({"template": "N: {{nodes.n_big.outputs.text}}"}, scope)
        assert is_deferred(deferred)

        def hydrate(value: Any) -> Any:
            return "the long note" if payload_refs.is_marker(value) else value

        assert finish_deferred(deferred, hydrate) == "N: the long note"

    def test_first_of_skips_a_null_before_a_reference(self) -> None:
        marker = payload_refs.make_marker({"bucket": "b", "key": "k", "sha256": "0" * 64})
        scope = _scope(
            nodes={"a": {"text": None}, "b": {"text": marker}},
            node_types={"a": "core.agent", "b": "core.agent"},
        )
        value = resolve_binding(
            {"firstOf": ["nodes.a.outputs.text", "nodes.b.outputs.text"]}, scope
        )
        assert finish_deferred(value, lambda v: "big" if payload_refs.is_marker(v) else v) == "big"

    def test_binding_sources(self) -> None:
        assert binding_source({"from": "a.b"}) == {"kind": "from", "path": "a.b"}
        assert binding_source({"firstOf": ["x", "y"]}) == {"kind": "from", "path": "x"}
        assert binding_source({"template": "t"}) == {"kind": "template", "template": "t"}
        assert binding_source({"value": 1}) == {"kind": "value"}


class TestDelivery:
    def test_end_wired_from_bindings_both_spellings(self) -> None:
        wired = end_wired_fields(
            [{"firstOf": ["nodes.n_final.outputs.data", "nodes.n_draft.text"]}], []
        )
        assert wired == {"n_final": {"data"}, "n_draft": {"text"}}

    def test_end_wired_from_legacy_edges(self) -> None:
        assert end_wired_fields(None, [("n_final", "text"), ("n_gate", None)]) == {
            "n_final": {"text"}
        }


class TestEffectiveSettings:
    """TASK-1036 §3.5 / D-4 — the compiled `settings`, else the legacy trigger `kinds` / output
    `protocols` (one release). Pinned to `workflow-settings.fixture.json`'s `effective` cases.
    Nothing in the harness GATES on them; the walk reads `sources` only."""

    @pytest.mark.parametrize(
        "entry", _fixture("workflow-settings.fixture.json")["effective"], ids=lambda e: e["name"]
    )
    def test_matches_the_contract(self, entry: dict[str, Any]) -> None:
        from harness.temporal.interpreter.data_contract import effective_settings

        graph = entry["graph"]
        nodes = [(n.get("type"), n.get("config") or {}) for n in graph.get("nodes") or []]
        settings = graph.get("settings")
        expected = entry["expected"]
        got = effective_settings(nodes, settings)
        assert got == {
            "connections": expected["connections"],
            "sources": expected["sources"],
            "origin": expected["origin"],
        }
