"""TASK-1035 — the interpreter's other `/generate` call sites under the new egress contract.

* `generate.text` / `consultation.synthesize` (lane G): the `systemPrompt` produced by
  `consultation.assemblePrompt` is BOUND as the system prompt (config is an explicit override),
  and the assemble node's metadata never leaks into the user prompt.
* Every site sends the prompt verbatim — the harness Presidio egress redactor is retired from
  `/generate` calls — and forwards the identity the run holds as `known_phi`.
* None stamps a locality it does not know: these lanes resolve the provider by NAME from the
  policy overlay, so `provider_locality` is omitted and `apps/text` fails closed.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter.compose_messages import platform_rules
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import _llm_policy as llm_policy_mod
from harness.temporal.interpreter.nodes import consultation_realtime as realtime_mod
from harness.temporal.interpreter.nodes import text_generate as text_generate_mod
from harness.temporal.models import HarnessPolicy

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN_PAYLOAD = {"consultationId": "c-1", "externalPatientId": "MRN-00042"}


class _Result:
    content = '{"subjective": "s"}'
    provider = "azure-openai"
    model = "gpt"
    usage: dict[str, Any] = {}
    stats = None
    usage_detail = None
    egress = None


class _Text:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> _Result:
        self.calls.append(kwargs)
        return _Result()


class _Api:
    async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        # PHI flags ON: under the old code a cloud provider would have been Presidio-screened.
        return {
            "textProvider": "azure-openai",
            "textModel": "gpt",
            "phiEnabled": True,
            "phiFailClosed": True,
        }


@pytest.fixture
def stubs(monkeypatch: pytest.MonkeyPatch):
    text = _Text()

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    for mod in (text_generate_mod, realtime_mod):
        monkeypatch.setattr(mod, "record_and_flush", _noop)
        monkeypatch.setattr(mod, "_api_client", lambda _settings: _Api())
        monkeypatch.setattr(mod, "_text_client", lambda _settings: text)
    monkeypatch.setattr(llm_policy_mod, "_text_client", lambda _settings: text)
    return text


def _assembled(system_prompt: str = "ASSEMBLED SYSTEM") -> dict[str, Any]:
    """`consultation.assemblePrompt`'s published output (`consultation_compose.py`)."""
    return {
        "text": "Transcript: Ada Lovelace reports chest pain.",
        "systemPrompt": system_prompt,
        "promptTemplateId": "tpl-1",
        "promptVersion": 3,
        "resolvedFrom": "tenant",
    }


def _node(config: dict[str, Any], bound: dict[str, Any]) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="n1",
        node_type="generate.text",
        config=config,
        tenant_id=_TENANT,
        bound_inputs=bound,
        run_payload=_RUN_PAYLOAD,
    )


class TestPaletteLaneBindsTheAssembledSystemPrompt:
    @pytest.mark.asyncio
    async def test_the_assembled_system_prompt_is_bound(self, stubs) -> None:
        result = await text_generate_mod.interpreter_text_generate(
            _node({"taskKey": "text.finalize"}, {"in": _assembled()})
        )

        assert result.status == "SUCCEEDED"
        call = stubs.calls[0]
        assert call["system_prompt"] == "ASSEMBLED SYSTEM"
        assert call["prompt"] == "Transcript: Ada Lovelace reports chest pain."

    @pytest.mark.asyncio
    async def test_config_is_an_explicit_override(self, stubs) -> None:
        await text_generate_mod.interpreter_text_generate(
            _node({"taskKey": "text.finalize", "systemPrompt": "OVERRIDE"}, {"in": _assembled()})
        )

        # P1 — the override is the instruction, composed below the platform rules.
        assert stubs.calls[0]["system_prompt"] == platform_rules() + "\n\nOVERRIDE"

    @pytest.mark.asyncio
    async def test_assemble_metadata_never_reaches_the_prompt(self, stubs) -> None:
        await text_generate_mod.interpreter_text_generate(
            _node({"taskKey": "text.finalize"}, {"in": _assembled()})
        )

        prompt = stubs.calls[0]["prompt"]
        for leaked in ("ASSEMBLED SYSTEM", "tpl-1", "tenant"):
            assert leaked not in prompt

    @pytest.mark.asyncio
    async def test_egress_fields(self, stubs) -> None:
        await text_generate_mod.interpreter_text_generate(
            _node({"taskKey": "text.finalize"}, {"in": "Ada Lovelace reports chest pain."})
        )

        call = stubs.calls[0]
        # P1 — not rewritten (no Presidio pass): only wrapped as the `input` data block.
        assert call["prompt"] == (
            '<<<EXTERNAL_DATA section="input">>>\n--- Input ---\n'
            "Ada Lovelace reports chest pain.\n<<<END_EXTERNAL_DATA>>>"
        )
        assert {"label": "patient_id", "value": "MRN-00042"} in call["known_phi"]
        assert call.get("provider_locality") is None


def test_no_interpreter_text_site_imports_the_presidio_egress_guard() -> None:
    for mod in (text_generate_mod, realtime_mod, llm_policy_mod):
        assert not hasattr(mod, "ensure_egress_safe"), mod.__name__
        assert not hasattr(mod, "_phi_redactor"), mod.__name__


class TestRealtimeSummary:
    @pytest.mark.asyncio
    async def test_window_reaches_text_verbatim_with_known_phi(self, stubs, monkeypatch) -> None:
        async def _no_event(*_args: Any, **_kwargs: Any) -> None:
            return None

        class _ApiWithEvents(_Api):
            # The announcement/publish calls are fire-and-forget here; any of them is a no-op.
            def __getattr__(self, _name: str) -> Any:
                return _no_event

        monkeypatch.setattr(realtime_mod, "_api_client", lambda _settings: _ApiWithEvents())

        await realtime_mod.interpreter_consultation_realtime_summary(
            NodeActivityInput(
                node_id="rt1",
                node_type="consultation.realtimeSummary",
                config={},
                tenant_id=_TENANT,
                bound_inputs={"in": "Ada Lovelace reports chest pain."},
                run_payload=_RUN_PAYLOAD,
            )
        )

        call = stubs.calls[0]
        assert call["prompt"] == "Ada Lovelace reports chest pain."
        assert {"label": "patient_id", "value": "MRN-00042"} in call["known_phi"]


class TestLlmPolicyGenerateJson:
    @pytest.mark.asyncio
    async def test_payload_reaches_text_verbatim_with_known_phi(self, stubs) -> None:
        judgement = llm_policy_mod.LlmJudgement(HarnessPolicy(), "azure-openai", "gpt")

        await llm_policy_mod.generate_json(
            tenant_id=_TENANT,
            judgement=judgement,
            system_prompt="Find the findings.",
            user_payload={"transcript": "Ada Lovelace reports chest pain."},
            known_phi=[{"label": "person", "value": "Ada Lovelace"}],
        )

        call = stubs.calls[0]
        assert "Ada Lovelace reports chest pain." in call["prompt"]
        assert call["system_prompt"] == "Find the findings."
        assert call["known_phi"] == [{"label": "person", "value": "Ada Lovelace"}]
