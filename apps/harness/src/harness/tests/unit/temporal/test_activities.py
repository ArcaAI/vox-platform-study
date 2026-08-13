"""Unit tests for the document-loop activities (input → client mapping).

The orchestration is covered in ``test_doc_workflow`` with stubbed activities;
here we run each *real* activity body in a proper Temporal ``ActivityEnvironment``
with the module-level client factories monkeypatched to deterministic fakes, so
we assert the activity maps its typed input onto the right tool-client call and
returns the typed result. No network I/O.
"""

from __future__ import annotations

import dataclasses
from typing import Any

import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from harness.core.config import Settings
from harness.sensors.base import NEREntity
from harness.sensors.inferential.granite_client import GraniteServiceError
from harness.services.api_client import (
    ApiServiceError,
    AssembleResponse,
    DraftResponse,
    EscalationRecordResponse,
    FinalizeAssuranceResponse,
    PersistEntitiesResponse,
    RecordGateResponse,
    RetractDraftResponse,
)
from harness.services.smr_client import SmrGenerationResult, SmrServiceError
from harness.temporal import activities
from harness.temporal.models import (
    AssembleInput,
    EscalateInput,
    ExtractEntitiesInput,
    FetchPolicyInput,
    FinalizeAssuranceInput,
    GenerateInput,
    PersistDraftInput,
    PersistEntitiesInput,
    RecordGateInput,
    ReportProgressInput,
    RetractDraftInput,
    RetrieveContextInput,
    RunInferentialSensorsInput,
    RunSensorsInput,
)


class _FakeNlp:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def classify_tokens(self, text: str, *, language: str = "en") -> list[NEREntity]:
        self.calls.append((text, language))
        return [NEREntity(text="hypertension", type="DISEASE", start=0, end=12)]


class _FakeSmr:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] = {}

    async def generate(self, **kwargs: Any) -> SmrGenerationResult:
        self.kwargs = kwargs
        return SmrGenerationResult(content="DRAFT", model="m", finish_reason="stop")


class _FakeApi:
    def __init__(self) -> None:
        self.calls: dict[str, dict[str, Any]] = {}

    async def persist_entities(self, consultation_id: str, **kw: Any) -> PersistEntitiesResponse:
        self.calls["persist_entities"] = {"consultation_id": consultation_id, **kw}
        return PersistEntitiesResponse(saved_count=len(kw.get("entities", [])), entity_ids=["e0"])

    async def assemble(self, consultation_id: str, **kw: Any) -> AssembleResponse:
        self.calls["assemble"] = {"consultation_id": consultation_id, **kw}
        return AssembleResponse(user_prompt="U", system_prompt="S")

    async def persist_draft(self, consultation_id: str, **kw: Any) -> DraftResponse:
        self.calls["persist_draft"] = {"consultation_id": consultation_id, **kw}
        return DraftResponse(context_item_id="ctx-1")

    async def record_gate_decision(self, consultation_id: str, **kw: Any) -> RecordGateResponse:
        self.calls["record_gate_decision"] = {"consultation_id": consultation_id, **kw}
        return RecordGateResponse(recorded=True)

    async def finalize_assurance(
        self, consultation_id: str, **kw: Any
    ) -> FinalizeAssuranceResponse:
        self.calls["finalize_assurance"] = {"consultation_id": consultation_id, **kw}
        return FinalizeAssuranceResponse(recorded=True, context_item_id="ctx-1")

    async def record_escalation(self, consultation_id: str, **kw: Any) -> EscalationRecordResponse:
        self.calls["record_escalation"] = {"consultation_id": consultation_id, **kw}
        return EscalationRecordResponse(recorded=True)

    async def retract_draft(self, consultation_id: str, **kw: Any) -> RetractDraftResponse:
        self.calls["retract_draft"] = {"consultation_id": consultation_id, **kw}
        return RetractDraftResponse(retracted=True, context_item_id=kw.get("context_item_id", ""))


class _FakeApiPriors:
    """apps/api read client stub for coded NER priors (returns priors or raises)."""

    def __init__(
        self, *, priors: list[NEREntity] | None = None, error: Exception | None = None
    ) -> None:
        self._priors = priors or []
        self._error = error
        self.calls: list[tuple[str, str]] = []

    async def load_entity_priors(self, consultation_id: str, *, tenant_id: str) -> list[NEREntity]:
        self.calls.append((consultation_id, tenant_id))
        if self._error is not None:
            raise self._error
        return list(self._priors)


class _StubJudge:
    """Deterministic judge stub: ``supported`` unless a marker hits the hypothesis."""

    model = "stub-judge"

    def __init__(self, *, unsupported_markers: tuple[str, ...] = ()) -> None:
        self.calls: list[list[dict[str, str]]] = []
        self._markers = unsupported_markers

    async def complete(self, messages: list[dict[str, str]], **kwargs: Any) -> str:
        self.calls.append(messages)
        content = messages[-1]["content"].lower()
        unsupported = any(marker in content for marker in self._markers)
        return '{"supported": false}' if unsupported else '{"supported": true}'


class _FakeGranite:
    """Stand-in Granite client: canned per-dimension verdicts (or raises)."""

    def __init__(
        self, *, dimensions: dict[str, bool] | None = None, error: Exception | None = None
    ) -> None:
        self.model = "granite-fake"
        self._dimensions = dimensions or {}
        self._error = error
        self.screened: list[str] = []

    async def screen(self, text: str) -> dict[str, bool]:
        self.screened.append(text)
        if self._error is not None:
            raise self._error
        return dict(self._dimensions)


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


