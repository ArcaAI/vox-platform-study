"""TDD tests for the Sarvam translate provider (TASK-600) — BYOK-only.

Sarvam's api_key NEVER comes from env/config; it arrives per request as a
``ProviderOverride``. httpx is mocked at the import site
(``smr.translation.sarvam.httpx.AsyncClient``). Verifies the wire call, that the
override supplies the key, that a missing/empty override key raises
``SarvamCredentialError``, plus chunking, blank passthrough, order preservation,
error mapping, and that the api-subscription-key never surfaces via repr/logs.
"""

from __future__ import annotations

from unittest.mock import patch

import httpx
import pytest

from smr.core.config import SarvamConfig
from smr.models.requests import ProviderOverride
from smr.translation.sarvam import (
    SarvamCredentialError,
    SarvamTranslateError,
    SarvamTranslateProvider,
)

# Every request needs a BYOK override key; the default carries one.
_KEY = ProviderOverride(api_key="tenant-key")


class _FakeResponse:
    def __init__(self, *, status_code: int = 200, json_data=None, text: str = "") -> None:
        self.status_code = status_code
        self._json = json_data if json_data is not None else {}
        self.text = text

    def json(self):
        return self._json


class _FakeAsyncClient:
    """Async-context-manager stand-in for ``httpx.AsyncClient``.

    ``responder`` maps the posted body -> ``_FakeResponse``; ``raise_exc`` makes
    every ``post`` raise (transport-error simulation). Records every call.
    """

    def __init__(self, *, responder=None, raise_exc: Exception | None = None) -> None:
        self.calls: list[dict] = []
        self._responder = responder or (
            lambda body: _FakeResponse(json_data={"translated_text": "T:" + body["input"]})
        )
        self._raise = raise_exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None, headers=None):
        self.calls.append({"url": url, "json": json, "headers": headers})
        if self._raise is not None:
            raise self._raise
        return self._responder(json)


def _patch_client(fake: _FakeAsyncClient):
    return patch("smr.translation.sarvam.httpx.AsyncClient", return_value=fake)


@pytest.mark.asyncio
async def test_override_supplies_key_and_posts_to_translate_endpoint():
    provider = SarvamTranslateProvider(SarvamConfig(base_url="https://api.sarvam.ai"))
    fake = _FakeAsyncClient()

    with _patch_client(fake):
        result = await provider.translate(
            ["hello"], source_language="auto", target_language="en-IN", overrides=_KEY
        )

    assert result == ["T:hello"]
    assert len(fake.calls) == 1
    call = fake.calls[0]
    assert call["url"] == "https://api.sarvam.ai/translate"
    assert call["headers"]["api-subscription-key"] == "tenant-key"
    assert call["json"]["input"] == "hello"
    assert call["json"]["source_language_code"] == "auto"
    assert call["json"]["target_language_code"] == "en-IN"


@pytest.mark.asyncio
async def test_override_base_url_wins_over_config():
    provider = SarvamTranslateProvider(SarvamConfig(base_url="https://api.sarvam.ai"))
    fake = _FakeAsyncClient()
    override = ProviderOverride(api_key="tenant-key", base_url="https://tenant.sarvam.ai")

    with _patch_client(fake):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=override
        )

    call = fake.calls[0]
    assert call["headers"]["api-subscription-key"] == "tenant-key"
    assert call["url"] == "https://tenant.sarvam.ai/translate"


@pytest.mark.asyncio
async def test_no_override_raises_credential_error():
    provider = SarvamTranslateProvider(SarvamConfig())
    with pytest.raises(SarvamCredentialError):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=None
        )
    # SarvamCredentialError is a SarvamTranslateError subclass (endpoint mapping).
    assert issubclass(SarvamCredentialError, SarvamTranslateError)


@pytest.mark.asyncio
async def test_override_without_key_raises_credential_error():
    provider = SarvamTranslateProvider(SarvamConfig())
    empty_key_override = ProviderOverride(api_key="")
    with pytest.raises(SarvamCredentialError):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=empty_key_override
        )


@pytest.mark.asyncio
async def test_no_network_call_when_credential_missing():
    """Credential is resolved BEFORE any client is opened — a missing key must
    never reach the transport."""
    provider = SarvamTranslateProvider(SarvamConfig())
    fake = _FakeAsyncClient()
    with _patch_client(fake), pytest.raises(SarvamCredentialError):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=None
        )
    assert fake.calls == []


