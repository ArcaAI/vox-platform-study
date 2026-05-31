"""Pluggable per-tenant blob-storage providers (TASK-318 W3-C).

Exposes a provider-agnostic surface (:class:`BlobStorageProvider`) with S3/MinIO
and Azure Blob implementations, plus a factory that maps a storage descriptor
to a concrete provider.
"""

from .azure_provider import AzureBlobStorageProvider
from .base import BlobStorageProvider
from .factory import build_provider, clear_provider_cache, default_provider
from .s3_provider import S3BlobStorageProvider

__all__ = [
    "BlobStorageProvider",
    "S3BlobStorageProvider",
    "AzureBlobStorageProvider",
    "build_provider",
    "default_provider",
    "clear_provider_cache",
]
