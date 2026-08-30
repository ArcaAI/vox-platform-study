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
import urllib3

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
        cert_check: Verify the endpoint's TLS certificate. The caller passes
            the resolved ``MINIO_CERT_CHECK`` value; ``True`` here keeps the
            SDK's own default so a direct construction is never silently
            relaxed.
    """

    def __init__(
        self,
        endpoint: str,
        access_key: str,
        secret_key: str,
        secure: bool = True,
        region: str | None = None,
        cert_check: bool = True,
    ) -> None:
        client_kwargs: dict[str, object] = {
            "endpoint": endpoint,
            "access_key": access_key or None,
            "secret_key": secret_key or None,
            "secure": secure,
            "region": region,
        }
        if secure and not cert_check:
            # ⚠️ DELIBERATE, REVERSIBLE SECURITY RELAXATION (owner ruling
            # 2026-08-30, `MINIO_CERT_CHECK`): MinIO keeps TLS but its
            # certificate is not verified — the platform has no private CA to
            # chain it to and authenticates with a service-account key pair
            # instead. Taken while PHI hardening is de-prioritised; grep
            # `MINIO_CERT_CHECK` for every site to revert when a CA lands.
            # Mirrors `stt.core.storage.minio_client.MinIOClient`, which has
            # carried this escape hatch since before the ruling.
            client_kwargs["http_client"] = urllib3.PoolManager(cert_reqs="CERT_NONE")

        self._client = minio.Minio(**client_kwargs)  # type: ignore[arg-type]

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
