"""Unit tests for SessionManager draining (TASK-726 Task 3).

Distinct from the existing startup-recovery/replay path (module docstring,
`SessionManager.start()`): draining is a PLANNED scale-down signal checked
at `create_session()` time, never touched by crash recovery. See
docs/implementation/TASK-726-Worker-Pool-Stt-Tts/design-notes.md §(a).
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from stt.core.exceptions import SessionManagerDrainingError
from stt.streaming.session_manager import SessionManager


class _FakeMgr:
    """Bare object carrying only the attributes begin_drain/is_draining/
    wait_for_drain touch — avoids constructing a real SessionManager (heavy
    ExecutionProfile/Redis deps) for logic that never reaches them."""

    def __init__(self) -> None:
        self._draining = False
        self._sessions: dict[str, object] = {}
        self._worker_id = "test-worker"


class TestBeginDrain:
    def test_is_draining_false_by_default(self):
        mgr = _FakeMgr()
        assert SessionManager.is_draining.fget(mgr) is False

    def test_begin_drain_sets_flag(self):
        mgr = _FakeMgr()
        SessionManager.begin_drain(mgr)
        assert SessionManager.is_draining.fget(mgr) is True

    def test_begin_drain_is_idempotent(self):
        mgr = _FakeMgr()
        SessionManager.begin_drain(mgr)
        SessionManager.begin_drain(mgr)  # must not raise or double-log-crash
        assert SessionManager.is_draining.fget(mgr) is True


class TestCreateSessionRejectsWhileDraining:
    @pytest.mark.asyncio
    async def test_create_session_raises_when_draining(self):
        mgr = MagicMock(spec=SessionManager)
        mgr._draining = True
        mgr._worker_id = "test-worker"

        with pytest.raises(SessionManagerDrainingError):
            await SessionManager.create_session(
                mgr, session_id="s1", tenant_id="t1", pipeline_id="p1"
            )

    @pytest.mark.asyncio
    async def test_create_session_draining_check_precedes_capacity_guard(self):
        """The draining check must short-circuit BEFORE the capacity guard is
        touched — proven by never configuring `_capacity_guard` on the mock;
        if the implementation checked capacity first, this would AttributeError
        on a MagicMock(spec=...) access instead of raising the drain error."""
        mgr = MagicMock(spec=SessionManager)
        mgr._draining = True
        mgr._worker_id = "test-worker"
        # _capacity_guard is deliberately never configured — a spec'd
        # MagicMock raises AttributeError on any unconfigured private
        # attribute access, so touching it before the drain check would fail
        # this test with the WRONG exception type.

        with pytest.raises(SessionManagerDrainingError):
            await SessionManager.create_session(
                mgr, session_id="s1", tenant_id="t1", pipeline_id="p1"
            )


class TestWaitForDrain:
    @pytest.mark.asyncio
    async def test_returns_true_once_sessions_clear(self):
        mgr = _FakeMgr()
        mgr._sessions = {"s1": object()}

        async def _clear_soon() -> None:
            await asyncio.sleep(0.03)
            mgr._sessions.clear()

        asyncio.create_task(_clear_soon())

        result = await SessionManager.wait_for_drain(mgr, timeout_s=2.0, poll_interval_s=0.01)

        assert result is True

    @pytest.mark.asyncio
    async def test_returns_false_on_timeout_with_sessions_still_active(self):
        mgr = _FakeMgr()
        mgr._sessions = {"s1": object()}

        result = await SessionManager.wait_for_drain(mgr, timeout_s=0.05, poll_interval_s=0.01)

        assert result is False
        assert mgr._sessions  # untouched — draining never evicts active sessions

    @pytest.mark.asyncio
    async def test_returns_true_immediately_with_no_active_sessions(self):
        mgr = _FakeMgr()
        result = await SessionManager.wait_for_drain(mgr, timeout_s=1.0, poll_interval_s=0.01)
        assert result is True


class TestToDictIncludesDraining:
    def test_to_dict_reports_draining_false_by_default(self):
        mgr = MagicMock(spec=SessionManager)
        mgr._draining = False
        mgr._worker_id = "w1"
        mgr.active_session_count = 0
        mgr._capacity_guard = MagicMock()
        mgr._capacity_guard.to_dict.return_value = {}
        mgr._profile = MagicMock()
        mgr._profile.platform.value = "linux"
        mgr._profile.device_name = "cpu"
        mgr._profile.max_concurrent_streams = 4
        mgr._profile.asr_device = "cpu"
        mgr._profile.asr_max_batch_size = 1
        mgr._profile.embedding_device = "cpu"
        mgr.list_sessions.return_value = []

        result = SessionManager.to_dict(mgr)

        assert result["draining"] is False

    def test_to_dict_reports_draining_true(self):
        mgr = MagicMock(spec=SessionManager)
        mgr._draining = True
        mgr._worker_id = "w1"
        mgr.active_session_count = 0
        mgr._capacity_guard = MagicMock()
        mgr._capacity_guard.to_dict.return_value = {}
        mgr._profile = MagicMock()
        mgr._profile.platform.value = "linux"
        mgr._profile.device_name = "cpu"
        mgr._profile.max_concurrent_streams = 4
        mgr._profile.asr_device = "cpu"
        mgr._profile.asr_max_batch_size = 1
        mgr._profile.embedding_device = "cpu"
        mgr.list_sessions.return_value = []

        result = SessionManager.to_dict(mgr)

        assert result["draining"] is True
