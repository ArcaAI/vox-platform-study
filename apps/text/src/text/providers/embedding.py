"""EmbeddingProvider protocol and EmbeddingProviderRegistry.

A SEPARATE registry namespace from the nine `LLMProvider`s in
`providers/base.py::ProviderRegistry` — decided in Task 1's design (see
). Mirrors
`translation/base.py::TranslateProviderRegistry`, which already established
this exact "separate capability, separate registry, same lazy/connection-gated
shape" pattern for the `translate` capability — an embedding provider and an
`LLMProvider` satisfy structurally different protocols (`embed` vs.
`generate`/`generate_stream`), so a shared registry would need a task-type
branch on every `get()` call; two small registries are simpler.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol, runtime_checkable

from text.models.provider import ProviderInfo


class EmbeddingProviderNotFoundError(KeyError):
    """Raised when a requested embedding provider is not registered."""


@runtime_checkable
class EmbeddingProvider(Protocol):
    """Contract every embedding provider must satisfy."""

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed ``texts`` 1:1 (order preserved). Never called with an empty list."""
        ...

    async def get_info(self) -> ProviderInfo:
        """Return metadata about the provider and its served model."""
        ...

    async def health_check(self) -> bool:
        """Return True if the provider is reachable and operational."""
        ...


class EmbeddingProviderRegistry:
    """Registry of named `EmbeddingProvider`s with LAZY, request-driven
    instantiation — the embedding-capability twin of `ProviderRegistry`
    (`providers/base.py`) and `TranslateProviderRegistry`
    (`translation/base.py`).
    """

    def __init__(self) -> None:
        self._providers: dict[str, EmbeddingProvider] = {}
        self._factories: dict[str, Callable[[], EmbeddingProvider]] = {}

    def register(self, name: str, provider: EmbeddingProvider) -> None:
        """Register an already-built provider instance (eager)."""
        self._providers[name] = provider

    def register_factory(self, name: str, factory: Callable[[], EmbeddingProvider]) -> None:
        """Register a lazy builder; the instance is created on first ``get``."""
        self._factories[name] = factory

    def get(self, name: str) -> EmbeddingProvider:
        provider = self._providers.get(name)
        if provider is not None:
            return provider
        factory = self._factories.get(name)
        if factory is not None:
            provider = factory()
            self._providers[name] = provider  # memoize the lazily-built instance
            return provider
        raise EmbeddingProviderNotFoundError(
            f"Embedding provider '{name}' not registered. Available: {self.list_providers()}"
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
