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
from openai import AsyncOpenAI

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
from text.models.stats import GenerationStats, stats_from_openai_usage
from text.models.stream import StreamChunk
from text.models.usage import openai_usage_dict
from text.providers.base import CredentialPosture, require_model
from text.providers.clients import CLIENT_CACHE, client_key
from text.providers.pool import TransportFamily, pooled_http_client

if TYPE_CHECKING:
    from opentelemetry.trace import Tracer

logger = structlog.get_logger(__name__)

_PROVIDER_NAME = "openai"


def _get_tracer() -> Tracer:
    return get_tracer(__name__)


class OpenAIProvider:
    """OpenAI provider using the openai Python SDK (``AsyncOpenAI``)."""

    credential_posture = CredentialPosture.BYOK

    def __init__(self) -> None:
        """No configuration. OpenAI is BYOK-only and Text holds no connection of
        its own: the credential and (for an OpenAI-compatible gateway) the base
        URL arrive per request as a gateway-resolved ``ProviderOverride``.

        There is no client on this INSTANCE. Clients live in the process-wide
        `CLIENT_CACHE`, keyed by `(provider, base_url, credential fingerprint)` —
        so two tenants still never share one, while two requests on the same
        connection reuse one instead of paying a fresh TLS handshake each
        (B-2). See `providers/clients.py` for why that key is the exact
        predicate the isolation property needs.
        """
        self._timeout_s = PROVIDER_TIMEOUT_FLOOR_S

    def apply_timeout(self, timeout_s: int) -> None:
        """Adopt the control-plane per-provider request timeout.

        Pushed by `services/runtime_limits.py` on each config refresh, the same
        way `apply_retention` pushes the retention TTL. Replaces the retired
        ``TEXT_OPENAI_TIMEOUT_S``, and unlike it can change without a restart.
        """
        self._timeout_s = timeout_s

    def _resolve_override(self, request: GenerateRequest) -> ProviderOverride | None:
        """The connection the gateway resolved for THIS request's provider."""
        return resolve_connection(request)

    def _client_for(self, request: GenerateRequest) -> AsyncOpenAI:
        """Connection-scoped, fail-closed client resolution.

        There is no shared platform client to degrade onto, so a MALFORMED
        override raises instead of silently running the request on a process-wide
        credential — the outcome that made a revoked tenant key look like it still
        worked. The key is NEVER logged, and never becomes part of a cache key
        (`clients.py` fingerprints it).

        A build failure is deliberately NOT cached, so a transient failure cannot
        become a permanent one.
        """
        override = self._resolve_override(request)
        if override is None:
            raise ProviderConnectionMissingError(
                "No OpenAI connection resolved. OpenAI is BYOK-only: configure a "
                "tenant OpenAI credential, or the platform (SYSTEM-tenant) "
                "connection, in the provider-connection plane. There is no env "
                "fallback.",
                provider=_PROVIDER_NAME,
            )
        secret = override.api_key.get_secret_value()
        key = client_key(_PROVIDER_NAME, override.base_url, secret)
        try:
            return CLIENT_CACHE.get_or_create(
                key,
                lambda: AsyncOpenAI(
                    api_key=secret,
                    base_url=override.base_url or None,
                    timeout=float(self._timeout_s),
                    http_client=pooled_http_client(
                        _PROVIDER_NAME,
                        timeout_s=self._timeout_s,
                        family=TransportFamily.HTTPX2,
                    ),
                ),
            )
        except Exception as exc:  # noqa: BLE001 — never leak the key
            logger.warning(
                "openai.override_client_build_failed",
                provider=_PROVIDER_NAME,
                error=type(exc).__name__,
            )
            raise ProviderCredentialsError(
                "The configured OpenAI credential could not be used "
                f"({type(exc).__name__}). The request is refused rather than "
                "served on another tenant's or the platform's credential.",
                provider=_PROVIDER_NAME,
            ) from exc

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        # override-wins: a tenant override MAY pin the model; otherwise the
        # caller-supplied model is authoritative. ``_default_model`` is
        # informational (providers listing) only.
        override = self._resolve_override(request)
        if override is not None and override.model:
            return override.model
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
        """Adapter capabilities only — no probe.

        A BYOK provider has no process-level connection to reach, so there is
        nothing here to contact. The MODEL listing and the default model come
        from `AiModel` and the gateway's resolved selection, which is where they were
        already authoritative: this adapter used to echo ``TEXT_OPENAI_DEFAULT_
        MODEL``, an env var no generation path ever read.
        """
        return ProviderInfo(
            name=_PROVIDER_NAME,
            display_name="OpenAI",
            status="unavailable",
            default_model="",
            models=[],
            supports_streaming=True,
            supports_vision=True,
        )
