"""TASK-1036 (lane B1, the confirmed defect) — `overrides.promptVariables` templates are RENDERED.

A `core.agent` node's `overrides.promptVariables` value containing `{{…}}` used to be bound
LITERALLY, so `{{nodes.n_asr.transcript}}` reached the model as those characters. Under run
protocol v2 it is rendered against the run scope (`trigger`/`context`, `vars`, `nodes` with the
dual NodeIO scope, `consultation`, `run`); an unresolved path fails BY NAME. Off v2 nothing moves
(a run recorded before the marker keeps its bytes).
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core
from harness.temporal.interpreter.templating import PromptVariableUnresolved
from harness.tests.unit.temporal.interpreter.test_core_agent_templating_task890 import _resolved

_CONFIG = {
    "agentRef": {"slug": "discharge-writer"},
    "overrides": {
        "promptVariables": {
            "transcript": "{{nodes.n_asr.outputs.transcript}}",
            "legacy": "{{nodes.n_asr.transcript}}",
            "age": "{{consultation.patient.age}}",
            "run": "{{run.id}}",
            "plain": "no braces",
        }
    },
}


def _payload(protocol: int | None) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="n_note",
        node_type="core.agent",
        config=_CONFIG,
        tenant_id="t",
        run_id="run-1",
        run_context={
            "trigger": {"q": 1},
            "vars": {},
            "nodes": {"n_asr": {"transcript": "cough three days", "jobId": "j"}},
            "nodeMeta": {"n_asr": {"type": "core.agent", "task": "SPEECH_TO_TEXT"}},
        },
        protocol=protocol,
        consultation={"patient": {"age": 41}},
        run_fields={"id": "run-1"},
    )


def _scope(payload: NodeActivityInput) -> dict[str, Any]:
    return core._agent_prompt_scope(  # noqa: SLF001
        _resolved("{{transcript}}"), _CONFIG, core._scope_context(payload)  # noqa: SLF001
    )


def test_a_braced_override_is_rendered_against_the_run_scope_under_v2() -> None:
    scope = _scope(_payload(2))
    assert scope["transcript"] == "cough three days"
    assert scope["legacy"] == "cough three days"
    assert scope["age"] == "41"
    assert scope["run"] == "run-1"
    assert scope["plain"] == "no braces"
    assert scope["consultation"] == {"patient": {"age": 41}}


def test_an_unresolved_override_fails_by_name() -> None:
    payload = _payload(2)
    config = {
        "agentRef": {"slug": "x"},
        "overrides": {"promptVariables": {"x": "{{nodes.nope.text}}"}},
    }
    with pytest.raises(PromptVariableUnresolved) as excinfo:
        core._agent_prompt_scope(  # noqa: SLF001
            _resolved("{{x}}"), config, core._scope_context(payload)  # noqa: SLF001
        )
    assert excinfo.value.paths == ["nodes.nope.text"]


def test_off_protocol_v2_an_override_is_still_bound_literally() -> None:
    scope = _scope(_payload(None))
    assert scope["transcript"] == "{{nodes.n_asr.outputs.transcript}}"
    assert "consultation" not in scope