class TestExtractEntities:
    @pytest.mark.asyncio
    async def test_delegates_to_nlp_client_and_maps_entities(self, env, monkeypatch):
        fake = _FakeNlp()
        monkeypatch.setattr(activities, "_nlp_client", lambda s: fake)
        result = await env.run(
            activities.extract_entities, ExtractEntitiesInput(text="hi", language="vi")
        )
        assert [e.text for e in result.entities] == ["hypertension"]
        assert result.reused is False
        assert fake.calls == [("hi", "vi")]

    @pytest.mark.asyncio
    async def test_reuses_coded_priors_and_skips_cold_nlp(self, env, monkeypatch):
        """Flag on + CODED priors present ⇒ reuse them AND skip the cold
        NLP pass (the redundancy-kill)."""
        nlp = _FakeNlp()
        priors = [
            NEREntity(text="hypertension", type="DISEASE", start=0, end=12, snomed_code="38341003")
        ]
        api = _FakeApiPriors(priors=priors)
        monkeypatch.setattr(activities, "get_settings", lambda: Settings(ner_priors_enabled=True))
        monkeypatch.setattr(activities, "_nlp_client", lambda s: nlp)
        monkeypatch.setattr(activities, "_api_client", lambda s: api)
        result = await env.run(
            activities.extract_entities,
            ExtractEntitiesInput(
                text="Patient has hypertension.",
                reuse_priors=True,
                consultation_id="c-1",
                tenant_id="t-1",
            ),
        )
        assert result.reused is True
        assert [e.text for e in result.entities] == ["hypertension"]
        assert result.entities[0].snomed_code == "38341003"
        assert nlp.calls == []  # cold NLP pass skipped
        assert api.calls == [("c-1", "t-1")]

    @pytest.mark.asyncio
    async def test_falls_back_to_cold_when_priors_uncoded(self, env, monkeypatch):
        """Priors with NO ontology code fall back to the cold NLP pass
        (inert until the encoder starts populating the codes)."""
        nlp = _FakeNlp()
        api = _FakeApiPriors(priors=[NEREntity(text="cough", type="SYMPTOM", start=0, end=5)])
        monkeypatch.setattr(activities, "get_settings", lambda: Settings(ner_priors_enabled=True))
        monkeypatch.setattr(activities, "_nlp_client", lambda s: nlp)
        monkeypatch.setattr(activities, "_api_client", lambda s: api)
        result = await env.run(
            activities.extract_entities,
            ExtractEntitiesInput(
                text="hi", reuse_priors=True, consultation_id="c-1", tenant_id="t-1"
            ),
        )
        assert result.reused is False
        assert nlp.calls == [("hi", "en")]

    @pytest.mark.asyncio
    async def test_flag_off_ignores_priors_and_runs_cold(self, env, monkeypatch):
        """The ops flag defaults OFF ⇒ coded priors are ignored, cold NLP runs, and NO
        priors read is even attempted (explicit rollout, not a silent flip)."""
        nlp = _FakeNlp()
        api = _FakeApiPriors(priors=[NEREntity(text="x", type="DISEASE", umls_cui="C0020538")])
        monkeypatch.setattr(activities, "get_settings", lambda: Settings(ner_priors_enabled=False))
        monkeypatch.setattr(activities, "_nlp_client", lambda s: nlp)
        monkeypatch.setattr(activities, "_api_client", lambda s: api)
        result = await env.run(
            activities.extract_entities,
            ExtractEntitiesInput(
                text="hi", reuse_priors=True, consultation_id="c-1", tenant_id="t-1"
            ),
        )
        assert result.reused is False
        assert nlp.calls == [("hi", "en")]
        assert api.calls == []

    @pytest.mark.asyncio
    async def test_note_ner_never_reuses_priors(self, env, monkeypatch):
        """The note-NER calls leave reuse_priors=False ⇒ always cold, never a priors read
        (only the transcript pass reuses)."""
        nlp = _FakeNlp()
        api = _FakeApiPriors(priors=[NEREntity(text="x", type="DISEASE", umls_cui="C1")])
        monkeypatch.setattr(activities, "get_settings", lambda: Settings(ner_priors_enabled=True))
        monkeypatch.setattr(activities, "_nlp_client", lambda s: nlp)
        monkeypatch.setattr(activities, "_api_client", lambda s: api)
        result = await env.run(
            activities.extract_entities, ExtractEntitiesInput(text="note", language="en")
        )
        assert result.reused is False
        assert nlp.calls == [("note", "en")]
        assert api.calls == []

    @pytest.mark.asyncio
    async def test_priors_read_failure_falls_back_to_cold(self, env, monkeypatch):
        """A degraded apps/api read (priors are an optimization, not a hard dep) falls
        back to the cold NLP extraction — never fails the pass."""
        nlp = _FakeNlp()
        api = _FakeApiPriors(error=ApiServiceError("apps/api down"))
        monkeypatch.setattr(activities, "get_settings", lambda: Settings(ner_priors_enabled=True))
        monkeypatch.setattr(activities, "_nlp_client", lambda s: nlp)
        monkeypatch.setattr(activities, "_api_client", lambda s: api)
        result = await env.run(
            activities.extract_entities,
            ExtractEntitiesInput(
                text="hi", reuse_priors=True, consultation_id="c-1", tenant_id="t-1"
            ),
        )
        assert result.reused is False
        assert nlp.calls == [("hi", "en")]


