"""Unit tests for streaming audio recording and S3 persistence.

Covers:
- Audio buffer accumulation in StreamSession
- WAV encoding via encode_wav()
- Transcript JSON building via build_transcript_json()
- Upload calls in SessionManager._finalize_session()
- Upload error isolation (each artifact uploaded independently)
- Snapshot loop behaviour
- StoragePathResolver streaming paths (with year/month partitioning)
- BlobService streaming upload methods (raw + processed)
"""

from __future__ import annotations

import io
import json
import wave
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt_v2.storage.blob_service import BlobService

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_session(
    session_id: str = "sess_rec",
    tenant_id: str = "t1",
    consultation_id: str | None = "c1",
    sample_rate: int = 16000,
):
    """Create a StreamSession with mocked Redis for testing."""
    from stt_v2.streaming.schemas import SessionMetadata, SessionStatus
    from stt_v2.streaming.session import StreamSession

    meta = SessionMetadata(
        session_id=session_id,
        tenant_id=tenant_id,
        pipeline_id="p1",
        consultation_id=consultation_id,
        status=SessionStatus.ACTIVE,
        sample_rate=sample_rate,
    )
    redis_mock = AsyncMock()
    return StreamSession(metadata=meta, redis=redis_mock, persist_interval_s=5.0)


def _make_manager():
    """Create a SessionManager with mocked Redis."""
    from stt_v2.streaming.execution_profile import ExecutionProfile, PlatformType
    from stt_v2.streaming.session_manager import SessionManager

    profile = ExecutionProfile(
        platform=PlatformType.CPU,
        device_name="cpu-test",
        gpu_count=0,
        total_vram_gb=0,
        total_ram_gb=16,
        cpu_cores=4,
        asr_device="cpu",
        asr_compute_type="float32",
        asr_max_batch_size=2,
        asr_model_quantization="fp16",
        embedding_device="cpu",
        embedding_batch_size=2,
        preprocess_pool_size=2,
        denoise_enabled_default=False,
        max_concurrent_streams=10,
        batch_scheduler_max_wait_ms=500,
        vad_silence_threshold_ms=700,
        multi_gpu_strategy="none",
    )
    redis_mock = AsyncMock()
    redis_mock.hset = AsyncMock()
    redis_mock.expire = AsyncMock()
    redis_mock.delete = AsyncMock()
    redis_mock.scan = AsyncMock(return_value=(0, []))
    return SessionManager(redis=redis_mock, profile=profile, worker_id="test-worker")


def _one_second_pcm(sample_rate: int = 16000) -> bytes:
    """Return 1 second of silent 16-bit mono PCM."""
    return b"\x00\x00" * sample_rate


# ---------------------------------------------------------------------------
# StreamSession — audio buffer accumulation
# ---------------------------------------------------------------------------


class TestAudioBufferAccumulation:
    """Tests for the full-session audio_buffer in StreamSession."""

    def test_record_frame_appends_to_audio_buffer(self):
        session = _make_session()
        data = b"\x01\x02" * 480
        session.record_frame(seq=0, data=data, sample_rate=16000)
        assert len(session.audio_buffer) == len(data)

    def test_audio_buffer_not_trimmed_beyond_30s(self):
        """Unlike ring_buffer, audio_buffer grows until the cap is hit."""
        session = _make_session()
        # Set a large cap so 40s fits comfortably
        session._max_audio_buffer_bytes = 16000 * 2 * 100  # 100s
        chunk = _one_second_pcm(16000)
        for i in range(40):  # 40 seconds of audio
            session.record_frame(seq=i, data=chunk, sample_rate=16000)
        # audio_buffer should have all 40 seconds
        expected = 16000 * 2 * 40
        assert len(session.audio_buffer) == expected
        # ring_buffer should be capped at ~30s
        max_ring = 16000 * 2 * 30
        assert len(session.ring_buffer) <= max_ring

    def test_audio_buffer_starts_empty(self):
        session = _make_session()
        assert len(session.audio_buffer) == 0

    def test_to_dict_includes_audio_buffer_bytes(self):
        session = _make_session()
        data = b"\x00\x00" * 100
        session.record_frame(seq=0, data=data, sample_rate=16000)
        d = session.to_dict()
        assert "audio_buffer_bytes" in d
        assert d["audio_buffer_bytes"] == 200


# ---------------------------------------------------------------------------
# StreamSession — WAV encoding
# ---------------------------------------------------------------------------


class TestEncodeWav:
    """Tests for StreamSession.encode_wav()."""

    def test_encode_wav_empty_buffer(self):
        session = _make_session()
        wav_bytes = session.encode_wav()
        # Should be a valid WAV with 0 frames
        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            assert wf.getnchannels() == 1
            assert wf.getsampwidth() == 2
            assert wf.getframerate() == 16000
            assert wf.getnframes() == 0

    def test_encode_wav_with_data(self):
        session = _make_session()
        chunk = _one_second_pcm(16000)
        session.record_frame(seq=0, data=chunk, sample_rate=16000)
        wav_bytes = session.encode_wav()

        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            assert wf.getnchannels() == 1
            assert wf.getsampwidth() == 2
            assert wf.getframerate() == 16000
            assert wf.getnframes() == 16000

    def test_encode_wav_preserves_sample_rate(self):
        session = _make_session(sample_rate=48000)
        chunk = b"\x00\x00" * 48000  # 1 second at 48kHz
        session.record_frame(seq=0, data=chunk, sample_rate=48000)
        wav_bytes = session.encode_wav()

        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            assert wf.getframerate() == 48000
            assert wf.getnframes() == 48000


# ---------------------------------------------------------------------------
# StreamSession — transcript JSON
# ---------------------------------------------------------------------------


class TestBuildTranscriptJson:
    """Tests for StreamSession.build_transcript_json()."""

    def test_empty_results(self):
        session = _make_session()
        data = session.build_transcript_json()
        transcript = json.loads(data)
        assert transcript["session_id"] == "sess_rec"
        assert transcript["tenant_id"] == "t1"
        assert transcript["consultation_id"] == "c1"
        assert transcript["segment_count"] == 0
        assert transcript["segments"] == []

    def test_with_results(self):
        from stt_v2.streaming.schemas import SegmentResult

        session = _make_session()
        session.add_result(
            SegmentResult(
                text="Hello",
                start_time=0.0,
                end_time=1.5,
                is_final=True,
                speaker_id="spk_1",
                speaker_confidence=0.95,
            )
        )
        session.add_result(
            SegmentResult(
                text="World",
                start_time=1.5,
                end_time=3.0,
                is_final=True,
                word_timestamps=[
                    {"word": "World", "start_time": 1.5, "end_time": 3.0, "confidence": None}
                ],
            )
        )

        data = session.build_transcript_json()
        transcript = json.loads(data)
        assert transcript["segment_count"] == 2
        segments = transcript["segments"]

        assert segments[0]["text"] == "Hello"
        assert segments[0]["speaker_id"] == "spk_1"
        assert segments[0]["speaker_confidence"] == 0.95

        assert segments[1]["text"] == "World"
        assert "speaker_id" not in segments[1]
        assert segments[1]["word_timestamps"][0]["word"] == "World"

    def test_build_transcript_text_joins_final_segments(self):
        """TASK-342 GAP #1 — build_transcript_text() returns the plain-text
        transcript (final segments only) used to persist the streaming
        TRANSCRIPT context item."""
        from stt_v2.streaming.schemas import SegmentResult

        session = _make_session()
        session.add_result(
            SegmentResult(text="Hello", start_time=0.0, end_time=1.0, is_final=True)
        )
        session.add_result(
            SegmentResult(text="partial", start_time=1.0, end_time=1.2, is_final=False)
        )
        session.add_result(
            SegmentResult(text="world", start_time=1.2, end_time=2.0, is_final=True)
        )

        assert session.build_transcript_text() == "Hello world"

    def test_build_transcript_text_empty_when_no_final_segments(self):
        session = _make_session()
        assert session.build_transcript_text() == ""

    def test_returns_utf8_bytes(self):
        session = _make_session()
        data = session.build_transcript_json()
        assert isinstance(data, bytes)
        # Must be valid UTF-8
        data.decode("utf-8")


