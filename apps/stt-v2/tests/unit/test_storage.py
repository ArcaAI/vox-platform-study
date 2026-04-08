"""Unit tests for Storage domain."""

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from stt_v2.storage.blob_service import BlobService
from stt_v2.storage.path_resolver import StoragePathResolver


class TestStoragePathResolver:
    """Tests for StoragePathResolver."""

    @pytest.fixture
    def resolver(self):
        return StoragePathResolver(
            audio_bucket="hope-audio",
            chunk_bucket="hope-chunks",
            model_bucket="hope-models",
        )

    def test_audio_path_with_consultation(self, resolver):
        """Test audio path generation with consultation."""
        ts = datetime(2024, 3, 15, 10, 30, 0)

        path = resolver.audio_path(
            tenant_id="tenant-123",
            consultation_id="consult-456",
            job_id="job-789",
            filename="recording.wav",
            timestamp=ts,
        )

        assert path == "2024/03/consultations/consult-456/job-789/raw/recording.wav"

    def test_audio_path_without_consultation(self, resolver):
        """Test audio path generation without consultation."""
        ts = datetime(2024, 6, 20, 14, 0, 0)

        path = resolver.audio_path(
            tenant_id="tenant-123",
            consultation_id=None,
            job_id="job-789",
            filename="audio.mp3",
            timestamp=ts,
        )

        assert path == "2024/06/jobs/job-789/raw/audio.mp3"

    def test_audio_path_sanitizes_filename(self, resolver):
        """Test that filenames are sanitized."""
        path = resolver.audio_path(
            tenant_id="t-1",
            consultation_id=None,
            job_id="j-1",
            filename="my file & name?.wav",
        )

        # Spaces become _, & becomes _, ? is removed
        # "my file & name?.wav" -> "my_file___name.wav" (space->_ + space->_ + &->_)
        assert "my_file___name.wav" in path
        assert "&" not in path
        assert "?" not in path
        assert " " not in path

    def test_chunk_path(self, resolver):
        """Test chunk path generation."""
        path = resolver.chunk_path(
            session_id="session-abc",
            chunk_index=5,
        )

        assert path == "sessions/session-abc/chunk_000005.wav"

    def test_chunk_path_padding(self, resolver):
        """Test chunk index padding."""
        path = resolver.chunk_path(
            session_id="session-abc",
            chunk_index=123456,
        )

        assert path == "sessions/session-abc/chunk_123456.wav"

    def test_transcript_path_json(self, resolver):
        """Test transcript path for JSON format."""
        ts = datetime(2024, 1, 10)

        path = resolver.transcript_path(
            tenant_id="t-1",
            consultation_id="c-1",
            job_id="j-1",
            format="json",
            timestamp=ts,
        )

        assert path == "2024/01/consultations/c-1/j-1/transcript.json"

    def test_transcript_path_vtt(self, resolver):
        """Test transcript path for VTT format."""
        path = resolver.transcript_path(
            tenant_id="t-1",
            consultation_id=None,
            job_id="j-1",
            format="vtt",
        )

        assert path.endswith("/transcript.vtt")

    def test_model_cache_path(self, resolver):
        """Test model cache path generation."""
        path = resolver.model_cache_path(
            model_slug="whisper-large",
            revision="v1.0",
            filename="model.safetensors",
        )

        assert path == "models/whisper-large/v1.0/model.safetensors"

    def test_model_cache_path_no_revision(self, resolver):
        """Test model cache path without revision."""
        path = resolver.model_cache_path(
            model_slug="whisper-large",
            revision=None,
            filename="config.json",
        )

        assert path == "models/whisper-large/default/config.json"

    def test_temp_path(self, resolver):
        """Test temporary path generation."""
        path = resolver.temp_path(prefix="upload", suffix=".wav")

        assert path.startswith("temp/upload_")
        assert path.endswith(".wav")

    def test_get_full_uri(self, resolver):
        """Test full URI generation."""
        uri = resolver.get_full_uri("my-bucket", "path/to/file.txt")

        assert uri == "s3://my-bucket/path/to/file.txt"

    def test_parse_uri_s3(self, resolver):
        """Test parsing S3 URI."""
        bucket, path = resolver.parse_uri("s3://my-bucket/path/to/file.txt")

        assert bucket == "my-bucket"
        assert path == "path/to/file.txt"

    def test_parse_uri_minio(self, resolver):
        """Test parsing MinIO URI."""
        bucket, path = resolver.parse_uri("minio://my-bucket/file.txt")

        assert bucket == "my-bucket"
        assert path == "file.txt"

    def test_parse_uri_no_prefix(self, resolver):
        """Test parsing URI without prefix."""
        bucket, path = resolver.parse_uri("bucket/path/file.txt")

        assert bucket == "bucket"
        assert path == "path/file.txt"

    def test_sanitize_filename_long_name(self, resolver):
        """Test sanitizing very long filenames."""
        long_name = "a" * 250 + ".wav"

        sanitized = resolver._sanitize_filename(long_name)

        assert len(sanitized) <= 200
        assert sanitized.endswith(".wav")

    def test_sanitize_filename_with_path(self, resolver):
        """Test sanitizing filename with path components."""
        sanitized = resolver._sanitize_filename("/path/to/file.wav")

        assert sanitized == "file.wav"
        assert "/" not in sanitized