class TestGenerate:
    @pytest.mark.asyncio
    async def test_unpacks_hyperparameters_and_passes_response_format(self, env, monkeypatch):
        fake = _FakeSmr()
        monkeypatch.setattr(activities, "_smr_client", lambda s: fake)
        rf = {"type": "json_schema", "json_schema": {"type": "object"}}
        result = await env.run(
            activities.generate,
            GenerateInput(
                prompt="P",
                system_prompt="S",
                response_format=rf,
                hyperparameters={"temperature": 0.3, "max_tokens": 512, "top_p": 0.9},
                provider="azure-openai",
                model="gpt-4o",
            ),
        )
        assert result.content == "DRAFT"
        assert fake.kwargs["prompt"] == "P"
        assert fake.kwargs["system_prompt"] == "S"
        assert fake.kwargs["temperature"] == 0.3
        assert fake.kwargs["max_tokens"] == 512
        assert fake.kwargs["top_p"] == 0.9
        assert fake.kwargs["response_format"] == rf
        assert fake.kwargs["provider"] == "azure-openai"
        assert fake.kwargs["model"] == "gpt-4o"

    @pytest.mark.asyncio
    async def test_threads_smr_stats_onto_activity_result(self, env, monkeypatch):
        """the generate activity result carries the SMR
        ``stats`` block (additive field on ``SmrGenerationResult``; command-neutral —
        no new workflow command). Phase 2 trajectory emitters read it off the result."""
        stats = {
            "stop_reason": "stop",
            "stop_reason_raw": "stop",
            "total_ms": 950,
            "ttft_ms": 60,
            "tokens_per_second": 33.0,
            "prompt_tokens": 25,
            "predicted_tokens": 12,
            "total_tokens": 37,
            "provider": "openai_compat",
            "model": "m",
            "engine_native": None,
        }

        class _StatsSmr:
            async def generate(self, **kwargs: Any) -> SmrGenerationResult:
                return SmrGenerationResult(
                    content="DRAFT", model="m", finish_reason="stop", stats=stats
                )

        monkeypatch.setattr(activities, "_smr_client", lambda s: _StatsSmr())
        result = await env.run(activities.generate, GenerateInput(prompt="P"))
        assert result.content == "DRAFT"
        assert result.stats == stats

    @pytest.mark.asyncio
    async def test_passes_stable_idempotency_key_across_reruns(self, env, monkeypatch):
        """The generate activity supplies a deterministic Idempotency-Key
        (``workflow_run:activity_id`` via ``_idempotency_key``) so a worker-crash re-delivery
        reuses it and SMR dedups the replay instead of re-billing the model. The key is stable
        across re-runs of the SAME logical activity (ActivityEnvironment fixes the ids)."""
        fake = _FakeSmr()
        monkeypatch.setattr(activities, "_smr_client", lambda s: fake)

        await env.run(activities.generate, GenerateInput(prompt="P"))
        first_key = fake.kwargs["idempotency_key"]
        await env.run(activities.generate, GenerateInput(prompt="P"))
        second_key = fake.kwargs["idempotency_key"]

        # _idempotency_key() → workflow_run_id:activity_id (ActivityEnvironment defaults).
        assert first_key == "test-run:test"
        # A re-delivery of the same logical generate reuses the SAME key (replay dedups).
        assert second_key == first_key


class TestGeneratePostSendFailure:
    """A post-send SMR failure (the model may have generated) must be
    NON-retryable at the Temporal layer too, so ``_GENERATE_RETRY`` never re-runs the
    activity (a re-run re-invokes the model). A pre-send failure stays retryable — the
    model never ran, so a retry is safe (and the SMR-down invariant still fails the loop)."""

    @pytest.mark.asyncio
    async def test_post_send_failure_raises_non_retryable(self, env, monkeypatch):
        class _LostSmr:
            async def generate(self, **kw: Any) -> SmrGenerationResult:
                raise SmrServiceError("response lost after dispatch", after_send=True)

        monkeypatch.setattr(activities, "_smr_client", lambda s: _LostSmr())
        with pytest.raises(ApplicationError) as ei:
            await env.run(activities.generate, GenerateInput(prompt="P"))
        assert ei.value.non_retryable is True

    @pytest.mark.asyncio
    async def test_pre_send_failure_propagates_as_retryable(self, env, monkeypatch):
        class _DownSmr:
            async def generate(self, **kw: Any) -> SmrGenerationResult:
                raise SmrServiceError("connection refused", after_send=False)

        monkeypatch.setattr(activities, "_smr_client", lambda s: _DownSmr())
        # Propagates unchanged (NOT wrapped non-retryable) → Temporal retries per policy.
        with pytest.raises(SmrServiceError):
            await env.run(activities.generate, GenerateInput(prompt="P"))


class _FakePolicyApi:
    """apps/api ``/policy`` client stub — succeeds or raises a canned error."""

    def __init__(self, *, error: Exception | None = None) -> None:
        self._error = error
        self.calls: list[tuple[str, str | None]] = []

    async def get_policy(self, tenant_id: str, consultation_id: str | None = None) -> dict:
        self.calls.append((tenant_id, consultation_id))
        if self._error is not None:
            raise self._error
        return {"version": 1}


class TestFetchPolicy:
    """F-23: 401/403 from the gateway must be distinguishable from a transient outage."""

    @pytest.mark.asyncio
    async def test_401_raises_non_retryable_policy_auth_error(self, env, monkeypatch):
        fake = _FakePolicyApi(
            error=ApiServiceError(
                "apps/api /policy failed: Client error '401 Unauthorized' for url "
                "'http://x/policy'"
            )
        )
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        with pytest.raises(ApplicationError) as exc_info:
            await env.run(activities.fetch_policy, FetchPolicyInput(tenant_id="t-1"))
        assert exc_info.value.type == "PolicyAuthError"
        assert exc_info.value.non_retryable is True

    @pytest.mark.asyncio
    async def test_403_raises_non_retryable_policy_auth_error(self, env, monkeypatch):
        fake = _FakePolicyApi(
            error=ApiServiceError(
                "apps/api /policy failed: Client error '403 Forbidden' for url " "'http://x/policy'"
            )
        )
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        with pytest.raises(ApplicationError) as exc_info:
            await env.run(activities.fetch_policy, FetchPolicyInput(tenant_id="t-1"))
        assert exc_info.value.type == "PolicyAuthError"
        assert exc_info.value.non_retryable is True

    @pytest.mark.asyncio
    async def test_transient_outage_stays_a_plain_api_service_error(self, env, monkeypatch):
        fake = _FakePolicyApi(error=ApiServiceError("apps/api /policy failed: connection refused"))
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        with pytest.raises(ApiServiceError):
            await env.run(activities.fetch_policy, FetchPolicyInput(tenant_id="t-1"))

    @pytest.mark.asyncio
    async def test_success_returns_policy_unaffected(self, env, monkeypatch):
        fake = _FakePolicyApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        result = await env.run(activities.fetch_policy, FetchPolicyInput(tenant_id="t-1"))
        assert result.version == 1
        assert fake.calls == [("t-1", None)]


