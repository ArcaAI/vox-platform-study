"""Unit tests for user-selected start-on-fallback at session create.

Exercises ``SessionManager.create_session(start_on=...)`` in isolation: the
heavy assembly is mocked, but the REAL ``_make_switch_controller`` is bound so
the per-session ``EngineSwitchController`` state can be asserted. Contrast with
the create-time load-failure path (``created_on_fallback``), which marks the
primary unavailable and emits a switch event.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt.streaming.session_manager import SessionManager


def _make_manager() -> MagicMock:
    mgr = MagicMock(spec=SessionManager)
    mgr._sessions = {}
    mgr._consumers = {}
    mgr._control_listeners = {}
    mgr._publishers = {}
    mgr._preprocessors = {}
    mgr._inference_workers = {}
    mgr._dual_capture = {}
    mgr._commit_policies = {}
    mgr._switch_controllers = {}
    mgr._provider_overrides = {}
    mgr._fallback_pipeline_ids = {}
    mgr._session_language_modes = {}

    mgr._redis = AsyncMock()
    mgr._worker_id = "test-worker"
    mgr._capacity_guard = MagicMock()
    mgr._capacity_guard.try_acquire = AsyncMock(return_value=True)
    mgr._register_inference_runtime = MagicMock()
    mgr._make_frame_handler = MagicMock(return_value=lambda x: None)
    mgr._make_batch_handler = MagicMock(return_value=lambda x: None)
    mgr._make_control_handler = MagicMock(return_value=lambda x: None)
    mgr._make_commit_policy = MagicMock(return_value=None)
    mgr._resolve_dual_capture = MagicMock(return_value=False)
    mgr.remove_session = AsyncMock()
    type(mgr).active_session_count = 1

    # Real switch-controller factory so we can assert its state.
    mgr._make_switch_controller = lambda **kw: SessionManager._make_switch_controller(mgr, **kw)

    # Mock the heavy assembly + config load. _load_pipeline_config records the
    # pipeline_id it was asked to load so the test can prove which engine was
    # assembled first.
    mgr._loaded_pipeline_ids = []

    async def _load_cfg(pid, tenant_id=None):
        mgr._loaded_pipeline_ids.append(pid)
        return MagicMock()

    mgr._load_pipeline_config = AsyncMock(side_effect=_load_cfg)
    mgr._assemble_session_runtime = AsyncMock(return_value=MagicMock())
    return mgr


async def _create(mgr, **overrides):
    kwargs = {"session_id": "s1", "tenant_id": "t1", "pipeline_id": "primary-pipe"}
    kwargs.update(overrides)
    with (
        patch("stt.streaming.session_manager.StreamSession") as mock_sess_cls,
        patch("stt.streaming.session_manager.IngestionConsumer") as mock_ic,
        patch("stt.streaming.session_manager.ControlListener") as mock_cl,
    ):
        mock_sess_cls.return_value.force_persist = AsyncMock()
        mock_ic.return_value.start = AsyncMock()
        mock_cl.return_value.start = AsyncMock()
        return await SessionManager.create_session(mgr, **kwargs)


@pytest.mark.asyncio
async def test_start_on_fallback_assembles_fallback_and_keeps_primary_switchable():
    mgr = _make_manager()

    await _create(mgr, fallback_pipeline_id="fb-pipe", start_on="fallback")

    # The FIRST (and only) config loaded is the fallback — the primary is never
    # attempted at create.
    assert mgr._loaded_pipeline_ids == ["fb-pipe"]
    assert mgr._assemble_session_runtime.await_count == 1

    ctrl = mgr._switch_controllers["s1"]
    assert ctrl.active_engine == "fallback"
    # Deliberate choice: primary stays switchable.
    assert ctrl.can_switch_to_primary is True
    assert ctrl._primary_available is True
    # No provider_switched event emitted for a start-on-fallback.
    mgr._publishers["s1"].publish_provider_switched.assert_not_called()


@pytest.mark.asyncio
async def test_start_on_fallback_without_fallback_configured_proceeds_on_primary():
    """Fail-open: start_on='fallback' but no fallback → assemble the primary."""
    mgr = _make_manager()

    await _create(mgr, fallback_pipeline_id=None, start_on="fallback")

    assert mgr._loaded_pipeline_ids == ["primary-pipe"]
    ctrl = mgr._switch_controllers["s1"]
    assert ctrl.active_engine == "primary"


@pytest.mark.asyncio
async def test_default_start_on_primary_is_unchanged():
    mgr = _make_manager()

    await _create(mgr, fallback_pipeline_id="fb-pipe")  # default start_on='primary'

    assert mgr._loaded_pipeline_ids == ["primary-pipe"]
    ctrl = mgr._switch_controllers["s1"]
    assert ctrl.active_engine == "primary"
    assert ctrl.can_switch_to_primary is True
