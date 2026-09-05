"""TASK-864 `core.agent` against the TASK-863 resolve contract, as merged.

`GET /api/v1/internal/agents/resolve` answers with `ResolvedAgent` from
`packages/types/src/agent.ts`: the SELECTION under `compiledConfig` and the REGISTRY FACTS of
every model in the chain under `models[]` keyed by role. The activity's local mirror must read
that shape — the first cut was coded before the route landed and expected flat `model` /
`fallbacks` keys, which would have degraded every core.agent run as `agent_unresolvable`.

Pinned here:

1. The 863 wire shape validates, and the flat fields the activities read are derived from it
   (primary from `models[role=primary]` merged with `compiledConfig.model`, fallbacks in priority
   order merged by slug, instruction / parameters / schemas / resolvedPrompt lifted).
2. A legacy flat payload still validates unchanged (older fixtures).
3. The gateway-resolved prompt text wins over re-reading the raw instruction.
4. `agentRef.versionNumber` is honoured AFTER resolution: the route serves the active version and
   takes no pin, so a drift fails the node CLOSED instead of running whatever is active.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult, ResolvedAgent
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"
_SYSTEM = "00000000-0000-0000-0000-000000000000"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"


def _wire_863(**overrides: Any) -> dict[str, Any]:
    """`ResolvedAgent` exactly as `AgentResolverService.resolve` serialises it."""
    payload: dict[str, Any] = {
        "agentId": "agent-1",
        "agentVersionId": "agent-1",
        "slug": "discharge-writer",
        "versionNumber": 3,
        "task": "TEXT_GENERATION",
        "tenantId": _TENANT,
        "source": "tenant",
        "compiledConfig": {
            "task": "TEXT_GENERATION",
            "service": "llm",
            "model": {
                "id": "m-1",
                "slug": "gpt-x",
                "provider": "openai",
                "taskType": "text-generation",
            },
            "fallbacks": [
                {"priority": 1, "id": "m-3", "slug": "qwen-small", "provider": None},
                {"priority": 0, "id": "m-2", "slug": "llama-local", "provider": None},
            ],
            "instruction": {"systemPrompt": "Raw {{name}}", "variables": {"name": "Raw"}},
            "resolvedPrompt": {"source": "inline", "content": "Resolved {{name}}"},
            "parameters": {"generation": {"temperature": 0.2}},
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "string"},
            "tools": [],
            "protocols": ["http"],
        },
        "models": [
            {
                "role": "fallback",
                "priority": 0,
                "slug": "llama-local",
                "sourceUri": "meta-llama/Llama-3.2-3B",
                "sourceRevision": None,
                "localPath": "/models/llama-local",
                "checksum": "sha256:abc",
                "format": "SAFETENSORS",
                "computeType": "float16",
                "provider": None,
                "tenantId": _SYSTEM,
            },
            {
                "role": "primary",
                "slug": "gpt-x",
                "sourceUri": "openai/gpt-x",
                "sourceRevision": None,
                "localPath": None,
                "checksum": None,
                "format": "CLOUD",
                "computeType": None,
                "provider": "openai",
                "tenantId": _SYSTEM,
            },
        ],
        "providerOverride": {"provider": "openai", "api_key": "k", "funding": "tenant"},
        "fundingTier": "tenant",
    }
    payload.update(overrides)
    return payload


class TestResolvedAgentMirror:
    def test_863_wire_shape_derives_the_flat_fields_the_activities_read(self) -> None:
        resolved = ResolvedAgent.model_validate(_wire_863())

        assert resolved.model.slug == "gpt-x"
        assert resolved.model.provider == "openai"
        assert resolved.model.source_uri == "openai/gpt-x"
        assert resolved.model.format == "CLOUD"
        # Fallbacks in PRIORITY order, each selection merged with its registry row by slug.
        assert [f.slug for f in resolved.fallbacks] == ["llama-local", "qwen-small"]
        assert resolved.fallbacks[0].local_path == "/models/llama-local"
        assert resolved.fallbacks[0].source_uri == "meta-llama/Llama-3.2-3B"
        assert resolved.fallbacks[1].source_uri is None
        assert resolved.instruction == {
            "systemPrompt": "Raw {{name}}",
            "variables": {"name": "Raw"},
        }
        assert resolved.resolved_prompt is not None
        assert resolved.resolved_prompt.content == "Resolved {{name}}"
        assert resolved.parameters == {"generation": {"temperature": 0.2}}
        assert resolved.input_schema == {"type": "object"}
        assert resolved.output_schema == {"type": "string"}
        assert resolved.provider_override == {
            "provider": "openai",
            "api_key": "k",
            "funding": "tenant",
        }
        assert resolved.funding_tier == "tenant"
        assert resolved.tenant_id == _TENANT
        assert resolved.source == "tenant"
        assert isinstance(resolved.compiled_config, dict)

    def test_primary_falls_back_to_the_selection_when_the_registry_row_is_absent(self) -> None:
        wire = _wire_863()
        wire["models"] = [m for m in wire["models"] if m["role"] != "primary"]

        resolved = ResolvedAgent.model_validate(wire)

        assert resolved.model.slug == "gpt-x"
        assert resolved.model.provider == "openai"
        assert resolved.model.source_uri is None

    def test_registry_fallbacks_stand_in_when_the_selection_lists_none(self) -> None:
        wire = _wire_863()
        wire["compiledConfig"]["fallbacks"] = []

        resolved = ResolvedAgent.model_validate(wire)

        assert [f.slug for f in resolved.fallbacks] == ["llama-local"]

    def test_legacy_flat_payload_still_validates(self) -> None:
        resolved = ResolvedAgent.model_validate(
            {
                "agentId": "agent-1",
                "slug": "flat",
                "versionNumber": 1,
                "task": "TEXT_TO_SPEECH",
                "model": {"slug": "kokoro", "provider": "local", "sourceUri": "hexgrad/Kokoro-82M"},
                "parameters": {"voice": "af_heart"},
            }
        )

        assert resolved.model.slug == "kokoro"
        assert resolved.fallbacks == []
        assert resolved.resolved_prompt is None

    def test_a_payload_without_any_model_selection_is_rejected(self) -> None:
        wire = _wire_863()
        wire["models"] = []
        wire["compiledConfig"]["model"] = None

        with pytest.raises(ValueError):
            ResolvedAgent.model_validate(wire)


class TestSystemPrompt:
    def test_the_gateway_resolved_prompt_wins_and_node_variables_interpolate(self) -> None:
        resolved = ResolvedAgent.model_validate(_wire_863())

        prompt = core._system_prompt(
            resolved, {"overrides": {"promptVariables": {"name": "Ada"}}}, {}
        )

        assert prompt == "Resolved Ada"

    def test_without_a_resolved_prompt_the_instruction_text_is_used(self) -> None:
        wire = _wire_863()
        wire["compiledConfig"]["resolvedPrompt"] = None
        resolved = ResolvedAgent.model_validate(wire)

        assert core._system_prompt(resolved, {}, {}) == "Raw Raw"


def _payload(**config: Any) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="agent1",
        node_type="core.agent",
        config=config,
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs={"in": "Summarise this."},
        run_payload={},
        run_id=_RUN,
    )


class _StubApi:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer = answer
        self.calls: list[dict[str, Any]] = []

    async def resolve_agent(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return self.answer


@pytest.fixture
def stub_api(monkeypatch: pytest.MonkeyPatch) -> _StubApi:
    api = _StubApi(_wire_863())
    monkeypatch.setattr(core, "_api_client", lambda _settings: api)

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)
    return api


class TestVersionPin:
    @pytest.mark.asyncio
    async def test_a_drifted_pin_fails_closed(self, stub_api: _StubApi) -> None:
        result = await core.interpreter_core_agent(
            _payload(agentRef={"slug": "discharge-writer", "versionNumber": 2})
        )

        assert result.status == "DEGRADED"
        assert "pinned to v2" in (result.reason or "")
        assert "resolved v3" in (result.reason or "")
        # The pin never travels to the gateway — the route has no such parameter.
        assert stub_api.calls == [{"slug": "discharge-writer", "tenant_id": _TENANT}]

    @pytest.mark.asyncio
    async def test_a_matching_pin_and_no_pin_both_dispatch_by_task(
        self, stub_api: _StubApi, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen: list[ResolvedAgent] = []

        async def _generate(
            _payload: NodeActivityInput,
            resolved: ResolvedAgent,
            _started: Any,
            fallback: Any = None,
        ) -> NodeActivityResult:
            seen.append(resolved)
            return NodeActivityResult(status="SUCCEEDED", output={"ok": True})

        monkeypatch.setattr(core, "_run_text_generation", _generate)

        pinned = await core.interpreter_core_agent(
            _payload(agentRef={"slug": "discharge-writer", "versionNumber": 3})
        )
        unpinned = await core.interpreter_core_agent(
            _payload(agentRef={"slug": "discharge-writer"})
        )

        assert pinned.status == "SUCCEEDED" and unpinned.status == "SUCCEEDED"
        assert [r.version_number for r in seen] == [3, 3]
        assert seen[0].model.slug == "gpt-x"
