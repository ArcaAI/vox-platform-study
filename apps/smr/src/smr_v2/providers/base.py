"""LLMProvider protocol and ProviderRegistry."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol, runtime_checkable

from smr_v2.models.provider import ProviderInfo
from smr_v2.models.requests import GenerateRequest
from smr_v2.models.stats import GenerationStats
from smr_v2.models.stream import StreamChunk


class ProviderNotFoundError(KeyError):
    """Raised when a requested provider is not registered."""


@runtime_checkable
class LLMProvider(Protocol):
    """Contract that every LLM provider must satisfy."""

    # TASK-508 AD-1: the third element is a normalized ``GenerationStats`` (real
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
    """Thread-safe registry of named LLMProvider instances."""

    def __init__(self) -> None:
        self._providers: dict[str, LLMProvider] = {}

    def register(self, name: str, provider: LLMProvider) -> None:
        self._providers[name] = provider

    def get(self, name: str) -> LLMProvider:
        try:
            return self._providers[name]
        except KeyError:
            raise ProviderNotFoundError(f"Provider '{name}' not registered. Available: {list(self._providers)}") from None

    def unregister(self, name: str) -> None:
        self._providers.pop(name, None)

    def list_providers(self) -> list[str]:
        return list(self._providers.keys())
