"""Factory + cache for per-tenant blob-storage providers.

Translates a LOCKED storage *descriptor* (snake_case dict sent by the NestJS
gateway) into a concrete :class:`BlobStorageProvider`, and caches the result
keyed by a stable fingerprint of the descriptor's identity (provider, endpoint,
account, bucket and a hashed credential fingerprint) so we don't rebuild a
vendor SDK client on every upload/download.

Descriptor shape (all snake_case)::

    {
      "provider": "minio" | "aws_s3" | "azure_blob",   # required
      "bucket": "<bucket/container>",                    # required
      # S3 / MinIO:
      "endpoint": "https://…" | null,
      "region": "us-east-1" | null,
      "force_path_style": true | null,
      "access_key_id": "…" | null,
      "secret_access_key": "…" | null,
      # Azure:
      "account_name": "…" | null,
      "endpoint_suffix": "core.windows.net" | null,
      "connection_string": "…" | null,
      "account_key": "…" | null
    }
"""

from __future__ import annotations

import hashlib
import io
import json
from typing import Any, cast

import structlog

from stt.core.config.settings import get_settings

from .azure_provider import AzureBlobStorageProvider
from .base import BlobStorageProvider
from .s3_provider import S3BlobStorageProvider

logger = structlog.get_logger(__name__)

# Cache of built providers keyed by descriptor fingerprint.
_PROVIDER_CACHE: dict[str, BlobStorageProvider] = {}

_S3_PROVIDERS = ("minio", "aws_s3")


def _credential_fingerprint(descriptor: dict[str, Any]) -> str:
    """Hash the credential material so it never appears in a cache key."""
    material = "|".join(
        descriptor.get(field) or ""
        for field in (
            "access_key_id",
            "secret_access_key",
            "account_key",
            "connection_string",
        )
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _descriptor_fingerprint(descriptor: dict[str, Any]) -> str:
    """Build a stable identity hash for a descriptor (credentials hashed)."""
    identity = {
        "provider": descriptor.get("provider"),
        "endpoint": descriptor.get("endpoint"),
        "region": descriptor.get("region"),
        "bucket": descriptor.get("bucket"),
        "account_name": descriptor.get("account_name"),
        "endpoint_suffix": descriptor.get("endpoint_suffix"),
        "cred": _credential_fingerprint(descriptor),
    }
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode("utf-8")).hexdigest()


def _parse_s3_endpoint(descriptor: dict[str, Any]) -> tuple[str, bool, str | None]:
    """Resolve (host, secure, region) for the ``minio`` SDK from a descriptor.

    - When ``endpoint`` is provided, the scheme determines ``secure`` and is
      stripped (the ``minio`` SDK wants a bare ``host[:port]``).
    - When ``endpoint`` is absent/empty (real AWS), the host is derived as
      ``s3.<region>.amazonaws.com`` with TLS enabled.
    """
    endpoint = (descriptor.get("endpoint") or "").strip()
    region = descriptor.get("region") or None

    if endpoint:
        secure = not endpoint.lower().startswith("http://")
        host = endpoint.split("://", 1)[-1].strip("/")
        return host, secure, region

    resolved_region = region or "us-east-1"
    return f"s3.{resolved_region}.amazonaws.com", True, resolved_region


def _build_s3(descriptor: dict[str, Any]) -> S3BlobStorageProvider:
    host, secure, region = _parse_s3_endpoint(descriptor)
    return S3BlobStorageProvider(
        endpoint=host,
        access_key=descriptor.get("access_key_id") or "",
        secret_key=descriptor.get("secret_access_key") or "",
        secure=secure,
        region=region,
    )


def _build_azure(descriptor: dict[str, Any]) -> AzureBlobStorageProvider:
    return AzureBlobStorageProvider(
        connection_string=descriptor.get("connection_string"),
        account_name=descriptor.get("account_name"),
        account_key=descriptor.get("account_key"),
        endpoint_suffix=descriptor.get("endpoint_suffix") or "core.windows.net",
    )


def build_provider(descriptor: dict[str, Any]) -> BlobStorageProvider:
    """Build (or return a cached) provider for a tenant storage descriptor.

    Args:
        descriptor: The snake_case storage descriptor (see module docstring).

    Raises:
        ValueError: if the descriptor is empty, missing ``provider``, or uses
            an unsupported provider type.
    """
    if not descriptor:
        raise ValueError("storage descriptor must be a non-empty dict")

    provider_type = descriptor.get("provider")
    if not provider_type:
        raise ValueError("storage descriptor missing required 'provider' field")

    cache_key = _descriptor_fingerprint(descriptor)
    cached = _PROVIDER_CACHE.get(cache_key)
    if cached is not None:
        return cached

    if provider_type in _S3_PROVIDERS:
        provider: BlobStorageProvider = _build_s3(descriptor)
    elif provider_type == "azure_blob":
        provider = _build_azure(descriptor)
    else:
        raise ValueError(f"Unsupported storage provider: {provider_type!r}")

    _PROVIDER_CACHE[cache_key] = provider
    logger.info(
        "Built storage provider",
        provider=provider_type,
        bucket=descriptor.get("bucket"),
    )
    return provider


def clear_provider_cache() -> None:
    """Clear the provider cache (primarily for tests)."""
    _PROVIDER_CACHE.clear()


class _GlobalMinioProvider(BlobStorageProvider):
    """Default provider that wraps the process-global MinIO client.

    Used by :func:`default_provider` for the no-descriptor path so existing
    behaviour (a single env-configured MinIO endpoint) is preserved.  The
    global client is looked up lazily on every call so this provider tracks
    ``initialize_minio()`` / ``close_minio()`` lifecycle changes.
    """

    @staticmethod
    def _raw():  # type: ignore[no-untyped-def]
        from stt.core.storage.minio_client import get_minio_client

        return get_minio_client().client

    def ensure_bucket(self, bucket: str) -> None:
        client = self._raw()
        if not client.bucket_exists(bucket):
            client.make_bucket(bucket)

    def put_bytes(
        self,
        bucket: str,
        key: str,
        data: bytes,
        content_type: str | None = None,
    ) -> None:
        self._raw().put_object(
            bucket,
            key,
            io.BytesIO(data),
            len(data),
            content_type=content_type or "application/octet-stream",
        )

    def get_bytes(self, bucket: str, key: str) -> bytes:
        response = self._raw().get_object(bucket, key)
        try:
            return cast(bytes, response.read())
        finally:
            response.close()
            response.release_conn()

    def object_exists(self, bucket: str, key: str) -> bool:
        try:
            self._raw().stat_object(bucket, key)
            return True
        except Exception:
            return False


def default_provider() -> BlobStorageProvider:
    """Provider for the platform default (no per-tenant descriptor).

    Wraps the global MinIO client unless ``STORAGE_PROVIDER=azure_blob``, in
    which case an Azure provider is built from the global ``azure_storage_*``
    settings.
    """
    settings = get_settings()
    if getattr(settings, "storage_provider", "minio") == "azure_blob":
        return _build_azure(
            {
                "connection_string": settings.azure_storage_connection_string or None,
                "account_name": settings.azure_storage_account or None,
                "account_key": settings.azure_storage_account_key or None,
                "endpoint_suffix": settings.azure_storage_endpoint_suffix or "core.windows.net",
            }
        )
    return _GlobalMinioProvider()
