"""MinIO client wrapper for object storage operations."""

from io import BytesIO
from typing import Any

import structlog
import urllib3
from minio import Minio
from minio.error import S3Error

from stt_v2.core.config.settings import get_settings
from stt_v2.core.exceptions import StorageError

logger = structlog.get_logger(__name__)
settings = get_settings()

# Global client instance
_client: "MinIOClient | None" = None


class MinIOClient:
    """Wrapper for MinIO operations."""

    def __init__(
        self,
        endpoint: str,
        access_key: str,
        secret_key: str,
        secure: bool = False,
        cert_check: bool = True,
    ) -> None:
        client_kwargs: dict[str, Any] = {
            "endpoint": endpoint,
            "access_key": access_key,
            "secret_key": secret_key,
            "secure": secure,
        }
        if secure and not cert_check:
            client_kwargs["http_client"] = urllib3.PoolManager(cert_reqs="CERT_NONE")

        self._client = Minio(**client_kwargs)

    @property
    def client(self) -> Minio:
        """Expose the underlying ``minio.Minio`` instance.

        ``BlobService`` (and potentially other consumers) accesses the raw
        client via ``get_minio_client().client``.  This property provides
        a clean public API instead of reaching into ``_client`` directly.
        """
        return self._client

    def ensure_bucket(self, bucket_name: str) -> None:
        """Ensure a bucket exists, create if not."""
        try:
            if not self._client.bucket_exists(bucket_name):
                self._client.make_bucket(bucket_name)
                logger.info("Created bucket", bucket=bucket_name)
        except S3Error as e:
            raise StorageError(f"Failed to ensure bucket: {e}") from e

    def upload_file(
        self,
        bucket_name: str,
        object_name: str,
        file_path: str,
        content_type: str = "application/octet-stream",
    ) -> str:
        """Upload a file to MinIO."""
        try:
            self._client.fput_object(
                bucket_name=bucket_name,
                object_name=object_name,
                file_path=file_path,
                content_type=content_type,
            )
            logger.info("Uploaded file", bucket=bucket_name, object=object_name)
            return f"{bucket_name}/{object_name}"
        except S3Error as e:
            raise StorageError(f"Failed to upload file: {e}") from e

    def upload_bytes(
        self,
        bucket_name: str,
        object_name: str,
        data: bytes,
        content_type: str = "application/octet-stream",
    ) -> str:
        """Upload bytes to MinIO."""
        try:
            self._client.put_object(
                bucket_name=bucket_name,
                object_name=object_name,
                data=BytesIO(data),
                length=len(data),
                content_type=content_type,
            )
            logger.info("Uploaded bytes", bucket=bucket_name, object=object_name, size=len(data))
            return f"{bucket_name}/{object_name}"
        except S3Error as e:
            raise StorageError(f"Failed to upload bytes: {e}") from e

    def download_file(self, bucket_name: str, object_name: str, file_path: str) -> None:
        """Download a file from MinIO."""
        try:
            self._client.fget_object(
                bucket_name=bucket_name,
                object_name=object_name,
                file_path=file_path,
            )
            logger.info("Downloaded file", bucket=bucket_name, object=object_name)
        except S3Error as e:
            raise StorageError(f"Failed to download file: {e}") from e

    def download_bytes(self, bucket_name: str, object_name: str) -> bytes:
        """Download an object as bytes."""
        try:
            response = self._client.get_object(bucket_name, object_name)
            data = response.read()
            response.close()
            response.release_conn()
            logger.info("Downloaded bytes", bucket=bucket_name, object=object_name, size=len(data))
            return data
        except S3Error as e:
            raise StorageError(f"Failed to download bytes: {e}") from e

    def delete_object(self, bucket_name: str, object_name: str) -> None:
        """Delete an object from MinIO."""
        try:
            self._client.remove_object(bucket_name, object_name)
            logger.info("Deleted object", bucket=bucket_name, object=object_name)
        except S3Error as e:
            raise StorageError(f"Failed to delete object: {e}") from e

    def object_exists(self, bucket_name: str, object_name: str) -> bool:
        """Check if an object exists."""
        try:
            self._client.stat_object(bucket_name, object_name)
            return True
        except S3Error:
            return False

    def get_object_info(self, bucket_name: str, object_name: str) -> dict[str, Any]:
        """Get object metadata."""
        try:
            stat = self._client.stat_object(bucket_name, object_name)
            return {
                "size": stat.size,
                "etag": stat.etag,
                "content_type": stat.content_type,
                "last_modified": stat.last_modified,
            }
        except S3Error as e:
            raise StorageError(f"Failed to get object info: {e}") from e

    def health_check(self) -> bool:
        """Check if MinIO is reachable."""
        try:
            self._client.list_buckets()
            return True
        except Exception:
            return False


async def initialize_minio() -> None:
    """Initialize the MinIO client."""
    global _client

    logger.info("Initializing MinIO client", endpoint=settings.minio_endpoint)

    _client = MinIOClient(
        endpoint=settings.minio_endpoint,
        access_key=settings.minio_access_key,
        secret_key=settings.minio_secret_key,
        secure=settings.minio_secure,
        cert_check=settings.minio_cert_check,
    )

    # Ensure buckets exist
    _client.ensure_bucket(settings.minio_audio_bucket)
    _client.ensure_bucket(settings.minio_chunk_bucket)

    logger.info("MinIO client initialized successfully")


async def close_minio() -> None:
    """Close the MinIO client."""
    global _client
    _client = None
    logger.info("MinIO client closed")


def get_minio_client() -> MinIOClient:
    """Get the MinIO client instance."""
    if _client is None:
        raise RuntimeError("MinIO not initialized. Call initialize_minio() first.")
    return _client
