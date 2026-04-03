"""Integration tests for SessionManager with preprocessor + inference wiring.

Tests ``_make_frame_handler`` and ``_make_control_handler`` with real or mock
preprocessors. Frame handlers enqueue utterances to ``_inference_queues``;
ASR runs in background inference tasks (see ``create_session`` tests for worker wiring).
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
    """Test _make_frame_handler with preprocessor and inference queue enqueue."""

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

        handler = mgr._make_frame_handler(session, preprocessor)
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

        inference_queue = asyncio.Queue(maxsize=4)
        mgr._inference_queues["test-sess"] = inference_queue
        handler = mgr._make_frame_handler(session, mock_pp)
        frame = _make_audio_frame(seq=1)

        await handler(frame)

        mock_pp.feed.assert_awaited_once_with(frame.data)
        queued = inference_queue.get_nowait()
        assert queued is mock_utt

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

        inference_queue = asyncio.Queue(maxsize=4)
        mgr._inference_queues["test-sess"] = inference_queue
        handler = mgr._make_frame_handler(session, mock_pp)
        await handler(_make_audio_frame(seq=1))

        assert inference_queue.qsize() == 2

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
        """FINALIZE control should invoke flush/drain/finalize orchestration."""
        mgr, redis = self._make_manager()
        session = self._make_session(redis)

        mgr._sessions["test-sess"] = session
        publisher = AsyncMock()
        publisher.publish_status = AsyncMock()
        mgr._publishers["test-sess"] = publisher

        mock_pp = AsyncMock(spec=StreamingPreprocessor)

        mgr._flush_final_utterance = AsyncMock()
        mgr._drain_inference_queue = AsyncMock()
        mgr._finalize_session = AsyncMock()

        control_handler = mgr._make_control_handler(session, mock_pp)

        finalize_cmd = SessionControl(action=ControlAction.FINALIZE)
        await control_handler(finalize_cmd)

        mgr._flush_final_utterance.assert_awaited_once_with(session=session, preprocessor=mock_pp)
        mgr._drain_inference_queue.assert_awaited_once_with("test-sess")
        mgr._finalize_session.assert_awaited_once_with(session)

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

        mgr._flush_final_utterance = AsyncMock()
        mgr._drain_inference_queue = AsyncMock()
        mgr._finalize_session = AsyncMock()

        control_handler = mgr._make_control_handler(session, mock_pp)

        finalize_cmd = SessionControl(action=ControlAction.FINALIZE)
        await control_handler(finalize_cmd)

        mgr._flush_final_utterance.assert_awaited_once_with(session=session, preprocessor=mock_pp)
        mgr._drain_inference_queue.assert_awaited_once_with("test-sess")
        mgr._finalize_session.assert_awaited_once_with(session)

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

        control_handler = mgr._make_control_handler(session, mock_pp)

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
# Tests: SessionManager capacity guard
# =========================================================================


class TestGuardAlias:
    """``SessionManager`` exposes ``_capacity_guard`` for concurrent stream limits."""

    def test_capacity_guard_configured(self):
        redis = _make_mock_redis()
        profile = _make_mock_profile(max_concurrent=8)
        mgr = SessionManager(redis=redis, profile=profile, worker_id="test")

        assert mgr._capacity_guard.max_streams == 8