class TestBlobService:
    """Tests for BlobService."""

    @pytest.fixture
    def mock_minio_client(self):
        """Create mock MinIO client."""
        client = MagicMock()
        client.client = MagicMock()
        client.client.bucket_exists = MagicMock(return_value=True)
        client.client.put_object = MagicMock()
        client.client.get_object = MagicMock()
        client.client.remove_object = MagicMock()
        client.client.stat_object = MagicMock()
        return client

    @pytest.fixture
    def blob_service(self, mock_minio_client):
        """Create BlobService with mocked client."""
        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_minio_client):
            service = BlobService()
            yield service

    @pytest.mark.asyncio
    async def test_upload_audio(self, blob_service, mock_minio_client):
        """Test uploading audio file."""
        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_minio_client):
            uri = await blob_service.upload_audio(
                audio_bytes=b"audio data",
                tenant_id="t-1",
                job_id="j-1",
                filename="test.wav",
                consultation_id="c-1",
                content_type="audio/wav",
            )

            assert uri.startswith("s3://")
            assert "test.wav" in uri
            mock_minio_client.client.put_object.assert_called_once()

    @pytest.mark.asyncio
    async def test_upload_chunk(self, blob_service, mock_minio_client):
        """Test uploading audio chunk."""
        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_minio_client):
            uri = await blob_service.upload_chunk(
                chunk_bytes=b"chunk data",
                session_id="session-123",
                chunk_index=0,
            )

            assert "session-123" in uri
            assert "chunk_000000" in uri

    @pytest.mark.asyncio
    async def test_upload_transcript(self, blob_service, mock_minio_client):
        """Test uploading transcript."""
        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_minio_client):
            uri = await blob_service.upload_transcript(
                transcript_data='{"text": "hello"}',
                tenant_id="t-1",
                job_id="j-1",
                format="json",
            )

            assert uri.endswith("/transcript.json")

    @pytest.mark.asyncio
    async def test_download_audio(self, blob_service, mock_minio_client):
        """Test downloading audio."""
        mock_response = MagicMock()
        mock_response.read = MagicMock(return_value=b"audio data")
        mock_response.close = MagicMock()
        mock_response.release_conn = MagicMock()
        mock_minio_client.client.get_object = MagicMock(return_value=mock_response)

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_minio_client):
            data = await blob_service.download_audio("s3://bucket/path/file.wav")

            assert data == b"audio data"
            mock_response.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_delete(self, blob_service, mock_minio_client):
        """Test deleting blob."""
        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_minio_client):
            result = await blob_service.delete("s3://bucket/path/file.wav")

            assert result is True
            mock_minio_client.client.remove_object.assert_called_once()

    @pytest.mark.asyncio
    async def test_delete_failure(self, blob_service, mock_minio_client):
        """Test delete failure handling."""
        mock_minio_client.client.remove_object = MagicMock(side_effect=Exception("Delete failed"))

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_minio_client):
            result = await blob_service.delete("s3://bucket/path/file.wav")

            assert result is False

    @pytest.mark.asyncio
    async def test_exists(self, blob_service, mock_minio_client):
        """Test checking blob existence."""
        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_minio_client):
            result = await blob_service.exists("s3://bucket/path/file.wav")

            assert result is True
            mock_minio_client.client.stat_object.assert_called_once()

    @pytest.mark.asyncio
    async def test_exists_not_found(self, blob_service, mock_minio_client):
        """Test exists returns False for non-existent blob."""
        mock_minio_client.client.stat_object = MagicMock(side_effect=Exception("Not found"))

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_minio_client):
            result = await blob_service.exists("s3://bucket/path/file.wav")

            assert result is False

    @pytest.mark.asyncio
    async def test_get_size(self, blob_service, mock_minio_client):
        """Test getting blob size."""
        mock_stat = MagicMock()
        mock_stat.size = 1024
        mock_minio_client.client.stat_object = MagicMock(return_value=mock_stat)

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_minio_client):
            size = await blob_service.get_size("s3://bucket/path/file.wav")

            assert size == 1024

    @pytest.mark.asyncio
    async def test_get_size_not_found(self, blob_service, mock_minio_client):
        """Test get_size returns 0 for non-existent blob."""
        mock_minio_client.client.stat_object = MagicMock(side_effect=Exception("Not found"))

        with patch("stt_v2.storage.blob_service.get_minio_client", return_value=mock_minio_client):
            size = await blob_service.get_size("s3://bucket/path/file.wav")

            assert size == 0
