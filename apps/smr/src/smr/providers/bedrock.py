"""AWS Bedrock LLM provider — uses boto3 + asyncio.to_thread for async compat."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import boto3
import botocore.session
import structlog
from botocore.config import Config as BotocoreConfig
from botocore.exceptions import BotoCoreError, ClientError, EndpointConnectionError
from botocore.tokens import FrozenAuthToken

from smr.core.config import BedrockConfig
from smr.core.defaults import resolve_request_defaults
from smr.core.telemetry import get_tracer
from smr.models.provider import ModelInfo, ProviderInfo
from smr.models.requests import GenerateRequest, ProviderOverride
from smr.models.stats import GenerationStats, stats_from_bedrock
from smr.models.stream import StreamChunk
from smr.providers.base import require_model

if TYPE_CHECKING:
    from opentelemetry.trace import Tracer

logger = structlog.get_logger(__name__)


def _get_tracer() -> Tracer:
    return get_tracer(__name__)


class _StaticBearerTokenProvider:
    """A botocore token provider that always resolves to one fixed token.

    A tenant's BYO Bedrock credential is a single ``api_key`` string — the
    AWS "Bedrock API key" bearer-token auth, not a SigV4 access/secret key
    pair — so overriding it means handing botocore a token *provider*, not a
    static credential. Scoped to a dedicated ``botocore.session.Session``
    built fresh per request (never the process-wide default session or an
    env var), so two tenants' overrides on concurrent requests can never
    race each other.
    """

    def __init__(self, token: str) -> None:
        self._token = token

    def load_token(self, **_kwargs: Any) -> FrozenAuthToken:
        return FrozenAuthToken(token=self._token)


class BedrockProvider:
    """AWS Bedrock provider using boto3 converse / converse_stream APIs."""

    def __init__(self, config: BedrockConfig) -> None:
        self._config = config
        self._default_model = config.default_model
        self._client = boto3.client(
            "bedrock-runtime",
            region_name=config.region,
        )
        self._mgmt_client = boto3.client(
            "bedrock",
            region_name=config.region,
        )

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        # No in-gateway default — the caller-supplied model is
        # authoritative. ``_default_model`` is retained for the providers
        # listing (informational) only.
        return request.model

    def _resolve_override(self, request: GenerateRequest) -> ProviderOverride | None:
        """Tenant BYO credential injected by the gateway for THIS provider,
        keyed by ``request.provider`` (see `ProviderOverride`). ``None`` for
        every caller until a tenant configures an enabled bedrock connection —
        current (env/config) behavior is unchanged in that case."""
        if not request.provider_overrides:
            return None
        return request.provider_overrides.get(request.provider)

    def _client_for(self, request: GenerateRequest) -> Any:
        """Override-wins client resolution. A tenant credential builds a
        request-scoped bearer-token client (the shared/env-configured
        ``self._client`` is never mutated) so concurrent requests for
        different tenants can never interfere; absent an override, the
        shared client is reused unchanged."""
        override = self._resolve_override(request)
        if override is None:
            return self._client
        # A dedicated session per request: botocore has no public API to bind a
        # bearer token to one client instance, so this registers a scoped
        # token-provider component directly (see _StaticBearerTokenProvider).
        session = botocore.session.Session()
        # botocore-stubs doesn't type this private attribute.
        session._components.register_component(  # type: ignore[attr-defined]
            "token_provider", _StaticBearerTokenProvider(override.api_key.get_secret_value())
        )
        return boto3.Session(botocore_session=session).client(
            "bedrock-runtime",
            region_name=override.region or self._config.region,
            config=BotocoreConfig(signature_version="bearer"),
        )

    def _build_converse_params(self, request: GenerateRequest) -> dict[str, Any]:
        resolved = resolve_request_defaults(request)
        params: dict[str, Any] = {
            "modelId": self._resolve_model(request),
            "messages": [{"role": "user", "content": [{"text": request.prompt}]}],
            "inferenceConfig": {
                "temperature": resolved["temperature"],
                "maxTokens": resolved["max_tokens"],
                "topP": resolved["top_p"],
            },
        }
        if request.system_prompt:
            params["system"] = [{"text": request.system_prompt}]

        if request.response_format is not None and request.response_format.type == "json_schema":
            schema = request.response_format.json_schema or {}
            params["toolConfig"] = {
                "tools": [
                    {
                        "toolSpec": {
                            "name": schema.get("title", "output"),
                            "description": "Structured output schema",
                            "inputSchema": {"json": schema},
                        }
                    }
                ],
                "toolChoice": {"tool": {"name": schema.get("title", "output")}},
            }

        if self._config.guardrail_id:
            params["guardrailConfig"] = {
                "guardrailIdentifier": self._config.guardrail_id,
                "guardrailVersion": self._config.guardrail_version,
            }

        return params

    async def generate(self, request: GenerateRequest) -> tuple[str, str, GenerationStats]:
        resolved = resolve_request_defaults(request)
        resolved_model = require_model(self._resolve_model(request), provider="bedrock")
        with _get_tracer().start_as_current_span(
            "gen_ai.generate",
            attributes={
                "gen_ai.system": "aws_bedrock",
                "gen_ai.request.model": resolved_model,
                "gen_ai.operation.name": "generate",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            params = self._build_converse_params(request)
            client = self._client_for(request)
            start = time.monotonic()
            response = await asyncio.to_thread(client.converse, **params)
            total_ms = int((time.monotonic() - start) * 1000)

            stop_reason = response.get("stopReason", "")
            if stop_reason == "guardrail_intervened":
                logger.warning(
                    "bedrock.guardrail_intervened",
                    model=params["modelId"],
                    guardrail_id=self._config.guardrail_id,
                )

            content_blocks = response["output"]["message"]["content"]
            content = "".join(block.get("text", "") for block in content_blocks)
            # ReasoningContentBlockOutputTypeDef nests the text under "reasoningText"
            # (unlike the streaming delta variant, which has a flat "text" field).
            reasoning = "".join(
                block.get("reasoningContent", {}).get("reasoningText", {}).get("text", "")
                for block in content_blocks
            )

            raw_usage: dict[str, Any] = dict(response.get("usage", {}))
            stats = stats_from_bedrock(
                provider="bedrock",
                model=resolved_model,
                usage=raw_usage,
                stop_reason=stop_reason,
                total_ms=total_ms,
                engine_native={"usage": raw_usage, "stopReason": stop_reason},
            )
            span.set_attribute("gen_ai.usage.input_tokens", stats.prompt_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", stats.predicted_tokens)
            span.set_attribute("gen_ai.response.finish_reason", stop_reason or "stop")
            return content, reasoning, stats

    async def generate_stream(self, request: GenerateRequest) -> AsyncIterator[StreamChunk]:
        resolved = resolve_request_defaults(request)
        resolved_model = require_model(self._resolve_model(request), provider="bedrock")
        with _get_tracer().start_as_current_span(
            "gen_ai.generate_stream",
            attributes={
                "gen_ai.system": "aws_bedrock",
                "gen_ai.request.model": resolved_model,
                "gen_ai.operation.name": "generate_stream",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            params = self._build_converse_params(request)
            client = self._client_for(request)

            loop = asyncio.get_running_loop()
            queue: asyncio.Queue[Any] = asyncio.Queue()
            _SENTINEL = object()

            def _iterate_stream() -> None:
                """Run in thread — iterates boto3 sync stream, pushes to queue."""
                try:
                    response = client.converse_stream(**params)
                    for event in response["stream"]:
                        loop.call_soon_threadsafe(queue.put_nowait, event)
                    loop.call_soon_threadsafe(queue.put_nowait, _SENTINEL)
                except Exception as exc:
                    loop.call_soon_threadsafe(queue.put_nowait, exc)

            thread_future = loop.run_in_executor(None, _iterate_stream)

            # DRAIN to completion (AD-1): the ``messageStop`` (stopReason) event
            # arrives BEFORE the ``metadata`` (usage) event, so yielding ``done``
            # at ``messageStop`` emits done→usage (wrong order) and drops usage
            # from the stats. Accumulate stop reason + usage across the whole
            # stream, measure TTFT at the first content/reasoning delta, then emit
            # ONE ``usage`` chunk (full AD-1 stats) followed by ``done``.
            start = time.monotonic()
            ttft_ms: int | None = None
            stop_reason: str | None = None
            raw_usage: dict[str, Any] = {}
            try:
                while True:
                    event = await queue.get()
                    if event is _SENTINEL:
                        break
                    if isinstance(event, Exception):
                        raise event

                    if "contentBlockDelta" in event:
                        delta = event["contentBlockDelta"]["delta"]
                        reasoning_text = delta.get("reasoningContent", {}).get("text", "")
                        if reasoning_text:
                            if ttft_ms is None:
                                ttft_ms = int((time.monotonic() - start) * 1000)
                            yield StreamChunk(type="reasoning", content=reasoning_text)
                        text = delta.get("text", "")
                        if text:
                            if ttft_ms is None:
                                ttft_ms = int((time.monotonic() - start) * 1000)
                            yield StreamChunk(type="chunk", content=text)
                    elif "messageStop" in event:
                        stop_reason = event["messageStop"].get("stopReason", stop_reason)
                    elif "metadata" in event:
                        raw_usage = event["metadata"].get("usage", {}) or {}
            finally:
                await thread_future

            total_ms = int((time.monotonic() - start) * 1000)
            stats = stats_from_bedrock(
                provider="bedrock",
                model=resolved_model,
                usage=raw_usage,
                stop_reason=stop_reason,
                total_ms=total_ms,
                ttft_ms=ttft_ms,
                engine_native=(
                    {"usage": raw_usage, "stopReason": stop_reason}
                    if raw_usage or stop_reason
                    else None
                ),
            )
            if raw_usage:
                span.set_attribute("gen_ai.usage.input_tokens", raw_usage.get("inputTokens", 0))
                span.set_attribute("gen_ai.usage.output_tokens", raw_usage.get("outputTokens", 0))
            span.set_attribute("gen_ai.response.finish_reason", stop_reason or "stop")
            yield StreamChunk(type="usage", data=stats.model_dump())
            yield StreamChunk(type="done", data={"finish_reason": stop_reason or "stop"})

    async def health_check(self) -> bool:
        try:
            await asyncio.to_thread(self._mgmt_client.list_foundation_models)
            return True
        except (ClientError, BotoCoreError, EndpointConnectionError) as exc:
            logger.warning("health_check.failed", provider="bedrock", error=str(exc))
            return False
        except Exception as exc:
            logger.error("health_check.unexpected_error", provider="bedrock", error=str(exc))
            return False

    async def get_info(self) -> ProviderInfo:
        models: list[ModelInfo] = []
        status = "unavailable"
        try:
            resp = await asyncio.to_thread(self._mgmt_client.list_foundation_models)
            for m in resp.get("modelSummaries", []):
                models.append(ModelInfo(name=m["modelId"], supports_streaming=True))
            status = "available"
        except (ClientError, BotoCoreError, EndpointConnectionError) as exc:
            logger.warning("get_info.failed", provider="bedrock", error=str(exc))
        except Exception as exc:
            logger.error("get_info.unexpected_error", provider="bedrock", error=str(exc))
        return ProviderInfo(
            name="bedrock",
            display_name="AWS Bedrock",
            status=status,
            default_model=self._default_model,
            models=models,
            supports_streaming=True,
        )