# ---------------------------------------------------------------------------
# StreamSession — metadata JSON
# ---------------------------------------------------------------------------


class TestBuildMetadataJson:
    """Tests for StreamSession.build_metadata_json()."""

    def test_metadata_fields(self):
        session = _make_session()
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)
        data = session.build_metadata_json()
        meta = json.loads(data)
        assert meta["session_id"] == "sess_rec"
        assert meta["tenant_id"] == "t1"
        assert meta["pipeline_id"] == "p1"
        assert meta["consultation_id"] == "c1"
        assert meta["sample_rate"] == 16000
        assert meta["total_samples_received"] == 16000
        assert meta["audio_buffer_bytes"] == 32000

    def test_metadata_returns_utf8_bytes(self):
        session = _make_session()
        data = session.build_metadata_json()
        assert isinstance(data, bytes)
        data.decode("utf-8")


# ---------------------------------------------------------------------------
# StoragePathResolver — streaming paths
# ---------------------------------------------------------------------------


class TestStreamingPaths:
    """Tests for StoragePathResolver streaming path methods."""

    _TS = datetime(2026, 3, 15, 10, 0, 0)

    def test_streaming_raw_chunk_path(self):
        from stt_v2.storage.path_resolver import StoragePathResolver

        resolver = StoragePathResolver()
        path = resolver.streaming_raw_chunk_path(
            tenant_id="t1",
            session_id="sess-abc",
            chunk_index=0,
            timestamp=self._TS,
        )
        assert path == "2026/03/15/streams/sess-abc/raw/chunk_0000.pcm"

    def test_streaming_raw_chunk_path_index_padding(self):
        from stt_v2.storage.path_resolver import StoragePathResolver

        resolver = StoragePathResolver()
        path = resolver.streaming_raw_chunk_path(
            tenant_id="t1",
            session_id="sess-abc",
            chunk_index=42,
            timestamp=self._TS,
        )
        assert path == "2026/03/15/streams/sess-abc/raw/chunk_0042.pcm"

    def test_streaming_processed_chunk_path(self):
        from stt_v2.storage.path_resolver import StoragePathResolver

        resolver = StoragePathResolver()
        path = resolver.streaming_processed_chunk_path(
            tenant_id="t1",
            session_id="sess-abc",
            chunk_index=0,
            timestamp=self._TS,
        )
        assert path == "2026/03/15/streams/sess-abc/processed/chunk_0000.pcm"

    def test_streaming_raw_complete_path(self):
        from stt_v2.storage.path_resolver import StoragePathResolver

        resolver = StoragePathResolver()
        path = resolver.streaming_raw_complete_path(
            tenant_id="tenant-123",
            session_id="sess-xyz",
            timestamp=self._TS,
        )
        assert path == "2026/03/15/streams/sess-xyz/raw/complete.wav"

    def test_streaming_transcript_path(self):
        from stt_v2.storage.path_resolver import StoragePathResolver

        resolver = StoragePathResolver()
        path = resolver.streaming_transcript_path(
            tenant_id="t1",
            session_id="sess-abc",
            timestamp=self._TS,
        )
        assert path == "2026/03/15/streams/sess-abc/transcript.json"

    def test_streaming_metadata_path(self):
        from stt_v2.storage.path_resolver import StoragePathResolver

        resolver = StoragePathResolver()
        path = resolver.streaming_metadata_path(
            tenant_id="t1",
            session_id="sess-abc",
            timestamp=self._TS,
        )
        assert path == "2026/03/15/streams/sess-abc/metadata.json"

    def test_streaming_path_defaults_to_utcnow(self):
        from stt_v2.storage.path_resolver import StoragePathResolver

        resolver = StoragePathResolver()
        path = resolver.streaming_raw_chunk_path(
            tenant_id="t1",
            session_id="s1",
            chunk_index=0,
        )
        now = datetime.utcnow()
        expected_prefix = f"{now.strftime('%Y')}/{now.strftime('%m')}/{now.strftime('%d')}/streams/s1/"
        assert path.startswith(expected_prefix)


# ---------------------------------------------------------------------------
# BlobService — streaming upload methods
# ---------------------------------------------------------------------------


