"""Judge backends + the model-agnostic factory.

Three interchangeable backends, all selected via :class:`~harness.eval.config.JudgeConfig`:

* :class:`OpenAICompatJudgeClient` — LM Studio / vLLM / any OpenAI-compatible
  server (priority/default for a small ≤20B judge).
* :class:`AzureOpenAIJudgeClient` — Azure OpenAI (large judge).
* :class:`BedrockJudgeClient` — AWS Bedrock (large judge); ``boto3`` is imported
  lazily so selecting/constructing the client never requires it offline.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from functools import partial
from typing import Any, cast

from pydantic import SecretStr

from harness.core.llm_concurrency import call_with_timeout, get_llm_governor_config, limit_endpoint
from harness.eval.config import JudgeConfig, JudgeProvider
from harness.eval.jsonio import extract_last_object
from harness.eval.judge.base import JudgeClient, JudgeConnectionError, Messages


def _secret_value(value: object) -> str:
    """Read a secret whether it is a ``SecretStr`` or a plain string."""
    if isinstance(value, SecretStr):
        return value.get_secret_value()
    return str(value)


# ---------------------------------------------------------------------------
# generation-stats capture for the judge/sensor LLM
# clients. These call their OWN LLM endpoints (not Text), so they can't reuse
# Text's ``GenerationStats`` model (a separate uv package); instead they capture
# the equivalent native fields into an AD-1-shaped dict mirroring the Text
# ``stats`` field names, for Phase 2 trajectory ``LLM_CALL`` / ``GUARDRAIL``
# steps. Every builder is null-safe: a response that omits usage / finish
# reason must NEVER throw — counts fall back to zero and the stop reason to a
# null-safe normalized value.
# ---------------------------------------------------------------------------

# Per-wire raw→normalized stop-reason tables (subset mirroring text.models.stats
# for the wires these clients speak: OpenAI-compatible, Bedrock converse).
_OPENAI_WIRE_STOP: dict[str, str] = {
    "stop": "stop",
    "eos": "stop",
    "end_turn": "stop",
    "length": "length",
    "max_tokens": "length",
    "content_filter": "content_filter",
    "tool_calls": "tool_call",
    "function_call": "tool_call",
}
_BEDROCK_STOP: dict[str, str] = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "content_filtered": "content_filter",
    "guardrail_intervened": "content_filter",
    "tool_use": "tool_call",
}
_STOP_TABLES: dict[str, dict[str, str]] = {
    "lm-studio": _OPENAI_WIRE_STOP,
    "lmstudio": _OPENAI_WIRE_STOP,
    "openai_compat": _OPENAI_WIRE_STOP,
    "openai": _OPENAI_WIRE_STOP,
    "vllm": _OPENAI_WIRE_STOP,
    "azure": _OPENAI_WIRE_STOP,
    "azure-openai": _OPENAI_WIRE_STOP,
    "bedrock": _BEDROCK_STOP,
    "llama-cpp": _OPENAI_WIRE_STOP,
}


def _normalize_stop_reason(provider: str, raw: str | None) -> str:
    """Map a provider-native finish/stop reason onto the AD-1 stop-reason set.

    Case-insensitive; an empty/unknown token normalizes to ``"other"`` so a novel
    engine reason never crashes the mapper.
    """
    if not raw:
        return "other"
    table = _STOP_TABLES.get((provider or "").lower(), _OPENAI_WIRE_STOP)
    return table.get(raw.strip().lower(), "other")


def build_llm_call_stats(
    *,
    provider: str,
    model: str,
    raw_stop_reason: str | None,
    prompt_tokens: int = 0,
    predicted_tokens: int = 0,
    total_tokens: int | None = None,
    total_ms: int = 0,
    ttft_ms: int | None = None,
    tokens_per_second: float | None = None,
    engine_native: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble an AD-1-shaped stats dict from already-extracted native fields.

    Mirrors ``text.models.stats.GenerationStats`` field names. ``tokens_per_second``
    is used verbatim when the engine reports it; otherwise it is computed from client
    timing (predicted / decode-time), and left ``None`` when nothing can be divided.
    """
    prompt = int(prompt_tokens or 0)
    predicted = int(predicted_tokens or 0)
    total = int(total_tokens) if total_tokens is not None else prompt + predicted
    total_ms_int = int(total_ms or 0)

    tps = tokens_per_second
    if tps is None and predicted and total_ms_int > 0:
        decode_ms = (
            total_ms_int - ttft_ms
            if ttft_ms is not None and total_ms_int > ttft_ms
            else total_ms_int
        )
        if decode_ms > 0:
            tps = round(predicted / (decode_ms / 1000.0), 3)

    return {
        "stop_reason": _normalize_stop_reason(provider, raw_stop_reason),
        "stop_reason_raw": raw_stop_reason or "",
        "total_ms": total_ms_int,
        "ttft_ms": ttft_ms,
        "tokens_per_second": tps,
        "prompt_tokens": prompt,
        "predicted_tokens": predicted,
        "total_tokens": total,
        "provider": provider,
        "model": model,
        "engine_native": engine_native,
    }


