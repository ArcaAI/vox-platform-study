"""Unit tests for the per-session EngineSwitchController (TASK-567 §3.4).

Tier-1 style: no Redis, no models — the controller is exercised in isolation
with fakes for the three injected primitives (build fallback / apply / publish).
Covers every trigger path in plan §5 item 12.
"""

from __future__ import annotations

from typing import Any

import pytest

from stt.core.exceptions import (
    CloudASRAuthError,
    CloudASRQuotaError,
    CloudASRTranscriptionError,
    ConfigurationError,
    ModelError,
)
from stt.streaming.engine_switch import EngineSwitchController


class _Recorder:
    """Captures the injected-primitive interactions."""

    def __init__(self, *, build_ok: bool = True) -> None:
        self.build_calls = 0
        self.applied: list[Any] = []
        self.published: list[dict[str, Any]] = []
        self._build_ok = build_ok

    async def build_fallback(self) -> Any:
        self.build_calls += 1
        if not self._build_ok:
            raise RuntimeError("fallback build failed")
        return f"fallback-callable-{self.build_calls}"

    def apply(self, new_callable: Any) -> None:
        self.applied.append(new_callable)

    async def publish(
        self, from_pipeline: str, to_pipeline: str, reason: str, utterance_index: int | None
    ) -> None:
        self.published.append(
            {
                "from": from_pipeline,
                "to": to_pipeline,
                "reason": reason,
                "utterance_index": utterance_index,
            }
        )


def _make_controller(
    rec: _Recorder,
    *,
    fallback_pipeline_id: str | None = "fb-pipe",
    auto_switch_enabled: bool = True,
    threshold: int = 2,
) -> EngineSwitchController:
    return EngineSwitchController(
        session_id="sess-1",
        tenant_id="tenant-a",
        primary_pipeline_id="primary-pipe",
        fallback_pipeline_id=fallback_pipeline_id,
        build_fallback=rec.build_fallback,
        apply_callable=rec.apply,
        publish_switch=rec.publish,
        auto_switch_enabled=auto_switch_enabled,
        consecutive_failure_threshold=threshold,
    )


@pytest.mark.asyncio
async def test_auth_error_switches_immediately():
    rec = _Recorder()
    ctrl = _make_controller(rec)

    switched = await ctrl.record_failure(CloudASRAuthError("bad key"), utterance_index=3)

    assert switched is True
    assert ctrl.switched is True
    assert ctrl.active_engine == "fallback"
    assert rec.build_calls == 1
    assert rec.applied == ["fallback-callable-1"]
    assert rec.published == [
        {"from": "primary-pipe", "to": "fb-pipe", "reason": "auto", "utterance_index": 3}
    ]


@pytest.mark.asyncio
async def test_quota_error_switches_immediately():
    rec = _Recorder()
    ctrl = _make_controller(rec)

    assert await ctrl.record_failure(CloudASRQuotaError("429")) is True
    assert ctrl.switched is True


@pytest.mark.asyncio
async def test_transcription_error_switches_only_after_threshold():
    rec = _Recorder()
    ctrl = _make_controller(rec, threshold=2)

    # First transcription failure: no switch yet.
    assert await ctrl.record_failure(CloudASRTranscriptionError("5xx")) is False
    assert ctrl.switched is False
    assert rec.build_calls == 0

    # Second consecutive: switch.
    assert await ctrl.record_failure(CloudASRTranscriptionError("5xx")) is True
    assert ctrl.switched is True
    assert rec.build_calls == 1


@pytest.mark.asyncio
async def test_success_resets_consecutive_failure_run():
    rec = _Recorder()
    ctrl = _make_controller(rec, threshold=2)

    assert await ctrl.record_failure(ModelError("blip")) is False
    ctrl.record_success()  # resets the run
    assert await ctrl.record_failure(ModelError("blip")) is False  # count is 1 again
    assert ctrl.switched is False
    assert rec.build_calls == 0


@pytest.mark.asyncio
async def test_switch_is_one_way_no_flapping():
    rec = _Recorder()
    ctrl = _make_controller(rec)

    assert await ctrl.record_failure(CloudASRAuthError("x")) is True
    # A second failure after the switch does nothing (one-way per session).
    assert await ctrl.record_failure(CloudASRAuthError("x")) is False
    assert await ctrl.switch_manual() is False
    assert rec.build_calls == 1  # only ever built once
    assert len(rec.published) == 1


@pytest.mark.asyncio
async def test_manual_switch_publishes_user_reason():
    rec = _Recorder()
    ctrl = _make_controller(rec)

    assert await ctrl.switch_manual(utterance_index=7) is True
    assert ctrl.switched is True
    assert rec.published[0]["reason"] == "user"
    assert rec.published[0]["utterance_index"] == 7


@pytest.mark.asyncio
async def test_no_fallback_never_switches():
    rec = _Recorder()
    ctrl = _make_controller(rec, fallback_pipeline_id=None)

    assert ctrl.has_fallback is False
    assert await ctrl.record_failure(CloudASRAuthError("x")) is False
    assert await ctrl.switch_manual() is False
    assert rec.build_calls == 0
    assert rec.published == []


@pytest.mark.asyncio
async def test_auto_switch_disabled_blocks_auto_but_allows_manual():
    rec = _Recorder()
    ctrl = _make_controller(rec, auto_switch_enabled=False)

    # Auto trigger is suppressed…
    assert await ctrl.record_failure(CloudASRAuthError("x")) is False
    assert ctrl.switched is False
    # …but an explicit user request still switches.
    assert await ctrl.switch_manual() is True
    assert ctrl.switched is True


@pytest.mark.asyncio
async def test_ignore_class_error_does_not_count_toward_threshold():
    rec = _Recorder()
    ctrl = _make_controller(rec, threshold=2)

    # A non-cloud, non-model error is ignored (not a provider outage).
    assert await ctrl.record_failure(ConfigurationError("bad yaml")) is False
    assert await ctrl.record_failure(ConfigurationError("bad yaml")) is False
    assert ctrl.switched is False
    assert rec.build_calls == 0


@pytest.mark.asyncio
async def test_create_time_switch_flips_state_without_building():
    rec = _Recorder()
    ctrl = _make_controller(rec)

    # The manager already installed the fallback callable at create; this only
    # records the switch (no build) and emits the observable event.
    await ctrl.note_switched_at_create(utterance_index=0)

    assert ctrl.switched is True
    assert rec.build_calls == 0
    assert rec.applied == []
    assert rec.published == [
        {"from": "primary-pipe", "to": "fb-pipe", "reason": "auto", "utterance_index": 0}
    ]


@pytest.mark.asyncio
async def test_build_failure_propagates_and_stays_on_primary():
    rec = _Recorder(build_ok=False)
    ctrl = _make_controller(rec)

    # Selection is fail-closed: a fallback that cannot be built raises rather
    # than silently no-op'ing; the session stays on the primary.
    with pytest.raises(RuntimeError):
        await ctrl.record_failure(CloudASRAuthError("x"))
    assert ctrl.switched is False
    assert rec.applied == []
    assert rec.published == []
