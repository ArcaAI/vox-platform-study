"""Unit tests for the per-session EngineSwitchController (TASK-567 §3.4, TASK-586).

Tier-1 style: no Redis, no models — the controller is exercised in isolation
with fakes for the injected primitives (build primary / build fallback / apply /
publish). Covers every trigger path in plan §5 item 12, plus the TASK-586
bidirectional user-initiated switch, its cooldown, and the auto-path one-way
invariant.
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


class _Clock:
    """A controllable monotonic clock for cooldown assertions."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class _Recorder:
    """Captures the injected-primitive interactions."""

    def __init__(self, *, build_ok: bool = True, primary_build_ok: bool = True) -> None:
        self.build_calls = 0
        self.primary_build_calls = 0
        self.applied: list[Any] = []
        self.published: list[dict[str, Any]] = []
        self._build_ok = build_ok
        self._primary_build_ok = primary_build_ok

    async def build_fallback(self) -> Any:
        self.build_calls += 1
        if not self._build_ok:
            raise RuntimeError("fallback build failed")
        return f"fallback-callable-{self.build_calls}"

    async def build_primary(self) -> Any:
        self.primary_build_calls += 1
        if not self._primary_build_ok:
            raise RuntimeError("primary build failed")
        return f"primary-callable-{self.primary_build_calls}"

    def apply(self, new_callable: Any) -> None:
        self.applied.append(new_callable)

    async def publish(
        self,
        from_pipeline: str,
        to_pipeline: str,
        reason: str,
        active: str,
        utterance_index: int | None,
    ) -> None:
        self.published.append(
            {
                "from": from_pipeline,
                "to": to_pipeline,
                "reason": reason,
                "active": active,
                "utterance_index": utterance_index,
            }
        )


