"""Unit tests for the streaming architecture components.

Covers:
- schemas.py: AudioFrame, SegmentResult, SessionControl, SessionMetadata
- execution_profile.py: ExecutionProfile, detect_execution_profile()
- capacity_guard.py: CapacityGuard
- session.py: StreamSession
- redis_streams.py: IngestionConsumer, ResultPublisher, ControlListener
- session_manager.py: SessionManager
- _runtime.py: singleton accessors
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from stt.streaming.session import StreamSession
    from stt.streaming.session_manager import SessionManager

import json
import time
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

# ---------------------------------------------------------------------------
# Schema Tests
# ---------------------------------------------------------------------------


class TestAudioFrame:
    """Tests for AudioFrame serialization/deserialization."""

    def test_to_redis_dict(self):
        from stt.streaming.schemas import AudioEncoding, AudioFrame

        frame = AudioFrame(
            seq=42,
            sr=16000,
            enc=AudioEncoding.PCM_S16LE,
            ch=1,
            data=b"\x00\x01\x02\x03",
            final=False,
            ts=1738800000.123,
        )
        d = frame.to_redis_dict()
        assert d["seq"] == "42"
        assert d["sr"] == "16000"
        assert d["enc"] == "pcm_s16le"
        assert d["ch"] == "1"
        assert d["data"] == b"\x00\x01\x02\x03"
        assert d["final"] == "0"
        assert d["ts"] == "1738800000.123"

    def test_from_redis_dict_str_keys(self):
        from stt.streaming.schemas import AudioEncoding, AudioFrame

        d = {
            "seq": "42",
            "sr": "16000",
            "enc": "pcm_s16le",
            "ch": "1",
            "data": b"\x00\x01\x02\x03",
            "final": "1",
            "ts": "1738800000.123",
        }
        frame = AudioFrame.from_redis_dict(d)
        assert frame.seq == 42
        assert frame.sr == 16000
        assert frame.enc == AudioEncoding.PCM_S16LE
        assert frame.ch == 1
        assert frame.data == b"\x00\x01\x02\x03"
        assert frame.final is True
        assert frame.ts == pytest.approx(1738800000.123)

    def test_from_redis_dict_bytes_keys(self):
        from stt.streaming.schemas import AudioEncoding, AudioFrame

        d = {
            b"seq": b"10",
            b"sr": b"48000",
            b"enc": b"pcm_f32le",
            b"ch": b"1",
            b"data": b"\xff\xfe",
            b"final": b"0",
            b"ts": b"1000.5",
        }
        frame = AudioFrame.from_redis_dict(d)
        assert frame.seq == 10
        assert frame.sr == 48000
        assert frame.enc == AudioEncoding.PCM_F32LE
        assert frame.ch == 1
        assert frame.final is False

    def test_roundtrip(self):
        from stt.streaming.schemas import AudioEncoding, AudioFrame

        original = AudioFrame(
            seq=99,
            sr=16000,
            enc=AudioEncoding.PCM_S16LE,
            ch=1,
            data=b"\xab\xcd" * 480,
            final=True,
            ts=time.time(),
        )
        d = original.to_redis_dict()
        restored = AudioFrame.from_redis_dict(d)
        assert restored.seq == original.seq
        assert restored.sr == original.sr
        assert restored.enc == original.enc
        assert restored.data == original.data
        assert restored.final == original.final

    def test_from_redis_dict_missing_field_raises(self):
        from stt.streaming.schemas import AudioFrame

        with pytest.raises(KeyError, match="seq"):
            AudioFrame.from_redis_dict({"sr": "16000"})


class TestSegmentResult:
    """Tests for SegmentResult serialization/deserialization."""

    def test_to_redis_dict(self):
        from stt.streaming.schemas import SegmentResult

        result = SegmentResult(
            text="Hello world",
            english_text="Hello world",
            speaker_id="spk_123",
            speaker_confidence=0.95,
            start_time=1.5,
            end_time=3.2,
            is_final=True,
        )
        d = result.to_redis_dict()
        assert d["type"] == "segment"
        assert d["text"] == "Hello world"
        assert d["english_text"] == "Hello world"
        assert d["speaker_id"] == "spk_123"
        assert d["is_final"] == "1"

    def test_from_redis_dict(self):
        from stt.streaming.schemas import SegmentResult

        d = {
            "type": "segment",
            "text": "Test text",
            "english_text": "Translated text",
            "speaker_id": "spk_abc",
            "speaker_confidence": "0.85",
            "start_time": "2.0",
            "end_time": "4.5",
            "is_final": "0",
        }
        result = SegmentResult.from_redis_dict(d)
        assert result.text == "Test text"
        assert result.english_text == "Translated text"
        assert result.speaker_id == "spk_abc"
        assert result.speaker_confidence == pytest.approx(0.85)
        assert result.is_final is False

    def test_roundtrip(self):
        from stt.streaming.schemas import SegmentResult

        original = SegmentResult(
            text="Patient reports headache",
            english_text="Patient reports headache",
            speaker_id="spk_dr_smith",
            speaker_confidence=0.92,
            start_time=12.5,
            end_time=17.3,
            is_final=True,
        )
        d = original.to_redis_dict()
        restored = SegmentResult.from_redis_dict(d)
        assert restored.text == original.text
        assert restored.english_text == original.english_text
        assert restored.speaker_id == original.speaker_id
        assert restored.is_final == original.is_final

    def test_no_speaker(self):
        from stt.streaming.schemas import SegmentResult

        result = SegmentResult(text="No speaker info")
        d = result.to_redis_dict()
        # speaker_id is omitted when not set (conditional field)
        assert "speaker_id" not in d
        restored = SegmentResult.from_redis_dict(d)
        assert restored.speaker_id is None

    def test_word_timestamps_and_language_roundtrip(self):
        from stt.streaming.schemas import SegmentResult

        original = SegmentResult(
            text="hello mọi người",
            start_time=0.352,
            end_time=0.544,
            word_timestamps=[
                {
                    "word": "hello",
                    "start_time": 0.352,
                    "end_time": 0.416,
                    "confidence": 0.98,
                    "language": "en",
                },
                {
                    "word": "mọi",
                    "start_time": 0.416,
                    "end_time": 0.48,
                    "confidence": 0.98,
                    "language": "vi",
                },
            ],
        )

        d = original.to_redis_dict()
        assert "language" not in d
        assert "word_timestamps_json" in d

        restored = SegmentResult.from_redis_dict(d)
        assert len(restored.word_timestamps) == 2
        assert restored.word_timestamps[0]["word"] == "hello"
        assert restored.word_timestamps[0]["language"] == "en"

    def test_invalid_word_timestamps_json_is_ignored(self):
        from stt.streaming.schemas import SegmentResult

        restored = SegmentResult.from_redis_dict(
            {
                "text": "hello",
                "word_timestamps_json": "{not-json",
            }
        )
        assert restored.word_timestamps == []

    def test_pipeline_id_omitted_when_unset(self):
        """pipeline_id is omitted from the wire dict when unknown —
        same conditional pattern as `language` (never emitted as empty string)."""
        from stt.streaming.schemas import SegmentResult

        result = SegmentResult(text="No pipeline info")
        d = result.to_redis_dict()
        assert "pipeline_id" not in d
        restored = SegmentResult.from_redis_dict(d)
        assert restored.pipeline_id is None

    def test_pipeline_id_roundtrip(self):
        from stt.streaming.schemas import SegmentResult

        original = SegmentResult(
            text="Patient reports headache",
            start_time=0.0,
            end_time=1.0,
            is_final=True,
            pipeline_id="pipe-primary-001",
        )
        d = original.to_redis_dict()
        assert d["pipeline_id"] == "pipe-primary-001"

        restored = SegmentResult.from_redis_dict(d)
        assert restored.pipeline_id == "pipe-primary-001"


class TestSessionControl:
    """Tests for SessionControl serialization/deserialization."""

    def test_all_actions(self):
        from stt.streaming.schemas import ControlAction, SessionControl

        for action in ControlAction:
            ctrl = SessionControl(action=action)
            d = ctrl.to_redis_dict()
            assert d["action"] == action.value
            restored = SessionControl.from_redis_dict(d)
            assert restored.action == action

    def test_from_redis_dict_bytes(self):
        from stt.streaming.schemas import ControlAction, SessionControl

        d = {b"action": b"finalize"}
        ctrl = SessionControl.from_redis_dict(d)
        assert ctrl.action == ControlAction.FINALIZE

    def test_missing_action_raises(self):
        from stt.streaming.schemas import SessionControl

        with pytest.raises(KeyError, match="action"):
            SessionControl.from_redis_dict({})


class TestStreamingInferenceWorker:
    """Realtime streaming inference behavior tests."""

    @pytest.mark.asyncio
    async def test_process_utterance_publishes_inference_and_word_timestamps(self):
        from stt.streaming.inference import StreamingInferenceWorker
        from stt.streaming.preprocessor import AudioUtterance

        async def fake_pipeline(samples, sample_rate):
            await asyncio.sleep(0.01)
            return {
                "text": "hello world",
                "word_timestamps": [
                    {"word": "hello", "start": 0.0, "end": 0.3, "confidence": 0.98},
                    {"word": "world", "start": 0.31, "end": 0.62, "confidence": 0.97},
                ],
            }

        publisher = MagicMock()
        publisher.publish = AsyncMock(return_value="1-0")

        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=fake_pipeline,
        )

        utterance = AudioUtterance(
            samples=np.random.randn(16000).astype(np.float32) * 0.1,
            sample_rate=16000,
            start_time=1.0,
            end_time=2.0,
            utterance_index=0,
            is_final=True,
        )

        result = await worker.process_utterance("sess-1", utterance)

        assert result.text == "hello world"
        assert result.inference_ms > 0
        assert len(result.word_timestamps) == 2

        publisher.publish.assert_awaited_once()
        published_result = publisher.publish.await_args.args[0]
        payload = published_result.to_redis_dict()

        assert "inference_ms" in payload
        assert float(payload["inference_ms"]) > 0
        assert "word_timestamps_json" in payload

        parsed_word_ts = json.loads(payload["word_timestamps_json"])
        assert len(parsed_word_ts) == 2
        assert parsed_word_ts[0]["word"] == "hello"

    @pytest.mark.asyncio
    async def test_process_utterance_with_string_pipeline_still_sets_inference(self):
        from stt.streaming.inference import StreamingInferenceWorker
        from stt.streaming.preprocessor import AudioUtterance

        def fake_pipeline(samples, sample_rate):
            return "plain transcript"

        worker = StreamingInferenceWorker(asr_pipeline=fake_pipeline)
        utterance = AudioUtterance(
            samples=np.random.randn(8000).astype(np.float32) * 0.1,
            sample_rate=16000,
            start_time=0.0,
            end_time=0.5,
            utterance_index=1,
            is_final=True,
        )

        result = await worker.process_utterance("sess-2", utterance)

        assert result.text == "plain transcript"
        assert result.inference_ms >= 0
        assert result.word_timestamps == []
        payload = result.to_redis_dict()
        assert "inference_ms" in payload
        assert "word_timestamps_json" not in payload

    @pytest.mark.asyncio
    async def test_phrase_level_timestamp_is_split_to_per_word_for_streaming(self):
        from stt.streaming.inference import StreamingInferenceWorker
        from stt.streaming.preprocessor import AudioUtterance

        async def fake_pipeline(samples, sample_rate):
            return {
                "text": "How are you?",
                "word_timestamps": [
                    {
                        "word": " How are you?",
                        "start": 0,
                        "end": 1.6,
                        "confidence": 1,
                    }
                ],
            }

        worker = StreamingInferenceWorker(asr_pipeline=fake_pipeline)
        utterance = AudioUtterance(
            samples=np.zeros(16000, dtype=np.float32),
            sample_rate=16000,
            start_time=0.0,
            end_time=1.6,
            utterance_index=2,
            is_final=True,
        )

        result = await worker.process_utterance("sess-3", utterance)

        assert [wt["word"] for wt in result.word_timestamps] == ["How", "are", "you?"]
        assert result.word_timestamps[0]["start"] == pytest.approx(0.0, abs=1e-4)
        assert result.word_timestamps[-1]["end"] == pytest.approx(1.6, abs=1e-4)


class TestSessionMetadata:
    """Tests for SessionMetadata serialization/deserialization."""

    def test_to_redis_dict(self):
        from stt.streaming.schemas import SessionMetadata, SessionStatus

        meta = SessionMetadata(
            session_id="sess_123",
            tenant_id="tenant_1",
            pipeline_id="pipe_abc",
            consultation_id="consult_456",
            status=SessionStatus.ACTIVE,
            sample_rate=16000,
        )
        d = meta.to_redis_dict()
        assert d["session_id"] == "sess_123"
        assert d["tenant_id"] == "tenant_1"
        assert d["status"] == "active"
        assert "created_at" in d
        assert "last_activity" in d

    def test_roundtrip(self):
        from stt.streaming.schemas import SessionMetadata

        original = SessionMetadata(
            session_id="sess_round",
            tenant_id="t1",
            pipeline_id="p1",
            consultation_id="c1",
            total_samples_received=480000,
            total_duration_seconds=30.0,
            utterance_count=7,
            last_seq=1000,
            sample_rate=16000,
            worker_id="worker-abc",
        )
        d = original.to_redis_dict()
        restored = SessionMetadata.from_redis_dict(d)
        assert restored.session_id == original.session_id
        assert restored.total_samples_received == original.total_samples_received
        assert restored.last_seq == original.last_seq
        assert restored.worker_id == original.worker_id

    def test_auto_timestamps(self):
        from stt.streaming.schemas import SessionMetadata

        meta = SessionMetadata(session_id="s1", tenant_id="t1", pipeline_id="p1")
        assert meta.created_at != ""
        assert meta.last_activity != ""

    def test_optional_fields_absent(self):
        from stt.streaming.schemas import SessionMetadata

        meta = SessionMetadata(session_id="s1", tenant_id="t1", pipeline_id="p1")
        d = meta.to_redis_dict()
        # Optional fields should NOT be in the dict when None
        assert "closed_at" not in d
        assert "raw_audio_uri" not in d
        assert "transcript_uri" not in d


# ---------------------------------------------------------------------------
# Execution Profile Tests
# ---------------------------------------------------------------------------


class TestExecutionProfile:
    """Tests for ExecutionProfile and detect_execution_profile()."""

    def test_cpu_profile_creation(self):
        from stt.streaming.execution_profile import _build_cpu_profile

        profile = _build_cpu_profile()
        assert profile.platform.value == "cpu"
        assert profile.gpu_count == 0
        assert profile.total_vram_gb == 0.0
        assert profile.asr_device == "cpu"
        assert profile.asr_compute_type == "float32"
        assert profile.multi_gpu_strategy == "none"
        assert profile.max_concurrent_streams >= 1

    def test_apple_silicon_profile_48gb(self):
        from stt.streaming.execution_profile import _build_apple_silicon_profile

        profile = _build_apple_silicon_profile(48.0)
        assert profile.platform.value == "mps"
        assert profile.asr_device == "mps"
        assert profile.max_concurrent_streams == 15
        assert profile.asr_max_batch_size == 4

    def test_apple_silicon_profile_16gb(self):
        from stt.streaming.execution_profile import _build_apple_silicon_profile

        profile = _build_apple_silicon_profile(16.0)
        assert profile.max_concurrent_streams == 5
        assert profile.asr_max_batch_size == 2

    def test_a100_profile(self):
        from stt.streaming.execution_profile import _build_a100_h100_profile

        profile = _build_a100_h100_profile(1, 80.0, "NVIDIA A100-SXM4-80GB")
        assert profile.max_concurrent_streams == 100
        assert profile.asr_max_batch_size == 32
        assert profile.asr_compute_type == "float16"

    def test_multi_gpu_profile(self):
        from stt.streaming.execution_profile import _build_multi_gpu_profile

        profile = _build_multi_gpu_profile(2, 32.0, "NVIDIA RTX A2000")
        assert profile.max_concurrent_streams == 40
        assert profile.embedding_device == "cuda:1"
        assert profile.multi_gpu_strategy == "split"

    def test_rtx_a2000_profile(self):
        from stt.streaming.execution_profile import _build_rtx_a2000_profile

        profile = _build_rtx_a2000_profile("NVIDIA RTX A2000", 16.0)
        assert profile.max_concurrent_streams == 20
        assert profile.embedding_device == "cpu"
        assert profile.asr_model_quantization == "q4"

    def test_settings_override_max_concurrent(self):
        from stt.streaming.execution_profile import (
            _apply_settings_overrides,
            _build_cpu_profile,
        )

        profile = _build_cpu_profile()
        settings = MagicMock()
        settings.streaming_max_concurrent = 42
        settings.streaming_max_batch_size = 0
        settings.streaming_batch_wait_ms = 0
        settings.streaming_embedding_device = "auto"
        settings.streaming_multi_gpu_strategy = "auto"

        overridden = _apply_settings_overrides(profile, settings)
        assert overridden.max_concurrent_streams == 42
        # Other fields should be unchanged
        assert overridden.asr_device == profile.asr_device

    def test_settings_override_all_fields(self):
        from stt.streaming.execution_profile import (
            _apply_settings_overrides,
            _build_cpu_profile,
        )

        profile = _build_cpu_profile()
        settings = MagicMock()
        settings.streaming_max_concurrent = 10
        settings.streaming_max_batch_size = 16
        settings.streaming_batch_wait_ms = 500
        settings.streaming_embedding_device = "cuda:1"
        settings.streaming_multi_gpu_strategy = "split"

        overridden = _apply_settings_overrides(profile, settings)
        assert overridden.max_concurrent_streams == 10
        assert overridden.asr_max_batch_size == 16
        assert overridden.batch_scheduler_max_wait_ms == 500
        assert overridden.embedding_device == "cuda:1"
        assert overridden.multi_gpu_strategy == "split"

    def test_settings_override_no_changes(self):
        from stt.streaming.execution_profile import (
            _apply_settings_overrides,
            _build_cpu_profile,
        )

        profile = _build_cpu_profile()
        settings = MagicMock()
        settings.streaming_max_concurrent = 0
        settings.streaming_max_batch_size = 0
        settings.streaming_batch_wait_ms = 0
        settings.streaming_embedding_device = "auto"
        settings.streaming_multi_gpu_strategy = "auto"

        overridden = _apply_settings_overrides(profile, settings)
        assert overridden is profile  # no changes, same object returned

    @patch("stt.streaming.execution_profile.detect_platform")
    @patch("stt.streaming.execution_profile.get_settings")
    def test_detect_execution_profile_cpu(self, mock_settings, mock_detect):
        from stt.core.platform import PlatformType
        from stt.streaming.execution_profile import detect_execution_profile

        mock_detect.return_value = PlatformType.CPU
        settings = MagicMock()
        settings.streaming_max_concurrent = 0
        settings.streaming_max_batch_size = 0
        settings.streaming_batch_wait_ms = 0
        settings.streaming_embedding_device = "auto"
        settings.streaming_multi_gpu_strategy = "auto"
        mock_settings.return_value = settings

        profile = detect_execution_profile()
        assert profile.platform == PlatformType.CPU
        assert profile.asr_device == "cpu"

    @patch("stt.streaming.execution_profile.detect_platform")
    @patch("stt.streaming.execution_profile._get_mps_unified_memory_gb")
    @patch("stt.streaming.execution_profile.get_settings")
    def test_detect_execution_profile_mps(self, mock_settings, mock_mem, mock_detect):
        from stt.core.platform import PlatformType
        from stt.streaming.execution_profile import detect_execution_profile

        mock_detect.return_value = PlatformType.MPS
        mock_mem.return_value = 48.0
        settings = MagicMock()
        settings.streaming_max_concurrent = 0
        settings.streaming_max_batch_size = 0
        settings.streaming_batch_wait_ms = 0
        settings.streaming_embedding_device = "auto"
        settings.streaming_multi_gpu_strategy = "auto"
        mock_settings.return_value = settings

        profile = detect_execution_profile()
        assert profile.platform == PlatformType.MPS
        assert profile.asr_device == "mps"
        assert profile.max_concurrent_streams == 15


# ---------------------------------------------------------------------------
# Capacity Guard Tests
# ---------------------------------------------------------------------------


class TestCapacityGuard:
    """Tests for CapacityGuard."""

    async def test_acquire_and_release(self):
        from stt.streaming.capacity_guard import CapacityGuard

        guard = CapacityGuard(max_streams=3)
        assert guard.active_count == 0
        assert guard.available_slots == 3

        assert await guard.try_acquire("s1")
        assert guard.active_count == 1
        assert guard.available_slots == 2

        assert await guard.try_acquire("s2")
        assert await guard.try_acquire("s3")
        assert guard.active_count == 3
        assert guard.available_slots == 0

        # At capacity — should reject
        assert not await guard.try_acquire("s4")
        assert guard.active_count == 3

        # Release and re-acquire
        await guard.release("s1")
        assert guard.active_count == 2
        assert await guard.try_acquire("s4")
        assert guard.active_count == 3

    async def test_idempotent_acquire(self):
        from stt.streaming.capacity_guard import CapacityGuard

        guard = CapacityGuard(max_streams=2)
        assert await guard.try_acquire("s1")
        assert await guard.try_acquire("s1")  # idempotent
        assert guard.active_count == 1

    async def test_idempotent_release(self):
        from stt.streaming.capacity_guard import CapacityGuard

        guard = CapacityGuard(max_streams=2)
        assert await guard.try_acquire("s1")
        await guard.release("s1")
        await guard.release("s1")  # no-op
        assert guard.active_count == 0

    async def test_release_unknown_session(self):
        from stt.streaming.capacity_guard import CapacityGuard

        guard = CapacityGuard(max_streams=2)
        await guard.release("nonexistent")  # should not raise
        assert guard.active_count == 0

    async def test_active_session_ids(self):
        from stt.streaming.capacity_guard import CapacityGuard

        guard = CapacityGuard(max_streams=5)
        await guard.try_acquire("s1")
        await guard.try_acquire("s2")
        ids = guard.active_session_ids
        assert isinstance(ids, frozenset)
        assert ids == frozenset({"s1", "s2"})

    async def test_to_dict(self):
        from stt.streaming.capacity_guard import CapacityGuard

        guard = CapacityGuard(max_streams=10)
        await guard.try_acquire("s1")
        d = guard.to_dict()
        assert d["active_sessions"] == 1
        assert d["max_concurrent_streams"] == 10
        assert d["available_slots"] == 9

    def test_invalid_max_streams(self):
        from stt.streaming.capacity_guard import CapacityGuard

        with pytest.raises(ValueError, match="max_streams must be >= 1"):
            CapacityGuard(max_streams=0)

    async def test_concurrent_access(self):
        """Test that concurrent acquire/release is safe."""
        from stt.streaming.capacity_guard import CapacityGuard

        guard = CapacityGuard(max_streams=50)

        async def acquire_release(i: int) -> bool:
            sid = f"s{i}"
            acquired = await guard.try_acquire(sid)
            if acquired:
                await asyncio.sleep(0.001)  # simulate some work
                await guard.release(sid)
            return acquired

        _results = await asyncio.gather(*[acquire_release(i) for i in range(100)])
        # All should have been able to acquire (capacity = 50, but tasks finish fast)
        assert guard.active_count == 0  # all released


# ---------------------------------------------------------------------------
# StreamSession Tests
# ---------------------------------------------------------------------------


class TestStreamSession:
    """Tests for StreamSession."""

    def _make_session(self, session_id: str = "sess_test") -> StreamSession:
        from stt.streaming.schemas import SessionMetadata, SessionStatus
        from stt.streaming.session import StreamSession

        meta = SessionMetadata(
            session_id=session_id,
            tenant_id="t1",
            pipeline_id="p1",
            status=SessionStatus.ACTIVE,
        )
        redis_mock = AsyncMock()
        return StreamSession(metadata=meta, redis=redis_mock, persist_interval_s=5.0)

    def test_properties(self):
        session = self._make_session()
        assert session.session_id == "sess_test"
        assert session.tenant_id == "t1"
        assert session.pipeline_id == "p1"
        assert session.status.value == "active"
        assert session.total_samples_received == 0
        assert session.total_duration_seconds == 0.0

    def test_record_frame(self):
        session = self._make_session()
        data = b"\x00\x00" * 480  # 480 samples at 16-bit = 960 bytes
        session.record_frame(seq=1, data=data, sample_rate=16000)
        assert session.total_samples_received == 480
        assert session.total_duration_seconds == pytest.approx(0.03, abs=0.001)
        assert session.last_seq == 1
        assert len(session.ring_buffer) == 960

    def test_ring_buffer_overflow(self):
        session = self._make_session()
        # Fill ring buffer beyond 30s limit (16000 * 2 * 30 = 960,000 bytes)
        chunk = b"\x00\x00" * 16000  # 1 second of audio = 32,000 bytes
        for i in range(35):  # 35 seconds
            session.record_frame(seq=i, data=chunk, sample_rate=16000)
        # Ring buffer should be capped at ~30 seconds by design
        max_bytes = 16000 * 2 * 30
        assert len(session.ring_buffer) <= max_bytes

    def test_ring_buffer_overflow_logging_is_throttled(self):
        session = self._make_session()
        chunk = b"\x00\x00" * 16000  # 1 second of audio = 32,000 bytes

        with patch("stt.streaming.session.logger") as logger_mock:
            # First overflow burst within the same throttle window => one log.
            with patch("stt.streaming.session.time.monotonic", return_value=100.0):
                for i in range(40):  # Trigger many overflows
                    session.record_frame(seq=i, data=chunk, sample_rate=16000)

            # Advance time past throttle interval => one additional summary log.
            with patch("stt.streaming.session.time.monotonic", return_value=131.0):
                for i in range(40, 45):
                    session.record_frame(seq=i, data=chunk, sample_rate=16000)

        # Overflow trimming is expected for long sessions and should not spam warnings.
        logger_mock.warning.assert_not_called()
        assert logger_mock.info.call_count == 2

    def test_add_result(self):
        from stt.streaming.schemas import SegmentResult

        session = self._make_session()
        result = SegmentResult(text="Hello", start_time=0.0, end_time=1.0, is_final=True)
        session.add_result(result)
        assert len(session.results) == 1
        assert session.results[0].text == "Hello"

    async def test_persist_if_needed_respects_interval(self):
        session = self._make_session()
        session._persist_interval_s = 1000  # very long interval
        # `persist_if_needed` compares against `time.monotonic()`, which is time
        # SINCE BOOT. Leaving `_last_persisted_at` at its 0.0 default made this
        # test depend on host uptime: the first call only persisted once the
        # machine had been up longer than the interval, so it failed on any host
        # booted less than ~17 minutes ago. Backdate explicitly instead.
        session._last_persisted_at = time.monotonic() - (session._persist_interval_s + 1)
        # First call: interval has elapsed — persists
        result = await session.persist_if_needed()
        assert result is True
        # Second call: interval not yet elapsed — should skip
        result = await session.persist_if_needed()
        assert result is False

    async def test_force_persist(self):
        session = self._make_session()
        await session.force_persist()
        session._redis.hset.assert_called_once()
        call_args = session._redis.hset.call_args
        assert call_args.args[0] == "stt:session:sess_test"

    async def test_finalize(self):
        from stt.streaming.schemas import SessionStatus

        session = self._make_session()
        await session.finalize()
        assert session.status == SessionStatus.FINALIZING
        session._redis.hset.assert_called()

    async def test_close_sets_ttl(self):
        from stt.streaming.schemas import SessionStatus

        session = self._make_session()
        await session.close(
            raw_audio_uri="minio://audio/raw.wav",
            processed_audio_uri="minio://audio/processed.wav",
            transcript_uri="minio://audio/transcript.json",
        )
        assert session.status == SessionStatus.CLOSED
        assert session._metadata.closed_at is not None
        assert session._metadata.raw_audio_uri == "minio://audio/raw.wav"
        # Should have called expire on stream keys
        assert session._redis.expire.call_count >= 4  # 3 streams + 1 metadata

    def test_to_dict(self):
        session = self._make_session()
        d = session.to_dict()
        assert d["session_id"] == "sess_test"
        assert d["status"] == "active"
        assert "ring_buffer_bytes" in d
        assert "pending_segments" in d


# ---------------------------------------------------------------------------
# Redis Streams Tests
# ---------------------------------------------------------------------------


class TestRedisStreamKeys:
    """Tests for Redis key helpers."""

    def test_key_functions(self):
        from stt.streaming.redis_streams import (
            audio_stream_key,
            control_stream_key,
            result_stream_key,
            session_meta_key,
            worker_key,
        )

        assert audio_stream_key("s1") == "stt:audio:s1"
        assert result_stream_key("s1") == "stt:result:s1"
        assert control_stream_key("s1") == "stt:control:s1"
        assert session_meta_key("s1") == "stt:session:s1"
        assert worker_key("w1") == "stt:worker:w1"


def _group_redis_mock() -> AsyncMock:
    """AsyncMock wired for the consumer-group audio reader.

    Defaults: XGROUP CREATE ok, XAUTOCLAIM returns nothing, XACK ok, and a
    slow empty XREADGROUP so the loop yields instead of spin-looping. Tests
    override ``xreadgroup.side_effect`` to inject a batch.
    """
    redis_mock = AsyncMock()

    async def _slow_xreadgroup(*args, **kwargs):
        await asyncio.sleep(0.05)
        return []

    redis_mock.xreadgroup.side_effect = _slow_xreadgroup
    redis_mock.xautoclaim.return_value = (b"0-0", [], [])
    redis_mock.xgroup_create.return_value = True
    redis_mock.xack.return_value = 1
    return redis_mock


class TestIngestionConsumer:
    """Tests for IngestionConsumer (Redis consumer groups)."""

    async def test_start_stop(self):
        from stt.streaming.redis_streams import IngestionConsumer

        redis_mock = _group_redis_mock()

        on_frame = AsyncMock()
        consumer = IngestionConsumer(
            redis=redis_mock, session_id="s1", on_frame=on_frame, block_ms=100
        )

        assert not consumer.is_running
        await consumer.start()
        assert consumer.is_running
        await asyncio.sleep(0.15)  # let the loop run a couple times
        await consumer.stop()
        assert not consumer.is_running

    async def test_creates_consumer_group_with_mkstream(self):
        """The group is created (MKSTREAM) before the first XREADGROUP."""
        from stt.streaming.redis_streams import (
            AUDIO_CONSUMER_GROUP,
            IngestionConsumer,
        )

        redis_mock = _group_redis_mock()
        consumer = IngestionConsumer(
            redis=redis_mock, session_id="s1", on_frame=AsyncMock(), block_ms=50
        )
        await consumer.start()
        await asyncio.sleep(0.1)
        await consumer.stop()

        redis_mock.xgroup_create.assert_awaited()
        call = redis_mock.xgroup_create.await_args
        assert call.args[0] == "stt:audio:s1"
        assert call.args[1] == AUDIO_CONSUMER_GROUP
        assert call.kwargs.get("mkstream") is True

    async def test_processes_frames_via_xreadgroup_and_acks(self):
        from stt.streaming.redis_streams import IngestionConsumer

        frame_data = {
            b"seq": b"1",
            b"sr": b"16000",
            b"enc": b"pcm_s16le",
            b"ch": b"1",
            b"data": b"\x00\x01",
            b"final": b"0",
            b"ts": b"1000.0",
        }

        redis_mock = _group_redis_mock()
        call_count = 0

        async def fake_xreadgroup(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return [[b"stt:audio:s1", [(b"1-0", frame_data)]]]
            await asyncio.sleep(0.05)  # yield control for subsequent calls
            return []

        redis_mock.xreadgroup.side_effect = fake_xreadgroup

        frames_received = []

        async def on_frame(frame):
            frames_received.append(frame)

        consumer = IngestionConsumer(
            redis=redis_mock, session_id="s1", on_frame=on_frame, block_ms=50
        )
        await consumer.start()
        await asyncio.sleep(0.2)
        await consumer.stop()

        assert len(frames_received) == 1
        assert frames_received[0].seq == 1
        # At-least-once: the processed entry is XACK'd to the group.
        redis_mock.xack.assert_awaited()
        ack_call = redis_mock.xack.await_args
        assert ack_call.args[0] == "stt:audio:s1"
        assert "1-0" in ack_call.args[2:]

    async def test_reclaims_dead_consumer_pending_via_xautoclaim(self):
        """A crashed consumer's unacked in-flight is reclaimed + processed."""
        from stt.streaming.redis_streams import IngestionConsumer

        frame_data = {
            b"seq": b"7",
            b"sr": b"16000",
            b"enc": b"pcm_s16le",
            b"ch": b"1",
            b"data": b"\x00\x02",
            b"final": b"0",
            b"ts": b"2000.0",
        }

        redis_mock = _group_redis_mock()
        claim_count = 0

        async def fake_xautoclaim(*args, **kwargs):
            nonlocal claim_count
            claim_count += 1
            if claim_count == 1:
                # [cursor, [(id, fields), ...], [deleted]]
                return (b"0-0", [(b"5-0", frame_data)], [])
            return (b"0-0", [], [])

        redis_mock.xautoclaim.side_effect = fake_xautoclaim

        frames_received = []

        async def on_frame(frame):
            frames_received.append(frame)

        consumer = IngestionConsumer(
            redis=redis_mock, session_id="s1", on_frame=on_frame, block_ms=50
        )
        await consumer.start()
        await asyncio.sleep(0.15)
        await consumer.stop()

        # The reclaimed frame was dispatched and acked (dead-consumer handoff).
        assert any(f.seq == 7 for f in frames_received)
        redis_mock.xautoclaim.assert_awaited()
        redis_mock.xack.assert_awaited()


