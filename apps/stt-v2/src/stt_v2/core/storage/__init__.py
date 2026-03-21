"""Storage module (MinIO)."""

from stt_v2.core.storage.minio_client import (
    MinIOClient,
    close_minio,
    get_minio_client,
    initialize_minio,
)

__all__ = [
    "MinIOClient",
    "initialize_minio",
    "close_minio",
    "get_minio_client",
]
