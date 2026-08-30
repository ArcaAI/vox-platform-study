"""TASK-816 Phase 2 — the graph lane must gate on the TENANT's configured sensor thresholds.

## The defect these tests pin

`HarnessPolicy` carries five clinical threshold columns. The LEGACY durable loop reads them
(`workflows.py:512` builds `policy.to_sensor_thresholds()` and threads it onto every
`RunSensorsInput`), so a tenant that tightens `coverageThreshold` to 0.95 gets 0.95.

The GRAPH interpreter's `consultation.sensors` node built its `RunSensorsInput` with **no**
`thresholds` at all, so `_platform_thresholds(None)` fell through to the PLATFORM value and the
tenant's four computational gates were silently discarded. `groundednessThreshold` was honoured
(the inferential node reads it), which is what made the loss easy to miss: one of the five
thresholds worked, so the feature looked wired.

The direction matters clinically. A tenant that TIGHTENED a fabrication or numeric-dose gate got
it LOOSENED back to the platform default, on the substrate every graph-mode consultation runs on.

## Why the fix is a thread, not a new node-config tier

The threshold already has two governed homes — the platform default in the settings registry
(`harness.sensor.*`, resolved by `resolve_sensor_thresholds`) and the tenant value in
`HarnessPolicy` (`db-config` tier). A third, node-authored source would be two rows that can
disagree, which is what TASK-816 Phase 1 rejected five of six proposed `llmBinding` fields for.
So the graph lane is made to read the tier that already exists, exactly as the legacy lane does.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from harness.services.api_client import ApiServiceError
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import consultation_verify as verify

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = {"consultationId": "c1", "externalPatientId": "p1", "userId": "u1"}

#: A tenant that has TIGHTENED coverage and LOOSENED nothing — every value differs from the
#: `SensorThresholds` code default, so a dropped threshold cannot pass by coincidence.
_TENANT_POLICY = {
    "entityFaithfulnessThreshold": 0.97,
    "coverageThreshold": 0.95,
    "citationPresenceThreshold": 0.93,
    "numericDoseThreshold": 0.91,
    "groundednessThreshold": 0.89,
}


def _payload(node_type: str, **overrides) -> NodeActivityInput:
    base = {
        "node_id": "n1",
        "node_type": node_type,
        "config": {},
        "tenant_id": _TENANT,
        "sandbox": False,
        "bound_inputs": {"in": {"text": "the draft note"}},
        "run_payload": dict(_RUN),
    }
    base.update(overrides)
    return NodeActivityInput(**base)


class _Obj:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


def _sensors_ok() -> _Obj:
    return _Obj(scores={"coverage": 0.9}, citations_map={}, results=[], soap_sections={})


def _stub_policy(monkeypatch, raw: dict | None, *, error: Exception | None = None) -> None:
    monkeypatch.setattr(verify, "get_settings", lambda: object())
    get_policy = AsyncMock(side_effect=error) if error else AsyncMock(return_value=raw)
    monkeypatch.setattr(verify, "_api_client", lambda _s: _Obj(get_policy=get_policy))


class TestComputationalSensorsHonourTenantThresholds:
    @pytest.mark.asyncio
    async def test_the_tenants_configured_thresholds_reach_run_sensors(self, monkeypatch):
        """The whole defect, in one assertion: all five tenant values arrive."""
        _stub_policy(monkeypatch, _TENANT_POLICY)
        run_sensors = AsyncMock(return_value=_sensors_ok())
        monkeypatch.setattr(verify, "run_sensors", run_sensors)

        result = await verify.interpreter_consultation_sensors(_payload("consultation.sensors"))

        assert result.status == "SUCCEEDED"
        thresholds = run_sensors.await_args.args[0].thresholds
        assert thresholds is not None, "the tenant's HarnessPolicy thresholds were dropped"
        assert thresholds.entity_faithfulness_threshold == 0.97
        assert thresholds.coverage_threshold == 0.95
        assert thresholds.citation_presence_threshold == 0.93
        assert thresholds.numeric_dose_threshold == 0.91
        assert thresholds.groundedness_threshold == 0.89

    @pytest.mark.asyncio
    async def test_a_policy_fetch_failure_falls_through_to_the_platform_tier(self, monkeypatch):
        """CR-14 — a sensor must never fail the run, and an unreachable control plane must
        leave the clinical gate exactly where it was. `thresholds=None` is precisely the
        "no tenant opinion" signal `_platform_thresholds` already understands, so the node
        degrades to the PLATFORM default rather than degrading the NODE."""
        _stub_policy(monkeypatch, None, error=ApiServiceError("policy unreachable"))
        run_sensors = AsyncMock(return_value=_sensors_ok())
        monkeypatch.setattr(verify, "run_sensors", run_sensors)

        result = await verify.interpreter_consultation_sensors(_payload("consultation.sensors"))

        assert result.status == "SUCCEEDED", "an unreachable policy must not degrade the verifier"
        assert run_sensors.await_args.args[0].thresholds is None

    @pytest.mark.asyncio
    async def test_no_bound_note_still_degrades_before_any_policy_read(self, monkeypatch):
        """Pre-existing behaviour, pinned: the empty-note degrade short-circuits ahead of the
        fetch, so the fix adds no network call to a node that has nothing to verify."""
        get_policy = AsyncMock(side_effect=AssertionError("must not fetch without a note"))
        monkeypatch.setattr(verify, "get_settings", lambda: object())
        monkeypatch.setattr(verify, "_api_client", lambda _s: _Obj(get_policy=get_policy))

        result = await verify.interpreter_consultation_sensors(
            _payload("consultation.sensors", bound_inputs={})
        )
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_a_sensor_crash_still_degrades_and_never_fails_the_run(self, monkeypatch):
        """CR-14, pinned across the change — the added fetch must not move this posture."""
        _stub_policy(monkeypatch, _TENANT_POLICY)
        monkeypatch.setattr(verify, "run_sensors", AsyncMock(side_effect=RuntimeError("boom")))

        result = await verify.interpreter_consultation_sensors(_payload("consultation.sensors"))
        assert result.status == "DEGRADED"
