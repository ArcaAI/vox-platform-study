"""TDD tests for the Sarvam translate provider — connection-only.

The api_key, the base_url AND the model all arrive per request as a
``ProviderOverride``; Sarvam holds no configuration of its own. httpx is mocked
at the import site (``text.translation.sarvam.httpx.AsyncClient``).

The MODEL is the part worth stating plainly. Unlike every other ``*_MODEL`` in
this service — which only decorated the `/providers` listing — Sarvam's reaches
the wire as the request's ``model`` field, so ``TEXT_SARVAM_MODEL`` was a
process-wide model SELECTION for every tenant. Selection is ``failMode: closed``,
so it resolves from `AiTaskDefault` and an unresolved value RAISES rather than
letting the vendor pick its own default.

Verifies the wire call, the three fail-closed paths (no connection, no key, no
model), chunking, blank passthrough, order preservation, error mapping, and that
the api-subscription-key never surfaces via repr/logs.
"""

from __future__ import annotations

from unittest.mock import patch

import httpx
import pytest

from text.models.requests import ProviderOverride
from text.translation.sarvam import (
    SarvamCredentialError,
    SarvamModelError,
    SarvamTranslateError,
    SarvamTranslateProvider,
)

# Every request needs a resolved connection: key, endpoint AND model.
_KEY = ProviderOverride(api_key="tenant-key", base_url="https://api.sarvam.ai", model="bulbul:v3")


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
    return patch("text.translation.sarvam.httpx.AsyncClient", return_value=fake)


@pytest.mark.asyncio
async def test_override_supplies_key_and_posts_to_translate_endpoint():
    provider = SarvamTranslateProvider()
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
async def test_the_connection_supplies_the_endpoint():
    """A tenant fronting its own Sarvam endpoint is routed there.

    There is no platform `base_url` for this to "win over" any more — the
    connection is the only source, which is what makes a per-tenant endpoint
    expressible at all."""
    provider = SarvamTranslateProvider()
    fake = _FakeAsyncClient()
    override = ProviderOverride(
        api_key="tenant-key", base_url="https://tenant.sarvam.ai", model="bulbul:v3"
    )

    with _patch_client(fake):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=override
        )

    call = fake.calls[0]
    assert call["headers"]["api-subscription-key"] == "tenant-key"
    assert call["url"] == "https://tenant.sarvam.ai/translate"


@pytest.mark.asyncio
async def test_no_override_raises_credential_error():
    provider = SarvamTranslateProvider()
    with pytest.raises(SarvamCredentialError):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=None
        )
    # SarvamCredentialError is a SarvamTranslateError subclass (endpoint mapping).
    assert issubclass(SarvamCredentialError, SarvamTranslateError)


@pytest.mark.asyncio
async def test_override_without_key_raises_credential_error():
    provider = SarvamTranslateProvider()
    empty_key_override = ProviderOverride(api_key="", base_url="https://api.sarvam.ai")
    with pytest.raises(SarvamCredentialError):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=empty_key_override
        )


@pytest.mark.asyncio
async def test_connection_without_a_model_fails_closed():
    """Model selection is fail-closed: no `AiTaskDefault` resolved ⇒ raise.

    Omitting the field instead would hand the choice of translation model to
    Sarvam's own default — a silent change of clinical behaviour on a vendor-side
    release, chosen by nobody.
    """
    provider = SarvamTranslateProvider()
    fake = _FakeAsyncClient()
    modelless = ProviderOverride(api_key="tenant-key", base_url="https://api.sarvam.ai")

    with _patch_client(fake), pytest.raises(SarvamModelError):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=modelless
        )
    assert fake.calls == [], "no request may reach the wire without a resolved model"


@pytest.mark.asyncio
async def test_connection_without_an_endpoint_fails_closed():
    provider = SarvamTranslateProvider()
    fake = _FakeAsyncClient()
    endpointless = ProviderOverride(api_key="tenant-key", model="bulbul:v3")

    with _patch_client(fake), pytest.raises(SarvamCredentialError):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=endpointless
        )
    assert fake.calls == []


@pytest.mark.asyncio
async def test_no_network_call_when_credential_missing():
    """Credential is resolved BEFORE any client is opened — a missing key must
    never reach the transport."""
    provider = SarvamTranslateProvider()
    fake = _FakeAsyncClient()
    with _patch_client(fake), pytest.raises(SarvamCredentialError):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=None
        )
    assert fake.calls == []


@pytest.mark.asyncio
async def test_long_text_is_chunked_and_rejoined():
    provider = SarvamTranslateProvider()
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
    provider = SarvamTranslateProvider()
    fake = _FakeAsyncClient()

    with _patch_client(fake):
        result = await provider.translate(
            ["", "   ", "real"], source_language="auto", target_language="en-IN", overrides=_KEY
        )

    assert result == ["", "   ", "T:real"]
    assert len(fake.calls) == 1  # only the non-blank entry hit the network


@pytest.mark.asyncio
async def test_all_blank_makes_no_network_call():
    provider = SarvamTranslateProvider()
    fake = _FakeAsyncClient()
    with _patch_client(fake):
        result = await provider.translate(
            ["", "  "], source_language="auto", target_language="en-IN", overrides=_KEY
        )
    assert result == ["", "  "]
    assert fake.calls == []


@pytest.mark.asyncio
async def test_order_preserved_across_many_texts():
    provider = SarvamTranslateProvider()
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
    provider = SarvamTranslateProvider()
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
    provider = SarvamTranslateProvider()
    fake = _FakeAsyncClient(raise_exc=httpx.ConnectError("boom"))

    with _patch_client(fake), pytest.raises(SarvamTranslateError):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=_KEY
        )


def test_api_key_never_appears_in_repr():
    override = ProviderOverride(api_key="super-secret-key")
    provider = SarvamTranslateProvider()
    assert "super-secret-key" not in repr(provider)
    assert "super-secret-key" not in str(provider)
    # The override object itself must not leak the key either.
    assert "super-secret-key" not in repr(override)
    assert "super-secret-key" not in str(override)


@pytest.mark.asyncio
async def test_key_never_logged_on_error(caplog):
    provider = SarvamTranslateProvider()
    fake = _FakeAsyncClient(raise_exc=httpx.ConnectError("boom"))
    override = ProviderOverride(api_key="super-secret-key")

    with _patch_client(fake), pytest.raises(SarvamTranslateError):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=override
        )
    assert "super-secret-key" not in caplog.text


@pytest.mark.asyncio
async def test_the_resolved_model_is_sent_on_the_wire():
    """The reason this model could never be an env var: it is a wire field."""
    provider = SarvamTranslateProvider()
    fake = _FakeAsyncClient()
    override = ProviderOverride(
        api_key="tenant-key", base_url="https://api.sarvam.ai", model="mayura:v1"
    )

    with _patch_client(fake):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=override
        )
    assert fake.calls[0]["json"]["model"] == "mayura:v1"


@pytest.mark.asyncio
async def test_the_reported_model_is_the_one_used():
    """`provider.model` reports what ran, never what was configured."""
    provider = SarvamTranslateProvider()
    assert provider.model is None

    fake = _FakeAsyncClient()
    with _patch_client(fake):
        await provider.translate(
            ["hi"], source_language="auto", target_language="en-IN", overrides=_KEY
        )
    assert provider.model == "bulbul:v3"
