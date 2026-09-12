"""AWS Bedrock LLM provider — uses boto3 + asyncio.to_thread for async compat."""

from __future__ import annotations

import asyncio
import base64
import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any, Literal

import boto3
import botocore.session
import structlog
from botocore.config import Config as BotocoreConfig
from botocore.tokens import FrozenAuthToken

from text.core.connection import resolve_connection
from text.core.defaults import resolve_request_defaults
from text.core.exceptions import InputValidationError, ProviderConnectionMissingError
from text.core.telemetry import get_tracer
from text.models.provider import ProviderInfo
from text.models.requests import GenerateRequest, ImageContentPart, ProviderOverride
from text.models.stats import GenerationStats, stats_from_bedrock
from text.models.stream import StreamChunk
from text.providers.base import CredentialPosture, require_model
from text.providers.clients import CLIENT_CACHE, client_key
from text.providers.pool import (
    bedrock_stream_executor,
    current_byte_counts,
    run_in_bedrock_executor,
    with_byte_counts,
)

if TYPE_CHECKING:
    from opentelemetry.trace import Tracer

logger = structlog.get_logger(__name__)

# Bedrock Converse ``ImageBlock.format`` — the vendor's closed enum.
_BEDROCK_IMAGE_FORMATS: dict[str, str] = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/jpg": "jpeg",
    "image/gif": "gif",
    "image/webp": "webp",
}


def _bedrock_image_block(part: ImageContentPart) -> dict[str, Any]:
    fmt = _BEDROCK_IMAGE_FORMATS.get(part.media_type.lower())
    if fmt is None:
        raise InputValidationError(
            f"Bedrock does not support image media type '{part.media_type}' — "
            f"supported: {sorted(set(_BEDROCK_IMAGE_FORMATS.values()))}."
        )
    return {"image": {"format": fmt, "source": {"bytes": base64.b64decode(part.data)}}}


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


# ── Network bytes without a transport to hook (TASK-959 §4.1) ────────────────
#
# Every other adapter in this service reaches its vendor through
# `pooled_http_client`, so `providers/pool.py`'s transport counts its bytes.
# Bedrock is botocore, not httpx, and it never will be on that pool — so it gets
# the equivalent from botocore's OWN event system, credited into the same
# per-request record the pooled transport uses.
#
# `before-send` carries the prepared request, whose `body` is the serialized
# JSON. `response-received` carries a response dict whose `body` is the response
# BYTES for a normal operation — and, for an operation with a streaming output
# shape (`converse_stream`), the UNREAD event stream. Reading that to size it
# would consume the generation, so it is not read: the request is counted, the
# response is not, and `usage_detail` answers `response_bytes: None` rather than
# a zero that would read as "the vendor sent nothing". That is §4.2's documented
# blind spot, stated where it is created.
#
# The hooks are registered on the CLIENT, which is cached and shared by every
# request on the same (region, credential) — so registration happens once, in the
# factory, and attribution comes from the contextvar, which `with_byte_counts`
# carries into the Bedrock worker thread the SDK actually runs on.

#: Botocore event prefixes, wildcard over every operation of the service: one
#: registration covers `Converse` and `ConverseStream` and anything added later.
_BEFORE_SEND_EVENT = "before-send.bedrock-runtime"
_RESPONSE_RECEIVED_EVENT = "response-received.bedrock-runtime"


def _count_request_bytes(request: Any = None, **_kwargs: Any) -> None:
    """Count the prepared request's body. MUST return ``None``.

    A `before-send` handler that returns anything else REPLACES the HTTP call
    with its return value (that is how botocore's stubber works), so a metering
    hook that accidentally returned a truthy value would silently stop every
    Bedrock generation from reaching AWS.
    """
    counts = current_byte_counts()
    if counts is None:
        return
    body = getattr(request, "body", None)
    counts.add_request(len(body) if isinstance(body, (bytes, bytearray)) else 0)


