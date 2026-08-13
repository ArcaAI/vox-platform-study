"""TDD tests for POST /api/v1/translate.

A minimal FastAPI app mounts only the translate router; the registry dependency
is overridden so no lifespan/redis/provider wiring is needed. Verifies the happy
path (translations + chars), unknown provider -> 404, upstream failure -> 502,
missing credential -> 503.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from smr.api.endpoints.translate import router
from smr.core.dependencies import get_translate_registry
from smr.translation.base import TranslateProviderRegistry
from smr.translation.sarvam import SarvamCredentialError, SarvamTranslateError


def _make_client(registry: TranslateProviderRegistry) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_translate_registry] = lambda: registry
    return TestClient(app)


def _registry_with(provider) -> TranslateProviderRegistry:
    registry = TranslateProviderRegistry()
    registry.register("sarvam", provider)
    return registry


def test_happy_path_returns_translations_and_chars():
    provider = AsyncMock()
    provider.translate = AsyncMock(return_value=["hello", "world"])
    provider.model = "mayura:v1"
    client = _make_client(_registry_with(provider))

    resp = client.post(
        "/api/v1/translate",
        json={
            "texts": ["hola", "mundo"],
            "source_language": "es",
            "target_language": "en-IN",
            "provider": "sarvam",
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["translations"] == ["hello", "world"]
    assert body["provider"] == "sarvam"
    assert body["model"] == "mayura:v1"
    assert body["chars"] == len("hola") + len("mundo")
    # The named provider was asked with the request's languages.
    provider.translate.assert_awaited_once()
    kwargs = provider.translate.await_args.kwargs
    assert kwargs["source_language"] == "es"
    assert kwargs["target_language"] == "en-IN"


def test_unknown_provider_returns_404():
    provider = AsyncMock()
    provider.translate = AsyncMock(return_value=[])
    client = _make_client(_registry_with(provider))

    resp = client.post(
        "/api/v1/translate",
        json={"texts": ["hi"], "provider": "does-not-exist"},
    )
    assert resp.status_code == 404


def test_upstream_failure_returns_502():
    provider = AsyncMock()
    provider.translate = AsyncMock(side_effect=SarvamTranslateError("HTTP 401: unauthorized"))
    provider.model = None
    client = _make_client(_registry_with(provider))

    resp = client.post("/api/v1/translate", json={"texts": ["hi"], "provider": "sarvam"})
    assert resp.status_code == 502


def test_missing_credential_returns_503():
    # BYOK-only: a request with no provider_overrides has no key -> the provider
    # raises SarvamCredentialError, which the endpoint maps to 503.
    provider = AsyncMock()
    provider.translate = AsyncMock(side_effect=SarvamCredentialError("no key"))
    provider.model = None
    client = _make_client(_registry_with(provider))

    resp = client.post("/api/v1/translate", json={"texts": ["hi"], "provider": "sarvam"})
    assert resp.status_code == 503
    # No credential was forwarded (the request carried no provider_overrides).
    assert provider.translate.await_args.kwargs.get("overrides") is None


def test_defaults_source_and_target_language():
    provider = AsyncMock()
    provider.translate = AsyncMock(return_value=["x"])
    provider.model = None
    client = _make_client(_registry_with(provider))

    resp = client.post("/api/v1/translate", json={"texts": ["x"], "provider": "sarvam"})
    assert resp.status_code == 200
    kwargs = provider.translate.await_args.kwargs
    assert kwargs["source_language"] == "auto"
    assert kwargs["target_language"] == "en-IN"
