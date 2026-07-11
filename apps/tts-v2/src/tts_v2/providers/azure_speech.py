"""Azure AI Speech text-to-speech provider.

Streams audio incrementally via ``start_speaking_*_async`` + ``AudioDataStream``
(the documented low-latency path — first-byte latency is independent of text
length). The Azure SDK is synchronous/blocking, so each blocking call is
off-loaded with ``asyncio.to_thread``. The SDK is imported lazily so this module
(and hermetic tests) load without the native ``azure-cognitiveservices-speech``
wheel; tests inject a fake SDK.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any
from xml.sax.saxutils import escape

from tts_v2.core.config import AzureSpeechConfig
from tts_v2.core.logging import get_logger
from tts_v2.providers.base import AudioChunk, AudioFormat, SynthesisRequest

logger = get_logger(__name__)

_CHUNK_BYTES = 4096


class AzureSynthesisError(RuntimeError):
    """Azure returned a canceled/failed synthesis result (router fails over)."""


class AzureSpeechProvider:
    """TTSEngine backed by Azure AI Speech."""

    name = "azure"
    supported_locales = {"en-IN", "en-US", "ml-IN"}
    native_streaming = True

    def __init__(
        self,
        config: AzureSpeechConfig,
        *,
        sdk: Any | None = None,
        chunk_bytes: int = _CHUNK_BYTES,
    ) -> None:
        self._config = config
        self._key = config.api_key.get_secret_value()
        self._region = config.region
        self._sdk_mod = sdk
        self._chunk_bytes = chunk_bytes

    def _sdk(self) -> Any:
        if self._sdk_mod is None:
            import azure.cognitiveservices.speech as speechsdk  # lazy, native dep

            self._sdk_mod = speechsdk
        return self._sdk_mod

    async def health(self) -> bool:
        return bool(self._key)

    def _output_format(self, sdk: Any, fmt: AudioFormat) -> Any:
        formats = sdk.SpeechSynthesisOutputFormat
        return {
            AudioFormat.PCM: formats.Raw24Khz16BitMonoPcm,
            AudioFormat.WAV: formats.Riff24Khz16BitMonoPcm,
            AudioFormat.MP3: formats.Audio24Khz48KBitRateMonoMp3,
        }[fmt]

    def _build_config(self, sdk: Any, req: SynthesisRequest) -> Any:
        cfg = sdk.SpeechConfig(subscription=self._key, region=self._region)
        cfg.speech_synthesis_voice_name = req.provider_voice
        cfg.set_speech_synthesis_output_format(self._output_format(sdk, req.fmt))
        return cfg

    def _ssml(self, req: SynthesisRequest) -> str:
        rate = f"{(req.speed - 1.0) * 100:+.0f}%"
        return (
            '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
            f'xml:lang="{req.locale}"><voice name="{req.provider_voice}">'
            f'<prosody rate="{rate}">{escape(req.text)}</prosody></voice></speak>'
        )

    async def synthesize(self, req: SynthesisRequest) -> AsyncIterator[AudioChunk]:
        sdk = self._sdk()
        cfg = self._build_config(sdk, req)
        synth = sdk.SpeechSynthesizer(speech_config=cfg, audio_config=None)

        if req.speed != 1.0:
            ssml = self._ssml(req)
            result = await asyncio.to_thread(lambda: synth.start_speaking_ssml_async(ssml).get())
        else:
            result = await asyncio.to_thread(lambda: synth.start_speaking_text_async(req.text).get())

        if result.reason == sdk.ResultReason.Canceled:
            detail = getattr(result, "cancellation_details", None)
            raise AzureSynthesisError(f"azure synthesis canceled: {detail}")

        stream = sdk.AudioDataStream(result)
        while True:
            buffer = bytearray(self._chunk_bytes)
            filled = await asyncio.to_thread(stream.read_data, buffer)
            if not filled:
                break
            yield AudioChunk(data=bytes(buffer[:filled]))

    async def prewarm(self) -> None:
        """Open a connection to warm DNS/TLS/token — best-effort, called at startup."""
        sdk = self._sdk()
        cfg = sdk.SpeechConfig(subscription=self._key, region=self._region)
        synth = sdk.SpeechSynthesizer(speech_config=cfg, audio_config=None)

        def _open() -> None:
            connection = sdk.Connection.from_speech_synthesizer(synth)
            connection.open(True)

        await asyncio.to_thread(_open)