class TestBlobServiceStreamingUpload:
    """Tests for BlobService streaming upload methods."""

    @pytest.fixture
    def service(self):
        mock_resolver = MagicMock()
        mock_resolver.audio_bucket = "hope-audio"
        mock_resolver.resolve_tenant_bucket.return_value = "hope-audio"
        mock_resolver.streaming_raw_chunk_path.return_value = (
            "2026/03/15/streams/s1/raw/chunk_0000.pcm"
        )
        mock_resolver.streaming_processed_chunk_path.return_value = (
            "2026/03/15/streams/s1/processed/chunk_0000.pcm"
        )
        mock_resolver.streaming_raw_complete_path.return_value = (
            "2026/03/15/streams/s1/raw/complete.wav"
        )
        mock_resolver.streaming_transcript_path.return_value = (
            "2026/03/15/streams/s1/transcript.json"
        )
        mock_resolver.streaming_metadata_path.return_value = "2026/03/15/streams/s1/metadata.json"
        mock_resolver.get_full_uri.side_effect = lambda bucket, path: f"s3://{bucket}/{path}"

        with patch("stt_v2.storage.blob_service.get_settings") as mock_settings:
            mock_settings.return_value = MagicMock()
            return BlobService(path_resolver=mock_resolver)

    @pytest.mark.asyncio
    async def test_upload_raw_chunk(self, service):
        with patch.object(service, "_upload_bytes", new_callable=AsyncMock) as mock_upload:
            uri = await service.upload_streaming_raw_chunk(
                chunk_bytes=b"\x00" * 100,
                tenant_id="t1",
                session_id="s1",
                chunk_index=0,
            )
            mock_upload.assert_called_once_with(
                bucket="hope-audio",
                path="2026/03/15/streams/s1/raw/chunk_0000.pcm",
                data=b"\x00" * 100,
                content_type="application/octet-stream",
                tenant_id="t1",
            )
            assert "chunk_0000.pcm" in uri

    @pytest.mark.asyncio
    async def test_upload_processed_chunk(self, service):
        with patch.object(service, "_upload_bytes", new_callable=AsyncMock) as mock_upload:
            uri = await service.upload_streaming_processed_chunk(
                chunk_bytes=b"\x00" * 100,
                tenant_id="t1",
                session_id="s1",
                chunk_index=0,
            )
            mock_upload.assert_called_once_with(
                bucket="hope-audio",
                path="2026/03/15/streams/s1/processed/chunk_0000.pcm",
                data=b"\x00" * 100,
                content_type="application/octet-stream",
                tenant_id="t1",
            )
            assert "processed/chunk_0000.pcm" in uri

    @pytest.mark.asyncio
    async def test_upload_raw_complete(self, service):
        with patch.object(service, "_upload_bytes", new_callable=AsyncMock) as mock_upload:
            uri = await service.upload_streaming_raw_complete(
                wav_bytes=b"wav-data",
                tenant_id="t1",
                session_id="s1",
            )
            mock_upload.assert_called_once_with(
                bucket="hope-audio",
                path="2026/03/15/streams/s1/raw/complete.wav",
                data=b"wav-data",
                content_type="audio/wav",
                tenant_id="t1",
            )
            assert "complete.wav" in uri

    @pytest.mark.asyncio
    async def test_upload_streaming_transcript(self, service):
        with patch.object(service, "_upload_bytes", new_callable=AsyncMock) as mock_upload:
            uri = await service.upload_streaming_transcript(
                transcript_bytes=b'{"segments":[]}',
                tenant_id="t1",
                session_id="s1",
            )
            mock_upload.assert_called_once_with(
                bucket="hope-audio",
                path="2026/03/15/streams/s1/transcript.json",
                data=b'{"segments":[]}',
                content_type="application/json",
                tenant_id="t1",
            )
            assert "transcript.json" in uri

    @pytest.mark.asyncio
    async def test_upload_streaming_metadata(self, service):
        with patch.object(service, "_upload_bytes", new_callable=AsyncMock) as mock_upload:
            uri = await service.upload_streaming_metadata(
                metadata_bytes=b'{"session_id":"s1"}',
                tenant_id="t1",
                session_id="s1",
            )
            mock_upload.assert_called_once_with(
                bucket="hope-audio",
                path="2026/03/15/streams/s1/metadata.json",
                data=b'{"session_id":"s1"}',
                content_type="application/json",
                tenant_id="t1",
            )
            assert "metadata.json" in uri


# ---------------------------------------------------------------------------
# SessionManager — finalize uploads audio and transcript
# ---------------------------------------------------------------------------


class TestFinalizeSessionRecording:
    """Tests for audio/transcript/metadata upload in SessionManager._finalize_session()."""

    @pytest.mark.asyncio
    async def test_finalize_uploads_all_artifacts(self):
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = _make_session(consultation_id="c1")
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)

        mgr._sessions[session.session_id] = session

        mock_blob = MagicMock()
        mock_blob.upload_streaming_raw_chunk = AsyncMock(return_value="s3://bucket/chunk")
        mock_blob.upload_streaming_raw_complete = AsyncMock(return_value="s3://bucket/complete.wav")
        mock_blob.upload_streaming_transcript = AsyncMock(
            return_value="s3://bucket/transcript.json"
        )
        mock_blob.upload_streaming_metadata = AsyncMock(return_value="s3://bucket/metadata.json")
        mgr._blob_service = mock_blob
        mgr.remove_session = AsyncMock()

        await mgr._finalize_session(session)

        mock_blob.upload_streaming_raw_chunk.assert_awaited_once()
        mock_blob.upload_streaming_raw_complete.assert_awaited_once()
        mock_blob.upload_streaming_transcript.assert_awaited_once()
        mock_blob.upload_streaming_metadata.assert_awaited_once()

        assert session.status == SessionStatus.CLOSED
        assert session.metadata.raw_audio_uri == "s3://bucket/complete.wav"
        assert session.metadata.transcript_uri == "s3://bucket/transcript.json"

    @pytest.mark.asyncio
    async def test_finalize_skips_remaining_chunk_when_fully_flushed(self):
        mgr = _make_manager()
        session = _make_session()
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)

        # Simulate that snapshot already flushed all audio
        mgr._chunk_offsets[session.session_id] = len(session.audio_buffer)
        mgr._chunk_indices[session.session_id] = 1
        mgr._sessions[session.session_id] = session

        mock_blob = MagicMock()
        mock_blob.upload_streaming_raw_chunk = AsyncMock()
        mock_blob.upload_streaming_raw_complete = AsyncMock(return_value="s3://bucket/complete.wav")
        mock_blob.upload_streaming_transcript = AsyncMock(
            return_value="s3://bucket/transcript.json"
        )
        mock_blob.upload_streaming_metadata = AsyncMock(return_value="s3://bucket/metadata.json")
        mgr._blob_service = mock_blob
        mgr.remove_session = AsyncMock()

        await mgr._finalize_session(session)

        # No remaining chunk to upload since offset == buffer length
        mock_blob.upload_streaming_raw_chunk.assert_not_awaited()
        # But complete.wav should still be uploaded
        mock_blob.upload_streaming_raw_complete.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_finalize_chunk_failure_still_uploads_remaining_artifacts(self):
        """When the remaining chunk upload fails, complete.wav/transcript/metadata still upload."""
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = _make_session(consultation_id="c1")
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)

        mgr._sessions[session.session_id] = session

        mock_blob = MagicMock()
        mock_blob.upload_streaming_raw_chunk = AsyncMock(side_effect=Exception("S3 down"))
        mock_blob.upload_streaming_raw_complete = AsyncMock(return_value="s3://bucket/complete.wav")
        mock_blob.upload_streaming_transcript = AsyncMock(
            return_value="s3://bucket/transcript.json"
        )
        mock_blob.upload_streaming_metadata = AsyncMock(return_value="s3://bucket/metadata.json")
        mgr._blob_service = mock_blob
        mgr.remove_session = AsyncMock()

        await mgr._finalize_session(session)

        # Chunk failed but the rest should still have been attempted
        mock_blob.upload_streaming_raw_chunk.assert_awaited_once()
        mock_blob.upload_streaming_raw_complete.assert_awaited_once()
        mock_blob.upload_streaming_transcript.assert_awaited_once()
        mock_blob.upload_streaming_metadata.assert_awaited_once()

        assert session.status == SessionStatus.CLOSED
        assert session.metadata.raw_audio_uri == "s3://bucket/complete.wav"
        assert session.metadata.transcript_uri == "s3://bucket/transcript.json"
        mgr.remove_session.assert_awaited_once_with(session.session_id)

    @pytest.mark.asyncio
    async def test_finalize_all_uploads_fail_still_closes(self):
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = _make_session(consultation_id="c1")
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)

        mgr._sessions[session.session_id] = session

        mock_blob = MagicMock()
        mock_blob.upload_streaming_raw_chunk = AsyncMock(side_effect=Exception("S3 down"))
        mock_blob.upload_streaming_raw_complete = AsyncMock(side_effect=Exception("S3 down"))
        mock_blob.upload_streaming_transcript = AsyncMock(side_effect=Exception("S3 down"))
        mock_blob.upload_streaming_metadata = AsyncMock(side_effect=Exception("S3 down"))
        mgr._blob_service = mock_blob
        mgr.remove_session = AsyncMock()

        await mgr._finalize_session(session)

        assert session.status == SessionStatus.CLOSED
        assert session.metadata.raw_audio_uri is None
        assert session.metadata.transcript_uri is None
        mgr.remove_session.assert_awaited_once_with(session.session_id)

    @pytest.mark.asyncio
    async def test_finalize_empty_buffer_skips_upload(self):
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = _make_session(consultation_id="c1")
        # No audio recorded — buffer is empty

        mgr._sessions[session.session_id] = session

        mock_blob = MagicMock()
        mock_blob.upload_streaming_raw_complete = AsyncMock()
        mgr._blob_service = mock_blob
        mgr.remove_session = AsyncMock()

        await mgr._finalize_session(session)

        mock_blob.upload_streaming_raw_complete.assert_not_awaited()
        assert session.status == SessionStatus.CLOSED


