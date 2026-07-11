"""Provider-selection router.

Resolves a voice → locale → ordered provider chain, then synthesizes through the
first healthy provider. Failover happens ONLY before the first audio byte —
switching providers mid-stream would produce an audible voice seam, so a
mid-stream failure is surfaced as an error instead. Per-provider circuit
breakers skip providers that are failing.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from contextlib import aclosing
from dataclasses import replace

from tts_v2.catalog.voices import Voice, VoiceCatalog
from tts_v2.core.config import Settings
from tts_v2.core.metrics import (
    TTS_ACTIVE_STREAMS,
    TTS_FAILOVER,
    TTS_PROVIDER_ERRORS,
    TTS_REQUESTS,
    TTS_RTF,
    TTS_TTFA,
)
from tts_v2.providers.base import (
    AudioChunk,
    AudioFormat,
    ProviderRegistry,
    SynthesisRequest,
    TTSEngine,
)
from tts_v2.routing.chunking import chunk_text
from tts_v2.routing.circuit_breaker import CircuitBreaker

CB_FAILURE_THRESHOLD = 5
CB_RECOVERY_TIMEOUT_S = 30.0


class AllProvidersUnavailableError(RuntimeError):
    """No registered, bound, closed-circuit provider could serve the voice."""

    def __init__(self, voice_id: str) -> None:
        super().__init__(f"no TTS provider available for voice '{voice_id}'")
        self.voice_id = voice_id


class TTSRouter:
    def __init__(
        self,
        registry: ProviderRegistry,
        catalog: VoiceCatalog,
        settings: Settings,
        *,
        cb_threshold: int = CB_FAILURE_THRESHOLD,
        cb_recovery_s: float = CB_RECOVERY_TIMEOUT_S,
    ) -> None:
        self._registry = registry
        self._catalog = catalog
        self._settings = settings
        self._cb_threshold = cb_threshold
        self._cb_recovery_s = cb_recovery_s
        self._breakers: dict[str, CircuitBreaker] = {}

    def breaker(self, name: str) -> CircuitBreaker:
        if name not in self._breakers:
            self._breakers[name] = CircuitBreaker(self._cb_threshold, self._cb_recovery_s)
        return self._breakers[name]

    def resolve_chain(self, locale: str) -> list[str]:
        """Locale → ordered provider chain. Code-switch ``ml-en`` → ml chain."""
        base = locale.split("-")[0]
        chain = self._settings.routing_ml if base == "ml" else self._settings.routing_en
        return list(chain)

    def candidates(self, voice: Voice) -> list[str]:
        """Providers that are registered, bound to this voice, and not tripped."""
        out: list[str] = []
        for name in self.resolve_chain(voice.locale):
            if name not in self._registry:
                continue
            if name not in voice.bindings:
                continue
            if self.breaker(name).is_open():
                continue
            out.append(name)
        return out

    async def synthesize(
        self,
        *,
        voice_id: str,
        text: str,
        fmt: AudioFormat = AudioFormat.PCM,
        speed: float = 1.0,
        request_id: str = "",
    ) -> AsyncIterator[AudioChunk]:
        voice = self._catalog.get(voice_id)  # VoiceNotFoundError → 404 at endpoint
        locale = voice.locale
        candidates = self.candidates(voice)
        if not candidates:
            TTS_REQUESTS.labels(provider="none", locale=locale, status="unavailable").inc()
            raise AllProvidersUnavailableError(voice_id)

        last_exc: Exception | None = None
        failed_from: str | None = None
        for name in candidates:
            if failed_from is not None:
                TTS_FAILOVER.labels(from_provider=failed_from, to_provider=name).inc()
                failed_from = None

            engine: TTSEngine = self._registry.get(name)
            breaker = self.breaker(name)
            req = SynthesisRequest(
                text=text,
                provider_voice=voice.bindings[name],
                locale=locale,
                fmt=fmt,
                speed=speed,
                sample_rate=self._settings.sample_rate,
                request_id=request_id,
            )
            emitted = False
            audio_bytes = 0
            started = time.perf_counter()
            TTS_ACTIVE_STREAMS.labels(provider=name).inc()
            try:
                source = (
                    engine.synthesize(req)
                    if engine.native_streaming
                    else self._sentence_adapter(engine, req)
                )
                async with aclosing(source) as stream:
                    async for chunk in stream:
                        if not emitted:
                            TTS_TTFA.labels(provider=name, locale=locale).observe(
                                time.perf_counter() - started
                            )
                            emitted = True
                        audio_bytes += len(chunk.data)
                        yield chunk
                breaker.record_success()
                self._observe_rtf(name, req, audio_bytes, time.perf_counter() - started)
                TTS_REQUESTS.labels(provider=name, locale=locale, status="ok").inc()
                return
            except Exception as exc:
                breaker.record_failure()
                TTS_PROVIDER_ERRORS.labels(provider=name, type=type(exc).__name__).inc()
                last_exc = exc
                if emitted:
                    # Audio already flowing — never switch providers mid-stream.
                    TTS_REQUESTS.labels(
                        provider=name, locale=locale, status="error_midstream"
                    ).inc()
                    raise
                failed_from = name
                continue
            finally:
                TTS_ACTIVE_STREAMS.labels(provider=name).dec()

        TTS_REQUESTS.labels(provider="none", locale=locale, status="unavailable").inc()
        raise AllProvidersUnavailableError(voice_id) from last_exc

    async def _sentence_adapter(
        self, engine: TTSEngine, req: SynthesisRequest
    ) -> AsyncIterator[AudioChunk]:
        """Feed a non-streaming engine one sentence at a time for early first-audio."""
        for sentence in chunk_text(req.text, req.locale, self._settings.max_input_chars):
            sub = replace(req, text=sentence)
            async with aclosing(engine.synthesize(sub)) as stream:
                async for chunk in stream:
                    yield chunk

    def _observe_rtf(
        self, name: str, req: SynthesisRequest, audio_bytes: int, gen_s: float
    ) -> None:
        if req.fmt == AudioFormat.PCM and req.sample_rate and audio_bytes:
            audio_s = audio_bytes / (2 * req.sample_rate)  # s16le mono
            if audio_s > 0:
                TTS_RTF.labels(provider=name).observe(gen_s / audio_s)
