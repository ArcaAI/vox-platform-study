"""Azure OpenAI LLM provider — uses openai.AsyncAzureOpenAI."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import structlog
from openai import APIConnectionError, APIError, APITimeoutError, AsyncAzureOpenAI, BadRequestError

from smr.core.config import AzureOpenAIConfig
from smr.core.defaults import resolve_request_defaults
from smr.core.exceptions import ProviderCredentialsError
from smr.core.telemetry import get_tracer
from smr.models.provider import ModelInfo, ProviderInfo
from smr.models.requests import GenerateRequest, ProviderOverride
from smr.models.stats import GenerationStats, stats_from_openai_usage
from smr.models.stream import StreamChunk
from smr.providers.base import require_model

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
        # TASK-602: BYOK — the shared platform client is built ONLY when an
        # explicit api_key is present (never from env; see AzureOpenAIConfig).
        # In production api_key is empty, so this is None and the credential must
        # arrive per request as a ProviderOverride (tenant→SYSTEM). Never hand an
        # empty key to the SDK constructor (it would build a client that 401s).
        key = config.api_key.get_secret_value()
        self._client: AsyncAzureOpenAI | None = (
            AsyncAzureOpenAI(
                api_key=key,
                azure_endpoint=config.endpoint,
                api_version=config.api_version,
            )
            if key
            else None
        )

    def _resolve_override(self, request: GenerateRequest) -> ProviderOverride | None:
        """Tenant BYO credential injected by the gateway for THIS provider,
        keyed by ``request.provider`` (see `ProviderOverride`). ``None`` for
        every caller until a tenant configures an enabled azure connection —
        current (env/config) behavior is unchanged in that case."""
        if not request.provider_overrides:
            return None
        return request.provider_overrides.get(request.provider)

    def _client_for(self, request: GenerateRequest) -> AsyncAzureOpenAI:
        """Override-wins client resolution. A tenant credential builds a
        request-scoped client (the shared client is never mutated) so concurrent
        requests for different tenants can never interfere.

        TASK-602 (BYOK, fail-closed): absent an override, the shared client is
        reused ONLY when a platform key was configured; when neither an override
        nor a platform client exists, raise ``ProviderCredentialsError`` (503)
        rather than 401-ing an empty-keyed client downstream. There is no env
        fallback."""
        override = self._resolve_override(request)
        if override is None:
            if self._client is None:
                raise ProviderCredentialsError(
                    "Azure OpenAI credentials not configured. Azure OpenAI is "
                    "BYOK-only: configure a tenant Azure OpenAI credential, or the "
                    "platform (SYSTEM-tenant) connection, in the provider-connection "
                    "plane. There is no env fallback.",
                    provider="azure_openai",
                )
            return self._client
        return AsyncAzureOpenAI(
            api_key=override.api_key.get_secret_value(),
            azure_endpoint=override.base_url or self._config.endpoint,
            api_version=override.api_version or self._config.api_version,
        )

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        # No in-gateway default — the caller-supplied model is
        # authoritative, UNLESS an explicit Azure deployment is configured
        #: Azure OpenAI routes requests by *deployment name*, not
        # model name, so ``deployment_name`` — when set — takes precedence over
        # the caller-supplied model. Default ("") preserves the pre-existing
        # behavior of forwarding ``request.model`` unchanged. A tenant BYO
        # override's own ``deployment_name`` wins over both.
        override = self._resolve_override(request)
        if override is not None and override.deployment_name:
            return override.deployment_name
        return self._config.deployment_name or request.model

    def _build_messages(self, request: GenerateRequest) -> list[dict[str, str]]:
        messages = []
        if request.system_prompt:
            messages.append({"role": "system", "content": request.system_prompt})
        messages.append({"role": "user", "content": request.prompt})
        return messages

    async def generate(self, request: GenerateRequest) -> tuple[str, str, GenerationStats]:
        resolved = resolve_request_defaults(request)
        resolved_model = require_model(self._resolve_model(request), provider="azure_openai")
        with _get_tracer().start_as_current_span(
            "gen_ai.generate",
            attributes={
                "gen_ai.system": "azure_openai",
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
                # TASK-602 follow-up: newer Azure OpenAI models (gpt-5.x / o-series,
                # e.g. gpt-5.4-mini) reject `max_tokens` and require
                # `max_completion_tokens`; it is accepted across chat models on the
                # configured api-version, so send it unconditionally.
                "max_completion_tokens": resolved["max_tokens"],
                "top_p": resolved["top_p"],
                "stream": False,
            }

            if (
                request.response_format is not None
                and request.response_format.type == "json_schema"
            ):
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

            start = time.monotonic()
            try:
                response = await self._client_for(request).chat.completions.create(**kwargs)
            except BadRequestError as e:
                if "content_filter" in str(e).lower():
                    logger.warning(
                        "azure.content_filter_blocked",
                        error=str(e),
                        model=kwargs.get("model"),
                    )
                raise
            total_ms = int((time.monotonic() - start) * 1000)

            message = response.choices[0].message
            content = message.content or ""
            reasoning = (
                getattr(message, "reasoning_content", None)
                or getattr(message, "reasoning", None)
                or ""
            )
            finish_reason = response.choices[0].finish_reason
            usage_obj = getattr(response, "usage", None)
            usage = {
                "prompt_tokens": usage_obj.prompt_tokens if usage_obj else 0,
                "completion_tokens": usage_obj.completion_tokens if usage_obj else 0,
                "total_tokens": usage_obj.total_tokens if usage_obj else 0,
            }
            # engine_native: OpenAI ``usage`` + Azure ``prompt_filter_results`` /
            # ``content_filter_results`` when present (content-safety audit blob).
            native: dict[str, Any] = {"usage": usage}
            for attr in ("prompt_filter_results", "content_filter_results"):
                val = getattr(response, attr, None)
                if isinstance(val, (dict, list)):
                    native[attr] = val
            stats = stats_from_openai_usage(
                provider="azure_openai",
                model=resolved_model,
                usage=usage,
                finish_reason=finish_reason,
                total_ms=total_ms,
                engine_native=native,
            )
            span.set_attribute("gen_ai.usage.input_tokens", usage["prompt_tokens"])
            span.set_attribute("gen_ai.usage.output_tokens", usage["completion_tokens"])
            span.set_attribute("gen_ai.response.finish_reason", finish_reason or "stop")
            return content, reasoning, stats

    async def generate_stream(self, request: GenerateRequest) -> AsyncIterator[StreamChunk]:
        resolved = resolve_request_defaults(request)
        resolved_model = require_model(self._resolve_model(request), provider="azure_openai")
        with _get_tracer().start_as_current_span(
            "gen_ai.generate_stream",
            attributes={
                "gen_ai.system": "azure_openai",
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
                # TASK-602 follow-up: newer Azure OpenAI models (gpt-5.x / o-series,
                # e.g. gpt-5.4-mini) reject `max_tokens` and require
                # `max_completion_tokens`; it is accepted across chat models on the
                # configured api-version, so send it unconditionally.
                "max_completion_tokens": resolved["max_tokens"],
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

            # DRAIN to completion (AD-1) — see openai_compat for the rationale: an
            # early-return on the finish chunk drops the trailing usage-only chunk.
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
                reasoning = getattr(delta, "reasoning_content", None) or getattr(
                    delta, "reasoning", None
                )
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
                provider="azure_openai",
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
        # TASK-602: no platform key ⇒ no shared client to probe. The provider is
        # still registered (BYOK — usable per request via an override), but the
        # platform connection itself is unhealthy.
        if self._client is None:
            return False
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
        # TASK-579: default_model is informational-only (may be unset now that
        # cloud configs carry no compiled-in vendor model) — never advertise an
        # empty-named model.
        models: list[ModelInfo] = (
            [ModelInfo(name=self._default_model, supports_streaming=True)]
            if self._default_model
            else []
        )
        # TASK-602: no platform key ⇒ no shared client to probe ⇒ unavailable at
        # the platform level (still BYOK-usable per request).
        status = "available"
        if self._client is None:
            return ProviderInfo(
                name="azure_openai",
                display_name="Azure OpenAI",
                status="unavailable",
                default_model=self._default_model,
                models=models,
                supports_streaming=True,
            )
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