class TestResultPublisher:
    """Tests for ResultPublisher."""

    async def test_publish(self):
        from stt.streaming.redis_streams import ResultPublisher
        from stt.streaming.schemas import SegmentResult

        redis_mock = AsyncMock()
        redis_mock.xadd.return_value = b"1-0"

        publisher = ResultPublisher(redis=redis_mock, session_id="s1")
        result = SegmentResult(text="Hello", is_final=True)
        entry_id = await publisher.publish(result)
        assert entry_id == "1-0"
        redis_mock.xadd.assert_called_once()
        # Result stream is MAXLEN-bounded during the session.
        call_kwargs = redis_mock.xadd.call_args.kwargs
        assert call_kwargs["maxlen"] is not None and call_kwargs["maxlen"] > 0
        assert call_kwargs["approximate"] is True

    async def test_publish_skips_empty_text(self):
        from stt.streaming.redis_streams import ResultPublisher
        from stt.streaming.schemas import SegmentResult

        redis_mock = AsyncMock()
        publisher = ResultPublisher(redis=redis_mock, session_id="s1")

        entry_id = await publisher.publish(SegmentResult(text="", is_final=True))

        assert entry_id is None
        redis_mock.xadd.assert_not_called()

    async def test_publish_uses_explicit_maxlen_when_given(self):
        from stt.streaming.redis_streams import ResultPublisher
        from stt.streaming.schemas import SegmentResult

        redis_mock = AsyncMock()
        redis_mock.xadd.return_value = b"1-0"

        publisher = ResultPublisher(redis=redis_mock, session_id="s1", maxlen=1234)
        await publisher.publish(SegmentResult(text="Hi", is_final=True))
        assert redis_mock.xadd.call_args.kwargs["maxlen"] == 1234

    async def test_publish_error(self):
        from stt.streaming.redis_streams import ResultPublisher

        redis_mock = AsyncMock()
        redis_mock.xadd.return_value = b"2-0"

        publisher = ResultPublisher(redis=redis_mock, session_id="s1")
        entry_id = await publisher.publish_error("Something went wrong")
        assert entry_id == "2-0"
        # Error entries are bounded too.
        assert redis_mock.xadd.call_args.kwargs["maxlen"] is not None
        assert redis_mock.xadd.call_args.kwargs["approximate"] is True

    async def test_publish_status(self):
        from stt.streaming.redis_streams import ResultPublisher

        redis_mock = AsyncMock()
        redis_mock.xadd.return_value = "3-0"

        publisher = ResultPublisher(redis=redis_mock, session_id="s1")
        entry_id = await publisher.publish_status("finalizing")
        assert entry_id == "3-0"
        # Status entries are bounded too.
        assert redis_mock.xadd.call_args.kwargs["maxlen"] is not None
        assert redis_mock.xadd.call_args.kwargs["approximate"] is True


