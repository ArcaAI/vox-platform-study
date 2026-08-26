"""TASK-809 OD-15 — `WorkflowInterpreter._resolve_bound_inputs`, the function the whole lane
turns on, and which had ZERO test coverage before this file.

## What changed and why it needed testing

Until OD-15 the interpreter treated an edge's ``fromPort`` as a KEY into the producing activity's
output dict — and no activity in this platform has ever emitted a key called ``"out"``, which is
what every authored graph named. So the real code path was always the ``else`` branch: thread the
WHOLE predecessor output object. That is exactly the untyped bundle the port vocabulary exists to
abolish (a bundle cannot be typed as "contains a document", so generated prose could reach the NER
node again), and removing it would have been caught by no existing test.

The socket now declares its runtime key (``NodeSpec.output_keys``), and this file pins the three
behaviours that replace the fallback:

1. a DATA socket resolves through its declared ``outputKey``;
2. a CONTROL socket (``None`` key) contributes nothing — ordering carries no payload;
3. an UNDECLARED port RAISES, naming the node and the port, instead of silently threading
   something the graph never asked for.

Hermetic: no Temporal server, no DB, no network. ``WorkflowInterpreter.__init__`` sets plain
fields, so the class can be constructed and its pure resolver exercised directly.
"""

from __future__ import annotations

import pytest
from temporalio.exceptions import ApplicationError

from harness.temporal.interpreter.compiled_config import CompiledNode
from harness.temporal.interpreter.workflow import WorkflowInterpreter


def _node(node_id: str, node_type: str, inputs: list[tuple[str, str, str]]) -> CompiledNode:
    return CompiledNode.model_validate(
        {
            "nodeId": node_id,
            "type": node_type,
            "activity": "interpreter.noop",
            "config": {},
            "timeoutSeconds": 30,
            "retry": {"maximumAttempts": 1, "initialIntervalSeconds": 1, "backoffCoefficient": 2},
            "inputs": [{"fromNodeId": f, "fromPort": fp, "toPort": tp} for (f, fp, tp) in inputs],
            "onError": "degrade",
            "emitsTrajectory": True,
        }
    )


def _interpreter(types: dict[str, str], outputs: dict[str, dict]) -> WorkflowInterpreter:
    wf = WorkflowInterpreter()
    wf._node_types.update(types)
    wf._node_outputs.update(outputs)
    return wf


class TestDataSocketsResolveThroughTheirDeclaredKey:
    def test_the_ner_node_receives_the_transcript_key_not_the_whole_output_object(self):
        wf = _interpreter(
            {"a": "consultation.captureBinding"},
            {"a": {"action": "start", "consultationId": "c1", "transcript": "the said words"}},
        )
        node = _node("b", "consultation.extractEntities", [("a", "out", "in")])
        assert wf._resolve_bound_inputs(node) == {"in": "the said words"}

    def test_entities_arrive_under_the_toPort_the_edge_named(self):
        wf = _interpreter(
            {"a": "consultation.extractEntities"},
            {"a": {"entities": [{"text": "cough"}], "count": 1, "persisted": 1}},
        )
        node = _node("b", "consultation.realtimeSummary", [("a", "out", "entities")])
        assert wf._resolve_bound_inputs(node) == {"entities": [{"text": "cough"}]}

    def test_two_sockets_off_the_same_producer_stay_distinct(self):
        # The OD-15 flow that had no legal expression before: persistDraft publishes BOTH the
        # note and the contextItemId finalizeAssurance must target.
        wf = _interpreter(
            {"p": "consultation.persistDraft"},
            {"p": {"contextItemId": "ci-1", "text": "S: cough"}},
        )
        node = _node(
            "a",
            "consultation.finalizeAssurance",
            [("p", "out", "in"), ("p", "contextItemId", "contextItemId")],
        )
        assert wf._resolve_bound_inputs(node) == {"in": "S: cough", "contextItemId": "ci-1"}

    def test_the_whole_output_object_is_NEVER_threaded(self):
        # The regression that matters: the pre-OD-15 fallback put the entire dict on the port.
        wf = _interpreter(
            {"g": "generate.text"},
            {"g": {"text": "the note", "provider": "openai", "model": "gpt"}},
        )
        node = _node("d", "guardrail.check", [("g", "out", "in")])
        bound = wf._resolve_bound_inputs(node)
        assert bound == {"in": "the note"}
        assert not isinstance(bound["in"], dict)


