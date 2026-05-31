"""Abstract base class for pluggable blob-storage providers.

Defines the minimal synchronous surface that :class:`BlobService` needs in
order to read/write objects against an arbitrary object store (S3/MinIO or
Azure Blob).  Implementations wrap a vendor SDK and are intentionally simple:
``BlobService`` is responsible for offloading these (blocking) calls to a
thread-pool executor so the event loop is never blocked.
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class BlobStorageProvider(ABC):
    """Provider-agnostic object-storage surface used by ``BlobService``.

    A *bucket* maps to an S3 bucket or an Azure container; a *key* maps to an
    S3 object name or an Azure blob name.  All methods are synchronous and may
    perform blocking network I/O.
    """

    @abstractmethod
    def put_bytes(
        self,
        bucket: str,
        key: str,
        data: bytes,
        content_type: str | None = None,
    ) -> None:
        """Upload ``data`` to ``bucket``/``key`` with an optional content type."""

    @abstractmethod
    def get_bytes(self, bucket: str, key: str) -> bytes:
        """Download and return the bytes stored at ``bucket``/``key``."""

    @abstractmethod
    def ensure_bucket(self, bucket: str) -> None:
        """Create ``bucket`` if it does not already exist (idempotent)."""

    @abstractmethod
    def object_exists(self, bucket: str, key: str) -> bool:
        """Return ``True`` if an object exists at ``bucket``/``key``."""
