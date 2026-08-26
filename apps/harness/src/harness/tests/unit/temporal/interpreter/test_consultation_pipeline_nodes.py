"""Node-activity tests for the ten consultation-palette nodes wired after TASK-731.

TASK-731 registered three of the palette's thirteen node types and left ten specified but
unwired, which made the palette unbuildable: `DRAFT_CONSULTATION_RULE_SET` names nine node types
by key and the registry served three of them. These are the wrappers that close that gap —
grouped by pipeline stage in `nodes/consultation_{capture,nlp,compose,verify,persist}.py`.

Each wrapper is a thin `NodeActivityInput -> NodeActivityResult` adapter over the activity
`contracts/palette-contract.md` §1 already names as that node's compile target, so what these
tests assert is the ADAPTER: identity read from `run_payload` (never `config`), data read
generically from `bound_inputs` (never off a fixed port name), and CR-14's degrade-never-raise
posture on every failure path. The wrapped activities have their own tests elsewhere and are
stubbed here.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from harness.sensors.base import NEREntity
from harness.services.api_client import ApiServiceError
from harness.services.nlp_client import NlpServiceError
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import consultation_capture as caps
from harness.temporal.interpreter.nodes import consultation_compose as compose
from harness.temporal.interpreter.nodes import consultation_nlp as nlp
from harness.temporal.interpreter.nodes import consultation_persist as persist
from harness.temporal.interpreter.nodes import consultation_verify as verify
from harness.temporal.interpreter.registry import NODE_REGISTRY

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = {"consultationId": "c1", "externalPatientId": "p1", "userId": "u1"}


def _payload(node_type: str, **overrides) -> NodeActivityInput:
    base = {
        "node_id": "n1",
        "node_type": node_type,
        "config": {},
        "tenant_id": _TENANT,
        "sandbox": False,
        "bound_inputs": {},
        "run_payload": dict(_RUN),
    }
    base.update(overrides)
    return NodeActivityInput(**base)


class _Obj:
    """Minimal stand-in for a wrapped activity's pydantic result."""

    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


# ---------------------------------------------------------------------------
# N-2 consultation.captureBinding
# ---------------------------------------------------------------------------


class TestCaptureBinding:
    @pytest.mark.asyncio
    async def test_start_dispatches_livedoc_start(self, monkeypatch):
        started = AsyncMock(return_value=_Obj(ok=True))
        monkeypatch.setattr(caps, "livedoc_start", started)
        monkeypatch.setattr(
            caps, "livedoc_stop", AsyncMock(side_effect=AssertionError("wrong leg"))
        )

        result = await caps.interpreter_consultation_capture_binding(
            _payload("consultation.captureBinding", config={"action": "start"})
        )

        assert result.status == "SUCCEEDED"
        assert result.output == {"action": "start", "consultationId": "c1"}
        assert started.await_count == 1
        # Identity comes from run_payload, never from config.
        assert started.await_args.args[0].consultation_id == "c1"
        assert started.await_args.args[0].tenant_id == _TENANT

    @pytest.mark.asyncio
    async def test_stop_dispatches_livedoc_stop(self, monkeypatch):
        stopped = AsyncMock(return_value=_Obj(ok=True))
        monkeypatch.setattr(caps, "livedoc_stop", stopped)
        result = await caps.interpreter_consultation_capture_binding(
            _payload("consultation.captureBinding", config={"action": "stop"})
        )
        assert result.status == "SUCCEEDED"
        assert stopped.await_count == 1

    @pytest.mark.asyncio
    async def test_missing_action_degrades_rather_than_guessing_start(self):
        result = await caps.interpreter_consultation_capture_binding(
            _payload("consultation.captureBinding")
        )
        assert result.status == "DEGRADED"
        assert "is not 'start' or 'stop'" in result.reason

    @pytest.mark.asyncio
    async def test_no_consultation_id_degrades(self):
        result = await caps.interpreter_consultation_capture_binding(
            _payload("consultation.captureBinding", config={"action": "start"}, run_payload={})
        )
        assert result.status == "DEGRADED"
        assert "consultationId" in result.reason

    @pytest.mark.asyncio
    async def test_unreachable_livedoc_degrades_never_raises(self, monkeypatch):
        monkeypatch.setattr(caps, "livedoc_start", AsyncMock(side_effect=ApiServiceError("down")))
        result = await caps.interpreter_consultation_capture_binding(
            _payload("consultation.captureBinding", config={"action": "start"})
        )
        assert result.status == "DEGRADED"


