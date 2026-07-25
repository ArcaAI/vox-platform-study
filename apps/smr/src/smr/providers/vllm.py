"""vLLM LLM provider — first-class engine over the OpenAI wire.

vLLM speaks the OpenAI chat-completions wire, so ``VllmProvider`` composes the
same async client as ``OpenAICompatProvider`` but carries a distinct engine
identity (``provider="vllm"`` in AD-1 stats / spans / ``get_info``) and adds the
production-serving affordances the generic compat provider lacks:

* ``stream_options.include_usage`` is always on (inherited) so streaming carries
  the final ``usage`` chunk.
* Structured outputs default to vLLM >= 0.8's native
  ``response_format={"type":"json_schema",...}``; the ``use_guided_json`` toggle
  routes older builds through ``extra_body.guided_json`` instead.
* ``health_check()`` hits the server-root ``/health`` (not ``/v1/models``).
* An OPTIONAL ``scrape_cache_hit_rate()`` reads vLLM's ``/metrics`` prefix-cache
  counters and re-exports them as ``SMR_ENGINE_CACHE_HIT_RATE{engine="vllm"}``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import httpx
import structlog

from smr.core.config import VllmConfig
from smr.core.metrics import SMR_ENGINE_CACHE_HIT_RATE
from smr.models.requests import GenerateRequest
from smr.providers.openai_compat import OpenAICompatProvider

if TYPE_CHECKING:
    pass

logger = structlog.get_logger(__name__)

_ENGINE = "vllm"


class VllmProvider(OpenAICompatProvider):
    """vLLM self-hosted provider (OpenAI-wire, engine-native identity)."""

    def __init__(self, config: VllmConfig, http_client: httpx.AsyncClient | None = None) -> None:
        super().__init__(config, provider_name=_ENGINE, display_name="vLLM")
        self._vllm_config = config
        self._http = http_client
        # ``/health`` and ``/metrics`` live at the server ROOT, not under ``/v1``.
        self._root_url = config.base_url.rstrip("/")
        if self._root_url.endswith("/v1"):
            self._root_url = self._root_url[: -len("/v1")]
        self._metrics_url = config.metrics_url or f"{self._root_url}/metrics"

    def _apply_response_format(self, kwargs: dict[str, Any], request: GenerateRequest) -> None:
        # ``use_guided_json`` fallback (vLLM < 0.8): send the raw JSON schema via
        # ``extra_body.guided_json`` instead of the native ``response_format``.
        if (
            self._vllm_config.use_guided_json
            and request.response_format is not None
            and request.response_format.type == "json_schema"
            and request.response_format.json_schema
        ):
            extra_body = kwargs.setdefault("extra_body", {})
            extra_body["guided_json"] = request.response_format.json_schema
            return
        super()._apply_response_format(kwargs, request)

    async def health_check(self) -> bool:
        url = f"{self._root_url}/health"
        try:
            if self._http is not None:
                resp = await self._http.get(url)
                return resp.status_code == 200
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url)
                return resp.status_code == 200
        except (httpx.HTTPError, httpx.TimeoutException, ConnectionError, OSError) as exc:
            logger.warning("health_check.failed", provider=_ENGINE, error=str(exc))
            return False
        except Exception as exc:
            logger.error("health_check.unexpected_error", provider=_ENGINE, error=str(exc))
            return False

    async def scrape_cache_hit_rate(self) -> float | None:
        """Best-effort: scrape vLLM ``/metrics`` and re-export the prefix-cache
        hit rate as ``SMR_ENGINE_CACHE_HIT_RATE{engine="vllm"}``.

        Never raises — a metrics-scrape failure must not affect generation.
        Returns the ratio (0.0-1.0) on success, else ``None``.
        """
        try:
            if self._http is not None:
                resp = await self._http.get(self._metrics_url)
                text = resp.text
            else:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.get(self._metrics_url)
                    text = resp.text
        except (httpx.HTTPError, httpx.TimeoutException, ConnectionError, OSError) as exc:
            logger.warning("scrape_cache_hit_rate.failed", provider=_ENGINE, error=str(exc))
            return None
        except Exception as exc:
            logger.error("scrape_cache_hit_rate.unexpected_error", provider=_ENGINE, error=str(exc))
            return None

        rate = _parse_cache_hit_rate(text)
        if rate is not None:
            SMR_ENGINE_CACHE_HIT_RATE.labels(engine=_ENGINE).set(rate)
        return rate


def _parse_cache_hit_rate(metrics_text: str) -> float | None:
    """Compute the prefix-cache hit rate from vLLM Prometheus exposition text.

    Prefers the two prefix-cache counters (hits / queries); if the deployment
    exposes a direct hit-rate gauge (``vllm:gpu_prefix_cache_hit_rate``) that is
    used instead. Returns ``None`` when neither is present or the denominator is
    zero (no invented number).
    """
    hits: float | None = None
    queries: float | None = None
    direct: float | None = None

    for raw in metrics_text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        # ``metric_name{labels} value`` — split on the LAST space for the value.
        name_part, _, value_part = line.rpartition(" ")
        if not name_part:
            continue
        metric = name_part.split("{", 1)[0]
        try:
            value = float(value_part)
        except ValueError:
            continue
        if metric in ("vllm:prefix_cache_hits_total", "vllm:gpu_prefix_cache_hits_total"):
            hits = (hits or 0.0) + value
        elif metric in ("vllm:prefix_cache_queries_total", "vllm:gpu_prefix_cache_queries_total"):
            queries = (queries or 0.0) + value
        elif metric == "vllm:gpu_prefix_cache_hit_rate":
            direct = value

    if hits is not None and queries:
        return round(hits / queries, 4)
    if direct is not None:
        return round(direct, 4)
    return None
