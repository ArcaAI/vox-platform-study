"""TASK-1006 (A-2) — ``core.data`` publishes its reshaped ``text`` field on the ``text`` socket.

The contract half is ``packages/workflow-contract/src/node-ports.ts`` (``core.data`` outputs
``text: text``, runtime key ``text``) and the parity fixture; this is the runtime half. The
socket carries the reshaped output's ``text`` field and nothing else, and only when that field
IS text — a string, a list of strings, or a ``{ "text": … }`` TEXT-kind object — so a mapping
that resolved nothing, or resolved a non-text value, publishes no ``text`` at all (an absent
socket contributes nothing downstream; a fabricated empty string would).
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core
from harness.temporal.interpreter.registry import NODE_REGISTRY

_TENANT = "10000000-0000-0000-0000-000000000001"
_TRANSCRIPT = "Doctor: What brings you in? Patient: A dry cough for three days."


def _payload(mappings: list[dict[str, Any]], bound_in: Any) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="n_transcript",
        node_type="core.data",
        config={"mappings": mappings},
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs={"in": bound_in},
        run_payload={},
    )


@pytest.fixture(autouse=True)
def _no_trajectory(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)


def test_the_registry_declares_the_socket_under_its_runtime_key() -> None:
    assert NODE_REGISTRY["core.data"].output_keys == {"out": "data", "text": "text", "next": None}


class TestTheTextSocket:
    async def test_a_mapped_string_is_published_on_text(self) -> None:
        result = await core.interpreter_core_data(
            _payload(
                [{"from": "in.transcript.text", "to": "text"}],
                {"transcript": {"text": _TRANSCRIPT}},
            )
        )
        assert result.status == "SUCCEEDED"
        assert result.output == {"data": {"text": _TRANSCRIPT}, "text": _TRANSCRIPT}

    async def test_a_text_kind_object_is_unwrapped(self) -> None:
        result = await core.interpreter_core_data(
            _payload([{"from": "in.transcript", "to": "text"}], {"transcript": {"text": _TRANSCRIPT}})
        )
        assert result.output == {"data": {"text": {"text": _TRANSCRIPT}}, "text": _TRANSCRIPT}

    async def test_several_texts_are_joined_as_paragraphs(self) -> None:
        result = await core.interpreter_core_data(
            _payload([{"from": "in.parts", "to": "text"}], {"parts": ["first", {"text": "second"}]})
        )
        assert result.output["text"] == "first\n\nsecond"

    async def test_an_unresolved_optional_mapping_publishes_no_text(self) -> None:
        # The consultation-bound run: the payload carries no transcript, so nothing is bound
        # downstream — the socket is ABSENT, never an empty string.
        result = await core.interpreter_core_data(
            _payload([{"from": "in.transcript.text", "to": "text"}], {"context": {}})
        )
        assert result.status == "SUCCEEDED"
        assert result.output == {"data": {}}

    @pytest.mark.parametrize("value", ["", "   ", 42, {"note": "not text"}, [], None])
    async def test_a_non_text_or_blank_value_publishes_no_text(self, value: Any) -> None:
        result = await core.interpreter_core_data(
            _payload([{"from": "in.value", "to": "text"}], {"value": value})
        )
        assert "text" not in result.output

    async def test_a_node_that_maps_no_text_field_is_unchanged(self) -> None:
        result = await core.interpreter_core_data(
            _payload([{"from": "in.patient.name", "to": "patient_name"}], {"patient": {"name": "A"}})
        )
        assert result.output == {"data": {"patient_name": "A"}}