class TestFinalizeSessionDualCapture:
    """Dual-capture media registration in SessionManager._finalize_session()."""

    @staticmethod
    def _blob_with_both_complete():
        mock_blob = MagicMock()
        mock_blob.upload_streaming_raw_chunk = AsyncMock(return_value="s3://bucket/chunk")
        mock_blob.upload_streaming_raw_complete = AsyncMock(return_value="s3://bucket/raw.wav")
        mock_blob.upload_streaming_processed_complete = AsyncMock(
            return_value="s3://bucket/processed.wav"
        )
        mock_blob.upload_streaming_transcript = AsyncMock(
            return_value="s3://bucket/transcript.json"
        )
        mock_blob.upload_streaming_metadata = AsyncMock(
            return_value="s3://bucket/metadata.json"
        )
        return mock_blob

    @pytest.mark.asyncio
    async def test_finalize_registers_dual_capture_media_when_enabled(self):
        """Enabled (raw+processed): create two Media + an AudioRecording carrying both ids."""
        from stt_v2.pipeline.dto import DualCaptureConfig

        mgr = _make_manager()
        session = _make_session(consultation_id="c1")
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)
        session.processed_audio_buffer = bytearray(_one_second_pcm())
        session.processed_sample_rate = 16000

        mgr._sessions[session.session_id] = session
        mgr._dual_capture[session.session_id] = DualCaptureConfig(
            enabled=True, capture_raw=True, capture_processed=True
        )

        mgr._blob_service = self._blob_with_both_complete()
        mgr.remove_session = AsyncMock()

        mock_gateway = MagicMock()
        mock_gateway.create_media = AsyncMock(
            side_effect=[{"id": "raw-media-1"}, {"id": "proc-media-2"}]
        )
        mock_gateway.create_audio_recording = AsyncMock(return_value={"id": "ar-1"})
        mgr._get_api_client = MagicMock(return_value=mock_gateway)

        await mgr._finalize_session(session)

        assert mock_gateway.create_media.await_count == 2
        mock_gateway.create_audio_recording.assert_awaited_once()
        kwargs = mock_gateway.create_audio_recording.await_args.kwargs
        assert kwargs["raw_media_id"] == "raw-media-1"
        assert kwargs["processed_media_id"] == "proc-media-2"
        assert kwargs["consultation_id"] == "c1"

    @pytest.mark.asyncio
    async def test_concurrent_finalize_registers_media_once(self):
        """C2-07 (TASK-456) — two racing finalize entrypoints must serialize on
        a per-session lock and the second must be a no-op, so Media rows are not
        duplicated and the blob is not uploaded twice."""
        import asyncio

        from stt_v2.pipeline.dto import DualCaptureConfig
        from stt_v2.streaming.schemas import SegmentResult

        mgr = _make_manager()
        session = _make_session(consultation_id="c1")
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)
        session.add_result(
            SegmentResult(text="Hello", start_time=0.0, end_time=1.0, is_final=True)
        )

        mgr._sessions[session.session_id] = session
        mgr._dual_capture[session.session_id] = DualCaptureConfig(
            enabled=True, capture_raw=True, capture_processed=False
        )
        mgr._blob_service = self._blob_with_both_complete()
        mgr.remove_session = AsyncMock()

        mock_gateway = MagicMock()
        mock_gateway.create_media = AsyncMock(return_value={"id": "raw-media-1"})
        mock_gateway.create_audio_recording = AsyncMock(return_value={"id": "ar-1"})
        mock_gateway.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-1"})
        mgr._get_api_client = MagicMock(return_value=mock_gateway)

        # Two entrypoints (e.g. final-frame + control-FINALIZE) race.
        await asyncio.gather(
            mgr._finalize_session(session),
            mgr._finalize_session(session),
        )

        # Media created exactly once (no duplicate rows / double upload).
        assert mock_gateway.create_media.await_count == 1
        mock_gateway.create_audio_recording.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_finalize_skips_dual_capture_when_disabled(self):
        """Disabled config: no Media and no AudioRecording are created."""
        from stt_v2.pipeline.dto import DualCaptureConfig

        mgr = _make_manager()
        session = _make_session(consultation_id="c1")
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)

        mgr._sessions[session.session_id] = session
        mgr._dual_capture[session.session_id] = DualCaptureConfig()  # all-off

        mgr._blob_service = self._blob_with_both_complete()
        mgr.remove_session = AsyncMock()

        mock_gateway = MagicMock()
        mock_gateway.create_media = AsyncMock()
        mock_gateway.create_audio_recording = AsyncMock()
        mgr._get_api_client = MagicMock(return_value=mock_gateway)

        await mgr._finalize_session(session)

        mock_gateway.create_media.assert_not_awaited()
        mock_gateway.create_audio_recording.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_finalize_dual_capture_skips_without_consultation(self):
        """Enabled but no consultation_id: skip registration (documented gap, non-fatal)."""
        from stt_v2.pipeline.dto import DualCaptureConfig

        mgr = _make_manager()
        session = _make_session(consultation_id=None)
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)

        mgr._sessions[session.session_id] = session
        mgr._dual_capture[session.session_id] = DualCaptureConfig(
            enabled=True, capture_raw=True
        )

        mgr._blob_service = self._blob_with_both_complete()
        mgr.remove_session = AsyncMock()

        mock_gateway = MagicMock()
        mock_gateway.create_media = AsyncMock()
        mock_gateway.create_audio_recording = AsyncMock()
        mgr._get_api_client = MagicMock(return_value=mock_gateway)

        await mgr._finalize_session(session)

        mock_gateway.create_media.assert_not_awaited()
        mock_gateway.create_audio_recording.assert_not_awaited()