class TestApiActivities:
    @pytest.mark.asyncio
    async def test_persist_entities_forwards_payload(self, env, monkeypatch):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        result = await env.run(
            activities.persist_entities,
            PersistEntitiesInput(
                consultation_id="c-1",
                tenant_id="t-1",
                context_item_id="ctx-t1",
                entities=[NEREntity(text="x", type="DISEASE", start=0, end=1)],
                user_id="u-1",
            ),
        )
        assert result.saved_count == 1
        call = fake.calls["persist_entities"]
        assert call["consultation_id"] == "c-1"
        assert call["tenant_id"] == "t-1"
        assert call["context_item_id"] == "ctx-t1"
        # The key is derived from the WRITE (consultation + a digest
        # of the entity set), NOT from the run — a second workflow EXECUTION
        # duplicates this callback, which a run-scoped key cannot dedup. Every
        # OTHER callback keeps the run-scoped key (their duplicate is only ever
        # an activity retry).
        assert call["idempotency_key"] == activities._entities_idempotency_key(
            "c-1", [NEREntity(text="x", type="DISEASE", start=0, end=1)]
        )
        assert call["idempotency_key"].startswith("entities:c-1:")
        assert "test-run" not in call["idempotency_key"]

    @pytest.mark.asyncio
    async def test_assemble_prompt_forwards_consultation(self, env, monkeypatch):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        result = await env.run(
            activities.assemble_prompt,
            AssembleInput(consultation_id="c-1", tenant_id="t-1", conversation_language="en"),
        )
        assert result.user_prompt == "U"
        assert fake.calls["assemble"]["consultation_id"] == "c-1"

    @pytest.mark.asyncio
    async def test_persist_draft_forwards_scores_and_citations(self, env, monkeypatch):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        result = await env.run(
            activities.persist_draft,
            PersistDraftInput(
                consultation_id="c-1",
                tenant_id="t-1",
                content="DRAFT",
                sensor_scores={"entity_faithfulness": 1.0},
                citations_map={"claims": []},
                gate_decision="PASS",
                is_auto_generated=True,
            ),
        )
        assert result.context_item_id == "ctx-1"
        call = fake.calls["persist_draft"]
        assert call["content"] == "DRAFT"
        assert call["gate_decision"] == "PASS"
        assert call["sensor_scores"] == {"entity_faithfulness": 1.0}
        # The DRAFT persist is keyed on the WRITE (consultation + note),
        # not on `{run_id}:{activity_id}`: its duplicate is a second workflow
        # EXECUTION, which a run-scoped key cannot dedup. Every OTHER callback keeps
        # the run-scoped key (their duplicate is only ever an activity retry).
        assert call["idempotency_key"] == activities._draft_idempotency_key("c-1", "DRAFT")
        assert call["idempotency_key"].startswith("draft:c-1:")

    @pytest.mark.asyncio
    async def test_persist_draft_forwards_guardrail_decisions_and_reduced_assurance(
        self, env, monkeypatch
    ):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        guardrail = {
            "groundedness": {"decision": "PASS"},
            "safety": {"decision": "FLAG", "flaggedDimensions": ["violence"]},
        }
        await env.run(
            activities.persist_draft,
            PersistDraftInput(
                consultation_id="c-1",
                tenant_id="t-1",
                content="DRAFT",
                guardrail_decisions=guardrail,
                reduced_assurance=True,
                rag_triad_score=0.91,
                gate_decision="FLAG",
            ),
        )
        call = fake.calls["persist_draft"]
        assert call["guardrail_decisions"] == guardrail
        assert call["reduced_assurance"] is True
        assert call["rag_triad_score"] == 0.91

    @pytest.mark.asyncio
    async def test_draft_key_is_byte_identical_across_workflow_executions(self, monkeypatch):
        """The draft persist key must identify the WRITE, never the execution.

        ``HarnessDocWorkflow`` has two start sites (the legacy gateway start and the
        loop's ``harness.finalize`` child) that both target ``harness-doc-{id}`` without
        an ``id_reuse_policy``, so a SECOND execution runs whenever the first has already
        closed. A key derived from ``workflow_run_id`` differs per execution, so the
        gateway sees two unrelated writes and the consultation ends up with two notes.
        """
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        payload = PersistDraftInput(consultation_id="c-1", tenant_id="t-1", content="DRAFT")

        keys = []
        for run_id, activity_id in (("run-A", "act-3"), ("run-B", "act-91")):
            env = ActivityEnvironment()
            env.info = dataclasses.replace(
                ActivityEnvironment.default_info(),
                workflow_run_id=run_id,
                activity_id=activity_id,
            )
            await env.run(activities.persist_draft, payload)
            keys.append(fake.calls["persist_draft"]["idempotency_key"])

        assert keys[0] == keys[1], "two executions over the same input must share one key"
        assert "run-A" not in keys[0] and "run-B" not in keys[0]

    @pytest.mark.asyncio
    async def test_draft_key_changes_when_the_note_content_changes(self, env, monkeypatch):
        """A genuine re-delivery must NOT be swallowed as a duplicate.

        The optimistic path re-persists a REGENERATED note through the same activity
        (``_deliver_early`` is called again on the post-delivery regen). A key that
        ignored the content would make that second, better note a blind no-op on the
        gateway's replay cache — the failure this ticket exists to prevent.
        """
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        base = {"consultation_id": "c-1", "tenant_id": "t-1"}

        await env.run(activities.persist_draft, PersistDraftInput(**base, content="FIRST"))
        first = fake.calls["persist_draft"]["idempotency_key"]
        await env.run(activities.persist_draft, PersistDraftInput(**base, content="REGENERATED"))
        second = fake.calls["persist_draft"]["idempotency_key"]

        assert first != second

    @pytest.mark.asyncio
    async def test_draft_key_never_collides_across_consultations(self, env, monkeypatch):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)

        await env.run(
            activities.persist_draft,
            PersistDraftInput(consultation_id="c-1", tenant_id="t-1", content="DRAFT"),
        )
        first = fake.calls["persist_draft"]["idempotency_key"]
        await env.run(
            activities.persist_draft,
            PersistDraftInput(consultation_id="c-2", tenant_id="t-1", content="DRAFT"),
        )
        second = fake.calls["persist_draft"]["idempotency_key"]

        assert first != second

    # The same three properties for the ENTITY persist. The gateway's
    # write path is what actually guarantees one set of rows; these lock the
    # fast path so it can never SUPPRESS a legitimate re-extraction.
    @pytest.mark.asyncio
    async def test_entities_key_is_byte_identical_across_workflow_executions(self, monkeypatch):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        payload = PersistEntitiesInput(
            consultation_id="c-1",
            tenant_id="t-1",
            context_item_id="ctx-t1",
            entities=[NEREntity(text="Metformin", type="MEDICATION", start=0, end=9)],
        )

        keys = []
        for run_id, activity_id in (("run-A", "act-3"), ("run-B", "act-91")):
            env = ActivityEnvironment()
            env.info = dataclasses.replace(
                ActivityEnvironment.default_info(),
                workflow_run_id=run_id,
                activity_id=activity_id,
            )
            await env.run(activities.persist_entities, payload)
            keys.append(fake.calls["persist_entities"]["idempotency_key"])

        assert keys[0] == keys[1]
        assert "run-A" not in keys[0] and "run-B" not in keys[0]

    @pytest.mark.asyncio
    async def test_entities_key_changes_when_the_extracted_set_changes(self, env, monkeypatch):
        """A genuine re-extraction must NOT be swallowed as a duplicate."""
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        base = {"consultation_id": "c-1", "tenant_id": "t-1", "context_item_id": "ctx-t1"}

        await env.run(
            activities.persist_entities,
            PersistEntitiesInput(**base, entities=[NEREntity(text="Metformin", type="MEDICATION")]),
        )
        first = fake.calls["persist_entities"]["idempotency_key"]
        await env.run(
            activities.persist_entities,
            PersistEntitiesInput(
                **base, entities=[NEREntity(text="Amoxicillin", type="MEDICATION")]
            ),
        )
        second = fake.calls["persist_entities"]["idempotency_key"]

        assert first != second

    @pytest.mark.asyncio
    async def test_entities_key_never_collides_across_consultations(self, env, monkeypatch):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        entities = [NEREntity(text="Metformin", type="MEDICATION")]

        await env.run(
            activities.persist_entities,
            PersistEntitiesInput(consultation_id="c-1", tenant_id="t-1", entities=entities),
        )
        first = fake.calls["persist_entities"]["idempotency_key"]
        await env.run(
            activities.persist_entities,
            PersistEntitiesInput(consultation_id="c-2", tenant_id="t-1", entities=entities),
        )
        second = fake.calls["persist_entities"]["idempotency_key"]

        assert first != second

    @pytest.mark.asyncio
    async def test_record_gate_decision_forwards_attestation(self, env, monkeypatch):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        result = await env.run(
            activities.record_gate_decision,
            RecordGateInput(
                consultation_id="c-1",
                tenant_id="t-1",
                decision="SIGNED",
                gate_decision="PASS",
                clinician_id="doc-1",
                attestation_hash="h-1",
            ),
        )
        assert result.recorded is True
        call = fake.calls["record_gate_decision"]
        assert call["decision"] == "SIGNED"
        assert call["clinician_id"] == "doc-1"
        assert call["idempotency_key"] == "test-run:test"

    @pytest.mark.asyncio
    async def test_finalize_assurance_forwards_idempotency_key(self, env, monkeypatch):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        result = await env.run(
            activities.finalize_assurance,
            FinalizeAssuranceInput(
                consultation_id="c-1",
                tenant_id="t-1",
                context_item_id="ctx-1",
                gate_decision="PASS",
            ),
        )
        assert result.recorded is True
        call = fake.calls["finalize_assurance"]
        assert call["context_item_id"] == "ctx-1"
        assert call["idempotency_key"] == "test-run:test"

    @pytest.mark.asyncio
    async def test_retract_draft_forwards_flag_and_idempotency_key(self, env, monkeypatch):
        # The retract_draft activity forwards the FLAG verdict + offending
        # claims to apps/api under a stable idempotency key (a retried retraction dedups).
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        result = await env.run(
            activities.retract_draft,
            RetractDraftInput(
                consultation_id="c-1",
                tenant_id="t-1",
                context_item_id="ctx-1",
                gate_decision="FLAG",
                reason="assurance_flag",
                claims_flagged=["Start warfarin"],
            ),
        )
        assert result.retracted is True
        call = fake.calls["retract_draft"]
        assert call["context_item_id"] == "ctx-1"
        assert call["gate_decision"] == "FLAG"
        assert call["claims_flagged"] == ["Start warfarin"]
        assert call["idempotency_key"] == "test-run:test"  # dedups a retried retraction


