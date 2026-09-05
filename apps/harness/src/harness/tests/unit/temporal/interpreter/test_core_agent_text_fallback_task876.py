"""TASK-876 — `core.agent` text generation falls back along the GATEWAY-RESOLVED chain.

The resolve route (`GET /internal/agents/resolve`) answers a TEXT_GENERATION agent with a
`textFallback` block: the agent's governance (`autoSwitch`, ON by default — owner decision #4,
fallback is a platform HA capability) and the ORDERED chain the gateway already resolved (the
explicit fallback agent | the agent's own model chain, then the SYSTEM platform default), each
candidate carrying its provider, provider-native model id, resolved prompt, parameters and the
funding tier DERIVED from the row that serves it. The activity walks that chain on a
`TextServiceError` and never resolves anything itself — one resolution in the platform.

Pinned here:

1. The wire block parses with the contract defaults (absent ⇒ ON, threshold 2, empty chain).
2. Primary failure + autoSwitch ON ⇒ the next candidate is called with ITS provider / model /
   instruction, and the output names the candidate that served (`agent`, `selectionSource`,
   `fundingTier`) — metering and attribution follow the serving row.
3. autoSwitch OFF ⇒ no switch: the node degrades `text_generate_failed` after ONE call.
4. Every candidate failing ⇒ degraded, with every candidate tried once.
5. The provider on the wire is what apps/text registers (`azure` → `azure-openai`).
6. The retired `llmBinding` never travels: no node module reads a model slug off its config.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.services.text_client import TextServiceError
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import agent_catalogue as agent_catalogue_mod
from harness.temporal.interpreter.nodes import consultation_realtime as realtime_mod
from harness.temporal.interpreter.nodes import core
from harness.temporal.interpreter.nodes import guards as guards_mod
from harness.temporal.interpreter.nodes import text_generate as text_generate_mod
from harness.temporal.interpreter.nodes._text_fallback import (
    read_text_fallback,
    wire_provider,
)

_TENANT = "10000000-0000-0000-0000-000000000001"
_SYSTEM = "00000000-0000-0000-0000-000000000000"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"


def _candidate(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "kind": "platform-default",
        "agent": {
            "slug": "platform-summarization",
            "versionId": "p1",
            "versionNumber": 1,
            "tenantId": _SYSTEM,
            "source": "platform-default",
        },
        "modelSlug": "lms-gemma-4-e2b-it-qat",
        "provider": "lm-studio",
        "model": "gemma-4-e2b-it-qat",
        "resolvedPrompt": {"source": "inline", "content": "PLATFORM {{name}}"},
        "instruction": {"systemPrompt": "PLATFORM {{name}}", "variables": {"name": "default"}},
        "parameters": {"generation": {"temperature": 0.2, "maxTokens": 2048}},
        "tools": [],
        "fundingTier": "platform",
    }
    base.update(over)
    return base


def _wire(
    *, auto_switch: bool = True, chain: list[dict[str, Any]] | None = None, **over: Any
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "agentId": "agent-1",
        "agentVersionId": "agent-1",
        "slug": "clinic-summarizer",
        "versionNumber": 3,
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
            "instruction": {"systemPrompt": "Raw {{name}}", "variables": {"name": "Raw"}},
            "resolvedPrompt": {"source": "inline", "content": "Resolved {{name}}"},
            "parameters": {"generation": {"temperature": 0.1, "maxTokens": 900}},
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object"},
            "tools": [],
            "protocols": ["http"],
        },
        "models": [
            {
                "role": "primary",
                "slug": "az-gpt",
                "sourceUri": "gpt-5.4-mini",
                "sourceRevision": None,
                "localPath": None,
                "checksum": None,
                "format": "CLOUD",
                "computeType": None,
                "provider": "azure",
                "tenantId": _TENANT,
            }
        ],
        "fundingTier": "tenant",
        "textFallback": {
            "autoSwitch": auto_switch,
            "switchAfterConsecutiveFailures": 2,
            "chain": [_candidate()] if chain is None else chain,
        },
    }
    payload.update(over)
    return payload


def _payload(**config: Any) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="agent1",
        node_type="core.agent",
        config=config or {"agentRef": {"slug": "clinic-summarizer"}},
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs={"in": "Summarise this."},
        run_payload={},
        run_id=_RUN,
    )


class _StubApi:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer = answer

    async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
        return self.answer

    async def get_policy(
        self, tenant_id: str, consultation_id: Any = None, task_key: Any = None
    ) -> dict[str, Any]:
        # PHI egress OFF keeps the test hermetic (no Presidio); the flags are all this activity reads here.
        return {"phiEnabled": False, "phiFailClosed": True}


class _Result:
    def __init__(self, provider: str, model: str) -> None:
        self.content = "generated"
        self.provider = provider
        self.model = model
        self.usage = None


class _StubText:
    """Fails the providers in ``failing`` with a TextServiceError; records every call."""

    def __init__(self, failing: set[str]) -> None:
        self.failing = failing
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> _Result:
        self.calls.append(kwargs)
        if kwargs["provider"] in self.failing:
            raise TextServiceError(f"{kwargs['provider']} down")
        return _Result(kwargs["provider"], kwargs["model"])


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch):
    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)
    monkeypatch.setattr(core, "_phi_redactor", lambda: None)

    def _install(answer: dict[str, Any], failing: set[str]) -> _StubText:
        api = _StubApi(answer)
        text = _StubText(failing)
        monkeypatch.setattr(core, "_api_client", lambda _settings: api)
        monkeypatch.setattr(core, "_text_client", lambda _settings: text)
        return text

    return _install


class TestReadTextFallback:
    def test_parses_the_wire_block(self) -> None:
        block = read_text_fallback(_wire(auto_switch=False))
        assert block.auto_switch is False
        assert block.switch_after_consecutive_failures == 2
        assert [c.agent.slug for c in block.chain] == ["platform-summarization"]
        assert block.chain[0].provider == "lm-studio"
        assert block.chain[0].model == "gemma-4-e2b-it-qat"
        assert block.chain[0].funding_tier == "platform"
        assert block.chain[0].resolved_prompt is not None
        assert block.chain[0].resolved_prompt.content == "PLATFORM {{name}}"

    def test_absent_block_reads_as_the_contract_defaults(self) -> None:
        wire = _wire()
        del wire["textFallback"]
        block = read_text_fallback(wire)
        assert block.auto_switch is True
        assert block.switch_after_consecutive_failures == 2
        assert block.chain == []

    def test_a_malformed_block_reads_as_defaults_with_no_chain(self) -> None:
        block = read_text_fallback(_wire(textFallback="nope"))
        assert block.auto_switch is True and block.chain == []
        block = read_text_fallback(
            _wire(textFallback={"autoSwitch": True, "chain": ["junk", {"kind": "x"}]})
        )
        assert block.chain == []

    def test_wire_provider_is_what_apps_text_registers(self) -> None:
        assert wire_provider("azure") == "azure-openai"
        assert wire_provider("lm-studio") == "lm-studio"
        assert wire_provider(None) is None


class TestFallbackOnPrimaryFailure:
    @pytest.mark.asyncio
    async def test_switches_to_the_next_candidate_and_attributes_the_serving_row(
        self, harness
    ) -> None:
        text = harness(_wire(), failing={"azure-openai"})

        result = await core.interpreter_core_agent(
            _payload(
                agentRef={"slug": "clinic-summarizer"},
                overrides={"promptVariables": {"name": "Ada"}},
            )
        )

        assert result.status == "SUCCEEDED"
        assert [c["provider"] for c in text.calls] == ["azure-openai", "lm-studio"]
        # The fallback candidate runs on ITS model, ITS resolved prompt (node variables interpolated) and ITS parameters.
        served = text.calls[1]
        assert served["model"] == "gemma-4-e2b-it-qat"
        assert served["system_prompt"] == "PLATFORM Ada"
        assert served["temperature"] == 0.2 and served["max_tokens"] == 2048
        # And the output names the row that served — metering follows it.
        assert result.output is not None
        assert result.output["agent"] == {"slug": "platform-summarization", "versionNumber": 1}
        assert result.output["selectionSource"] == "agent-fallback"
        assert result.output["fundingTier"] == "platform"

    @pytest.mark.asyncio
    async def test_the_primary_serves_when_it_works_and_is_attributed_as_the_agent(
        self, harness
    ) -> None:
        text = harness(_wire(), failing=set())

        result = await core.interpreter_core_agent(_payload())

        assert result.status == "SUCCEEDED"
        assert [c["provider"] for c in text.calls] == ["azure-openai"]
        assert text.calls[0]["model"] == "gpt-5.4-mini"
        assert result.output is not None
        assert result.output["agent"] == {"slug": "clinic-summarizer", "versionNumber": 3}
        assert result.output["selectionSource"] == "agent"
        assert result.output["fundingTier"] == "tenant"

    @pytest.mark.asyncio
    async def test_auto_switch_off_degrades_after_one_call(self, harness) -> None:
        text = harness(_wire(auto_switch=False), failing={"azure-openai"})

        result = await core.interpreter_core_agent(_payload())

        assert result.status == "DEGRADED"
        assert "text generate failed" in (result.reason or "")
        assert len(text.calls) == 1

    @pytest.mark.asyncio
    async def test_every_candidate_failing_degrades_after_trying_each_once(self, harness) -> None:
        second = _candidate(
            kind="fallback-model",
            agent={
                "slug": "clinic-summarizer",
                "versionId": "agent-1",
                "versionNumber": 3,
                "tenantId": _TENANT,
                "source": "tenant",
            },
            provider="vllm",
            model="medgemma",
            fundingTier="tenant",
        )
        text = harness(
            _wire(chain=[second, _candidate()]), failing={"azure-openai", "vllm", "lm-studio"}
        )

        result = await core.interpreter_core_agent(_payload())

        assert result.status == "DEGRADED"
        assert [c["provider"] for c in text.calls] == ["azure-openai", "vllm", "lm-studio"]


class TestLlmBindingIsRetired:
    @pytest.mark.parametrize(
        "module", [text_generate_mod, realtime_mod, guards_mod, agent_catalogue_mod]
    )
    def test_no_node_module_reads_a_model_slug_off_its_config(self, module) -> None:
        source = __import__("inspect").getsource(module)
        assert "read_model_slug(" not in source
        assert "model_slug=" not in source
