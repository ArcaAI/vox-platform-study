"""Unit tests for SessionManager -- partial dispatch and cancellation."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt_v2.streaming.inference import StreamingInferenceWorker
from stt_v2.streaming.preprocessor import AudioUtterance
from stt_v2.streaming.redis_streams import ResultPublisher
from stt_v2.streaming.schemas import SegmentResult


def _make_utterance(is_final: bool = False, index: int = 0) -> AudioUtterance:
    samples = np.random.randn(16000).astype(np.float32) * 0.1
    return AudioUtterance(
        samples=samples,
        sample_rate=16000,
        start_time=0.0,
        end_time=1.0,
        utterance_index=index,
        is_final=is_final,
    )


def _make_segment_result(is_final: bool = False, text: str = "hello") -> SegmentResult:
    return SegmentResult(
        text=text,
        start_time=0.0,
        end_time=1.0,
        is_final=is_final,
    )


@pytest.fixture
def session_manager():
    """Create a minimal SessionManager for testing partial dispatch."""
    with patch("stt_v2.streaming.session_manager.get_settings") as mock_settings:
        mock_settings.side_effect = Exception("no settings in test")
        from stt_v2.streaming.execution_profile import ExecutionProfile
        from stt_v2.streaming.session_manager import SessionManager

        profile = MagicMock(spec=ExecutionProfile)
        profile.max_concurrent_streams = 5
        redis = AsyncMock()
        mgr = SessionManager(redis=redis, profile=profile)
        return mgr


@pytest.mark.skip(reason="Partial dispatch (_fire_partial/_cancel_partial) not yet implemented in SessionManager")
class TestFirePartial:

    @pytest.mark.asyncio
    async def test_partial_utterance_fires_task(self, session_manager):
        """_fire_partial should create an asyncio.Task."""
        worker = AsyncMock(spec=StreamingInferenceWorker)
        worker.process_partial = AsyncMock(
            return_value=_make_segment_result(is_final=False, text="partial")
        )
        publisher = AsyncMock(spec=ResultPublisher)

        session_manager._fire_partial("sess-1", _make_utterance(), worker, publisher)

        assert "sess-1" in session_manager._partial_tasks
        # Let the task run
        await asyncio.sleep(0.05)
        worker.process_partial.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_final_cancels_in_flight_partial(self, session_manager):
        """_cancel_partial should cancel the in-flight task."""
        # Create a slow partial task
        slow_event = asyncio.Event()

        async def slow_partial(*args, **kwargs):
            await slow_event.wait()
            return _make_segment_result(is_final=False)

        worker = AsyncMock(spec=StreamingInferenceWorker)
        worker.process_partial = slow_partial
        publisher = AsyncMock(spec=ResultPublisher)

        session_manager._fire_partial("sess-1", _make_utterance(), worker, publisher)
        task = session_manager._partial_tasks.get("sess-1")
        assert task is not None

        # Cancel it (simulating a final arriving)
        session_manager._cancel_partial("sess-1")

        # Task should be cancelled
        await asyncio.sleep(0.05)
        assert task.cancelled() or task.done()

    @pytest.mark.asyncio
    async def test_new_partial_while_busy_keeps_existing_task(self, session_manager):
        """Consecutive partials should reuse the in-flight task."""
        slow_event = asyncio.Event()
        call_count = [0]

        async def slow_partial(*args, **kwargs):
            call_count[0] += 1
            await slow_event.wait()
            return _make_segment_result(is_final=False)

        worker = AsyncMock(spec=StreamingInferenceWorker)
        worker.process_partial = slow_partial
        publisher = AsyncMock(spec=ResultPublisher)

        session_manager._fire_partial("sess-1", _make_utterance(index=0), worker, publisher)
        first_task = session_manager._partial_tasks.get("sess-1")

        session_manager._fire_partial("sess-1", _make_utterance(index=1), worker, publisher)
        second_task = session_manager._partial_tasks.get("sess-1")

        assert first_task is second_task
        await asyncio.sleep(0.05)

        # Release the in-flight task and ensure only one partial ran.
        slow_event.set()
        await asyncio.sleep(0.05)
        assert call_count[0] == 1

    @pytest.mark.asyncio
    async def test_partial_cleanup_on_remove_session(self, session_manager):
        """remove_session should clean up partial tasks."""
        worker = AsyncMock(spec=StreamingInferenceWorker)
        worker.process_partial = AsyncMock(
            return_value=_make_segment_result(is_final=False)
        )
        publisher = AsyncMock(spec=ResultPublisher)

        session_manager._fire_partial("sess-1", _make_utterance(), worker, publisher)
        await asyncio.sleep(0.05)

        await session_manager.remove_session("sess-1")

        assert "sess-1" not in session_manager._partial_tasks
