"""Azure Blob Storage provider.

Backs the ``azure_blob`` provider type from the per-tenant storage descriptor.
Maps the provider-agnostic *bucket* -> Azure *container* and *key* -> *blob*.

The ``azure.storage.blob`` SDK is imported lazily so that (a) importing the
``providers`` package does not hard-require the Azure SDK, and (b) unit tests
can patch ``azure.storage.blob.BlobServiceClient`` directly.
"""

from __future__ import annotations

import structlog

from .base import BlobStorageProvider

logger = structlog.get_logger(__name__)


class AzureBlobStorageProvider(BlobStorageProvider):
    """``BlobStorageProvider`` backed by ``azure.storage.blob.BlobServiceClient``.

    Construction prefers a full ``connection_string``; otherwise an account
    URL is built from ``account_name`` + ``account_key`` + ``endpoint_suffix``.

    Args:
        connection_string: Full Azure connection string (preferred).
        account_name: Storage account name (used when no connection string).
        account_key: Shared key credential (used with ``account_name``).
        endpoint_suffix: Storage endpoint suffix (default ``core.windows.net``).
    """

    def __init__(
        self,
        connection_string: str | None = None,
        account_name: str | None = None,
        account_key: str | None = None,
        endpoint_suffix: str = "core.windows.net",
    ) -> None:
        from azure.storage.blob import BlobServiceClient

        if connection_string:
            self._service = BlobServiceClient.from_connection_string(connection_string)
        elif account_name and account_key:
            account_url = f"https://{account_name}.blob.{endpoint_suffix}"
            self._service = BlobServiceClient(account_url=account_url, credential=account_key)
        else:
            raise ValueError(
                "Azure storage provider requires either 'connection_string' or "
                "both 'account_name' and 'account_key'."
            )

    def ensure_bucket(self, bucket: str) -> None:
        from azure.core.exceptions import ResourceExistsError

        container = self._service.get_container_client(bucket)
        try:
            container.create_container()
            logger.info("Created Azure container", container=bucket)
        except ResourceExistsError:
            pass

    def put_bytes(
        self,
        bucket: str,
        key: str,
        data: bytes,
        content_type: str | None = None,
    ) -> None:
        from azure.storage.blob import ContentSettings

        blob = self._service.get_blob_client(container=bucket, blob=key)
        content_settings = ContentSettings(content_type=content_type) if content_type else None
        blob.upload_blob(data, overwrite=True, content_settings=content_settings)

    def get_bytes(self, bucket: str, key: str) -> bytes:
        blob = self._service.get_blob_client(container=bucket, blob=key)
        downloader = blob.download_blob()
        return downloader.readall()

    def object_exists(self, bucket: str, key: str) -> bool:
        blob = self._service.get_blob_client(container=bucket, blob=key)
        try:
            return bool(blob.exists())
        except Exception:
            return False