_SOAP_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "subjective": {"type": "string"},
        "objective": {"type": "string"},
        "assessment": {"type": "string"},
        "plan": {"type": "string"},
    },
    "required": ["subjective", "objective", "assessment", "plan"],
}


class TestRunSensors:
    @pytest.mark.asyncio
    async def test_runs_real_sensors_and_returns_scores(self, env):
        note = '{"subjective": "s", "objective": "o", "assessment": "a", "plan": "p"}'
        result = await env.run(
            activities.run_sensors,
            RunSensorsInput(
                note_text=note,
                transcript_text="patient",
                note_entities=[],
                transcript_entities=[],
                response_format={
                    "type": "json_schema",
                    "json_schema": _SOAP_SCHEMA,
                    "strict": True,
                },
            ),
        )
        assert result.results  # sensors ran
        assert set(result.scores)  # scores populated
        assert "claims" in result.citations_map


class _FakeRetriever:
    """Stand-in :class:`HybridRetriever`: canned chunks (or degrade)."""

    def __init__(self, chunks, *, degraded: bool = False) -> None:
        from harness.guides.retrieval.retriever import RetrievalResult, RetrievedChunk

        self._result = RetrievalResult(
            chunks=[RetrievedChunk(chunk_id=c, text=f"text {c}") for c in chunks],
            degraded=degraded,
        )
        self.calls: list[dict[str, Any]] = []

    async def retrieve(self, *, query: str, tenant_id: str):
        self.calls.append({"query": query, "tenant_id": tenant_id})
        return self._result


