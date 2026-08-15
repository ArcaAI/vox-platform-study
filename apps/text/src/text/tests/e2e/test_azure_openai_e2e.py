"""E2E tests for the Azure OpenAI provider against a real Azure endpoint."""

from __future__ import annotations

import pytest
from httpx import AsyncClient

pytestmark = [pytest.mark.e2e]


@pytest.mark.usefixtures("require_azure")
class TestAzureOpenAIE2E:
    """Tests that require valid Azure OpenAI credentials."""

    async def test_azure_health_check(self, e2e_client: AsyncClient) -> None:
        resp = await e2e_client.get("/api/v1/health")
        assert resp.status_code == 200

        body = resp.json()
        assert body["status"] in ("ok", "degraded")
        assert "azure" in body["providers"]
        assert body["providers"]["azure"] == "healthy"

    async def test_azure_sync_generate(self, e2e_client: AsyncClient) -> None:
        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "azure",
                "prompt": "Say hello in one word",
                "model": "gpt-4o-mini",
                "stream": False,
                "max_tokens": 20,
            },
            timeout=120.0,
        )
        assert resp.status_code == 200

        body = resp.json()
        assert body["status"] == "completed"
        assert body["provider"] == "azure"
        assert isinstance(body["content"], str)
        assert len(body["content"].strip()) > 0
        assert body["task_id"]
        assert body["finish_reason"] == "stop"
        assert body["usage"]["total_tokens"] > 0

    async def test_azure_streaming_generate(self, e2e_client: AsyncClient) -> None:
        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "azure",
                "prompt": "Say hello in one word",
                "model": "gpt-4o-mini",
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

    async def test_azure_provider_listing(self, e2e_client: AsyncClient) -> None:
        resp = await e2e_client.get("/api/v1/providers")
        assert resp.status_code == 200

        providers = resp.json()
        assert isinstance(providers, list)

        azure_providers = [p for p in providers if p["name"] == "azure"]
        assert len(azure_providers) == 1

        azure = azure_providers[0]
        assert azure["status"] == "available"
        assert azure["default_model"]
        assert azure["supports_streaming"] is True
