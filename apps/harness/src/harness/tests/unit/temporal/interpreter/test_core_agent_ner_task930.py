"""TASK-930 — `core.agent` runs a NAMED_ENTITY_RECOGNITION agent, and a declared
``outputSchema`` becomes an engine constraint.

Two gaps are closed here, and they are related: both are places where the durable lane knew
LESS about an agent than the gateway did.

1. **§2.4 — the task switch had no NER arm.** ``interpreter_core_agent`` dispatched
   TEXT_GENERATION, then SPEECH_TO_TEXT, then fell THROUGH to ``_run_speech`` for everything
   else. A NER agent therefore reached the TTS path and degraded with "the resolved TTS agent
   names no `voice`" — a message about a control the author never declared, for a task the
   node was never told about. The arm is explicit now, and the fallthrough is gone.

2. **§5 — ``outputSchema`` was documentation.** ``_run_text_generation`` built a
   ``response_format`` only from ``parameters.responseFormat``, so an agent that PUBLISHED a
   ``{ case_note, redactions }`` contract was handed prose and its `core.output` node then
   failed the schema check it could have passed. The declared schema is now sent as a
   ``json_schema`` constraint — unless the author set ``responseFormat``, which always wins.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput, ResolvedAgent
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"
_TEXT = "Prescribed metformin 500mg daily."

_NER_WIRE: dict[str, Any] = {
    "agentId": "agent-ner",
    "agentVersionId": "agent-ner",
    "slug": "medical-ner",
    "versionNumber": 1,
    "task": "NAMED_ENTITY_RECOGNITION",
    "tenantId": _TENANT,
    "source": "tenant",
    "compiledConfig": {
        "task": "NAMED_ENTITY_RECOGNITION",
        "service": None,
        "model": {
            "id": "m-ner",
            "slug": "medical-ner",
            "provider": "built-in",
            "taskType": "TOKEN_CLASSIFICATION",
        },
        "fallbacks": [],
        "instruction": {"labels": ["MEDICATION", "DOSAGE"]},
        "resolvedPrompt": None,
        "parameters": {"threshold": 0.4, "aggregation": "max"},
        "inputSchema": {"type": "object", "required": ["text"]},
        "outputSchema": {"type": "object", "required": ["entities"]},
        "tools": [],
        "protocols": ["http"],
    },
    "models": [
        {
            "role": "primary",
            "slug": "medical-ner",
            "sourceUri": "blaze999/Medical-NER",
            "sourceRevision": "main",
            "localPath": "/mnt/models-bucket/medical-ner",
            "checksum": None,
            "format": "SAFETENSOR",
            "computeType": "float32",
            "provider": "built-in",
            "tenantId": "00000000-0000-0000-0000-000000000000",
        }
    ],
}

_ENTITIES = [
    {
        "id": "e1",
        "text": "metformin",
        "normalized_text": "metformin",
        "entity_type": "MEDICATION",
        "confidence": 0.94,
        "position": {"start": 11, "end": 20},
    },
    {
        "id": "e2",
        "text": "500mg",
        "normalized_text": "500mg",
        "entity_type": "DOSAGE",
        "confidence": 0.81,
        "position": {"start": 21, "end": 26},
    },
]


class _StubApi:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer = answer

    async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
        return self.answer


class _StubNlp:
    def __init__(self, entities: list[dict[str, Any]] | None = None) -> None:
        self.token_calls: list[dict[str, Any]] = []
        self._entities = _ENTITIES if entities is None else entities

    async def classify_tokens_raw(self, text: str, **kwargs: Any) -> dict[str, Any]:
        self.token_calls.append({"text": text, **kwargs})
        return {"entities": self._entities, "model_version": "blaze999/Medical-NER", "vitals": None}


@pytest.fixture
def ner_stubs(monkeypatch: pytest.MonkeyPatch):
    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)

    def _install(wire: dict[str, Any] | None = None, entities: list[dict[str, Any]] | None = None):
        nlp = _StubNlp(entities)
        monkeypatch.setattr(core, "_api_client", lambda _settings: _StubApi(wire or _NER_WIRE))
        monkeypatch.setattr(core, "_nlp_client", lambda _settings: nlp)
        return nlp

    return _install


def _payload(**config: Any) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="agent1",
        node_type="core.agent",
        config={"agentRef": {"slug": "medical-ner"}, **config},
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs={"in": _TEXT},
        run_payload={},
        run_id=_RUN,
    )


class TestTheMirrorAdmitsTheTask:
    def test_a_ner_resolve_answer_validates(self) -> None:
        # Without the widened `AgentTask` Literal this raises, and the node degrades as
        # `agent_unresolvable` — an error about resolution for an agent that resolved fine.
        resolved = ResolvedAgent.model_validate(_NER_WIRE)
        assert resolved.task == "NAMED_ENTITY_RECOGNITION"
        assert resolved.model.source_uri == "blaze999/Medical-NER"


class TestNerDispatch:
    @pytest.mark.asyncio
    async def test_the_task_switch_routes_ner_to_the_token_classification_call(
        self, ner_stubs
    ) -> None:
        nlp = ner_stubs()

        result = await core.interpreter_core_agent(_payload())

        assert result.status == "SUCCEEDED"
        assert len(nlp.token_calls) == 1
        call = nlp.token_calls[0]
        assert call["text"] == _TEXT
        assert call["tenant_id"] == _TENANT
        # The registry facts the gateway resolved travel unaltered — nothing is invented here.
        assert call["model_name"] == "blaze999/Medical-NER"
        assert call["model_path"] == "/mnt/models-bucket/medical-ner"

    @pytest.mark.asyncio
    async def test_the_agents_labels_and_threshold_reach_the_extractor(self, ner_stubs) -> None:
        nlp = ner_stubs()

        await core.interpreter_core_agent(_payload())

        call = nlp.token_calls[0]
        assert call["labels"] == ["MEDICATION", "DOSAGE"]
        assert call["threshold"] == 0.4
        assert call["aggregation_strategy"] == "max"

    @pytest.mark.asyncio
    async def test_the_output_ports_carry_the_entities_and_pass_the_text_through(
        self, ner_stubs
    ) -> None:
        ner_stubs()

        result = await core.interpreter_core_agent(_payload())

        assert result.output is not None
        # §2.3's output schema, offsets and all — not `apps/nlp`'s own entity vocabulary.
        assert result.output["data"] == {
            "entities": [
                {
                    "text": "metformin",
                    "label": "MEDICATION",
                    "start": 11,
                    "end": 20,
                    "score": 0.94,
                },
                {"text": "500mg", "label": "DOSAGE", "start": 21, "end": 26, "score": 0.81},
            ]
        }
        # `out` is the INPUT text: a downstream node bound to this agent must still see the
        # document, exactly as `core.classify` passes its text through.
        assert result.output["out"] == _TEXT
        assert result.output["agent"]["slug"] == "medical-ner"

    @pytest.mark.asyncio
    async def test_no_bound_text_degrades_rather_than_classifying_nothing(self, ner_stubs) -> None:
        nlp = ner_stubs()

        payload = _payload()
        payload.bound_inputs = {}
        result = await core.interpreter_core_agent(payload)

        assert result.status == "DEGRADED"
        assert nlp.token_calls == []

    @pytest.mark.asyncio
    async def test_an_nlp_failure_degrades_the_node_and_never_raises(self, ner_stubs) -> None:
        from harness.services.nlp_client import NlpServiceError

        nlp = ner_stubs()

        async def _boom(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
            raise NlpServiceError("nlp is down")

        nlp.classify_tokens_raw = _boom  # type: ignore[method-assign]

        result = await core.interpreter_core_agent(_payload())

        assert result.status == "DEGRADED"
        assert result.reason is not None and "core.agent" in result.reason


class TestOutputSchemaResponseFormat:
    """§5 — the ONE rule, mirrored from `agent-schemas.ts`."""

    def test_a_declared_object_schema_becomes_a_json_schema_constraint(self) -> None:
        schema = {"type": "object", "properties": {"case_note": {"type": "string"}}}

        assert core.output_schema_response_format("casenote-finalization", schema, {}) == {
            "type": "json_schema",
            "json_schema": {
                "name": "casenote_finalization_output",
                "schema": schema,
                "strict": True,
            },
        }

    def test_an_explicit_response_format_parameter_always_wins(self) -> None:
        schema = {"type": "object", "properties": {"case_note": {"type": "string"}}}

        assert core.output_schema_response_format("a", schema, {"responseFormat": "json"}) is None
        # Including when it says plain text — an author's opt-out is an opt-out.
        assert core.output_schema_response_format("a", schema, {"responseFormat": "text"}) is None

    def test_the_task_default_constrains_nothing(self) -> None:
        # `AGENT_IO_DEFAULTS.TEXT_GENERATION.outputSchema` — declared by every agent that
        # declared nothing, so enforcing it would constrain every agent on the platform.
        default = {
            "type": "object",
            "required": ["text"],
            "properties": {"text": {"type": "string"}},
        }
        assert core.output_schema_response_format("a", default, {}) is None

    def test_a_schema_an_engine_cannot_constrain_to_is_ignored(self) -> None:
        assert core.output_schema_response_format("a", {"type": "string"}, {}) is None
        assert core.output_schema_response_format("a", {"type": "object"}, {}) is None
        assert core.output_schema_response_format("a", None, {}) is None

    def test_the_name_is_sanitised_the_same_way_the_typescript_rule_sanitises_it(self) -> None:
        schema = {"type": "object", "properties": {"x": {"type": "string"}}}
        answer = core.output_schema_response_format("arcaai-gen.summary v2", schema, {})

        assert answer is not None
        assert answer["json_schema"]["name"] == "arcaai_gen_summary_v2_output"