class TestRetrieveContext:
    @pytest.mark.asyncio
    async def test_disabled_flag_returns_empty_without_calling_backends(self, env, monkeypatch):
        # Hermetic: force retrieval OFF regardless of the ambient dev ``.env`` (which
        # sets ``HARNESS_RETRIEVAL_ENABLED=true``). The activity reads the flag via the
        # real ``get_settings()`` -> ``_load_dotenv_into_environ()``, which never
        # overrides an already-set env var, so the disabled path runs deterministically.
        monkeypatch.setenv("HARNESS_RETRIEVAL_ENABLED", "false")

        def _boom(_settings):  # pragma: no cover - must not run
            raise AssertionError("retriever must not be built when retrieval is disabled")

        monkeypatch.setattr(activities, "_hybrid_retriever", _boom)
        result = await env.run(
            activities.retrieve_context,
            RetrieveContextInput(tenant_id="t-1", entities=[NEREntity(text="x")]),
        )
        assert result.chunks == []
        assert result.degraded is False
        assert result.prompt_block == ""

    @pytest.mark.asyncio
    async def test_enabled_builds_query_and_returns_block(self, env, monkeypatch):
        from harness.core.config import Settings

        settings = Settings(retrieval={"enabled": True})
        monkeypatch.setattr(activities, "get_settings", lambda: settings)
        fake = _FakeRetriever(["kc-1", "kc-2"])
        monkeypatch.setattr(activities, "_hybrid_retriever", lambda s: fake)

        result = await env.run(
            activities.retrieve_context,
            RetrieveContextInput(
                tenant_id="t-1",
                entities=[NEREntity(text="hypertension"), NEREntity(text="metformin")],
            ),
        )
        assert [c.chunk_id for c in result.chunks] == ["kc-1", "kc-2"]
        assert result.degraded is False
        assert "[[kb:" in result.prompt_block and "kc-1" in result.prompt_block
        # Query is built from the entities; tenant scope is forwarded.
        assert fake.calls[0]["query"] == "hypertension metformin"
        assert fake.calls[0]["tenant_id"] == "t-1"

    @pytest.mark.asyncio
    async def test_enabled_degrade_yields_empty_flagged_context(self, env, monkeypatch):
        from harness.core.config import Settings

        settings = Settings(retrieval={"enabled": True})
        monkeypatch.setattr(activities, "get_settings", lambda: settings)
        monkeypatch.setattr(
            activities, "_hybrid_retriever", lambda s: _FakeRetriever([], degraded=True)
        )

        result = await env.run(
            activities.retrieve_context,
            RetrieveContextInput(tenant_id="t-1", entities=[NEREntity(text="x")]),
        )
        assert result.chunks == []
        assert result.degraded is True
        assert result.prompt_block == ""


class TestEscalateGate:
    """The SLA-breach escalation RECORDS to apps/api. Still fail-safe: a down
    escalation endpoint is swallowed so the gate keeps waiting."""

    @pytest.mark.asyncio
    async def test_escalate_records_breach_to_api(self, env, monkeypatch):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)
        result = await env.run(
            activities.escalate_gate,
            EscalateInput(
                consultation_id="c-1", tenant_id="t-1", reason="gate_sla_breached", job_id="job-1"
            ),
        )
        assert result.escalated is True
        call = fake.calls["record_escalation"]
        assert call["consultation_id"] == "c-1"
        assert call["tenant_id"] == "t-1"
        assert call["reason"] == "gate_sla_breached"
        assert call["job_id"] == "job-1"
        # The escalation record is retried by _API_RETRY, so it too dedups.
        assert call["idempotency_key"] == "test-run:test"

    @pytest.mark.asyncio
    async def test_escalate_swallows_record_failure_stays_failsafe(self, env, monkeypatch):
        from harness.services.api_client import ApiServiceError

        class _DownApi:
            async def record_escalation(self, *a: Any, **kw: Any) -> EscalationRecordResponse:
                raise ApiServiceError("escalation endpoint unavailable")

        monkeypatch.setattr(activities, "_api_client", lambda s: _DownApi())
        # A down endpoint (e.g. before the coordinated apps/api route lands) must NEVER
        # fail the escalation — the gate keeps waiting (fail-safe, like report_progress).
        result = await env.run(
            activities.escalate_gate,
            EscalateInput(consultation_id="c-1", tenant_id="t-1", reason="gate_sla_breached"),
        )
        assert result.escalated is True


