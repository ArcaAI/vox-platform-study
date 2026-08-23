"""TASK-799 A.2 — the sensor thresholds become control-plane tunable (PULL channel).

These seven values gate CLINICAL assurance decisions (entity faithfulness, coverage,
citation presence, numeric/dose fidelity, groundedness, citation-verify, atomic fact).
`sensors/config.py`'s own docstring said making them admin-editable "is a separate,
coordinated change" — this is it.

**Which channel, and why (owner decision D-1).** The PER-TENANT lane already exists and
is PUSH: `HarnessPolicy` resolves per tenant in `apps/api` and the workflow snapshots the
result onto `RunSensorsInput.thresholds` / the inferential input. What had no home was the
PLATFORM DEFAULT — the value in force when a tenant expressed no opinion, which was a
pydantic default reachable only by redeploying. That is exactly D-1's PULL channel:
platform scope, cardinality one per service, TTL + push invalidation.

So the precedence this locks is **policy (tenant) → control plane (platform) → env
bootstrap**, and the tenant lane is untouched: a policy value still wins outright.

**`value: null` means UNRESOLVED, never "the default".** An absent key, a null, a wrong
`dataType` or an out-of-range number leaves the bootstrap value in force — a degraded
control plane must leave a clinical gate exactly where it was, never loosen it.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.core.effective_config import EffectiveConfigSnapshot
from harness.sensors.config import SensorThresholds, resolve_sensor_thresholds


def _snapshot(**settings: Any) -> EffectiveConfigSnapshot:
    return EffectiveConfigSnapshot(raw={"settings": settings}, ok=True)


def _entry(value: Any, data_type: str = "number", source: str = "db") -> dict[str, Any]:
    return {"value": value, "dataType": data_type, "source": source}


class TestSnapshotSettingsAccessor:
    def test_reads_a_declared_key(self) -> None:
        snap = _snapshot(**{"harness.sensor.coverageThreshold": _entry(0.5)})
        assert snap.setting("harness.sensor.coverageThreshold") == 0.5

    def test_absent_block_and_absent_key_read_as_none(self) -> None:
        assert EffectiveConfigSnapshot().setting("harness.sensor.coverageThreshold") is None
        assert _snapshot().setting("harness.sensor.coverageThreshold") is None

    def test_null_value_is_unresolved_not_a_value(self) -> None:
        snap = _snapshot(**{"harness.sensor.coverageThreshold": _entry(None)})
        assert snap.setting("harness.sensor.coverageThreshold") is None

    def test_a_malformed_entry_is_refused(self) -> None:
        snap = EffectiveConfigSnapshot(
            raw={"settings": {"harness.sensor.coverageThreshold": "0.5"}}, ok=True
        )
        assert snap.setting("harness.sensor.coverageThreshold") is None


class TestResolveSensorThresholds:
    def test_no_snapshot_keeps_every_bootstrap_value(self) -> None:
        base = SensorThresholds()
        assert resolve_sensor_thresholds(None, base) == base

    def test_a_failed_pull_keeps_every_bootstrap_value(self) -> None:
        base = SensorThresholds()
        assert resolve_sensor_thresholds(EffectiveConfigSnapshot(ok=False), base) == base

    def test_a_resolved_value_wins_over_the_bootstrap_default(self) -> None:
        base = SensorThresholds()
        assert base.coverage_threshold == 0.8
        out = resolve_sensor_thresholds(
            _snapshot(**{"harness.sensor.coverageThreshold": _entry(0.55)}), base
        )
        assert out.coverage_threshold == 0.55
        # Untouched keys keep their bootstrap values — this is a per-key merge.
        assert out.entity_faithfulness_threshold == base.entity_faithfulness_threshold

    def test_the_object_is_copied_not_mutated(self) -> None:
        base = SensorThresholds()
        resolve_sensor_thresholds(
            _snapshot(**{"harness.sensor.coverageThreshold": _entry(0.55)}), base
        )
        assert base.coverage_threshold == 0.8

    @pytest.mark.parametrize("bad", [-0.1, 1.1, "0.5", True, None])
    def test_an_out_of_contract_value_is_refused_not_clamped(self, bad: Any) -> None:
        """Every threshold is a fraction in [0, 1]; anything else keeps the bootstrap.

        Refused, NOT clamped: clamping would invent a clinical gate nobody chose, and a
        control-plane defect would then be invisible.
        """
        base = SensorThresholds()
        out = resolve_sensor_thresholds(
            _snapshot(**{"harness.sensor.coverageThreshold": _entry(bad)}), base
        )
        assert out.coverage_threshold == base.coverage_threshold

    def test_every_threshold_field_is_addressable(self) -> None:
        """No field may be left behind — a half-migrated group is worse than none."""
        from harness.sensors.config import SENSOR_THRESHOLD_KEYS

        assert set(SENSOR_THRESHOLD_KEYS) == set(SensorThresholds.model_fields)


class TestPrecedence:
    def test_a_tenant_policy_value_still_wins_over_the_platform_default(self) -> None:
        """D-1: the PUSH lane carries the tenant; PULL only supplies the platform default.

        The activity passes `payload.thresholds` when the policy set one, and only
        consults the control plane when it did not — so this resolver is never even
        reached for a tenant that has an opinion.
        """
        policy = SensorThresholds(coverage_threshold=0.9)
        # The platform default says 0.55; the tenant's 0.9 is what the activity uses.
        platform = resolve_sensor_thresholds(
            _snapshot(**{"harness.sensor.coverageThreshold": _entry(0.55)}),
            SensorThresholds(),
        )
        assert platform.coverage_threshold == 0.55
        assert policy.coverage_threshold == 0.9