@pytest.mark.asyncio
async def test_long_text_is_chunked_and_rejoined():
    provider = SarvamTranslateProvider(SarvamConfig())
    # Echo each chunk's input so we can confirm multiple calls + rejoin.
    fake = _FakeAsyncClient(
        responder=lambda body: _FakeResponse(json_data={"translated_text": body["input"]})
    )
    long_text = " ".join(["word"] * 400)  # ~2000 chars, exceeds the 900 cap

    with _patch_client(fake):
        result = await provider.translate(
            [long_text], source_language="auto", target_language="en-IN", overrides=_KEY
        )

    assert len(fake.calls) > 1  # was actually chunked
    # Rejoined chunks reconstruct the original word sequence.
    assert result[0].split() == long_text.split()


@pytest.mark.asyncio
async def test_blank_entries_pass_through_without_a_call():
    provider = SarvamTranslateProvider(SarvamConfig())
    fake = _FakeAsyncClient()

    with _patch_client(fake):
        result = await provider.translate(
            ["", "   ", "real"], source_language="auto", target_language="en-IN", overrides=_KEY
        )

    assert result == ["", "   ", "T:real"]
    assert len(fake.calls) == 1  # only the non-blank entry hit the network


@pytest.mark.asyncio
async def test_all_blank_makes_no_network_call():
    provider = SarvamTranslateProvider(SarvamConfig())
    fake = _FakeAsyncClient()
    with _patch_client(fake):
        result = await provider.translate(
            ["", "  "], source_language="auto", target_language="en-IN", overrides=_KEY
        )
    assert result == ["", "  "]
    assert fake.calls == []


@pytest.mark.asyncio
async def test_order_preserved_across_many_texts():
    provider = SarvamTranslateProvider(SarvamConfig())
    fake = _FakeAsyncClient(
        responder=lambda body: _FakeResponse(json_data={"translated_text": "T:" + body["input"]})
    )
    texts = [f"seg-{i}" for i in range(10)]

    with _patch_client(fake):
        result = await provider.translate(
            texts, source_language="auto", target_language="en-IN", overrides=_KEY
        )

    assert result == [f"T:seg-{i}" for i in range(10)]


@pytest.mark.asyncio
async def test_http_401_raises_translate_error():
    provider = SarvamTranslateProvider(SarvamConfig())
    fake = _FakeAsyncClient(
        responder=lambda body: _FakeResponse(status_code=401, text="unauthorized")
    )

    with _patch_client(fake), pytest.raises(SarvamTranslateError) as exc_info:
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=_KEY
        )
    assert "401" in str(exc_info.value)


@pytest.mark.asyncio
async def test_transport_error_raises_translate_error():
    provider = SarvamTranslateProvider(SarvamConfig())
    fake = _FakeAsyncClient(raise_exc=httpx.ConnectError("boom"))

    with _patch_client(fake), pytest.raises(SarvamTranslateError):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=_KEY
        )


def test_api_key_never_appears_in_repr():
    override = ProviderOverride(api_key="super-secret-key")
    provider = SarvamTranslateProvider(SarvamConfig())
    assert "super-secret-key" not in repr(provider)
    assert "super-secret-key" not in str(provider)
    # The override object itself must not leak the key either.
    assert "super-secret-key" not in repr(override)
    assert "super-secret-key" not in str(override)


@pytest.mark.asyncio
async def test_key_never_logged_on_error(caplog):
    provider = SarvamTranslateProvider(SarvamConfig())
    fake = _FakeAsyncClient(raise_exc=httpx.ConnectError("boom"))
    override = ProviderOverride(api_key="super-secret-key")

    with _patch_client(fake), pytest.raises(SarvamTranslateError):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=override
        )
    assert "super-secret-key" not in caplog.text


@pytest.mark.asyncio
async def test_override_model_included_in_request_body():
    provider = SarvamTranslateProvider(SarvamConfig(model=None))
    fake = _FakeAsyncClient()
    override = ProviderOverride(api_key="tenant-key", model="mayura:v1")

    with _patch_client(fake):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=override
        )
    assert fake.calls[0]["json"]["model"] == "mayura:v1"


@pytest.mark.asyncio
async def test_config_model_used_when_override_has_no_model():
    provider = SarvamTranslateProvider(SarvamConfig(model="config-model"))
    fake = _FakeAsyncClient()

    with _patch_client(fake):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=_KEY
        )
    assert fake.calls[0]["json"]["model"] == "config-model"
