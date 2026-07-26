"""Unit tests for MinIO Client wrapper.

Tests cover all MinIO storage operations.
"""

from unittest.mock import MagicMock, patch

import pytest
from minio.error import S3Error
from pydantic import SecretStr

from stt.core.exceptions import StorageError
from stt.core.storage.minio_client import (
    MinIOClient,
    close_minio,
    get_minio_client,
    initialize_minio,
)


class TestMinIOClientInit:
    """Tests for MinIOClient initialization."""

    def test_init_creates_minio_client(self):
        """Test that init creates underlying Minio client."""
        with patch("stt.core.storage.minio_client.Minio") as mock_minio:
            mock_minio.return_value = MagicMock()

            _client = MinIOClient(
                endpoint="localhost:9000",
                access_key="access",
                secret_key="secret",
                secure=False,
            )

            mock_minio.assert_called_once_with(
                endpoint="localhost:9000",
                access_key="access",
                secret_key="secret",
                secure=False,
            )


class TestMinIOClientBucket:
    """Tests for bucket operations."""

    @pytest.fixture
    def client(self):
        with patch("stt.core.storage.minio_client.Minio") as mock_minio:
            mock_instance = MagicMock()
            mock_minio.return_value = mock_instance
            client = MinIOClient("localhost", "access", "secret")
            return client

    def test_ensure_bucket_creates_if_not_exists(self, client):
        """Test ensure_bucket creates bucket if it doesn't exist."""
        client._client.bucket_exists.return_value = False

        client.ensure_bucket("test-bucket")

        client._client.make_bucket.assert_called_once_with("test-bucket")

    def test_ensure_bucket_skips_if_exists(self, client):
        """Test ensure_bucket skips creation if bucket exists."""
        client._client.bucket_exists.return_value = True

        client.ensure_bucket("test-bucket")

        client._client.make_bucket.assert_not_called()

    def test_ensure_bucket_raises_storage_error_on_failure(self, client):
        """Test ensure_bucket raises StorageError on S3Error."""
        client._client.bucket_exists.side_effect = S3Error(
            code="Error",
            message="Bucket error",
            resource="bucket",
            request_id="123",
            host_id="host",
            response=None,
        )

        with pytest.raises(StorageError, match="Failed to ensure bucket"):
            client.ensure_bucket("test-bucket")


class TestMinIOClientUpload:
    """Tests for upload operations."""

    @pytest.fixture
    def client(self):
        with patch("stt.core.storage.minio_client.Minio") as mock_minio:
            mock_instance = MagicMock()
            mock_minio.return_value = mock_instance
            client = MinIOClient("localhost", "access", "secret")
            return client

    def test_upload_file_success(self, client):
        """Test successful file upload."""
        result = client.upload_file(
            bucket_name="test-bucket",
            object_name="path/to/file.wav",
            file_path="/local/file.wav",
            content_type="audio/wav",
        )

        client._client.fput_object.assert_called_once_with(
            bucket_name="test-bucket",
            object_name="path/to/file.wav",
            file_path="/local/file.wav",
            content_type="audio/wav",
        )
        assert result == "test-bucket/path/to/file.wav"

    def test_upload_file_raises_storage_error_on_failure(self, client):
        """Test upload_file raises StorageError on S3Error."""
        client._client.fput_object.side_effect = S3Error(
            code="Error",
            message="Upload error",
            resource="object",
            request_id="123",
            host_id="host",
            response=None,
        )

        with pytest.raises(StorageError, match="Failed to upload file"):
            client.upload_file("bucket", "object", "/path")

    def test_upload_bytes_success(self, client):
        """Test successful bytes upload."""
        data = b"test content"

        result = client.upload_bytes(
            bucket_name="test-bucket",
            object_name="path/to/file.txt",
            data=data,
            content_type="text/plain",
        )

        client._client.put_object.assert_called_once()
        call_kwargs = client._client.put_object.call_args.kwargs
        assert call_kwargs["bucket_name"] == "test-bucket"
        assert call_kwargs["object_name"] == "path/to/file.txt"
        assert call_kwargs["length"] == len(data)
        assert result == "test-bucket/path/to/file.txt"

    def test_upload_bytes_raises_storage_error_on_failure(self, client):
        """Test upload_bytes raises StorageError on S3Error."""
        client._client.put_object.side_effect = S3Error(
            code="Error",
            message="Upload error",
            resource="object",
            request_id="123",
            host_id="host",
            response=None,
        )

        with pytest.raises(StorageError, match="Failed to upload bytes"):
            client.upload_bytes("bucket", "object", b"data")


class TestMinIOClientDownload:
    """Tests for download operations."""

    @pytest.fixture
    def client(self):
        with patch("stt.core.storage.minio_client.Minio") as mock_minio:
            mock_instance = MagicMock()
            mock_minio.return_value = mock_instance
            client = MinIOClient("localhost", "access", "secret")
            return client

    def test_download_file_success(self, client):
        """Test successful file download."""
        client.download_file(
            bucket_name="test-bucket",
            object_name="path/to/file.wav",
            file_path="/local/file.wav",
        )

        client._client.fget_object.assert_called_once_with(
            bucket_name="test-bucket",
            object_name="path/to/file.wav",
            file_path="/local/file.wav",
        )

    def test_download_file_raises_storage_error_on_failure(self, client):
        """Test download_file raises StorageError on S3Error."""
        client._client.fget_object.side_effect = S3Error(
            code="Error",
            message="Download error",
            resource="object",
            request_id="123",
            host_id="host",
            response=None,
        )

        with pytest.raises(StorageError, match="Failed to download file"):
            client.download_file("bucket", "object", "/path")

    def test_download_bytes_success(self, client):
        """Test successful bytes download."""
        expected_data = b"test content"
        mock_response = MagicMock()
        mock_response.read.return_value = expected_data
        client._client.get_object.return_value = mock_response

        result = client.download_bytes("test-bucket", "path/to/file.txt")

        assert result == expected_data
        mock_response.close.assert_called_once()
        mock_response.release_conn.assert_called_once()

    def test_download_bytes_raises_storage_error_on_failure(self, client):
        """Test download_bytes raises StorageError on S3Error."""
        client._client.get_object.side_effect = S3Error(
            code="Error",
            message="Download error",
            resource="object",
            request_id="123",
            host_id="host",
            response=None,
        )

        with pytest.raises(StorageError, match="Failed to download bytes"):
            client.download_bytes("bucket", "object")


