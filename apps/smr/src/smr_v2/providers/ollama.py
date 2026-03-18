"""Ollama LLM provider — uses httpx for async HTTP + NDJSON streaming."""

from __future__ import annotations

import json
from typing import AsyncIterator

import httpx
import structlog

from smr_v2.core.config import OllamaConfig
from smr_v2.core.defaults import resolve_request_defaults
from smr_v2.core.telemetry import get_tracer
from smr_v2.models.provider import ModelInfo, ProviderInfo
from smr_v2.models.requests import GenerateRequest
from smr_v2.models.stream import StreamChunk

logger = structlog.get_logger(__name__)


def _get_tracer():
    return get_tracer(__name__)


class OllamaProvider:
    """Ollama self-hosted LLM provider."""

    def __init__(self, config: OllamaConfig, http_client: httpx.AsyncClient) -> None:
        self._config = config
        self._http = http_client
        self._default_model = config.default_model
        self._base_url = config.base_url.rstrip("/")

    def _resolve_model(self, request: GenerateRequest) -> str:
        return request.model or self._default_model

    def _build_payload(self, request: GenerateRequest, *, stream: bool) -> dict:
        resolved = resolve_request_defaults(request)
        payload: dict = {
            "model": self._resolve_model(request),
            "prompt": request.prompt,
            "stream": stream,
            "options": {
                "temperature": resolved["temperature"],
                "num_predict": resolved["max_tokens"],
                "top_p": resolved["top_p"],
            },
        }
        if request.system_prompt:
            payload["system"] = request.system_prompt

        if request.response_format is not None:
            if request.response_format.type == "json_schema" and request.response_format.json_schema:
                payload["format"] = request.response_format.json_schema
            elif request.response_format.type == "json":
                payload["format"] = "json"

        return payload

    async def generate(self, request: GenerateRequest) -> tuple[str, dict]:
        resolved = resolve_request_defaults(request)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate",
            attributes={
                "gen_ai.system": "ollama",
                "gen_ai.request.model": self._resolve_model(request),
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
            return data.get("response", ""), usage

    async def generate_stream(self, request: GenerateRequest) -> AsyncIterator[StreamChunk]:
        resolved = resolve_request_defaults(request)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate_stream",
            attributes={
                "gen_ai.system": "ollama",
                "gen_ai.request.model": self._resolve_model(request),
                "gen_ai.operation.name": "generate_stream",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            url = f"{self._base_url}/api/generate"
            payload = self._build_payload(request, stream=True)

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
                    text = data.get("response", "")
                    if text:
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
