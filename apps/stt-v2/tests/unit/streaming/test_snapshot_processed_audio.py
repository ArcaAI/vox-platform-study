"""Tests for snapshot and finalize preferring processed audio when available."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestSnapshotProcessedAudio:
    async def test_snapshot_uses_processed_buffer_when_available(self):
        """_upload_snapshot should upload from processed_audio_buffer when it has content."""
        from stt_v2.streaming.session_manager import SessionManager

        mgr = SessionManager.__new__(SessionManager)

        session = MagicMock()
        session.session_id = "s1"
        session.tenant_id = "t1"
        session.status.name = "ACTIVE"
        session._denoise_active = True
        session.processed_audio_buffer = bytearray(b"\x01\x02\x03\x04" * 100)
        session.audio_buffer = bytearray(b"\xff\xfe" * 50)

        mgr._chunk_offsets = {"s1": 0}
        mgr._chunk_indices = {"s1": 0}
        mgr._processed_chunk_indices = {"s1": 0}
        mgr._last_snapshot_at = {}
        mgr._processed_chunk_offsets = {"s1": 0}

        mock_blob = AsyncMock()
        mgr._get_blob_service = MagicMock(return_value=mock_blob)

        await mgr._upload_snapshot(session)

        # Verify processed chunk uses upload_streaming_processed_chunk (not raw)
        mock_blob.upload_streaming_raw_chunk.assert_not_called()
        call_args = mock_blob.upload_streaming_processed_chunk.call_args
        uploaded = call_args.kwargs.get("chunk_bytes") or call_args[1].get("chunk_bytes")
        if uploaded is None:
            uploaded = call_args[0][0]
        assert uploaded == bytes(session.processed_audio_buffer)

    async def test_snapshot_uses_raw_buffer_when_no_processed_audio(self):
        """_upload_snapshot should use audio_buffer when no processed audio."""
        from stt_v2.streaming.session_manager import SessionManager

        mgr = SessionManager.__new__(SessionManager)

        session = MagicMock()
        session.session_id = "s2"
        session.tenant_id = "t1"
        session.status.name = "ACTIVE"
        session._denoise_active = False
        session.processed_audio_buffer = bytearray()
        session.audio_buffer = bytearray(b"\xaa\xbb" * 100)

        mgr._chunk_offsets = {"s2": 0}
        mgr._chunk_indices = {"s2": 0}
        mgr._last_snapshot_at = {}

        mock_blob = AsyncMock()
        mgr._get_blob_service = MagicMock(return_value=mock_blob)

        await mgr._upload_snapshot(session)

        call_args = mock_blob.upload_streaming_raw_chunk.call_args
        uploaded = call_args.kwargs.get("chunk_bytes") or call_args[1].get("chunk_bytes")
        if uploaded is None:
            uploaded = call_args[0][0]
        assert uploaded == bytes(session.audio_buffer)
