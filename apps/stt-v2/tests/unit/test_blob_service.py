"""Unit tests for Blob Storage Service.

Tests cover all blob storage operations including upload, download,
delete, and presigned URL generation.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import io

from stt_v2.storage.blob_service import BlobService, get_blob_service
from stt_v2.core.exceptions import StorageError


class TestBlobServiceInit:
    """Tests for BlobService initialization."""

    def test_init_with_custom_resolver(self):
        """Test initialization with custom path resolver."""
        mock_resolver = MagicMock()
        service = BlobService(path_resolver=mock_resolver)

        assert service._resolver is mock_resolver

    def test_init_with_default_resolver(self):
        """Test initialization with default path resolver."""
        with patch("stt_v2.storage.blob_service.get_path_resolver") as mock_get_resolver, \
             patch("stt_v2.storage.blob_service.get_settings") as mock_settings:

            mock_resolver = MagicMock()
            mock_get_resolver.return_value = mock_resolver
            mock_settings.return_value = MagicMock()

            service = BlobService()

            assert service._resolver is mock_resolver


class TestBlobServiceUpload:
    """Tests for upload operations."""

    @pytest.fixture
    def service(self):
        mock_resolver = MagicMock()
        mock_resolver.audio_bucket = "hope-audio"
        mock_resolver.chunk_bucket = "hope-audio-chunks"
        mock_resolver.audio_path.return_value = "tenant/job/audio.wav"
        mock_resolver.chunk_path.return_value = "sessions/s-123/chunk-0.wav"
        mock_resolver.transcript_path.return_value = "tenant/job/transcript.json"
        mock_resolver.get_full_uri.return_value = "minio://hope-audio/tenant/job/audio.wav"

        with patch("stt_v2.storage.blob_service.get_settings") as mock_settings:
            mock_settings.return_value = MagicMock()
            return BlobService(path_resolver=mock_resolver)

    @pytest.mark.asyncio
    async def test_upload_audio_success(self, service):
        """Test successful audio upload."""
        audio_bytes = b"audio data"

        with patch.object(service, "_upload_bytes", new_callable=AsyncMock) as mock_upload:
            result = await service.upload_audio(
                audio_bytes=audio_bytes,
                tenant_id="t-123",
                job_id="j-456",
                filename="test.wav",
                consultation_id="c-789",
            )

            mock_upload.assert_called_once()
            assert result == "minio://hope-audio/tenant/job/audio.wav"

    @pytest.mark.asyncio
    async def test_upload_chunk_success(self, service):
        """Test successful chunk upload."""
        chunk_bytes = b"chunk data"

        with patch.object(service, "_upload_bytes", new_callable=AsyncMock) as mock_upload:
            result = await service.upload_chunk(
                chunk_bytes=chunk_bytes,
                session_id="s-123",
                chunk_index=0,
            )

            mock_upload.assert_called_once()
            assert "minio://" in result

    @pytest.mark.asyncio
    async def test_upload_transcript_string(self, service):
        """Test transcript upload with string data."""
        transcript = '{"text": "Hello world"}'

        with patch.object(service, "_upload_bytes", new_callable=AsyncMock) as mock_upload:
            result = await service.upload_transcript(
                transcript_data=transcript,
                tenant_id="t-123",
                job_id="j-456",
                format="json",
            )

            # Should encode string to bytes
            call_args = mock_upload.call_args
            assert isinstance(call_args.kwargs["data"], bytes)

    @pytest.mark.asyncio
    async def test_upload_transcript_bytes(self, service):
        """Test transcript upload with bytes data."""
        transcript = b'{"text": "Hello world"}'

        with patch.object(service, "_upload_bytes", new_callable=AsyncMock) as mock_upload:
            result = await service.upload_transcript(
                transcript_data=transcript,
                tenant_id="t-123",
                job_id="j-456",
                format="json",
            )

            mock_upload.assert_called_once()

    @pytest.mark.asyncio
    async def test_upload_transcript_different_formats(self, service):
        """Test transcript upload with different formats."""
        formats_and_types = [
            ("json", "application/json"),
            ("txt", "text/plain"),
            ("vtt", "text/vtt"),
            ("srt", "text/plain"),
            ("unknown", "application/octet-stream"),
        ]

        for fmt, expected_type in formats_and_types:
            with patch.object(service, "_upload_bytes", new_callable=AsyncMock) as mock_upload:
                await service.upload_transcript(
                    transcript_data="test",
                    tenant_id="t-123",
                    job_id="j-456",
                    format=fmt,
                )

                call_kwargs = mock_upload.call_args.kwargs
                assert call_kwargs["content_type"] == expected_type, f"Failed for format: {fmt}"


class TestBlobServiceDownload:
    """Tests for download operations."""

    @pytest.fixture
    def service(self):
        mock_resolver = MagicMock()
        mock_resolver.parse_uri.return_value = ("hope-audio", "path/to/file")

        with patch("stt_v2.storage.blob_service.get_settings") as mock_settings:
            mock_settings.return_value = MagicMock()
            return BlobService(path_resolver=mock_resolver)

    @pytest.mark.asyncio
    async def test_download_audio_success(self, service):
        """Test successful audio download."""
        expected_data = b"audio data"

        with patch.object(service, "_download_bytes", new_callable=AsyncMock) as mock_download:
            mock_download.return_value = expected_data

            result = await service.download_audio("minio://hope-audio/path/to/file")

            assert result == expected_data
            service._resolver.parse_uri.assert_called_once()

    @pytest.mark.asyncio
    async def test_download_bytes_success(self, service):
        """Test _download_bytes implementation."""
        expected_data = b"file content"

        mock_response = MagicMock()
        mock_response.read.return_value = expected_data

        mock_client = MagicMock()
        mock_client.client.get_object.return_value = mock_response

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_client):
            result = await service._download_bytes("bucket", "path")

            assert result == expected_data
            mock_response.close.assert_called_once()
            mock_response.release_conn.assert_called_once()

    @pytest.mark.asyncio
    async def test_download_bytes_error(self, service):
        """Test _download_bytes raises StorageError on failure."""
        mock_client = MagicMock()
        mock_client.client.get_object.side_effect = Exception("Download failed")

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_client):
            with pytest.raises(StorageError, match="Failed to download"):
                await service._download_bytes("bucket", "path")


class TestBlobServiceDelete:
    """Tests for delete operations."""

    @pytest.fixture
    def service(self):
        mock_resolver = MagicMock()
        mock_resolver.parse_uri.return_value = ("hope-audio", "path/to/file")
        mock_resolver.chunk_bucket = "hope-audio-chunks"

        with patch("stt_v2.storage.blob_service.get_settings") as mock_settings:
            mock_settings.return_value = MagicMock()
            return BlobService(path_resolver=mock_resolver)

    @pytest.mark.asyncio
    async def test_delete_success(self, service):
        """Test successful deletion."""
        mock_client = MagicMock()

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_client):
            result = await service.delete("minio://hope-audio/path/to/file")

            assert result is True
            mock_client.client.remove_object.assert_called_once()

    @pytest.mark.asyncio
    async def test_delete_failure(self, service):
        """Test delete returns False on failure."""
        mock_client = MagicMock()
        mock_client.client.remove_object.side_effect = Exception("Delete failed")

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_client):
            result = await service.delete("minio://hope-audio/path/to/file")

            assert result is False

    @pytest.mark.asyncio
    async def test_delete_session_chunks(self, service):
        """Test deleting session chunks."""
        mock_obj1 = MagicMock()
        mock_obj1.object_name = "sessions/s-123/chunk-0.wav"
        mock_obj2 = MagicMock()
        mock_obj2.object_name = "sessions/s-123/chunk-1.wav"

        mock_client = MagicMock()
        mock_client.client.list_objects.return_value = [mock_obj1, mock_obj2]

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_client):
            count = await service.delete_session_chunks("s-123")

            assert count == 2
            assert mock_client.client.remove_object.call_count == 2

    @pytest.mark.asyncio
    async def test_delete_session_chunks_error(self, service):
        """Test delete session chunks handles errors gracefully."""
        mock_client = MagicMock()
        mock_client.client.list_objects.side_effect = Exception("List failed")

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_client):
            count = await service.delete_session_chunks("s-123")

            assert count == 0


class TestBlobServiceUtilities:
    """Tests for utility operations."""

    @pytest.fixture
    def service(self):
        mock_resolver = MagicMock()
        mock_resolver.parse_uri.return_value = ("hope-audio", "path/to/file")

        with patch("stt_v2.storage.blob_service.get_settings") as mock_settings:
            mock_settings.return_value = MagicMock()
            return BlobService(path_resolver=mock_resolver)

    @pytest.mark.asyncio
    async def test_exists_true(self, service):
        """Test exists returns True when file exists."""
        mock_client = MagicMock()
        mock_client.client.stat_object.return_value = MagicMock()

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_client):
            result = await service.exists("minio://hope-audio/path/to/file")

            assert result is True

    @pytest.mark.asyncio
    async def test_exists_false(self, service):
        """Test exists returns False when file doesn't exist."""
        mock_client = MagicMock()
        mock_client.client.stat_object.side_effect = Exception("Not found")

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_client):
            result = await service.exists("minio://hope-audio/path/to/file")

            assert result is False

    @pytest.mark.asyncio
    async def test_get_size_success(self, service):
        """Test get_size returns correct size."""
        mock_stat = MagicMock()
        mock_stat.size = 1024

        mock_client = MagicMock()
        mock_client.client.stat_object.return_value = mock_stat

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_client):
            result = await service.get_size("minio://hope-audio/path/to/file")

            assert result == 1024

    @pytest.mark.asyncio
    async def test_get_size_not_found(self, service):
        """Test get_size returns 0 when file not found."""
        mock_client = MagicMock()
        mock_client.client.stat_object.side_effect = Exception("Not found")

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_client):
            result = await service.get_size("minio://hope-audio/path/to/file")

            assert result == 0

    @pytest.mark.asyncio
    async def test_get_presigned_url(self, service):
        """Test getting presigned URL."""
        mock_client = MagicMock()
        mock_client.client.presigned_get_object.return_value = "https://presigned-url"

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_client):
            result = await service.get_presigned_url(
                "minio://hope-audio/path/to/file",
                expires_in=7200,
            )

            assert result == "https://presigned-url"