class TestFinalizeTranscriptPersistence:
    """TASK-342 GAP #1 — _finalize_session persists a streaming TRANSCRIPT
    (no jobId, keyed by consultation + tenant) so the harness auto-drafts the
    SOAP after a live consultation. All failures are non-fatal."""

    @staticmethod
    def _blob_mock():
        mock_blob = MagicMock()
        mock_blob.upload_streaming_raw_chunk = AsyncMock(return_value="s3://b/chunk")
        mock_blob.upload_streaming_raw_complete = AsyncMock(return_value="s3://b/raw.wav")
        mock_blob.upload_streaming_processed_complete = AsyncMock(
            return_value="s3://b/proc.wav"
        )
        mock_blob.upload_streaming_transcript = AsyncMock(
            return_value="s3://b/transcript.json"
        )
        mock_blob.upload_streaming_metadata = AsyncMock(
            return_value="s3://b/metadata.json"
        )
        return mock_blob

    @pytest.mark.asyncio
    async def test_finalize_persists_streaming_transcript(self):
        from stt_v2.streaming.schemas import SegmentResult

        mgr = _make_manager()
        session = _make_session(consultation_id="c1")
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)
        session.add_result(
            SegmentResult(text="Hello", start_time=0.0, end_time=1.0, is_final=True)
        )
        session.add_result(
            SegmentResult(text="world", start_time=1.0, end_time=2.0, is_final=True)
        )

        mgr._sessions[session.session_id] = session
        mgr._blob_service = self._blob_mock()
        mgr.remove_session = AsyncMock()

        mock_gateway = MagicMock()
        mock_gateway.create_transcript = AsyncMock(
            return_value={"contextItemId": "ctx-1"}
        )
        mgr._get_api_client = MagicMock(return_value=mock_gateway)

        await mgr._finalize_session(session)

        mock_gateway.create_transcript.assert_awaited_once()
        kwargs = mock_gateway.create_transcript.await_args.kwargs
        assert kwargs["consultation_id"] == "c1"
        assert kwargs["tenant_id"] == "t1"
        assert kwargs["transcript_text"] == "Hello world"
        assert kwargs.get("transcription_source") == "streaming"
        assert kwargs.get("job_id") is None

    @pytest.mark.asyncio
    async def test_finalize_skips_transcript_without_consultation(self):
        from stt_v2.streaming.schemas import SegmentResult

        mgr = _make_manager()
        session = _make_session(consultation_id=None)
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)
        session.add_result(
            SegmentResult(text="Hello", start_time=0.0, end_time=1.0, is_final=True)
        )

        mgr._sessions[session.session_id] = session
        mgr._blob_service = self._blob_mock()
        mgr.remove_session = AsyncMock()

        mock_gateway = MagicMock()
        mock_gateway.create_transcript = AsyncMock()
        mgr._get_api_client = MagicMock(return_value=mock_gateway)

        await mgr._finalize_session(session)

        mock_gateway.create_transcript.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_finalize_skips_transcript_when_no_final_text(self):
        mgr = _make_manager()
        session = _make_session(consultation_id="c1")
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)
        # No final results → empty transcript text.

        mgr._sessions[session.session_id] = session
        mgr._blob_service = self._blob_mock()
        mgr.remove_session = AsyncMock()

        mock_gateway = MagicMock()
        mock_gateway.create_transcript = AsyncMock()
        mgr._get_api_client = MagicMock(return_value=mock_gateway)

        await mgr._finalize_session(session)

        mock_gateway.create_transcript.assert_not_awaited()


class TestFinalizeTranscriptDurability:
    """C2-03 (TASK-456) — the streaming transcript is the durable system of
    record AND the harness trigger. A transient gateway blip must NOT lose it,
    but finalize must ALSO always release the session's capacity (no leak): the
    persist is retried inline, then a transient failure is handed to a durable
    Redis outbox while finalize closes normally. A permanent (4xx) failure is
    dropped with a loud alert."""

    OUTBOX_KEY = "stt:transcript_outbox"

    @staticmethod
    def _blob_mock():
        mock_blob = MagicMock()
        mock_blob.upload_streaming_raw_chunk = AsyncMock(return_value="s3://b/chunk")
        mock_blob.upload_streaming_raw_complete = AsyncMock(return_value="s3://b/raw.wav")
        mock_blob.upload_streaming_processed_complete = AsyncMock(
            return_value="s3://b/proc.wav"
        )
        mock_blob.upload_streaming_transcript = AsyncMock(
            return_value="s3://b/transcript.json"
        )
        mock_blob.upload_streaming_metadata = AsyncMock(
            return_value="s3://b/metadata.json"
        )
        return mock_blob

    def _session_with_text(self, mgr):
        from stt_v2.streaming.schemas import SegmentResult

        session = _make_session(consultation_id="c1")
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)
        session.add_result(
            SegmentResult(text="Hello", start_time=0.0, end_time=1.0, is_final=True)
        )
        mgr._sessions[session.session_id] = session
        mgr._blob_service = self._blob_mock()
        return session

    @pytest.mark.asyncio
    async def test_transient_persist_failure_is_retried_then_persisted(self):
        """A transient gateway blip on create_transcript is retried, not lost,
        and the retry carries the idempotency key."""
        mgr = _make_manager()
        mgr._transcript_persist_backoff_s = 0  # no real sleep in tests
        session = self._session_with_text(mgr)
        mgr.remove_session = AsyncMock()

        mock_gateway = MagicMock()
        mock_gateway.create_transcript = AsyncMock(
            side_effect=[RuntimeError("502 Bad Gateway"), {"contextItemId": "ctx-1"}]
        )
        mgr._get_api_client = MagicMock(return_value=mock_gateway)

        await mgr._finalize_session(session)

        # Retried after the transient failure → durable transcript survives.
        assert mock_gateway.create_transcript.await_count == 2
        assert (
            mock_gateway.create_transcript.await_args.kwargs["idempotency_key"]
            == f"c1:{session.session_id}"
        )
        # Persist eventually succeeded → session closed + capacity released.
        mgr.remove_session.assert_awaited_once()
        # Nothing left in the outbox.
        mgr._redis.hset.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_transient_exhaustion_enqueues_outbox_and_releases_capacity(self):
        """When inline retries are exhausted on a TRANSIENT error, the transcript
        is durably enqueued to the shared Redis outbox AND the session is closed
        so its capacity slot is released (C-1: no FINALIZING leak)."""
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        mgr._transcript_persist_backoff_s = 0
        session = self._session_with_text(mgr)
        mgr.remove_session = AsyncMock()

        mock_gateway = MagicMock()
        mock_gateway.create_transcript = AsyncMock(
            side_effect=RuntimeError("gateway down")  # no 4xx → transient
        )
        mgr._get_api_client = MagicMock(return_value=mock_gateway)

        await mgr._finalize_session(session)

        # Retried up to the configured cap (default 3), then handed to the outbox.
        assert mock_gateway.create_transcript.await_count == 3
        # Capacity released — the session is NOT retained/leaked.
        mgr.remove_session.assert_awaited_once()
        assert session.status == SessionStatus.CLOSED
        # Durably enqueued to the shared Redis outbox with the payload.
        enqueue = [
            c for c in mgr._redis.hset.await_args_list if c.args[0] == self.OUTBOX_KEY
        ]
        assert len(enqueue) == 1
        field, raw = enqueue[0].args[1], enqueue[0].args[2]
        assert field == f"c1:{session.session_id}"
        payload = json.loads(raw)
        assert payload["transcript_text"] == "Hello"
        assert payload["consultation_id"] == "c1"
        assert payload["idempotency_key"] == f"c1:{session.session_id}"

    @pytest.mark.asyncio
    async def test_permanent_persist_failure_drops_without_outbox(self):
        """A PERMANENT (4xx) persist error is dropped immediately — not retried,
        not enqueued — and the session still closes + releases capacity."""
        from stt_v2.core.exceptions import APIGatewayError
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        mgr._transcript_persist_backoff_s = 0
        session = self._session_with_text(mgr)
        mgr.remove_session = AsyncMock()

        mock_gateway = MagicMock()
        mock_gateway.create_transcript = AsyncMock(
            side_effect=APIGatewayError("bad request", details={"status_code": 400})
        )
        mgr._get_api_client = MagicMock(return_value=mock_gateway)

        await mgr._finalize_session(session)

        # 4xx → not retried.
        assert mock_gateway.create_transcript.await_count == 1
        # Not enqueued (retrying a client error is futile).
        assert not [
            c for c in mgr._redis.hset.await_args_list if c.args[0] == self.OUTBOX_KEY
        ]
        # Capacity still released.
        mgr.remove_session.assert_awaited_once()
        assert session.status == SessionStatus.CLOSED

    @pytest.mark.asyncio
    async def test_rate_limit_429_is_transient_enqueues_outbox(self):
        """I-1 — a 429 (throttled by the internal route under an end-of-clinic
        burst) is TRANSIENT, not permanent: it is retried inline and then
        enqueued to the outbox, NOT dropped, so the transcript is not lost."""
        from stt_v2.core.exceptions import APIGatewayError

        mgr = _make_manager()
        mgr._transcript_persist_backoff_s = 0
        session = self._session_with_text(mgr)
        mgr.remove_session = AsyncMock()

        mock_gateway = MagicMock()
        mock_gateway.create_transcript = AsyncMock(
            side_effect=APIGatewayError("Too Many Requests", details={"status_code": 429})
        )
        mgr._get_api_client = MagicMock(return_value=mock_gateway)

        await mgr._finalize_session(session)

        # Retried (not dropped at attempt 1) then handed to the durable outbox.
        assert mock_gateway.create_transcript.await_count == 3
        enqueue = [
            c for c in mgr._redis.hset.await_args_list if c.args[0] == self.OUTBOX_KEY
        ]
        assert len(enqueue) == 1
        # Capacity still released.
        mgr.remove_session.assert_awaited_once()