class _FakeProgressApi:
    """Stand-in ApiClient for report_progress: records calls (or raises)."""

    def __init__(self, *, error: Exception | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self._error = error

    async def report_progress(self, consultation_id: str, **kw: Any):
        self.calls.append({"consultation_id": consultation_id, **kw})
        if self._error is not None:
            raise self._error
        from harness.services.api_client import ReportProgressResponse

        return ReportProgressResponse(ok=True)


class TestReportProgress:
    """Fire-and-forget: forwards the stage event, swallows ALL errors."""

    @pytest.mark.asyncio
    async def test_forwards_stage_event_to_api_client(self, env, monkeypatch):
        fake = _FakeProgressApi()
        monkeypatch.setattr(activities, "_progress_api_client", lambda s: fake)
        result = await env.run(
            activities.report_progress,
            ReportProgressInput(
                consultation_id="c-1",
                tenant_id="t-1",
                job_id="job-1",
                stage="running_safety_sensors",
                label="Running safety sensors",
                ordinal=4,
                total=5,
            ),
        )
        assert result.reported is True
        call = fake.calls[0]
        assert call["consultation_id"] == "c-1"
        assert call["tenant_id"] == "t-1"
        assert call["job_id"] == "job-1"
        assert call["stage"] == "running_safety_sensors"
        assert call["label"] == "Running safety sensors"
        assert call["ordinal"] == 4
        assert call["total"] == 5
        assert call["idempotency_key"] == "test-run:test"

    @pytest.mark.asyncio
    async def test_api_failure_is_swallowed_and_reported_false(self, env, monkeypatch):
        from harness.services.api_client import ApiServiceError

        fake = _FakeProgressApi(error=ApiServiceError("api down"))
        monkeypatch.setattr(activities, "_progress_api_client", lambda s: fake)
        result = await env.run(
            activities.report_progress,
            ReportProgressInput(
                consultation_id="c-1",
                tenant_id="t-1",
                stage="drafting_note",
                label="Drafting the note",
                ordinal=3,
                total=5,
            ),
        )
        assert result.reported is False  # swallowed — never raises into the workflow


def _infer_input(**kw: Any) -> RunInferentialSensorsInput:
    base: dict[str, Any] = {
        "note_text": "Patient stable; continue current plan.",
        "transcript_text": "Patient has hypertension.",
        # the SYSTEM harness.judge selection the workflow threads onto the
        # input (a local judge here ⇒ no cloud PHI redaction). Absent ⇒ fail-closed.
        "judge_provider": "openai_compat",
        "judge_model": "stub-judge",
        "citations_map": {
            "claims": [
                {
                    "id": "c-htn",
                    "text": "hypertension",
                    "section": "A",
                    "evidence": [{"quote": "hypertension"}],
                }
            ]
        },
    }
    base.update(kw)
    return RunInferentialSensorsInput(**base)


class TestRunInferentialSensors:
    """Builds the judge + Granite client once, runs both sensors concurrently, and
    folds the results into a guardrailDecisions map + ragTriadScore (degrade, never
    raise, on backend failure)."""

    @pytest.mark.asyncio
    async def test_runs_both_sensors_and_assembles_guardrail_decisions(self, env, monkeypatch):
        judge = _StubJudge()
        granite = _FakeGranite(dimensions={"harm": False, "violence": False})
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: judge)
        monkeypatch.setattr(activities, "_granite_client", lambda s: granite)

        result = await env.run(activities.run_inferential_sensors, _infer_input())

        # Phase 3 adds citation_verify to the concurrent inferential pass. Its claim
        # has no knowledgeChunkIds here, so it vacuously PASSes (no judge call).
        assert {r.name for r in result.results} == {"groundedness", "safety", "citation_verify"}
        assert result.degraded is False
        assert result.rag_triad_score == pytest.approx(1.0)
        gd = result.guardrail_decisions
        assert gd["groundedness"]["decision"] == "PASS"
        assert gd["groundedness"]["passed"] is True
        assert gd["groundedness"]["ragTriadScore"] == pytest.approx(1.0)
        assert gd["safety"]["decision"] == "PASS"
        assert gd["safety"]["dimensions"] == {"harm": False, "violence": False}
        assert gd["safety"]["model"] == "granite-fake"
        assert gd["citation_verify"]["decision"] == "PASS"
        assert judge.calls, "groundedness must drive the judge per claim"
        assert granite.screened == ["Patient stable; continue current plan."]

    @pytest.mark.asyncio
    async def test_unsafe_dimension_marks_safety_flag(self, env, monkeypatch):
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: _StubJudge())
        monkeypatch.setattr(
            activities,
            "_granite_client",
            lambda s: _FakeGranite(dimensions={"harm": False, "violence": True}),
        )

        result = await env.run(
            activities.run_inferential_sensors, _infer_input(citations_map={"claims": []})
        )

        gd = result.guardrail_decisions
        assert gd["safety"]["decision"] == "FLAG"
        assert gd["safety"]["unsafe"] is True
        assert gd["safety"]["flaggedDimensions"] == ["violence"]
        assert result.degraded is False

    @pytest.mark.asyncio
    async def test_ungrounded_claim_marks_groundedness_regen(self, env, monkeypatch):
        judge = _StubJudge(unsupported_markers=("penicillin",))
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: judge)
        monkeypatch.setattr(
            activities, "_granite_client", lambda s: _FakeGranite(dimensions={"harm": False})
        )

        result = await env.run(
            activities.run_inferential_sensors,
            _infer_input(
                citations_map={
                    "claims": [
                        {
                            "id": "c-pen",
                            "text": "penicillin allergy",
                            "section": "P",
                            "evidence": [],
                        }
                    ]
                }
            ),
        )

        gd = result.guardrail_decisions
        assert gd["groundedness"]["decision"] == "REGEN"
        assert gd["groundedness"]["passed"] is False
        assert gd["groundedness"]["sections"] == ["P"]
        assert gd["groundedness"]["ungrounded"] == ["c-pen"]

    @pytest.mark.asyncio
    async def test_granite_failure_degrades_safety_without_raising(self, env, monkeypatch):
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: _StubJudge())
        monkeypatch.setattr(
            activities,
            "_granite_client",
            lambda s: _FakeGranite(error=GraniteServiceError("ollama offline")),
        )

        result = await env.run(
            activities.run_inferential_sensors, _infer_input(citations_map={"claims": []})
        )

        assert result.degraded is True
        gd = result.guardrail_decisions
        assert gd["safety"]["decision"] == "DEGRADED"
        assert gd["safety"]["degraded"] is True
        # Groundedness was fine -> only the safety backend degraded.
        assert gd["groundedness"]["decision"] == "PASS"

    @pytest.mark.asyncio
    async def test_judge_build_failure_degrades_whole_pass(self, env, monkeypatch):
        def _boom(*_a: Any, **_k: Any) -> object:
            raise RuntimeError("judge unbuildable")

        monkeypatch.setattr(activities, "_build_runtime_judge", _boom)
        monkeypatch.setattr(
            activities, "_granite_client", lambda s: _FakeGranite(dimensions={"harm": False})
        )

        result = await env.run(
            activities.run_inferential_sensors, _infer_input(citations_map={"claims": []})
        )

        assert result.degraded is True
        assert result.rag_triad_score is None
        assert result.guardrail_decisions["groundedness"]["decision"] == "DEGRADED"
        assert result.guardrail_decisions["safety"]["decision"] == "DEGRADED"
        # The whole pass degrades, including citation-verify (the "unverified" badge).
        cv = result.guardrail_decisions["citation_verify"]
        assert cv["decision"] == "DEGRADED"
        assert cv["badge"] == "unverified"


