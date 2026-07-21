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
    async def test_new_partial_skips_when_previous_in_flight(self, session_manager):
        """Skip-if-busy: second fire while first is pending keeps first task."""
        slow_event = asyncio.Event()

        async def slow_partial(*args, **kwargs):
            await slow_event.wait()
            return _make_segment_result(is_final=False)

        worker = AsyncMock(spec=StreamingInferenceWorker)
        worker.process_partial = slow_partial
        publisher = AsyncMock(spec=ResultPublisher)

        session_manager._fire_partial("sess-1", _make_utterance(index=0), worker, publisher)
        first_task = session_manager._partial_tasks.get("sess-1")

        session_manager._fire_partial("sess-1", _make_utterance(index=1), worker, publisher)
        second_task = session_manager._partial_tasks.get("sess-1")

        # skip-if-busy: task unchanged because first is still pending
        assert first_task is second_task

        slow_event.set()
        await asyncio.sleep(0.05)

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


class TestFirePartialCommitPolicy:
    """LocalAgreement-2 wiring in the partial publish flow."""

    @pytest.mark.asyncio
    async def test_consecutive_partials_publish_stable_chars(self, session_manager):
        """'hello wor' → 'hello world how' must publish stable_chars 0 then 5."""
        from stt_v2.streaming.commit_policy import LocalAgreementPolicy

        session_manager._commit_policies["sess-1"] = LocalAgreementPolicy()

        worker = AsyncMock(spec=StreamingInferenceWorker)
        publisher = AsyncMock(spec=ResultPublisher)

        worker.process_partial = AsyncMock(
            return_value=_make_segment_result(is_final=False, text="hello wor")
        )
        session_manager._fire_partial("sess-1", _make_utterance(index=0), worker, publisher)
        await asyncio.sleep(0.05)

        worker.process_partial = AsyncMock(
            return_value=_make_segment_result(is_final=False, text="hello world how")
        )
        session_manager._fire_partial("sess-1", _make_utterance(index=0), worker, publisher)
        await asyncio.sleep(0.05)

        published = [c.args[0] for c in publisher.publish.await_args_list]
        assert len(published) == 2
        assert published[0].text == "hello wor"
        assert published[0].stable_chars == 0
        assert published[1].text == "hello world how"
        # "hello" is the agreed prefix between the two hypotheses
        assert published[1].stable_chars == len("hello")

    @pytest.mark.asyncio
    async def test_policy_off_publishes_no_stable_chars(self, session_manager):
        """Without a commit policy the wire format is unchanged."""
        worker = AsyncMock(spec=StreamingInferenceWorker)
        worker.process_partial = AsyncMock(
            return_value=_make_segment_result(is_final=False, text="hello wor")
        )
        publisher = AsyncMock(spec=ResultPublisher)

        session_manager._fire_partial("sess-1", _make_utterance(), worker, publisher)
        await asyncio.sleep(0.05)

        published = publisher.publish.await_args_list[0].args[0]
        assert published.stable_chars is None
        assert "stable_chars" not in published.to_redis_dict()

    @pytest.mark.asyncio
    async def test_final_utterance_resets_policy(self, session_manager):
        """A final utterance routed via the frame handler resets the policy."""
        from stt_v2.streaming.commit_policy import LocalAgreementPolicy
        from stt_v2.streaming.schemas import AudioEncoding, AudioFrame, SessionStatus

        policy = LocalAgreementPolicy()
        policy.update("hello world")
        policy.update("hello world again")
        assert policy.committed_text != ""
        session_manager._commit_policies["sess-1"] = policy

        session = MagicMock()
        session.session_id = "sess-1"
        session.status = SessionStatus.ACTIVE
        session.persist_if_needed = AsyncMock(return_value=False)
        session.record_frame = MagicMock()

        preprocessor = AsyncMock()
        preprocessor.feed = AsyncMock(return_value=[_make_utterance(is_final=True)])
        preprocessor.drain_processed_samples = MagicMock(return_value=b"")

        queue = asyncio.Queue()
        session_manager._inference_queues["sess-1"] = queue

        handler = session_manager._make_frame_handler(session, preprocessor)
        frame = AudioFrame(
            seq=1, sr=16000, enc=AudioEncoding.PCM_S16LE, ch=1,
            data=b"\x00" * 320, final=False, ts=0.0,
        )
        await handler(frame)

        assert policy.committed_text == ""
        assert policy.tentative_text == ""
