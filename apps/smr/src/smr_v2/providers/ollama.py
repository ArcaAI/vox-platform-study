"""Ollama LLM provider — uses httpx for async HTTP + NDJSON streaming."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import httpx
import structlog

from smr_v2.core.config import OllamaConfig
from smr_v2.core.defaults import resolve_request_defaults
from smr_v2.core.telemetry import get_tracer
from smr_v2.models.provider import ModelInfo, ProviderInfo
from smr_v2.models.requests import GenerateRequest
from smr_v2.models.stream import StreamChunk

if TYPE_CHECKING:
    from opentelemetry.trace import Tracer

logger = structlog.get_logger(__name__)


def _get_tracer() -> Tracer:
    return get_tracer(__name__)


def _split_inline_think(text: str, in_think: bool) -> tuple[list[tuple[str, str]], bool]:
    segments: list[tuple[str, str]] = []
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

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        # D-7 (TASK-356): no in-gateway default — the caller-supplied model is
        # authoritative. ``_default_model`` is retained for the providers
        # listing (informational) only.
        return request.model

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
        }
        if request.system_prompt:
            payload["system"] = request.system_prompt

        if request.response_format is not None:
            if request.response_format.type == "json_schema" and request.response_format.json_schema:
                payload["format"] = request.response_format.json_schema
            elif request.response_format.type == "json":
                payload["format"] = "json"

        return payload

    async def generate(self, request: GenerateRequest) -> tuple[str, dict[str, Any]]:
        resolved = resolve_request_defaults(request)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate",
            attributes={
                "gen_ai.system": "ollama",
                "gen_ai.request.model": self._resolve_model(request) or "",
                "gen_ai.operation.name": "generate",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            url = f"{self._base_url}/api/generate"
            payload = self._build_payload(request, stream=False)
            resp = await self._http.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
            usage = {
                "prompt_tokens": data.get("prompt_eval_count", 0),
                "completion_tokens": data.get("eval_count", 0),
                "total_tokens": data.get("prompt_eval_count", 0) + data.get("eval_count", 0),
            }
            span.set_attribute("gen_ai.usage.input_tokens", usage["prompt_tokens"])
            span.set_attribute("gen_ai.usage.output_tokens", usage["completion_tokens"])
            span.set_attribute("gen_ai.response.finish_reason", "stop")
            return data.get("response", ""), data.get("thinking", ""), usage

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
            in_inline_think = False

            async with self._http.stream("POST", url, json=payload) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    data = json.loads(line)
                    if data.get("done"):
                        usage = {
                            "prompt_tokens": data.get("prompt_eval_count", 0),
                            "completion_tokens": data.get("eval_count", 0),
                            "total_tokens": data.get("prompt_eval_count", 0) + data.get("eval_count", 0),
                        }
                        span.set_attribute("gen_ai.usage.input_tokens", usage["prompt_tokens"])
                        span.set_attribute("gen_ai.usage.output_tokens", usage["completion_tokens"])
                        span.set_attribute("gen_ai.response.finish_reason", "stop")
                        yield StreamChunk(type="usage", data=usage)
                        yield StreamChunk(type="done", data={"finish_reason": "stop"})
                        return
                    thinking = data.get("thinking", "")
                    if thinking:
                        yield StreamChunk(type="reasoning", content=thinking)
                    text = data.get("response", "")
                    if not text:
                        continue
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
        return ProviderInfo(
            name="ollama",
            display_name="Ollama (Self-Hosted)",
            status="available" if models else "unavailable",
            default_model=self._default_model,
            models=models,
            supports_streaming=True,
        )
