"""Google Vertex AI (Gemini) LLM provider — first-class tenant-BYO provider.

Maps SMR's ``generate``/``generate_stream`` contract onto the ``google-genai``
Vertex client. A Vertex client is bound to a ``(project, location)`` pair; the
tenant BYO credential is a service-account JSON (``ProviderOverride.api_key``)
plus its ``project``/``location``. Mirrors the request-scoped, override-wins
client pattern of ``azure_openai.py``/``bedrock.py``; the platform fallback
client authenticates with Application Default Credentials.
"""

from __future__ import annotations

import base64
import json
import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import structlog
from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from google.oauth2 import service_account

from text.core.config import VertexConfig
from text.core.defaults import resolve_request_defaults
from text.core.telemetry import get_tracer
from text.models.provider import ModelInfo, ProviderInfo
from text.models.requests import GenerateRequest, ProviderOverride
from text.models.stats import GenerationStats, build_generation_stats
from text.models.stream import StreamChunk
from text.models.usage import vertex_usage_dict
from text.providers.base import require_model

if TYPE_CHECKING:
    from opentelemetry.trace import Tracer

logger = structlog.get_logger(__name__)

_PROVIDER_NAME = "vertex"
_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"

# Gemini ``FinishReason`` → AD-1 ``StopReason``. The shared table (stats.py)
# has no ``vertex`` entry; the true native reason is preserved in
# ``stop_reason_raw`` while this map supplies the normalized value.
_VERTEX_STOP: dict[str, str] = {
    "stop": "stop",
    "max_tokens": "length",
    "safety": "content_filter",
    "blocklist": "content_filter",
    "prohibited_content": "content_filter",
    "spii": "content_filter",
    "recitation": "other",
    "malformed_function_call": "tool_call",
}


def _get_tracer() -> Tracer:
    return get_tracer(__name__)


