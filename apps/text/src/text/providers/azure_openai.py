"""Azure OpenAI LLM provider — uses openai.AsyncAzureOpenAI."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import structlog
from openai import AsyncAzureOpenAI, BadRequestError

from text.core.connection import resolve_connection
from text.core.defaults import resolve_request_defaults
from text.core.exceptions import ProviderConnectionMissingError, ProviderCredentialsError
from text.core.reasoning import ReasoningSupport, apply_openai_wire_reasoning
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

#: The S-4 provider identity, which is what an `AiRuntimeProfile` row is keyed by
#: and therefore what the connection pool must be named after. Deliberately NOT
#: the ``azure_openai`` spelling used in this module's error messages and spans:
#: those are user-facing text and telemetry with their own history, while THIS
#: string has to match the vocabulary a platform admin types into the config
#: plane, or the pool silently never receives its tuning.
_POOL_NAME = "azure-openai"


def _get_tracer() -> Tracer:
    return get_tracer(__name__)


def _annotation(source: Any, name: str) -> dict[str, Any] | list[Any] | None:
    """One content-filter annotation off an OpenAI-typed SDK object.

    The annotations are Azure EXTRA fields on OpenAI's models; the SDK's
    ``extra="allow"`` is what makes them reachable by attribute at all. The
    isinstance guard is load-bearing for the streaming path, where a delta may
    legitimately not carry the field.
    """
    value = getattr(source, name, None)
    return value if isinstance(value, (dict, list)) else None


def _filter_annotations(response: Any, choice: Any) -> dict[str, Any]:
    """Azure's content-filter annotations, each from where Azure puts it.

    ``prompt_filter_results`` is a ROOT member (results for the prompt);
    ``content_filter_results`` is a member of each element of ``choices``
    (results for that generation).
    """
    out: dict[str, Any] = {}
    prompt_filter = _annotation(response, "prompt_filter_results")
    if prompt_filter is not None:
        out["prompt_filter_results"] = prompt_filter
    choice_filter = _annotation(choice, "content_filter_results")
    if choice_filter is not None:
        out["content_filter_results"] = choice_filter
    return out


class AzureOpenAIProvider:
    """Azure OpenAI provider using the openai Python SDK."""

    credential_posture = CredentialPosture.BYOK

    # TASK-970 — a TRUE off-switch, verified against the pinned SDK: openai==3.1.0
    # declares `ReasoningEffort = Literal['none','minimal','low','medium','high',
    # 'xhigh','max']` and `chat.completions.create` takes it as a typed parameter.
    # This adapter is one of the two the ticket named specifically: the posture's
    # correct native parameter has always lived on this wire, and until now this
    # adapter forwarded nothing at all.
    reasoning_support = ReasoningSupport.NATIVE_OFF
    reasoning_parameter = "reasoning_effort"
    reasoning_effort_parameter = "reasoning_effort"

    #: Azure pins its wire contract by date. This is the version this ADAPTER is
    #: written against — a property of the code, not a deployment choice — used
    #: only when the resolved connection does not pin its own.
    ADAPTER_API_VERSION = "2024-12-01-preview"

    def __init__(self) -> None:
        """No configuration. Azure OpenAI is BYOK-only and Text holds no
        connection of its own: endpoint, credential and api-version all arrive
        per request as a gateway-resolved ``ProviderOverride`` (tenant → SYSTEM).

        There is no client on this INSTANCE. Clients live in the process-wide
        `CLIENT_CACHE`, keyed by `(provider, endpoint, credential fingerprint)`,
        so two tenants still never share one while two requests on the same
        Azure resource reuse one (B-2). A request with no resolved connection
        still raises rather than 401-ing an empty-keyed client downstream.
        """

    def _resolve_override(self, request: GenerateRequest) -> ProviderOverride | None:
        """The connection the gateway resolved for THIS request's provider."""
        return resolve_connection(request)

    def _client_for(self, request: GenerateRequest) -> AsyncAzureOpenAI:
        """Request-scoped, fail-closed client resolution."""
        override = self._resolve_override(request)
        if override is None:
            raise ProviderConnectionMissingError(
                "No Azure OpenAI connection resolved. Azure OpenAI is BYOK-only: "
                "configure a tenant Azure OpenAI credential, or the platform "
                "(SYSTEM-tenant) connection, in the provider-connection plane. "
                "There is no env fallback.",
                provider="azure_openai",
            )
        endpoint = (override.base_url or "").strip()
        if not endpoint:
            # Azure addresses a DEPLOYMENT on a named resource
            # (``https://<resource>.openai.azure.com``), so the endpoint travels
            # with that resource's credential on the connection row. Checked
            # explicitly because ``AsyncAzureOpenAI(azure_endpoint="")`` does NOT
            # raise — it builds a client whose base_url is the relative string
            # ``/openai/``, which fails much later with an error naming neither
            # the tenant nor the missing row. Bedrock refuses a connection with
            # no ``region`` for exactly this reason.
            raise ProviderConnectionMissingError(
                "No endpoint on the resolved Azure OpenAI connection. Azure "
                "routes by deployment on a named resource, so the endpoint "
                "travels with the credential on the AiProviderConnection row.",
                provider="azure_openai",
            )
        secret = override.api_key.get_secret_value()
        api_version = override.api_version or self.ADAPTER_API_VERSION
        # `api_version` is part of the client's identity, not just a header: two
        # connections on the same resource pinned to different versions speak
        # different wires and must not be collapsed onto one client.
        key = client_key(_POOL_NAME, f"{endpoint}|{api_version}", secret)
        try:
            return CLIENT_CACHE.get_or_create(
                key,
                lambda: AsyncAzureOpenAI(
                    api_key=secret,
                    azure_endpoint=endpoint,
                    api_version=api_version,
                    http_client=pooled_http_client(
                        _POOL_NAME,
                        timeout_s=PROVIDER_TIMEOUT_FLOOR_S,
                        family=TransportFamily.HTTPX2,
                    ),
                ),
            )
        except Exception as exc:  # noqa: BLE001 — never leak the key
            # A MALFORMED override is refused, not degraded onto another
            # credential. Bare `OpenAIError` (what an empty key raises) would
            # otherwise escape as a 500 instead of the 503
            # PROVIDER_CREDENTIALS_MISSING contract. Same shape as
            # ``providers/openai.py``; the key is never logged.
            logger.warning(
                "azure.override_client_build_failed",
                provider="azure_openai",
                error=type(exc).__name__,
            )
            raise ProviderCredentialsError(
                "The configured Azure OpenAI credential could not be used "
                f"({type(exc).__name__}). The request is refused rather than "
                "served on another tenant's or the platform's credential.",
                provider="azure_openai",
            ) from exc

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        # No in-gateway default — the caller-supplied model is
        # authoritative, UNLESS an explicit Azure deployment is configured
        #: Azure OpenAI routes requests by *deployment name*, not
        # model name, so ``deployment_name`` — when set — takes precedence over
        # the caller-supplied model. Default ("") preserves the pre-existing
        # behavior of forwarding ``request.model`` unchanged. A tenant BYO
        # override's own ``deployment_name`` wins over both.
        override = self._resolve_override(request)
        if override is not None and override.deployment_name:
            return override.deployment_name
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

    def _apply_reasoning(self, kwargs: dict[str, Any], request: GenerateRequest) -> None:
        """Render the reasoning posture as this wire's own ``reasoning_effort``."""
        apply_openai_wire_reasoning(
            kwargs,
            request,
            provider="azure_openai",
            model=self._resolve_model(request),
            off_is_expressible=self.reasoning_support is ReasoningSupport.NATIVE_OFF,
        )

    async def generate(self, request: GenerateRequest) -> tuple[str, str, GenerationStats]:
        resolved = resolve_request_defaults(request)
        resolved_model = require_model(self._resolve_model(request), provider="azure_openai")
        with _get_tracer().start_as_current_span(
            "gen_ai.generate",
            attributes={
                "gen_ai.system": "azure_openai",
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
                # Follow-up: newer Azure OpenAI models (gpt-5.x / o-series,
                # e.g. gpt-5.4-mini) reject `max_tokens` and require
                # `max_completion_tokens`; it is accepted across chat models on the
                # configured api-version, so send it unconditionally.
                "max_completion_tokens": resolved["max_tokens"],
                "top_p": resolved["top_p"],
                "stream": False,
            }

            if (
                request.response_format is not None
                and request.response_format.type == "json_schema"
            ):
                schema = request.response_format.json_schema or {}
                kwargs["response_format"] = {
                    "type": "json_schema",
                    "json_schema": {
                        "name": schema.get("title", "output"),
                        "schema": schema,
                        "strict": request.response_format.strict,
                    },
                }
            elif request.response_format is not None and request.response_format.type == "json":
                kwargs["response_format"] = {"type": "json_object"}

            self._apply_reasoning(kwargs, request)

            start = time.monotonic()
            try:
                response = await self._client_for(request).chat.completions.create(**kwargs)
            except BadRequestError as e:
                if "content_filter" in str(e).lower():
                    logger.warning(
                        "azure.content_filter_blocked",
                        error=str(e),
                        model=kwargs.get("model"),
                    )
                raise
            total_ms = int((time.monotonic() - start) * 1000)

            choice = response.choices[0]
            message = choice.message
            content = message.content or ""
            reasoning = (
                getattr(message, "reasoning_content", None)
                or getattr(message, "reasoning", None)
                or ""
            )
            finish_reason = choice.finish_reason
            usage_obj = getattr(response, "usage", None)
            # Keep the provider's OWN usage object, breakdown intact: the cache
            # and reasoning splits are priced separately by the ledger and the
            # three headline fields cannot express them.
            usage = openai_usage_dict(usage_obj)
            # engine_native: OpenAI ``usage`` + Azure's content-filter annotations
            # (the content-safety audit blob), each read from where Azure
            # actually puts it. They are NOT both at the response root:
            # ``prompt_filter_results`` is a root member (prompt side), while
            # ``content_filter_results`` is a member of each element of
            # ``choices`` (completion side). Reading the completion-side one off
            # the root — as this did — can never find it, which left a
            # 200-with-``content_filter`` refusal indistinguishable from a model
            # that simply returned nothing.
            native: dict[str, Any] = {"usage": usage}
            native.update(_filter_annotations(response, choice))
            stats = stats_from_openai_usage(
                provider="azure_openai",
                model=resolved_model,
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
        resolved_model = require_model(self._resolve_model(request), provider="azure_openai")
        with _get_tracer().start_as_current_span(
            "gen_ai.generate_stream",
            attributes={
                "gen_ai.system": "azure_openai",
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
                # Follow-up: newer Azure OpenAI models (gpt-5.x / o-series,
                # e.g. gpt-5.4-mini) reject `max_tokens` and require
                # `max_completion_tokens`; it is accepted across chat models on the
                # configured api-version, so send it unconditionally.
                "max_completion_tokens": resolved["max_tokens"],
                "top_p": resolved["top_p"],
                "stream": True,
                "stream_options": {"include_usage": True},
            }

            if request.response_format is not None:
                if request.response_format.type == "json_schema":
                    schema = request.response_format.json_schema or {}
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

            self._apply_reasoning(kwargs, request)

            # DRAIN to completion (AD-1) — see openai_compat for the rationale: an
            # early-return on the finish chunk drops the trailing usage-only chunk.
            start = time.monotonic()
            ttft_ms: int | None = None
            finish_reason: str | None = None
            usage: dict[str, Any] | None = None
            # Content-filter annotations ride in their own frames on a stream:
            # the PROMPT annotation is the leading choice-less frame
            # (``{"choices": [], "prompt_filter_results": [...]}``), and
            # COMPLETION annotations arrive as annotation messages whose text is
            # empty. Several may refer to the same tokens, so they accumulate.
            prompt_filter_results: dict[str, Any] | list[Any] | None = None
            content_filter_results: list[Any] = []

            stream = await self._client_for(request).chat.completions.create(**kwargs)
            async for chunk in stream:
                prompt_filter = _annotation(chunk, "prompt_filter_results")
                if prompt_filter is not None:
                    prompt_filter_results = prompt_filter
                if not chunk.choices:
                    if getattr(chunk, "usage", None):
                        usage = openai_usage_dict(chunk.usage)
                    continue
                choice = chunk.choices[0]
                choice_filter = _annotation(choice, "content_filter_results")
                if choice_filter is not None:
                    content_filter_results.append(choice_filter)
                delta = choice.delta
                if choice.finish_reason:
                    finish_reason = choice.finish_reason
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
            native: dict[str, Any] = {}
            if usage:
                native["usage"] = usage
            if prompt_filter_results is not None:
                native["prompt_filter_results"] = prompt_filter_results
            if content_filter_results:
                native["content_filter_results"] = content_filter_results
            stats = stats_from_openai_usage(
                provider="azure_openai",
                model=resolved_model,
                usage=usage,
                finish_reason=finish_reason,
                total_ms=total_ms,
                ttft_ms=ttft_ms,
                engine_native=native or None,
            )
            if usage:
                span.set_attribute("gen_ai.usage.input_tokens", usage["prompt_tokens"])
                span.set_attribute("gen_ai.usage.output_tokens", usage["completion_tokens"])
            span.set_attribute("gen_ai.response.finish_reason", finish_reason or "stop")
            yield StreamChunk(type="usage", data=stats.model_dump())
            # The terminal frame reports the reason the STATS beside it report.
            # A stream that never delivered a ``finish_reason`` did not stop
            # cleanly, and substituting the literal ``"stop"`` here turned a
            # truncated answer into a complete one for the audit log and the
            # STOP_REASON_TOTAL metric — while the very same frame's stats said
            # ``"other"``. The two must never disagree.
            yield StreamChunk(
                type="done", data={"finish_reason": finish_reason or stats.stop_reason}
            )

    async def health_check(self) -> bool:
        """Nothing to probe: the connection is per request, so there is no
        process-level Azure endpoint to reach.

        Returns True — "no negative evidence" — deliberately. `PoolHealthTracker`
        acts only on a POSITIVELY known-unhealthy result
        (`services/pool_health.py`), so reporting False here would take a
        perfectly usable BYOK provider out of degrade routing for every tenant
        that carries its own working credential.
        """
        return True

    async def get_info(self) -> ProviderInfo:
        """Adapter capabilities only.

        The MODEL listing and the default model come from `AiModel` and the
        gateway's resolved selection (`Agent`, or `AiRoutingPolicy` for a
        non-agent task), which is where they have always been
        authoritative — this adapter used to echo an env var
        (``TEXT_AZURE_DEFAULT_MODEL``) that no generation path ever read.
        """
        return ProviderInfo(
            name="azure_openai",
            display_name="Azure OpenAI",
            status="unavailable",
            default_model="",
            models=[],
            supports_streaming=True,
            supports_vision=True,
        )
