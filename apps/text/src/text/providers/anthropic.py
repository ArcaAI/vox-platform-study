"""Anthropic (Claude Messages API) LLM provider — first-class tenant-BYO provider.

Maps Text's ``generate``/``generate_stream`` contract onto the Anthropic Messages
API. The credential arrives per request as a gateway-injected
``ProviderOverride`` (tenant BYO key); this adapter mirrors the request-scoped,
override-wins client pattern of ``azure_openai.py``/``bedrock.py`` with a plain
``AsyncAnthropic`` client.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import structlog
from anthropic import APIConnectionError, APIError, APITimeoutError, AsyncAnthropic

from text.core.config import AnthropicConfig
from text.core.defaults import resolve_request_defaults
from text.core.exceptions import ProviderCredentialsError
from text.core.telemetry import get_tracer
from text.models.provider import ModelInfo, ProviderInfo
from text.models.requests import GenerateRequest, ProviderOverride
from text.models.stats import GenerationStats, build_generation_stats
from text.models.stream import StreamChunk
from text.models.usage import anthropic_usage_dict
from text.providers.base import CredentialPosture, require_model

if TYPE_CHECKING:
    from opentelemetry.trace import Tracer

logger = structlog.get_logger(__name__)

_PROVIDER_NAME = "anthropic"

# Anthropic Messages-API ``stop_reason`` → AD-1 ``StopReason``. The shared
# ``normalize_stop_reason`` table (stats.py) has no ``anthropic`` entry and
# defaults to the OpenAI wire (which only knows ``end_turn``/``max_tokens``), so
# the true native reason is preserved in ``stop_reason_raw`` while THIS map
# supplies the correct normalized value.
_ANTHROPIC_STOP: dict[str, str] = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "pause_turn": "stop",
    "max_tokens": "length",
    "tool_use": "tool_call",
    "refusal": "content_filter",
}


def _get_tracer() -> Tracer:
    return get_tracer(__name__)


class AnthropicProvider:
    """Anthropic provider using the anthropic Python SDK (``AsyncAnthropic``)."""

    credential_posture = CredentialPosture.BYOK

    def __init__(self, config: AnthropicConfig) -> None:
        self._config = config
        self._default_model = config.default_model
        # BYOK — the shared platform client is built ONLY when an
        # explicit api_key is present (never from env; see AnthropicConfig). In
        # production api_key is empty ⇒ None, and the credential must arrive per
        # request as a ProviderOverride. Never hand an empty key to the SDK.
        key = config.api_key.get_secret_value()
        self._client: AsyncAnthropic | None = (
            AsyncAnthropic(
                api_key=key,
                base_url=config.base_url or None,
                timeout=float(config.timeout_s),
            )
            if key
            else None
        )

    def _resolve_override(self, request: GenerateRequest) -> ProviderOverride | None:
        """Tenant BYO credential injected by the gateway for THIS provider,
        keyed by ``request.provider``. ``None`` for every caller until a tenant
        configures an enabled anthropic connection."""
        if not request.provider_overrides:
            return None
        return request.provider_overrides.get(request.provider)

    def _shared_or_raise(self) -> AsyncAnthropic:
        """The shared platform client, or ``ProviderCredentialsError`` (503) when
        none was configured. BYOK, fail-closed — no env fallback, so a
        request with no usable override and no platform client fails cleanly
        rather than 401-ing an empty-keyed client."""
        if self._client is None:
            raise ProviderCredentialsError(
                "Anthropic credentials not configured. Anthropic is BYOK-only: "
                "configure a tenant Anthropic credential, or the platform "
                "(SYSTEM-tenant) connection, in the provider-connection plane. "
                "There is no env fallback.",
                provider=_PROVIDER_NAME,
            )
        return self._client

    def _client_for(self, request: GenerateRequest) -> AsyncAnthropic:
        """Override-wins client resolution. A tenant credential builds a
        request-scoped client (the shared client is never mutated); absent an
        override, the shared platform client is used (or 503 if none).
        Fail-OPEN on a MALFORMED override: degrade to the shared platform client
        (itself 503 if none). The key is NEVER logged."""
        override = self._resolve_override(request)
        if override is None:
            return self._shared_or_raise()
        try:
            return AsyncAnthropic(
                api_key=override.api_key.get_secret_value(),
                base_url=override.base_url or self._config.base_url or None,
                timeout=float(self._config.timeout_s),
            )
        except Exception as exc:  # noqa: BLE001 — fail-open, never leak the key
            logger.warning(
                "anthropic.override_client_build_failed",
                provider=_PROVIDER_NAME,
                error=type(exc).__name__,
            )
            return self._shared_or_raise()

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        override = self._resolve_override(request)
        if override is not None and override.model:
            return override.model
        return request.model

    def _build_create_kwargs(self, request: GenerateRequest) -> dict[str, Any]:
        resolved = resolve_request_defaults(request)
        images = request.image_parts()
        content: str | list[dict[str, Any]]
        if images:
            # Anthropic's documented ordering: image blocks before the text
            # block they relate to.
            content = [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": image.media_type,
                        "data": image.data,
                    },
                }
                for image in images
            ]
            content.append({"type": "text", "text": request.prompt})
        else:
            content = request.prompt
        kwargs: dict[str, Any] = {
            "model": self._resolve_model(request),
            "max_tokens": resolved["max_tokens"],
            "temperature": resolved["temperature"],
            "top_p": resolved["top_p"],
            "messages": [{"role": "user", "content": content}],
        }
        if request.system_prompt:
            kwargs["system"] = request.system_prompt
        return kwargs

    def _apply_structured_output(self, kwargs: dict[str, Any], request: GenerateRequest) -> bool:
        """Force a single-tool response for ``json_schema`` requests (the
        Anthropic-native structured-output path, matching ``bedrock.py``).
        Returns True when tool-forcing was applied so the caller extracts the
        tool ``input`` instead of a text block."""
        rf = request.response_format
        if rf is None or rf.type != "json_schema" or not rf.json_schema:
            return False
        name = rf.json_schema.get("title", "output")
        kwargs["tools"] = [
            {
                "name": name,
                "description": "Structured output schema",
                "input_schema": rf.json_schema,
            }
        ]
        kwargs["tool_choice"] = {"type": "tool", "name": name}
        return True

    @staticmethod
    def _extract(message: Any, tool_forced: bool) -> tuple[str, str]:
        """Return (content, reasoning) from a Messages-API response object."""
        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        tool_input: dict[str, Any] | None = None
        for block in message.content or []:
            btype = getattr(block, "type", None)
            if btype == "text":
                text_parts.append(getattr(block, "text", "") or "")
            elif btype == "thinking":
                reasoning_parts.append(getattr(block, "thinking", "") or "")
            elif btype == "tool_use" and tool_input is None:
                tool_input = getattr(block, "input", None)
        if tool_forced and tool_input is not None:
            return json.dumps(tool_input), "".join(reasoning_parts)
        return "".join(text_parts), "".join(reasoning_parts)

    def _build_stats(
        self,
        *,
        model: str,
        raw_stop_reason: str | None,
        input_tokens: int,
        output_tokens: int,
        total_ms: int,
        ttft_ms: int | None = None,
        raw_usage: Any = None,
    ) -> GenerationStats:
        # Anthropic's ``input_tokens`` EXCLUDES the cache counts, so a usage blob
        # without ``cache_read_input_tokens`` / ``cache_creation_input_tokens``
        # under-reports the input total by the whole cached prefix. When the SDK
        # usage object is available it is preserved verbatim (TTL split included);
        # otherwise fall back to the two headline counts.
        native_usage = (
            anthropic_usage_dict(raw_usage)
            if raw_usage is not None
            else {"input_tokens": input_tokens, "output_tokens": output_tokens}
        )
        stats = build_generation_stats(
            provider=_PROVIDER_NAME,
            model=model,
            raw_stop_reason=raw_stop_reason,
            prompt_tokens=input_tokens,
            predicted_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
            total_ms=total_ms,
            ttft_ms=ttft_ms,
            engine_native={
                "usage": native_usage,
                "stop_reason": raw_stop_reason,
            },
        )
        # Supply the correct normalized reason for the Anthropic vocabulary while
        # keeping the truthful native token in ``stop_reason_raw``.
        normalized = _ANTHROPIC_STOP.get((raw_stop_reason or "").lower())
        if normalized is not None:
            stats = stats.model_copy(update={"stop_reason": normalized})
        return stats

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
            kwargs = self._build_create_kwargs(request)
            tool_forced = self._apply_structured_output(kwargs, request)

            start = time.monotonic()
            message = await self._client_for(request).messages.create(**kwargs)
            total_ms = int((time.monotonic() - start) * 1000)

            content, reasoning = self._extract(message, tool_forced)
            usage_obj = getattr(message, "usage", None)
            input_tokens = getattr(usage_obj, "input_tokens", 0) or 0
            output_tokens = getattr(usage_obj, "output_tokens", 0) or 0
            raw_stop = getattr(message, "stop_reason", None)

            stats = self._build_stats(
                model=resolved_model,
                raw_stop_reason=raw_stop,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                total_ms=total_ms,
                raw_usage=usage_obj,
            )
            span.set_attribute("gen_ai.usage.input_tokens", input_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", output_tokens)
            span.set_attribute("gen_ai.response.finish_reason", raw_stop or "end_turn")
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
            kwargs = self._build_create_kwargs(request)
            kwargs["stream"] = True

            # DRAIN to completion (AD-1): input tokens arrive on ``message_start``,
            # output tokens + stop_reason on ``message_delta``; accumulate both,
            # measure TTFT at the first text/thinking delta, then emit ONE
            # ``usage`` chunk followed by ``done``.
            start = time.monotonic()
            ttft_ms: int | None = None
            input_tokens = 0
            output_tokens = 0
            raw_stop: str | None = None
            # ``message_start`` carries the input + CACHE counts for the whole
            # request; ``message_delta`` only restates output. Keeping the start
            # usage as the base is what preserves the cache breakdown — deltas
            # would otherwise overwrite it with a cache-less object.
            stream_usage: dict[str, Any] | None = None

            stream = await self._client_for(request).messages.create(**kwargs)
            async for event in stream:
                etype = getattr(event, "type", None)
                if etype == "message_start":
                    usage = getattr(getattr(event, "message", None), "usage", None)
                    input_tokens = getattr(usage, "input_tokens", input_tokens) or input_tokens
                    if usage is not None:
                        stream_usage = anthropic_usage_dict(usage)
                elif etype == "content_block_delta":
                    delta = getattr(event, "delta", None)
                    dtype = getattr(delta, "type", None)
                    if dtype == "thinking_delta":
                        text = getattr(delta, "thinking", "") or ""
                        if text:
                            if ttft_ms is None:
                                ttft_ms = int((time.monotonic() - start) * 1000)
                            yield StreamChunk(type="reasoning", content=text)
                    elif dtype == "text_delta":
                        text = getattr(delta, "text", "") or ""
                        if text:
                            if ttft_ms is None:
                                ttft_ms = int((time.monotonic() - start) * 1000)
                            yield StreamChunk(type="chunk", content=text)
                elif etype == "message_delta":
                    usage = getattr(event, "usage", None)
                    # CUMULATIVE, not incremental — take the latest value, never
                    # accumulate. Summing the deltas multiplies the output count
                    # by the number of deltas.
                    output_tokens = getattr(usage, "output_tokens", output_tokens) or output_tokens
                    delta = getattr(event, "delta", None)
                    raw_stop = getattr(delta, "stop_reason", raw_stop)

            total_ms = int((time.monotonic() - start) * 1000)
            if stream_usage is not None:
                stream_usage["output_tokens"] = output_tokens
            stats = self._build_stats(
                model=resolved_model,
                raw_stop_reason=raw_stop,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                total_ms=total_ms,
                ttft_ms=ttft_ms,
                raw_usage=stream_usage,
            )
            span.set_attribute("gen_ai.usage.input_tokens", input_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", output_tokens)
            span.set_attribute("gen_ai.response.finish_reason", raw_stop or "end_turn")
            yield StreamChunk(type="usage", data=stats.model_dump())
            yield StreamChunk(type="done", data={"finish_reason": raw_stop or "end_turn"})

    async def health_check(self) -> bool:
        # No platform key ⇒ no shared client to probe (still BYOK-usable
        # per request via an override).
        if self._client is None:
            return False
        try:
            # A minimal, cheap round-trip; any successful response proves auth.
            await self._client.models.list(limit=1)
            return True
        except (APIError, APIConnectionError, APITimeoutError) as exc:
            logger.warning("health_check.failed", provider=_PROVIDER_NAME, error=str(exc))
            return False
        except Exception as exc:
            logger.error("health_check.unexpected_error", provider=_PROVIDER_NAME, error=str(exc))
            return False

    async def get_info(self) -> ProviderInfo:
        # Default_model is informational-only (may be unset now that
        # cloud configs carry no compiled-in vendor model) — never advertise an
        # empty-named model.
        models: list[ModelInfo] = (
            [ModelInfo(name=self._default_model, supports_streaming=True)]
            if self._default_model
            else []
        )
        status = "available"
        # No platform key ⇒ unavailable at the platform level (still
        # BYOK-usable per request).
        if self._client is None:
            return ProviderInfo(
                name=_PROVIDER_NAME,
                display_name="Anthropic",
                status="unavailable",
                default_model=self._default_model,
                models=models,
                supports_streaming=True,
                supports_vision=True,
            )
        try:
            listing = await self._client.models.list(limit=100)
            models = [ModelInfo(name=m.id, supports_streaming=True) for m in listing.data]
        except (APIError, APIConnectionError, APITimeoutError) as exc:
            logger.warning("get_info.failed", provider=_PROVIDER_NAME, error=str(exc))
            status = "unavailable"
        except Exception as exc:
            logger.error("get_info.unexpected_error", provider=_PROVIDER_NAME, error=str(exc))
            status = "unavailable"
        return ProviderInfo(
            name=_PROVIDER_NAME,
            display_name="Anthropic",
            status=status,
            default_model=self._default_model,
            models=models,
            supports_streaming=True,
            supports_vision=True,
        )