class TestTranscriptOutbox:
    """C2-03 (TASK-456) — the reaper re-drives the durable Redis transcript
    outbox at-LEAST-once (I-2): an entry is deleted ONLY after a confirmed 2xx,
    so a worker crash mid-POST leaves it re-drivable. A transient error keeps
    the entry (lease released, attempts bumped); a permanent (4xx) error or
    exhausted attempts drop it with a loud alert. A soft lease lets concurrent
    workers skip an in-flight entry."""

    OUTBOX_KEY = "stt:transcript_outbox"

    @staticmethod
    def _entry(attempts: int = 0, lease_expiry: float = 0):
        return {
            "transcript_text": "Hello world",
            "consultation_id": "c1",
            "tenant_id": "t1",
            "transcription_source": "streaming",
            "idempotency_key": "c1:sess_rec",
            "attempts": attempts,
            "lease_expiry": lease_expiry,
        }

    @pytest.mark.asyncio
    async def test_redrive_deletes_only_after_success(self):
        """The POST is committed BEFORE the entry is removed (delete-after-ack):
        create_transcript is awaited, THEN hdel — never the reverse."""
        mgr = _make_manager()
        order: list[str] = []
        mgr._redis.hgetall = AsyncMock(
            return_value={"c1:sess_rec": json.dumps(self._entry())}
        )
        mgr._redis.hset = AsyncMock(side_effect=lambda *a, **k: order.append("hset"))
        mgr._redis.hdel = AsyncMock(side_effect=lambda *a, **k: order.append("hdel"))

        gw = MagicMock()
        gw.create_transcript = AsyncMock(side_effect=lambda **k: order.append("post"))
        mgr._get_api_client = MagicMock(return_value=gw)

        await mgr._drain_transcript_outbox()

        kwargs = gw.create_transcript.await_args.kwargs
        assert kwargs["idempotency_key"] == "c1:sess_rec"
        assert kwargs["consultation_id"] == "c1"
        # Claim (lease) → POST → delete. The delete never precedes the POST.
        assert order == ["hset", "post", "hdel"]

    @pytest.mark.asyncio
    async def test_redrive_failure_keeps_entry_at_least_once(self):
        """I-2 — a redrive whose POST fails/does-not-complete must NEVER delete
        the entry, so a worker crash mid-POST cannot lose the transcript."""
        mgr = _make_manager()
        mgr._transcript_outbox_max_attempts = 5
        mgr._redis.hgetall = AsyncMock(
            return_value={"c1:sess_rec": json.dumps(self._entry())}
        )
        mgr._redis.hset = AsyncMock()
        mgr._redis.hdel = AsyncMock()

        gw = MagicMock()
        gw.create_transcript = AsyncMock(side_effect=RuntimeError("POST did not commit"))
        mgr._get_api_client = MagicMock(return_value=gw)

        await mgr._drain_transcript_outbox()

        # The entry is NEVER deleted on failure — it survives, re-drivable.
        mgr._redis.hdel.assert_not_awaited()
        # And it was written back (lease released) so the next scan re-drives it.
        deferred = [
            json.loads(c.args[2])
            for c in mgr._redis.hset.await_args_list
            if c.args[0] == self.OUTBOX_KEY
        ]
        assert deferred and deferred[-1]["lease_expiry"] == 0

    @pytest.mark.asyncio
    async def test_outbox_skips_entry_with_fresh_lease(self):
        """An entry whose lease is still fresh is being redriven by another
        worker → skip it (no duplicate POST)."""
        import time

        mgr = _make_manager()
        mgr._redis.hgetall = AsyncMock(
            return_value={
                "c1:sess_rec": json.dumps(self._entry(lease_expiry=time.time() + 1000))
            }
        )
        mgr._redis.hset = AsyncMock()
        mgr._redis.hdel = AsyncMock()

        gw = MagicMock()
        gw.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-1"})
        mgr._get_api_client = MagicMock(return_value=gw)

        await mgr._drain_transcript_outbox()

        gw.create_transcript.assert_not_awaited()
        mgr._redis.hset.assert_not_awaited()
        mgr._redis.hdel.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_outbox_transient_failure_reenqueues(self):
        mgr = _make_manager()
        mgr._transcript_outbox_max_attempts = 5
        mgr._redis.hgetall = AsyncMock(
            return_value={"c1:sess_rec": json.dumps(self._entry(attempts=1))}
        )
        mgr._redis.hset = AsyncMock()
        mgr._redis.hdel = AsyncMock()

        gw = MagicMock()
        gw.create_transcript = AsyncMock(side_effect=RuntimeError("503"))
        mgr._get_api_client = MagicMock(return_value=gw)

        await mgr._drain_transcript_outbox()

        # Kept (never deleted) and re-enqueued with an incremented attempt count.
        mgr._redis.hdel.assert_not_awaited()
        deferred = [
            json.loads(c.args[2])
            for c in mgr._redis.hset.await_args_list
            if c.args[0] == self.OUTBOX_KEY and json.loads(c.args[2])["lease_expiry"] == 0
        ]
        assert deferred and deferred[-1]["attempts"] == 2

    @pytest.mark.asyncio
    async def test_outbox_429_redrive_is_transient(self):
        """I-1 — a 429 during redrive is TRANSIENT: keep + re-enqueue, not drop."""
        from stt_v2.core.exceptions import APIGatewayError

        mgr = _make_manager()
        mgr._transcript_outbox_max_attempts = 5
        mgr._redis.hgetall = AsyncMock(
            return_value={"c1:sess_rec": json.dumps(self._entry(attempts=1))}
        )
        mgr._redis.hset = AsyncMock()
        mgr._redis.hdel = AsyncMock()

        gw = MagicMock()
        gw.create_transcript = AsyncMock(
            side_effect=APIGatewayError("throttled", details={"status_code": 429})
        )
        mgr._get_api_client = MagicMock(return_value=gw)

        await mgr._drain_transcript_outbox()

        # 429 is not permanent → the entry is retained, not dropped.
        mgr._redis.hdel.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_outbox_permanent_failure_drops_and_alerts(self):
        from structlog.testing import capture_logs

        from stt_v2.core.exceptions import APIGatewayError

        mgr = _make_manager()
        mgr._redis.hgetall = AsyncMock(
            return_value={"c1:sess_rec": json.dumps(self._entry())}
        )
        mgr._redis.hset = AsyncMock()
        mgr._redis.hdel = AsyncMock()

        gw = MagicMock()
        gw.create_transcript = AsyncMock(
            side_effect=APIGatewayError("bad", details={"status_code": 422})
        )
        mgr._get_api_client = MagicMock(return_value=gw)

        with capture_logs() as logs:
            await mgr._drain_transcript_outbox()

        # A genuine 4xx is dropped (deleted) with a loud alert.
        mgr._redis.hdel.assert_awaited_once_with(self.OUTBOX_KEY, "c1:sess_rec")
        assert any(
            "outbox_permanent_drop" in (entry.get("event") or "") for entry in logs
        )

    @pytest.mark.asyncio
    async def test_outbox_exhausted_drops_and_alerts(self):
        from structlog.testing import capture_logs

        mgr = _make_manager()
        mgr._transcript_outbox_max_attempts = 2
        mgr._redis.hgetall = AsyncMock(
            return_value={"c1:sess_rec": json.dumps(self._entry(attempts=1))}
        )
        mgr._redis.hset = AsyncMock()
        mgr._redis.hdel = AsyncMock()

        gw = MagicMock()
        gw.create_transcript = AsyncMock(side_effect=RuntimeError("503"))
        mgr._get_api_client = MagicMock(return_value=gw)

        with capture_logs() as logs:
            await mgr._drain_transcript_outbox()

        # attempts 1 -> 2 == max → dropped (deleted) with an alert.
        mgr._redis.hdel.assert_awaited_once_with(self.OUTBOX_KEY, "c1:sess_rec")
        assert any(
            "outbox_exhausted_drop" in (entry.get("event") or "") for entry in logs
        )


