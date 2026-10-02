"""TASK-1035 P1 — the palette lane (`generate.text`, and `consultation.synthesize` through it)
composes its messages through `compose_messages`.

Pinned here:

1. A bound ``consultation.assemblePrompt`` output was ALREADY composed by the gateway's composer:
   its ``systemPrompt`` and ``text`` reach text verbatim (re-composing would prepend the
   platform rules twice and re-wrap blocks that are already wrapped).
2. Otherwise SYSTEM = ``platform_rules()`` → the instruction (``config.systemPrompt``, then a bound
   ``prompt.template_ref`` body), and every other bound value is USER data, wrapped as the
   ``input`` block. ``config.systemPrompt`` is rendered through the one grammar, so a missing
   variable degrades the node by name instead of shipping a literal ``{{…}}``.
3. With an assembled prompt bound, ``config.systemPrompt`` still overrides the system message,
   now composed below the platform rules.
4. OD-9: the call is recorded at the gateway, phase from the task key, locality from text.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.services import composed_prompt_recorder as recorder
from harness.temporal.interpreter.compose_messages import platform_rules
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import consultation_compose as compose_mod
from harness.temporal.interpreter.nodes import text_generate as text_generate_mod

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN_PAYLOAD = {"consultationId": "c-1", "externalPatientId": "MRN-00042"}


def _block(key: str, label: str, body: str) -> str:
    return f'<<<EXTERNAL_DATA section="{key}">>>\n--- {label} ---\n{body}\n<<<END_EXTERNAL_DATA>>>'


class _Result:
    content = "the note"
    provider = "lm-studio"
    model = "gemma"
    usage: dict[str, Any] = {}
    stats = None
    usage_detail = None
    egress = {"locality": "local", "redacted": 0}


class _Text:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> _Result:
        self.calls.append(kwargs)
        return _Result()


class _Api:
    async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"textProvider": "lm-studio", "textModel": "gemma"}


@pytest.fixture
def stubs(monkeypatch: pytest.MonkeyPatch):
    text = _Text()
    recorded: list[tuple[dict[str, Any], str]] = []
    statuses: list[dict[str, Any]] = []

    async def _record_and_flush(_payload: Any, **kwargs: Any) -> None:
        statuses.append(kwargs)

    async def _capture(body: dict[str, Any], tenant_id: str) -> None:
        recorded.append((body, tenant_id))

    monkeypatch.setattr(text_generate_mod, "record_and_flush", _record_and_flush)
    monkeypatch.setattr(text_generate_mod, "_api_client", lambda _settings: _Api())
    monkeypatch.setattr(text_generate_mod, "_text_client", lambda _settings: text)
    monkeypatch.setattr(recorder, "_send", _capture)
    return text, recorded, statuses


def _node(
    config: dict[str, Any], bound: dict[str, Any], node_type: str = "generate.text"
) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="n1",
        node_type=node_type,
        config=config,
        tenant_id=_TENANT,
        bound_inputs=bound,
        run_payload=_RUN_PAYLOAD,
    )


def _assembled() -> dict[str, Any]:
    return {
        "text": _block("transcript", "Transcript", "Ada reports chest pain."),
        "systemPrompt": platform_rules() + "\n\nWrite a SOAP note.",
        "promptTemplateId": "tpl-1",
        "promptVersion": 3,
        "resolvedFrom": "tenant",
    }


def _template_ref() -> dict[str, Any]:
    return {"content": "Summarise in three lines.", "promptTemplateId": "tpl-9", "version": 2}


class TestComposition:
    @pytest.mark.asyncio
    async def test_an_assembled_prompt_passes_through_verbatim(self, stubs) -> None:
        text, _, _ = stubs

        await text_generate_mod.interpreter_text_generate(
            _node({"taskKey": "text.finalize"}, {"in": _assembled()})
        )

        assert text.calls[0]["system_prompt"] == _assembled()["systemPrompt"]
        assert text.calls[0]["prompt"] == _assembled()["text"]

    @pytest.mark.asyncio
    async def test_bare_text_is_wrapped_as_input_data_under_the_platform_rules(self, stubs) -> None:
        text, _, _ = stubs

        await text_generate_mod.interpreter_text_generate(
            _node({"taskKey": "text.finalize"}, {"in": "Ada reports chest pain."})
        )

        assert text.calls[0]["system_prompt"] == platform_rules()
        assert text.calls[0]["prompt"] == _block("input", "Input", "Ada reports chest pain.")

    @pytest.mark.asyncio
    async def test_a_template_ref_body_is_the_instruction_not_data(self, stubs) -> None:
        text, _, _ = stubs

        await text_generate_mod.interpreter_text_generate(
            _node(
                {"taskKey": "text.finalize"},
                {"in": "Ada reports chest pain.", "prompt": _template_ref()},
            )
        )

        assert text.calls[0]["system_prompt"] == (
            platform_rules() + "\n\nSummarise in three lines."
        )
        assert text.calls[0]["prompt"] == _block("input", "Input", "Ada reports chest pain.")

    @pytest.mark.asyncio
    async def test_a_template_ref_body_is_not_rendered_a_second_time(self, stubs) -> None:
        text, _, _ = stubs
        rendered = {**_template_ref(), "content": "Keep the literal {{marker}} as written."}

        result = await text_generate_mod.interpreter_text_generate(
            _node({"taskKey": "text.finalize"}, {"in": "x", "prompt": rendered})
        )

        assert result.status == "SUCCEEDED"
        assert text.calls[0]["system_prompt"].endswith("Keep the literal {{marker}} as written.")

    @pytest.mark.asyncio
    async def test_config_system_prompt_overrides_under_the_platform_rules(self, stubs) -> None:
        text, _, _ = stubs

        await text_generate_mod.interpreter_text_generate(
            _node({"taskKey": "text.finalize", "systemPrompt": "OVERRIDE"}, {"in": _assembled()})
        )

        assert text.calls[0]["system_prompt"] == platform_rules() + "\n\nOVERRIDE"
        assert text.calls[0]["prompt"] == _assembled()["text"]

    @pytest.mark.asyncio
    async def test_an_unresolved_override_variable_degrades_by_name(self, stubs) -> None:
        text, recorded, statuses = stubs

        result = await text_generate_mod.interpreter_text_generate(
            _node({"taskKey": "text.finalize", "systemPrompt": "Hi {{context.who}}"}, {"in": "x"})
        )

        assert result.status == "DEGRADED"
        assert "context.who" in result.reason
        assert statuses[-1]["error_code"] == "prompt_variable_unresolved"
        assert text.calls == []
        await recorder.drain_pending()
        assert recorded == []


class TestRecording:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("task_key", "phase"),
        [("text.finalize", "finalize"), ("text.live", "live"), ("text.test", "test")],
    )
    async def test_generate_text_records_the_composed_call(
        self, stubs, task_key: str, phase: str
    ) -> None:
        text, recorded, _ = stubs

        await text_generate_mod.interpreter_text_generate(_node({"taskKey": task_key}, {"in": "x"}))
        await recorder.drain_pending()

        assert recorded == [
            (
                {
                    "consultationId": "c-1",
                    "phase": phase,
                    "provider": "lm-studio",
                    "locality": "local",
                    "system": text.calls[0]["system_prompt"],
                    "user": text.calls[0]["prompt"],
                },
                _TENANT,
            )
        ]

    @pytest.mark.asyncio
    async def test_synthesize_records_through_generate_text(self, stubs) -> None:
        _, recorded, _ = stubs

        await compose_mod.interpreter_consultation_synthesize(
            _node({"taskKey": "text.finalize"}, {"in": _assembled()}, "consultation.synthesize")
        )
        await recorder.drain_pending()

        assert len(recorded) == 1
        assert recorded[0][0]["system"] == _assembled()["systemPrompt"]
