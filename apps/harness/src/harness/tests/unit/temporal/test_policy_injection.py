"""Policy injection into the durable loop.

The harness policy (sensor thresholds, guard toggles, gate budgets,
model defaults) is read once at workflow start via the ``fetch_policy`` activity
and threaded into the deterministic body. These tests prove:

* ``HarnessPolicy.from_api`` maps the apps/api camelCase contract onto the
  snake_case model + builds a ``SensorThresholds``.
* ``fetch_policy`` calls the api client with the tenant + returns the parsed policy.
* a lowered ``coverageThreshold`` flips the *computational* gate verdict
  REGEN -> PASS (policy actually drives the loop), via the real ``run_sensors``
  activity + the aggregator.
* a lowered ``groundednessThreshold`` flips the *inferential* groundedness
  decision REGEN -> PASS, and ``safetyEnabled=False`` skips the safety screen.
"""

from __future__ import annotations

from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.sensors.aggregator import GateDecision, aggregate
from harness.sensors.base import NEREntity
from harness.sensors.config import SensorThresholds
from harness.sensors.registry import COMPUTATIONAL_SENSOR_NAMES
from harness.services.api_client import ApiServiceError
from harness.temporal import activities
from harness.temporal.models import (
    FetchPolicyInput,
    HarnessPolicy,
    RunInferentialSensorsInput,
    RunSensorsInput,
)

_POLICY_JSON: dict[str, Any] = {
    "id": "hp-1",
    "tenantId": "t-1",
    "source": "tenant",
    "entityFaithfulnessThreshold": 0.7,
    "coverageThreshold": 0.6,
    "citationPresenceThreshold": 0.9,
    "numericDoseThreshold": 1.0,
    "groundednessThreshold": 0.5,
    "safetyEnabled": False,
    "phiEnabled": False,
    "phiFailClosed": False,
    "textProvider": "azure",
    "textModel": "gpt-4o",
    "judgeProvider": "openai_compat",
    "judgeModel": "google/gemma-4-e4b",
    "maxRegen": 4,
    "gateSlaSeconds": 3600,
    "gateEscalationSeconds": 1800,
    "toolAllowlist": ["nlp", "text"],
    "version": 7,
}


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


class TestHarnessPolicyModel:
    def test_from_api_maps_camel_contract(self):
        policy = HarnessPolicy.from_api(_POLICY_JSON)
        assert policy.entity_faithfulness_threshold == 0.7
        assert policy.coverage_threshold == 0.6
        assert policy.citation_presence_threshold == 0.9
        assert policy.numeric_dose_threshold == 1.0
        assert policy.groundedness_threshold == 0.5
        assert policy.safety_enabled is False
        assert policy.phi_enabled is False
        assert policy.phi_fail_closed is False
        assert policy.text_provider == "azure"
        assert policy.text_model == "gpt-4o"
        # the SYSTEM harness.judge selection maps straight through.
        assert policy.judge_provider == "openai_compat"
        assert policy.judge_model == "google/gemma-4-e4b"
        assert policy.max_regen == 4
        assert policy.gate_sla_seconds == 3600
        assert policy.gate_escalation_seconds == 1800
        assert policy.tool_allowlist == ["nlp", "text"]
        assert policy.version == 7

    def test_to_sensor_thresholds_carries_policy_values(self):
        thresholds = HarnessPolicy.from_api(_POLICY_JSON).to_sensor_thresholds()
        assert isinstance(thresholds, SensorThresholds)
        assert thresholds.entity_faithfulness_threshold == 0.7
        assert thresholds.coverage_threshold == 0.6
        assert thresholds.citation_presence_threshold == 0.9
        assert thresholds.numeric_dose_threshold == 1.0
        assert thresholds.groundedness_threshold == 0.5

    def test_from_api_tolerates_missing_optional_fields(self):
        # A code-default policy may omit nullable model fields -> degrade-safe defaults.
        policy = HarnessPolicy.from_api({"textProvider": None, "textModel": None})
        assert policy.text_provider is None
        assert policy.text_model is None
        # absent judge selection ⇒ None (inferential pass fails closed).
        assert policy.judge_provider is None
        assert policy.judge_model is None
        assert policy.safety_enabled is True  # conservative default
        assert policy.tool_allowlist is None