# ---------------------------------------------------------------------------
# SessionManager — snapshot loop
# ---------------------------------------------------------------------------


class TestSnapshotLoop:
    """Tests for incremental PCM chunk upload logic."""

    @pytest.mark.asyncio
    async def test_upload_snapshot_uploads_incremental_chunk(self):
        mgr = _make_manager()
        session = _make_session(consultation_id="c1")
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)

        mock_blob = MagicMock()
        mock_blob.upload_streaming_raw_chunk = AsyncMock(return_value="s3://bucket/chunk")
        mgr._blob_service = mock_blob

        await mgr._upload_snapshot(session)

        mock_blob.upload_streaming_raw_chunk.assert_awaited_once()
        call_kwargs = mock_blob.upload_streaming_raw_chunk.call_args.kwargs
        assert call_kwargs["chunk_index"] == 0
        assert call_kwargs["tenant_id"] == "t1"
        assert call_kwargs["session_id"] == "sess_rec"
        assert len(call_kwargs["chunk_bytes"]) == len(session.audio_buffer)

        # State should be updated
        assert mgr._chunk_offsets[session.session_id] == len(session.audio_buffer)
        assert mgr._chunk_indices[session.session_id] == 1
        assert session.session_id in mgr._last_snapshot_at

    @pytest.mark.asyncio
    async def test_upload_snapshot_second_chunk_is_incremental(self):
        mgr = _make_manager()
        session = _make_session()
        pcm = _one_second_pcm()
        session.record_frame(seq=0, data=pcm, sample_rate=16000)

        mock_blob = MagicMock()
        mock_blob.upload_streaming_raw_chunk = AsyncMock(return_value="s3://bucket/chunk")
        mgr._blob_service = mock_blob

        # First snapshot
        await mgr._upload_snapshot(session)
        first_chunk_size = len(pcm)

        # Record more audio
        session.record_frame(seq=1, data=pcm, sample_rate=16000)

        # Second snapshot — should only upload the new audio
        await mgr._upload_snapshot(session)

        assert mock_blob.upload_streaming_raw_chunk.await_count == 2
        second_call_kwargs = mock_blob.upload_streaming_raw_chunk.call_args_list[1].kwargs
        assert second_call_kwargs["chunk_index"] == 1
        assert len(second_call_kwargs["chunk_bytes"]) == first_chunk_size

    @pytest.mark.asyncio
    async def test_upload_snapshot_failure_non_fatal(self):
        mgr = _make_manager()
        session = _make_session(consultation_id="c1")
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)

        mock_blob = MagicMock()
        mock_blob.upload_streaming_raw_chunk = AsyncMock(side_effect=Exception("S3 error"))
        mgr._blob_service = mock_blob

        # Should not raise
        await mgr._upload_snapshot(session)

        # Offsets should NOT be updated on failure
        assert session.session_id not in mgr._chunk_offsets
        assert session.session_id not in mgr._last_snapshot_at