# ---------------------------------------------------------------------------
# N-3 consultation.extractEntities / N-4 consultation.bindTerminology
# ---------------------------------------------------------------------------


def _entity(text: str = "aspirin", **codes) -> NEREntity:
    """A real ``NEREntity`` — ``PersistEntitiesInput`` validates the list, so a loose stub would
    only prove the stub."""
    return NEREntity(text=text, label="DRUG", start=0, end=len(text), **codes)


class TestExtractEntities:
    @pytest.mark.asyncio
    async def test_extracts_then_persists(self, monkeypatch):
        extract = AsyncMock(return_value=_Obj(entities=[_entity()], reused=False))
        persist_call = AsyncMock(return_value=_Obj(saved_count=1, entity_ids=["e1"]))
        monkeypatch.setattr(nlp, "extract_entities", extract)
        monkeypatch.setattr(nlp, "persist_entities", persist_call)

        result = await nlp.interpreter_consultation_extract_entities(
            _payload(
                "consultation.extractEntities",
                bound_inputs={"in": {"text": "patient takes aspirin"}},
            )
        )

        assert result.status == "SUCCEEDED"
        assert result.output["count"] == 1
        assert result.output["persisted"] == 1
        assert extract.await_args.args[0].text == "patient takes aspirin"
        assert extract.await_args.args[0].tenant_id == _TENANT

    @pytest.mark.asyncio
    async def test_persist_false_skips_the_write_leg(self, monkeypatch):
        monkeypatch.setattr(
            nlp, "extract_entities", AsyncMock(return_value=_Obj(entities=[], reused=False))
        )
        monkeypatch.setattr(
            nlp, "persist_entities", AsyncMock(side_effect=AssertionError("must not persist"))
        )
        result = await nlp.interpreter_consultation_extract_entities(
            _payload(
                "consultation.extractEntities",
                config={"persist": False},
                bound_inputs={"in": {"text": "text"}},
            )
        )
        assert result.status == "SUCCEEDED"
        assert result.output["persisted"] == 0

    @pytest.mark.asyncio
    async def test_persist_failure_degrades_but_still_returns_the_entities(self, monkeypatch):
        monkeypatch.setattr(
            nlp,
            "extract_entities",
            AsyncMock(return_value=_Obj(entities=[_entity()], reused=False)),
        )
        monkeypatch.setattr(nlp, "persist_entities", AsyncMock(side_effect=ApiServiceError("down")))
        result = await nlp.interpreter_consultation_extract_entities(
            _payload("consultation.extractEntities", bound_inputs={"in": {"text": "text"}})
        )
        assert result.status == "DEGRADED"
        assert result.output is not None and result.output["count"] == 1

    @pytest.mark.asyncio
    async def test_nlp_failure_degrades_never_raises(self, monkeypatch):
        monkeypatch.setattr(nlp, "extract_entities", AsyncMock(side_effect=NlpServiceError("boom")))
        result = await nlp.interpreter_consultation_extract_entities(
            _payload("consultation.extractEntities", bound_inputs={"in": {"text": "text"}})
        )
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_no_bound_text_degrades(self):
        result = await nlp.interpreter_consultation_extract_entities(
            _payload("consultation.extractEntities")
        )
        assert result.status == "DEGRADED"


