"""POST /tokenize — the serving engine's own tokenizer, else 501.

There is no Hugging Face tokenizer tier: apps/text never fetches model artifacts
(the no-serving invariant). When the engine cannot count, the route answers 501
``TOKENIZER_UNAVAILABLE`` and the caller applies its conservative estimate.

Hermetic: the engine is a stub provider.
"""

from __future__ import annotations

import importlib.util
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from text.core.config import InternalAccessConfig, Settings
from text.main import create_app
from text.models.requests import ProviderOverride
from text.providers.base import ProviderRegistry

TOKEN = "tok-secret"
HEADERS = {"X-Service-Token": TOKEN, "X-Tenant-Id": "t-1"}

#: What an older caller still sends from `AiModel._metadata.tokenizer`.
LEGACY_SPEC = {"hubRepo": "org/model", "file": "tokenizer.json", "sha256": "a" * 64}


def _app(*, engine=None, engine_error: Exception | None = None):
    settings = Settings(port=5099, internal_access=InternalAccessConfig(token=SecretStr(TOKEN)))
    app = create_app(settings_override=settings)
    registry = ProviderRegistry()
    provider = MagicMock()
    provider.count_tokens = AsyncMock(return_value=engine, side_effect=engine_error)
    registry.register("lm-studio", provider)
    app.state.provider_registry = registry
    app.state.engine_provider = provider
    return app


@pytest_asyncio.fixture
async def make_client():
    clients = []

    async def _make(app):
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        clients.append(c)
        return c

    yield _make
    for c in clients:
        await c.aclose()


BODY = {"provider": "lm-studio", "model": "m", "texts": ["hello world", "dose"]}


@pytest.mark.asyncio
async def test_engine_counts_win(make_client):
    app = _app(engine=[7, 3])
    client = await make_client(app)
    resp = await client.post("/api/v1/tokenize", json=BODY, headers=HEADERS)
    assert resp.status_code == 200
    assert resp.json() == {
        "counts": [7, 3],
        "tokenizer": {"source": "engine", "id": "lm-studio:m"},
        "exact": True,
    }


@pytest.mark.asyncio
async def test_messages_total_from_engine(make_client):
    client = await make_client(_app(engine=[2, 1]))
    body = {
        **BODY,
        "texts": [],
        "messages": [
            {"role": "user", "content": "hello world"},
            {"role": "assistant", "content": "dose"},
        ],
    }
    resp = await client.post("/api/v1/tokenize", json=body, headers=HEADERS)
    assert resp.status_code == 200
    assert resp.json()["counts"] == []
    assert resp.json()["messagesTotal"] == 3


@pytest.mark.asyncio
async def test_501_when_engine_cannot_count(make_client):
    client = await make_client(_app(engine=None))
    resp = await client.post("/api/v1/tokenize", json=BODY, headers=HEADERS)
    assert resp.status_code == 501
    assert resp.json()["detail"]["code"] == "TOKENIZER_UNAVAILABLE"


@pytest.mark.asyncio
async def test_501_when_engine_raises(make_client):
    client = await make_client(_app(engine_error=RuntimeError("engine down")))
    resp = await client.post("/api/v1/tokenize", json=BODY, headers=HEADERS)
    assert resp.status_code == 501
    assert resp.json()["detail"]["code"] == "TOKENIZER_UNAVAILABLE"


@pytest.mark.asyncio
async def test_pinned_tokenizer_spec_is_not_a_fallback(make_client):
    """A caller that still names a hub tokenizer gets 501, never a download."""
    client = await make_client(_app(engine=None))
    body = {**BODY, "tokenizer": LEGACY_SPEC}
    resp = await client.post("/api/v1/tokenize", json=body, headers=HEADERS)
    assert resp.status_code == 501
    assert resp.json()["detail"]["code"] == "TOKENIZER_UNAVAILABLE"


@pytest.mark.asyncio
async def test_engine_count_mismatch_is_501(make_client):
    client = await make_client(_app(engine=[1]))
    resp = await client.post("/api/v1/tokenize", json=BODY, headers=HEADERS)
    assert resp.status_code == 501


def test_no_hub_tokenizer_registry_module():
    assert importlib.util.find_spec("text.services.tokenizer_registry") is None


@pytest.mark.no_default_tenant_header
@pytest.mark.asyncio
async def test_auth_required(make_client):
    client = await make_client(_app(engine=[1, 1]))
    resp = await client.post("/api/v1/tokenize", json=BODY)
    assert resp.status_code in (401, 403)
    resp = await client.post("/api/v1/tokenize", json=BODY, headers={"X-Service-Token": TOKEN})
    assert resp.status_code == 428


class _Req:
    provider = "lm-studio"
    provider_overrides = {"lm-studio": ProviderOverride(base_url="http://engine:1234/v1")}


def _lms(state: str, usage: dict[str, int]):
    from text.providers.lmstudio import LMStudioProvider

    p = LMStudioProvider()
    p._native_models = AsyncMock(return_value={"m": {"state": state}})  # type: ignore[method-assign]

    async def create(*, model, prompt, max_tokens):
        return MagicMock(usage=MagicMock(prompt_tokens=usage[prompt]))

    client = MagicMock()
    client.completions.create = create
    p._client_at = MagicMock(return_value=client)  # type: ignore[method-assign]
    return p


@pytest.mark.asyncio
async def test_lmstudio_counts_via_prefill_minus_overhead():
    p = _lms("loaded", {"a": 2, "hello world": 6})  # overhead 1 (BOS)
    assert await p.count_tokens(["hello world"], model="m", request=_Req()) == [5]


@pytest.mark.asyncio
async def test_lmstudio_skips_unloaded_model():
    p = _lms("not-loaded", {})
    assert await p.count_tokens(["x"], model="m", request=_Req()) is None