class TestControlSocketsCarryNoPayload:
    def test_an_ordering_edge_binds_nothing(self):
        wf = _interpreter({"s": "core.start"}, {"s": {"anything": 1}})
        node = _node("c", "consultation.consentGate", [("s", "next", "after")])
        assert wf._resolve_bound_inputs(node) == {}

    def test_the_consent_gates_own_out_socket_is_control_and_binds_nothing(self):
        # `consentGate` emits `{allowed, grantId}` but its `out` port is typed `control` — an
        # authorization signal, not data. Binding it would hand a downstream node a payload the
        # contract says does not exist.
        wf = _interpreter(
            {"c": "consultation.consentGate"}, {"c": {"allowed": True, "grantId": "g1"}}
        )
        node = _node("k", "consultation.captureBinding", [("c", "out", "after")])
        assert wf._resolve_bound_inputs(node) == {}


class TestAbsentValuesContributeNothingRatherThanFabricating:
    def test_a_predecessor_that_produced_no_output_contributes_nothing(self):
        wf = _interpreter({"a": "consultation.captureBinding"}, {})
        node = _node("b", "consultation.extractEntities", [("a", "out", "in")])
        assert wf._resolve_bound_inputs(node) == {}

    def test_a_declared_key_missing_from_THIS_run_s_output_contributes_nothing(self):
        # `captureBinding.out` is design intent: the activity does not publish a transcript yet.
        # That is a runtime data condition, not a contract violation, so the node degrades on
        # `no_bound_text` exactly as it does today rather than failing the run.
        wf = _interpreter(
            {"a": "consultation.captureBinding"}, {"a": {"action": "start", "consultationId": "c"}}
        )
        node = _node("b", "consultation.extractEntities", [("a", "out", "in")])
        assert wf._resolve_bound_inputs(node) == {}


class TestAnUnresolvableBindingRaises:
    def test_a_port_the_producer_does_not_declare_raises_and_names_node_and_port(self):
        wf = _interpreter({"a": "consultation.extractEntities"}, {"a": {"entities": []}})
        node = _node("b", "consultation.bindTerminology", [("a", "banana", "in")])
        with pytest.raises(ApplicationError) as excinfo:
            wf._resolve_bound_inputs(node)
        message = str(excinfo.value)
        assert "banana" in message
        assert "b" in message
        assert "consultation.extractEntities" in message

    def test_naming_an_INPUT_port_as_an_edge_source_raises(self):
        wf = _interpreter({"a": "consultation.extractEntities"}, {"a": {"entities": []}})
        node = _node("b", "consultation.bindTerminology", [("a", "in", "in")])
        with pytest.raises(ApplicationError):
            wf._resolve_bound_inputs(node)

    def test_an_unregistered_producer_type_raises_rather_than_threading_blind(self):
        wf = _interpreter({"a": "not.a.registered.type"}, {"a": {"text": "x"}})
        node = _node("b", "consultation.synthesize", [("a", "out", "in")])
        with pytest.raises(ApplicationError):
            wf._resolve_bound_inputs(node)

    def test_it_is_non_retryable_a_contract_violation_never_fixes_itself_on_retry(self):
        wf = _interpreter({"a": "consultation.extractEntities"}, {"a": {"entities": []}})
        node = _node("b", "consultation.bindTerminology", [("a", "banana", "in")])
        with pytest.raises(ApplicationError) as excinfo:
            wf._resolve_bound_inputs(node)
        assert excinfo.value.non_retryable is True