class TestControlListener:
    """Tests for ControlListener."""

    async def test_start_stop(self):
        from stt.streaming.redis_streams import ControlListener

        redis_mock = AsyncMock()

        async def slow_xread(*args, **kwargs):
            await asyncio.sleep(0.05)
            return []

        redis_mock.xread.side_effect = slow_xread

        on_control = AsyncMock()
        listener = ControlListener(
            redis=redis_mock, session_id="s1", on_control=on_control, block_ms=50
        )
        await listener.start()
        assert listener.is_running
        await asyncio.sleep(0.15)
        await listener.stop()
        assert not listener.is_running

    async def test_processes_control_commands(self):
        from stt.streaming.redis_streams import ControlListener

        redis_mock = AsyncMock()
        call_count = 0

        async def fake_xread(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return [[b"stt:control:s1", [(b"1-0", {b"action": b"finalize"})]]]
            await asyncio.sleep(0.05)  # yield control for subsequent calls
            return []

        redis_mock.xread.side_effect = fake_xread

        controls_received = []

        async def on_control(ctrl):
            controls_received.append(ctrl)

        listener = ControlListener(
            redis=redis_mock, session_id="s1", on_control=on_control, block_ms=50
        )
        await listener.start()
        await asyncio.sleep(0.2)
        await listener.stop()

        assert len(controls_received) == 1
        assert controls_received[0].action.value == "finalize"


class TestXaddAudioFrame:
    """Tests for the xadd_audio_frame helper."""

    def _frame(self):
        from stt.streaming.schemas import AudioEncoding, AudioFrame

        return AudioFrame(
            seq=1,
            sr=16000,
            enc=AudioEncoding.PCM_S16LE,
            ch=1,
            data=b"\x00" * 960,
            final=False,
            ts=1000.0,
        )

    async def test_xadd_with_explicit_maxlen(self):
        from stt.streaming.redis_streams import xadd_audio_frame

        redis_mock = AsyncMock()
        redis_mock.xadd.return_value = b"1-0"

        entry_id = await xadd_audio_frame(redis_mock, "s1", self._frame(), maxlen=5000)
        assert entry_id == "1-0"
        redis_mock.xadd.assert_called_once()
        call_kwargs = redis_mock.xadd.call_args.kwargs
        assert call_kwargs["maxlen"] == 5000
        assert call_kwargs["approximate"] is True

    async def test_xadd_default_maxlen_uses_reconciled_setting(self):
        """The default bound is the single source of truth
        (settings.streaming_audio_stream_maxlen), reconciled to 10000 to match
        the TS bridge's XADD MAXLEN."""
        from stt.core.config.settings import get_settings
        from stt.streaming.redis_streams import xadd_audio_frame

        redis_mock = AsyncMock()
        redis_mock.xadd.return_value = b"1-0"

        await xadd_audio_frame(redis_mock, "s1", self._frame())
        assert redis_mock.xadd.call_args.kwargs["maxlen"] == (
            get_settings().streaming_audio_stream_maxlen
        )
        assert get_settings().streaming_audio_stream_maxlen == 10000


# ---------------------------------------------------------------------------
# Runtime Singleton Tests
# ---------------------------------------------------------------------------


class TestRuntime:
    """Tests for _runtime.py singleton accessors."""

    def test_initial_state(self):
        from stt.streaming._runtime import (
            clear_runtime,
            get_execution_profile,
            get_session_manager,
        )

        clear_runtime()
        assert get_session_manager() is None
        assert get_execution_profile() is None

    def test_set_and_get_session_manager(self):
        from stt.streaming._runtime import (
            clear_runtime,
            get_session_manager,
            set_session_manager,
        )

        clear_runtime()
        mgr = MagicMock()
        set_session_manager(mgr)
        assert get_session_manager() is mgr
        clear_runtime()
        assert get_session_manager() is None

    def test_set_and_get_execution_profile(self):
        from stt.streaming._runtime import (
            clear_runtime,
            get_execution_profile,
            set_execution_profile,
        )

        clear_runtime()
        profile = MagicMock()
        set_execution_profile(profile)
        assert get_execution_profile() is profile
        clear_runtime()


# ---------------------------------------------------------------------------
# SessionManager Tests
# ---------------------------------------------------------------------------


class TestSessionManager:
    """Tests for SessionManager."""

    def _make_manager(self) -> SessionManager:
        from stt.core.platform import PlatformType
        from stt.streaming.execution_profile import ExecutionProfile
        from stt.streaming.session_manager import SessionManager

        profile = ExecutionProfile(
            platform=PlatformType.CPU,
            device_name="Test CPU",
            gpu_count=0,
            total_vram_gb=0.0,
            total_ram_gb=16.0,
            cpu_cores=4,
            asr_device="cpu",
            asr_compute_type="float32",
            asr_max_batch_size=2,
            asr_model_quantization="q4",
            embedding_device="cpu",
            embedding_batch_size=4,
            preprocess_pool_size=4,
            denoise_enabled_default=False,
            max_concurrent_streams=5,
            batch_scheduler_max_wait_ms=2000,
            vad_silence_threshold_ms=500,
            multi_gpu_strategy="none",
        )
        redis_mock = AsyncMock()
        redis_mock.scan.return_value = (0, [])  # no sessions to recover
        redis_mock.hset.return_value = True
        redis_mock.expire.return_value = True
        redis_mock.delete.return_value = 1
        redis_mock.xadd.return_value = b"1-0"
        redis_mock.exists.return_value = False

        # Make the read loops yield control so consumer tasks don't spin-loop.
        # Audio uses XREADGROUP; control still uses XREAD.
        async def _slow_read(*args, **kwargs):
            await asyncio.sleep(0.05)
            return []

        redis_mock.xread.side_effect = _slow_read
        redis_mock.xreadgroup.side_effect = _slow_read
        redis_mock.xautoclaim.return_value = (b"0-0", [], [])
        redis_mock.xgroup_create.return_value = True
        redis_mock.xack.return_value = 1

        mgr = SessionManager(redis=redis_mock, profile=profile, worker_id="test-worker-1")

        # Stub pipeline/model loading so tests don't hit real DB/reader
        mgr._load_pipeline_config = AsyncMock(return_value=None)
        mgr._load_asr_pipeline = AsyncMock(return_value=(None, None))

        return mgr

    async def test_create_session(self):
        mgr = self._make_manager()
        # Don't call start() to avoid recovery / heartbeat
        session = await mgr.create_session(
            session_id="s1",
            tenant_id="t1",
            pipeline_id="p1",
        )
        assert session is not None
        assert session.session_id == "s1"
        assert mgr.active_session_count == 1

        # Clean up consumers that were started
        await mgr.remove_session("s1")

    async def test_capacity_rejection(self):
        mgr = self._make_manager()
        # Create up to capacity (5)
        sessions = []
        for i in range(5):
            s = await mgr.create_session(f"s{i}", "t1", "p1")
            assert s is not None
            sessions.append(s)

        # 6th should be rejected
        s6 = await mgr.create_session("s5", "t1", "p1")
        assert s6 is None
        assert mgr.active_session_count == 5

        # Clean up
        for i in range(5):
            await mgr.remove_session(f"s{i}")

    async def test_get_session(self):
        mgr = self._make_manager()
        await mgr.create_session("s1", "t1", "p1")
        assert mgr.get_session("s1") is not None
        assert mgr.get_session("nonexistent") is None
        await mgr.remove_session("s1")

    async def test_remove_session(self):
        mgr = self._make_manager()
        await mgr.create_session("s1", "t1", "p1")
        assert mgr.active_session_count == 1
        await mgr.remove_session("s1")
        assert mgr.active_session_count == 0
        assert mgr.get_session("s1") is None

    async def test_list_sessions(self):
        mgr = self._make_manager()
        await mgr.create_session("s1", "t1", "p1")
        await mgr.create_session("s2", "t1", "p2")
        sessions = mgr.list_sessions()
        assert len(sessions) == 2
        session_ids = {s["session_id"] for s in sessions}
        assert session_ids == {"s1", "s2"}
        await mgr.remove_session("s1")
        await mgr.remove_session("s2")

    async def test_to_dict(self):
        mgr = self._make_manager()
        d = mgr.to_dict()
        assert d["worker_id"] == "test-worker-1"
        assert "capacity" in d
        assert "profile" in d
        assert d["profile"]["platform"] == "cpu"

    async def test_worker_registration(self):
        mgr = self._make_manager()
        await mgr._register_worker()
        mgr._redis.hset.assert_called()
        mgr._redis.expire.assert_called()

        await mgr._unregister_worker()
        mgr._redis.delete.assert_called()

    async def test_reap_expired_sessions(self):
        mgr = self._make_manager()
        s = await mgr.create_session("s1", "t1", "p1")

        # Artificially set last_activity to 120s ago
        old_time = (datetime.utcnow() - timedelta(seconds=120)).isoformat()
        s._metadata.last_activity = old_time

        count = await mgr._reap_expired_sessions(timeout_s=60)
        assert count == 1
        assert mgr.active_session_count == 0

    async def test_reaper_loop_uses_audio_idle_timeout(self):
        """The background reaper must reap on the audio-idle
        timeout (streaming_audio_idle_timeout_s=300), NOT the 60s session
        timeout, so a live consultation with a normal speech pause is not
        finalized. Wires the previously-dead streaming_audio_idle_timeout_s knob.
        """
        mgr = self._make_manager()
        mgr._reaper_interval_s = 0  # don't wait between scans
        captured: list[int] = []

        async def _capture(timeout_s: int) -> int:
            captured.append(timeout_s)
            mgr._running = False  # stop after the first scan
            return 0

        mgr._reap_expired_sessions = _capture  # type: ignore[assignment]
        mgr._running = True
        await mgr._reaper_loop()

        assert captured == [300]

    def test_inference_stop_timeout_configurable_via_env(self, monkeypatch):
        """STREAMING_INFERENCE_STOP_TIMEOUT_S must actually control
        SessionManager._inference_stop_timeout_s. It was a phantom knob:
        streaming_inference_stop_timeout_s was never declared on Settings, so
        getattr() always fell back to the hardcoded 30.0 default regardless
        of env."""
        from stt.core.config.settings import get_settings

        monkeypatch.setenv("LOG_LEVEL", "INFO")
        monkeypatch.setenv("STREAMING_INFERENCE_STOP_TIMEOUT_S", "7.5")
        get_settings.cache_clear()
        try:
            mgr = self._make_manager()
            assert mgr._inference_stop_timeout_s == 7.5
        finally:
            get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Settings Tests (streaming fields)
# ---------------------------------------------------------------------------


class TestStreamingSettings:
    """Tests for the streaming settings added to Settings."""

    def test_default_values(self, monkeypatch):
        from stt.core.config.settings import Settings

        # Ensure LOG_LEVEL is uppercase to satisfy Settings validation
        monkeypatch.setenv("LOG_LEVEL", "INFO")
        s = Settings()
        assert s.streaming_max_concurrent == 0
        assert s.streaming_max_batch_size == 0
        assert s.streaming_batch_wait_ms == 0
        assert s.streaming_embedding_device == "auto"
        assert s.streaming_multi_gpu_strategy == "auto"
        assert s.streaming_session_persist_interval_s == 5.0
        assert s.streaming_session_timeout_s == 60
        assert s.streaming_reaper_interval_s == 300
        # Durable-transcript persist retries + outbox re-drive cap
        # + finalize drain timeout (previously a getattr fallback,
        # now a real setting).
        assert s.streaming_transcript_persist_max_attempts == 3
        assert s.streaming_transcript_persist_backoff_s == 0.5
        assert s.streaming_transcript_outbox_max_attempts == 10
        assert s.streaming_inference_drain_timeout_s == 60.0
        # Previously a getattr fallback (phantom knob — no env var could
        # ever change it); now a real setting.
        assert s.streaming_inference_stop_timeout_s == 30.0
        assert s.streaming_worker_heartbeat_s == 10
        assert s.streaming_worker_heartbeat_ttl_s == 30
        # Audio bound reconciled to the single source of
        # truth (was 2000; now equals the TS bridge's XADD MAXLEN of 10000).
        assert s.streaming_audio_stream_maxlen == 10000
        # Result stream bounded during the session.
        assert s.streaming_result_stream_maxlen == 10000
        assert s.streaming_result_stream_expire_s == 3600
        assert s.streaming_session_metadata_expire_s == 86400

    def test_override_via_env(self, monkeypatch):
        from stt.core.config.settings import Settings

        monkeypatch.setenv("LOG_LEVEL", "INFO")
        monkeypatch.setenv("STREAMING_MAX_CONCURRENT", "42")
        monkeypatch.setenv("STREAMING_EMBEDDING_DEVICE", "cuda:1")
        monkeypatch.setenv("STREAMING_INFERENCE_STOP_TIMEOUT_S", "12.5")
        s = Settings()
        assert s.streaming_max_concurrent == 42
        assert s.streaming_embedding_device == "cuda:1"
        assert s.streaming_inference_stop_timeout_s == 12.5
