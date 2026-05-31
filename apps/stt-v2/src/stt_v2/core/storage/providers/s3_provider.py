"""S3 / MinIO blob-storage provider.

Backs both the ``minio`` and ``aws_s3`` provider types from the per-tenant
storage descriptor.  Uses the synchronous ``minio.Minio`` SDK (already a hard
dependency of this service) which speaks the S3 protocol against MinIO, real
AWS S3, and other S3-compatible stores.
"""

from __future__ import annotations

import io

import minio
import structlog

from .base import BlobStorageProvider

logger = structlog.get_logger(__name__)


class S3BlobStorageProvider(BlobStorageProvider):
    """``BlobStorageProvider`` backed by the ``minio`` S3 SDK.

    Args:
        endpoint: Host (and optional port) WITHOUT a scheme, e.g.
            ``"minio.example.com:9000"`` or ``"s3.us-east-1.amazonaws.com"``.
        access_key: Access key id.
        secret_key: Secret access key.
        secure: Whether to use TLS (``https``).
        region: Optional region (required for some AWS operations).
    """

    def __init__(
        self,
        endpoint: str,
        access_key: str,
        secret_key: str,
        secure: bool = True,
        region: str | None = None,
    ) -> None:
        self._client = minio.Minio(
            endpoint=endpoint,
            access_key=access_key or None,
            secret_key=secret_key or None,
            secure=secure,
            region=region,
        )

    def ensure_bucket(self, bucket: str) -> None:
        if not self._client.bucket_exists(bucket):
            self._client.make_bucket(bucket)
            logger.info("Created S3 bucket", bucket=bucket)

    def put_bytes(
        self,
        bucket: str,
        key: str,
        data: bytes,
        content_type: str | None = None,
    ) -> None:
        self._client.put_object(
            bucket,
            key,
            io.BytesIO(data),
            len(data),
            content_type=content_type or "application/octet-stream",
        )

    def get_bytes(self, bucket: str, key: str) -> bytes:
        response = self._client.get_object(bucket, key)
        try:
            return response.read()
        finally:
            response.close()
            response.release_conn()

    def object_exists(self, bucket: str, key: str) -> bool:
        try:
            self._client.stat_object(bucket, key)
            return True
        except Exception:
            return False