class TestBindTerminology:
    @staticmethod
    def _bound_entities() -> dict:
        return {
            "in": {
                "entities": [
                    {
                        "text": "aspirin",
                        "label": "DRUG",
                        "start": 0,
                        "end": 7,
                        "score": 1.0,
                        "snomed_code": "1191",
                    }
                ]
            }
        }

    @pytest.mark.asyncio
    async def test_no_bound_entities_degrades(self):
        result = await nlp.interpreter_consultation_bind_terminology(
            _payload("consultation.bindTerminology")
        )
        assert result.status == "DEGRADED"
        assert "no entities bound" in result.reason

    @pytest.mark.asyncio
    async def test_no_terminology_server_degrades_and_passes_entities_through(self, monkeypatch):
        monkeypatch.setattr(nlp, "get_settings", lambda: object())
        monkeypatch.setattr(
            nlp, "_api_client", lambda _s: _Obj(get_policy=AsyncMock(return_value={}))
        )
        result = await nlp.interpreter_consultation_bind_terminology(
            _payload("consultation.bindTerminology", bound_inputs=self._bound_entities())
        )
        assert result.status == "DEGRADED"
        assert "no enabled MCP server" in result.reason
        # The coverage gap is SURFACED, never silently dropped (CR-19).
        assert result.output is not None
        assert result.output["unmapped"] == []
        assert len(result.output["entities"]) == 1

    @pytest.mark.asyncio
    async def test_unmapped_output_key_names_the_published_key(self, monkeypatch):
        monkeypatch.setattr(nlp, "get_settings", lambda: object())
        monkeypatch.setattr(
            nlp, "_api_client", lambda _s: _Obj(get_policy=AsyncMock(return_value={}))
        )
        result = await nlp.interpreter_consultation_bind_terminology(
            _payload(
                "consultation.bindTerminology",
                config={"unmappedOutputKey": "unmappedTerms", "purposeScope": "terminology"},
                bound_inputs=self._bound_entities(),
            )
        )
        assert result.output is not None
        assert "unmappedTerms" in result.output

    @pytest.mark.asyncio
    async def test_policy_fetch_failure_degrades_never_raises(self, monkeypatch):
        monkeypatch.setattr(nlp, "get_settings", lambda: object())
        monkeypatch.setattr(
            nlp,
            "_api_client",
            lambda _s: _Obj(get_policy=AsyncMock(side_effect=ApiServiceError("down"))),
        )
        result = await nlp.interpreter_consultation_bind_terminology(
            _payload("consultation.bindTerminology", bound_inputs=self._bound_entities())
        )
        assert result.status == "DEGRADED"

    def test_terminology_args_collect_every_resolved_code(self):
        entities = [
            NEREntity(text="aspirin", label="DRUG", start=0, end=7, snomed_code="1191"),
            NEREntity(text="HbA1c", label="TEST", start=8, end=13, loinc_code="4548-4"),
        ]
        args = nlp._terminology_args(entities)
        assert args["codes"] == ["1191", "4548-4"]
        assert args["terms"] == ["aspirin", "HbA1c"]


# ---------------------------------------------------------------------------
# N-6/N-7/N-8 retrieveEvidence / assemblePrompt / synthesize
# ---------------------------------------------------------------------------


class TestRetrieveEvidence:
    @pytest.mark.asyncio
    async def test_publishes_prompt_block_and_chunk_ids(self, monkeypatch):
        retrieved = _Obj(
            prompt_block="[[chunk:1]] evidence",
            chunks=[_Obj(chunk_id="k1"), _Obj(chunk_id="k2")],
            degraded=False,
        )
        monkeypatch.setattr(compose, "retrieve_context", AsyncMock(return_value=retrieved))
        result = await compose.interpreter_consultation_retrieve_evidence(
            _payload("consultation.retrieveEvidence")
        )
        assert result.status == "SUCCEEDED"
        # TASK-809 OD-15: published under the `context` key this node's `context<schemaRef>`
        # output socket declares, so a bound consumer receives a context OBJECT rather than a
        # flat dict with no key for the socket to name.
        assert result.output["context"]["chunkIds"] == ["k1", "k2"]
        assert result.output["context"]["text"] == "[[chunk:1]] evidence"

    @pytest.mark.asyncio
    async def test_degraded_backend_degrades_with_partial_output(self, monkeypatch):
        monkeypatch.setattr(
            compose,
            "retrieve_context",
            AsyncMock(return_value=_Obj(prompt_block="", chunks=[], degraded=True)),
        )
        result = await compose.interpreter_consultation_retrieve_evidence(
            _payload("consultation.retrieveEvidence")
        )
        assert result.status == "DEGRADED"
        assert result.output is not None and result.output["context"]["chunkCount"] == 0

    @pytest.mark.asyncio
    async def test_unreachable_retrieval_degrades_never_raises(self, monkeypatch):
        monkeypatch.setattr(
            compose, "retrieve_context", AsyncMock(side_effect=ApiServiceError("down"))
        )
        result = await compose.interpreter_consultation_retrieve_evidence(
            _payload("consultation.retrieveEvidence")
        )
        assert result.status == "DEGRADED"


