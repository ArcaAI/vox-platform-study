"""TASK-1047 FC-1 / FC-2 — Python-only rules of the governed composer.

The byte-level rules are held by ``tests/contracts/compose-messages.fixture.json`` (the
``governed-*`` cases, ``test_compose_messages_parity.py``). This file pins what the fixture does
not see: the pointer helpers, the snake_case governance shape, and the ``layers`` telemetry once
the answer shape arrives as named parts.
"""

from __future__ import annotations

import hashlib

import pytest

from harness.temporal.interpreter.compose_messages import (
    ComposeOutputContractConflictError,
    compose_messages,
)
from harness.temporal.interpreter.templating import (
    PointerPlaceholder,
    data_section_pointer,
    placeholder_block_name,
    render_template_pointers,
)


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_block_names_and_pointer() -> None:
    assert placeholder_block_name("trigger.context.formatted_vitals") == (
        "trigger_context_formatted_vitals"
    )
    assert placeholder_block_name("Chief__Complaint") == "chief_complaint"
    assert placeholder_block_name("context.x", {"context.x": "vitals"}) == "vitals"
    assert data_section_pointer("vitals") == "[see the vitals data section below]"


def test_render_template_pointers_reports_every_occurrence() -> None:
    text, found = render_template_pointers(
        '{{a}} {{b | default("z")}} {{a}}', {"a": {"k": 1}}, template_ref="t"
    )
    assert text == (
        "[see the a data section below] [see the b data section below] "
        "[see the a data section below]"
    )
    assert found == [
        PointerPlaceholder(path="a", block="a", value='{"k":1}'),
        PointerPlaceholder(path="b", block="b", value="z"),
        PointerPlaceholder(path="a", block="a", value='{"k":1}'),
    ]


def test_system_is_identical_across_data_and_governance_is_snake_case() -> None:
    def run(age: str):  # type: ignore[no-untyped-def]
        return compose_messages(
            platform_rules="RULES",
            resolved_prompt={"source": "inline", "content": "Age {{age}}."},
            scope={"age": age},
            output_contract_parts=[{"key": "shape", "text": "Return JSON."}],
        )

    first, second = run("42"), run("7")
    assert (
        first.system
        == second.system
        == ("RULES\n\nAge [see the age data section below].\n\nReturn JSON.")
    )
    assert "42" not in first.system
    assert (
        first.governance
        == second.governance
        == {
            "pieces": [
                {"kind": "PLATFORM", "key": "platform-rules@1", "digest": _digest("RULES")},
                {
                    "kind": "TEMPLATE_BODY",
                    "key": "body",
                    "digest": _digest("Age [see the age data section below]."),
                },
                {"kind": "CONTRACT", "key": "shape", "digest": _digest("Return JSON.")},
            ],
            "composed_digest": _digest(first.system),
        }
    )


def test_layers_report_the_contract_parts_as_one_output_contract_layer() -> None:
    result = compose_messages(
        platform_rules="",
        resolved_prompt={"source": "inline", "content": "X"},
        scope={},
        output_contract_parts=[{"key": "a", "text": "Aa"}, {"key": "b", "text": "Bbb"}],
    )
    assert result.layers == [("instruction", 1), ("outputContract", len("Aa\n\nBbb"))]


def test_both_contract_forms_are_refused_by_name() -> None:
    with pytest.raises(ComposeOutputContractConflictError):
        compose_messages(
            platform_rules="",
            resolved_prompt=None,
            scope={},
            output_contract="A",
            output_contract_parts=[{"key": "b", "text": "B"}],
        )