class TestMinIOClientDelete:
    """Tests for delete operations."""

    @pytest.fixture
    def client(self):
        with patch("stt.core.storage.minio_client.Minio") as mock_minio:
            mock_instance = MagicMock()
            mock_minio.return_value = mock_instance
            client = MinIOClient("localhost", "access", "secret")
            return client

    def test_delete_object_success(self, client):
        """Test successful object deletion."""
        client.delete_object("test-bucket", "path/to/file.txt")

        client._client.remove_object.assert_called_once_with("test-bucket", "path/to/file.txt")

    def test_delete_object_raises_storage_error_on_failure(self, client):
        """Test delete_object raises StorageError on S3Error."""
        client._client.remove_object.side_effect = S3Error(
            code="Error",
            message="Delete error",
            resource="object",
            request_id="123",
            host_id="host",
            response=None,
        )

        with pytest.raises(StorageError, match="Failed to delete object"):
            client.delete_object("bucket", "object")


class TestMinIOClientUtilities:
    """Tests for utility methods."""

    @pytest.fixture
    def client(self):
        with patch("stt.core.storage.minio_client.Minio") as mock_minio:
            mock_instance = MagicMock()
            mock_minio.return_value = mock_instance
            client = MinIOClient("localhost", "access", "secret")
            return client

    def test_object_exists_true(self, client):
        """Test object_exists returns True when object exists."""
        client._client.stat_object.return_value = MagicMock()

        result = client.object_exists("bucket", "object")

        assert result is True

    def test_object_exists_false(self, client):
        """Test object_exists returns False when object doesn't exist."""
        client._client.stat_object.side_effect = S3Error(
            code="NoSuchKey",
            message="Not found",
            resource="object",
            request_id="123",
            host_id="host",
            response=None,
        )

        result = client.object_exists("bucket", "object")

        assert result is False

    def test_get_object_info_success(self, client):
        """Test get_object_info returns metadata."""
        mock_stat = MagicMock()
        mock_stat.size = 1024
        mock_stat.etag = "abc123"
        mock_stat.content_type = "text/plain"
        mock_stat.last_modified = "2024-01-01T00:00:00"
        client._client.stat_object.return_value = mock_stat

        result = client.get_object_info("bucket", "object")

        assert result["size"] == 1024
        assert result["etag"] == "abc123"
        assert result["content_type"] == "text/plain"

    def test_get_object_info_raises_storage_error_on_failure(self, client):
        """Test get_object_info raises StorageError on S3Error."""
        client._client.stat_object.side_effect = S3Error(
            code="Error",
            message="Stat error",
            resource="object",
            request_id="123",
            host_id="host",
            response=None,
        )

        with pytest.raises(StorageError, match="Failed to get object info"):
            client.get_object_info("bucket", "object")

    def test_health_check_success(self, client):
        """Test health_check returns True when MinIO is healthy."""
        client._client.list_buckets.return_value = []

        result = client.health_check()

        assert result is True

    def test_health_check_failure(self, client):
        """Test health_check returns False when MinIO is unhealthy."""
        client._client.list_buckets.side_effect = Exception("Connection error")

        result = client.health_check()

        assert result is False


class TestMinIOClientGlobalFunctions:
    """Tests for global functions (initialize, close, get)."""

    @pytest.mark.asyncio
    async def test_initialize_minio(self):
        """Test initialize_minio creates client and ensures buckets."""
        import stt.core.storage.minio_client as module

        module._client = None

        mock_settings = MagicMock()
        mock_settings.minio_endpoint = "localhost:9000"
        mock_settings.minio_access_key = SecretStr("access")
        mock_settings.minio_secret_key = SecretStr("secret")
        mock_settings.minio_secure = False
        mock_settings.minio_audio_bucket = "audio"
        mock_settings.minio_chunk_bucket = "chunks"

        with (
            patch("stt.core.storage.minio_client.settings", mock_settings),
            patch("stt.core.storage.minio_client.Minio") as mock_minio,
        ):

            mock_instance = MagicMock()
            mock_instance.bucket_exists.return_value = True
            mock_minio.return_value = mock_instance

            await initialize_minio()

            assert module._client is not None

    @pytest.mark.asyncio
    async def test_close_minio(self):
        """Test close_minio resets client."""
        import stt.core.storage.minio_client as module

        module._client = MagicMock()

        await close_minio()

        assert module._client is None

    def test_get_minio_client_success(self):
        """Test get_minio_client returns client when initialized."""
        import stt.core.storage.minio_client as module

        mock_client = MagicMock()
        module._client = mock_client

        result = get_minio_client()

        assert result is mock_client

    def test_get_minio_client_raises_if_not_initialized(self):
        """Test get_minio_client raises if not initialized."""
        import stt.core.storage.minio_client as module

        module._client = None

        with pytest.raises(RuntimeError, match="MinIO not initialized"):
            get_minio_client()
