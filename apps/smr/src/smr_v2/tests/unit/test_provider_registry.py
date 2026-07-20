"""TDD tests for LLMProvider protocol and ProviderRegistry.

RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

# ── LLMProvider protocol ──


class TestLLMProviderProtocol:
    def test_protocol_defines_generate(self):
        from smr_v2.providers.base import LLMProvider
        assert hasattr(LLMProvider, "generate")

    def test_protocol_defines_generate_stream(self):
        from smr_v2.providers.base import LLMProvider
        assert hasattr(LLMProvider, "generate_stream")

    def test_protocol_defines_get_info(self):
        from smr_v2.providers.base import LLMProvider
        assert hasattr(LLMProvider, "get_info")

    def test_protocol_defines_health_check(self):
        from smr_v2.providers.base import LLMProvider
        assert hasattr(LLMProvider, "health_check")


# ── ProviderRegistry ──


class TestProviderRegistry:
    def test_register_provider(self):
        from smr_v2.providers.base import ProviderRegistry
        registry = ProviderRegistry()
        mock_provider = AsyncMock()
        registry.register("ollama", mock_provider)
        assert "ollama" in registry.list_providers()

    def test_get_registered_provider(self):
        from smr_v2.providers.base import ProviderRegistry
        registry = ProviderRegistry()
        mock_provider = AsyncMock()
        registry.register("ollama", mock_provider)
        assert registry.get("ollama") is mock_provider

    def test_get_unknown_provider_raises(self):
        from smr_v2.providers.base import ProviderNotFoundError, ProviderRegistry
        registry = ProviderRegistry()
        with pytest.raises(ProviderNotFoundError):
            registry.get("nonexistent")

    def test_list_providers(self):
        from smr_v2.providers.base import ProviderRegistry
        registry = ProviderRegistry()
        mock1 = AsyncMock()
        mock2 = AsyncMock()
        registry.register("ollama", mock1)
        registry.register("azure_openai", mock2)
        names = registry.list_providers()
        assert set(names) == {"ollama", "azure_openai"}

    def test_unregister_provider(self):
        from smr_v2.providers.base import ProviderRegistry
        registry = ProviderRegistry()
        mock_provider = AsyncMock()
        registry.register("ollama", mock_provider)
        registry.unregister("ollama")
        assert "ollama" not in registry.list_providers()

    def test_unregister_nonexistent_is_noop(self):
        from smr_v2.providers.base import ProviderRegistry
        registry = ProviderRegistry()
        registry.unregister("nonexistent")

    def test_overwrite_provider(self):
        from smr_v2.providers.base import ProviderRegistry
        registry = ProviderRegistry()
        mock1 = AsyncMock()
        mock2 = AsyncMock()
        registry.register("ollama", mock1)
        registry.register("ollama", mock2)
        assert registry.get("ollama") is mock2


class TestProviderRegistryLazyFactories:
    """request-driven lazy instantiation via registered factories."""

    def test_factory_makes_provider_available_but_not_built(self):
        from smr_v2.providers.base import ProviderRegistry
        registry = ProviderRegistry()
        registry.register_factory("ollama", AsyncMock)
        assert "ollama" in registry.list_providers()
        assert registry.is_instantiated("ollama") is False

    def test_get_builds_and_memoizes_on_first_use(self):
        from smr_v2.providers.base import ProviderRegistry
        registry = ProviderRegistry()
        calls: list[int] = []

        def _factory():
            calls.append(1)
            return AsyncMock()

        registry.register_factory("ollama", _factory)
        first = registry.get("ollama")
        assert registry.is_instantiated("ollama") is True
        second = registry.get("ollama")
        assert first is second  # memoized — built exactly once
        assert len(calls) == 1

    def test_unknown_provider_without_factory_fails_closed(self):
        from smr_v2.providers.base import ProviderNotFoundError, ProviderRegistry
        registry = ProviderRegistry()
        # No instance AND no factory (missing connection config) ⇒ fail closed.
        with pytest.raises(ProviderNotFoundError):
            registry.get("azure-openai")

    def test_eager_instance_wins_over_factory(self):
        from smr_v2.providers.base import ProviderRegistry
        registry = ProviderRegistry()
        eager = AsyncMock()
        registry.register("ollama", eager)
        registry.register_factory("ollama", AsyncMock)
        assert registry.get("ollama") is eager

    def test_unregister_removes_factory_too(self):
        from smr_v2.providers.base import ProviderNotFoundError, ProviderRegistry
        registry = ProviderRegistry()
        registry.register_factory("ollama", AsyncMock)
        registry.unregister("ollama")
        assert "ollama" not in registry.list_providers()
        with pytest.raises(ProviderNotFoundError):
            registry.get("ollama")
