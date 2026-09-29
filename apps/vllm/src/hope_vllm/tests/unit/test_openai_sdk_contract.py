"""A STOCK OpenAI SDK talks to the shell (C-3): the contract is the SDK's, not ours.

`openai.AsyncOpenAI(base_url=…/v1, api_key=<INTERNAL_ACCESS_TOKEN>,
default_headers={"X-Tenant-Id": …}).audio.transcriptions.create(model=…, file=…,
language=…)` — the SDK sends `Authorization: Bearer`, multipart, and parses what comes back.
Driven in-process through an ASGI transport, so the SDK's real request building and
response parsing run against the real app.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

openai = pytest.importorskip("openai")

import httpx  # noqa: E402

from hope_vllm.core.config import Settings  # noqa: E402
from hope_vllm.main import create_app  # noqa: E402
from hope_vllm.tests.conftest import SLUG, TENANT_ID, wav_bytes  # noqa: E402
from hope_vllm.tests.fakes import FakeEngineFactory, FakeSpecResolver  # noqa: E402

TOKEN = "sdk-secret-token"


@pytest.fixture
def resolver() -> FakeSpecResolver:
    return FakeSpecResolver()


@pytest.fixture
async def sdk(monkeypatch: pytest.MonkeyPatch, resolver: FakeSpecResolver) -> AsyncIterator[object]:
    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", TOKEN)
    app = create_app(Settings(), engine_factory=FakeEngineFactory(), serving_spec_client=resolver)
    async with app.router.lifespan_context(app):
        http_client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app))
        client = openai.AsyncOpenAI(
            base_url="http://vllm.test/v1",
            api_key=TOKEN,
            default_headers={"X-Tenant-Id": TENANT_ID},
            http_client=http_client,
            max_retries=0,
        )
        try:
            yield client
        finally:
            await client.close()


async def test_json(sdk) -> None:  # type: ignore[no-untyped-def]
    result = await sdk.audio.transcriptions.create(
        model=SLUG, file=("w.wav", wav_bytes(3.0), "audio/wav"), language="ml"
    )
    assert result.text == "hello world from the fake engine"


async def test_text(sdk) -> None:  # type: ignore[no-untyped-def]
    result = await sdk.audio.transcriptions.create(
        model=SLUG,
        file=("w.wav", wav_bytes(3.0), "audio/wav"),
        language="ml",
        response_format="text",
    )
    assert str(result).strip() == "hello world from the fake engine"


async def test_verbose_json_with_the_x_hope_extension(sdk) -> None:  # type: ignore[no-untyped-def]
    result = await sdk.audio.transcriptions.create(
        model=SLUG,
        file=("w.wav", wav_bytes(3.0), "audio/wav"),
        language="ml",
        response_format="verbose_json",
    )
    assert result.text == "hello world from the fake engine"
    assert result.language == "ml"
    assert result.duration == pytest.approx(3.0)
    assert result.segments == []
    extra = result.model_extra or {}
    assert extra["x_hope"]["truncation"]["suspected"] is False


async def test_an_unknown_model_is_the_sdks_not_found_error(sdk, resolver) -> None:  # type: ignore[no-untyped-def]
    resolver.missing.add("nope")
    with pytest.raises(openai.NotFoundError) as caught:
        await sdk.audio.transcriptions.create(
            model="nope", file=("w.wav", wav_bytes(1.0), "audio/wav"), language="ml"
        )
    assert caught.value.code == "model_not_found"


async def test_a_wrong_token_is_the_sdks_authentication_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", TOKEN)
    app = create_app(
        Settings(), engine_factory=FakeEngineFactory(), serving_spec_client=FakeSpecResolver()
    )
    client = openai.AsyncOpenAI(
        base_url="http://vllm.test/v1",
        api_key="wrong",
        default_headers={"X-Tenant-Id": TENANT_ID},
        http_client=httpx.AsyncClient(transport=httpx.ASGITransport(app=app)),
        max_retries=0,
    )
    with pytest.raises(openai.AuthenticationError):
        await client.audio.transcriptions.create(
            model=SLUG, file=("w.wav", wav_bytes(1.0), "audio/wav"), language="ml"
        )
    await client.close()