class TestAssemblePrompt:
    @pytest.mark.asyncio
    async def test_publishes_the_assembled_prompt(self, monkeypatch):
        assembled = _Obj(
            user_prompt="write the note",
            system_prompt="you are a scribe",
            prompt_template_id="t1",
            prompt_version="3",
            resolved_from="TENANT",
        )
        call = AsyncMock(return_value=assembled)
        monkeypatch.setattr(compose, "assemble_prompt", call)
        result = await compose.interpreter_consultation_assemble_prompt(
            _payload("consultation.assemblePrompt", config={"dnaStyleId": "d1"})
        )
        assert result.status == "SUCCEEDED"
        assert result.output["text"] == "write the note"
        assert result.output["promptTemplateId"] == "t1"
        # Selection knobs come from config; identity from run_payload.
        assert call.await_args.args[0].dna_style_id == "d1"
        assert call.await_args.args[0].consultation_id == "c1"

    @pytest.mark.asyncio
    async def test_no_consultation_id_degrades(self):
        result = await compose.interpreter_consultation_assemble_prompt(
            _payload("consultation.assemblePrompt", run_payload={})
        )
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_empty_prompt_degrades(self, monkeypatch):
        monkeypatch.setattr(
            compose,
            "assemble_prompt",
            AsyncMock(
                return_value=_Obj(
                    user_prompt="",
                    system_prompt="",
                    prompt_template_id=None,
                    prompt_version=None,
                    resolved_from="",
                )
            ),
        )
        result = await compose.interpreter_consultation_assemble_prompt(
            _payload("consultation.assemblePrompt")
        )
        assert result.status == "DEGRADED"


class TestSynthesize:
    @pytest.mark.asyncio
    async def test_delegates_to_the_text_generate_node_with_the_payload_untouched(
        self, monkeypatch
    ):
        seen: list[NodeActivityInput] = []

        async def _fake(payload):
            seen.append(payload)
            return _Obj(status="SUCCEEDED", reason=None, output={"text": "draft"})

        monkeypatch.setattr(compose, "interpreter_text_generate", _fake)
        payload = _payload("consultation.synthesize", config={"taskKey": "text.finalize"})
        result = await compose.interpreter_consultation_synthesize(payload)

        assert result.output == {"text": "draft"}
        # The node id/type must stay this node's own so the run trace reads consultation.synthesize.
        assert seen[0] is payload
        assert seen[0].node_type == "consultation.synthesize"


# ---------------------------------------------------------------------------
# N-9/N-10 sensors / inferentialSensors
# ---------------------------------------------------------------------------


class TestSensors:
    @pytest.mark.asyncio
    async def test_publishes_scores_and_citations(self, monkeypatch):
        monkeypatch.setattr(
            verify,
            "run_sensors",
            AsyncMock(
                return_value=_Obj(
                    scores={"coverage": 0.9},
                    citations_map={"c1": ["k1"]},
                    results=[],
                    soap_sections={},
                )
            ),
        )
        result = await verify.interpreter_consultation_sensors(
            _payload("consultation.sensors", bound_inputs={"in": {"text": "the draft note"}})
        )
        assert result.status == "SUCCEEDED"
        # TASK-809 OD-15: the assurance record is ONE object on the `verdict` socket — a flat
        # shape would have let a single-key binding carry `scores` and drop `citationsMap`.
        assert result.output["verdict"]["scores"] == {"coverage": 0.9}
        assert result.output["verdict"]["citationsMap"] == {"c1": ["k1"]}
        # `text` stays at the top level: it is the `document` PASSTHROUGH socket, which is how
        # the note reaches persistence without routing around this verifier (WF-CONS-011).
        assert result.output["text"] == "the draft note"

    @pytest.mark.asyncio
    async def test_no_bound_note_degrades(self):
        result = await verify.interpreter_consultation_sensors(_payload("consultation.sensors"))
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_sensor_crash_degrades_never_fails_the_run(self, monkeypatch):
        # CR-14: "a failing sensor ... must not fail the whole run".
        monkeypatch.setattr(verify, "run_sensors", AsyncMock(side_effect=RuntimeError("boom")))
        result = await verify.interpreter_consultation_sensors(
            _payload("consultation.sensors", bound_inputs={"in": {"text": "note"}})
        )
        assert result.status == "DEGRADED"


