"""Azure OpenAI LLM provider — uses openai.AsyncAzureOpenAI."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import structlog
from openai import AsyncAzureOpenAI, BadRequestError

from text.core.connection import resolve_connection
from text.core.defaults import resolve_request_defaults
from text.core.exceptions import ProviderConnectionMissingError
from text.core.telemetry import get_tracer
from text.models.provider import ProviderInfo
from text.models.requests import GenerateRequest, ProviderOverride
from text.models.stats import GenerationStats, stats_from_openai_usage
from text.models.stream import StreamChunk
from text.models.usage import openai_usage_dict
from text.providers.base import CredentialPosture, require_model

if TYPE_CHECKING:
    from opentelemetry.trace import Tracer

logger = structlog.get_logger(__name__)


def _get_tracer() -> Tracer:
    return get_tracer(__name__)


class AzureOpenAIProvider:
    """Azure OpenAI provider using the openai Python SDK."""

    credential_posture = CredentialPosture.BYOK

    #: Azure pins its wire contract by date. This is the version this ADAPTER is
    #: written against — a property of the code, not a deployment choice — used
    #: only when the resolved connection does not pin its own.
    ADAPTER_API_VERSION = "2024-12-01-preview"

    def __init__(self) -> None:
        """No configuration. Azure OpenAI is BYOK-only and Text holds no
        connection of its own: endpoint, credential and api-version all arrive
        per request as a gateway-resolved ``ProviderOverride`` (tenant → SYSTEM).

        There is therefore no shared client. Every request builds its own, so
        two tenants can never race on one, and a request with no resolved
        connection raises rather than 401-ing an empty-keyed client downstream.
        """

    def _resolve_override(self, request: GenerateRequest) -> ProviderOverride | None:
        """The connection the gateway resolved for THIS request's provider."""
        return resolve_connection(request)

    def _client_for(self, request: GenerateRequest) -> AsyncAzureOpenAI:
        """Request-scoped, fail-closed client resolution."""
        override = self._resolve_override(request)
        if override is None:
            raise ProviderConnectionMissingError(
                "No Azure OpenAI connection resolved. Azure OpenAI is BYOK-only: "
                "configure a tenant Azure OpenAI credential, or the platform "
                "(SYSTEM-tenant) connection, in the provider-connection plane. "
                "There is no env fallback.",
                provider="azure_openai",
            )
        return AsyncAzureOpenAI(
            api_key=override.api_key.get_secret_value(),
            azure_endpoint=override.base_url or "",
            api_version=override.api_version or self.ADAPTER_API_VERSION,
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
        return request.model

    def _build_messages(self, request: GenerateRequest) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        if request.system_prompt:
            messages.append({"role": "system", "content": request.system_prompt})
        images = request.image_parts()
        if images:
            content: list[dict[str, Any]] = [{"type": "text", "text": request.prompt}]
            for image in images:
                content.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{image.media_type};base64,{image.data}"},
                    }
                )
            messages.append({"role": "user", "content": content})
        else:
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
                # Follow-up: newer Azure OpenAI models (gpt-5.x / o-series,
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
            # Keep the provider's OWN usage object, breakdown intact: the cache
            # and reasoning splits are priced separately by the ledger and the
            # three headline fields cannot express them.
            usage = openai_usage_dict(usage_obj)
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
                # Follow-up: newer Azure OpenAI models (gpt-5.x / o-series,
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
            usage: dict[str, Any] | None = None

            stream = await self._client_for(request).chat.completions.create(**kwargs)
            async for chunk in stream:
                if not chunk.choices:
                    if getattr(chunk, "usage", None):
                        usage = openai_usage_dict(chunk.usage)
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
        """Nothing to probe: the connection is per request, so there is no
        process-level Azure endpoint to reach.

        Returns True — "no negative evidence" — deliberately. `PoolHealthTracker`
        acts only on a POSITIVELY known-unhealthy result
        (`services/pool_health.py`), so reporting False here would take a
        perfectly usable BYOK provider out of degrade routing for every tenant
        that carries its own working credential.
        """
        return True

    async def get_info(self) -> ProviderInfo:
        """Adapter capabilities only.

        The MODEL listing and the default model come from `AiModel` /
        `AiTaskDefault` on the gateway, which is where they have always been
        authoritative — this adapter used to echo an env var
        (``TEXT_AZURE_DEFAULT_MODEL``) that no generation path ever read.
        """
        return ProviderInfo(
            name="azure_openai",
            display_name="Azure OpenAI",
            status="unavailable",
            default_model="",
            models=[],
            supports_streaming=True,
            supports_vision=True,
        )
