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
  counters and re-exports them as ``TEXT_ENGINE_CACHE_HIT_RATE{engine="vllm"}``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import httpx
import structlog

from text.core.metrics import TEXT_ENGINE_CACHE_HIT_RATE
from text.core.reasoning import (
    REASON_EFFORT_NOT_EXPRESSIBLE,
    ReasoningSupport,
    posture_to_render,
    record_unenforceable,
)
from text.models.requests import GenerateRequest
from text.providers.openai_compat import OpenAICompatProvider

if TYPE_CHECKING:
    pass

logger = structlog.get_logger(__name__)

_ENGINE = "vllm"


class VllmProvider(OpenAICompatProvider):
    """vLLM self-hosted provider (OpenAI-wire, engine-native identity)."""

    # TASK-970 — vLLM's reasoning switch is NOT the OpenAI effort word. For the
    # Qwen3-class checkpoints this deployment serves (`vllm/vllm-openai:v0.11.0`),
    # thinking is turned off by re-rendering the chat template:
    # `extra_body={"chat_template_kwargs": {"enable_thinking": False}}`. There is
    # no effort dial on that toggle, so a NAMED effort is recorded as
    # unenforceable while the on/off half is still honoured.
    reasoning_support = ReasoningSupport.NATIVE_OFF
    reasoning_parameter = "chat_template_kwargs.enable_thinking"
    reasoning_effort_parameter = None

    def __init__(self, http_client: httpx.AsyncClient | None = None) -> None:
        """No configuration — the engine endpoint arrives per request, exactly as
        for the base OpenAI-compatible adapter."""
        super().__init__(provider_name=_ENGINE, display_name="vLLM")
        self._http = http_client
        # Structured-output routing. vLLM >= 0.8 accepts the native OpenAI
        # ``response_format={"type":"json_schema",...}``; older builds only
        # support ``extra_body.guided_json``. This is a property of the ENGINE
        # BUILD, so it rides the connection's `extra` rather than a process-wide
        # ``TEXT_VLLM_USE_GUIDED_JSON`` that would apply one deployment's vLLM
        # version to every other.
        self._use_guided_json = False

    def _metrics_url(self) -> str | None:
        """Prometheus scrape target for the prefix-cache hit rate.

        Derived from the observed endpoint rather than configured separately: a
        ``TEXT_VLLM_METRICS_URL`` that disagrees with ``TEXT_VLLM_BASE_URL`` can
        only be wrong, and the field was already documented as "empty ⇒ derived".
        """
        root = self._server_root()
        return f"{root}/metrics" if root else None

    def _server_root(self) -> str | None:
        """``/health`` and ``/metrics`` live at the server ROOT, not under
        ``/v1``, so strip the OpenAI suffix off the observed endpoint."""
        base = self._probe_url()
        if base is None:
            return None
        root = base.rstrip("/")
        return root[: -len("/v1")] if root.endswith("/v1") else root

    def _apply_reasoning(self, kwargs: dict[str, Any], request: GenerateRequest) -> None:
        """Re-render the chat template with thinking on or off.

        Overrides the base entirely: sending ``reasoning_effort`` here would be
        OpenAI vocabulary aimed at an engine that answers to a different word,
        which is the whole defect this ticket removes. ``setdefault`` on
        ``extra_body`` so the structured-output ``guided_json`` route and this
        one can coexist on the same request.
        """
        posture = posture_to_render(request)
        if posture is None:
            return
        extra_body = kwargs.setdefault("extra_body", {})
        template_kwargs = extra_body.setdefault("chat_template_kwargs", {})
        template_kwargs["enable_thinking"] = posture.enabled
        if posture.enabled and posture.effort is not None:
            record_unenforceable(
                provider=self._provider_name,
                model=self._resolve_model(request) or "",
                posture=posture,
                reason=REASON_EFFORT_NOT_EXPRESSIBLE,
            )

    def _apply_response_format(self, kwargs: dict[str, Any], request: GenerateRequest) -> None:
        # ``use_guided_json`` fallback (vLLM < 0.8): send the raw JSON schema via
        # ``extra_body.guided_json`` instead of the native ``response_format``.
        if (
            self._use_guided_json
            and request.response_format is not None
            and request.response_format.type == "json_schema"
            and request.response_format.json_schema
        ):
            extra_body = kwargs.setdefault("extra_body", {})
            extra_body["guided_json"] = request.response_format.json_schema
            return
        super()._apply_response_format(kwargs, request)

    async def health_check(self) -> bool:
        """Probe the last-observed server root; True when none has been observed
        yet ("no negative evidence" — see `OllamaProvider.health_check`)."""
        root = self._server_root()
        if root is None:
            return True
        url = f"{root}/health"
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
        hit rate as ``TEXT_ENGINE_CACHE_HIT_RATE{engine="vllm"}``.

        Never raises — a metrics-scrape failure must not affect generation.
        Returns the ratio (0.0-1.0) on success, else ``None``.
        """
        metrics_url = self._metrics_url()
        if metrics_url is None:
            return None
        try:
            if self._http is not None:
                resp = await self._http.get(metrics_url)
                text = resp.text
            else:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.get(metrics_url)
                    text = resp.text
        except (httpx.HTTPError, httpx.TimeoutException, ConnectionError, OSError) as exc:
            logger.warning("scrape_cache_hit_rate.failed", provider=_ENGINE, error=str(exc))
            return None
        except Exception as exc:
            logger.error("scrape_cache_hit_rate.unexpected_error", provider=_ENGINE, error=str(exc))
            return None

        rate = _parse_cache_hit_rate(text)
        if rate is not None:
            TEXT_ENGINE_CACHE_HIT_RATE.labels(engine=_ENGINE).set(rate)
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
