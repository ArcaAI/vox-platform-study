"""Google Vertex AI (Gemini) LLM provider — first-class tenant-BYO provider.

Maps Text's ``generate``/``generate_stream`` contract onto the ``google-genai``
Vertex client. A Vertex client is bound to a ``(project, location)`` pair; the
tenant BYO credential is a service-account JSON (``ProviderOverride.api_key``)
plus its ``project``/``location``. Mirrors the request-scoped, override-wins
client pattern of ``azure_openai.py``/``bedrock.py``; the platform fallback
client is built from its OWN explicit service-account credential and is absent
when none is configured — there is no Application Default Credentials fallback.
"""

from __future__ import annotations

import base64
import json
import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import structlog
from google import genai
from google.genai import types
from google.oauth2 import service_account

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
from text.models.usage import vertex_usage_dict
from text.providers.base import CredentialPosture, require_model
from text.providers.clients import CLIENT_CACHE, client_key
from text.providers.pool import TransportFamily, pooled_http_client

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


def _credentials_from_service_account(raw: str) -> Any:
    """Build scoped Google credentials from a service-account JSON document.

    Raises whatever ``json``/``google.oauth2`` raises — the callers turn that
    into a typed ``ProviderCredentialsError`` WITHOUT the key in the message.
    """
    return service_account.Credentials.from_service_account_info(
        json.loads(raw), scopes=[_CLOUD_PLATFORM_SCOPE]
    )


class VertexProvider:
    """Google Vertex AI provider using the google-genai SDK."""

    credential_posture = CredentialPosture.BYOK

    #: Google's own default region, used when a connection pins a project but no
    #: location. A property of the Vertex API, not a deployment choice.
    DEFAULT_LOCATION = "us-central1"

    def __init__(self) -> None:
        """No configuration, and NO Application Default Credentials.

        The service-account credential AND its `(project, location)` binding all
        arrive per request as a gateway-resolved ``ProviderOverride``. There is no
        shared client, so two tenants can never race on one.

        This adapter used to hold `genai.Client(vertexai=True, project=...,
        location=...)` with no `credentials=`, which resolves through Google ADC —
        `GOOGLE_APPLICATION_CREDENTIALS`, a gcloud login, or GCE metadata. That
        ambient identity appeared in no config surface and could not be revoked
        through the provider plane; removing the config field removes the only
        path that could construct such a client.
        """

    def _resolve_override(self, request: GenerateRequest) -> ProviderOverride | None:
        """The connection the gateway resolved for THIS request's provider."""
        return resolve_connection(request)

    def _client_for(self, request: GenerateRequest) -> Any:
        """Request-scoped, fail-closed client bound to the connection's project.

        A credential that cannot be parsed RAISES. It used to fall through to the
        platform client while ``funding`` stayed ``tenant``, so a tenant whose key
        was revoked kept generating on the platform's Google account, billed as
        BYOK. A broken tenant credential must surface as an error the tenant can
        fix, never as platform spend attributed to them.

        The service-account key is NEVER logged and never appears in the raised
        message: only the exception TYPE is recorded.
        """
        override = self._resolve_override(request)
        if override is None:
            raise ProviderConnectionMissingError(
                "No Google Vertex AI connection resolved. Vertex is BYOK-only: "
                "configure a tenant Vertex credential, or the platform "
                "(SYSTEM-tenant) connection, in the provider-connection plane. "
                "There is no env fallback and no Application Default Credentials "
                "fallback.",
                provider=_PROVIDER_NAME,
            )
        project = (override.project or "").strip()
        if not project:
            raise ProviderConnectionMissingError(
                "No GCP project on the resolved Vertex connection. A Vertex "
                "client is bound to a (project, location), so both travel with "
                "the service-account key on the AiProviderConnection row.",
                provider=_PROVIDER_NAME,
            )
        secret = override.api_key.get_secret_value()
        location = override.location or self.DEFAULT_LOCATION
        try:
            credentials = _credentials_from_service_account(secret)
        except Exception as exc:  # noqa: BLE001 — never leak the key
            logger.warning(
                "vertex.override_client_build_failed",
                provider=_PROVIDER_NAME,
                error=type(exc).__name__,
            )
            raise ProviderCredentialsError(
                "The configured Vertex AI credential could not be used "
                f"({type(exc).__name__}). It must be a Google service-account "
                "JSON key. The request is refused rather than served on another "
                "credential, which would misattribute the spend.",
                provider=_PROVIDER_NAME,
            ) from exc
        # A Vertex client is bound to a (project, location) as well as a
        # credential, so all three are part of its identity: one service account
        # used in two regions is two clients, not one reused across them.
        key = client_key(_PROVIDER_NAME, f"{project}|{location}", secret)
        return CLIENT_CACHE.get_or_create(
            key,
            lambda: genai.Client(
                vertexai=True,
                project=project,
                location=location,
                credentials=credentials,
                # TASK-959 §4.1 — Vertex joins the POOL. Without this the SDK
                # builds its own client, so a Vertex call got none of `pool.py`'s
                # per-upstream limits, none of its connection reuse, and — since
                # the byte counters live in that transport — no network metering
                # at all. Injecting the client also settles WHICH stack the SDK
                # uses: `google-genai` prefers aiohttp when it is installed, and
                # `_use_aiohttp()` is false precisely when a custom async httpx
                # client is supplied, so this both measures and pins the path.
                #
                # `HTTPX` (not `HTTPX2`): `AsyncHttpxClient` subclasses
                # `httpx.AsyncClient`, and the two families are structurally
                # identical and silently incompatible (`pool.py` docstring).
                http_options=types.HttpOptions(
                    httpx_async_client=pooled_http_client(
                        _PROVIDER_NAME,
                        timeout_s=PROVIDER_TIMEOUT_FLOOR_S,
                        family=TransportFamily.HTTPX,
                    )
                ),
            ),
        )

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        # No in-gateway default — the caller-supplied model is authoritative,
        # unless the resolved connection pins one. Provider/model SELECTION is
        # failMode=closed: a missing model raises via `require_model` in
        # generate/generate_stream rather than being substituted.
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
        """Nothing to probe: credential and project are per request, so there is
        no process-level GCP project to reach.

        Returns True — "no negative evidence". `PoolHealthTracker` acts only on a
        POSITIVELY known-unhealthy result (`services/pool_health.py`).
        """
        return True

    async def get_info(self) -> ProviderInfo:
        """Adapter capabilities only — no probe.

        The model catalogue comes from `AiModel` on the gateway; this adapter
        used to echo ``TEXT_VERTEX_DEFAULT_MODEL``, an env var no generation path
        ever read.
        """
        return ProviderInfo(
            name=_PROVIDER_NAME,
            display_name="Google Vertex AI",
            status="unavailable",
            default_model="",
            models=[],
            supports_streaming=True,
            supports_vision=True,
        )
