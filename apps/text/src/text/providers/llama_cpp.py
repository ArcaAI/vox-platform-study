"""llama.cpp server LLM provider — native ``/completion`` client.

llama.cpp is the AD-1 REFERENCE engine for the owner's generation metrics: its
``timings`` block (``prompt_n``, ``predicted_n``, ``predicted_ms``,
``predicted_per_second``) and ``stopped_eos``/``stopped_word``/``stopped_limit``
flags are mapped verbatim into ``GenerationStats``. We target the native
``/completion`` endpoint (richer than llama.cpp's OpenAI shim) so we get those
timings plus first-class GBNF ``grammar`` and JSON-``json_schema`` structured
output. Streaming is server-sent-event lines.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import httpx
import structlog

from text.core.connection import require_base_url
from text.core.defaults import resolve_request_defaults
from text.core.reasoning import ReasoningSupport, record_unsupported_posture
from text.core.telemetry import get_tracer
from text.models.probe import ProbeConnection
from text.models.provider import ProviderInfo
from text.models.requests import GenerateRequest
from text.models.stats import GenerationStats, stats_from_llama_cpp
from text.models.stream import StreamChunk
from text.providers.base import CredentialPosture, reject_vision

if TYPE_CHECKING:
    from opentelemetry.trace import Tracer

logger = structlog.get_logger(__name__)

_ENGINE = "llama-cpp"


def _get_tracer() -> Tracer:
    return get_tracer(__name__)


class LlamaCppProvider:
    """llama.cpp server provider over the native ``/completion`` endpoint."""

    credential_posture = CredentialPosture.SELF_HOST

    # TASK-970 — UNSUPPORTED because of the ENDPOINT this adapter deliberately
    # targets. llama.cpp's server documents `reasoning_effort`,
    # `reasoning_format`, `reasoning_control` and `chat_template_kwargs` on
    # `/v1/chat/completions` ONLY; `/completion` applies no chat template and
    # accepts no reasoning parameter (`--reasoning-budget` is a server CLI flag,
    # not per-request). The native endpoint is chosen for its `timings` block —
    # this adapter is the AD-1 reference engine — so the trade is deliberate, and
    # the posture is recorded rather than dropped.
    reasoning_support = ReasoningSupport.UNSUPPORTED
    reasoning_parameter = None
    reasoning_effort_parameter = None

    #: Name used when reporting a missing connection and on the admin listing.
    _probe_name = _ENGINE

    def __init__(self, http_client: httpx.AsyncClient) -> None:
        """No configuration. The engine endpoint arrives per request as a
        gateway-resolved ``ProviderOverride`` (`core/connection.py`)."""
        self._http = http_client
        self._last_base_url: str | None = None

    def _endpoint(self, request: GenerateRequest) -> str:
        """The engine endpoint for THIS request, from the resolved connection.

        Also remembered as ``_last_base_url`` so the admin-facing probes
        (`health_check` / `get_info`), which have no request to resolve from, can
        still report on the engine this process has actually been talking to. A
        self-hosted engine is platform infrastructure with one SYSTEM-tenant row,
        so that memo is accurate in practice — and it is never used to ROUTE a
        generation, only to describe one.
        """
        base_url = require_base_url(request, provider=self._probe_name)
        self._last_base_url = base_url
        return base_url

    def _resolve_model(self, request: GenerateRequest) -> str | None:
        # The caller-supplied model is authoritative. A llama.cpp
        # server loads a single model at launch and ignores a per-request model,
        # so this is informational only (stamped onto stats), never sent on the
        # wire.
        return request.model

    def _build_prompt(self, request: GenerateRequest) -> str:
        # ``/completion`` is a raw-prompt endpoint (no chat roles); prepend the
        # system prompt when present.
        if request.system_prompt:
            return f"{request.system_prompt}\n\n{request.prompt}"
        return request.prompt

    def _build_payload(self, request: GenerateRequest, *, stream: bool) -> dict[str, Any]:
        resolved = resolve_request_defaults(request)
        payload: dict[str, Any] = {
            "prompt": self._build_prompt(request),
            "n_predict": resolved["max_tokens"],
            "temperature": resolved["temperature"],
            "top_p": resolved["top_p"],
            "stream": stream,
            # Prefix caching (AD-4): reuse the KV cache of a shared stable prefix
            # across regen iterations / flushes.
            "cache_prompt": True,
        }

        # Structured output. A GBNF grammar (supplied via ``context.grammar``)
        # takes precedence over a JSON schema; both are native ``/completion``
        # fields, so they pass through verbatim.
        grammar = (request.context or {}).get("grammar") if request.context else None
        if isinstance(grammar, str) and grammar:
            payload["grammar"] = grammar
        elif request.response_format is not None and request.response_format.type == "json_schema":
            if request.response_format.json_schema:
                payload["json_schema"] = request.response_format.json_schema

        record_unsupported_posture(request, provider=_ENGINE, model=self._resolve_model(request))

        return payload

    async def generate(self, request: GenerateRequest) -> tuple[str, str, GenerationStats]:
        reject_vision(request, provider=_ENGINE)
        resolved = resolve_request_defaults(request)
        resolved_model = self._resolve_model(request)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate",
            attributes={
                "gen_ai.system": _ENGINE,
                "gen_ai.request.model": resolved_model or "",
                "gen_ai.operation.name": "generate",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            url = f"{self._endpoint(request)}/completion"
            payload = self._build_payload(request, stream=False)
            start = time.monotonic()
            resp = await self._http.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
            total_ms = int((time.monotonic() - start) * 1000)

            stats = stats_from_llama_cpp(
                provider=_ENGINE,
                model=resolved_model or "",
                data=data,
                total_ms=total_ms,
            )
            span.set_attribute("gen_ai.usage.input_tokens", stats.prompt_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", stats.predicted_tokens)
            span.set_attribute("gen_ai.response.finish_reason", stats.stop_reason_raw or "stop")
            return data.get("content", ""), "", stats

    async def generate_stream(self, request: GenerateRequest) -> AsyncIterator[StreamChunk]:
        reject_vision(request, provider=_ENGINE)
        resolved = resolve_request_defaults(request)
        with _get_tracer().start_as_current_span(
            "gen_ai.generate_stream",
            attributes={
                "gen_ai.system": _ENGINE,
                "gen_ai.request.model": self._resolve_model(request) or "",
                "gen_ai.operation.name": "generate_stream",
                "gen_ai.request.temperature": resolved["temperature"],
                "gen_ai.request.max_tokens": resolved["max_tokens"],
            },
        ) as span:
            url = f"{self._endpoint(request)}/completion"
            payload = self._build_payload(request, stream=True)
            resolved_model = self._resolve_model(request)
            start = time.monotonic()
            ttft_ms: int | None = None

            async with self._http.stream("POST", url, json=payload) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    # llama.cpp streams SSE ``data: {json}`` lines.
                    if line.startswith("data:"):
                        line = line[len("data:") :].strip()
                    if not line:
                        continue
                    data = json.loads(line)
                    if data.get("stop"):
                        # Final object carries the full ``timings`` + ``stopped_*``
                        # flags → build the AD-1 stats, emit ONE usage chunk then
                        # done (drain-complete; no early return mid-stream).
                        total_ms = int((time.monotonic() - start) * 1000)
                        stats = stats_from_llama_cpp(
                            provider=_ENGINE,
                            model=resolved_model or "",
                            data=data,
                            total_ms=total_ms,
                            ttft_ms=ttft_ms,
                        )
                        span.set_attribute("gen_ai.usage.input_tokens", stats.prompt_tokens)
                        span.set_attribute("gen_ai.usage.output_tokens", stats.predicted_tokens)
                        span.set_attribute(
                            "gen_ai.response.finish_reason", stats.stop_reason_raw or "stop"
                        )
                        yield StreamChunk(type="usage", data=stats.model_dump())
                        yield StreamChunk(
                            type="done", data={"finish_reason": stats.stop_reason_raw or "stop"}
                        )
                        return
                    text = data.get("content", "")
                    if not text:
                        continue
                    if ttft_ms is None:
                        ttft_ms = int((time.monotonic() - start) * 1000)
                    yield StreamChunk(type="chunk", content=text)

    def _probe_url(self) -> str | None:
        """The engine this process last talked to, or ``None``.

        The admin probes have no request, so there is no connection to resolve.
        Reporting on the last endpoint observed keeps `/providers` and `/health`
        meaningful for a platform-run engine (one SYSTEM-tenant row, one address)
        without ever inventing one: before the first generation there is nothing
        to report, and this returns ``None``.
        """
        return self._last_base_url

    async def health_check(self) -> bool:
        """Probe the last-observed endpoint; True when none has been observed
        yet ("no negative evidence" — see `OllamaProvider.health_check`)."""
        probe_url = self._probe_url()
        if probe_url is None:
            return True
        try:
            resp = await self._http.get(f"{probe_url}/health")
            return resp.status_code == 200
        except (httpx.HTTPError, httpx.TimeoutException, ConnectionError, OSError) as exc:
            logger.warning("health_check.failed", provider=_ENGINE, error=str(exc))
            return False
        except Exception as exc:
            logger.error("health_check.unexpected_error", provider=_ENGINE, error=str(exc))
            return False

    async def _probe_health(self, base_url: str | None) -> str:
        """`GET {base_url}/health` — the one availability check shared by the memo
        probe (`get_info`) and the connection-scoped one (`discover_models`)."""
        status = "unavailable"
        try:
            resp = await self._http.get(f"{base_url}/health") if base_url else None
            if resp is not None and resp.status_code == 200:
                status = "available"
        except (httpx.HTTPError, httpx.TimeoutException, ConnectionError, OSError) as exc:
            logger.warning("get_info.failed", provider=_ENGINE, error=str(exc))
        except Exception as exc:
            logger.error("get_info.unexpected_error", provider=_ENGINE, error=str(exc))
        return status

    async def discover_models(self, connection: ProbeConnection) -> ProviderInfo:
        """Report on the llama.cpp server the GATEWAY resolved for this caller.

        A llama.cpp process serves exactly ONE model, chosen at launch, and
        exposes no listing endpoint — so there is nothing to enumerate and the
        model list stays empty here exactly as it does in `get_info`. What the
        connection DOES change is which instance's availability is reported, so a
        tenant fronting its own llama.cpp is not told the platform's is up.

        Deliberately does not touch ``_last_base_url`` (see the base protocol).
        """
        return self._info(await self._probe_health(connection.base_url.strip().rstrip("/")))

    async def get_info(self) -> ProviderInfo:
        return self._info(await self._probe_health(self._probe_url()))

    def _info(self, status: str) -> ProviderInfo:
        # A llama.cpp server loads ONE model at launch and ignores a per-request
        # model, so the served identity is a property of the engine process, not
        # of this adapter. The catalogue comes from `AiModel` on the gateway.
        return ProviderInfo(
            name=_ENGINE,
            display_name="llama.cpp",
            status=status,
            default_model="",
            models=[],
            supports_streaming=True,
            supports_vision=False,
        )
