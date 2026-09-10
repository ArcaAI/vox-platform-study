"""Sarvam AI translate provider — plain httpx, no vendor SDK.

Ported into Text from the former ``apps/stt`` helper (that STT copy is being
deleted by a separate task — do NOT import from STT). Translates each text via
Sarvam's REST ``/translate`` endpoint.

Sarvam is BYOK-ONLY and now connection-only: the ``api_key``, the ``base_url``
AND the ``model`` all arrive per request as a ``ProviderOverride`` (the gateway
resolves it from the tenant/super-admin provider-connection). A request with no
override fails closed (``SarvamCredentialError`` / ``SarvamModelError`` → 503).

The model matters more here than for the LLM adapters, and that is why
``TEXT_SARVAM_MODEL`` had to go rather than merely being emptied: unlike every
other ``*_MODEL`` env var in this service — which only decorated the `/providers`
listing — this one REACHED THE WIRE as the request's ``model`` field. A
process-wide value therefore chose the translation model for every tenant, which
is precisely a model SELECTION, and selection is ``failMode: closed``
(`.claude/rules/09-infrastructure-devops.md` §Configuration Tiers): it resolves
through `AiRoutingPolicy` tenant → SYSTEM, and an unresolved selection raises
rather than letting the vendor pick a default nobody chose.

Security invariant: the ``api-subscription-key`` is passed in the request header
and never formatted into a log line, exception message, or repr. Error paths
carry response bodies / status text, never the key; the override key is a
``SecretStr`` read only at the single point it is handed to the transport.
"""

from __future__ import annotations

import asyncio

import httpx
import structlog

from text.models.requests import ProviderOverride

logger = structlog.get_logger(__name__)

_PROVIDER_NAME = "sarvam"
# Sarvam accepts a bounded input per call; chunk longer text on whitespace
# boundaries and rejoin. Conservative — a single clinical turn is far under.
_MAX_CHARS = 900
# Bounded fan-out when translating many segments at once.
_MAX_CONCURRENCY = 5
# Generous per-request timeout — a chunk is small, but a slow link must not hang.
_TIMEOUT_S = 60.0


class SarvamTranslateError(Exception):
    """Sarvam translation failure (auth / quota / transport / bad response)."""


class SarvamCredentialError(SarvamTranslateError):
    """No usable Sarvam API key — no connection was injected for this request.

    A distinct subclass so the endpoint can map a missing credential to a 503
    (retryable/misconfiguration) rather than the generic 502 upstream failure.
    """


class SarvamModelError(SarvamTranslateError):
    """No translation model resolved for this request.

    Selection is fail-closed: Sarvam's ``model`` reaches the wire, so an
    unresolved value must raise rather than let the vendor substitute one. Mapped
    to the same 503 as a missing credential — both are a platform-configuration
    gap an admin can close, not a caller error.
    """


def _chunk_text(text: str, max_chars: int) -> list[str]:
    """Split ``text`` into <= ``max_chars`` chunks on whitespace boundaries.

    A single token longer than ``max_chars`` is kept whole. Returns ``[text]``
    when it already fits.
    """
    if len(text) <= max_chars:
        return [text]
    chunks: list[str] = []
    current = ""
    for word in text.split(" "):
        if not current:
            current = word
        elif len(current) + 1 + len(word) <= max_chars:
            current = f"{current} {word}"
        else:
            chunks.append(current)
            current = word
    if current:
        chunks.append(current)
    return chunks or [text]


