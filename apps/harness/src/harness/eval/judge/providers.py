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

from pydantic import SecretStr

from harness.eval.config import JudgeConfig, JudgeProvider
from harness.eval.jsonio import extract_last_object
from harness.eval.judge.base import JudgeClient, JudgeConnectionError, Messages


def _secret_value(value: object) -> str:
    """Read a secret whether it is a ``SecretStr`` or a plain string."""
    if isinstance(value, SecretStr):
        return value.get_secret_value()
    return str(value)


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
    "503",
    "502",
    "500",
)


def _is_transient(exc: Exception) -> bool:
    return any(marker in str(exc).lower() for marker in _TRANSIENT_MARKERS)


async def _create_with_retry(create_fn, kwargs: dict, *, retries: int, backoff_s: float):
    """Call ``create_fn(**kwargs)``, retrying transient failures with linear backoff.

    The backoff gives a crashed local model time to reload before the next attempt.
    Non-transient errors raise immediately; transient ones raise only once the
    retry budget is exhausted (the caller wraps that in ``JudgeConnectionError``).
    """
    last_exc: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return await create_fn(**kwargs)
        except Exception as exc:  # noqa: BLE001 — re-raised below
            last_exc = exc
            if attempt < retries and _is_transient(exc):
                await asyncio.sleep(backoff_s * (attempt + 1))
                continue
            raise
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
        kwargs: dict = {
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
        try:
            resp = await _create_with_retry(
                self._client.chat.completions.create,
                kwargs,
                retries=self._config.transient_retries,
                backoff_s=self._config.transient_retry_backoff_s,
            )
        except Exception as exc:  # transport/API failure (post-retry) → typed error
            raise JudgeConnectionError(f"openai_compat judge call failed: {exc}") from exc
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
        kwargs: dict = {
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
        try:
            resp = await _create_with_retry(
                self._client.chat.completions.create,
                kwargs,
                retries=self._config.transient_retries,
                backoff_s=self._config.transient_retry_backoff_s,
            )
        except Exception as exc:  # transport/API failure (post-retry) → typed error
            raise JudgeConnectionError(f"azure judge call failed: {exc}") from exc
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
        self._runtime = None  # boto3 client constructed lazily on first call

    def _client(self):  # type: ignore[no-untyped-def]
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

        def _call() -> dict:
            return self._client().converse(
                modelId=self.model,
                system=system,
                messages=conversation,
                inferenceConfig={
                    "temperature": temp,
                    "maxTokens": self._config.max_tokens,
                },
            )

        try:
            resp = await asyncio.to_thread(_call)
        except Exception as exc:
            raise JudgeConnectionError(f"bedrock judge call failed: {exc}") from exc
        return resp["output"]["message"]["content"][0]["text"]


def build_judge_client(config: JudgeConfig | None = None) -> JudgeClient:
    """Construct the configured judge backend (fail-closed on bad config)."""
    if config is None:
        from harness.eval.config import get_judge_config

        config = get_judge_config()

    provider = config.provider
    if provider == JudgeProvider.OPENAI_COMPAT:
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