class _FakeApi:
    def __init__(self, data: dict[str, Any] | None = None, error: Exception | None = None) -> None:
        self._data = data if data is not None else dict(_POLICY_JSON)
        self._error = error
        self.calls: list[str] = []
        # Records the consultation_id the activity forwarded (None when
        # the workflow input carried no consultation).
        self.consultation_ids: list[str | None] = []

    async def get_policy(
        self, tenant_id: str, consultation_id: str | None = None
    ) -> dict[str, Any]:
        self.calls.append(tenant_id)
        self.consultation_ids.append(consultation_id)
        if self._error is not None:
            raise self._error
        return self._data


class TestFetchPolicyActivity:
    @pytest.mark.asyncio
    async def test_fetch_policy_returns_parsed_policy_for_tenant(self, env, monkeypatch):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)

        result = await env.run(activities.fetch_policy, FetchPolicyInput(tenant_id="t-1"))

        assert fake.calls == ["t-1"]
        assert isinstance(result, HarnessPolicy)
        assert result.coverage_threshold == 0.6
        assert result.max_regen == 4
        assert result.text_provider == "azure"

    @pytest.mark.asyncio
    async def test_fetch_policy_never_forwards_consultation_id(self, env, monkeypatch):
        # TASK-815 / OD-12 retired the per-agent `harnessOverrides` overlay, which
        # was the only reason this activity threaded the consultation id onto the
        # policy GET. The gateway route still accepts the query param, so sending
        # it would not fail — it would just claim an overlay that no longer runs.
        # The effective policy is tenant-scoped now, full stop.
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)

        result = await env.run(
            activities.fetch_policy,
            FetchPolicyInput(tenant_id="t-1", consultation_id="c-9"),
        )

        assert fake.calls == ["t-1"]
        assert fake.consultation_ids == [None]
        assert isinstance(result, HarnessPolicy)

    @pytest.mark.asyncio
    async def test_fetch_policy_omits_consultation_id_when_absent(self, env, monkeypatch):
        fake = _FakeApi()
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)

        await env.run(activities.fetch_policy, FetchPolicyInput(tenant_id="t-1"))

        assert fake.consultation_ids == [None]

    @pytest.mark.asyncio
    async def test_fetch_policy_propagates_api_error_for_workflow_fallback(self, env, monkeypatch):
        # The activity raises on an unreachable endpoint; the workflow catches the
        # ActivityError and degrades to code defaults (covered in the workflow tests).
        fake = _FakeApi(error=ApiServiceError("policy endpoint down"))
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)

        with pytest.raises(ApiServiceError):
            await env.run(activities.fetch_policy, FetchPolicyInput(tenant_id="t-1"))


# A SOAP draft that covers only 1 of the 2 transcript entities (coverage = 0.5);
# every other computational sensor passes, so the gate verdict hinges purely on
# the coverage threshold the policy supplies.
_NOTE = (
    '{"subjective": "Patient reports hypertension.", "objective": "BP 140/90.", '
    '"assessment": "Hypertension.", "plan": "Continue lisinopril 10 mg daily."}'
)
_TRANSCRIPT = (
    "Patient has hypertension and diabetes. BP is 140/90. Continue lisinopril 10 mg daily."
)
_TRANSCRIPT_ENTITIES = [
    NEREntity(text="hypertension", type="DISEASE", start=17, end=29),
    NEREntity(text="diabetes", type="DISEASE", start=34, end=42),
]
_NOTE_ENTITIES = [NEREntity(text="hypertension", type="DISEASE", start=16, end=28)]
_SOAP_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "subjective": {"type": "string"},
            "objective": {"type": "string"},
            "assessment": {"type": "string"},
            "plan": {"type": "string"},
        },
        "required": ["subjective", "objective", "assessment", "plan"],
    },
    "strict": True,
}


def _run_sensors_input(thresholds: SensorThresholds | None) -> RunSensorsInput:
    return RunSensorsInput(
        note_text=_NOTE,
        transcript_text=_TRANSCRIPT,
        note_entities=_NOTE_ENTITIES,
        transcript_entities=_TRANSCRIPT_ENTITIES,
        response_format=_SOAP_RESPONSE_FORMAT,
        thresholds=thresholds,
    )