def _openai_usage_dict(usage: Any) -> dict[str, Any] | None:
    """Coerce an OpenAI-wire ``usage`` (SDK object or dict) to a plain dict, null-safe."""
    if usage is None:
        return None
    if isinstance(usage, dict):
        return usage
    return {
        "prompt_tokens": getattr(usage, "prompt_tokens", 0),
        "completion_tokens": getattr(usage, "completion_tokens", 0),
        "total_tokens": getattr(usage, "total_tokens", None),
    }


def _stats_from_openai_response(
    resp: Any, *, provider: str, model: str, total_ms: int
) -> dict[str, Any]:
    """Build AD-1 stats from an OpenAI-wire chat-completion response (null-safe)."""
    usage = _openai_usage_dict(getattr(resp, "usage", None)) or {}
    choices = getattr(resp, "choices", None) or []
    finish_reason = getattr(choices[0], "finish_reason", None) if choices else None
    return build_llm_call_stats(
        provider=provider,
        model=getattr(resp, "model", None) or model,
        raw_stop_reason=finish_reason,
        prompt_tokens=usage.get("prompt_tokens", 0) or 0,
        predicted_tokens=usage.get("completion_tokens", 0) or 0,
        total_tokens=usage.get("total_tokens"),
        total_ms=total_ms,
    )


# Substrings that mark a *transient* backend failure worth retrying (a model
# engine that was terminated/unloaded under load and will JIT-reload, a dropped
# connection, a momentary 5xx/overload) — as opposed to a deterministic 4xx
# (bad request shape, auth) that would only fail again.
_TRANSIENT_MARKERS = (
    "terminated",
    "connection",
    "reset",
    "timeout",
    "timed out",
    "overloaded",
    "unavailable",
    # Rate limits: the OpenAI SDK already retries 429s honoring ``Retry-After`` (see
    # ``JudgeConfig.max_retries``); these markers add a belt-and-braces retry if one
    # still surfaces as an exception after the SDK budget is spent.
    "rate limit",
    "too many requests",
    "429",
    "503",
    "502",
    "500",
)


def _is_transient(exc: Exception) -> bool:
    # A per-call wall-clock timeout is a transient hang — retry within the
    # judge's budget before the sensor degrades (``asyncio.timeout`` can raise a bare
    # ``TimeoutError`` whose empty message marker-matching would otherwise miss).
    if isinstance(exc, TimeoutError):
        return True
    return any(marker in str(exc).lower() for marker in _TRANSIENT_MARKERS)


async def _create_with_retry(
    create_fn: Callable[..., Awaitable[Any]],
    kwargs: dict[str, Any],
    *,
    retries: int,
    backoff_s: float,
    base_url: str,
) -> Any:
    """Call ``create_fn(**kwargs)``, retrying transient failures with linear backoff.

    Each attempt runs under the shared per-endpoint concurrency governor
    (:func:`harness.core.llm_concurrency.limit_endpoint`, keyed by ``base_url``), so
    the inferential pass's concurrent judge calls never burst the LM Studio box past
    its admin-set cap — the slot is held only for the call itself, not the backoff.
    Each attempt is ALSO bounded by the per-call wall-clock timeout
    (``HARNESS_LLM_REQUEST_TIMEOUT_S``) so a hung judge call can't stall the whole pass;
    a timeout is transient and retried like any other transient backend failure.
    The backoff gives a crashed local model time to reload before the next attempt.
    Non-transient errors raise immediately; transient ones raise only once the
    retry budget is exhausted (the caller wraps that in ``JudgeConnectionError``).
    """
    request_timeout_s = get_llm_governor_config().request_timeout_s
    last_exc: Exception | None = None
    for attempt in range(retries + 1):
        try:
            async with limit_endpoint(base_url):
                return await call_with_timeout(partial(create_fn, **kwargs), request_timeout_s)
        except Exception as exc:  # noqa: BLE001 — re-raised below
            last_exc = exc
            if attempt < retries and _is_transient(exc):
                await asyncio.sleep(backoff_s * (attempt + 1))
                continue
            raise
    assert last_exc is not None  # pragma: no cover — loop always sets last_exc
    raise last_exc  # pragma: no cover — loop always returns or raises above


