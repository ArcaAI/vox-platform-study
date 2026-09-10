"""TASK-947 OD-11 — WHICH fragments of a composite instruction ran lands on the NODE trajectory row.

Lane C put the selected keys on ``NodeActivityResult.prompt_fragments``; the trajectory step the
activity records carried nothing, because ``record_and_flush`` / ``record_generation_and_flush``
had no way to attach node-level stats. They do now: an optional ``stats`` / ``node_stats`` dict
that rides the NODE step (``_TrajectoryBatch.record`` already accepts one). The gateway persists
``stats`` on any step type and BILLS only LLM_CALL steps (``harness-usage.mapper.ts``), so a NODE
step carrying ``{"prompt_fragments": [...]}`` is provenance, never a ledger row.

Keys only, by construction: a condition string and a fragment body are authored content, and a
trajectory row is read by people who are not the author.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import _shared, core

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"


def _payload() -> NodeActivityInput:
    return NodeActivityInput(
        node_id="node_presummary",
        node_type="core.agent",
        config={"agentRef": {"slug": "arcaai-pre-summarization"}},
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs={"in": "Patient reports chest pain."},
        run_payload={},
        run_id=_RUN,
    )


# ---------------------------------------------------------------------------------------------
# The two recorders forward node stats to the batch
# ---------------------------------------------------------------------------------------------


class _Batch:
    calls: list[dict[str, Any]] = []

    def __init__(self, _settings: Any, _ctx: Any) -> None:
        pass

    def record(self, **kwargs: Any) -> None:
        _Batch.calls.append(kwargs)

    async def flush(self) -> None:
        return None


@pytest.fixture
def batch(monkeypatch: pytest.MonkeyPatch) -> type[_Batch]:
    _Batch.calls = []
    monkeypatch.setattr(_shared, "TrajectoryBatch", _Batch)
    monkeypatch.setattr(_shared, "get_settings", lambda: object())
    return _Batch


class TestTheRecordersCarryNodeStats:
    async def test_record_and_flush_forwards_stats_to_the_node_step(
        self, batch: type[_Batch]
    ) -> None:
        await _shared.record_and_flush(
            _payload(),
            status=_shared.STATUS_OK,
            started=datetime.now(UTC),
            stats={"prompt_fragments": ["base"]},
        )
        assert len(batch.calls) == 1
        assert batch.calls[0]["step_type"] == _shared.STEP_NODE
        assert batch.calls[0]["stats"] == {"prompt_fragments": ["base"]}

    async def test_record_and_flush_without_stats_is_unchanged(self, batch: type[_Batch]) -> None:
        await _shared.record_and_flush(
            _payload(), status=_shared.STATUS_OK, started=datetime.now(UTC)
        )
        assert batch.calls[0].get("stats") is None

    async def test_record_generation_puts_node_stats_on_the_node_step_only(
        self, batch: type[_Batch]
    ) -> None:
        await _shared.record_generation_and_flush(
            _payload(),
            started=datetime.now(UTC),
            stats={"prompt_tokens": 1},
            node_stats={"prompt_fragments": ["base", "revisit"]},
        )
        node, llm = batch.calls
        assert node["step_type"] == _shared.STEP_NODE
        assert node["stats"] == {"prompt_fragments": ["base", "revisit"]}
        # The LLM_CALL step keeps the BILLABLE stats verbatim — provenance never touches it.
        assert llm["step_type"] == _shared.STEP_LLM_CALL
        assert llm["stats"] == {"prompt_tokens": 1}

    async def test_record_generation_without_node_stats_is_unchanged(
        self, batch: type[_Batch]
    ) -> None:
        await _shared.record_generation_and_flush(
            _payload(), started=datetime.now(UTC), stats={"prompt_tokens": 1}
        )
        node, _llm = batch.calls
        assert node.get("stats") is None


# ---------------------------------------------------------------------------------------------
# core.agent attaches the selected keys — and only for a composite
# ---------------------------------------------------------------------------------------------


def _wire(resolved_prompt: dict[str, Any], instruction: dict[str, Any]) -> dict[str, Any]:
    compiled: dict[str, Any] = {
        "task": "TEXT_GENERATION",
        "service": "llm",
        "model": {
            "id": "m-1",
            "slug": "lms-gemma",
            "provider": "lm-studio",
            "taskType": "TEXT_GENERATION",
        },
        "fallbacks": [],
        "instruction": instruction,
        "resolvedPrompt": resolved_prompt,
        "parameters": {},
        "inputSchema": {"type": "object"},
        "outputSchema": {"type": "object"},
        "tools": [],
        "protocols": ["http"],
    }
    return {
        "agentId": "agent-1",
        "agentVersionId": "agent-1",
        "slug": "arcaai-pre-summarization",
        "versionNumber": 4,
        "task": "TEXT_GENERATION",
        "tenantId": _TENANT,
        "source": "tenant",
        "compiledConfig": compiled,
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
                "slug": "arcaai-pre-summarization",
                "versionId": "agent-1",
                "versionNumber": 4,
                "tenantId": _TENANT,
                "source": "tenant",
            },
            "modelSlug": "lms-gemma",
            "provider": "lm-studio",
            "model": "gemma-4-e2b-it-qat",
            "resolvedPrompt": resolved_prompt,
            "instruction": instruction,
            "parameters": {},
            "tools": [],
            "fundingTier": "platform",
        },
        "textFallback": {"autoSwitch": False, "chain": []},
    }


_COMPOSITE = {
    "source": "composite",
    "content": "Base.",
    "join": "\n\n",
    "fragments": [
        {"key": "base", "source": "inline", "content": "Base.", "when": None},
        {"key": "revisit", "source": "inline", "content": "Revisit.", "when": "true"},
        {"key": "peds", "source": "inline", "content": "Minor.", "when": "false"},
    ],
}
_INLINE = {"source": "inline", "content": "Summarise."}


class _StubApi:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer = answer

    async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
        return self.answer

    async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"phiEnabled": False, "phiFailClosed": True}


class _Result:
    content = "A pre-summary."
    provider = "lm-studio"
    model = "gemma-4-e2b-it-qat"
    usage = {"prompt_tokens": 812, "completion_tokens": 344}
    stats = {"provider": "lm-studio", "model": "gemma-4-e2b-it-qat", "prompt_tokens": 812}


class _StubText:
    calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> _Result:
        _StubText.calls.append(kwargs)
        return _Result()


@pytest.fixture
def run(monkeypatch: pytest.MonkeyPatch):
    recorded: list[dict[str, Any]] = []
    _StubText.calls = []

    async def _record_generation(_payload: Any, **kwargs: Any) -> None:
        recorded.append(kwargs)

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)
    monkeypatch.setattr(core, "record_generation_and_flush", _record_generation)
    monkeypatch.setattr(core, "_phi_redactor", lambda: None)
    monkeypatch.setattr(core, "_text_client", lambda _settings: _StubText())

    async def _go(
        resolved_prompt: dict[str, Any], instruction: dict[str, Any]
    ) -> tuple[list[dict[str, Any]], Any]:
        monkeypatch.setattr(
            core, "_api_client", lambda _settings: _StubApi(_wire(resolved_prompt, instruction))
        )
        result = await core.interpreter_core_agent(_payload())
        return recorded, result

    return _go


class TestCoreAgentStampsTheSelectedFragments:
    async def test_a_composite_generation_records_the_selected_keys_on_the_node_step(
        self, run
    ) -> None:
        recorded, result = await run(_COMPOSITE, {"fragments": _COMPOSITE["fragments"]})
        assert result.status == "SUCCEEDED"
        assert result.prompt_fragments == ["base", "revisit"]
        assert len(recorded) == 1
        assert recorded[0]["node_stats"] == {"prompt_fragments": ["base", "revisit"]}
        # The prompt that went to TEXT is the composition — the excluded fragment is absent.
        assert _StubText.calls[0]["system_prompt"] == "Base.\n\nRevisit."

    async def test_a_single_body_generation_records_no_node_stats(self, run) -> None:
        recorded, result = await run(_INLINE, {"systemPrompt": "Summarise."})
        assert result.status == "SUCCEEDED"
        assert result.prompt_fragments is None
        assert "node_stats" not in recorded[0]
