"""F13 — a `responseFormat: "json"` agent must not 422 at `apps/text`.

`core.agent` translated the agent's declared `parameters.responseFormat` into the OpenAI wire
spelling `{"type": "json_object"}`, but the HOPE text service declares its own vocabulary —
`ResponseFormat.type: Literal["text", "json", "json_schema"]`
(`apps/text/src/text/models/requests.py`) — so every generation by an agent whose response
format is `json` (`platform-important-findings`, for one) was refused with a 422 before any
provider was reached. The gateway's own contract is the one to speak; `json_schema` was already
spelled correctly and stays that way.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"
_SCHEMA = {"name": "findings", "schema": {"type": "object"}}


def _wire(parameters: dict[str, Any]) -> dict[str, Any]:
    return {
        "agentId": "agent-1",
        "agentVersionId": "agent-1",
        "slug": "platform-important-findings",
        "versionNumber": 1,
        "task": "TEXT_GENERATION",
        "tenantId": _TENANT,
        "source": "tenant",
        "compiledConfig": {
            "task": "TEXT_GENERATION",
            "service": "llm",
            "model": {
                "id": "m-1",
                "slug": "lms-gemma",
                "provider": "lm-studio",
                "taskType": "TEXT_GENERATION",
            },
            "fallbacks": [],
            "instruction": {"systemPrompt": "List the findings."},
            "resolvedPrompt": {"source": "inline", "content": "List the findings."},
            "parameters": parameters,
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object"},
            "tools": [],
            "protocols": ["http"],
        },
        "models": [
            {
                "role": "primary",
                "priority": 0,
                "slug": "lms-gemma",
                "sourceUri": "gemma-4-e2b-it-qat",
                "provider": "lm-studio",
                "format": "GGUF",
                "tenantId": _TENANT,
            }
        ],
        "textPrimary": {
            "kind": "primary",
            "agent": {
                "slug": "platform-important-findings",
                "versionId": "agent-1",
                "versionNumber": 1,
                "tenantId": _TENANT,
                "source": "tenant",
            },
            "modelSlug": "lms-gemma",
            "provider": "lm-studio",
            "model": "gemma-4-e2b-it-qat",
            "resolvedPrompt": {"source": "inline", "content": "List the findings."},
            "instruction": {"systemPrompt": "List the findings."},
            "parameters": parameters,
            "tools": [],
            "fundingTier": "tenant",
        },
        "textFallback": {"autoSwitch": False, "chain": []},
    }


class _StubApi:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer = answer

    async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
        return self.answer

    async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"phiEnabled": False, "phiFailClosed": True}


class _Result:
    content = '{"findings": []}'
    provider = "lm-studio"
    model = "gemma-4-e2b-it-qat"
    usage = None


class _StubText:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> _Result:
        self.calls.append(kwargs)
        return _Result()


@pytest.fixture
def run(monkeypatch: pytest.MonkeyPatch):
    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)
    monkeypatch.setattr(core, "_phi_redactor", lambda: None)

    async def _go(parameters: dict[str, Any]) -> tuple[_StubText, Any]:
        text = _StubText()
        monkeypatch.setattr(core, "_api_client", lambda _settings: _StubApi(_wire(parameters)))
        monkeypatch.setattr(core, "_text_client", lambda _settings: text)
        result = await core.interpreter_core_agent(
            NodeActivityInput(
                node_id="agent1",
                node_type="core.agent",
                config={"agentRef": {"slug": "platform-important-findings"}},
                tenant_id=_TENANT,
                sandbox=False,
                bound_inputs={"in": "Summarise this."},
                run_payload={},
                run_id=_RUN,
            )
        )
        return text, result

    return _go


class TestResponseFormatSpeaksTheTextServiceVocabulary:
    @pytest.mark.asyncio
    async def test_json_travels_as_the_declared_literal(self, run) -> None:
        text, result = await run({"responseFormat": "json"})

        assert result.status == "SUCCEEDED"
        assert text.calls[0]["response_format"] == {"type": "json"}

    @pytest.mark.asyncio
    async def test_json_schema_is_unchanged(self, run) -> None:
        text, result = await run({"responseFormat": "json_schema", "responseSchema": _SCHEMA})

        assert result.status == "SUCCEEDED"
        assert text.calls[0]["response_format"] == {"type": "json_schema", "json_schema": _SCHEMA}

    @pytest.mark.asyncio
    async def test_no_declared_format_sends_none(self, run) -> None:
        text, _result = await run({})

        assert text.calls[0]["response_format"] is None
