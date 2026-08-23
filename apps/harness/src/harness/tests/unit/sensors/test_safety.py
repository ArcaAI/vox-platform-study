"""Safety inferential-sensor tests.

The safety sensor screens the generated note through the constructor-injected
Granite Guardian client (the shared ``judge`` is accepted for a uniform call site
but unused — safety screens via Granite, not the judge). ``passed`` is False if
ANY harm dimension is flagged unsafe; the triggered dimensions are surfaced in
``details`` (and ``claims_flagged``). A Granite backend failure degrades (never an
auto-PASS, never an exception into the durable loop).
"""

from __future__ import annotations

import pytest

from harness.sensors.base import SensorContext
from harness.sensors.inferential.base import InferentialSensor
from harness.sensors.inferential.guardrail_screen import SafetyScreenError
from harness.sensors.inferential.safety import NAME, SafetySensor


class _StubGranite:
    """Stand-in Granite client: returns canned per-dimension verdicts (or raises)."""

    model = "granite-stub"

    def __init__(
        self, *, dimensions: dict[str, bool] | None = None, error: Exception | None = None
    ) -> None:
        self._dimensions = dimensions or {}
        self._error = error
        self.screened: list[str] = []

    async def screen(self, text: str) -> dict[str, bool]:
        self.screened.append(text)
        if self._error is not None:
            raise self._error
        return dict(self._dimensions)


class _NoopJudge:
    model = "noop"

    async def complete(self, *args: object, **kwargs: object) -> str:  # pragma: no cover - unused
        raise AssertionError("safety sensor must not call the judge")


def _ctx(note: str = "Patient stable, continue current plan.") -> SensorContext:
    return SensorContext(note_text=note)


class TestConformance:
    def test_is_an_inferential_sensor(self):
        assert isinstance(SafetySensor(_StubGranite()), InferentialSensor)

    def test_name_is_safety(self):
        assert SafetySensor(_StubGranite()).name == NAME == "safety"


class TestSafety:
    @pytest.mark.asyncio
    async def test_all_dimensions_safe_passes(self):
        client = _StubGranite(dimensions={"harm": False, "violence": False})
        result = await SafetySensor(client).arun(_ctx(), judge=_NoopJudge())

        assert result.name == NAME
        assert result.passed is True
        assert result.score == pytest.approx(1.0)
        assert result.claims_flagged == []
        assert result.degraded is False
        assert result.details["unsafe"] is False
        assert result.details["flagged_dimensions"] == []
        assert result.details["dimensions"] == {"harm": False, "violence": False}
        assert result.details["model"] == "granite-stub"
        assert client.screened == ["Patient stable, continue current plan."]

    @pytest.mark.asyncio
    async def test_any_unsafe_dimension_fails_and_is_reported(self):
        client = _StubGranite(dimensions={"harm": False, "violence": True, "jailbreak": False})
        result = await SafetySensor(client).arun(_ctx(), judge=_NoopJudge())

        assert result.passed is False
        assert result.score == pytest.approx(2 / 3)
        assert result.details["unsafe"] is True
        assert result.details["flagged_dimensions"] == ["violence"]
        assert result.claims_flagged == ["violence"]

    @pytest.mark.asyncio
    async def test_multiple_unsafe_dimensions(self):
        client = _StubGranite(dimensions={"harm": True, "violence": True})
        result = await SafetySensor(client).arun(_ctx(), judge=_NoopJudge())
        assert result.passed is False
        assert result.score == pytest.approx(0.0)
        assert sorted(result.details["flagged_dimensions"]) == ["harm", "violence"]

    @pytest.mark.asyncio
    async def test_no_dimensions_is_vacuously_safe(self):
        result = await SafetySensor(_StubGranite(dimensions={})).arun(_ctx(), judge=_NoopJudge())
        assert result.passed is True
        assert result.score == pytest.approx(1.0)


class TestDegrade:
    @pytest.mark.asyncio
    async def test_granite_backend_failure_degrades_never_raises(self):
        client = _StubGranite(error=SafetyScreenError("ollama offline"))
        result = await SafetySensor(client).arun(_ctx(), judge=_NoopJudge())
        assert result.degraded is True
        assert result.passed is False
        assert result.score == 0.0
        assert "reason" in result.details
