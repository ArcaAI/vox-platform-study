"""TranslateProvider protocol and TranslateProviderRegistry.

Mirrors ``text.providers.base`` (the LLM ``ProviderRegistry``) so the translate
capability follows the exact same lazy, connection-gated registration shape: a
provider is *available* once its factory is registered at startup, and the
instance is built on the first ``get(name)`` and memoized. A request for an
unregistered name fails closed with ``TranslateProviderNotFoundError`` (the
endpoint maps it to a 404).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol, runtime_checkable

from text.models.requests import ProviderOverride


class TranslateProviderNotFoundError(KeyError):
    """Raised when a requested translate provider is not registered."""


@runtime_checkable
class TranslateProvider(Protocol):
    """Contract that every translate provider must satisfy."""

    async def translate(
        self,
        texts: list[str],
        *,
        source_language: str,
        target_language: str,
        overrides: ProviderOverride | None,
    ) -> list[str]:
        """Translate ``texts`` 1:1 (order preserved). Blank entries pass through."""
        ...

    async def health_check(self) -> bool:
        """Return True if the provider is reachable/usable."""
        ...


class TranslateProviderRegistry:
    """Registry of named ``TranslateProvider``s with LAZY, request-driven
    instantiation — the translate-capability twin of ``ProviderRegistry``.

    A provider is *available* once its factory is registered
    (``register_factory`` at startup); the instance is built on the first
    ``get(name)`` and memoized. Eager ``register`` is retained for tests /
    direct wiring.
    """

    def __init__(self) -> None:
        self._providers: dict[str, TranslateProvider] = {}
        self._factories: dict[str, Callable[[], TranslateProvider]] = {}

    def register(self, name: str, provider: TranslateProvider) -> None:
        """Register an already-built provider instance (eager)."""
        self._providers[name] = provider

    def register_factory(self, name: str, factory: Callable[[], TranslateProvider]) -> None:
        """Register a lazy builder; the instance is created on first ``get``."""
        self._factories[name] = factory

    def get(self, name: str) -> TranslateProvider:
        provider = self._providers.get(name)
        if provider is not None:
            return provider
        factory = self._factories.get(name)
        if factory is not None:
            provider = factory()
            self._providers[name] = provider  # memoize the lazily-built instance
            return provider
        raise TranslateProviderNotFoundError(
            f"Translate provider '{name}' not registered. Available: {self.list_providers()}"
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
