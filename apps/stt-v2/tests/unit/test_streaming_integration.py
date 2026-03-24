"""Integration tests for SessionManager with preprocessor + inference wiring.

Tests the _make_frame_handler and _make_control_handler methods with
actual StreamingPreprocessor and StreamingInferenceWorker instances
(mocked at the VAD/ASR level).
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest

from stt_v2.streaming.inference import StreamingInferenceWorker
from stt_v2.streaming.preprocessor import AudioUtterance, StreamingPreprocessor
from stt_v2.streaming.schemas import (
    AudioEncoding,
    AudioFrame,
    ControlAction,
    SegmentResult,
    SessionControl,
    SessionMetadata,
    SessionStatus,
)
from stt_v2.streaming.session import StreamSession
from stt_v2.streaming.session_manager import SessionManager

# =========================================================================
# Helpers
# =========================================================================


def _make_mock_redis():
    """Create a mock async Redis client.

    IMPORTANT: xread must yield control via asyncio.sleep to prevent
    the IngestionConsumer/ControlListener background tasks from
    spin-looping and hanging the event loop.
    """
    redis = AsyncMock()
    redis.hset = AsyncMock(return_value=True)
    redis.expire = AsyncMock(return_value=True)
    redis.exists = AsyncMock(return_value=False)
    redis.scan = AsyncMock(return_value=(0, []))
    redis.delete = AsyncMock(return_value=1)
    redis.xadd = AsyncMock(return_value=b"1-0")

    async def _slow_xread(*args, **kwargs):
        await asyncio.sleep(0.05)
        return []

    redis.xread = AsyncMock(side_effect=_slow_xread)
    return redis


def _make_mock_profile(max_concurrent: int = 5):
    """Create a mock ExecutionProfile."""
    profile = MagicMock()
    profile.max_concurrent_streams = max_concurrent
    profile.platform = MagicMock(value="cpu")
    profile.device_name = "test-cpu"
    profile.asr_device = "cpu"
    profile.asr_max_batch_size = 1
    profile.embedding_device = "cpu"
    return profile


def _make_audio_frame(seq: int = 0, final: bool = False) -> AudioFrame:
    """Create a test AudioFrame with real PCM data."""
    num_samples = 512
    t = np.linspace(0, 0.032, num_samples)
    wave = (10000 * np.sin(2 * np.pi * 440 * t)).astype(np.int16)
    return AudioFrame(
        seq=seq,
        sr=16000,
        enc=AudioEncoding.PCM_S16LE,
        ch=1,
        data=wave.tobytes(),
        final=final,
        ts=0.0,
    )


# =========================================================================
# Tests: Frame handler with preprocessor + inference
# =========================================================================


class TestFrameHandlerIntegration:
    """Test _make_frame_handler with preprocessor and inference worker."""

    def _make_manager(self) -> tuple[SessionManager, AsyncMock]:
        redis = _make_mock_redis()
        profile = _make_mock_profile()
        mgr = SessionManager(redis=redis, profile=profile, worker_id="test-worker")
        return mgr, redis

    def _make_session(self, redis) -> StreamSession:
        meta = SessionMetadata(
            session_id="test-sess",
            tenant_id="t1",
            pipeline_id="p1",
            worker_id="test-worker",
        )
        return StreamSession(metadata=meta, redis=redis)

    @pytest.mark.asyncio
    async def test_frame_handler_without_preprocessor(self):
        """Without preprocessor, handler should only record frames."""
        mgr, redis = self._make_manager()
        session = self._make_session(redis)

        handler = mgr._make_frame_handler(session)
        frame = _make_audio_frame(seq=1)

        await handler(frame)

        assert session.last_seq == 1
        assert session.total_samples_received > 0

    @pytest.mark.asyncio
    async def test_frame_handler_with_preprocessor_no_utterance(self):
        """With preprocessor that produces no utterances, should still record."""
        mgr, redis = self._make_manager()
        session = self._make_session(redis)

        # VAD returns silence — no utterances
        preprocessor = StreamingPreprocessor(
            session_id="test-sess",
            vad_service=MagicMock(is_loaded=True, process_chunk=MagicMock(return_value=0.1)),
            threshold=0.5,
            min_speech_duration_ms=32,
        )
        inference = StreamingInferenceWorker()

        handler = mgr._make_frame_handler(session, preprocessor, inference)
        frame = _make_audio_frame(seq=1)

        await handler(frame)

        assert session.last_seq == 1
        assert len(session.results) == 0

    @pytest.mark.asyncio
    async def test_frame_handler_with_utterance_production(self):
        """With preprocessor that produces an utterance, inference should run."""
        mgr, redis = self._make_manager()
        session = self._make_session(redis)

        # Mock preprocessor that returns a fake utterance
        mock_pp = AsyncMock(spec=StreamingPreprocessor)
        mock_utt = AudioUtterance(
            samples=np.zeros(512, dtype=np.float32),
            sample_rate=16000,
            start_time=0.0,
            end_time=0.032,
            utterance_index=0,
        )
        mock_pp.feed = AsyncMock(return_value=[mock_utt])
        mock_pp.utterance_count = 1

        # Mock inference that returns a result
        mock_result = SegmentResult(text="hello", start_time=0.0, end_time=0.032)
        mock_inf = AsyncMock(spec=StreamingInferenceWorker)
        mock_inf.process_utterance = AsyncMock(return_value=mock_result)

        handler = mgr._make_frame_handler(session, mock_pp, mock_inf)
        frame = _make_audio_frame(seq=1)

        await handler(frame)

        mock_pp.feed.assert_awaited_once_with(frame.data)
        mock_inf.process_utterance.assert_awaited_once_with("test-sess", mock_utt)
        assert len(session.results) == 1
        assert session.results[0].text == "hello"
        assert session.utterance_count == 1

    @pytest.mark.asyncio
    async def test_frame_handler_multiple_utterances_in_one_frame(self):
        """If preprocessor returns multiple utterances, all should be processed."""
        mgr, redis = self._make_manager()
        session = self._make_session(redis)

        mock_pp = AsyncMock(spec=StreamingPreprocessor)
        utts = [
            AudioUtterance(np.zeros(100, dtype=np.float32), 16000, 0.0, 0.5, 0),
            AudioUtterance(np.zeros(100, dtype=np.float32), 16000, 0.5, 1.0, 1),
        ]
        mock_pp.feed = AsyncMock(return_value=utts)
        mock_pp.utterance_count = 2

        results = [
            SegmentResult(text="first", start_time=0.0, end_time=0.5),
            SegmentResult(text="second", start_time=0.5, end_time=1.0),
        ]
        mock_inf = AsyncMock(spec=StreamingInferenceWorker)
        mock_inf.process_utterance = AsyncMock(side_effect=results)

        handler = mgr._make_frame_handler(session, mock_pp, mock_inf)
        await handler(_make_audio_frame(seq=1))

        assert mock_inf.process_utterance.await_count == 2
        assert len(session.results) == 2
        assert session.results[0].text == "first"
        assert session.results[1].text == "second"

    @pytest.mark.asyncio
    async def test_final_frame_triggers_finalization(self):
        """Frame with final=True should trigger session finalization."""
        mgr, redis = self._make_manager()
        session = self._make_session(redis)

        # Need to register the session in the manager for finalize to work
        mgr._sessions["test-sess"] = session
        publisher = AsyncMock()
        publisher.publish_status = AsyncMock()
        mgr._publishers["test-sess"] = publisher

        handler = mgr._make_frame_handler(session)

        final_frame = _make_audio_frame(seq=1, final=True)
        await handler(final_frame)

        # Session should be closed after finalization
        assert session.status in (SessionStatus.FINALIZING, SessionStatus.CLOSED)


# =========================================================================
# Tests: Control handler with preprocessor flush
# =========================================================================


class TestControlHandlerIntegration:
    """Test _make_control_handler with preprocessor flush on FINALIZE."""

    def _make_manager(self) -> tuple[SessionManager, AsyncMock]:
        redis = _make_mock_redis()
        profile = _make_mock_profile()
        mgr = SessionManager(redis=redis, profile=profile, worker_id="test-worker")
        return mgr, redis

    def _make_session(self, redis) -> StreamSession:
        meta = SessionMetadata(
            session_id="test-sess",
            tenant_id="t1",
            pipeline_id="p1",
            worker_id="test-worker",
        )
        return StreamSession(metadata=meta, redis=redis)

    @pytest.mark.asyncio
    async def test_finalize_flushes_preprocessor(self):
        """FINALIZE control should flush preprocessor and run inference on remainder."""
        mgr, redis = self._make_manager()
        session = self._make_session(redis)

        mgr._sessions["test-sess"] = session
        publisher = AsyncMock()
        publisher.publish_status = AsyncMock()
        mgr._publishers["test-sess"] = publisher

        # Mock preprocessor that has remaining audio
        final_utt = AudioUtterance(
            samples=np.zeros(256, dtype=np.float32),
            sample_rate=16000,
            start_time=1.0,
            end_time=1.5,
            utterance_index=3,
            is_final=True,
        )
        mock_pp = AsyncMock(spec=StreamingPreprocessor)
        mock_pp.flush = AsyncMock(return_value=final_utt)
        mock_pp.utterance_count = 4

        mock_result = SegmentResult(text="final words", start_time=1.0, end_time=1.5, is_final=True)
        mock_inf = AsyncMock(spec=StreamingInferenceWorker)
        mock_inf.process_utterance = AsyncMock(return_value=mock_result)

        control_handler = mgr._make_control_handler(session, mock_pp, mock_inf)

        finalize_cmd = SessionControl(action=ControlAction.FINALIZE)
        await control_handler(finalize_cmd)

        mock_pp.flush.assert_awaited_once()
        mock_inf.process_utterance.assert_awaited_once_with("test-sess", final_utt)
        assert any(r.text == "final words" for r in session.results)

    @pytest.mark.asyncio
    async def test_finalize_no_remaining_audio(self):
        """FINALIZE when preprocessor has no remaining audio."""
        mgr, redis = self._make_manager()
        session = self._make_session(redis)

        mgr._sessions["test-sess"] = session
        publisher = AsyncMock()
        publisher.publish_status = AsyncMock()
        mgr._publishers["test-sess"] = publisher

        mock_pp = AsyncMock(spec=StreamingPreprocessor)
        mock_pp.flush = AsyncMock(return_value=None)
        mock_pp.utterance_count = 0

        mock_inf = AsyncMock(spec=StreamingInferenceWorker)

        control_handler = mgr._make_control_handler(session, mock_pp, mock_inf)

        finalize_cmd = SessionControl(action=ControlAction.FINALIZE)
        await control_handler(finalize_cmd)

        mock_pp.flush.assert_awaited_once()
        mock_inf.process_utterance.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_cancel_does_not_flush(self):
        """CANCEL control should NOT flush preprocessor."""
        mgr, redis = self._make_manager()
        session = self._make_session(redis)

        mgr._sessions["test-sess"] = session
        publisher = AsyncMock()
        publisher.publish_status = AsyncMock()
        mgr._publishers["test-sess"] = publisher

        mock_pp = AsyncMock(spec=StreamingPreprocessor)
        mock_inf = AsyncMock(spec=StreamingInferenceWorker)

        control_handler = mgr._make_control_handler(session, mock_pp, mock_inf)

        cancel_cmd = SessionControl(action=ControlAction.CANCEL)
        await control_handler(cancel_cmd)

        mock_pp.flush.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_control_handler_without_preprocessor(self):
        """Control handler without preprocessor should still work."""
        mgr, redis = self._make_manager()
        session = self._make_session(redis)

        mgr._sessions["test-sess"] = session
        publisher = AsyncMock()
        publisher.publish_status = AsyncMock()
        mgr._publishers["test-sess"] = publisher

        control_handler = mgr._make_control_handler(session)

        finalize_cmd = SessionControl(action=ControlAction.FINALIZE)
        await control_handler(finalize_cmd)

        # Session should be finalized
        assert session.status in (SessionStatus.FINALIZING, SessionStatus.CLOSED)


# =========================================================================
# Tests: create_session now creates preprocessor + inference
# =========================================================================


class TestCreateSessionIntegration:
    """Test that create_session wires preprocessor and inference worker."""

    @pytest.mark.asyncio
    async def test_create_session_stores_preprocessor(self):
        """create_session should store a preprocessor in _preprocessors."""
        redis = _make_mock_redis()
        profile = _make_mock_profile()
        mgr = SessionManager(redis=redis, profile=profile, worker_id="test")

        session = await mgr.create_session(
            session_id="s1",
            tenant_id="t1",
            pipeline_id="p1",
        )

        try:
            assert session is not None
            assert "s1" in mgr._preprocessors
            assert isinstance(mgr._preprocessors["s1"], StreamingPreprocessor)
        finally:
            await mgr.remove_session("s1")

    @pytest.mark.asyncio
    async def test_create_session_stores_inference_worker(self):
        """create_session should store an inference worker."""
        redis = _make_mock_redis()
        profile = _make_mock_profile()
        mgr = SessionManager(redis=redis, profile=profile, worker_id="test")

        session = await mgr.create_session(
            session_id="s2",
            tenant_id="t1",
            pipeline_id="p1",
        )

        try:
            assert session is not None
            assert "s2" in mgr._inference_workers
            assert isinstance(mgr._inference_workers["s2"], StreamingInferenceWorker)
        finally:
            await mgr.remove_session("s2")

    @pytest.mark.asyncio
    async def test_remove_session_cleans_preprocessor(self):
        """remove_session should clean up preprocessor and inference worker."""
        redis = _make_mock_redis()
        profile = _make_mock_profile()
        mgr = SessionManager(redis=redis, profile=profile, worker_id="test")

        await mgr.create_session(
            session_id="s3",
            tenant_id="t1",
            pipeline_id="p1",
        )

        assert "s3" in mgr._preprocessors
        assert "s3" in mgr._inference_workers

        await mgr.remove_session("s3")

        assert "s3" not in mgr._preprocessors
        assert "s3" not in mgr._inference_workers
        assert "s3" not in mgr._sessions

    @pytest.mark.asyncio
    async def test_stop_clears_all(self):
        """SessionManager.stop() should clear preprocessors and workers."""
        redis = _make_mock_redis()
        profile = _make_mock_profile()
        mgr = SessionManager(redis=redis, profile=profile, worker_id="test")
        mgr._running = True

        await mgr.create_session("s4", "t1", "p1")
        await mgr.create_session("s5", "t1", "p1")

        assert len(mgr._preprocessors) == 2
        assert len(mgr._inference_workers) == 2

        await mgr.stop()

        assert len(mgr._preprocessors) == 0
        assert len(mgr._inference_workers) == 0


# =========================================================================
# Tests: SessionManager._guard alias
# =========================================================================


class TestGuardAlias:
    """Test that _guard alias works for API routes."""

    def test_guard_alias_matches_capacity_guard(self):
        redis = _make_mock_redis()
        profile = _make_mock_profile(max_concurrent=8)
        mgr = SessionManager(redis=redis, profile=profile, worker_id="test")

        assert mgr._guard is mgr._capacity_guard
        assert mgr._guard.max_streams == 8
