"""Contract tests for the inferential-sensor foundation (TASK-330 Phase 2).

RED-first. Inferential sensors are **async + model-calling**, so they cannot use
the pure sync :class:`~harness.sensors.base.Sensor` protocol. This covers:

* the new ``groundedness_threshold`` knob on :class:`SensorThresholds`,
* the runtime-checkable :class:`InferentialSensor` protocol
  (``name`` + ``async def arun(ctx, *, judge) -> SensorResult``), and
* the shared :func:`degraded_result` helper used by the reduced-assurance path
  (a backend-unavailable result must never auto-PASS).

A tiny stub sensor + stub judge stand in for the real (Phase-2 later) sensors.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from harness.eval.judge.base import JudgeClient
from harness.sensors.base import Sensor, SensorContext, SensorResult
from harness.sensors.config import SensorThresholds
from harness.sensors.inferential.base import InferentialSensor, degraded_result


class _StubJudge:
    """A minimal :class:`JudgeClient`-conforming stub (no network)."""

    model = "stub-judge"

    def __init__(self) -> None:
        self.calls: list[list[dict[str, str]]] = []

    async def complete(
        self,
        messages: list[dict[str, str]],
        *,
        json_mode: bool = False,
        temperature: float | None = None,
        seed: int | None = None,
    ) -> str:
        self.calls.append(messages)
        return '{"supported": true}'


class _StubInferentialSensor:
    """A conforming inferential sensor that drives the injected judge."""

    name = "stub_inferential"

    async def arun(self, ctx: SensorContext, *, judge: JudgeClient) -> SensorResult:
        raw = await judge.complete([{"role": "user", "content": ctx.note_blob()}])
        return SensorResult(name=self.name, score=1.0, passed=True, details={"raw": raw})


class TestGroundednessThreshold:
    def test_default_is_0_8(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.delenv("HARNESS_SENSOR_GROUNDEDNESS_THRESHOLD", raising=False)
        assert SensorThresholds().groundedness_threshold == 0.8

    def test_env_override(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_SENSOR_GROUNDEDNESS_THRESHOLD", "0.9")
        assert SensorThresholds().groundedness_threshold == 0.9

    def test_rejects_value_outside_unit_interval(self):
        with pytest.raises(ValidationError):
            SensorThresholds(groundedness_threshold=1.5)


class TestStubJudgeConformsToJudgeClient:
    def test_stub_is_a_judge_client(self):
        assert isinstance(_StubJudge(), JudgeClient)


class TestInferentialSensorProtocol:
    def test_conforming_stub_is_an_inferential_sensor(self):
        assert isinstance(_StubInferentialSensor(), InferentialSensor)

    def test_non_conforming_object_is_not(self):
        assert not isinstance(object(), InferentialSensor)

    def test_sync_sensor_is_not_an_inferential_sensor(self):
        class _Sync:
            name = "sync"

            def run(self, ctx: SensorContext) -> SensorResult:
                return SensorResult(name="sync", score=1.0, passed=True)

        # A pure sync sensor satisfies Sensor but NOT the async InferentialSensor.
        assert isinstance(_Sync(), Sensor)
        assert not isinstance(_Sync(), InferentialSensor)

    @pytest.mark.asyncio
    async def test_arun_drives_the_injected_judge(self):
        judge = _StubJudge()
        sensor = _StubInferentialSensor()
        res = await sensor.arun(SensorContext(note_text="hello world"), judge=judge)
        assert res.name == "stub_inferential"
        assert res.passed is True
        assert judge.calls, "arun must actually invoke the injected judge"


class TestDegradedResult:
    def test_marks_degraded_and_never_passes(self):
        r = degraded_result("groundedness", "judge backend offline")
        assert r.degraded is True
        assert r.passed is False
        assert r.name == "groundedness"
        assert r.score == 0.0
        assert r.details.get("reason") == "judge backend offline"

    def test_accepts_flagged_claims(self):
        r = degraded_result("safety", "granite offline", claims_flagged=["c1", "c2"])
        assert r.claims_flagged == ["c1", "c2"]
        assert r.degraded is True
