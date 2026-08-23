"""Sarvam AI Bulbul TTS provider (cloud).

Best-quality path for code-switched clinical Malayalam. Calls the REST
`POST /text-to-speech` endpoint; the response is a base64 audio string. Output
is native 24 kHz (no resample). `native_streaming=False` → the router's sentence
adapter provides incremental per-sentence chunking; the WebSocket streaming API
is a phase-2 upgrade (`use_streaming`).

⚠️ PHI: the public Sarvam API is NOT India-resident / zero-retention and has no
HIPAA/BAA — point `base_url` at the enterprise VPC/on-prem host before enabling
for real patient data.

NOTE (wav/mp3): with the per-sentence adapter, `wav`/`mp3` yield one container per
sentence. PCM (the realtime/browser path) concatenates gaplessly; single-container
wav/mp3 for multi-sentence text is a follow-up — cloud fallback (Azure) serves it.
"""

from __future__ import annotations

import base64
from collections.abc import AsyncGenerator

import httpx

from tts.core.config import SarvamConfig
from tts.core.logging import get_logger
from tts.providers.base import AudioChunk, AudioFormat, SynthesisRequest

logger = get_logger(__name__)

_CODEC = {AudioFormat.PCM: "linear16", AudioFormat.WAV: "wav", AudioFormat.MP3: "mp3"}
_LOCALE = {"ml": "ml-IN", "en": "en-IN"}
_CHUNK_BYTES = 8192


class SarvamSynthesisError(RuntimeError):
    """Sarvam returned a non-2xx or malformed response (router fails over)."""


class SarvamProvider:
    name = "sarvam"
    supported_locales = {"ml-IN", "en-IN"}
    native_streaming = False

    def __init__(self, config: SarvamConfig, *, client: httpx.AsyncClient | None = None) -> None:
        self._config = config
        self._client = client  # injectable for tests
        # A keyless instance (empty platform config) is NOT usable — the
        # router excludes it from candidates. A per-tenant override builds its own
        # keyed instance via the router's `_build_override_engine`.
        self.is_configured = bool(config.api_key.get_secret_value())

    def _target_language(self, locale: str) -> str:
        return _LOCALE.get(locale.split("-")[0], "en-IN")

    async def health(self) -> bool:
        return bool(self._config.api_key.get_secret_value())

    async def synthesize(self, req: SynthesisRequest) -> AsyncGenerator[AudioChunk, None]:
        payload = {
            "text": req.text,
            "target_language_code": self._target_language(req.locale),
            "model": self._config.model,
            # The catalog binding, always. There is no config fallback since
            # TASK-799 lane C: `voice_ml`/`voice_en` both held `ishita`, which is
            # already the catalog's sarvam binding, and the router guarantees
            # `provider_voice` is set (`candidates()` skips a provider the voice
            # is not bound to).
            "speaker": req.provider_voice,
            "speech_sample_rate": str(req.sample_rate),
            "output_audio_codec": _CODEC.get(req.fmt, "linear16"),
            "pace": max(0.5, min(req.speed, 2.0)),
        }
        if self._config.model.startswith("bulbul:v2"):
            payload["enable_preprocessing"] = True

        headers = {
            "api-subscription-key": self._config.api_key.get_secret_value(),
            "Content-Type": "application/json",
        }
        url = f"{self._config.base_url.rstrip('/')}/text-to-speech"

        client = self._client or httpx.AsyncClient(timeout=self._config.timeout_s)
        owns = self._client is None
        try:
            try:
                resp = await client.post(url, json=payload, headers=headers)
            except httpx.HTTPError as exc:
                raise SarvamSynthesisError(f"sarvam request failed: {exc}") from exc
            if resp.status_code >= 400:
                raise SarvamSynthesisError(f"sarvam HTTP {resp.status_code}")
            audios = (resp.json() or {}).get("audios") or []
            if not audios:
                raise SarvamSynthesisError("sarvam response missing audio")
            audio = base64.b64decode(audios[0])
        finally:
            if owns:
                await client.aclose()

        if req.fmt == AudioFormat.PCM:
            for offset in range(0, len(audio), _CHUNK_BYTES):
                yield AudioChunk(data=audio[offset : offset + _CHUNK_BYTES])
        else:
            yield AudioChunk(data=audio, is_final=True)
