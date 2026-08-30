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
from anthropic import AsyncAnthropic

from text.core.connection import resolve_connection
from text.core.defaults import resolve_request_defaults
from text.core.exceptions import (
    ProviderConnectionMissingError,
    ProviderCredentialsError,
)
from text.core.runtime_defaults import PROVIDER_TIMEOUT_FLOOR_S
from text.core.telemetry import get_tracer
from text.models.provider import ProviderInfo
from text.models.requests import GenerateRequest, ProviderOverride
from text.models.stats import GenerationStats, build_generation_stats
from text.models.stream import StreamChunk
from text.models.usage import anthropic_usage_dict
from text.providers.base import CredentialPosture, require_model
from text.providers.clients import CLIENT_CACHE, client_key
from text.providers.pool import pooled_http_client

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

    def __init__(self) -> None:
        """No configuration. Anthropic is BYOK-only and Text holds no connection
        of its own: the credential (and any proxy base URL) arrive per request as
        a gateway-resolved ``ProviderOverride``.

        There is no client on this INSTANCE: clients live in the process-wide
        `CLIENT_CACHE`, keyed by `(provider, base_url, credential fingerprint)`,
        so two tenants still never share one while two requests on the same
        connection reuse one (B-2). Anthropic is also the adapter where reuse
        matters most beyond TLS: its prompt cache is byte-exact on the prefix
        (4.4), so a stable connection is part of keeping cache reads warm.
        """
        self._timeout_s = PROVIDER_TIMEOUT_FLOOR_S

    def apply_timeout(self, timeout_s: int) -> None:
        """Adopt the control-plane per-provider request timeout (see
        `services/runtime_limits.py`). Replaces ``TEXT_ANTHROPIC_TIMEOUT_S``."""
        self._timeout_s = timeout_s

    def _resolve_override(self, request: GenerateRequest) -> ProviderOverride | None:
        """The connection the gateway resolved for THIS request's provider."""
        return resolve_connection(request)

    def _client_for(self, request: GenerateRequest) -> AsyncAnthropic:
        """Connection-scoped, fail-closed client resolution. A MALFORMED override
        raises rather than degrading onto a process-wide credential, and a failed
        build is never cached. The key is NEVER logged."""
        override = self._resolve_override(request)
        if override is None:
            raise ProviderConnectionMissingError(
                "No Anthropic connection resolved. Anthropic is BYOK-only: "
                "configure a tenant Anthropic credential, or the platform "
                "(SYSTEM-tenant) connection, in the provider-connection plane. "
                "There is no env fallback.",
                provider=_PROVIDER_NAME,
            )
        secret = override.api_key.get_secret_value()
        key = client_key(_PROVIDER_NAME, override.base_url, secret)
        try:
            return CLIENT_CACHE.get_or_create(
                key,
                lambda: AsyncAnthropic(
                    api_key=secret,
                    base_url=override.base_url or None,
                    timeout=float(self._timeout_s),
                    http_client=pooled_http_client(_PROVIDER_NAME, timeout_s=self._timeout_s),
                ),
            )
        except Exception as exc:  # noqa: BLE001 — never leak the key
            logger.warning(
                "anthropic.override_client_build_failed",
                provider=_PROVIDER_NAME,
                error=type(exc).__name__,
            )
            raise ProviderCredentialsError(
                "The configured Anthropic credential could not be used "
                f"({type(exc).__name__}). The request is refused rather than "
                "served on another tenant's or the platform's credential.",
                provider=_PROVIDER_NAME,
            ) from exc

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
        """Nothing to probe: the connection is per request, so there is no
        process-level endpoint to reach.

        Returns True — "no negative evidence" — deliberately. `PoolHealthTracker`
        acts only on a POSITIVELY known-unhealthy result
        (`services/pool_health.py`), so reporting False here would take a
        perfectly usable BYOK provider out of degrade routing for every tenant
        that carries its own working credential.
        """
        return True

    async def get_info(self) -> ProviderInfo:
        """Adapter capabilities only — no probe. See `OpenAIProvider.get_info`."""
        return ProviderInfo(
            name=_PROVIDER_NAME,
            display_name="Anthropic",
            status="unavailable",
            default_model="",
            models=[],
            supports_streaming=True,
            supports_vision=True,
        )
