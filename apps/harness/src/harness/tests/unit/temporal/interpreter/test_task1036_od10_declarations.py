"""TASK-1036 OD-10 (lane B6b) — the durable `core.agent` lane passes the frozen template
DECLARATIONS to the render scope, so an absent OPTIONAL variable renders ``""`` (a required one
still fails by name), and an empty data block is dropped.

The declarations ride on ``compiledConfig.resolvedPrompt.variables`` (a template) or on each
composite fragment, frozen at agent publish. Under run protocol v2 only — the same gate B1 put on
``drop_empty_blocks``, so a run recorded before the marker keeps its bytes.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput, ResolvedAgent
from harness.temporal.interpreter.nodes import core
from harness.temporal.interpreter.prompt_composition import resolved_prompt_variable_declarations
from harness.temporal.interpreter.templating import PromptVariableUnresolved
from harness.tests.unit.temporal.interpreter.test_core_agent_templating_task890 import _resolved

_CONFIG: dict[str, Any] = {"agentRef": {"slug": "discharge-writer"}}


def _agent(required: bool) -> ResolvedAgent:
    resolved = _resolved("Tone: {{tone}}.")
    return resolved.model_copy(
        update={
            "resolved_prompt": resolved.resolved_prompt.model_validate(
                {
                    "source": "template",
                    "promptTemplateId": "tpl-1",
                    "promptVersionNumber": 2,
                    "content": "Tone: {{tone}}.",
                    "variables": [{"name": "tone", "type": "string", "required": required}],
                }
            )
        }
    )


def _context(protocol: int | None) -> dict[str, Any]:
    payload = NodeActivityInput(
        node_id="n_note",
        node_type="core.agent",
        config=_CONFIG,
        tenant_id="t",
        run_id="run-1",
        run_context={"trigger": {"q": 1}, "vars": {}, "nodes": {}},
        protocol=protocol,
    )
    return core._scope_context(payload)  # noqa: SLF001


def test_declarations_are_read_from_a_template_and_from_composite_fragments() -> None:
    assert [
        d["name"] for d in resolved_prompt_variable_declarations(_agent(False).resolved_prompt)
    ] == ["tone"]
    composite = _resolved("x").resolved_prompt.model_validate(
        {
            "source": "composite",
            "content": "",
            "join": "\n\n",
            "fragments": [
                {
                    "key": "a",
                    "source": "template",
                    "content": "{{x}}",
                    "variables": [{"name": "x", "required": False}],
                },
                {"key": "b", "source": "inline", "content": "b"},
                {
                    "key": "c",
                    "source": "template",
                    "content": "{{x}}",
                    "variables": [{"name": "x", "required": True}],
                },
            ],
        }
    )
    assert resolved_prompt_variable_declarations(composite) == [{"name": "x", "required": False}]
    assert resolved_prompt_variable_declarations(None) == []


def test_an_absent_optional_variable_renders_empty_and_an_empty_block_is_dropped() -> None:
    composed, _ = core._compose_agent_messages(  # noqa: SLF001
        _agent(False),
        _CONFIG,
        _context(2),
        data_blocks=[
            {"key": "notes", "label": "Notes", "content": "  \n "},
            {"key": "input", "label": "Input", "content": "hello"},
        ],
        rules="",
    )
    assert composed.system == "Tone: ."
    assert [block.key for block in composed.blocks] == ["input"]


def test_an_absent_required_variable_still_fails_by_name() -> None:
    with pytest.raises(PromptVariableUnresolved) as excinfo:
        core._compose_agent_messages(_agent(True), _CONFIG, _context(2), rules="")  # noqa: SLF001
    assert excinfo.value.paths == ["tone"]


def test_off_protocol_v2_the_declarations_are_not_applied() -> None:
    with pytest.raises(PromptVariableUnresolved):
        core._compose_agent_messages(
            _agent(False), _CONFIG, _context(None), rules=""
        )  # noqa: SLF001
