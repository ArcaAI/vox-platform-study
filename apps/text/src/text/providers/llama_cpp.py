"""llama.cpp server LLM provider — native ``/completion`` client.

llama.cpp is the AD-1 REFERENCE engine for the owner's generation metrics: its
``timings`` block (``prompt_n``, ``predicted_n``, ``predicted_ms``,
``predicted_per_second``) and ``stopped_eos``/``stopped_word``/``stopped_limit``
flags are mapped verbatim into ``GenerationStats``. We target the native
``/completion`` endpoint (richer than llama.cpp's OpenAI shim) so we get those
timings plus first-class GBNF ``grammar`` and JSON-``json_schema`` structured
output. Streaming is server-sent-event lines.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import httpx
import structlog

from text.core.config import LlamaCppConfig
from text.core.defaults import resolve_request_defaults
from text.core.telemetry import get_tracer
from text.models.provider import ModelInfo, ProviderInfo
from text.models.requests import GenerateRequest
from text.models.stats import GenerationStats, stats_from_llama_cpp
from text.models.stream import StreamChunk
from text.providers.base import reject_vision

if TYPE_CHECKING:
    from opentelemetry.trace import Tracer

logger = structlog.get_logger(__name__)

_ENGINE = "llama-cpp"


def _get_tracer() -> Tracer:
    return get_tracer(__name__)


class LlamaCppProvider:
    """llama.cpp server provider over the native ``/completion`` endpoint."""

    def __init__(self, config: LlamaCppConfig, http_client: httpx.AsyncClient) -> None:
        self._config = config
        self._http = http_client
        self._default_model = config.default_model
        self._base_url = config.base_url.rstrip("/")

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        # The caller-supplied model is authoritative. A llama.cpp
        # server loads a single model at launch and ignores a per-request model,
        # so this is informational only (stamped onto stats), never sent on the
        # wire.
        return request.model

    def _build_prompt(self, request: GenerateRequest) -> str:
        # ``/completion`` is a raw-prompt endpoint (no chat roles); prepend the
        # system prompt when present.
        if request.system_prompt:
            return f"{request.system_prompt}\n\n{request.prompt}"
        return request.prompt

    def _build_payload(self, request: GenerateRequest, *, stream: bool) -> dict[str, Any]:
        resolved = resolve_request_defaults(request)
        payload: dict[str, Any] = {
            "prompt": self._build_prompt(request),
            "n_predict": resolved["max_tokens"],
            "temperature": resolved["temperature"],
            "top_p": resolved["top_p"],
            "stream": stream,
            # Prefix caching (AD-4): reuse the KV cache of a shared stable prefix
            # across regen iterations / flushes.
            "cache_prompt": True,
        }

        # Structured output. A GBNF grammar (supplied via ``context.grammar``)
        # takes precedence over a JSON schema; both are native ``/completion``
        # fields, so they pass through verbatim.
        grammar = (request.context or {}).get("grammar") if request.context else None
        if isinstance(grammar, str) and grammar:
            payload["grammar"] = grammar
        elif request.response_format is not None and request.response_format.type == "json_schema":
            if request.response_format.json_schema:
                payload["json_schema"] = request.response_format.json_schema

        return payload

    async def generate(self, request: GenerateRequest) -> tuple[str, str, GenerationStats]:
        reject_vision(request, provider=_ENGINE)
        resolved = resolve_request_defaults(request)
        resolved_model = self._resolve_model(request)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate",
            attributes={
                "gen_ai.system": _ENGINE,
                "gen_ai.request.model": resolved_model or "",
                "gen_ai.operation.name": "generate",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            url = f"{self._base_url}/completion"
            payload = self._build_payload(request, stream=False)
            start = time.monotonic()
            resp = await self._http.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
            total_ms = int((time.monotonic() - start) * 1000)

            stats = stats_from_llama_cpp(
                provider=_ENGINE,
                model=resolved_model or "",
                data=data,
                total_ms=total_ms,
            )
            span.set_attribute("gen_ai.usage.input_tokens", stats.prompt_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", stats.predicted_tokens)
            span.set_attribute("gen_ai.response.finish_reason", stats.stop_reason_raw or "stop")
            return data.get("content", ""), "", stats

    async def generate_stream(self, request: GenerateRequest) -> AsyncIterator[StreamChunk]:
        reject_vision(request, provider=_ENGINE)
        resolved = resolve_request_defaults(request)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate_stream",
            attributes={
                "gen_ai.system": _ENGINE,
                "gen_ai.request.model": self._resolve_model(request) or "",
                "gen_ai.operation.name": "generate_stream",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            url = f"{self._base_url}/completion"
            payload = self._build_payload(request, stream=True)
            resolved_model = self._resolve_model(request)
            start = time.monotonic()
            ttft_ms: int | None = None

            async with self._http.stream("POST", url, json=payload) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    # llama.cpp streams SSE ``data: {json}`` lines.
                    if line.startswith("data:"):
                        line = line[len("data:") :].strip()
                    if not line:
                        continue
                    data = json.loads(line)
                    if data.get("stop"):
                        # Final object carries the full ``timings`` + ``stopped_*``
                        # flags → build the AD-1 stats, emit ONE usage chunk then
                        # done (drain-complete; no early return mid-stream).
                        total_ms = int((time.monotonic() - start) * 1000)
                        stats = stats_from_llama_cpp(
                            provider=_ENGINE,
                            model=resolved_model or "",
                            data=data,
                            total_ms=total_ms,
                            ttft_ms=ttft_ms,
                        )
                        span.set_attribute("gen_ai.usage.input_tokens", stats.prompt_tokens)
                        span.set_attribute("gen_ai.usage.output_tokens", stats.predicted_tokens)
                        span.set_attribute(
                            "gen_ai.response.finish_reason", stats.stop_reason_raw or "stop"
                        )
                        yield StreamChunk(type="usage", data=stats.model_dump())
                        yield StreamChunk(
                            type="done", data={"finish_reason": stats.stop_reason_raw or "stop"}
                        )
                        return
                    text = data.get("content", "")
                    if not text:
                        continue
                    if ttft_ms is None:
                        ttft_ms = int((time.monotonic() - start) * 1000)
                    yield StreamChunk(type="chunk", content=text)

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
        models = (
            [ModelInfo(name=self._default_model, supports_streaming=True)]
            if self._default_model
            else []
        )
        return ProviderInfo(
            name=_ENGINE,
            display_name="llama.cpp",
            status=status,
            default_model=self._default_model,
            models=models,
            supports_streaming=True,
            supports_vision=False,
        )