class SarvamTranslateProvider:
    """Sarvam translate provider (implements ``TranslateProvider``)."""

    def __init__(self) -> None:
        """No configuration. Endpoint, credential and model all arrive with the
        request as a gateway-resolved ``ProviderOverride``."""
        #: Last model actually used, surfaced on the response. Never a default:
        #: it is set only after a real selection resolved.
        self.model: str | None = None

    def _resolve_key(self, overrides: ProviderOverride | None) -> str:
        """BYOK-only credential resolution. The api_key comes ONLY from the
        per-request override — there is NO platform/env fallback. Raises
        ``SarvamCredentialError`` if the override is absent or carries no key.
        The key is NEVER logged."""
        if overrides is not None:
            override_key = overrides.api_key.get_secret_value()
            if override_key:
                return override_key
        raise SarvamCredentialError(
            "No Sarvam API key: this provider is BYOK-only — the key must be "
            "supplied per request via provider_overrides (there is no "
            "platform/env fallback)."
        )

    def _resolve_base_url(self, overrides: ProviderOverride | None) -> str:
        """The endpoint from the injected connection. Fail-closed: Text holds no
        ``TEXT_SARVAM_BASE_URL`` to fall back to."""
        if overrides is not None and overrides.base_url:
            return overrides.base_url.rstrip("/")
        raise SarvamCredentialError(
            "No Sarvam connection: the endpoint must arrive per request via "
            "provider_overrides (there is no platform/env fallback)."
        )

    def _resolve_model(self, overrides: ProviderOverride | None) -> str:
        """The model from the resolved `AiRoutingPolicy` selection. Fail-closed.

        Sarvam's ``model`` goes on the wire, so an unresolved selection raises
        instead of omitting the field and letting the vendor pick — which would
        silently change the translation model on a vendor-side default change.
        """
        if overrides is not None and overrides.model:
            return overrides.model
        raise SarvamModelError(
            "No Sarvam translation model selected. Model selection is "
            "fail-closed: configure an AiRoutingPolicy for the translate task "
            "(tenant, or the SYSTEM-tenant platform default). Text substitutes "
            "no model of its own."
        )

    async def translate(
        self,
        texts: list[str],
        *,
        source_language: str,
        target_language: str,
        overrides: ProviderOverride | None = None,
    ) -> list[str]:
        """Translate ``texts`` 1:1 (order preserved). Blank/whitespace entries
        pass through unchanged without a network call. Reuses ONE
        ``httpx.AsyncClient`` per call with bounded concurrency."""
        api_key = self._resolve_key(overrides)  # raises SarvamCredentialError
        base_url = self._resolve_base_url(overrides)
        model = self._resolve_model(overrides)  # raises SarvamModelError
        # Report what was actually used, not what was configured.
        self.model = model

        if not any(text and text.strip() for text in texts):
            return list(texts)

        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            semaphore = asyncio.Semaphore(_MAX_CONCURRENCY)

            async def _one(text: str) -> str:
                if not text or not text.strip():
                    return text
                async with semaphore:
                    return await self._translate_text(
                        client,
                        api_key=api_key,
                        base_url=base_url,
                        text=text,
                        source_language=source_language,
                        target_language=target_language,
                        model=model,
                    )

            return list(await asyncio.gather(*[_one(text) for text in texts]))

    async def _translate_text(
        self,
        client: httpx.AsyncClient,
        *,
        api_key: str,
        base_url: str,
        text: str,
        source_language: str,
        target_language: str,
        model: str,
    ) -> str:
        chunks = _chunk_text(text, _MAX_CHARS)
        translated = [
            await self._translate_chunk(
                client,
                api_key=api_key,
                base_url=base_url,
                chunk=chunk,
                source_language=source_language,
                target_language=target_language,
                model=model,
            )
            for chunk in chunks
        ]
        return " ".join(part for part in translated if part)

    async def _translate_chunk(
        self,
        client: httpx.AsyncClient,
        *,
        api_key: str,
        base_url: str,
        chunk: str,
        source_language: str,
        target_language: str,
        model: str,
    ) -> str:
        body: dict[str, str] = {
            "input": chunk,
            "source_language_code": source_language,
            "target_language_code": target_language,
            "model": model,
        }
        headers = {"api-subscription-key": api_key}
        url = base_url.rstrip("/") + "/translate"

        try:
            response = await client.post(url, json=body, headers=headers)
        except httpx.RequestError as exc:
            raise SarvamTranslateError(
                f"sarvam translate transport error: {type(exc).__name__}"
            ) from exc

        if response.status_code >= 400:
            raise SarvamTranslateError(
                f"sarvam translate error (HTTP {response.status_code}): {response.text[:300]}"
            )

        payload = response.json()
        return (payload.get("translated_text") or "").strip()

    async def health_check(self) -> bool:
        """Reachability of the provider itself. Sarvam exposes no cheap
        credential-free probe and is BYOK-only (no platform key to probe with),
        so this reports availability of the registered provider (True) rather
        than making a network call."""
        return True
