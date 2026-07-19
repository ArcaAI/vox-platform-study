"""Generic OpenAI-compatible LLM provider — works with LM Studio, vLLM, TGI, Groq, etc."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import structlog
from openai import APIConnectionError, APIError, APITimeoutError, AsyncOpenAI

from smr_v2.core.config import OpenAICompatConfig
from smr_v2.core.defaults import resolve_request_defaults
from smr_v2.core.telemetry import get_tracer
from smr_v2.models.provider import ModelInfo, ProviderInfo
from smr_v2.models.requests import GenerateRequest
from smr_v2.models.stats import GenerationStats, stats_from_openai_usage
from smr_v2.models.stream import StreamChunk

if TYPE_CHECKING:
    from opentelemetry.trace import Tracer

logger = structlog.get_logger(__name__)


def _get_tracer() -> Tracer:
    return get_tracer(__name__)


class OpenAICompatProvider:
    """Generic provider for any OpenAI-compatible API server."""

    def __init__(
        self,
        config: OpenAICompatConfig,
        *,
        provider_name: str = "openai_compat",
        display_name: str = "OpenAI Compatible",
    ) -> None:
        self._config = config
        self._default_model = config.default_model
        # Engine identity — subclasses (vLLM, TASK-513) override so stats/spans
        # /get_info carry the real engine name, not the generic wire name.
        self._provider_name = provider_name
        self._display_name = display_name
        self._client = AsyncOpenAI(
            api_key=config.api_key.get_secret_value(),
            base_url=config.base_url,
            organization=config.organization,
            timeout=float(config.timeout_s),
        )

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        # D-7 (TASK-356): no in-gateway default — the caller-supplied model is
        # authoritative. ``_default_model`` is retained for the providers
        # listing (informational) only.
        return request.model

    def _build_messages(self, request: GenerateRequest) -> list[dict[str, str]]:
        messages = []
        if request.system_prompt:
            messages.append({"role": "system", "content": request.system_prompt})
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

            start = time.monotonic()
            response = await self._client.chat.completions.create(**kwargs)
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

            # DRAIN the stream to completion (AD-1): the finish chunk arrives
            # BEFORE the ``stream_options.include_usage`` usage-only chunk, so an
            # early-return on the finish drops usage → zeroed streaming metrics.
            # Accumulate the finish reason + trailing usage, measure TTFT at the
            # first content/reasoning delta, then emit ONE ``usage`` chunk carrying
            # the full AD-1 stats followed by ``done``.
            start = time.monotonic()
            ttft_ms: int | None = None
            finish_reason: str | None = None
            usage: dict[str, int] | None = None

            stream = await self._client.chat.completions.create(**kwargs)
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
            logger.error("health_check.unexpected_error", provider=self._provider_name, error=str(exc))
            return False

    async def get_info(self) -> ProviderInfo:
        models: list[ModelInfo] = []
        status = "unavailable"
        try:
            model_list = await self._client.models.list()
            for m in model_list.data:
                models.append(ModelInfo(name=m.id, supports_streaming=True))
            status = "available"
        except Exception:
            pass
        return ProviderInfo(
            name=self._provider_name,
            display_name=self._display_name,
            status=status,
            default_model=self._default_model,
            models=models,
            supports_streaming=True,
        )