def _count_response_bytes(response_dict: Any = None, **_kwargs: Any) -> None:
    """Count the response body when it is bytes; never consume a stream."""
    counts = current_byte_counts()
    if counts is None or not isinstance(response_dict, dict):
        return
    body = response_dict.get("body")
    if isinstance(body, (bytes, bytearray)):
        counts.add_response(len(body))
        return
    # A streaming body. `Content-Length` is absent on a chunked event stream, so
    # this is the non-streaming-but-not-buffered case, not a second guess at the
    # stream's size.
    headers = response_dict.get("headers") or {}
    declared = headers.get("content-length") if hasattr(headers, "get") else None
    try:
        if declared is not None:
            counts.add_response(max(0, int(declared)))
    except (TypeError, ValueError):
        return


def _register_byte_hooks(client: Any) -> Any:
    """Attach the byte hooks to one freshly built client, and return it."""
    client.meta.events.register(_BEFORE_SEND_EVENT, _count_request_bytes)
    client.meta.events.register(_RESPONSE_RECEIVED_EVENT, _count_response_bytes)
    return client


def _bearer_client(
    service: Literal["bedrock-runtime", "bedrock"], *, token: str, region: str
) -> Any:
    """A boto3 client bound to ONE explicit bearer token.

    Every Bedrock client in this module is built here, platform and tenant alike,
    so there is exactly one construction site and it always takes a credential.
    The session is dedicated (never the process-wide default session), so two
    tenants' concurrent requests can never race each other's token.
    """
    session = botocore.session.Session()
    # botocore-stubs doesn't type this private attribute.
    session._components.register_component(  # type: ignore[attr-defined]
        "token_provider", _StaticBearerTokenProvider(token)
    )
    return _register_byte_hooks(
        boto3.Session(botocore_session=session).client(
            service,
            region_name=region,
            config=BotocoreConfig(signature_version="bearer"),
        )
    )


