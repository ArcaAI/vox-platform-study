"""E2E tests for the Ollama provider against a real Ollama instance."""

from __future__ import annotations

import pytest
from httpx import AsyncClient

pytestmark = [pytest.mark.e2e]


@pytest.mark.usefixtures("require_ollama")
class TestOllamaE2E:
    """Tests that require a running Ollama instance with gemma3."""

    async def test_ollama_health_check(self, e2e_client: AsyncClient) -> None:
        resp = await e2e_client.get("/api/v1/health")
        assert resp.status_code == 200

        body = resp.json()
        assert body["status"] in ("ok", "degraded")
        assert "ollama" in body["providers"]
        assert body["providers"]["ollama"] == "healthy"

    async def test_ollama_sync_generate(self, e2e_client: AsyncClient) -> None:
        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "prompt": "Say hello in one word",
                "stream": False,
                "max_tokens": 20,
            },
            timeout=120.0,
        )
        assert resp.status_code == 200

        body = resp.json()
        assert body["status"] == "completed"
        assert body["provider"] == "ollama"
        assert isinstance(body["content"], str)
        assert len(body["content"].strip()) > 0
        assert body["task_id"]
        assert body["finish_reason"] == "stop"

    async def test_ollama_streaming_generate(self, e2e_client: AsyncClient) -> None:
        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "prompt": "Say hello in one word",
                "stream": True,
                "max_tokens": 20,
            },
            timeout=120.0,
        )
        assert resp.status_code == 202

        body = resp.json()
        assert body["status"] == "running"
        assert body["task_id"]
        assert body["stream_url"]
        assert body["stream_url"].startswith("/api/v1/tasks/")
        assert body["stream_url"].endswith("/stream")

    async def test_ollama_provider_listing(self, e2e_client: AsyncClient) -> None:
        resp = await e2e_client.get("/api/v1/providers")
        assert resp.status_code == 200

        providers = resp.json()
        assert isinstance(providers, list)

        ollama_providers = [p for p in providers if p["name"] == "ollama"]
        assert len(ollama_providers) == 1

        ollama = ollama_providers[0]
        assert ollama["status"] == "available"
        assert ollama["supports_streaming"] is True