class TestPolicyDrivesComputationalGate:
    """Lowering the coverage threshold (policy) flips an otherwise-failing draft to
    PASS — proving the policy threshold reaches the computational sensors."""

    @pytest.mark.asyncio
    async def test_default_threshold_regens_partial_coverage_draft(self, env):
        out = await env.run(activities.run_sensors, _run_sensors_input(None))
        coverage = next(r for r in out.results if r.name == "coverage_omission")
        assert coverage.passed is False  # 0.5 < default 0.8
        verdict = aggregate(
            out.results, regens_remaining=2, expected=list(COMPUTATIONAL_SENSOR_NAMES)
        )
        assert verdict.decision == GateDecision.REGEN

    @pytest.mark.asyncio
    async def test_lowered_policy_threshold_passes_same_draft(self, env):
        thresholds = HarnessPolicy.from_api({**_POLICY_JSON, "coverageThreshold": 0.4})
        out = await env.run(
            activities.run_sensors, _run_sensors_input(thresholds.to_sensor_thresholds())
        )
        coverage = next(r for r in out.results if r.name == "coverage_omission")
        assert coverage.passed is True  # 0.5 >= lowered 0.4
        verdict = aggregate(
            out.results, regens_remaining=2, expected=list(COMPUTATIONAL_SENSOR_NAMES)
        )
        assert verdict.decision == GateDecision.PASS


class _StubJudge:
    """Deterministic judge: ``unsupported`` when a marker hits the message content."""

    model = "stub-judge"

    def __init__(self, *, unsupported_markers: tuple[str, ...] = ()) -> None:
        self._markers = unsupported_markers
        self.calls = 0

    async def complete(self, messages: list[dict[str, str]], **kwargs: Any) -> str:
        self.calls += 1
        content = messages[-1]["content"].lower()
        unsupported = any(marker in content for marker in self._markers)
        return '{"supported": false}' if unsupported else '{"supported": true}'


class _FakeGranite:
    def __init__(self, *, dimensions: dict[str, bool] | None = None) -> None:
        self.model = "granite-fake"
        self._dimensions = dimensions or {}
        self.screened: list[str] = []

    async def screen(self, text: str) -> dict[str, bool]:
        self.screened.append(text)
        return dict(self._dimensions)


# Two cited claims; the judge grounds exactly one (the other trips the marker),
# so groundedness = 0.5 — the verdict hinges purely on the policy threshold.
_TWO_CLAIMS = {
    "claims": [
        {
            "id": "c-htn",
            "text": "hypertension",
            "section": "A",
            "evidence": [{"quote": "hypertension"}],
        },
        {"id": "c-dm", "text": "diabetes", "section": "A", "evidence": [{"quote": "diabetes"}]},
    ]
}


class TestPolicyDrivesInferentialGate:
    @pytest.mark.asyncio
    async def test_default_groundedness_threshold_regens(self, env, monkeypatch):
        judge = _StubJudge(unsupported_markers=("diabetes",))
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: judge)
        monkeypatch.setattr(
            activities,
            "_safety_screen_client",
            lambda s, t: _FakeGranite(dimensions={"harm": False}),
        )

        result = await env.run(
            activities.run_inferential_sensors,
            RunInferentialSensorsInput(
                # tenant-scoped safety screen (TASK-737): both workflow call sites
                # thread this; without it the safety sensor degrades by design.
                tenant_id="11111111-1111-1111-1111-111111111111",
                note_text="note",
                transcript_text="hypertension",
                citations_map=_TWO_CLAIMS,
                # SYSTEM harness.judge selection (else the pass fails closed).
                judge_provider="openai_compat",
                judge_model="stub-judge",
            ),
        )
        assert result.guardrail_decisions["groundedness"]["decision"] == "REGEN"

    @pytest.mark.asyncio
    async def test_lowered_groundedness_threshold_passes(self, env, monkeypatch):
        judge = _StubJudge(unsupported_markers=("diabetes",))
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: judge)
        monkeypatch.setattr(
            activities,
            "_safety_screen_client",
            lambda s, t: _FakeGranite(dimensions={"harm": False}),
        )

        result = await env.run(
            activities.run_inferential_sensors,
            RunInferentialSensorsInput(
                # tenant-scoped safety screen (TASK-737): both workflow call sites
                # thread this; without it the safety sensor degrades by design.
                tenant_id="11111111-1111-1111-1111-111111111111",
                note_text="note",
                transcript_text="hypertension",
                citations_map=_TWO_CLAIMS,
                groundedness_threshold=0.4,
                # SYSTEM harness.judge selection (else the pass fails closed).
                judge_provider="openai_compat",
                judge_model="stub-judge",
            ),
        )
        assert result.guardrail_decisions["groundedness"]["decision"] == "PASS"

    @pytest.mark.asyncio
    async def test_safety_disabled_skips_safety_screen(self, env, monkeypatch):
        judge = _StubJudge()
        granite = _FakeGranite(dimensions={"harm": True})  # would FLAG if it ran
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: judge)
        monkeypatch.setattr(activities, "_safety_screen_client", lambda s, t: granite)

        result = await env.run(
            activities.run_inferential_sensors,
            RunInferentialSensorsInput(
                # tenant-scoped safety screen (TASK-737): both workflow call sites
                # thread this; without it the safety sensor degrades by design.
                tenant_id="11111111-1111-1111-1111-111111111111",
                note_text="note",
                transcript_text="t",
                citations_map={"claims": []},
                safety_enabled=False,
                # SYSTEM harness.judge selection (else the pass fails closed).
                judge_provider="openai_compat",
                judge_model="stub-judge",
            ),
        )
        assert "safety" not in result.guardrail_decisions
        assert granite.screened == []  # the safety sensor never ran
        assert result.degraded is False


