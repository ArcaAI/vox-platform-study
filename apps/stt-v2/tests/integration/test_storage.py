"""Integration tests for MinIO storage operations."""

import io
import pytest
from minio import Minio


@pytest.mark.integration
class TestMinIOStorage:
    """Test MinIO storage operations."""

    def test_upload_and_download_file(self, minio_client: Minio):
        """Test uploading and downloading a file."""
        bucket = "hope-audio"
        object_name = "test/audio.wav"
        test_data = b"test audio content"

        # Upload
        minio_client.put_object(
            bucket,
            object_name,
            io.BytesIO(test_data),
            len(test_data),
            content_type="audio/wav",
        )

        # Download
        response = minio_client.get_object(bucket, object_name)
        downloaded_data = response.read()
        response.close()
        response.release_conn()

        assert downloaded_data == test_data

    def test_object_exists(self, minio_client: Minio):
        """Test checking if object exists."""
        bucket = "hope-audio"
        object_name = "test/exists.txt"
        test_data = b"exists"

        # Upload
        minio_client.put_object(
            bucket,
            object_name,
            io.BytesIO(test_data),
            len(test_data),
        )

        # Check exists
        stat = minio_client.stat_object(bucket, object_name)
        assert stat is not None
        assert stat.size == len(test_data)

    def test_object_not_exists(self, minio_client: Minio):
        """Test checking non-existent object."""
        bucket = "hope-audio"
        object_name = "test/nonexistent.txt"

        from minio.error import S3Error

        with pytest.raises(S3Error):
            minio_client.stat_object(bucket, object_name)

    def test_delete_object(self, minio_client: Minio):
        """Test deleting an object."""
        bucket = "hope-audio"
        object_name = "test/delete-me.txt"
        test_data = b"delete me"

        # Upload
        minio_client.put_object(
            bucket,
            object_name,
            io.BytesIO(test_data),
            len(test_data),
        )

        # Delete
        minio_client.remove_object(bucket, object_name)

        # Verify deleted
        from minio.error import S3Error

        with pytest.raises(S3Error):
            minio_client.stat_object(bucket, object_name)

    def test_list_objects(self, minio_client: Minio):
        """Test listing objects."""
        bucket = "hope-audio"
        prefix = "test/list/"

        # Upload multiple files
        for i in range(3):
            minio_client.put_object(
                bucket,
                f"{prefix}file{i}.txt",
                io.BytesIO(f"content{i}".encode()),
                len(f"content{i}"),
            )

        # List
        objects = list(minio_client.list_objects(bucket, prefix=prefix))

        assert len(objects) == 3
        names = [obj.object_name for obj in objects]
        assert f"{prefix}file0.txt" in names
        assert f"{prefix}file1.txt" in names
        assert f"{prefix}file2.txt" in names

    def test_presigned_url(self, minio_client: Minio):
        """Test generating presigned URL."""
        from datetime import timedelta

        bucket = "hope-audio"
        object_name = "test/presigned.txt"
        test_data = b"presigned content"

        # Upload
        minio_client.put_object(
            bucket,
            object_name,
            io.BytesIO(test_data),
            len(test_data),
        )

        # Get presigned URL
        url = minio_client.presigned_get_object(
            bucket,
            object_name,
            expires=timedelta(hours=1),
        )

        assert url is not None
        assert bucket in url
        assert object_name in url


@pytest.mark.integration
class TestChunkStorage:
    """Test streaming chunk storage."""

    def test_store_and_retrieve_chunks(self, minio_client: Minio):
        """Test storing multiple chunks."""
        bucket = "hope-audio-chunks"
        session_id = "test-session-123"

        # Store chunks
        for i in range(5):
            chunk_data = f"chunk data {i}".encode()
            minio_client.put_object(
                bucket,
                f"sessions/{session_id}/chunk_{i:06d}.wav",
                io.BytesIO(chunk_data),
                len(chunk_data),
            )

        # List chunks
        prefix = f"sessions/{session_id}/"
        objects = list(minio_client.list_objects(bucket, prefix=prefix))

        assert len(objects) == 5

    def test_delete_session_chunks(self, minio_client: Minio):
        """Test deleting all chunks for a session."""
        bucket = "hope-audio-chunks"
        session_id = "test-session-delete"

        # Store chunks
        for i in range(3):
            chunk_data = f"chunk {i}".encode()
            minio_client.put_object(
                bucket,
                f"sessions/{session_id}/chunk_{i:06d}.wav",
                io.BytesIO(chunk_data),
                len(chunk_data),
            )

        # Delete all
        prefix = f"sessions/{session_id}/"
        objects = minio_client.list_objects(bucket, prefix=prefix, recursive=True)
        for obj in objects:
            minio_client.remove_object(bucket, obj.object_name)

        # Verify empty
        remaining = list(minio_client.list_objects(bucket, prefix=prefix))
        assert len(remaining) == 0