class TestInferentialSensors:
    @staticmethod
    def _policy(monkeypatch, **overrides):
        raw = {"judgeProvider": "lm-studio", "judgeModel": "judge-1"}
        raw.update(overrides)
        monkeypatch.setattr(verify, "get_settings", lambda: object())
        monkeypatch.setattr(
            verify, "_api_client", lambda _s: _Obj(get_policy=AsyncMock(return_value=raw))
        )

    @pytest.mark.asyncio
    async def test_missing_judge_selection_fails_closed(self, monkeypatch):
        # Never substitutes an env-selected judge — env carries connection config only.
        self._policy(monkeypatch, judgeProvider=None, judgeModel=None)
        monkeypatch.setattr(
            verify,
            "run_inferential_sensors",
            AsyncMock(side_effect=AssertionError("must not run without a judge")),
        )
        result = await verify.interpreter_consultation_inferential_sensors(
            _payload("consultation.inferentialSensors", bound_inputs={"in": {"text": "note"}})
        )
        assert result.status == "DEGRADED"
        assert "no judge provider/model" in result.reason

    @pytest.mark.asyncio
    async def test_degraded_pass_flags_reduced_assurance(self, monkeypatch):
        self._policy(monkeypatch)
        monkeypatch.setattr(
            verify,
            "run_inferential_sensors",
            AsyncMock(
                return_value=_Obj(
                    results=[],
                    guardrail_decisions={"safety": "pass"},
                    rag_triad_score=0.7,
                    degraded=True,
                )
            ),
        )
        result = await verify.interpreter_consultation_inferential_sensors(
            _payload("consultation.inferentialSensors", bound_inputs={"in": {"text": "note"}})
        )
        assert result.status == "DEGRADED"
        assert result.output["verdict"]["reducedAssurance"] is True

    @pytest.mark.asyncio
    async def test_clean_pass_succeeds_without_reduced_assurance(self, monkeypatch):
        self._policy(monkeypatch)
        monkeypatch.setattr(
            verify,
            "run_inferential_sensors",
            AsyncMock(
                return_value=_Obj(
                    results=[], guardrail_decisions={}, rag_triad_score=0.95, degraded=False
                )
            ),
        )
        result = await verify.interpreter_consultation_inferential_sensors(
            _payload("consultation.inferentialSensors", bound_inputs={"in": {"text": "note"}})
        )
        assert result.status == "SUCCEEDED"
        assert result.output["verdict"]["reducedAssurance"] is False

    @pytest.mark.asyncio
    async def test_no_bound_note_degrades(self):
        result = await verify.interpreter_consultation_inferential_sensors(
            _payload("consultation.inferentialSensors")
        )
        assert result.status == "DEGRADED"


# ---------------------------------------------------------------------------
# N-11/N-12 persistDraft / finalizeAssurance
# ---------------------------------------------------------------------------


class TestPersistDraft:
    @pytest.mark.asyncio
    async def test_persists_the_bound_draft_with_the_bound_verdicts(self, monkeypatch):
        call = AsyncMock(return_value=_Obj(context_item_id="ci1"))
        monkeypatch.setattr(persist, "persist_draft", call)
        result = await persist.interpreter_consultation_persist_draft(
            _payload(
                "consultation.persistDraft",
                config={"occ": True},
                bound_inputs={
                    "in": {
                        "text": "final note",
                        "scores": {"coverage": 0.9},
                        "citationsMap": {"c1": ["k1"]},
                        "reducedAssurance": False,
                        "ragTriadScore": 0.95,
                    }
                },
            )
        )
        assert result.status == "SUCCEEDED"
        assert result.output == {"contextItemId": "ci1", "text": "final note"}
        sent = call.await_args.args[0]
        assert sent.content == "final note"
        assert sent.sensor_scores == {"coverage": 0.9}
        assert sent.reduced_assurance is False
        assert sent.rag_triad_score == 0.95
        assert sent.consultation_id == "c1"

    @pytest.mark.asyncio
    async def test_persists_without_a_verifier_upstream(self, monkeypatch):
        call = AsyncMock(return_value=_Obj(context_item_id="ci1"))
        monkeypatch.setattr(persist, "persist_draft", call)
        result = await persist.interpreter_consultation_persist_draft(
            _payload("consultation.persistDraft", bound_inputs={"in": {"text": "note"}})
        )
        assert result.status == "SUCCEEDED"
        # No scores are FABRICATED when no verifier ran.
        assert call.await_args.args[0].sensor_scores is None

    @pytest.mark.asyncio
    async def test_no_bound_content_degrades(self):
        result = await persist.interpreter_consultation_persist_draft(
            _payload("consultation.persistDraft")
        )
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_no_consultation_id_degrades(self):
        result = await persist.interpreter_consultation_persist_draft(
            _payload(
                "consultation.persistDraft",
                bound_inputs={"in": {"text": "note"}},
                run_payload={},
            )
        )
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_api_failure_degrades_never_raises(self, monkeypatch):
        monkeypatch.setattr(
            persist, "persist_draft", AsyncMock(side_effect=ApiServiceError("down"))
        )
        result = await persist.interpreter_consultation_persist_draft(
            _payload("consultation.persistDraft", bound_inputs={"in": {"text": "note"}})
        )
        assert result.status == "DEGRADED"


