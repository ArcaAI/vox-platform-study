"""OpenAI (api.openai.com) LLM provider — first-class tenant-BYO provider.

The OpenAI chat-completions wire is identical to the generic OpenAI-compatible
one, but ``openai`` is a *governed* provider whose credential arrives per
request as a gateway-injected ``ProviderOverride`` (tenant BYO key). This adapter
mirrors ``azure_openai.py``'s request-scoped, override-wins client pattern with a
plain ``AsyncOpenAI`` client instead of the Azure variant.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import structlog
from openai import APIConnectionError, APIError, APITimeoutError, AsyncOpenAI

from smr.core.config import OpenAIConfig
from smr.core.defaults import resolve_request_defaults
from smr.core.telemetry import get_tracer
from smr.models.provider import ModelInfo, ProviderInfo
from smr.models.requests import GenerateRequest, ProviderOverride
from smr.models.stats import GenerationStats, stats_from_openai_usage
from smr.models.stream import StreamChunk
from smr.providers.base import require_model

if TYPE_CHECKING:
    from opentelemetry.trace import Tracer

logger = structlog.get_logger(__name__)

_PROVIDER_NAME = "openai"


def _get_tracer() -> Tracer:
    return get_tracer(__name__)


class OpenAIProvider:
    """OpenAI provider using the openai Python SDK (``AsyncOpenAI``)."""

    def __init__(self, config: OpenAIConfig) -> None:
        self._config = config
        self._default_model = config.default_model
        # The shared, env-configured PLATFORM fallback client. Rebuilt per
        # request only when a tenant override is present (never mutated).
        self._client = AsyncOpenAI(
            api_key=config.api_key.get_secret_value(),
            base_url=config.base_url,
            organization=config.organization,
            timeout=float(config.timeout_s),
        )

    def _resolve_override(self, request: GenerateRequest) -> ProviderOverride | None:
        """Tenant BYO credential injected by the gateway for THIS provider,
        keyed by ``request.provider`` (see `ProviderOverride`). ``None`` for
        every caller until a tenant configures an enabled openai connection —
        current (env/config) behavior is unchanged in that case."""
        if not request.provider_overrides:
            return None
        return request.provider_overrides.get(request.provider)

    def _client_for(self, request: GenerateRequest) -> AsyncOpenAI:
        """Override-wins client resolution. A tenant credential builds a
        request-scoped client (the shared/env-configured ``self._client`` is
        never mutated) so concurrent requests for different tenants can never
        interfere; absent an override, the shared client is reused unchanged.

        Fail-OPEN: if the override client cannot be built (malformed
        credential, bad base_url, ...), degrade to the shared env client rather
        than failing the request. The key is NEVER logged."""
        override = self._resolve_override(request)
        if override is None:
            return self._client
        try:
            return AsyncOpenAI(
                api_key=override.api_key.get_secret_value(),
                base_url=override.base_url or self._config.base_url,
                organization=self._config.organization,
                timeout=float(self._config.timeout_s),
            )
        except Exception as exc:  # noqa: BLE001 — fail-open, never leak the key
            logger.warning(
                "openai.override_client_build_failed",
                provider=_PROVIDER_NAME,
                error=type(exc).__name__,
            )
            return self._client

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        # override-wins: a tenant override MAY pin the model; otherwise the
        # caller-supplied model is authoritative. ``_default_model`` is
        # informational (providers listing) only.
        override = self._resolve_override(request)
        if override is not None and override.model:
            return override.model
        return request.model

    def _build_messages(self, request: GenerateRequest) -> list[dict[str, str]]:
        messages = []
        if request.system_prompt:
            messages.append({"role": "system", "content": request.system_prompt})
        messages.append({"role": "user", "content": request.prompt})
        return messages

    def _apply_response_format(self, kwargs: dict[str, Any], request: GenerateRequest) -> None:
        if request.response_format is None:
            return
        if request.response_format.type == "json_schema" and request.response_format.json_schema:
            schema = request.response_format.json_schema
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

    async def generate(self, request: GenerateRequest) -> tuple[str, str, GenerationStats]:
        resolved = resolve_request_defaults(request)
        resolved_model = require_model(self._resolve_model(request), provider=_PROVIDER_NAME)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate",
            attributes={
                "gen_ai.system": _PROVIDER_NAME,
                "gen_ai.request.model": resolved_model,
                "gen_ai.operation.name": "generate",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            kwargs: dict[str, Any] = {
                "model": resolved_model,
                "messages": self._build_messages(request),
                "temperature": resolved["temperature"],
                "max_tokens": resolved["max_tokens"],
                "top_p": resolved["top_p"],
                "stream": False,
            }
            self._apply_response_format(kwargs, request)

            start = time.monotonic()
            response = await self._client_for(request).chat.completions.create(**kwargs)
            total_ms = int((time.monotonic() - start) * 1000)

            message = response.choices[0].message
            content = message.content or ""
            reasoning = getattr(message, "reasoning_content", None) or getattr(message, "reasoning", None) or ""
            finish_reason = response.choices[0].finish_reason
            usage_obj = getattr(response, "usage", None)
            usage = {
                "prompt_tokens": usage_obj.prompt_tokens if usage_obj else 0,
                "completion_tokens": usage_obj.completion_tokens if usage_obj else 0,
                "total_tokens": usage_obj.total_tokens if usage_obj else 0,
            }
            stats = stats_from_openai_usage(
                provider=_PROVIDER_NAME,
                model=resolved_model,
                usage=usage,
                finish_reason=finish_reason,
                total_ms=total_ms,
                engine_native={"usage": usage},
            )
            span.set_attribute("gen_ai.usage.input_tokens", usage["prompt_tokens"])
            span.set_attribute("gen_ai.usage.output_tokens", usage["completion_tokens"])
            span.set_attribute("gen_ai.response.finish_reason", finish_reason or "stop")
            return content, reasoning, stats

    async def generate_stream(self, request: GenerateRequest) -> AsyncIterator[StreamChunk]:
        resolved = resolve_request_defaults(request)
        resolved_model = require_model(self._resolve_model(request), provider=_PROVIDER_NAME)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate_stream",
            attributes={
                "gen_ai.system": _PROVIDER_NAME,
                "gen_ai.request.model": resolved_model,
                "gen_ai.operation.name": "generate_stream",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            kwargs: dict[str, Any] = {
                "model": resolved_model,
                "messages": self._build_messages(request),
                "temperature": resolved["temperature"],
                "max_tokens": resolved["max_tokens"],
                "top_p": resolved["top_p"],
                "stream": True,
                "stream_options": {"include_usage": True},
            }
            self._apply_response_format(kwargs, request)

            # DRAIN to completion (AD-1): the finish chunk precedes the
            # usage-only chunk; an early return drops usage.
            start = time.monotonic()
            ttft_ms: int | None = None
            finish_reason: str | None = None
            usage: dict[str, int] | None = None

            stream = await self._client_for(request).chat.completions.create(**kwargs)
            async for chunk in stream:
                if not chunk.choices:
                    if getattr(chunk, "usage", None):
                        usage = {
                            "prompt_tokens": chunk.usage.prompt_tokens,
                            "completion_tokens": chunk.usage.completion_tokens,
                            "total_tokens": chunk.usage.total_tokens,
                        }
                    continue
                delta = chunk.choices[0].delta
                if chunk.choices[0].finish_reason:
                    finish_reason = chunk.choices[0].finish_reason
                reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                if isinstance(reasoning, str) and reasoning:
                    if ttft_ms is None:
                        ttft_ms = int((time.monotonic() - start) * 1000)
                    yield StreamChunk(type="reasoning", content=reasoning)
                if delta.content:
                    if ttft_ms is None:
                        ttft_ms = int((time.monotonic() - start) * 1000)
                    yield StreamChunk(type="chunk", content=delta.content)

            total_ms = int((time.monotonic() - start) * 1000)
            stats = stats_from_openai_usage(
                provider=_PROVIDER_NAME,
                model=resolved_model,
                usage=usage,
                finish_reason=finish_reason,
                total_ms=total_ms,
                ttft_ms=ttft_ms,
                engine_native={"usage": usage} if usage else None,
            )
            if usage:
                span.set_attribute("gen_ai.usage.input_tokens", usage["prompt_tokens"])
                span.set_attribute("gen_ai.usage.output_tokens", usage["completion_tokens"])
            span.set_attribute("gen_ai.response.finish_reason", finish_reason or "stop")
            yield StreamChunk(type="usage", data=stats.model_dump())
            yield StreamChunk(type="done", data={"finish_reason": finish_reason or "stop"})

    async def health_check(self) -> bool:
        try:
            await self._client.models.list()
            return True
        except (APIError, APIConnectionError, APITimeoutError) as exc:
            logger.warning("health_check.failed", provider=_PROVIDER_NAME, error=str(exc))
            return False
        except Exception as exc:
            logger.error("health_check.unexpected_error", provider=_PROVIDER_NAME, error=str(exc))
            return False

    async def get_info(self) -> ProviderInfo:
        # TASK-579: default_model is informational-only (may be unset now that
        # cloud configs carry no compiled-in vendor model) — never advertise an
        # empty-named model.
        models: list[ModelInfo] = (
            [ModelInfo(name=self._default_model, supports_streaming=True)] if self._default_model else []
        )
        status = "available"
        try:
            model_list = await self._client.models.list()
            models = [ModelInfo(name=m.id, supports_streaming=True) for m in model_list.data]
        except (APIError, APIConnectionError, APITimeoutError) as exc:
            logger.warning("get_info.failed", provider=_PROVIDER_NAME, error=str(exc))
            status = "unavailable"
        except Exception as exc:
            logger.error("get_info.unexpected_error", provider=_PROVIDER_NAME, error=str(exc))
            status = "unavailable"
        return ProviderInfo(
            name=_PROVIDER_NAME,
            display_name="OpenAI",
            status=status,
            default_model=self._default_model,
            models=models,
            supports_streaming=True,
        )
