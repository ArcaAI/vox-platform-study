"""Generic OpenAI-compatible LLM provider — works with LM Studio, vLLM, TGI, Groq, etc."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import httpx
import structlog
from openai import APIConnectionError, APIError, APITimeoutError, AsyncOpenAI

from text.core.config import OpenAICompatConfig
from text.core.defaults import resolve_request_defaults
from text.core.retention import DEFAULT_RETENTION_TTL_S, clamp_cache_ttl_seconds
from text.core.telemetry import get_tracer
from text.models.provider import ModelInfo, ProviderInfo
from text.models.requests import GenerateRequest, ProviderOverride
from text.models.stats import GenerationStats, stats_from_openai_usage
from text.models.stream import StreamChunk
from text.models.usage import openai_usage_dict
from text.providers.base import CredentialPosture

if TYPE_CHECKING:
    from opentelemetry.trace import Tracer

logger = structlog.get_logger(__name__)

# `main.py` registers the LM Studio instance under BOTH keys with
# the DEFAULT `provider_name`, so the native-REST enrichment below is attempted
# for both. Engine subclasses (vLLM) carry their own `provider_name` and are
# excluded — they have no `/api/v0` surface.
_LM_STUDIO_PROVIDER_NAMES = frozenset({"lm-studio", "openai_compat"})

# Short, self-contained budget for the OPTIONAL native listing probe. The
# endpoint-level `asyncio.wait_for` caps the whole `get_info`; this keeps the
# enrichment from consuming that entire budget and losing the `/v1` result.
_NATIVE_PROBE_TIMEOUT_S = 3.0


def _native_probe_client() -> httpx.AsyncClient:
    """Factory for the native-probe transport (patched in tests)."""
    return httpx.AsyncClient(timeout=_NATIVE_PROBE_TIMEOUT_S)


def _get_tracer() -> Tracer:
    return get_tracer(__name__)


class OpenAICompatProvider:
    """Generic provider for any OpenAI-compatible API server."""

    # An operator-run engine reached by topology base_url (LM Studio by default),
    # so there is no vendor credential to fail closed on. It still honours a tenant
    # override — see `_client_for`.
    credential_posture = CredentialPosture.SELF_HOST

    def __init__(
        self,
        config: OpenAICompatConfig,
        *,
        provider_name: str = "openai_compat",
        display_name: str = "OpenAI Compatible",
    ) -> None:
        self._config = config
        self._default_model = config.default_model
        # Engine identity — subclasses (vLLM, ) override so stats/spans
        # /get_info carry the real engine name, not the generic wire name.
        self._provider_name = provider_name
        self._display_name = display_name
        # Bootstrap retention hint; replaced by the
        # control-plane value on the first effective-config refresh.
        self._retention_ttl_s = clamp_cache_ttl_seconds(DEFAULT_RETENTION_TTL_S)
        self._client = AsyncOpenAI(
            api_key=config.api_key.get_secret_value(),
            base_url=config.base_url,
            organization=config.organization,
            timeout=float(config.timeout_s),
        )

    def _resolve_override(self, request: GenerateRequest) -> ProviderOverride | None:
        """Tenant BYO credential/endpoint injected by the gateway for THIS provider,
        keyed by ``request.provider`` (see `ProviderOverride`).

        A self-host engine has no VENDOR credential, but a tenant may still front
        its own OpenAI-compatible endpoint with its own key. Until TASK-799 this
        adapter had no override path at all, so ``TEXT_OPENAI_COMPAT_API_KEY`` (and
        the inherited ``TEXT_VLLM_API_KEY``) was the only way to set a key — a
        process-wide env credential that no tenant could ever override, which is
        exactly the shape §Configuration Principles forbids. The env path is now
        closed (dead ``validation_alias``, see `OpenAICompatConfig.api_key`) and
        this is the way in.
        """
        if not request.provider_overrides:
            return None
        return request.provider_overrides.get(request.provider)

    def _client_for(self, request: GenerateRequest) -> AsyncOpenAI:
        """Override-wins client resolution. A tenant credential builds a
        request-scoped client (the shared client is never mutated) so concurrent
        requests for different tenants can never interfere.

        Unlike the BYOK cloud adapters there is no fail-closed branch: a
        self-host engine is reachable on its topology ``base_url`` without a
        vendor credential, so absent an override the shared client stands.
        """
        override = self._resolve_override(request)
        if override is None:
            return self._client
        return AsyncOpenAI(
            api_key=override.api_key.get_secret_value(),
            base_url=override.base_url or self._config.base_url,
            organization=self._config.organization,
            timeout=float(self._config.timeout_s),
        )

    def apply_retention(self, retention: dict[str, int]) -> None:
        """Adopt the control-plane idle-retention TTL.

        An absent key keeps the current (env/bootstrap) value; the product clamp
        [60, 3600] is re-applied here as well as registry-side.
        """
        ttl_seconds = retention.get("ttl_seconds")
        if ttl_seconds is not None:
            self._retention_ttl_s = clamp_cache_ttl_seconds(ttl_seconds)

    def _apply_retention_hint(self, kwargs: dict[str, Any]) -> None:
        """Attach LM Studio's JIT `ttl`, and ONLY for LM Studio.

        This class is shared with vLLM and generic OpenAI-compatible endpoints,
        which reject unknown body fields — so the hint is gated on the engine
        identity, not merely "is openai-compatible". `extra_body` is the OpenAI
        SDK's sanctioned ride-along for non-standard fields.
        """
        if self._provider_name != "lm-studio":
            return
        kwargs["extra_body"] = {"ttl": self._retention_ttl_s}

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
            # engine_native: OpenAI ``usage`` + the LM-Studio ``stats`` blob when the
            # server includes it (extra field, dict-shaped) — audit-only, never billed.
            native: dict[str, Any] = {"usage": usage}
            lm_stats = getattr(response, "stats", None)
            if isinstance(lm_stats, dict):
                native["lm_studio_stats"] = lm_stats
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
        try:
            await self._client.models.list()
            return True
        except (APIError, APIConnectionError, APITimeoutError, ConnectionError, OSError) as exc:
            logger.warning("health_check.failed", provider=self._provider_name, error=str(exc))
            return False
        except Exception as exc:
            logger.error(
                "health_check.unexpected_error", provider=self._provider_name, error=str(exc)
            )
            return False

    async def _lm_studio_native_models(self) -> dict[str, dict[str, Any]]:
        """LM Studio's native REST listing, keyed by model id.

        `/v1/models` (OpenAI wire) carries no load state, but LM Studio also
        serves `GET {root}/api/v0/models` with `state` / `quantization` /
        `max_context_length` on the SAME host — the AsyncOpenAI client cannot
        reach it (it prefixes `/v1`), so this uses a plain httpx call against
        `base_url` minus its trailing `/v1`.

        ANY failure returns `{}`: enrichment is strictly best-effort and must
        never degrade or fail the `/v1/models` listing.
        """
        root = self._config.base_url.rstrip("/")
        if root.endswith("/v1"):
            root = root[: -len("/v1")].rstrip("/")
        try:
            async with _native_probe_client() as client:
                resp = await client.get(f"{root}/api/v0/models")
            if resp.status_code != 200:
                return {}
            return {m["id"]: m for m in resp.json().get("data", []) if m.get("id")}
        except Exception as exc:  # noqa: BLE001 — best-effort enrichment
            logger.warning(
                "get_info.native_probe_failed", provider=self._provider_name, error=str(exc)
            )
            return {}

    async def get_info(self) -> ProviderInfo:
        models: list[ModelInfo] = []
        status = "unavailable"
        try:
            model_list = await self._client.models.list()
            for m in model_list.data:
                models.append(ModelInfo(name=m.id, supports_streaming=True))
            status = "available"
        except (APIError, APIConnectionError, APITimeoutError, ConnectionError, OSError) as exc:
            # Narrower than a bare `except Exception: pass` so diagnostics
            # aren't swallowed. Mirrors `health_check` above.
            logger.warning("get_info.failed", provider=self._provider_name, error=str(exc))
        except Exception as exc:
            logger.error("get_info.unexpected_error", provider=self._provider_name, error=str(exc))

        if models and self._provider_name in _LM_STUDIO_PROVIDER_NAMES:
            native = await self._lm_studio_native_models()
            for model in models:
                meta = native.get(model.name)
                if not meta:
                    continue
                model.state = meta.get("state")
                model.engine_native = meta

        return ProviderInfo(
            name=self._provider_name,
            display_name=self._display_name,
            status=status,
            default_model=self._default_model,
            models=models,
            supports_streaming=True,
            supports_vision=True,
        )
