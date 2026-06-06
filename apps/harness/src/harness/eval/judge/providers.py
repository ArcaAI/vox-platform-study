"""Judge backends + the model-agnostic factory.

Three interchangeable backends, all selected via :class:`~harness.eval.config.JudgeConfig`:

* :class:`OpenAICompatJudgeClient` — LM Studio / vLLM / any OpenAI-compatible
  server (priority/default for a small ≤20B judge).
* :class:`AzureOpenAIJudgeClient` — Azure OpenAI (large judge).
* :class:`BedrockJudgeClient` — AWS Bedrock (large judge); ``boto3`` is imported
  lazily so selecting/constructing the client never requires it offline.
"""

from __future__ import annotations

from pydantic import SecretStr

from harness.eval.config import JudgeConfig, JudgeProvider
from harness.eval.judge.base import JudgeClient, JudgeConnectionError, Messages


def _secret_value(value: object) -> str:
    """Read a secret whether it is a ``SecretStr`` or a plain string."""
    if isinstance(value, SecretStr):
        return value.get_secret_value()
    return str(value)


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

    async def complete(self, messages: Messages, *, json_mode: bool = False) -> str:
        kwargs: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": self._config.temperature,
            "max_tokens": self._config.max_tokens,
        }
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            resp = await self._client.chat.completions.create(**kwargs)
        except Exception as exc:  # transport/API failure → typed error
            raise JudgeConnectionError(f"openai_compat judge call failed: {exc}") from exc
        return resp.choices[0].message.content or ""


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

    async def complete(self, messages: Messages, *, json_mode: bool = False) -> str:
        kwargs: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": self._config.temperature,
            "max_tokens": self._config.max_tokens,
        }
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            resp = await self._client.chat.completions.create(**kwargs)
        except Exception as exc:
            raise JudgeConnectionError(f"azure judge call failed: {exc}") from exc
        return resp.choices[0].message.content or ""


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

    async def complete(self, messages: Messages, *, json_mode: bool = False) -> str:
        import asyncio

        system = [{"text": m["content"]} for m in messages if m["role"] == "system"]
        conversation = [
            {"role": m["role"], "content": [{"text": m["content"]}]}
            for m in messages
            if m["role"] != "system"
        ]

        def _call() -> dict:
            return self._client().converse(
                modelId=self.model,
                system=system,
                messages=conversation,
                inferenceConfig={
                    "temperature": self._config.temperature,
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
