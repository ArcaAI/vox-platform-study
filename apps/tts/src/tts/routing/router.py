"""Provider-selection router.

Resolves a voice → locale → ordered provider chain, then synthesizes through the
first healthy provider. Failover happens ONLY before the first audio byte —
switching providers mid-stream would produce an audible voice seam, so a
mid-stream failure is surfaced as an error instead. Per-provider circuit
breakers skip providers that are failing.
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import aclosing
from dataclasses import replace

from tts.catalog.voices import Voice, VoiceCatalog
from tts.core.config import Settings
from tts.core.metrics import (
    TTS_ACTIVE_STREAMS,
    TTS_FAILOVER,
    TTS_PROVIDER_ERRORS,
    TTS_REQUESTS,
    TTS_RTF,
    TTS_TTFA,
    track_model_inference,
)
from tts.core.usage import compute_audio_seconds
from tts.providers.base import (
    AudioChunk,
    AudioFormat,
    DuplexTTSEngine,
    ProviderRegistry,
    SynthesisRequest,
    SynthesisStream,
    TTSEngine,
)
from tts.routing.chunking import chunk_text
from tts.routing.circuit_breaker import CircuitBreaker
from tts.routing.sentence_adapter import SentenceAdapter

CB_FAILURE_THRESHOLD = 5
CB_RECOVERY_TIMEOUT_S = 30.0


class AllProvidersUnavailableError(RuntimeError):
    """No registered, bound, closed-circuit provider could serve the voice."""

    def __init__(self, voice_id: str) -> None:
        super().__init__(f"no TTS provider available for voice '{voice_id}'")
        self.voice_id = voice_id


class TtsRoutingUnconfiguredError(AllProvidersUnavailableError):
    """No routing chain was injected for this locale — FAIL CLOSED.

    The router carries NO code/env vendor default (TASK-577 / F1): the per-locale
    provider order is DB-sourced (the SYSTEM ``TenantTtsConfig`` default, resolved
    by the gateway and injected per request). When nothing is injected we raise
    rather than substitute a vendor. Subclasses ``AllProvidersUnavailableError``
    so the endpoints' existing 503 (HTTP) / provider-unavailable (WS) handlers
    already surface it as an unavailable-provider condition — never as a silent
    vendor fallback.
    """

    def __init__(self, locale: str) -> None:
        # Bypass the parent voice-oriented message; this is a routing gap.
        RuntimeError.__init__(self, f"no TTS routing configured for locale '{locale}'")
        self.voice_id = ""
        self.locale = locale


# Per-tenant BYO credentials the gateway decrypts + injects:
# ``{"azure": {"api_key": ..., "region": ...}, "sarvam": {"api_key": ..., "base_url": ...}}``.
ProviderOverrides = dict[str, dict[str, str]]

# Per-request voice-binding overrides the gateway resolves from the AiModel
# registry / tenant TTS config and injects:
# ``{internalVoiceId: {provider: providerVoiceName}}``.
VoiceBindings = dict[str, dict[str, str]]


def _apply_voice_bindings(voice: Voice, voice_bindings: VoiceBindings | None) -> Voice:
    """Apply a gateway-injected binding override for this voice.

    A present override MERGES over the voice's catalog binding map: mentioned
    providers get the overridden voice name, unmentioned providers keep their
    catalog binding (and thus their failover eligibility — the admin UI's
    "empty = inherit" semantics). Malformed entries (non-string provider/voice
    names) are dropped; an absent/empty or fully malformed override keeps the
    catalog bindings. Returns a frozen copy — the global ``VoiceCatalog`` is
    never mutated.
    """
    if not voice_bindings:
        return voice
    override = voice_bindings.get(voice.id)
    if not isinstance(override, dict):
        return voice
    clean = {
        provider: name
        for provider, name in override.items()
        if isinstance(provider, str) and provider and isinstance(name, str) and name
    }
    if not clean:
        return voice
    return replace(voice, bindings={**voice.bindings, **clean})


def _override_cache_key(name: str, override: dict[str, str]) -> str:
    raw = f"{name}|{override.get('api_key', '')}|{override.get('region', '')}|{override.get('base_url', '')}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _build_override_engine(
    settings: Settings, name: str, override: dict[str, str]
) -> TTSEngine | None:
    """Build a per-tenant provider from injected BYO credentials.

    Clones the platform base config with the tenant's key/endpoint. Returns None
    for a provider that takes no BYO key or an unknown name (→ fall back to the
    shared registered engine). Provider imports are lazy to keep the router light.
    """
    from pydantic import SecretStr

    api_key = override.get("api_key")
    if not api_key:
        return None
    if name == "azure":
        from tts.providers.azure_speech import AzureSpeechProvider

        update: dict[str, object] = {"api_key": SecretStr(api_key), "enabled": True}
        if override.get("region"):
            update["region"] = override["region"]
        return AzureSpeechProvider(settings.azure.model_copy(update=update))
    if name == "sarvam":
        from tts.providers.sarvam import SarvamProvider

        update = {"api_key": SecretStr(api_key), "enabled": True}
        if override.get("base_url"):
            update["base_url"] = override["base_url"]
        return SarvamProvider(settings.sarvam.model_copy(update=update))
    return None


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
        # Per-tenant BYO provider instances, cached by credential hash.
        self._tenant_engines: dict[str, TTSEngine] = {}

    def breaker(self, name: str) -> CircuitBreaker:
        if name not in self._breakers:
            self._breakers[name] = CircuitBreaker(self._cb_threshold, self._cb_recovery_s)
        return self._breakers[name]

    def resolve_chain(
        self,
        locale: str,
        *,
        routing_en: list[str] | None = None,
        routing_ml: list[str] | None = None,
    ) -> list[str]:
        """Locale → ordered provider chain. Code-switch ``ml-en`` → ml chain.

        The chain comes ONLY from the per-request ``routing_en``/``routing_ml``
        the gateway injects from the tenant's resolved config (SYSTEM
        ``TenantTtsConfig`` default → tenant overrides). There is NO code/env
        vendor fallback (TASK-577 / F1): an empty/absent chain FAILS CLOSED with
        ``TtsRoutingUnconfiguredError`` rather than substituting a provider order.
        """
        base = locale.split("-")[0]
        chain = routing_ml if base == "ml" else routing_en
        if not chain:
            raise TtsRoutingUnconfiguredError(locale)
        return list(chain)

    def candidates(
        self,
        voice: Voice,
        *,
        routing_en: list[str] | None = None,
        routing_ml: list[str] | None = None,
        allowed_providers: list[str] | None = None,
        override_providers: set[str] | None = None,
    ) -> list[str]:
        """Providers that are registered, bound to this voice, and not tripped.

        ``allowed_providers`` (tenant whitelist) further bounds the chain;
        ``override_providers`` (tenants with a BYO key) count as available even when
        the platform hasn't registered that provider.
        """
        allow = set(allowed_providers) if allowed_providers else None
        out: list[str] = []
        for name in self.resolve_chain(voice.locale, routing_en=routing_en, routing_ml=routing_ml):
            if allow is not None and name not in allow:
                continue
            # TASK-602: a registered cloud provider with no platform credential
            # (is_configured=False) is NOT a usable candidate — it would 401 the
            # live API. It counts as available only via a per-tenant override
            # (override_providers), which builds a keyed engine. Self-hosted
            # engines are always is_configured=True.
            registered = name in self._registry and self._registry.get(name).is_configured
            overridden = override_providers is not None and name in override_providers
            if not registered and not overridden:
                continue
            if name not in voice.bindings:
                continue
            if self.breaker(name).is_open():
                continue
            out.append(name)
        return out

    def _engine_for(self, name: str, provider_overrides: ProviderOverrides | None) -> TTSEngine:
        """Engine for a provider: a per-tenant BYO instance when overridden (cached
        by credential hash), else the shared registered engine."""
        if provider_overrides and name in provider_overrides:
            override = provider_overrides[name]
            key = _override_cache_key(name, override)
            engine = self._tenant_engines.get(key)
            if engine is None:
                engine = _build_override_engine(self._settings, name, override)
                if engine is not None:
                    self._tenant_engines[key] = engine
            if engine is not None:
                return engine
        return self._registry.get(name)

    async def synthesize(
        self,
        *,
        voice_id: str,
        text: str,
        fmt: AudioFormat = AudioFormat.PCM,
        speed: float = 1.0,
        request_id: str = "",
        routing_en: list[str] | None = None,
        routing_ml: list[str] | None = None,
        allowed_providers: list[str] | None = None,
        provider_overrides: ProviderOverrides | None = None,
        voice_bindings: VoiceBindings | None = None,
    ) -> AsyncIterator[AudioChunk]:
        voice = self._catalog.get(voice_id)  # VoiceNotFoundError → 404 at endpoint
        voice = _apply_voice_bindings(voice, voice_bindings)  # binding override
        locale = voice.locale
        candidates = self.candidates(
            voice,
            routing_en=routing_en,
            routing_ml=routing_ml,
            allowed_providers=allowed_providers,
            override_providers=set(provider_overrides) if provider_overrides else None,
        )
        if not candidates:
            TTS_REQUESTS.labels(provider="none", locale=locale, status="unavailable").inc()
            raise AllProvidersUnavailableError(voice_id)

        last_exc: Exception | None = None
        failed_from: str | None = None
        for name in candidates:
            if failed_from is not None:
                TTS_FAILOVER.labels(from_provider=failed_from, to_provider=name).inc()
                failed_from = None

            engine: TTSEngine = self._engine_for(name, provider_overrides)
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
                # Per-model (= per-provider) running gauge + inference
                # latency — TASK-615 WS-E cross-service {service, model} pair.
                with track_model_inference(name):
                    async with aclosing(source) as stream:
                        async for chunk in stream:
                            if not emitted:
                                TTS_TTFA.labels(provider=name, locale=locale).observe(
                                    time.perf_counter() - started
                                )
                                emitted = True
                            audio_bytes += len(chunk.data)
                            # Stamp the winning provider (TASK-615 WS-E usage
                            # attribution) — a caller doesn't know which
                            # candidate won until the first byte ships.
                            yield replace(chunk, provider=name)
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

    def stream(
        self,
        *,
        voice_id: str,
        fmt: AudioFormat = AudioFormat.PCM,
        speed: float = 1.0,
        request_id: str = "",
        routing_en: list[str] | None = None,
        routing_ml: list[str] | None = None,
        allowed_providers: list[str] | None = None,
        provider_overrides: ProviderOverrides | None = None,
        voice_bindings: VoiceBindings | None = None,
    ) -> SynthesisStream:
        """Open a duplex stream: incremental text in, audio frames out.

        Prefers a natively-duplex engine (Azure text-stream) when the first
        candidate supports it and the request is PCM at speed 1.0 (TextStream mode
        has no SSML/rate control — ``speed != 1.0`` falls back to the per-sentence
        adapter over ``synthesize`` so ``<prosody rate>`` still applies). All other
        engines are driven per-sentence via ``SentenceAdapter`` with before-first-
        byte failover; the provider is locked once the first audio frame ships.
        """
        voice = self._catalog.get(voice_id)  # VoiceNotFoundError → 404 at endpoint
        voice = _apply_voice_bindings(voice, voice_bindings)  # binding override
        candidates = self.candidates(
            voice,
            routing_en=routing_en,
            routing_ml=routing_ml,
            allowed_providers=allowed_providers,
            override_providers=set(provider_overrides) if provider_overrides else None,
        )
        if not candidates:
            TTS_REQUESTS.labels(provider="none", locale=voice.locale, status="unavailable").inc()
            raise AllProvidersUnavailableError(voice_id)

        first = candidates[0]
        engine0 = self._engine_for(first, provider_overrides)
        if isinstance(engine0, DuplexTTSEngine) and fmt == AudioFormat.PCM and speed == 1.0:
            req = SynthesisRequest(
                text="",
                provider_voice=voice.bindings[first],
                locale=voice.locale,
                fmt=fmt,
                speed=speed,
                sample_rate=self._settings.sample_rate,
                request_id=request_id,
            )
            return engine0.open_stream(req)

        synth = _ChainSynthesizer(
            self,
            voice_id,
            voice,
            candidates,
            fmt=fmt,
            speed=speed,
            request_id=request_id,
            provider_overrides=provider_overrides,
        )
        return SentenceAdapter(synth, locale=voice.locale, max_chars=self._settings.max_input_chars)

    async def _sentence_adapter(
        self, engine: TTSEngine, req: SynthesisRequest
    ) -> AsyncGenerator[AudioChunk, None]:
        """Feed a non-streaming engine one sentence at a time for early first-audio."""
        for sentence in chunk_text(req.text, req.locale, self._settings.max_input_chars):
            sub = replace(req, text=sentence)
            async with aclosing(engine.synthesize(sub)) as stream:
                async for chunk in stream:
                    yield chunk

    def _observe_rtf(
        self, name: str, req: SynthesisRequest, audio_bytes: int, gen_s: float
    ) -> None:
        # Shares its byte math with the usage-metering audio-seconds
        # derivation (tts.core.usage.compute_audio_seconds, TASK-615 WS-E) so
        # the SLO metric and the billed quantity never drift apart. WAV/MP3
        # aren't RTF-observed here (this metric predates format support
        # beyond PCM); compute_audio_seconds itself DOES handle WAV.
        audio_s = compute_audio_seconds(req.fmt, audio_bytes, req.sample_rate)
        if audio_s:
            TTS_RTF.labels(provider=name).observe(gen_s / audio_s)


class _ChainSynthesizer:
    """Per-sentence synth callable for the SentenceAdapter.

    Sentence 1 tries the candidate chain (before-first-byte failover); once the
    first audio frame ships the stream locks to that provider — every later
    sentence uses only it, and a failure then is surfaced (never a mid-stream
    voice switch). Mirrors the ``synthesize`` failover rules for the duplex path.
    """

    def __init__(
        self,
        router: TTSRouter,
        voice_id: str,
        voice: Voice,
        candidates: list[str],
        *,
        fmt: AudioFormat,
        speed: float,
        request_id: str,
        provider_overrides: ProviderOverrides | None = None,
    ) -> None:
        self._router = router
        self._voice_id = voice_id
        self._voice = voice
        self._candidates = candidates
        self._fmt = fmt
        self._speed = speed
        self._request_id = request_id
        self._overrides = provider_overrides
        self._locked: str | None = None

    def _req(self, name: str, sentence: str) -> SynthesisRequest:
        return SynthesisRequest(
            text=sentence,
            provider_voice=self._voice.bindings[name],
            locale=self._voice.locale,
            fmt=self._fmt,
            speed=self._speed,
            sample_rate=self._router._settings.sample_rate,
            request_id=self._request_id,
        )

    async def __call__(self, sentence: str) -> AsyncGenerator[AudioChunk, None]:
        r = self._router
        locale = self._voice.locale

        if self._locked is not None:
            engine = r._engine_for(self._locked, self._overrides)
            with track_model_inference(self._locked):
                async with aclosing(engine.synthesize(self._req(self._locked, sentence))) as stream:
                    async for chunk in stream:
                        yield replace(chunk, provider=self._locked)
            return

        last_exc: Exception | None = None
        failed_from: str | None = None
        for name in self._candidates:
            if r.breaker(name).is_open():
                continue
            if failed_from is not None:
                TTS_FAILOVER.labels(from_provider=failed_from, to_provider=name).inc()
                failed_from = None
            engine = r._engine_for(name, self._overrides)
            breaker = r.breaker(name)
            emitted = False
            started = time.perf_counter()
            try:
                with track_model_inference(name):
                    async with aclosing(engine.synthesize(self._req(name, sentence))) as stream:
                        async for chunk in stream:
                            if not emitted:
                                TTS_TTFA.labels(provider=name, locale=locale).observe(
                                    time.perf_counter() - started
                                )
                                emitted = True
                                self._locked = name  # lock the whole stream to this provider
                            yield replace(chunk, provider=name)
                breaker.record_success()
                return
            except Exception as exc:
                breaker.record_failure()
                TTS_PROVIDER_ERRORS.labels(provider=name, type=type(exc).__name__).inc()
                last_exc = exc
                if emitted:
                    raise  # audio already flowing — no mid-stream switch
                failed_from = name
                continue

        raise AllProvidersUnavailableError(self._voice_id) from last_exc
