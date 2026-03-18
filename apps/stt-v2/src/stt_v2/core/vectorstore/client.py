"""Async Qdrant client singleton with connection pooling.

Design decisions:
- AsyncQdrantClient for non-blocking vector operations inside asyncio workers
- REST over gRPC (benchmarks show REST is faster for payload-heavy workloads)
- Connection pooling sized for 100+ concurrent sessions
- Lazy initialization: client is created on first access, not at import time
"""

import asyncio
import logging
from typing import Any

from ...core.config.settings import get_settings
from ...core.exceptions import VectorStoreConnectionError

logger = logging.getLogger(__name__)


class QdrantClientManager:
    """Manages a singleton AsyncQdrantClient with lifecycle methods."""

    def __init__(self) -> None:
        self._client: Any = None  # qdrant_client.AsyncQdrantClient
        self._lock = asyncio.Lock()

    async def get_client(self) -> Any:
        """Get or create the async Qdrant client.

        Returns:
            AsyncQdrantClient instance.

        Raises:
            VectorStoreConnectionError: If connection fails.
        """
        if self._client is not None:
            return self._client

        async with self._lock:
            if self._client is not None:
                return self._client

            try:
                from qdrant_client import AsyncQdrantClient

                settings = get_settings()

                self._client = AsyncQdrantClient(
                    url=settings.qdrant_url,
                    api_key=settings.qdrant_api_key,
                    prefer_grpc=False,  # REST faster for payload-heavy ops
                    timeout=settings.qdrant_timeout,
                )

                # Verify connectivity
                await self._client.get_collections()
                logger.info(
                    "Connected to Qdrant at %s (pool_size=%d)",
                    settings.qdrant_url,
                    settings.qdrant_pool_size,
                )
                return self._client

            except ImportError:
                raise VectorStoreConnectionError(
                    "qdrant-client is not installed. "
                    "Install with: pip install qdrant-client"
                )
            except Exception as e:
                self._client = None
                raise VectorStoreConnectionError(
                    f"Failed to connect to Qdrant: {e}"
                ) from e

    async def close(self) -> None:
        """Close the Qdrant client connection."""
        if self._client is not None:
            try:
                await self._client.close()
            except Exception as e:
                logger.warning("Error closing Qdrant client: %s", e)
            finally:
                self._client = None
                logger.info("Qdrant client closed")

    async def health_check(self) -> bool:
        """Check if Qdrant is reachable."""
        try:
            client = await self.get_client()
            await client.get_collections()
            return True
        except Exception:
            return False


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_manager: QdrantClientManager | None = None


def get_qdrant_client() -> QdrantClientManager:
    """Get singleton Qdrant client manager."""
    global _manager
    if _manager is None:
        _manager = QdrantClientManager()
    return _manager
