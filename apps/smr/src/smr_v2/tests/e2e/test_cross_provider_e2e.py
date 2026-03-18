"""E2E tests for cross-provider behaviour (error handling, headers, validation)."""

from __future__ import annotations

import pytest
from httpx import AsyncClient

pytestmark = [pytest.mark.e2e]


class TestCrossProviderE2E:
    """Provider-agnostic tests that don't need a live LLM backend."""

    async def test_request_id_propagation(self, e2e_client: AsyncClient) -> None:
        custom_request_id = "e2e-test-req-12345"
        resp = await e2e_client.get(
            "/api/v1/health",
            headers={"X-Request-ID": custom_request_id},
        )
        assert resp.status_code == 200
        assert resp.headers.get("X-Request-ID") == custom_request_id

    async def test_invalid_provider_returns_error(self, e2e_client: AsyncClient) -> None:
        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "nonexistent",
                "prompt": "Hello",
                "stream": False,
            },
            timeout=30.0,
        )
        assert resp.status_code in (404, 422)

    async def test_empty_prompt_returns_422(self, e2e_client: AsyncClient) -> None:
        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "prompt": "",
                "stream": False,
            },
            timeout=30.0,
        )
        assert resp.status_code == 422

    async def test_whitespace_only_prompt_returns_422(self, e2e_client: AsyncClient) -> None:
        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "prompt": "   ",
                "stream": False,
            },
            timeout=30.0,
        )
        assert resp.status_code == 422
