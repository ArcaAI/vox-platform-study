"""Ollama LLM provider — uses httpx for async HTTP + NDJSON streaming."""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any, Literal

import httpx
import structlog

from smr_v2.core.config import OllamaConfig
from smr_v2.core.defaults import resolve_request_defaults
from smr_v2.core.retention import DEFAULT_RETENTION_TTL_S, clamp_cache_ttl_seconds
from smr_v2.core.telemetry import get_tracer
from smr_v2.models.provider import ModelInfo, ProviderInfo
from smr_v2.models.requests import GenerateRequest
from smr_v2.models.stats import GenerationStats, stats_from_ollama_response
from smr_v2.models.stream import StreamChunk

if TYPE_CHECKING:
    from opentelemetry.trace import Tracer

logger = structlog.get_logger(__name__)


def _get_tracer() -> Tracer:
    return get_tracer(__name__)


def _split_inline_think(
    text: str, in_think: bool
) -> tuple[list[tuple[Literal["chunk", "reasoning"], str]], bool]:
    segments: list[tuple[Literal["chunk", "reasoning"], str]] = []
    remaining = text
    while remaining:
        tag = "</think>" if in_think else "<think>"
        idx = remaining.find(tag)
        if idx == -1:
            segments.append(("reasoning" if in_think else "chunk", remaining))
            remaining = ""
        else:
            before = remaining[:idx]
            if before:
                segments.append(("reasoning" if in_think else "chunk", before))
            in_think = not in_think
            remaining = remaining[idx + len(tag):]
    return segments, in_think


