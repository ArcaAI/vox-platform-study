"""LLMProvider protocol and ProviderRegistry."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from typing import Protocol, runtime_checkable

from text.core.exceptions import ModelNotSelectedError, VisionNotSupportedError
from text.models.provider import ProviderInfo
from text.models.requests import GenerateRequest
from text.models.stats import GenerationStats
from text.models.stream import StreamChunk


class ProviderNotFoundError(KeyError):
    """Raised when a requested provider is not registered."""


def require_model(model: str | None, *, provider: str) -> str:
    """Fail-closed guard for CLOUD providers (Azure/Bedrock/OpenAI/Anthropic/
    Vertex): raise when no model resolved rather than falling through to a
    substituted default.

    The five cloud sub-configs (``core/config.py``) carry no runtime
    fallback model — provider/model SELECTION is ``failMode=closed``, so an
    unresolved value must raise, never substitute a vendor model. Local
    built-in engines (Ollama, LM Studio/OpenAICompat, vLLM, llama.cpp) do
    NOT call this guard; they keep their topology-level model default.
    """
    if not model or not model.strip():
        raise ModelNotSelectedError(
            f"No model selected for provider '{provider}': Text does not "
            "substitute a default cloud model — the caller must supply "
            "'model' (resolved via AiTaskDefault upstream).",
            provider=provider,
        )
    return model


def reject_vision(request: GenerateRequest, *, provider: str) -> None:
    """Fail-closed guard for a provider with NO multimodal wire capability
    (today: llama.cpp's raw ``/completion`` endpoint).

    Raises ``VisionNotSupportedError`` when the request carries an image
    content part, rather than silently sending the text-only prompt and
    dropping the image. A caller that picked a text-only engine for a vision
    request must find out with a clear typed error.
    """
    if request.image_parts():
        raise VisionNotSupportedError(
            f"Provider '{provider}' does not support vision input: an 'image' "
            "content part was supplied but this engine has no multimodal wire "
            "capability.",
            provider=provider,
        )


@runtime_checkable
class LLMProvider(Protocol):
    """Contract that every LLM provider must satisfy.

    ``generate``/``generate_stream`` accept an OPTIONAL multimodal payload via
    ``request.content_parts`` — a text-only ``GenerateRequest`` (the
    default) is unaffected; a provider with no vision wire capability must
    raise ``VisionNotSupportedError`` (see ``reject_vision``) rather than drop
    the image parts.
    """

    # AD-1: the third element is a normalized ``GenerationStats`` (real
    # stop reason + token counts + engine-native blob), NOT a bare usage dict —
    # every provider (incl. the vLLM / llama.cpp wave) must return exactly this.
    async def generate(self, request: GenerateRequest) -> tuple[str, str, GenerationStats]:
        """Non-streaming generation. Returns (content, reasoning, GenerationStats)."""
        ...

    def generate_stream(self, request: GenerateRequest) -> AsyncIterator[StreamChunk]:
        """Streaming generation. Yields StreamChunk objects."""
        ...

    async def get_info(self) -> ProviderInfo:
        """Return metadata about the provider and its available models."""
        ...

    async def health_check(self) -> bool:
        """Return True if the provider is reachable and operational."""
        ...


class ProviderRegistry:
    """Registry of named LLMProviders with LAZY, request-driven instantiation.

    a provider is *available* once its CONNECTION config is present
    (``register_factory`` at startup), but the (weight/connection-bearing)
    instance is built only on the first ``get(name)`` for that key and then
    memoized. A request for a name with neither an instance nor a factory
    (missing connection config) fails closed with ``ProviderNotFoundError``.
    Eager ``register`` is retained for tests / direct wiring.
    """

    def __init__(self) -> None:
        self._providers: dict[str, LLMProvider] = {}
        self._factories: dict[str, Callable[[], LLMProvider]] = {}

    def register(self, name: str, provider: LLMProvider) -> None:
        """Register an already-built provider instance (eager)."""
        self._providers[name] = provider

    def register_factory(self, name: str, factory: Callable[[], LLMProvider]) -> None:
        """Register a lazy builder; the instance is created on first ``get``."""
        self._factories[name] = factory

    def get(self, name: str) -> LLMProvider:
        provider = self._providers.get(name)
        if provider is not None:
            return provider
        factory = self._factories.get(name)
        if factory is not None:
            provider = factory()
            self._providers[name] = provider  # memoize the lazily-built instance
            return provider
        raise ProviderNotFoundError(
            f"Provider '{name}' not registered. Available: {self.list_providers()}"
        ) from None

    def unregister(self, name: str) -> None:
        self._providers.pop(name, None)
        self._factories.pop(name, None)

    def list_providers(self) -> list[str]:
        """All AVAILABLE provider names (instantiated OR lazily registered)."""
        return list({**self._factories, **self._providers}.keys())

    def is_instantiated(self, name: str) -> bool:
        """True once the named provider has actually been built (test aid)."""
        return name in self._providers
