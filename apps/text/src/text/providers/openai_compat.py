"""Generic OpenAI-compatible LLM provider — the PORTABILITY adapter.

Any server that speaks the OpenAI chat-completions wire (TGI, Groq, a
llama.cpp `llama-server` on its `/v1` surface, an unknown vendor) is reachable
through this class under the ``openai_compat`` registry key.

It is deliberately WIRE-ONLY: nothing here may assume a particular engine.
Engine-specific affordances live in a subclass that carries its own identity —
`providers/vllm.py` (`/health`, `/metrics`, `guided_json`) and
`providers/lmstudio.py` (the `ttl` retention hint, the native `/api/v0/models`
listing, the non-standard `stats` blob). Two hooks below are the seam:
``_apply_retention_hint`` and ``_engine_native`` are no-ops here, and
``_enrich_models`` returns the `/v1/models` listing untouched.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import structlog
from openai import APIConnectionError, APIError, APITimeoutError, AsyncOpenAI

from text.core.connection import require_connection
from text.core.defaults import resolve_request_defaults
from text.core.retention import DEFAULT_RETENTION_TTL_S, clamp_cache_ttl_seconds
from text.core.runtime_defaults import PROVIDER_TIMEOUT_FLOOR_S
from text.core.telemetry import get_tracer
from text.models.probe import ProbeConnection
from text.models.provider import ModelInfo, ProviderInfo
from text.models.requests import GenerateRequest, ProviderOverride
from text.models.stats import GenerationStats, stats_from_openai_usage
from text.models.stream import StreamChunk
from text.models.usage import openai_usage_dict
from text.providers.base import CredentialPosture
from text.providers.clients import CLIENT_CACHE, client_key
from text.providers.pool import TransportFamily, pooled_http_client

if TYPE_CHECKING:
    from opentelemetry.trace import Tracer

logger = structlog.get_logger(__name__)


def _get_tracer() -> Tracer:
    return get_tracer(__name__)


class OpenAICompatProvider:
    """Generic provider for any OpenAI-compatible API server."""

    # An operator-run engine reached by topology base_url, so there is no vendor
    # credential to fail closed on. It still honours a tenant override — see
    # `_client_for`.
    credential_posture = CredentialPosture.SELF_HOST

    def __init__(
        self,
        *,
        provider_name: str = "openai_compat",
        display_name: str = "OpenAI Compatible",
    ) -> None:
        """No configuration. The engine endpoint and its key arrive per request
        as a gateway-resolved ``ProviderOverride`` (`core/connection.py`).

        ``TEXT_OPENAI_COMPAT_API_KEY`` (and the inherited ``TEXT_VLLM_API_KEY``)
        used to be the ONLY way to set a key for this adapter — a process-wide
        credential no tenant could override, which is exactly the shape
        §Configuration Principles forbids. There is no shared client any more, so
        two tenants fronting different OpenAI-compatible endpoints can never
        collide on one.
        """
        # Engine identity — subclasses (vLLM) override so stats/spans/get_info
        # carry the real engine name, not the generic wire name.
        self._provider_name = provider_name
        self._display_name = display_name
        self._last_base_url: str | None = None
        self._timeout_s = PROVIDER_TIMEOUT_FLOOR_S
        # Bootstrap retention hint; replaced by the
        # control-plane value on the first effective-config refresh.
        self._retention_ttl_s = clamp_cache_ttl_seconds(DEFAULT_RETENTION_TTL_S)

    def apply_timeout(self, timeout_s: int) -> None:
        """Adopt the control-plane per-provider request timeout (see
        `services/runtime_limits.py`). Replaces ``TEXT_OPENAI_COMPAT_TIMEOUT_S``,
        and unlike it can change without a restart."""
        self._timeout_s = timeout_s

    def _resolve_override(self, request: GenerateRequest) -> ProviderOverride | None:
        """The connection the gateway resolved for THIS request's provider."""
        from text.core.connection import resolve_connection

        return resolve_connection(request)

    def _probe_url(self) -> str | None:
        """The engine this process last talked to, or ``None``.

        The admin probes have no request, so there is no connection to resolve.
        Reporting on the last endpoint observed keeps `/providers` and `/health`
        meaningful for a platform-run engine (one SYSTEM-tenant row, one address)
        without ever inventing one.
        """
        return self._last_base_url

    def _client_at(self, base_url: str, api_key: str = "") -> AsyncOpenAI:
        """The ONE place this adapter builds a client, and it takes its endpoint
        as an ARGUMENT.

        V-6 (TASK-818 A-5) is about exactly this seam. `_last_base_url` is a
        process-wide memo of the endpoint this process last SERVED from — accurate
        for a platform engine with one SYSTEM-tenant row, and meaningless the
        moment two tenants front their own. It was never used to route a
        generation, but the only thing preventing that was that no construction
        site happened to read it. Now none *can*: this function does not see the
        memo, and every caller — generation, admin probe, connection-scoped
        discovery — states the endpoint it means.

        Clients are cached (B-2). `openai_compat` is `SELF_HOST`, so a KEYLESS row
        (the normal local shape) keys on `base_url` alone and has no BYOK cost to
        pay. When the row DOES carry a tenant credential — which this adapter
        documents that it honours — the credential is part of the key, because two
        tenants fronting one endpoint with different credentials sharing a client
        would be a cross-tenant credential substitution on the cheapest path in
        the service.
        """
        key = client_key(self._provider_name, base_url, api_key)
        return CLIENT_CACHE.get_or_create(
            key,
            lambda: AsyncOpenAI(
                api_key=api_key or "not-needed",
                base_url=base_url,
                timeout=float(self._timeout_s),
                http_client=pooled_http_client(
                    self._provider_name,
                    timeout_s=self._timeout_s,
                    family=TransportFamily.HTTPX2,
                ),
            ),
        )

    def _probe_client(self) -> AsyncOpenAI | None:
        """A client for the last-observed endpoint, or ``None`` if none was seen.

        A distinct seam from `_client_for` because it answers a different
        question: `_client_for` serves a REQUEST and therefore has a connection
        to build from, while the admin probes have neither. Keeping it a method
        also gives tests one place to stand a fake engine up.

        The memo is read HERE, at the one call site that legitimately has no
        request — never inside `_client_at`.
        """
        probe_url = self._probe_url()
        if probe_url is None:
            return None
        return self._client_at(probe_url)

    def _client_for(self, request: GenerateRequest) -> AsyncOpenAI:
        """Connection-scoped, fail-closed client resolution.

        A self-hosted engine needs no VENDOR credential, but it does need an
        address, and Text no longer holds one. The connection row supplies both;
        for a keyless local server the row carries whatever placeholder that
        server expects (LM Studio's ``not-needed``), because a row with no key
        injects on neither tier by design.
        """
        connection = require_connection(request, provider=self._provider_name)
        base_url = (connection.base_url or "").strip()
        if not base_url:
            from text.core.exceptions import ProviderConnectionMissingError

            raise ProviderConnectionMissingError(
                f"No base_url on the resolved connection for " f"'{self._provider_name}'.",
                provider=self._provider_name,
            )
        # The memo is WRITTEN here (the admin probes have no other source) but is
        # never read back by the construction seam above.
        self._last_base_url = base_url
        return self._client_at(base_url, connection.api_key.get_secret_value())

    def apply_retention(self, retention: dict[str, int]) -> None:
        """Adopt the control-plane idle-retention TTL.

        An absent key keeps the current (env/bootstrap) value; the product clamp
        [60, 3600] is re-applied here as well as registry-side.
        """
        ttl_seconds = retention.get("ttl_seconds")
        if ttl_seconds is not None:
            self._retention_ttl_s = clamp_cache_ttl_seconds(ttl_seconds)

    def _apply_retention_hint(self, kwargs: dict[str, Any]) -> None:
        """Hook: attach the engine's server-side idle-retention directive.

        NO-OP here, and that is the safe default: a generic OpenAI-wire server
        400s on an unknown body field, so an engine only opts in by overriding
        this (today: `providers/lmstudio.py`, which sends LM Studio's `ttl`).

        This used to be an ``if self._provider_name != "lm-studio": return``
        guard on this class — which never fired, because `main.py` registered
        the LM Studio key against an instance built with the DEFAULT
        ``provider_name``. An engine capability gated on a string the instance
        does not carry is a capability nobody has; a subclass cannot be wrong
        about which engine it is.
        """

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        # No in-gateway default — the caller-supplied model is
        # authoritative. ``_default_model`` is retained for the providers
        # listing (informational) only.
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

    def _engine_native(self, response: Any, usage: dict[str, Any]) -> dict[str, Any]:
        """Hook: the audit-only engine-native blob attached to `GenerationStats`.

        The OpenAI ``usage`` object is all the wire guarantees. An engine that
        returns more (LM Studio's non-standard ``stats``) adds it in its own
        subclass, so the generic adapter never carries a key named after an
        engine it is not talking to.
        """
        return {"usage": usage}

    def _apply_response_format(self, kwargs: dict[str, Any], request: GenerateRequest) -> None:
        """Inject the structured-output directive into the create() kwargs.

        Default = the standard OpenAI ``response_format`` wire. Subclasses
        (vLLM) override to add engine-specific routing (e.g. ``guided_json``).
        """
        if request.response_format is None:
            return
        if request.response_format.type == "json_schema" and request.response_format.json_schema:
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": request.response_format.json_schema.get("title", "output"),
                    "schema": request.response_format.json_schema,
                    "strict": request.response_format.strict,
                },
            }
        elif request.response_format.type == "json":
            kwargs["response_format"] = {"type": "json_object"}

    async def generate(self, request: GenerateRequest) -> tuple[str, str, GenerationStats]:
        resolved = resolve_request_defaults(request)
        resolved_model = self._resolve_model(request)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate",
            attributes={
                "gen_ai.system": self._provider_name,
                "gen_ai.request.model": resolved_model or "",
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
            self._apply_retention_hint(kwargs)

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
            # engine_native: the provider's OWN usage object, plus whatever the
            # engine subclass can add (`_engine_native`) — audit-only, never billed.
            native = self._engine_native(response, usage)
            stats = stats_from_openai_usage(
                provider=self._provider_name,
                model=resolved_model or "",
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
        with _get_tracer().start_as_current_span(
            "gen_ai.generate_stream",
            attributes={
                "gen_ai.system": self._provider_name,
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

            self._apply_response_format(kwargs, request)
            self._apply_retention_hint(kwargs)

            # DRAIN the stream to completion (AD-1): the finish chunk arrives
            # BEFORE the ``stream_options.include_usage`` usage-only chunk, so an
            # early-return on the finish drops usage → zeroed streaming metrics.
            # Accumulate the finish reason + trailing usage, measure TTFT at the
            # first content/reasoning delta, then emit ONE ``usage`` chunk carrying
            # the full AD-1 stats followed by ``done``.
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
                provider=self._provider_name,
                model=self._resolve_model(request) or "",
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
        """Probe the last-observed endpoint.

        Returns True when none has been observed yet — "no negative evidence".
        `PoolHealthTracker` acts only on a POSITIVELY known-unhealthy result
        (`services/pool_health.py`), so a freshly booted process must not report
        an engine it has simply not contacted yet as DOWN.
        """
        probe_client = self._probe_client()
        if probe_client is None:
            return True
        try:
            await probe_client.models.list()
            return True
        except (APIError, APIConnectionError, APITimeoutError, ConnectionError, OSError) as exc:
            logger.warning("health_check.failed", provider=self._provider_name, error=str(exc))
            return False
        except Exception as exc:
            logger.error(
                "health_check.unexpected_error", provider=self._provider_name, error=str(exc)
            )
            return False

    async def _enrich_models(self, models: list[ModelInfo], base_url: str | None) -> None:
        """Hook: decorate a `/v1/models` listing with engine-native metadata.

        NO-OP here — the OpenAI wire carries no load state and a generic server
        has no second listing route to ask. `providers/lmstudio.py` overrides it
        to read LM Studio's native `/api/v0/models`.

        Whatever an override does, it is STRICTLY best-effort: enrichment must
        never degrade or fail the `/v1/models` listing it decorates.
        """

    def _info(self, status: str, models: list[ModelInfo]) -> ProviderInfo:
        return ProviderInfo(
            name=self._provider_name,
            display_name=self._display_name,
            status=status,
            # The default model comes from `AiTaskDefault` on the gateway. This
            # adapter used to echo ``TEXT_OPENAI_COMPAT_DEFAULT_MODEL``, whose
            # value had to match an id LM Studio actually served — a hardcoded
            # engine-specific string in a config file, which is how a stale
            # `-qat` suffix once 400ed every request that reached the default.
            default_model="",
            models=models,
            supports_streaming=True,
            supports_vision=True,
        )

    async def _list_models(self, client: AsyncOpenAI, base_url: str | None) -> ProviderInfo:
        """`GET {base_url}/models` (OpenAI wire), plus `_enrich_models`.

        The one listing body shared by the memo probe (`get_info`) and the
        connection-scoped one (`discover_models`); they differ ONLY in which
        client and endpoint they hand in, so an engine cannot be enumerated one
        way here and another way there.
        """
        models: list[ModelInfo] = []
        status = "unavailable"
        try:
            model_list = await client.models.list()
            for m in model_list.data:
                models.append(ModelInfo(name=m.id, supports_streaming=True))
            status = "available"
        except (APIError, APIConnectionError, APITimeoutError, ConnectionError, OSError) as exc:
            # Narrower than a bare `except Exception: pass` so diagnostics
            # aren't swallowed. Mirrors `health_check` above.
            logger.warning("get_info.failed", provider=self._provider_name, error=str(exc))
        except Exception as exc:
            logger.error("get_info.unexpected_error", provider=self._provider_name, error=str(exc))

        if models:
            await self._enrich_models(models, base_url)

        return self._info(status, models)

    async def get_info(self) -> ProviderInfo:
        probe_client = self._probe_client()
        if probe_client is None:
            # Nothing observed yet — no endpoint to list models from. The
            # catalogue is authoritative on the gateway (`AiModel`) regardless.
            return self._info("unavailable", [])
        return await self._list_models(probe_client, self._probe_url())

    async def discover_models(self, connection: ProbeConnection) -> ProviderInfo:
        """Enumerate the engine the GATEWAY resolved for this caller.

        Deliberately does not touch ``_last_base_url``: this describes an engine,
        it must never re-point the endpoint a concurrently-serving generation
        remembers. A keyless connection is the normal self-hosted shape — the
        OpenAI SDK requires a non-empty ``api_key`` string, so the same
        ``not-needed`` placeholder ``_client_for`` uses stands in, and the probe
        goes out unauthenticated.
        """
        base_url = connection.base_url.strip()
        key = connection.api_key.get_secret_value() if connection.api_key else ""
        return await self._list_models(self._client_at(base_url, key), base_url)
