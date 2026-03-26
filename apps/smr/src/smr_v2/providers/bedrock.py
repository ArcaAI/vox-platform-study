"""AWS Bedrock LLM provider — uses boto3 + asyncio.to_thread for async compat."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import boto3
import structlog
from botocore.exceptions import BotoCoreError, ClientError, EndpointConnectionError

from smr_v2.core.config import BedrockConfig
from smr_v2.core.defaults import resolve_request_defaults
from smr_v2.core.telemetry import get_tracer
from smr_v2.models.provider import ModelInfo, ProviderInfo
from smr_v2.models.requests import GenerateRequest
from smr_v2.models.stream import StreamChunk

logger = structlog.get_logger(__name__)


def _get_tracer():
    return get_tracer(__name__)


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

    def _resolve_model(self, request: GenerateRequest) -> str:
        return request.model or self._default_model

    def _build_converse_params(self, request: GenerateRequest) -> dict:
        resolved = resolve_request_defaults(request)
        params: dict = {
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
                "tools": [{
                    "toolSpec": {
                        "name": schema.get("title", "output"),
                        "description": "Structured output schema",
                        "inputSchema": {"json": schema},
                    }
                }],
                "toolChoice": {"tool": {"name": schema.get("title", "output")}},
            }

        if self._config.guardrail_id:
            params["guardrailConfig"] = {
                "guardrailIdentifier": self._config.guardrail_id,
                "guardrailVersion": self._config.guardrail_version,
            }

        return params

    async def generate(self, request: GenerateRequest) -> tuple[str, dict]:
        resolved = resolve_request_defaults(request)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate",
            attributes={
                "gen_ai.system": "aws_bedrock",
                "gen_ai.request.model": self._resolve_model(request),
                "gen_ai.operation.name": "generate",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            params = self._build_converse_params(request)
            response = await asyncio.to_thread(self._client.converse, **params)

            stop_reason = response.get("stopReason", "")
            if stop_reason == "guardrail_intervened":
                logger.warning(
                    "bedrock.guardrail_intervened",
                    model=params["modelId"],
                    guardrail_id=self._config.guardrail_id,
                )

            content_blocks = response["output"]["message"]["content"]
            content = "".join(block.get("text", "") for block in content_blocks)

            raw_usage = response.get("usage", {})
            usage = {
                "prompt_tokens": raw_usage.get("inputTokens", 0),
                "completion_tokens": raw_usage.get("outputTokens", 0),
                "total_tokens": raw_usage.get("inputTokens", 0) + raw_usage.get("outputTokens", 0),
            }
            span.set_attribute("gen_ai.usage.input_tokens", usage["prompt_tokens"])
            span.set_attribute("gen_ai.usage.output_tokens", usage["completion_tokens"])
            span.set_attribute("gen_ai.response.finish_reason", stop_reason or "stop")
            return content, usage

    async def generate_stream(self, request: GenerateRequest) -> AsyncIterator[StreamChunk]:
        resolved = resolve_request_defaults(request)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate_stream",
            attributes={
                "gen_ai.system": "aws_bedrock",
                "gen_ai.request.model": self._resolve_model(request),
                "gen_ai.operation.name": "generate_stream",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            params = self._build_converse_params(request)

            loop = asyncio.get_running_loop()
            queue: asyncio.Queue = asyncio.Queue()
            _SENTINEL = object()

            def _iterate_stream():
                """Run in thread — iterates boto3 sync stream, pushes to queue."""
                try:
                    response = self._client.converse_stream(**params)
                    for event in response["stream"]:
                        loop.call_soon_threadsafe(queue.put_nowait, event)
                    loop.call_soon_threadsafe(queue.put_nowait, _SENTINEL)
                except Exception as exc:
                    loop.call_soon_threadsafe(queue.put_nowait, exc)

            thread_future = loop.run_in_executor(None, _iterate_stream)

            try:
                while True:
                    event = await queue.get()
                    if event is _SENTINEL:
                        break
                    if isinstance(event, Exception):
                        raise event

                    if "contentBlockDelta" in event:
                        text = event["contentBlockDelta"]["delta"].get("text", "")
                        if text:
                            yield StreamChunk(type="chunk", content=text)
                    elif "messageStop" in event:
                        reason = event["messageStop"].get("stopReason", "stop")
                        span.set_attribute("gen_ai.response.finish_reason", reason)
                        yield StreamChunk(type="done", data={"finish_reason": reason})
                    elif "metadata" in event:
                        raw_usage = event["metadata"].get("usage", {})
                        if raw_usage:
                            span.set_attribute("gen_ai.usage.input_tokens", raw_usage.get("inputTokens", 0))
                            span.set_attribute("gen_ai.usage.output_tokens", raw_usage.get("outputTokens", 0))
                            yield StreamChunk(type="usage", data={
                                "prompt_tokens": raw_usage.get("inputTokens", 0),
                                "completion_tokens": raw_usage.get("outputTokens", 0),
                                "total_tokens": raw_usage.get("inputTokens", 0) + raw_usage.get("outputTokens", 0),
                            })
            finally:
                await thread_future

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
