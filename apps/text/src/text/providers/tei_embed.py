"""`tei-embed` (HuggingFace text-embeddings-inference) embedding provider.

Targets TEI's native `POST /embed` REST contract (`{"inputs": [...]}` →
`[[float, ...], ...]`) rather than the OpenAI-compatible `/v1/embeddings`
route TEI only added in 1.2+ — see `core/config.py::TeiEmbedConfig` for why.
"""

from __future__ import annotations

import httpx
import structlog

from text.core.connection import require_base_url
from text.models.provider import ProviderInfo

logger = structlog.get_logger(__name__)

_ENGINE = "tei-embed"


class TeiEmbedProvider:
    """`tei-embed` provider over the native ``/embed`` endpoint."""

    def __init__(self, http_client: httpx.AsyncClient) -> None:
        """No configuration. The TEI endpoint arrives with the embedding request
        as a gateway-resolved connection (`core/connection.py`), the same channel
        every other engine uses."""
        self._http = http_client
        self._last_base_url: str | None = None

    def _probe_url(self) -> str | None:
        """The engine this process last talked to, or ``None`` — probes only."""
        return self._last_base_url

    async def embed(self, texts: list[str], request: object) -> list[list[float]]:
        """Embed ``texts`` against the connection resolved for ``request``.

        ``request`` is required rather than optional so a caller cannot silently
        fall back to a process-wide endpoint: there is none. The out-of-process
        batch worker passes the envelope it was submitted with, so the job runs
        against the SAME engine the submitting request resolved.
        """
        base_url = require_base_url(request, provider=_ENGINE)
        self._last_base_url = base_url
        resp = await self._http.post(f"{base_url}/embed", json={"inputs": texts})
        resp.raise_for_status()
        return resp.json()  # type: ignore[no-any-return]

    async def health_check(self) -> bool:
        """Probe the last-observed endpoint; True when none has been observed
        yet ("no negative evidence" — see `OllamaProvider.health_check`)."""
        probe_url = self._probe_url()
        if probe_url is None:
            return True
        try:
            resp = await self._http.get(f"{probe_url}/health")
            return resp.status_code == 200
        except (httpx.HTTPError, httpx.TimeoutException, ConnectionError, OSError) as exc:
            logger.warning("health_check.failed", provider=_ENGINE, error=str(exc))
            return False
        except Exception as exc:
            logger.error("health_check.unexpected_error", provider=_ENGINE, error=str(exc))
            return False

    async def get_info(self) -> ProviderInfo:
        status = "unavailable"
        probe_url = self._probe_url()
        try:
            resp = await self._http.get(f"{probe_url}/health") if probe_url else None
            if resp is not None and resp.status_code == 200:
                status = "available"
        except (httpx.HTTPError, httpx.TimeoutException, ConnectionError, OSError) as exc:
            logger.warning("get_info.failed", provider=_ENGINE, error=str(exc))
        except Exception as exc:
            logger.error("get_info.unexpected_error", provider=_ENGINE, error=str(exc))
        return ProviderInfo(
            name=_ENGINE,
            display_name="TEI Embeddings",
            status=status,
            # TEI serves exactly one model per container (`MODEL_ID`), which is a
            # property of the deployed container, not of this adapter. It comes
            # from `AiModel` on the gateway; ``TEXT_TEI_DEFAULT_MODEL`` was a
            # second, silently drifting copy of it.
            default_model="",
            models=[],
            supports_streaming=False,
            supports_vision=False,
        )
