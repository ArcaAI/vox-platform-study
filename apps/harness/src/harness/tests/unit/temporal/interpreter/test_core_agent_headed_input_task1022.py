"""TASK-1022 — the finalizer SEES the document template's headings.

The live handoff binds each per-turn summary node's whole output into the finalizer's ``in``
port: ``{ text, sections, stats, repaired }``. ``text`` is the live lane's unlabelled join of the
section BODIES (it is the NER offset base, so it must not change), and ``core.agent``'s text
generation read ONLY ``text`` — so the finalizer was told to keep headings it was never shown and
invented its own layout (TASK-1020 §9.6, prompt capture ``p48.txt``).

``_render_input_for_generation`` renders a ``sections``-carrying input as headed Markdown, in list
order (the live lane emits template order), with the owner's literal marker under an empty
heading (OD-1 (b)). Everything else renders exactly as ``_texts`` did, byte for byte.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"


def _note(*sections: tuple[str, str], text: str = "flat body join") -> dict[str, Any]:
    return {
        "text": text,
        "sections": [{"title": title, "content": content} for title, content in sections],
        "stats": {"turns": 3},
        "repaired": False,
    }


class TestRenderInputForGeneration:
    def test_sections_render_as_headed_markdown_in_list_order(self) -> None:
        rendered = core._render_input_for_generation(
            _note(
                ("New Complaints", "Chest pain on exertion."),
                ("Current Diagnosis", "Stable angina."),
                ("Treatment Plan", "Aspirin 75 mg OD."),
            )
        )

        assert rendered == [
            "## New Complaints\nChest pain on exertion.\n\n"
            "## Current Diagnosis\nStable angina.\n\n"
            "## Treatment Plan\nAspirin 75 mg OD."
        ]

    def test_an_empty_section_keeps_its_heading_with_the_literal_marker(self) -> None:
        rendered = core._render_input_for_generation(
            _note(("New Complaints", "Cough."), ("Investigations", ""), ("Plan", "  \n"))
        )

        assert rendered == [
            "## New Complaints\nCough.\n\n## Investigations\nNot discussed\n\n## Plan\nNot discussed"
        ]

    def test_the_parser_fallback_section_gets_no_heading(self) -> None:
        """A single ``Running Summary`` section is an UNKNOWN partition, not a section by that name."""
        rendered = core._render_input_for_generation(
            _note(("Running Summary", "Everything said, unpartitioned.\n"))
        )

        assert rendered == ["Everything said, unpartitioned."]

    def test_a_single_untitled_section_gets_no_heading(self) -> None:
        rendered = core._render_input_for_generation(_note(("", "Unlabelled body.")))

        assert rendered == ["Unlabelled body."]

    def test_a_note_whose_every_section_is_empty_falls_back_to_its_text(self) -> None:
        """A live lane that produced nothing must still degrade as ``no_bound_text``, not ship a
        note made of markers."""
        rendered = core._render_input_for_generation(
            _note(("New Complaints", ""), ("Plan", ""), text="")
        )

        assert rendered == []

    @pytest.mark.parametrize(
        "value",
        [
            None,
            "a plain string",
            ["one", "", "two"],
            {"text": "a dict with text only"},
            {"text": "sections is not a list", "sections": "nope"},
            {"text": "empty sections", "sections": []},
            {"text": "no titles anywhere", "sections": [{"content": "x"}, {"content": "y"}]},
            [{"text": "a"}, 42, {"nope": 1}, "b"],
            [["nested", "list"], "flat"],
        ],
    )
    def test_a_non_sections_input_renders_exactly_as_texts_did(self, value: Any) -> None:
        assert core._render_input_for_generation(value) == core._texts(value)

    def test_a_list_mixes_headed_notes_and_plain_items_in_order(self) -> None:
        rendered = core._render_input_for_generation(
            ["preface", _note(("A", "a.")), {"text": "tail"}]
        )

        assert rendered == ["preface", "## A\na.", "tail"]

    def test_the_same_input_always_renders_the_same_bytes(self) -> None:
        value = _note(("B", "second"), ("A", ""), ("C", "third"))

        first = core._render_input_for_generation(value)
        second = core._render_input_for_generation(value)

        assert first == second
        # Pure: the bound value is not mutated (it is the durable lane's cached output).
        assert value == _note(("B", "second"), ("A", ""), ("C", "third"))

    def test_texts_is_unchanged_for_its_other_callers(self) -> None:
        """classify / speech / NER read ``text`` — the NER offset base — and must keep doing so."""
        assert core._texts(_note(("A", "a."), text="flat body join")) == ["flat body join"]


# ---------------------------------------------------------------------------------------------
# The activity sends the rendered input as the user turn.
# ---------------------------------------------------------------------------------------------


def _wire() -> dict[str, Any]:
    return {
        "agentId": "agent-1",
        "agentVersionId": "agent-1",
        "slug": "casenote-finalization",
        "versionNumber": 1,
        "task": "TEXT_GENERATION",
        "tenantId": _TENANT,
        "source": "tenant",
        "compiledConfig": {
            "task": "TEXT_GENERATION",
            "service": "llm",
            "model": {
                "id": "m-1",
                "slug": "az-gpt",
                "provider": "azure",
                "taskType": "TEXT_GENERATION",
            },
            "fallbacks": [],
            "instruction": {"systemPrompt": "Finalize."},
            "resolvedPrompt": {"source": "inline", "content": "Finalize."},
            "parameters": {},
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "string"},
            "tools": [],
            "protocols": ["http"],
        },
        "models": [
            {
                "role": "primary",
                "slug": "az-gpt",
                "sourceUri": "gpt-5.4-mini",
                "format": "CLOUD",
                "provider": "azure",
                "tenantId": _TENANT,
            }
        ],
        "textFallback": {"autoSwitch": False, "chain": []},
    }


class _Api:
    async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
        return _wire()

    async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"phiEnabled": False, "phiFailClosed": True}


class _Result:
    content = "generated"
    provider = "azure-openai"
    model = "gpt-5.4-mini"
    usage = None


class _Text:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> _Result:
        self.calls.append(kwargs)
        return _Result()


@pytest.mark.asyncio
async def test_the_finalizer_user_turn_carries_the_headings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    text = _Text()
    monkeypatch.setattr(core, "record_and_flush", _noop)
    monkeypatch.setattr(core, "_phi_redactor", lambda: None)
    monkeypatch.setattr(core, "_api_client", lambda _settings: _Api())
    monkeypatch.setattr(core, "_text_client", lambda _settings: text)

    result = await core.interpreter_core_agent(
        NodeActivityInput(
            node_id="n_finalize",
            node_type="core.agent",
            config={"agentRef": {"slug": "casenote-finalization"}},
            tenant_id=_TENANT,
            sandbox=False,
            bound_inputs={
                "in": [
                    _note(
                        ("New Complaints", "Breathless on stairs."),
                        ("Investigations", ""),
                        ("Current Diagnosis", "Anaemia (Hb 10.2 g/dL)."),
                    )
                ]
            },
            run_payload={},
            run_id=_RUN,
        )
    )

    assert result.status == "SUCCEEDED"
    assert text.calls[0]["prompt"] == (
        "## New Complaints\nBreathless on stairs.\n\n"
        "## Investigations\nNot discussed\n\n"
        "## Current Diagnosis\nAnaemia (Hb 10.2 g/dL)."
    )