class TestFinalizeAssurance:
    @pytest.mark.asyncio
    async def test_binds_the_verdict_to_the_upstream_context_item(self, monkeypatch):
        call = AsyncMock(return_value=_Obj(recorded=True, context_item_id="ci1"))
        monkeypatch.setattr(persist, "finalize_assurance", call)
        result = await persist.interpreter_consultation_finalize_assurance(
            _payload(
                "consultation.finalizeAssurance",
                bound_inputs={
                    "in": {
                        "contextItemId": "ci1",
                        "guardrailDecisions": {"safety": "pass"},
                        "reducedAssurance": True,
                    }
                },
            )
        )
        assert result.status == "SUCCEEDED"
        assert result.output == {"contextItemId": "ci1", "recorded": True}
        assert call.await_args.args[0].context_item_id == "ci1"
        assert call.await_args.args[0].reduced_assurance is True

    @pytest.mark.asyncio
    async def test_no_context_item_degrades_rather_than_inventing_a_target(self, monkeypatch):
        monkeypatch.setattr(
            persist,
            "finalize_assurance",
            AsyncMock(side_effect=AssertionError("must not stamp a verdict on an unknown note")),
        )
        result = await persist.interpreter_consultation_finalize_assurance(
            _payload("consultation.finalizeAssurance")
        )
        assert result.status == "DEGRADED"
        assert "contextItemId" in result.reason

    @pytest.mark.asyncio
    async def test_refused_record_degrades(self, monkeypatch):
        monkeypatch.setattr(
            persist,
            "finalize_assurance",
            AsyncMock(return_value=_Obj(recorded=False, context_item_id="")),
        )
        result = await persist.interpreter_consultation_finalize_assurance(
            _payload(
                "consultation.finalizeAssurance",
                bound_inputs={"in": {"contextItemId": "ci1"}},
            )
        )
        assert result.status == "DEGRADED"


# ---------------------------------------------------------------------------
# Registry shape for the ten new entries
# ---------------------------------------------------------------------------

_NEW_KEYS = (
    "consultation.captureBinding",
    "consultation.extractEntities",
    "consultation.bindTerminology",
    "consultation.retrieveEvidence",
    "consultation.assemblePrompt",
    "consultation.synthesize",
    "consultation.sensors",
    "consultation.inferentialSensors",
    "consultation.persistDraft",
    "consultation.finalizeAssurance",
)


class TestNewRegistryEntries:
    def test_all_ten_are_registered_and_implemented(self):
        for key in _NEW_KEYS:
            assert key in NODE_REGISTRY, key
            assert NODE_REGISTRY[key].implemented is True, key

    def test_none_of_them_is_critical(self):
        # CR-14: only consentGate and hitlGate may be critical.
        for key in _NEW_KEYS:
            assert NODE_REGISTRY[key].critical is False, key

    def test_only_the_context_item_writers_are_external_write(self):
        writers = {
            "consultation.extractEntities",
            "consultation.persistDraft",
            "consultation.finalizeAssurance",
        }
        for key in _NEW_KEYS:
            assert NODE_REGISTRY[key].external_write is (key in writers), key

    def test_every_activity_resolves_to_a_distinct_consultation_activity_name(self):
        names = [NODE_REGISTRY[key].activity_name for key in _NEW_KEYS]
        for name in names:
            assert name.startswith("interpreter.consultation_"), name
        assert len(set(names)) == len(names)
