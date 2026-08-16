"""`tei-embed` (HuggingFace text-embeddings-inference) embedding provider.

Targets TEI's native `POST /embed` REST contract (`{"inputs": [...]}` →
`[[float, ...], ...]`) rather than the OpenAI-compatible `/v1/embeddings`
route TEI only added in 1.2+ — see `core/config.py::TeiEmbedConfig` for why.
"""

from __future__ import annotations

import httpx
import structlog

from text.core.config import TeiEmbedConfig
from text.models.provider import ModelInfo, ProviderInfo

logger = structlog.get_logger(__name__)

_ENGINE = "tei-embed"


class TeiEmbedProvider:
    """`tei-embed` provider over the native ``/embed`` endpoint."""

    def __init__(self, config: TeiEmbedConfig, http_client: httpx.AsyncClient) -> None:
        self._config = config
        self._http = http_client
        self._base_url = config.base_url.rstrip("/")

    async def embed(self, texts: list[str]) -> list[list[float]]:
        resp = await self._http.post(f"{self._base_url}/embed", json={"inputs": texts})
        resp.raise_for_status()
        return resp.json()  # type: ignore[no-any-return]

    async def health_check(self) -> bool:
        try:
            resp = await self._http.get(f"{self._base_url}/health")
            return resp.status_code == 200
        except (httpx.HTTPError, httpx.TimeoutException, ConnectionError, OSError) as exc:
            logger.warning("health_check.failed", provider=_ENGINE, error=str(exc))
            return False
        except Exception as exc:
            logger.error("health_check.unexpected_error", provider=_ENGINE, error=str(exc))
            return False

    async def get_info(self) -> ProviderInfo:
        status = "unavailable"
        try:
            resp = await self._http.get(f"{self._base_url}/health")
            if resp.status_code == 200:
                status = "available"
        except (httpx.HTTPError, httpx.TimeoutException, ConnectionError, OSError) as exc:
            logger.warning("get_info.failed", provider=_ENGINE, error=str(exc))
        except Exception as exc:
            logger.error("get_info.unexpected_error", provider=_ENGINE, error=str(exc))
        return ProviderInfo(
            name=_ENGINE,
            display_name="TEI Embeddings",
            status=status,
            default_model=self._config.default_model,
            models=(
                [ModelInfo(name=self._config.default_model, supports_streaming=False)]
                if self._config.default_model
                else []
            ),
            supports_streaming=False,
            supports_vision=False,
        )