class BedrockProvider:
    """AWS Bedrock provider using boto3 converse / converse_stream APIs."""

    credential_posture = CredentialPosture.BYOK

    def __init__(self) -> None:
        """No configuration, and NO AMBIENT CREDENTIAL CHAIN.

        The credential AND the region both arrive per request as a
        gateway-resolved ``ProviderOverride``. There is no shared client, so
        every request builds its own bearer-token client and two tenants can
        never race on one.

        This adapter used to hold a bare `boto3.client("bedrock-runtime", ...)`,
        which resolves credentials from `AWS_ACCESS_KEY_ID` / `AWS_PROFILE` / EC2
        instance metadata — a working PLATFORM identity that appeared in no env
        file, no `turbo.json` and no registry, on which every tenant's traffic
        silently ran. Removing the config field is what makes that unreachable:
        there is no longer any path to a client built without an explicit token.
        """

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        """The caller-supplied model is authoritative; a connection MAY pin it."""
        override = self._resolve_override(request)
        if override is not None and override.model:
            return override.model
        return request.model

    def _resolve_override(self, request: GenerateRequest) -> ProviderOverride | None:
        """The connection the gateway resolved for THIS request's provider."""
        return resolve_connection(request)

    def _client_for(self, request: GenerateRequest) -> Any:
        """Request-scoped, fail-closed bearer-token client."""
        override = self._resolve_override(request)
        if override is None:
            raise ProviderConnectionMissingError(
                "No AWS Bedrock connection resolved. Bedrock is BYOK-only: "
                "configure a tenant Bedrock credential, or the platform "
                "(SYSTEM-tenant) connection, in the provider-connection plane. "
                "There is no env fallback and no ambient AWS credential chain.",
                provider="bedrock",
            )
        region = (override.region or "").strip()
        if not region:
            raise ProviderConnectionMissingError(
                "No AWS region on the resolved Bedrock connection. A Bedrock "
                "client is bound to a region, so it travels with the credential "
                "on the AiProviderConnection row.",
                provider="bedrock",
            )
        token = override.api_key.get_secret_value()
        # Region is part of the identity: a boto3 client is bound to one, so the
        # same credential in two regions is two clients.
        key = client_key("bedrock", region, token)
        return CLIENT_CACHE.get_or_create(
            key,
            lambda: _bearer_client("bedrock-runtime", token=token, region=region),
        )

    def _build_converse_params(self, request: GenerateRequest) -> dict[str, Any]:
        resolved = resolve_request_defaults(request)
        content: list[dict[str, Any]] = [{"text": request.prompt}]
        for image in request.image_parts():
            content.append(_bedrock_image_block(image))
        params: dict[str, Any] = {
            "modelId": self._resolve_model(request),
            "messages": [{"role": "user", "content": content}],
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

        # An AWS Bedrock Guardrail belongs to the AWS ACCOUNT the request
        # authenticates against, so it travels with that account's credential on
        # the connection row — never as a process-wide `TEXT_BEDROCK_GUARDRAIL_ID`
        # that would apply one tenant's guardrail to every other tenant's traffic.
        override = self._resolve_override(request)
        if override is not None and override.guardrail_id:
            params["guardrailConfig"] = {
                "guardrailIdentifier": override.guardrail_id,
                "guardrailVersion": override.guardrail_version or "DRAFT",
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
            # Same boundary as the streaming path below, for the same reason:
            # `asyncio.to_thread` runs on the DEFAULT executor, and a
            # non-streaming Bedrock generation holds its thread for the whole
            # generation — seconds, not milliseconds. Bedrock's blocking work
            # draws on Bedrock's own budget or it draws on everyone's.
            response = await run_in_bedrock_executor(lambda: client.converse(**params))
            total_ms = int((time.monotonic() - start) * 1000)

            stop_reason = response.get("stopReason", "")
            if stop_reason == "guardrail_intervened":
                logger.warning(
                    "bedrock.guardrail_intervened",
                    model=params["modelId"],
                    guardrail_id=params.get("guardrailConfig", {}).get("guardrailIdentifier"),
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

            # NOT the default executor (B-3). `_iterate_stream` holds its thread
            # for the ENTIRE stream, not for one call, so on asyncio's default
            # pool (`min(32, cpu + 4)`) roughly 32 concurrent Bedrock generations
            # stall every other `asyncio.to_thread` caller in the process — a
            # ceiling Bedrock imposes on everybody else. The dedicated pool is
            # sized from the same control-plane `maxConcurrent` that bounds this
            # provider's semaphore, so it is never the binding constraint and
            # never anyone else's problem. See `providers/pool.py`.
            thread_future = loop.run_in_executor(
                bedrock_stream_executor(),
                # TASK-959 — the botocore hooks fire on THIS thread, and
                # `run_in_executor` carries no context into it.
                with_byte_counts(_iterate_stream),
            )

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
                        if stop_reason == "guardrail_intervened":
                            # Parity with `generate()`. A guardrail intervention
                            # reaches the streaming path through the very same
                            # `stopReason` field, and it is a safety event: it
                            # must be as visible in the logs for a streamed
                            # generation as for a synchronous one.
                            logger.warning(
                                "bedrock.guardrail_intervened",
                                model=params["modelId"],
                                guardrail_id=params.get("guardrailConfig", {}).get(
                                    "guardrailIdentifier"
                                ),
                            )
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
            # The terminal frame reports the reason the STATS beside it report.
            # ``MessageStopEvent.stopReason`` is REQUIRED by the ConverseStream
            # contract, so a stream that ended without a ``messageStop`` did not
            # finish — substituting the literal ``"stop"`` here billed and
            # audited a truncated generation as a complete one, while the very
            # same frame's stats said ``"other"``. The two must never disagree.
            yield StreamChunk(type="done", data={"finish_reason": stop_reason or stats.stop_reason})

    async def health_check(self) -> bool:
        """Nothing to probe: credential and region are per request, so there is
        no process-level AWS account to reach.

        Returns True — "no negative evidence". `PoolHealthTracker` acts only on a
        POSITIVELY known-unhealthy result (`services/pool_health.py`).
        """
        return True

    async def get_info(self) -> ProviderInfo:
        """Adapter capabilities only — no probe.

        Listing Bedrock foundation models requires an AWS account to list them
        IN, and this process has none: the account arrives per request. The model
        catalogue comes from `AiModel` on the gateway.
        """
        return ProviderInfo(
            name="bedrock",
            display_name="AWS Bedrock",
            status="unavailable",
            default_model="",
            models=[],
            supports_streaming=True,
            supports_vision=True,
        )
