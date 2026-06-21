"""Azure OpenAI LLM provider — uses openai.AsyncAzureOpenAI."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import structlog
from openai import APIConnectionError, APIError, APITimeoutError, AsyncAzureOpenAI, BadRequestError

from smr_v2.core.config import AzureOpenAIConfig
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


class AzureOpenAIProvider:
    """Azure OpenAI provider using the openai Python SDK."""

    def __init__(self, config: AzureOpenAIConfig) -> None:
        self._config = config
        self._default_model = config.default_model
        self._client = AsyncAzureOpenAI(
            api_key=config.api_key.get_secret_value(),
            azure_endpoint=config.endpoint,
            api_version=config.api_version,
        )

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        # D-7 (TASK-356): no in-gateway default — the caller-supplied model is
        # authoritative. ``_default_model`` is retained for the providers
        # listing (informational) only.
        return request.model

    def _build_messages(self, request: GenerateRequest) -> list[dict[str, str]]:
        messages = []
        if request.system_prompt:
            messages.append({"role": "system", "content": request.system_prompt})
        messages.append({"role": "user", "content": request.prompt})
        return messages

    async def generate(self, request: GenerateRequest) -> tuple[str, dict[str, Any]]:
        resolved = resolve_request_defaults(request)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate",
            attributes={
                "gen_ai.system": "azure_openai",
                "gen_ai.request.model": self._resolve_model(request) or "",
                "gen_ai.operation.name": "generate",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            kwargs: dict[str, Any] = {
                "model": self._resolve_model(request),
                "messages": self._build_messages(request),
                "temperature": resolved["temperature"],
                "max_tokens": resolved["max_tokens"],
                "top_p": resolved["top_p"],
                "stream": False,
            }

            if request.response_format is not None and request.response_format.type == "json_schema":
                schema = request.response_format.json_schema or {}
                kwargs["response_format"] = {
                    "type": "json_schema",
                    "json_schema": {
                        "name": schema.get("title", "output"),
                        "schema": schema,
                        "strict": request.response_format.strict,
                    },
                }
            elif request.response_format is not None and request.response_format.type == "json":
                kwargs["response_format"] = {"type": "json_object"}

            try:
                response = await self._client.chat.completions.create(**kwargs)
            except BadRequestError as e:
                if "content_filter" in str(e).lower():
                    logger.warning(
                        "azure.content_filter_blocked",
                        error=str(e),
                        model=kwargs.get("model"),
                    )
                raise

            content = response.choices[0].message.content or ""
            usage = {
                "prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
                "completion_tokens": response.usage.completion_tokens if response.usage else 0,
                "total_tokens": response.usage.total_tokens if response.usage else 0,
            }
            span.set_attribute("gen_ai.usage.input_tokens", usage["prompt_tokens"])
            span.set_attribute("gen_ai.usage.output_tokens", usage["completion_tokens"])
            span.set_attribute("gen_ai.response.finish_reason", "stop")
            return content, usage

    async def generate_stream(self, request: GenerateRequest) -> AsyncIterator[StreamChunk]:
        resolved = resolve_request_defaults(request)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate_stream",
            attributes={
                "gen_ai.system": "azure_openai",
                "gen_ai.request.model": self._resolve_model(request) or "",
                "gen_ai.operation.name": "generate_stream",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            kwargs: dict[str, Any] = {
                "model": self._resolve_model(request),
                "messages": self._build_messages(request),
                "temperature": resolved["temperature"],
                "max_tokens": resolved["max_tokens"],
                "top_p": resolved["top_p"],
                "stream": True,
                "stream_options": {"include_usage": True},
            }

            if request.response_format is not None:
                if request.response_format.type == "json_schema":
                    schema = request.response_format.json_schema or {}
                    kwargs["response_format"] = {
                        "type": "json_schema",
                        "json_schema": {
                            "name": schema.get("title", "output"),
                            "schema": schema,
                            "strict": request.response_format.strict,
                        },
                    }
                elif request.response_format.type == "json":
                    kwargs["response_format"] = {"type": "json_object"}

            stream = await self._client.chat.completions.create(**kwargs)
            async for chunk in stream:
                if not chunk.choices:
                    if hasattr(chunk, "usage") and chunk.usage:
                        span.set_attribute("gen_ai.usage.input_tokens", chunk.usage.prompt_tokens)
                        span.set_attribute("gen_ai.usage.output_tokens", chunk.usage.completion_tokens)
                        yield StreamChunk(type="usage", data={
                            "prompt_tokens": chunk.usage.prompt_tokens,
                            "completion_tokens": chunk.usage.completion_tokens,
                            "total_tokens": chunk.usage.total_tokens,
                        })
                    continue
                delta = chunk.choices[0].delta
                finish = chunk.choices[0].finish_reason
                if delta.content:
                    yield StreamChunk(type="chunk", content=delta.content)
                if finish:
                    span.set_attribute("gen_ai.response.finish_reason", finish)
                    yield StreamChunk(type="done", data={"finish_reason": finish})
                    return

    async def health_check(self) -> bool:
        try:
            await self._client.models.list()
            return True
        except (APIError, APIConnectionError, APITimeoutError) as exc:
            logger.warning("health_check.failed", provider="azure", error=str(exc))
            return False
        except Exception as exc:
            logger.error("health_check.unexpected_error", provider="azure", error=str(exc))
            return False

    async def get_info(self) -> ProviderInfo:
        models: list[ModelInfo] = [ModelInfo(name=self._default_model, supports_streaming=True)]
        status = "available"
        try:
            await self._client.models.list()
        except (APIError, APIConnectionError, APITimeoutError) as exc:
            logger.warning("get_info.failed", provider="azure", error=str(exc))
            status = "unavailable"
        except Exception as exc:
            logger.error("get_info.unexpected_error", provider="azure", error=str(exc))
            status = "unavailable"
        return ProviderInfo(
            name="azure_openai",
            display_name="Azure OpenAI",
            status=status,
            default_model=self._default_model,
            models=models,
            supports_streaming=True,
        )