# ---------------------------------------------------------------------------
# Settings — new fields
# ---------------------------------------------------------------------------


class TestSettingsNewFields:
    """Tests for new settings fields."""

    def test_streaming_snapshot_interval_default(self):
        from stt_v2.core.config.settings import Settings

        settings = Settings()
        assert settings.streaming_snapshot_interval_s == 30.0


# ---------------------------------------------------------------------------
# Audio buffer cap
# ---------------------------------------------------------------------------


class TestAudioBufferCap:
    """Tests for the configurable audio buffer memory cap."""

    def test_buffer_drops_frames_when_cap_exceeded(self):
        session = _make_session()
        session._max_audio_buffer_bytes = 500  # cap at 500 bytes
        data = b"\x00\x00" * 80  # 160 bytes per frame

        # First frame: 0 + 160 = 160 <= 500 → accepted
        session.record_frame(seq=0, data=data, sample_rate=16000)
        assert len(session.audio_buffer) == 160

        # Second frame: 160 + 160 = 320 <= 500 → accepted
        session.record_frame(seq=1, data=data, sample_rate=16000)
        assert len(session.audio_buffer) == 320

        # Third frame: 320 + 160 = 480 <= 500 → accepted
        session.record_frame(seq=2, data=data, sample_rate=16000)
        assert len(session.audio_buffer) == 480

        # Fourth frame: 480 + 160 = 640 > 500 → dropped
        session.record_frame(seq=3, data=data, sample_rate=16000)
        assert len(session.audio_buffer) == 480  # unchanged
        assert session._audio_buffer_warned is True

    def test_warning_only_logged_once(self):
        session = _make_session()
        session._max_audio_buffer_bytes = 10
        data = b"\x00\x00" * 100
        session.record_frame(seq=0, data=data, sample_rate=16000)
        # First frame exceeds cap (200 > 10), nothing appended
        assert len(session.audio_buffer) == 0
        assert session._audio_buffer_warned is True

        # Record more — warned flag stays True, no repeat warnings
        session.record_frame(seq=1, data=data, sample_rate=16000)
        assert session._audio_buffer_warned is True
        assert len(session.audio_buffer) == 0

    def test_max_buffer_setting_default(self):
        from stt_v2.core.config.settings import Settings

        settings = Settings()
        assert settings.streaming_max_audio_buffer_bytes == 500_000_000


# ---------------------------------------------------------------------------
# Path segment sanitization
# ---------------------------------------------------------------------------


class TestPathSegmentSanitization:
    """Tests for _sanitize_path_segment in StoragePathResolver."""

    def test_clean_segment_unchanged(self):
        from stt_v2.storage.path_resolver import StoragePathResolver

        resolver = StoragePathResolver()
        assert resolver._sanitize_path_segment("dev") == "dev"
        assert resolver._sanitize_path_segment("tenant-abc") == "tenant-abc"

    def test_special_chars_replaced(self):
        from stt_v2.storage.path_resolver import StoragePathResolver

        resolver = StoragePathResolver()
        # slashes, spaces, special chars get replaced with _
        assert "/" not in resolver._sanitize_path_segment("a/b")
        assert " " not in resolver._sanitize_path_segment("a b")
        assert (
            ".." not in resolver._sanitize_path_segment("..")
            or resolver._sanitize_path_segment("..") == ".."
        )
        # dots are allowed
        assert resolver._sanitize_path_segment("v1.2") == "v1.2"

    def test_empty_string_becomes_unknown(self):
        from stt_v2.storage.path_resolver import StoragePathResolver

        resolver = StoragePathResolver()
        assert resolver._sanitize_path_segment("") == "_unknown"
        assert resolver._sanitize_path_segment("   ") == "_unknown"

    def test_streaming_paths_sanitize_segments(self):
        from stt_v2.storage.path_resolver import StoragePathResolver

        resolver = StoragePathResolver()
        path = resolver.streaming_raw_chunk_path(
            tenant_id="tenant id",
            session_id="cons/../../root",
            chunk_index=0,
        )
        # No traversal or spaces should survive
        assert "../" not in path
        assert " " not in path


# ---------------------------------------------------------------------------
# Finalize — session.close() guarantee
# ---------------------------------------------------------------------------


class TestFinalizeCloseGuarantee:
    """session.close() must always execute even if prior steps fail."""

    @pytest.mark.asyncio
    async def test_close_called_when_finalize_raises(self):
        mgr = _make_manager()
        session = _make_session(consultation_id="c1")
        mgr._sessions[session.session_id] = session
        mgr.remove_session = AsyncMock()

        # Make session.finalize() raise
        session.finalize = AsyncMock(side_effect=RuntimeError("boom"))
        session.close = AsyncMock()

        await mgr._finalize_session(session)

        session.close.assert_awaited_once()
        mgr.remove_session.assert_awaited_once_with(session.session_id)


# ---------------------------------------------------------------------------
# end_session — public entry-point (used by DELETE / POST end)
# ---------------------------------------------------------------------------


class TestEndSession:
    """end_session() must finalize (upload all artifacts) before removing."""

    @pytest.mark.asyncio
    async def test_end_session_uploads_all_artifacts(self):
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = _make_session()
        session.record_frame(seq=0, data=_one_second_pcm(), sample_rate=16000)
        mgr._sessions[session.session_id] = session

        mock_blob = MagicMock()
        mock_blob.upload_streaming_raw_chunk = AsyncMock(return_value="s3://bucket/chunk")
        mock_blob.upload_streaming_raw_complete = AsyncMock(return_value="s3://bucket/complete.wav")
        mock_blob.upload_streaming_transcript = AsyncMock(
            return_value="s3://bucket/transcript.json"
        )
        mock_blob.upload_streaming_metadata = AsyncMock(return_value="s3://bucket/metadata.json")
        mgr._blob_service = mock_blob
        mgr.remove_session = AsyncMock()

        await mgr.end_session(session.session_id)

        mock_blob.upload_streaming_raw_complete.assert_awaited_once()
        mock_blob.upload_streaming_transcript.assert_awaited_once()
        mock_blob.upload_streaming_metadata.assert_awaited_once()
        assert session.status == SessionStatus.CLOSED

    @pytest.mark.asyncio
    async def test_end_session_noop_for_unknown_id(self):
        mgr = _make_manager()
        # Should not raise
        await mgr.end_session("nonexistent-id")

    @pytest.mark.asyncio
    async def test_end_session_falls_back_to_remove_on_error(self):
        mgr = _make_manager()
        session = _make_session()
        mgr._sessions[session.session_id] = session
        mgr.remove_session = AsyncMock()

        # Make finalize blow up at session.finalize()
        session.finalize = AsyncMock(side_effect=RuntimeError("boom"))
        session.close = AsyncMock()

        await mgr.end_session(session.session_id)

        # Should still clean up
        mgr.remove_session.assert_awaited()