def _pick_answer_text(content: str, reasoning: str) -> str:
    """Choose the channel that actually carries the JSON answer.

    Reasoning model families split their output differently: gpt-oss puts the
    answer in ``content`` (reasoning separate); qwen3.5 can leave ``content`` empty
    with the answer in ``reasoning_content``; and gemma-4 may emit its COMPLETE JSON
    in ``reasoning_content`` while ``content`` holds only a *truncated* duplicate
    (finish_reason=length → an unbalanced ``{`` that no parser can recover).

    So prefer ``content`` only when it already contains a balanced JSON object;
    otherwise fall back to the reasoning text, then to whatever content exists.
    """
    if content.strip() and extract_last_object(content) is not None:
        return content
    if reasoning.strip():
        return reasoning
    return content


class OpenAICompatJudgeClient:
    """Judge served by any OpenAI-compatible endpoint (LM Studio, vLLM, …)."""

    def __init__(self, config: JudgeConfig) -> None:
        from openai import AsyncOpenAI

        self._config = config
        self.model = config.model
        # AD-1 stats dict from the most recent ``complete`` call
        # (None until the first call), read by the Phase 2 trajectory ``LLM_CALL`` emitter.
        self.last_stats: dict[str, Any] | None = None
        oc = config.openai_compat
        self._client = AsyncOpenAI(
            api_key=_secret_value(oc.api_key) or "not-needed",
            base_url=oc.base_url,
            organization=oc.organization,
            timeout=config.timeout_s,
            max_retries=config.max_retries,
        )

    async def complete(
        self,
        messages: Messages,
        *,
        json_mode: bool = False,
        temperature: float | None = None,
        seed: int | None = None,
    ) -> str:
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self._config.temperature if temperature is None else temperature,
            "max_tokens": self._config.max_tokens,
        }
        effective_seed = seed if seed is not None else self._config.seed
        if effective_seed is not None:
            kwargs["seed"] = effective_seed
        if json_mode:
            fmt = self._config.openai_compat.json_response_format
            # "text"/"none"/"" → omit the constraint (LM Studio rejects json_object;
            # the prompts request JSON and parsing is tolerant). Otherwise pass through.
            if fmt and fmt not in ("text", "none"):
                kwargs["response_format"] = {"type": fmt}
        # Server-specific reasoning knobs (vLLM/Azure); only sent when configured.
        if self._config.extra_body:
            kwargs["extra_body"] = self._config.extra_body
        started = time.monotonic()
        try:
            resp = await _create_with_retry(
                self._client.chat.completions.create,
                kwargs,
                retries=self._config.transient_retries,
                backoff_s=self._config.transient_retry_backoff_s,
                base_url=self._config.openai_compat.base_url,
            )
        except Exception as exc:  # transport/API failure (post-retry) → typed error
            raise JudgeConnectionError(f"openai_compat judge call failed: {exc}") from exc
        # capture the native usage/finish-reason stats for this call.
        self.last_stats = _stats_from_openai_response(
            resp,
            provider=str(self._config.provider),
            model=self.model,
            total_ms=int((time.monotonic() - started) * 1000),
        )
        # Reasoning models can leave ``content`` empty and strand the answer in
        # ``reasoning_content`` (qwen3.5/gemma-4) or ``reasoning`` (gpt-oss); fall
        # back to the reasoning text so the answer is never lost.
        msg = resp.choices[0].message
        content = msg.content or ""
        reasoning = getattr(msg, "reasoning_content", None) or getattr(msg, "reasoning", None) or ""
        return _pick_answer_text(content, reasoning)


class AzureOpenAIJudgeClient:
    """Judge served by Azure OpenAI (deployment-based routing)."""

    def __init__(self, config: JudgeConfig) -> None:
        from openai import AsyncAzureOpenAI

        self._config = config
        az = config.azure
        self.model = az.deployment or config.model
        # AD-1 stats dict from the most recent ``complete`` call.
        self.last_stats: dict[str, Any] | None = None
        self._client = AsyncAzureOpenAI(
            api_key=_secret_value(az.api_key),
            azure_endpoint=az.endpoint,
            api_version=az.api_version,
            timeout=config.timeout_s,
            max_retries=config.max_retries,
        )

    async def complete(
        self,
        messages: Messages,
        *,
        json_mode: bool = False,
        temperature: float | None = None,
        seed: int | None = None,
    ) -> str:
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self._config.temperature if temperature is None else temperature,
            "max_tokens": self._config.max_tokens,
        }
        effective_seed = seed if seed is not None else self._config.seed
        if effective_seed is not None:
            kwargs["seed"] = effective_seed
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        # Server-specific reasoning knobs (e.g. reasoning_effort); only when configured.
        if self._config.extra_body:
            kwargs["extra_body"] = self._config.extra_body
        started = time.monotonic()
        try:
            resp = await _create_with_retry(
                self._client.chat.completions.create,
                kwargs,
                retries=self._config.transient_retries,
                backoff_s=self._config.transient_retry_backoff_s,
                base_url=self._config.azure.endpoint,
            )
        except Exception as exc:  # transport/API failure (post-retry) → typed error
            raise JudgeConnectionError(f"azure judge call failed: {exc}") from exc
        # capture the native usage/finish-reason stats for this call.
        self.last_stats = _stats_from_openai_response(
            resp,
            provider="azure",
            model=self.model,
            total_ms=int((time.monotonic() - started) * 1000),
        )
        # Same reasoning-aware fallback as the OpenAI-compatible client: prefer
        # ``content``, else the reasoning text (``reasoning_content`` / ``reasoning``).
        msg = resp.choices[0].message
        content = msg.content or ""
        reasoning = getattr(msg, "reasoning_content", None) or getattr(msg, "reasoning", None) or ""
        return _pick_answer_text(content, reasoning)