class VertexProvider:
    """Google Vertex AI provider using the google-genai SDK."""

    def __init__(self, config: VertexConfig) -> None:
        self._config = config
        self._default_model = config.default_model
        # The shared, env-configured PLATFORM fallback client (ADC-authenticated,
        # bound to the env project/location). ``None`` when no project is
        # configured — the provider is then usable only with a tenant override.
        self._client: Any = None
        if config.project:
            self._client = genai.Client(
                vertexai=True,
                project=config.project,
                location=config.location,
            )

    def _resolve_override(self, request: GenerateRequest) -> ProviderOverride | None:
        """Tenant BYO credential injected by the gateway for THIS provider,
        keyed by ``request.provider``. ``None`` for every caller until a tenant
        configures an enabled vertex connection."""
        if not request.provider_overrides:
            return None
        return request.provider_overrides.get(request.provider)

    def _client_for(self, request: GenerateRequest) -> Any:
        """Override-wins client resolution. A tenant service-account credential
        builds a request-scoped client bound to the tenant's project/location
        (the shared ``self._client`` is never mutated). Fail-OPEN: a credential
        that cannot be parsed/built degrades to the shared env client rather
        than failing the request; the SA key is NEVER logged."""
        override = self._resolve_override(request)
        if override is None:
            return self._client
        try:
            sa_info = json.loads(override.api_key.get_secret_value())
            credentials = service_account.Credentials.from_service_account_info(
                sa_info, scopes=[_CLOUD_PLATFORM_SCOPE]
            )
            return genai.Client(
                vertexai=True,
                project=override.project or self._config.project,
                location=override.location or self._config.location,
                credentials=credentials,
            )
        except Exception as exc:  # noqa: BLE001 — fail-open, never leak the key
            logger.warning(
                "vertex.override_client_build_failed",
                provider=_PROVIDER_NAME,
                error=type(exc).__name__,
            )
            return self._client

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        # No in-gateway default — the caller-supplied model is
        # authoritative. ``_default_model`` is retained for the providers
        # listing (informational) only and is NEVER substituted into a
        # generation request (provider/model SELECTION is failMode=closed —
        # a missing model raises via `require_model` in generate/generate_stream).
        override = self._resolve_override(request)
        if override is not None and override.model:
            return override.model
        return request.model

    def _build_config(self, request: GenerateRequest) -> types.GenerateContentConfig:
        resolved = resolve_request_defaults(request)
        cfg_kwargs: dict[str, Any] = {
            "temperature": resolved["temperature"],
            "max_output_tokens": resolved["max_tokens"],
            "top_p": resolved["top_p"],
        }
        if request.system_prompt:
            cfg_kwargs["system_instruction"] = request.system_prompt
        rf = request.response_format
        if rf is not None and rf.type in ("json", "json_schema"):
            # JSON mode (best-effort). A raw JSON-Schema dict is intentionally
            # NOT forwarded as ``response_schema`` — Gemini's schema type is
            # narrower than JSON-Schema and a mismatch would fail the generation.
            cfg_kwargs["response_mime_type"] = "application/json"
        return types.GenerateContentConfig(**cfg_kwargs)

    def _build_contents(self, request: GenerateRequest) -> Any:
        """``contents`` for ``generate_content``/``generate_content_stream``.

        A bare prompt string (unchanged) when there is no image; otherwise a
        list of parts — the ``google-genai`` SDK auto-wraps a list of
        strings/``Part``s into a single user-role ``Content``.
        """
        images = request.image_parts()
        if not images:
            return request.prompt
        parts: list[Any] = [
            types.Part.from_bytes(data=base64.b64decode(image.data), mime_type=image.media_type)
            for image in images
        ]
        parts.append(request.prompt)
        return parts

    @staticmethod
    def _raw_finish_reason(response: Any) -> str | None:
        candidates = getattr(response, "candidates", None) or []
        if not candidates:
            return None
        fr = getattr(candidates[0], "finish_reason", None)
        if fr is None:
            return None
        return getattr(fr, "name", None) or str(fr)

    def _build_stats(
        self,
        *,
        model: str,
        raw_stop_reason: str | None,
        usage: Any,
        total_ms: int,
        ttft_ms: int | None = None,
    ) -> GenerationStats:
        prompt_tokens = getattr(usage, "prompt_token_count", 0) or 0
        predicted_tokens = getattr(usage, "candidates_token_count", 0) or 0
        total_tokens = getattr(usage, "total_token_count", None)
        stats = build_generation_stats(
            provider=_PROVIDER_NAME,
            model=model,
            raw_stop_reason=raw_stop_reason,
            prompt_tokens=prompt_tokens,
            predicted_tokens=predicted_tokens,
            total_tokens=(
                total_tokens if total_tokens is not None else prompt_tokens + predicted_tokens
            ),
            total_ms=total_ms,
            ttft_ms=ttft_ms,
            # The usage blob is emitted in Google's JSON WIRE spelling (not the
            # SDK's snake_case), because that is what the billing normalizer
            # parses — and it carries `thoughtsTokenCount`, which Vertex reports
            # OUTSIDE `candidatesTokenCount` (the Gemini API reports it inside).
            engine_native={
                "usage": vertex_usage_dict(usage),
                "finish_reason": raw_stop_reason,
            },
        )
        normalized = _VERTEX_STOP.get((raw_stop_reason or "").lower())
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
            client = self._client_for(request)
            config = self._build_config(request)

            start = time.monotonic()
            response = await client.aio.models.generate_content(
                model=resolved_model,
                contents=self._build_contents(request),
                config=config,
            )
            total_ms = int((time.monotonic() - start) * 1000)

            content = getattr(response, "text", None) or ""
            raw_stop = self._raw_finish_reason(response)
            usage = getattr(response, "usage_metadata", None)
            stats = self._build_stats(
                model=resolved_model,
                raw_stop_reason=raw_stop,
                usage=usage,
                total_ms=total_ms,
            )
            span.set_attribute("gen_ai.usage.input_tokens", stats.prompt_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", stats.predicted_tokens)
            span.set_attribute("gen_ai.response.finish_reason", raw_stop or "stop")
            return content, "", stats

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
            client = self._client_for(request)
            config = self._build_config(request)

            # DRAIN to completion (AD-1): usage_metadata + finish_reason land on
            # the trailing chunk(s); keep the latest of each, measure TTFT at the
            # first text delta, then emit ONE ``usage`` chunk followed by ``done``.
            start = time.monotonic()
            ttft_ms: int | None = None
            raw_stop: str | None = None
            usage: Any = None

            stream = await client.aio.models.generate_content_stream(
                model=resolved_model,
                contents=self._build_contents(request),
                config=config,
            )
            async for chunk in stream:
                text = getattr(chunk, "text", None)
                if text:
                    if ttft_ms is None:
                        ttft_ms = int((time.monotonic() - start) * 1000)
                    yield StreamChunk(type="chunk", content=text)
                chunk_usage = getattr(chunk, "usage_metadata", None)
                if chunk_usage is not None:
                    usage = chunk_usage
                chunk_stop = self._raw_finish_reason(chunk)
                if chunk_stop is not None:
                    raw_stop = chunk_stop

            total_ms = int((time.monotonic() - start) * 1000)
            stats = self._build_stats(
                model=resolved_model,
                raw_stop_reason=raw_stop,
                usage=usage,
                total_ms=total_ms,
                ttft_ms=ttft_ms,
            )
            span.set_attribute("gen_ai.usage.input_tokens", stats.prompt_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", stats.predicted_tokens)
            span.set_attribute("gen_ai.response.finish_reason", raw_stop or "stop")
            yield StreamChunk(type="usage", data=stats.model_dump())
            yield StreamChunk(type="done", data={"finish_reason": raw_stop or "stop"})

    async def health_check(self) -> bool:
        if self._client is None:
            # No platform fallback configured — available only via tenant override.
            return False
        try:
            await self._client.aio.models.list(config={"page_size": 1})
            return True
        except (genai_errors.APIError, ConnectionError, OSError) as exc:
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
        status = "available" if self._client is not None else "unavailable"
        return ProviderInfo(
            name=_PROVIDER_NAME,
            display_name="Google Vertex AI",
            status=status,
            default_model=self._default_model,
            models=models,
            supports_streaming=True,
            supports_vision=True,
        )