def _make_controller(
    rec: _Recorder,
    *,
    fallback_pipeline_id: str | None = "fb-pipe",
    auto_switch_enabled: bool = True,
    threshold: int = 2,
    with_primary_builder: bool = True,
    clock: _Clock | None = None,
    cooldown_s: float = 1.5,
) -> EngineSwitchController:
    return EngineSwitchController(
        session_id="sess-1",
        tenant_id="tenant-a",
        primary_pipeline_id="primary-pipe",
        fallback_pipeline_id=fallback_pipeline_id,
        build_fallback=rec.build_fallback,
        build_primary=rec.build_primary if with_primary_builder else None,
        apply_callable=rec.apply,
        publish_switch=rec.publish,
        auto_switch_enabled=auto_switch_enabled,
        consecutive_failure_threshold=threshold,
        manual_switch_cooldown_s=cooldown_s,
        clock=clock or _Clock(),
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
        {
            "from": "primary-pipe",
            "to": "fb-pipe",
            "reason": "auto",
            "active": "fallback",
            "utterance_index": 3,
        }
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
async def test_auto_switch_is_one_way_no_flapping():
    """record_failure (auto) is one-way primary→fallback, never back."""
    rec = _Recorder()
    ctrl = _make_controller(rec)

    assert await ctrl.record_failure(CloudASRAuthError("x")) is True
    # A second failure after the switch does nothing (auto never auto-returns).
    assert await ctrl.record_failure(CloudASRAuthError("x")) is False
    assert rec.build_calls == 1  # only ever built once
    assert len(rec.published) == 1


@pytest.mark.asyncio
async def test_manual_switch_to_fallback_publishes_user_reason():
    rec = _Recorder()
    ctrl = _make_controller(rec)

    assert await ctrl.switch_manual("fallback", utterance_index=7) is True
    assert ctrl.switched is True
    assert ctrl.active_engine == "fallback"
    assert rec.published[0]["reason"] == "user"
    assert rec.published[0]["active"] == "fallback"
    assert rec.published[0]["utterance_index"] == 7


@pytest.mark.asyncio
async def test_manual_switch_defaults_to_fallback_for_backcompat():
    rec = _Recorder()
    ctrl = _make_controller(rec)

    # No target argument ⇒ fallback (native path back-compat).
    assert await ctrl.switch_manual() is True
    assert ctrl.active_engine == "fallback"


@pytest.mark.asyncio
async def test_manual_switch_is_bidirectional():
    """User-initiated switches go fallback→primary as well as primary→fallback."""
    clock = _Clock()
    rec = _Recorder()
    ctrl = _make_controller(rec, clock=clock)

    # primary → fallback
    assert await ctrl.switch_manual("fallback", utterance_index=1) is True
    assert ctrl.active_engine == "fallback"
    assert ctrl.switched is True

    # advance past cooldown, then fallback → primary
    clock.advance(2.0)
    assert await ctrl.switch_manual("primary", utterance_index=5) is True
    assert ctrl.active_engine == "primary"
    assert ctrl.switched is False  # switch-back clears `switched`
    assert rec.primary_build_calls == 1
    assert rec.applied == ["fallback-callable-1", "primary-callable-1"]
    # The switch-back frame reverses from/to and reports active=primary.
    assert rec.published[-1] == {
        "from": "fb-pipe",
        "to": "primary-pipe",
        "reason": "user",
        "active": "primary",
        "utterance_index": 5,
    }


@pytest.mark.asyncio
async def test_manual_switch_cooldown_rejects_rapid_second_switch():
    clock = _Clock()
    rec = _Recorder()
    ctrl = _make_controller(rec, clock=clock, cooldown_s=1.5)

    assert await ctrl.switch_manual("fallback") is True

    # Within the cooldown window: rejected (returns False, no raise, no switch).
    clock.advance(0.5)
    assert await ctrl.switch_manual("primary") is False
    assert ctrl.active_engine == "fallback"  # unchanged
    assert rec.primary_build_calls == 0

    # After the cooldown elapses: allowed.
    clock.advance(1.1)  # total 1.6s since first switch
    assert await ctrl.switch_manual("primary") is True
    assert ctrl.active_engine == "primary"


@pytest.mark.asyncio
async def test_manual_switch_to_same_target_is_noop():
    rec = _Recorder()
    ctrl = _make_controller(rec)

    # Already on primary: requesting primary is a no-op (False), no build.
    assert await ctrl.switch_manual("primary") is False
    assert rec.primary_build_calls == 0
    assert rec.published == []


@pytest.mark.asyncio
async def test_manual_switch_ignores_auto_toggle():
    rec = _Recorder()
    ctrl = _make_controller(rec, auto_switch_enabled=False)

    # Auto trigger is suppressed…
    assert await ctrl.record_failure(CloudASRAuthError("x")) is False
    assert ctrl.switched is False
    # …but an explicit user request still switches.
    assert await ctrl.switch_manual("fallback") is True
    assert ctrl.switched is True


@pytest.mark.asyncio
async def test_switch_to_primary_when_primary_never_loaded_is_rejected():
    """After a create-time fallback (primary never loaded), a user switch back to
    primary is unavailable → returns False (→ 409 upstream)."""
    rec = _Recorder()
    ctrl = _make_controller(rec)

    await ctrl.note_switched_at_create(utterance_index=0)
    assert ctrl.active_engine == "fallback"
    assert ctrl.can_switch_to_primary is False

    assert await ctrl.switch_manual("primary") is False
    assert ctrl.active_engine == "fallback"
    assert rec.primary_build_calls == 0


@pytest.mark.asyncio
async def test_can_switch_to_primary_reflects_builder_and_availability():
    rec = _Recorder()

    # No primary builder injected ⇒ cannot switch back.
    ctrl_no_builder = _make_controller(rec, with_primary_builder=False)
    assert ctrl_no_builder.can_switch_to_primary is False

    # Builder present + primary loaded ⇒ can switch back.
    ctrl = _make_controller(rec)
    assert ctrl.can_switch_to_primary is True


@pytest.mark.asyncio
async def test_no_fallback_never_switches():
    rec = _Recorder()
    ctrl = _make_controller(rec, fallback_pipeline_id=None)

    assert ctrl.has_fallback is False
    assert await ctrl.record_failure(CloudASRAuthError("x")) is False
    assert await ctrl.switch_manual("fallback") is False
    assert rec.build_calls == 0
    assert rec.published == []


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
        {
            "from": "primary-pipe",
            "to": "fb-pipe",
            "reason": "auto",
            "active": "fallback",
            "utterance_index": 0,
        }
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


@pytest.mark.asyncio
async def test_note_started_on_fallback_keeps_primary_switchable_and_emits_nothing():
    """User-selected start-on-fallback (TASK-586 C9): the session opens on the
    fallback by deliberate choice, so unlike a create-time load failure the
    primary stays available/switchable and NO provider_switched event is
    emitted (there is no transition to announce)."""
    rec = _Recorder()
    ctrl = _make_controller(rec)

    await ctrl.note_started_on_fallback()

    assert ctrl.active_engine == "fallback"
    assert ctrl.switched is True
    # Deliberate choice — primary is untouched and remains switchable.
    assert ctrl._primary_available is True
    assert ctrl.can_switch_to_primary is True
    # No build, no apply, and crucially no publish/emit.
    assert rec.build_calls == 0
    assert rec.applied == []
    assert rec.published == []


@pytest.mark.asyncio
async def test_note_started_on_fallback_allows_switch_back_to_primary():
    """A subsequent manual switch back to the primary must succeed."""
    rec = _Recorder()
    ctrl = _make_controller(rec)

    await ctrl.note_started_on_fallback()
    assert ctrl.active_engine == "fallback"

    assert await ctrl.switch_manual("primary") is True
    assert ctrl.active_engine == "primary"
    assert rec.primary_build_calls == 1
    assert rec.published == [
        {
            "from": "fb-pipe",
            "to": "primary-pipe",
            "reason": "user",
            "active": "primary",
            "utterance_index": None,
        }
    ]


@pytest.mark.asyncio
async def test_note_started_on_fallback_is_noop_when_already_switched():
    rec = _Recorder()
    ctrl = _make_controller(rec)

    await ctrl.note_started_on_fallback()
    await ctrl.note_started_on_fallback()  # second call is a no-op

    assert ctrl.active_engine == "fallback"
    assert rec.published == []