class TestJudgeSelectionFailClosed:
    """the LLM-as-judge SELECTION comes from the SYSTEM ``harness.judge``
    policy (threaded as ``judge_provider``/``judge_model``). When it is absent the
    pass FAILS CLOSED (degrades) — it never falls back to an env-selected judge, so
    the judge is never even built."""

    @pytest.mark.asyncio
    async def test_missing_judge_selection_degrades_without_building_judge(
        self, env, monkeypatch, caplog
    ):
        def _must_not_build(*_a: Any, **_k: Any) -> Any:
            raise AssertionError("judge must NOT be built with no SYSTEM selection")

        granite = _FakeGranite(dimensions={"harm": False})  # would flag if ever run
        monkeypatch.setattr(activities, "_build_runtime_judge", _must_not_build)
        monkeypatch.setattr(activities, "_safety_screen_client", lambda s, t: granite)

        import logging

        with caplog.at_level(logging.WARNING):
            result = await env.run(
                activities.run_inferential_sensors,
                RunInferentialSensorsInput(
                    # tenant-scoped safety screen (TASK-737): both workflow call sites
                    # thread this; without it the safety sensor degrades by design.
                    tenant_id="11111111-1111-1111-1111-111111111111",
                    note_text="note",
                    transcript_text="hypertension",
                    citations_map=_TWO_CLAIMS,
                    # judge_provider/judge_model intentionally omitted (None).
                ),
            )

        assert result.degraded is True
        gd = result.guardrail_decisions
        assert gd["groundedness"]["decision"] == "DEGRADED"
        assert gd["citation_verify"]["decision"] == "DEGRADED"
        assert "harness.judge" in (gd["groundedness"]["reason"] or "").lower()
        assert granite.screened == []  # never egressed to the safety screen either

    @pytest.mark.asyncio
    async def test_partial_judge_selection_also_fails_closed(self, env, monkeypatch):
        # A provider with no model (or vice-versa) is NOT a usable selection ⇒ degrade.
        monkeypatch.setattr(
            activities,
            "_build_runtime_judge",
            lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not build")),
        )
        monkeypatch.setattr(
            activities,
            "_safety_screen_client",
            lambda s, t: _FakeGranite(dimensions={"harm": False}),
        )

        result = await env.run(
            activities.run_inferential_sensors,
            RunInferentialSensorsInput(
                # tenant-scoped safety screen (TASK-737): both workflow call sites
                # thread this; without it the safety sensor degrades by design.
                tenant_id="11111111-1111-1111-1111-111111111111",
                note_text="note",
                transcript_text="hypertension",
                citations_map=_TWO_CLAIMS,
                judge_provider="openai_compat",  # model missing ⇒ unusable
            ),
        )
        assert result.degraded is True
        assert result.guardrail_decisions["groundedness"]["decision"] == "DEGRADED"