class TestBlobServiceUploadBytes:
    """Tests for _upload_bytes internal method."""

    @pytest.fixture
    def service(self):
        mock_resolver = MagicMock()

        with patch("stt_v2.storage.blob_service.get_settings") as mock_settings:
            mock_settings.return_value = MagicMock()
            return BlobService(path_resolver=mock_resolver)

    @pytest.mark.asyncio
    async def test_upload_bytes_creates_bucket_if_not_exists(self, service):
        """Test that upload creates bucket if it doesn't exist."""
        mock_client = MagicMock()
        mock_client.client.bucket_exists.return_value = False

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_client):
            await service._upload_bytes(
                bucket="new-bucket",
                path="path/to/file",
                data=b"content",
                content_type="text/plain",
            )

            mock_client.client.make_bucket.assert_called_once_with("new-bucket")
            mock_client.client.put_object.assert_called_once()

    @pytest.mark.asyncio
    async def test_upload_bytes_skips_bucket_creation_if_exists(self, service):
        """Test that upload skips bucket creation if exists."""
        mock_client = MagicMock()
        mock_client.client.bucket_exists.return_value = True

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_client):
            await service._upload_bytes(
                bucket="existing-bucket",
                path="path/to/file",
                data=b"content",
                content_type="text/plain",
            )

            mock_client.client.make_bucket.assert_not_called()
            mock_client.client.put_object.assert_called_once()

    @pytest.mark.asyncio
    async def test_upload_bytes_error(self, service):
        """Test _upload_bytes raises StorageError on failure."""
        mock_client = MagicMock()
        mock_client.client.bucket_exists.return_value = True
        mock_client.client.put_object.side_effect = Exception("Upload failed")

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_client):
            with pytest.raises(StorageError, match="Failed to upload"):
                await service._upload_bytes(
                    bucket="bucket",
                    path="path",
                    data=b"content",
                    content_type="text/plain",
                )


class TestBlobServiceSingleton:
    """Tests for singleton factory."""

    def test_get_blob_service_returns_singleton(self):
        """Test that get_blob_service returns the same instance."""
        import stt_v2.storage.blob_service as module
        module._service = None  # Reset

        with patch("stt_v2.storage.blob_service.get_path_resolver") as mock_resolver, \
             patch("stt_v2.storage.blob_service.get_settings") as mock_settings:

            mock_resolver.return_value = MagicMock()
            mock_settings.return_value = MagicMock()

            service1 = get_blob_service()
            service2 = get_blob_service()

            assert service1 is service2

    def test_get_blob_service_creates_instance(self):
        """Test that get_blob_service creates BlobService instance."""
        import stt_v2.storage.blob_service as module
        module._service = None  # Reset

        with patch("stt_v2.storage.blob_service.get_path_resolver") as mock_resolver, \
             patch("stt_v2.storage.blob_service.get_settings") as mock_settings:

            mock_resolver.return_value = MagicMock()
            mock_settings.return_value = MagicMock()

            service = get_blob_service()

            assert isinstance(service, BlobService)
