"""POST /tokenize — engine tokenizer first, pinned HF tokenizer.json second, 501 last.

Hermetic: the engine is a stub provider, the HF file is a tiny WordLevel tokenizer
written to tmp_path, and the registry's file fetcher is injected.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace

from text.core.config import InternalAccessConfig, Settings
from text.main import create_app
from text.providers.base import ProviderRegistry
from text.services.tokenizer_registry import TokenizerRegistry

TOKEN = "tok-secret"
HEADERS = {"X-Service-Token": TOKEN, "X-Tenant-Id": "t-1"}


@pytest.fixture
def tokenizer_file(tmp_path: Path) -> tuple[Path, str]:
    vocab = {"[UNK]": 0, "hello": 1, "world": 2, "dose": 3}
    tok = Tokenizer(WordLevel(vocab, unk_token="[UNK]"))
    tok.pre_tokenizer = Whitespace()
    path = tmp_path / "tokenizer.json"
    tok.save(str(path))
    return path, hashlib.sha256(path.read_bytes()).hexdigest()


def _spec(sha: str) -> dict:
    return {"hubRepo": "org/model", "file": "tokenizer.json", "sha256": sha}


def _app(*, engine=None, fetcher=None):
    settings = Settings(port=5099, internal_access=InternalAccessConfig(token=SecretStr(TOKEN)))
    app = create_app(settings_override=settings)
    registry = ProviderRegistry()
    provider = MagicMock()
    provider.count_tokens = AsyncMock(return_value=engine)
    registry.register("lm-studio", provider)
    app.state.provider_registry = registry
    app.state.tokenizer_registry = TokenizerRegistry(fetcher=fetcher or _no_fetch)
    app.state.engine_provider = provider
    return app


async def _no_fetch(repo: str, file: str) -> Path:
    raise RuntimeError("no network")


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
async def test_hf_fallback_when_engine_unavailable(make_client, tokenizer_file):
    path, sha = tokenizer_file
    calls = []

    async def fetch(repo, file):
        calls.append((repo, file))
        return path

    client = await make_client(_app(engine=None, fetcher=fetch))
    body = {**BODY, "tokenizer": _spec(sha)}
    resp = await client.post("/api/v1/tokenize", json=body, headers=HEADERS)
    assert resp.status_code == 200
    data = resp.json()
    assert data["counts"] == [2, 1]
    assert data["tokenizer"] == {"source": "hf", "id": f"org/model@{sha}"}
    assert data["exact"] is True

    await client.post("/api/v1/tokenize", json=body, headers=HEADERS)
    assert calls == [("org/model", "tokenizer.json")]  # cached per (repo, sha)


@pytest.mark.asyncio
async def test_messages_total(make_client, tokenizer_file):
    path, sha = tokenizer_file

    async def fetch(repo, file):
        return path

    client = await make_client(_app(fetcher=fetch))
    body = {
        **BODY,
        "texts": [],
        "tokenizer": _spec(sha),
        "messages": [
            {"role": "user", "content": "hello world"},
            {"role": "assistant", "content": "dose"},
        ],
    }
    resp = await client.post("/api/v1/tokenize", json=body, headers=HEADERS)
    assert resp.status_code == 200
    assert resp.json()["messagesTotal"] >= 3  # role-less content floor: 2 + 1


@pytest.mark.asyncio
async def test_sha_mismatch_is_501(make_client, tokenizer_file):
    path, _ = tokenizer_file

    async def fetch(repo, file):
        return path

    client = await make_client(_app(fetcher=fetch))
    body = {**BODY, "tokenizer": _spec("0" * 64)}
    resp = await client.post("/api/v1/tokenize", json=body, headers=HEADERS)
    assert resp.status_code == 501
    assert resp.json()["detail"]["code"] == "TOKENIZER_UNAVAILABLE"


@pytest.mark.asyncio
async def test_501_when_nothing_works(make_client):
    client = await make_client(_app(engine=None))
    resp = await client.post("/api/v1/tokenize", json=BODY, headers=HEADERS)
    assert resp.status_code == 501
    assert resp.json()["detail"]["code"] == "TOKENIZER_UNAVAILABLE"


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
