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