class _FakeAssuranceApi:
    """Stand-in ApiClient for the Slice-5d live feed: records per-claim publishes."""

    def __init__(self, *, error: Exception | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self._error = error

    async def report_assurance_event(self, consultation_id: str, **kw: Any):
        self.calls.append({"consultation_id": consultation_id, **kw})
        if self._error is not None:
            raise self._error
        from harness.services.api_client import AssuranceEventResponse

        return AssuranceEventResponse(ok=True)


class TestRunInferentialSensorsLiveAssurance:
    """When ``live_assurance`` is set and the ids
    are present, the activity streams each groundedness claim verdict to apps/api as
    it resolves (best-effort: a publish failure never degrades the pass)."""

    def _two_claim_input(self, **kw: Any) -> RunInferentialSensorsInput:
        return _infer_input(
            citations_map={
                "claims": [
                    {
                        "id": "c-htn",
                        "text": "hypertension",
                        "section": "A",
                        "evidence": [{"quote": "hypertension"}],
                    },
                    {"id": "c-pen", "text": "penicillin allergy", "section": "P", "evidence": []},
                ]
            },
            **kw,
        )

    @pytest.mark.asyncio
    async def test_publishes_one_event_per_claim_with_mapped_verdict(self, env, monkeypatch):
        judge = _StubJudge(unsupported_markers=("penicillin",))
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: judge)
        monkeypatch.setattr(
            activities, "_granite_client", lambda s: _FakeGranite(dimensions={"harm": False})
        )
        fake = _FakeAssuranceApi()
        monkeypatch.setattr(activities, "_progress_api_client", lambda s: fake)

        await env.run(
            activities.run_inferential_sensors,
            self._two_claim_input(
                live_assurance=True, consultation_id="c-1", tenant_id="t-1", job_id="job-1"
            ),
        )

        by_claim = {c["claim_id"]: c for c in fake.calls}
        assert set(by_claim) == {"c-htn", "c-pen"}
        assert by_claim["c-htn"]["consultation_id"] == "c-1"
        assert by_claim["c-htn"]["tenant_id"] == "t-1"
        assert by_claim["c-htn"]["job_id"] == "job-1"
        assert by_claim["c-htn"]["sensor"] == "groundedness"
        assert by_claim["c-htn"]["verdict"] == "grounded"
        assert by_claim["c-pen"]["verdict"] == "ungrounded"
        # Each event carries a running counter + the claim total for an N/M UI.
        assert by_claim["c-htn"]["total"] == 2
        assert sorted(c["ordinal"] for c in fake.calls) == [1, 2]
        # Per-claim idempotency key (activity run/id + claim) so a re-run of the
        # inferential activity dedups each claim event distinctly (no cross-claim collide).
        assert by_claim["c-htn"]["idempotency_key"] == "test-run:test:c-htn"
        assert by_claim["c-pen"]["idempotency_key"] == "test-run:test:c-pen"

    @pytest.mark.asyncio
    async def test_no_publish_when_live_assurance_disabled(self, env, monkeypatch):
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: _StubJudge())
        monkeypatch.setattr(
            activities, "_granite_client", lambda s: _FakeGranite(dimensions={"harm": False})
        )
        fake = _FakeAssuranceApi()
        monkeypatch.setattr(activities, "_progress_api_client", lambda s: fake)

        # Default input has live_assurance=False — the legacy path stays silent.
        await env.run(activities.run_inferential_sensors, self._two_claim_input())

        assert fake.calls == []

    @pytest.mark.asyncio
    async def test_publish_failure_never_degrades_the_pass(self, env, monkeypatch):
        from harness.services.api_client import ApiServiceError

        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: _StubJudge())
        monkeypatch.setattr(
            activities, "_granite_client", lambda s: _FakeGranite(dimensions={"harm": False})
        )
        fake = _FakeAssuranceApi(error=ApiServiceError("redis down"))
        monkeypatch.setattr(activities, "_progress_api_client", lambda s: fake)

        result = await env.run(
            activities.run_inferential_sensors,
            self._two_claim_input(
                live_assurance=True, consultation_id="c-1", tenant_id="t-1", job_id="job-1"
            ),
        )

        # The pass completes normally despite the failing live feed (this judge
        # grounds both claims, so the verdict is PASS — the point is it still resolves).
        assert result.degraded is False
        assert result.guardrail_decisions["groundedness"]["decision"] == "PASS"