class BedrockJudgeClient:
    """Judge served by AWS Bedrock (``converse`` API; lazy ``boto3``)."""

    def __init__(self, config: JudgeConfig) -> None:
        self._config = config
        self.model = config.model
        self.region = config.bedrock.region
        self._runtime: Any = None  # boto3 client constructed lazily on first call
        # AD-1 stats dict from the most recent ``complete`` call.
        self.last_stats: dict[str, Any] | None = None

    def _client(self) -> Any:
        if self._runtime is None:
            import boto3

            self._runtime = boto3.client("bedrock-runtime", region_name=self.region)
        return self._runtime

    async def complete(
        self,
        messages: Messages,
        *,
        json_mode: bool = False,
        temperature: float | None = None,
        seed: int | None = None,  # Bedrock ``converse`` has no seed knob → ignored.
    ) -> str:
        import asyncio

        # The Bedrock ``converse`` API has no ``extra_body`` / reasoning-content split,
        # so ``config.extra_body`` and the reasoning fallback do not apply here.
        system = [{"text": m["content"]} for m in messages if m["role"] == "system"]
        conversation = [
            {"role": m["role"], "content": [{"text": m["content"]}]}
            for m in messages
            if m["role"] != "system"
        ]
        temp = self._config.temperature if temperature is None else temperature

        def _call() -> dict[str, Any]:
            response = self._client().converse(
                modelId=self.model,
                system=system,
                messages=conversation,
                inferenceConfig={
                    "temperature": temp,
                    "maxTokens": self._config.max_tokens,
                },
            )
            return cast("dict[str, Any]", response)

        started = time.monotonic()
        try:
            resp = await asyncio.to_thread(_call)
        except Exception as exc:
            raise JudgeConnectionError(f"bedrock judge call failed: {exc}") from exc
        # map the converse ``usage`` + ``stopReason`` into AD-1 stats.
        usage = resp.get("usage") or {}
        self.last_stats = build_llm_call_stats(
            provider="bedrock",
            model=self.model,
            raw_stop_reason=resp.get("stopReason"),
            prompt_tokens=usage.get("inputTokens", 0) or 0,
            predicted_tokens=usage.get("outputTokens", 0) or 0,
            total_tokens=usage.get("totalTokens"),
            total_ms=int((time.monotonic() - started) * 1000),
        )
        return cast(str, resp["output"]["message"]["content"][0]["text"])


def build_judge_client(config: JudgeConfig | None = None) -> JudgeClient:
    """Construct the configured judge backend (fail-closed on bad config)."""
    if config is None:
        from harness.eval.config import get_judge_config

        config = get_judge_config()

    provider = config.provider
    # The production engines vLLM and llama.cpp also speak the OpenAI wire, so
    # they route through the same client (base_url points at the engine);
    # native stop-reason normalization is provider-aware (see ``_STOP_TABLES``:
    # both ``vllm`` and ``llama-cpp`` are registered).
    if provider in (
        JudgeProvider.OPENAI_COMPAT,
        JudgeProvider.VLLM,
        JudgeProvider.LLAMA_CPP,
    ):
        if not config.openai_compat.base_url:
            raise ValueError("openai_compat judge requires HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL")
        return OpenAICompatJudgeClient(config)

    if provider == JudgeProvider.AZURE:
        az = config.azure
        if not az.endpoint:
            raise ValueError("azure judge requires HARNESS_JUDGE_AZURE_ENDPOINT")
        if not _secret_value(az.api_key):
            raise ValueError("azure judge requires HARNESS_JUDGE_AZURE_API_KEY")
        if not az.deployment:
            raise ValueError("azure judge requires HARNESS_JUDGE_AZURE_DEPLOYMENT")
        return AzureOpenAIJudgeClient(config)

    if provider == JudgeProvider.BEDROCK:
        if not config.model:
            raise ValueError("bedrock judge requires an explicit HARNESS_JUDGE_MODEL (model id)")
        return BedrockJudgeClient(config)

    raise ValueError(f"unknown judge provider: {provider!r}")
