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
# v2 endpoint required for the incremental TextStream input mode (TASK-492).
_TEXT_STREAM_ENDPOINT = "wss://{region}.tts.speech.microsoft.com/cognitiveservices/websocket/v2"


class AzureSynthesisError(RuntimeError):
    """Azure returned a canceled/failed synthesis result (router fails over)."""


class _StreamDone:
    """Queue sentinel: Azure signalled synthesis_completed."""


class _StreamErr:
    """Queue sentinel wrapping a synthesis_canceled error."""

    def __init__(self, exc: BaseException) -> None:
        self.exc = exc


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

    # ── Native duplex (TextStream) — TASK-492 ───────────────────────────────

    def open_stream(self, req: SynthesisRequest) -> AzureTextStream:
        """Open an incremental text→audio duplex stream (v2 WS TextStream mode).

        The router only calls this for PCM at speed 1.0 — TextStream has no SSML,
        so ``speed != 1.0`` stays on the one-shot ``synthesize`` (SSML rate) path.
        """
        return AzureTextStream(self, req, self._sdk())

    def _build_stream_config(self, sdk: Any, req: SynthesisRequest) -> Any:
        endpoint = _TEXT_STREAM_ENDPOINT.format(region=self._region)
        cfg = sdk.SpeechConfig(endpoint=endpoint, subscription=self._key)
        cfg.speech_synthesis_voice_name = req.provider_voice
        cfg.set_speech_synthesis_output_format(self._output_format(sdk, req.fmt))
        # Don't abort on slow LLM token arrival between sentences (best-effort —
        # tolerate SDK builds that lack these property ids).
        prop = getattr(sdk, "PropertyId", None)
        for attr, value in (
            ("SpeechSynthesis_FrameTimeoutInterval", "10000"),
            ("SpeechSynthesis_RtfTimeoutThreshold", "100"),
        ):
            pid = getattr(prop, attr, None)
            if pid is not None:
                cfg.set_property(pid, value)
        return cfg


class AzureTextStream:
    """Duplex SynthesisStream over Azure's v2 TextStream input (SDK-only).

    Text tokens are written to ``request.input_stream``; audio arrives on the
    SDK's ``synthesizing`` event (a native callback thread), which we bridge to an
    asyncio queue via ``call_soon_threadsafe``. The blocking ``speak_async().get()``
    runs in a worker thread. ``aclose`` stops synthesis and frees the connection.
    """

    def __init__(self, provider: AzureSpeechProvider, req: SynthesisRequest, sdk: Any) -> None:
        self._provider = provider
        self._req = req
        self._sdk = sdk
        self._loop = asyncio.get_event_loop()
        self._queue: asyncio.Queue[Any] = asyncio.Queue()
        self._synth: Any = None
        self._request: Any = None
        self._speak_task: asyncio.Task[Any] | None = None
        self._started = False

    def _ensure_started(self) -> None:
        if self._started:
            return
        self._started = True
        sdk = self._sdk
        cfg = self._provider._build_stream_config(sdk, self._req)
        synth = sdk.SpeechSynthesizer(speech_config=cfg, audio_config=None)
        request = sdk.SpeechSynthesisRequest(
            input_type=sdk.SpeechSynthesisRequestInputType.TextStream
        )

        def _on_synthesizing(evt: Any) -> None:
            data = getattr(getattr(evt, "result", None), "audio_data", None)
            if data:
                self._loop.call_soon_threadsafe(self._queue.put_nowait, AudioChunk(data=bytes(data)))

        def _on_completed(_evt: Any) -> None:
            self._loop.call_soon_threadsafe(self._queue.put_nowait, _StreamDone())

        def _on_canceled(evt: Any) -> None:
            detail = getattr(evt, "cancellation_details", None) or getattr(evt, "result", None)
            self._loop.call_soon_threadsafe(
                self._queue.put_nowait,
                _StreamErr(AzureSynthesisError(f"azure text-stream canceled: {detail}")),
            )

        synth.synthesizing.connect(_on_synthesizing)
        synth.synthesis_completed.connect(_on_completed)
        synth.synthesis_canceled.connect(_on_canceled)
        self._synth = synth
        self._request = request
        # speak_async returns immediately (binds request→synth synchronously); only
        # the blocking .get() is off-loaded so writes/close can't race the binding.
        future = synth.speak_async(request)
        self._speak_task = asyncio.ensure_future(asyncio.to_thread(future.get))

    async def push_text(self, text: str) -> None:
        self._ensure_started()
        await asyncio.to_thread(self._request.input_stream.write, text)

    async def flush(self) -> None:
        # Azure TextStream synthesizes continuously — no explicit flush needed.
        self._ensure_started()

    async def end_input(self) -> None:
        self._ensure_started()
        await asyncio.to_thread(self._request.input_stream.close)

    def __aiter__(self) -> AsyncIterator[AudioChunk]:
        self._ensure_started()
        return self

    async def __anext__(self) -> AudioChunk:
        self._ensure_started()
        item = await self._queue.get()
        if isinstance(item, _StreamDone):
            raise StopAsyncIteration
        if isinstance(item, _StreamErr):
            raise item.exc
        return item

    async def aclose(self) -> None:
        if self._synth is not None:
            try:
                await asyncio.to_thread(lambda: self._synth.stop_speaking_async().get())
            except Exception:  # best-effort teardown
                logger.debug("tts_v2.azure_stream_stop_failed", exc_info=True)
        if self._speak_task is not None and not self._speak_task.done():
            self._speak_task.cancel()
            try:
                await self._speak_task
            except (asyncio.CancelledError, Exception):
                pass
        # Unblock a consumer parked on __anext__ (e.g. client disconnect).
        self._queue.put_nowait(_StreamDone())
