"""Text cloud provider/model SELECTION is failMode=closed.

Program: docs/implementation/SOTA-Track/2026-07-28-provider-plane-day1-defaults-followups.md
(finding F3). Ticket: docs/implementation/TASK-579-Text-Cloud-Default-Model-Fail-Closed/README.md

Decision A (owner-confirmed): the five CLOUD sub-configs (Azure/Bedrock/OpenAI/
Anthropic/Vertex) carry no compiled-in vendor ``default_model`` and a cloud
``generate``/``generate_stream`` call that resolves no model RAISES a typed
selection error — it never silently substitutes a vendor model.

RED-first (TDD): written before the GREEN provider-adapter edits landed. Locks:
  * ``_resolve_model`` never falls back to the configured (informational)
    ``default_model`` — the precise regression this closes: ``VertexProvider``
    used to return ``self._default_model`` when the caller omitted a model.
  * ``generate`` / ``generate_stream`` raise ``ModelNotSelectedError``
    (422 via the shared exception map — see ``core/exception_handlers.py``)
    when no model resolves, for EVERY cloud provider.
  * A caller-supplied model still succeeds unchanged (regression).
  * Local/built-in engines (LM Studio/OpenAICompat) are UNCHANGED — they do
    not raise and keep their topology-level model default.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from text.core.exceptions import ModelNotSelectedError
from text.models.requests import GenerateRequest
from text.tests.conftest import stub_client

# ---------------------------------------------------------------------------
# Provider factories — one per cloud provider (mirrors test_no_model_default_d7.py)
# ---------------------------------------------------------------------------


def _azure():
    from text.providers.azure_openai import AzureOpenAIProvider

    # deployment_name explicitly forced empty so it cannot mask the guard
    # (Azure routes by deployment name when one is configured — a separate,
    # unaffected contract covered by TestAzureDeploymentName).
    return AzureOpenAIProvider()


def _bedrock():
    from text.providers.bedrock import BedrockProvider

    with patch("boto3.client"):
        return BedrockProvider()


def _openai():
    from text.providers.openai import OpenAIProvider

    return OpenAIProvider()


def _anthropic():
    from text.providers.anthropic import AnthropicProvider

    return AnthropicProvider()


def _vertex():
    from text.providers.vertex import VertexProvider

    return VertexProvider()


_CLOUD_PROVIDERS = [
    ("azure_openai", _azure),
    ("bedrock", _bedrock),
    ("openai", _openai),
    ("anthropic", _anthropic),
    ("vertex", _vertex),
]
_CLOUD_IDS = [name for name, _ in _CLOUD_PROVIDERS]


class TestResolveModelNeverFallsBackToDefault:
    """Direct unit check of the fix: ``_resolve_model`` returns exactly
    ``request.model`` — never the configured (informational) default."""

    @pytest.mark.parametrize("name,factory", _CLOUD_PROVIDERS, ids=_CLOUD_IDS)
    def test_no_model_returns_none(self, name, factory):
        provider = factory()
        assert provider._resolve_model(GenerateRequest(prompt="hi")) is None

    @pytest.mark.parametrize("name,factory", _CLOUD_PROVIDERS, ids=_CLOUD_IDS)
    def test_caller_model_is_honored(self, name, factory):
        provider = factory()
        req = GenerateRequest(prompt="hi", model="caller-model")
        assert provider._resolve_model(req) == "caller-model"


class TestGenerateRaisesWithoutModel:
    """``generate()``/``generate_stream()`` must raise ``ModelNotSelectedError``
    — never substitute a vendor model — when the request carries no model."""

    @pytest.mark.parametrize("name,factory", _CLOUD_PROVIDERS, ids=_CLOUD_IDS)
    @pytest.mark.asyncio
    async def test_generate_raises(self, name, factory):
        provider = factory()
        with pytest.raises(ModelNotSelectedError):
            await provider.generate(GenerateRequest(prompt="hi", provider=name))

    @pytest.mark.parametrize("name,factory", _CLOUD_PROVIDERS, ids=_CLOUD_IDS)
    @pytest.mark.asyncio
    async def test_generate_stream_raises(self, name, factory):
        provider = factory()
        with pytest.raises(ModelNotSelectedError):
            async for _ in provider.generate_stream(
                GenerateRequest(prompt="hi", provider=name, stream=True)
            ):
                pass

    @pytest.mark.parametrize("name,factory", _CLOUD_PROVIDERS, ids=_CLOUD_IDS)
    @pytest.mark.asyncio
    async def test_blank_model_also_raises(self, name, factory):
        """A whitespace-only model must raise too (not just ``None``) —
        mirrors the endpoint-level 422 contract in ``test_no_model_default_d7.py``."""
        provider = factory()
        with pytest.raises(ModelNotSelectedError):
            await provider.generate(GenerateRequest(prompt="hi", provider=name, model="   "))


class TestGenerateSucceedsWithModel:
    """Regression: a caller-supplied model still generates successfully."""

    @pytest.mark.asyncio
    async def test_azure_succeeds_with_model(self):
        provider = _azure()
        mock_choice = MagicMock()
        mock_choice.message.content = "ok"
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2)
        provider._client = stub_client(provider, AsyncMock())
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        content, _reasoning, _stats = await provider.generate(
            GenerateRequest(prompt="hi", provider="azure_openai", model="caller-model")
        )
        assert content == "ok"

    @pytest.mark.asyncio
    async def test_bedrock_succeeds_with_model(self):
        provider = _bedrock()
        provider._client = stub_client(provider, MagicMock())
        provider._client.converse.return_value = {
            "output": {"message": {"content": [{"text": "ok"}]}},
            "usage": {"inputTokens": 1, "outputTokens": 1},
            "stopReason": "end_turn",
        }

        content, _reasoning, _stats = await provider.generate(
            GenerateRequest(prompt="hi", provider="bedrock", model="caller-model")
        )
        assert content == "ok"

    @pytest.mark.asyncio
    async def test_openai_succeeds_with_model(self):
        provider = _openai()
        mock_choice = MagicMock()
        mock_choice.message.content = "ok"
        mock_choice.message.reasoning_content = None
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2)
        provider._client = stub_client(provider, AsyncMock())
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        content, _reasoning, _stats = await provider.generate(
            GenerateRequest(prompt="hi", provider="openai", model="caller-model")
        )
        assert content == "ok"

    @pytest.mark.asyncio
    async def test_anthropic_succeeds_with_model(self):
        provider = _anthropic()
        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "ok"
        mock_message = MagicMock()
        mock_message.content = [text_block]
        mock_message.stop_reason = "end_turn"
        mock_message.usage = MagicMock(input_tokens=1, output_tokens=1)
        provider._client = stub_client(provider, MagicMock())
        provider._client.messages.create = AsyncMock(return_value=mock_message)

        content, _reasoning, _stats = await provider.generate(
            GenerateRequest(prompt="hi", provider="anthropic", model="caller-model")
        )
        assert content == "ok"

    @pytest.mark.asyncio
    async def test_vertex_succeeds_with_model(self):
        provider = _vertex()
        candidate = MagicMock()
        candidate.finish_reason = "STOP"
        mock_response = MagicMock()
        mock_response.text = "ok"
        mock_response.candidates = [candidate]
        mock_response.usage_metadata = MagicMock(
            prompt_token_count=1, candidates_token_count=1, total_token_count=2
        )
        provider._client = stub_client(provider, MagicMock())
        provider._client.aio.models.generate_content = AsyncMock(return_value=mock_response)

        content, _reasoning, _stats = await provider.generate(
            GenerateRequest(prompt="hi", provider="vertex", model="caller-model")
        )
        assert content == "ok"


class TestLocalEnginesUnaffected:
    """Local/built-in engines do NOT call the cloud guard.

    They never carried a MODEL of their own either — since TASK-799 lane B not
    even an informational one — but the engine itself has an opinion: LM Studio
    and llama.cpp serve whatever is loaded when the wire `model` is absent. So
    the distinction that survives is about the GUARD, not about a default:
    `require_model` is a cloud-only fail-closed check, and these adapters simply
    forward what the caller sent.
    """

    @pytest.mark.asyncio
    async def test_openai_compat_generate_without_model_does_not_raise(self):
        from text.providers.openai_compat import OpenAICompatProvider

        mock_choice = MagicMock()
        mock_choice.message.content = "ok"
        mock_choice.message.reasoning_content = None
        mock_choice.message.reasoning = None
        mock_choice.finish_reason = "stop"
        mock_completion = MagicMock()
        mock_completion.choices = [mock_choice]
        mock_completion.usage = MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2)

        provider = OpenAICompatProvider()
        provider._client = stub_client(provider, AsyncMock())
        provider._client.chat.completions.create = AsyncMock(return_value=mock_completion)

        content, _reasoning, _stats = await provider.generate(GenerateRequest(prompt="hi"))
        assert content == "ok"


class TestNoConfigCarriesAModelAtAll:
    """The guarantee got stronger: there is no `default_model` FIELD to inspect.

    Decision A emptied the five cloud defaults, which left a typed, named field
    one edit away from carrying a vendor string again — and left the five LOCAL
    engines still holding real ids. TASK-799 lane B deleted all ten, so
    "no compiled-in vendor model" is now a property of the settings TREE rather
    than of ten separately-maintained default values.
    """

    def test_no_settings_field_anywhere_is_a_model(self):
        from pydantic import BaseModel

        from text.core.config import Settings

        def walk(model: type[BaseModel], prefix: str = "") -> list[str]:
            out: list[str] = []
            for name, field in model.model_fields.items():
                annotation = field.annotation
                if isinstance(annotation, type) and issubclass(annotation, BaseModel):
                    out.extend(walk(annotation, f"{prefix}{name}."))
                else:
                    out.append(f"{prefix}{name}")
            return out

        offenders = [
            f for f in walk(Settings) if f.rsplit(".", 1)[-1] in {"default_model", "model"}
        ]
        assert offenders == []

    def test_no_adapter_holds_a_model(self):
        """Nor did the field simply move onto the adapter instances."""
        from unittest.mock import MagicMock as _MagicMock

        from text.main import _register_provider_factories
        from text.providers.base import ProviderRegistry

        registry = ProviderRegistry()
        _register_provider_factories(registry, _MagicMock())
        for name in registry.list_providers():
            provider = registry.get(name)
            assert not hasattr(provider, "_default_model"), name
