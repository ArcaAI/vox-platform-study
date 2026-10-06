"""TASK-1035 P1 — durable `core.agent` composes its messages through `compose_messages`.

Pinned here:

1. SYSTEM = ``platform_rules()`` → the composed instruction → the output-language step → (output
   contract), joined by a blank line. USER = the bound ``in`` and ``context`` as wrapped data
   blocks keyed ``input`` / ``context`` (labels ``Input`` / ``Context``), in that order.
2. A selected tenant output-language policy owns the language: no platform step is added.
3. The scope is ``build_prompt_scope`` (OD-6): ``{{context.x}}`` and ``{{trigger.x}}`` render the
   same value, and the single-kind ``context`` envelope is still unwrapped.
4. A missing variable keeps the DEGRADED ``prompt_variable_unresolved`` step, now naming EVERY
   missing path; nothing is sent to text.
5. OD-9: after the call that SERVED, the composed messages are recorded at the gateway with the
   serving agent's slug, the consultation, the provider and the locality text reported.
6. P0 stays intact: ``provider_locality`` and ``known_phi`` are still stamped.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from harness.services import composed_prompt_recorder as recorder
from harness.services.text_client import TextServiceError
from harness.temporal.interpreter.compose_messages import platform_rules
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core
from harness.temporal.interpreter.output_language import default_output_language_step

_TENANT = "10000000-0000-0000-0000-000000000001"
_SYSTEM_TENANT = "00000000-0000-0000-0000-000000000000"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"
_ENGLISH_STEP = default_output_language_step("English")


def _wire(
    resolved_prompt: dict[str, Any],
    *,
    variables: dict[str, Any] | None = None,
    chain: list[dict[str, Any]] | None = None,
    context_schema: dict[str, Any] | None = None,
) -> dict[str, Any]:
    instruction: dict[str, Any] = {"systemPrompt": resolved_prompt.get("content", "")}
    if variables is not None:
        instruction["variables"] = variables
    compiled: dict[str, Any] = {
        "task": "TEXT_GENERATION",
        "model": {"slug": "az-gpt", "provider": "azure"},
        "fallbacks": [],
        "instruction": instruction,
        "resolvedPrompt": resolved_prompt,
        "parameters": {},
    }
    if context_schema is not None:
        compiled["contextSchema"] = {"payloadSchema": context_schema}
    return {
        "agentId": "agent-1",
        "agentVersionId": "agent-1",
        "slug": "clinic-summarizer",
        "versionNumber": 3,
        "task": "TEXT_GENERATION",
        "tenantId": _TENANT,
        "source": "tenant",
        "compiledConfig": compiled,
        "models": [
            {
                "role": "primary",
                "slug": "az-gpt",
                "sourceUri": "gpt-5.4-mini",
                "provider": "azure",
                "tenantId": _TENANT,
                "deploymentKind": "BYOK",
            }
        ],
        "textFallback": {"autoSwitch": True, "chain": chain or []},
    }


def _fallback(content: str) -> dict[str, Any]:
    return {
        "kind": "platform-default",
        "agent": {
            "slug": "platform-summarization",
            "versionId": "p1",
            "versionNumber": 1,
            "tenantId": _SYSTEM_TENANT,
            "source": "platform-default",
        },
        "modelSlug": "lms-gemma",
        "provider": "lm-studio",
        "model": "gemma",
        "resolvedPrompt": {"source": "inline", "content": content},
        "instruction": {"systemPrompt": content},
        "parameters": {},
        "tools": [],
        "fundingTier": "platform",
        "deploymentKind": "SELF_HOSTED",
    }


def _payload(
    *,
    bound: dict[str, Any] | None = None,
    trigger: dict[str, Any] | None = None,
    config: dict[str, Any] | None = None,
) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="agent1",
        node_type="core.agent",
        config=config or {"agentRef": {"slug": "clinic-summarizer"}},
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs=bound if bound is not None else {"in": "Ada Lovelace reports chest pain."},
        run_payload={"consultationId": "c-1", "externalPatientId": "MRN-00042"},
        run_id=_RUN,
        run_context={"trigger": trigger if trigger is not None else {"patient": {"name": "Ada"}}},
    )


class _Result:
    def __init__(self, provider: str, egress: dict[str, Any] | None) -> None:
        self.content = "the note"
        self.provider = provider
        self.model = "m"
        self.usage = None
        self.stats = None
        self.usage_detail = None
        self.egress = egress


class _Text:
    def __init__(self, failing: set[str], egress: dict[str, Any] | None) -> None:
        self.failing = failing
        self.egress = egress
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> _Result:
        self.calls.append(kwargs)
        if kwargs["provider"] in self.failing:
            raise TextServiceError(f"{kwargs['provider']} down")
        return _Result(kwargs["provider"], self.egress)


@pytest.fixture
def run(monkeypatch: pytest.MonkeyPatch):
    recorded: list[tuple[dict[str, Any], str]] = []
    statuses: list[dict[str, Any]] = []

    async def _record_and_flush(_payload: Any, **kwargs: Any) -> None:
        statuses.append(kwargs)

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def _capture(body: dict[str, Any], tenant_id: str) -> None:
        recorded.append((body, tenant_id))

    monkeypatch.setattr(core, "record_and_flush", _record_and_flush)
    monkeypatch.setattr(core, "record_generation_and_flush", _noop)
    monkeypatch.setattr(recorder, "_send", _capture)

    async def _go(
        answer: dict[str, Any],
        payload: NodeActivityInput | None = None,
        *,
        failing: set[str] | None = None,
        egress: dict[str, Any] | None = None,
    ):
        text = _Text(failing or set(), egress if egress is not None else {"locality": "cloud"})

        class _Api:
            async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
                return answer

            async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
                return {}

        monkeypatch.setattr(core, "_api_client", lambda _settings: _Api())
        monkeypatch.setattr(core, "_text_client", lambda _settings: text)
        result = await core.interpreter_core_agent(payload or _payload())
        await recorder.drain_pending()
        return result, text.calls, recorded, statuses

    return _go


def _block(key: str, label: str, body: str) -> str:
    return f'<<<EXTERNAL_DATA section="{key}">>>\n--- {label} ---\n{body}\n<<<END_EXTERNAL_DATA>>>'


class TestMessages:
    @pytest.mark.asyncio
    async def test_system_is_platform_rules_then_instruction_then_language_step(self, run) -> None:
        result, calls, _, _ = await run(_wire({"source": "inline", "content": "Summarise."}))

        assert result.status == "SUCCEEDED"
        assert calls[0]["system_prompt"] == "\n\n".join(
            [platform_rules(), "Summarise.", _ENGLISH_STEP]
        )

    @pytest.mark.asyncio
    async def test_user_is_the_input_and_context_as_wrapped_data_blocks(self, run) -> None:
        payload = _payload(bound={"in": "Ada reports chest pain.", "context": {"age": 41}})

        _, calls, _, _ = await run(_wire({"source": "inline", "content": "Summarise."}), payload)

        context_json = json.dumps({"age": 41}, ensure_ascii=False, sort_keys=True, indent=2)
        assert calls[0]["prompt"] == "\n\n".join(
            [
                _block("input", "Input", "Ada reports chest pain."),
                _block("context", "Context", context_json),
            ]
        )

    @pytest.mark.asyncio
    async def test_context_alone_is_enough_to_generate(self, run) -> None:
        payload = _payload(bound={"context": {"age": 41}})

        result, calls, _, _ = await run(_wire({"source": "inline", "content": "S."}), payload)

        assert result.status == "SUCCEEDED"
        assert calls[0]["prompt"].startswith('<<<EXTERNAL_DATA section="context">>>')

    @pytest.mark.asyncio
    async def test_nothing_bound_still_degrades(self, run) -> None:
        result, calls, _, _ = await run(
            _wire({"source": "inline", "content": "S."}), _payload(bound={})
        )

        assert result.status == "DEGRADED"
        assert calls == []

    @pytest.mark.asyncio
    async def test_a_selected_tenant_policy_owns_the_language(self, run) -> None:
        composite = {
            "source": "composite",
            "content": "Write the note.",
            "fragments": [
                {"key": "base", "source": "inline", "content": "Write the note."},
                {
                    "key": "output_language_policy",
                    "source": "inline",
                    "content": "Write it in French.",
                },
            ],
        }

        _, calls, _, _ = await run(_wire(composite))

        assert calls[0]["system_prompt"] == "\n\n".join(
            [platform_rules(), "Write the note.\n\nWrite it in French."]
        )

    @pytest.mark.asyncio
    async def test_each_fallback_candidate_composes_its_own_instruction(self, run) -> None:
        answer = _wire({"source": "inline", "content": "PRIMARY."}, chain=[_fallback("FALLBACK.")])

        _, calls, _, _ = await run(answer, failing={"azure-openai"})

        assert calls[1]["system_prompt"] == "\n\n".join(
            [platform_rules(), "FALLBACK.", _ENGLISH_STEP]
        )
        assert calls[1]["prompt"] == calls[0]["prompt"]


class TestScope:
    @pytest.mark.asyncio
    async def test_context_and_trigger_render_the_same_value(self, run) -> None:
        _, calls, _, _ = await run(
            _wire(
                {"source": "inline", "content": "{{context.patient.name}}|{{trigger.patient.name}}"}
            )
        )

        # TASK-1047 FC-1 — the system message points; the value is an EXTERNAL_DATA block.
        pointer = "[see the {} data section below]"
        assert (
            pointer.format("context_patient_name") + "|" + pointer.format("trigger_patient_name")
            in calls[0]["system_prompt"]
        )
        assert "Ada" not in calls[0]["system_prompt"]
        for block in ("context_patient_name", "trigger_patient_name"):
            assert _block(block, block, "Ada") in calls[0]["prompt"]

    @pytest.mark.asyncio
    async def test_the_single_kind_context_envelope_is_unwrapped(self, run) -> None:
        schema = {"type": "object", "properties": {"context": {"type": "object"}}}
        payload = _payload(trigger={"context": {"safe_age": 41}})

        _, calls, _, _ = await run(
            _wire(
                {"source": "inline", "content": "Age {{context.safe_age}}."}, context_schema=schema
            ),
            payload,
        )

        assert "Age [see the context_safe_age data section below]." in calls[0]["system_prompt"]
        assert "41" not in calls[0]["system_prompt"]
        assert _block("context_safe_age", "context_safe_age", "41") in calls[0]["prompt"]

    @pytest.mark.asyncio
    async def test_a_path_binding_resolves_against_the_roots(self, run) -> None:
        _, calls, _, _ = await run(
            _wire(
                {"source": "inline", "content": "Name {{who}}."},
                variables={"who": {"path": "context.patient.name"}},
            )
        )

        assert "Name [see the who data section below]." in calls[0]["system_prompt"]
        assert "Ada" not in calls[0]["system_prompt"]
        assert _block("who", "who", "Ada") in calls[0]["prompt"]


class TestMissingVariables:
    @pytest.mark.asyncio
    async def test_degrades_naming_every_missing_path_and_sends_nothing(self, run) -> None:
        result, calls, recorded, statuses = await run(
            _wire({"source": "inline", "content": "{{context.alpha}} and {{trigger.beta}}"})
        )

        assert result.status == "DEGRADED"
        assert calls == []
        assert recorded == []
        assert statuses[-1]["error_code"] == "prompt_variable_unresolved"
        assert "context.alpha" in result.reason
        assert "trigger.beta" in result.reason


class TestRecording:
    @pytest.mark.asyncio
    async def test_the_served_call_is_recorded_with_its_composed_messages(self, run) -> None:
        _, calls, recorded, _ = await run(
            _wire({"source": "inline", "content": "Summarise."}),
            egress={"locality": "cloud", "redacted": 1},
        )

        assert len(recorded) == 1
        body, tenant = recorded[0]
        assert tenant == _TENANT
        assert body == {
            "consultationId": "c-1",
            "agentSlug": "clinic-summarizer",
            "phase": "workflow",
            "provider": "azure-openai",
            "locality": "cloud",
            "system": calls[0]["system_prompt"],
            "user": calls[0]["prompt"],
        }

    @pytest.mark.asyncio
    async def test_only_the_serving_candidate_is_recorded(self, run) -> None:
        answer = _wire({"source": "inline", "content": "PRIMARY."}, chain=[_fallback("FALLBACK.")])

        _, calls, recorded, _ = await run(
            answer, failing={"azure-openai"}, egress={"locality": "local"}
        )

        assert len(recorded) == 1
        body = recorded[0][0]
        assert body["agentSlug"] == "platform-summarization"
        assert body["provider"] == "lm-studio"
        assert body["locality"] == "local"
        assert body["system"] == calls[1]["system_prompt"]

    @pytest.mark.asyncio
    @pytest.mark.parametrize(("cadence", "phase"), [("perTurn", "live"), ("onEnd", "finalize")])
    async def test_the_phase_follows_the_node_cadence(self, run, cadence: str, phase: str) -> None:
        config = {"agentRef": {"slug": "clinic-summarizer"}, "execution": {"cadence": cadence}}
        # onEnd would persist the note; keep the run in sandbox so only recording is exercised.
        payload = _payload(config=config).model_copy(update={"sandbox": True})

        _, _, recorded, _ = await run(_wire({"source": "inline", "content": "S."}), payload)

        assert recorded[0][0]["phase"] == phase

    @pytest.mark.asyncio
    async def test_a_recording_failure_never_fails_the_step(self, run, monkeypatch) -> None:
        async def _down(_body: dict[str, Any], _tenant_id: str) -> None:
            raise RuntimeError("gateway down")

        monkeypatch.setattr(recorder, "_send", _down)

        result, _, _, _ = await run(_wire({"source": "inline", "content": "S."}))

        assert result.status == "SUCCEEDED"


class TestP0Intact:
    @pytest.mark.asyncio
    async def test_locality_and_known_phi_are_still_stamped(self, run) -> None:
        _, calls, _, _ = await run(_wire({"source": "inline", "content": "S."}))

        assert calls[0]["provider_locality"] == {"azure-openai": "cloud"}
        assert {"label": "patient_id", "value": "MRN-00042"} in calls[0]["known_phi"]