class OllamaProvider:
    """Ollama self-hosted LLM provider."""

    def __init__(self, config: OllamaConfig, http_client: httpx.AsyncClient) -> None:
        self._config = config
        self._http = http_client
        self._default_model = config.default_model
        self._base_url = config.base_url.rstrip("/")
        # Bootstrap retention hint; `apply_retention` replaces
        # it with the control-plane value on the first effective-config refresh.
        self._retention_ttl_s = clamp_cache_ttl_seconds(DEFAULT_RETENTION_TTL_S)

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        # No in-gateway default — the caller-supplied model is
        # authoritative. ``_default_model`` is retained for the providers
        # listing (informational) only.
        return request.model

    def apply_retention(self, retention: dict[str, int]) -> None:
        """Adopt the control-plane idle-retention TTL.

        An ABSENT key keeps the current (env/bootstrap) value, so a gateway
        outage leaves behaviour byte-identical. The product clamp [60, 3600] is
        re-applied here as well as registry-side: a bad DB value must not be
        able to pin a model in GPU memory for a day.
        """
        ttl_seconds = retention.get("ttl_seconds")
        if ttl_seconds is not None:
            self._retention_ttl_s = clamp_cache_ttl_seconds(ttl_seconds)

    def _build_payload(self, request: GenerateRequest, *, stream: bool) -> dict[str, Any]:
        resolved = resolve_request_defaults(request)
        payload: dict[str, Any] = {
            "model": self._resolve_model(request),
            "prompt": request.prompt,
            "stream": stream,
            "options": {
                "temperature": resolved["temperature"],
                "num_predict": resolved["max_tokens"],
                "top_p": resolved["top_p"],
            },
            "think": True,
            # Ollama owns residency; this per-request hint
            # overrides the server's OLLAMA_KEEP_ALIVE (default 5 min idle).
            # Sent on generate AND stream: both share this builder.
            "keep_alive": f"{self._retention_ttl_s}s",
        }
        if request.system_prompt:
            payload["system"] = request.system_prompt

        if request.response_format is not None:
            if request.response_format.type == "json_schema" and request.response_format.json_schema:
                payload["format"] = request.response_format.json_schema
            elif request.response_format.type == "json":
                payload["format"] = "json"

        return payload

    async def generate(self, request: GenerateRequest) -> tuple[str, str, GenerationStats]:
        resolved = resolve_request_defaults(request)
        resolved_model = self._resolve_model(request)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate",
            attributes={
                "gen_ai.system": "ollama",
                "gen_ai.request.model": resolved_model or "",
                "gen_ai.operation.name": "generate",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            url = f"{self._base_url}/api/generate"
            payload = self._build_payload(request, stream=False)
            start = time.monotonic()
            resp = await self._http.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
            total_ms = int((time.monotonic() - start) * 1000)
            # Ollama reports the real ``done_reason`` + nanosecond durations; the
            # builder normalizes the stop reason and keeps the raw blob in
            # ``engine_native`` (engine-preferred throughput from eval durations).
            stats = stats_from_ollama_response(
                provider="ollama",
                model=resolved_model or "",
                data=data,
                total_ms=total_ms,
            )
            span.set_attribute("gen_ai.usage.input_tokens", stats.prompt_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", stats.predicted_tokens)
            span.set_attribute("gen_ai.response.finish_reason", stats.stop_reason_raw or "stop")
            return data.get("response", ""), data.get("thinking", ""), stats

    async def generate_stream(self, request: GenerateRequest) -> AsyncIterator[StreamChunk]:
        resolved = resolve_request_defaults(request)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate_stream",
            attributes={
                "gen_ai.system": "ollama",
                "gen_ai.request.model": self._resolve_model(request) or "",
                "gen_ai.operation.name": "generate_stream",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            url = f"{self._base_url}/api/generate"
            payload = self._build_payload(request, stream=True)
            resolved_model = self._resolve_model(request)
            in_inline_think = False
            start = time.monotonic()
            ttft_ms: int | None = None

            async with self._http.stream("POST", url, json=payload) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    data = json.loads(line)
                    if data.get("done"):
                        # Final Ollama object carries the real ``done_reason`` +
                        # durations. Build full AD-1 stats and emit ONE usage chunk
                        # then done (drain-complete: no early-return mid-stream).
                        total_ms = int((time.monotonic() - start) * 1000)
                        stats = stats_from_ollama_response(
                            provider="ollama",
                            model=resolved_model or "",
                            data=data,
                            total_ms=total_ms,
                            ttft_ms=ttft_ms,
                        )
                        span.set_attribute("gen_ai.usage.input_tokens", stats.prompt_tokens)
                        span.set_attribute("gen_ai.usage.output_tokens", stats.predicted_tokens)
                        span.set_attribute("gen_ai.response.finish_reason", stats.stop_reason_raw or "stop")
                        yield StreamChunk(type="usage", data=stats.model_dump())
                        yield StreamChunk(type="done", data={"finish_reason": stats.stop_reason_raw or "stop"})
                        return
                    thinking = data.get("thinking", "")
                    if thinking:
                        if ttft_ms is None:
                            ttft_ms = int((time.monotonic() - start) * 1000)
                        yield StreamChunk(type="reasoning", content=thinking)
                    text = data.get("response", "")
                    if not text:
                        continue
                    if ttft_ms is None:
                        ttft_ms = int((time.monotonic() - start) * 1000)
                    if not thinking:
                        segments, in_inline_think = _split_inline_think(text, in_inline_think)
                        for chunk_type, chunk_text in segments:
                            yield StreamChunk(type=chunk_type, content=chunk_text)
                    else:
                        yield StreamChunk(type="chunk", content=text)

    async def health_check(self) -> bool:
        try:
            resp = await self._http.get(f"{self._base_url}/api/tags")
            return resp.status_code == 200
        except (httpx.HTTPError, httpx.TimeoutException, ConnectionError, OSError) as exc:
            logger.warning("health_check.failed", provider="ollama", error=str(exc))
            return False
        except Exception as exc:
            logger.error("health_check.unexpected_error", provider="ollama", error=str(exc))
            return False

    async def _running_model_names(self) -> set[str] | None:
        """`GET /api/ps` lists the models Ollama currently has resident.

        Returns ``None`` when the probe fails, which the caller renders as an
        UNKNOWN load state — never as "not loaded" (a transient `/api/ps` miss
        must not look like an unloaded engine).
        """
        try:
            resp = await self._http.get(f"{self._base_url}/api/ps")
            if resp.status_code != 200:
                return None
            return {m["name"] for m in resp.json().get("models", []) if m.get("name")}
        except (httpx.HTTPError, httpx.TimeoutException, ConnectionError, OSError) as exc:
            logger.warning("get_info.ps_failed", provider="ollama", error=str(exc))
            return None
        except Exception as exc:
            logger.error("get_info.ps_unexpected_error", provider="ollama", error=str(exc))
            return None

    async def get_info(self) -> ProviderInfo:
        models: list[ModelInfo] = []
        try:
            resp = await self._http.get(f"{self._base_url}/api/tags")
            if resp.status_code == 200:
                for m in resp.json().get("models", []):
                    models.append(ModelInfo(name=m["name"], supports_streaming=True))
        except (httpx.HTTPError, httpx.TimeoutException, ConnectionError, OSError) as exc:
            logger.warning("get_info.failed", provider="ollama", error=str(exc))
        except Exception as exc:
            logger.error("get_info.unexpected_error", provider="ollama", error=str(exc))

        if models:
            running = await self._running_model_names()
            if running is not None:
                for model in models:
                    model.state = "loaded" if model.name in running else "not-loaded"

        return ProviderInfo(
            name="ollama",
            display_name="Ollama (Self-Hosted)",
            status="available" if models else "unavailable",
            default_model=self._default_model,
            models=models,
            supports_streaming=True,
        )
