"""Provider-selection router.

The gateway resolves the tenant's TEXT_TO_SPEECH Agent and pushes a
``ResolvedTtsSpec`` with every request (TASK-879); this module executes it. The spec names an
ORDERED chain of candidates — each one an engine, a registry model, a voice binding and the
connection row that serves it — and the router synthesizes through the first healthy candidate.

Failover happens ONLY before the first audio byte: switching engines mid-stream would produce an
audible voice seam, so a mid-stream failure is surfaced as an error instead. Per-engine circuit
breakers skip engines that are failing.

WHAT THIS MODULE NO LONGER DECIDES. There is no locale→provider chain, no allow-list, no voice
catalogue lookup and no per-provider model id here any more. All four were injected config the
gateway resolved from `TenantTtsConfig`; all four are now properties of the agent and the rows it
binds, and they arrive resolved. A request with no spec is REFUSED — never served on a substituted
vendor.
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import aclosing
from dataclasses import replace

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
    ProviderNotFoundError,
    ProviderRegistry,
    SynthesisRequest,
    SynthesisStream,
    TTSEngine,
)
from tts.routing.chunking import chunk_text
from tts.routing.circuit_breaker import CircuitBreaker
from tts.routing.sentence_adapter import SentenceAdapter
from tts.spec import ResolvedTtsCandidate, ResolvedTtsSpec, candidate_chain

CB_FAILURE_THRESHOLD = 5
CB_RECOVERY_TIMEOUT_S = 30.0


class AllProvidersUnavailableError(RuntimeError):
    """No candidate in the resolved chain could serve the request."""

    def __init__(self, voice_id: str) -> None:
        super().__init__(f"no TTS provider available for voice '{voice_id}'")
        self.voice_id = voice_id


class TtsRoutingUnconfiguredError(AllProvidersUnavailableError):
    """The resolved chain is EMPTY — FAIL CLOSED.

    The router carries NO code/env vendor default: which engine speaks, in which voice, from
    which weights, is the tenant's AGENT, resolved by the gateway and pushed with the request.
    When the chain resolves to nothing — every candidate's engine disabled by its connection row,
    or none of them binds the requested voice — we raise rather than substitute a vendor.
    Subclasses ``AllProvidersUnavailableError`` so the endpoints' existing 503 (HTTP) /
    provider-unavailable (WS) handlers already surface it as an unavailable-provider condition.
    """

    def __init__(self, voice_id: str) -> None:
        RuntimeError.__init__(
            self,
            "no TTS candidate is routable for this request — every engine in the resolved chain is "
            "either disabled by its provider connection or cannot speak the requested voice",
        )
        self.voice_id = voice_id


# Per-tenant BYO credentials the gateway decrypts + injects, keyed by CONNECTION KEY
# (TASK-958) — the tenant connection's ``slug`` for a tenant row, the provider/engine name
# for a platform row:
# ``{"azure-clinic": {"api_key": ..., "region": ...}, "sarvam": {"api_key": ..., "base_url": ...}}``.
# For a tenant's DEFAULT connection the slug IS the provider name, so every payload written
# before multiplicity existed is unchanged and still keys by provider.
ProviderOverrides = dict[str, dict[str, str]]


def override_for(
    candidate: ResolvedTtsCandidate, overrides: ProviderOverrides | None
) -> dict[str, str]:
    """The credential entry that serves THIS candidate.

    ``connection_key`` first, engine name second. The second read is what keeps a
    legacy payload — and every platform-tier candidate, whose key IS the engine name —
    resolving exactly as it did; the first is the only thing that can tell two
    candidates apart when a tenant holds two accounts of one vendor and both name the
    same engine. Without it the chain reads ONE entry twice and a failover spends the
    key that just failed.
    """
    if not overrides:
        return {}
    if candidate.connection_key:
        entry = overrides.get(candidate.connection_key)
        if entry:
            return entry
    return overrides.get(candidate.engine or "") or {}


def _connection_id(candidate: ResolvedTtsCandidate) -> str | None:
    """The ``AiProviderConnection`` id that served a candidate, or ``None``.

    ``None`` means the gateway sent no id — a payload that predates TASK-958 — and the
    ledger records the spend with no connection, exactly as it does today. It is never
    guessed from the provider name: two connections of one vendor share that name, which
    is the whole reason this field exists.
    """
    return candidate.connection.connection_id if candidate.connection else None


def _engine_cache_key(candidate: ResolvedTtsCandidate, override: dict[str, str]) -> str:
    """Identity of the ENGINE INSTANCE a candidate needs.

    Everything that changes what the instance loads or authenticates to is in the key: the engine,
    the model it loads (source + mirror + artifacts), the endpoint it reaches, and the credential
    it reaches it with. Two candidates agreeing on all of that share one instance — which is what
    keeps a resident model resident across requests — and any difference builds a new one rather
    than serving a tenant on another tenant's cached engine.
    """
    model = candidate.model
    connection = candidate.connection
    parts = [
        model.provider or "",
        model.source_uri,
        model.local_path or "",
        repr(sorted(model.artifacts.items())),
        connection.base_url if connection else "",
        connection.region if connection else "",
        str(connection.timeout_s) if connection else "",
        override.get("api_key", ""),
        override.get("base_url", ""),
        override.get("region", ""),
    ]
    return hashlib.sha256("|".join(part or "" for part in parts).encode("utf-8")).hexdigest()


#: Adapter classes discovered by engine name. Built lazily and ONCE (provider imports are heavy:
#: native SDKs and ML stacks).
_SPEC_ADAPTERS: dict[str, type] | None = None


def _spec_adapters() -> dict[str, type]:
    """Discover every adapter class by its declared ``name``.

    Discovery, not enumeration. The previous implementation was an ``if name == "azure" /
    "sarvam"`` switch, which meant an adapter added later returned ``None`` here, silently fell
    back to the shared registered engine, and served EVERY tenant on the platform key. A
    hand-written list can only cover the adapters someone remembered — which is exactly how
    ambient credential chains survived a cleanup in ``apps/text``.
    """
    global _SPEC_ADAPTERS
    if _SPEC_ADAPTERS is not None:
        return _SPEC_ADAPTERS

    import inspect
    import pkgutil
    from importlib import import_module

    import tts.providers as providers_pkg

    found: dict[str, type] = {}
    for mod in pkgutil.iter_modules(providers_pkg.__path__):
        if mod.name in ("base", "registration"):
            continue
        try:
            module = import_module(f"tts.providers.{mod.name}")
        except Exception:  # noqa: BLE001 - an unimportable optional engine (missing
            # native/ML extra) must not take the spec path down with it.
            continue
        for _, obj in inspect.getmembers(module, inspect.isclass):
            if obj.__module__ != module.__name__:
                continue
            name = getattr(obj, "name", None)
            if not isinstance(name, str):
                continue
            if getattr(obj, "from_spec", None) is None:
                continue
            found[name] = obj
    _SPEC_ADAPTERS = found
    return found


def _build_spec_engine(
    settings: Settings,
    candidate: ResolvedTtsCandidate,
    override: dict[str, str],
    *,
    registry_class: type | None = None,
) -> TTSEngine | None:
    """Build a REQUEST-SCOPED engine for one resolved candidate.

    Asks the ADAPTER (``from_spec``) rather than matching the engine name against a literal, so
    spec support travels with the adapter's own declaration. Returns ``None`` when the engine is
    unknown to this image or the adapter refuses the candidate (a BYOK engine with no credential
    refuses here, which is what keeps a keyless row from being mistaken for one).

    ``registry_class`` is a test seam for proving the builder is not a name switch; production
    always resolves through discovery.
    """
    name = candidate.model.provider
    if not name:
        return None
    adapter = registry_class or _spec_adapters().get(name)
    if adapter is None:
        return None
    factory = getattr(adapter, "from_spec", None)
    if factory is None:
        return None
    engine: TTSEngine | None = factory(settings, candidate, override)
    return engine


class TTSRouter:
    def __init__(
        self,
        registry: ProviderRegistry,
        settings: Settings,
        *,
        cb_threshold: int = CB_FAILURE_THRESHOLD,
        cb_recovery_s: float = CB_RECOVERY_TIMEOUT_S,
    ) -> None:
        self._registry = registry
        self._settings = settings
        self._cb_threshold = cb_threshold
        self._cb_recovery_s = cb_recovery_s
        self._breakers: dict[str, CircuitBreaker] = {}
        # Request-scoped engines built from a resolved candidate, cached by what they load and
        # authenticate to (`_engine_cache_key`).
        self._spec_engines: dict[str, TTSEngine] = {}

    def breaker(self, name: str) -> CircuitBreaker:
        if name not in self._breakers:
            self._breakers[name] = CircuitBreaker(self._cb_threshold, self._cb_recovery_s)
        return self._breakers[name]

    def candidates(
        self, spec: ResolvedTtsSpec, *, voice_id: str | None = None
    ) -> list[ResolvedTtsCandidate]:
        """The resolved chain, minus the engines whose circuit is open.

        Everything else the chain filters on — the funding-gated ``autoSwitch``, the enabled
        connection row, the voice each candidate can actually speak — is decided by
        ``tts.spec.candidate_chain``, because those are the GATEWAY's decisions and this service
        must not re-derive them. The breaker is the one exclusion that is genuinely local: it is
        this process's own recent experience of an engine.
        """
        return [
            c
            for c in candidate_chain(spec, voice_id=voice_id)
            if not self.breaker(c.engine or "").is_open()
        ]

    def _engine_for(
        self, candidate: ResolvedTtsCandidate, provider_overrides: ProviderOverrides | None
    ) -> TTSEngine | None:
        """The engine instance for one candidate, or ``None`` when this process cannot build one.

        Built from the SPEC — the model it names, the mirror it names, the connection it names and
        the credential that arrived beside it — and cached by exactly those facts. Falls back to
        the boot-registered engine when this image has no spec-buildable adapter for the name;
        that instance carries no model of its own since TASK-879, so it exists mainly to answer
        the readiness probe.

        ``None`` is a ROUTING outcome, not an error, and it has two real causes: the image does
        not contain the engine the agent named (`[indic-parler]` is an optional image variant), or
        the adapter refused the candidate (a cloud engine with no credential, a clone voice with no
        reference recording). Both mean "this candidate cannot serve" — which is what the chain
        exists to survive — so the caller walks on rather than turning a routing fact into a 500.
        """
        name = candidate.engine or ""
        override = override_for(candidate, provider_overrides)
        key = _engine_cache_key(candidate, override)
        engine = self._spec_engines.get(key)
        if engine is None:
            engine = _build_spec_engine(self._settings, candidate, override)
            if engine is not None:
                self._spec_engines[key] = engine
        if engine is None:
            try:
                engine = self._registry.get(name)
            except ProviderNotFoundError:
                return None
        # A registered CLOUD engine with no credential is not a usable candidate — it would 401
        # the live API. Since TASK-879 every engine the image contains is registered (registration
        # says what this PROCESS holds, the connection row says what may serve), so this is the
        # check that keeps a keyless vendor engine out of the chain: without it, a boot-registered
        # Azure with an empty subscription key would be handed a session and fail on the first
        # sentence instead of being walked past before `ready`.
        return engine if getattr(engine, "is_configured", True) else None

    def _request_for(
        self,
        candidate: ResolvedTtsCandidate,
        *,
        text: str,
        voice_id: str | None,
        fmt: AudioFormat,
        speed: float,
        request_id: str,
    ) -> SynthesisRequest:
        """One provider-ready request, resolved entirely from THIS candidate.

        The voice, the locale and the sample rate all come from the candidate rather than from the
        primary: falling over to another engine with the primary's voice name would either fail or,
        worse, silently substitute a different voice.
        """
        binding = candidate.binding_for(voice_id)
        assert (
            binding is not None
        )  # `candidate_chain` already excluded candidates that cannot speak it
        return SynthesisRequest(
            text=text,
            provider_voice=binding.engine_voice,
            locale=binding.locale or candidate.parameters.language or "",
            fmt=fmt,
            speed=speed,
            sample_rate=candidate.sample_rate(),
            request_id=request_id,
        )

    async def synthesize(
        self,
        *,
        spec: ResolvedTtsSpec,
        text: str,
        voice_id: str | None = None,
        fmt: AudioFormat = AudioFormat.PCM,
        speed: float = 1.0,
        request_id: str = "",
        provider_overrides: ProviderOverrides | None = None,
    ) -> AsyncIterator[AudioChunk]:
        candidates = self.candidates(spec, voice_id=voice_id)
        requested_voice = voice_id or spec.primary.parameters.voice or ""
        if not candidates:
            TTS_REQUESTS.labels(provider="none", locale="", status="unavailable").inc()
            raise TtsRoutingUnconfiguredError(requested_voice)

        last_exc: Exception | None = None
        failed_from: str | None = None
        for candidate in candidates:
            name = candidate.engine or ""
            req = self._request_for(
                candidate, text=text, voice_id=voice_id, fmt=fmt, speed=speed, request_id=request_id
            )
            locale = req.locale
            if failed_from is not None:
                TTS_FAILOVER.labels(from_provider=failed_from, to_provider=name).inc()
                failed_from = None

            engine = self._engine_for(candidate, provider_overrides)
            if engine is None:
                # Not a failure of this engine — it is not here to fail. No breaker record, no
                # error counter: recording either would attribute an image/credential fact to an
                # engine's reliability.
                failed_from = failed_from or name
                continue
            breaker = self.breaker(name)
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
                # latency — cross-service {service, model} pair.
                with track_model_inference(name):
                    async with aclosing(source) as stream:
                        async for chunk in stream:
                            if not emitted:
                                TTS_TTFA.labels(provider=name, locale=locale).observe(
                                    time.perf_counter() - started
                                )
                                emitted = True
                            audio_bytes += len(chunk.data)
                            # Stamp the winning provider AND its connection (usage
                            # attribution) — a caller doesn't know which
                            # candidate won until the first byte ships.
                            yield replace(
                                chunk, provider=name, connection_id=_connection_id(candidate)
                            )
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

        TTS_REQUESTS.labels(provider="none", locale="", status="unavailable").inc()
        raise AllProvidersUnavailableError(requested_voice) from last_exc

    def stream(
        self,
        *,
        spec: ResolvedTtsSpec,
        voice_id: str | None = None,
        fmt: AudioFormat = AudioFormat.PCM,
        speed: float = 1.0,
        request_id: str = "",
        provider_overrides: ProviderOverrides | None = None,
    ) -> SynthesisStream:
        """Open a duplex stream: incremental text in, audio frames out.

        Prefers a natively-duplex engine (Azure text-stream) when the first candidate supports it
        and the request is PCM at speed 1.0 (TextStream mode has no SSML/rate control — ``speed
        != 1.0`` falls back to the per-sentence adapter over ``synthesize`` so ``<prosody rate>``
        still applies). All other engines are driven per-sentence via ``SentenceAdapter`` with
        before-first-byte failover; the engine is locked once the first audio frame ships.
        """
        requested_voice = voice_id or spec.primary.parameters.voice or ""
        # Buildability is resolved EAGERLY on this path, unlike `synthesize`. A duplex session
        # answers `ready` before any text arrives, so "no engine here can serve you" has to be
        # known now — a `ready` followed by a failure on the first sentence is a worse answer than
        # an up-front error. Building is cheap and cached, so this costs nothing the first
        # sentence would not have paid anyway.
        candidates = [
            c
            for c in self.candidates(spec, voice_id=voice_id)
            if self._engine_for(c, provider_overrides) is not None
        ]
        if not candidates:
            TTS_REQUESTS.labels(provider="none", locale="", status="unavailable").inc()
            raise TtsRoutingUnconfiguredError(requested_voice)

        first = candidates[0]
        engine0 = self._engine_for(first, provider_overrides)
        if (
            engine0 is not None
            and isinstance(engine0, DuplexTTSEngine)
            and fmt == AudioFormat.PCM
            and speed == 1.0
        ):
            return engine0.open_stream(
                self._request_for(
                    first, text="", voice_id=voice_id, fmt=fmt, speed=speed, request_id=request_id
                )
            )

        synth = _ChainSynthesizer(
            self,
            candidates,
            voice_id=voice_id,
            fmt=fmt,
            speed=speed,
            request_id=request_id,
            provider_overrides=provider_overrides,
        )
        binding = first.binding_for(voice_id)
        locale = (binding.locale if binding else None) or first.parameters.language or ""
        return SentenceAdapter(synth, locale=locale, max_chars=self._settings.max_input_chars)

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
        # derivation (tts.core.usage.compute_audio_seconds) so
        # the SLO metric and the billed quantity never drift apart. WAV/MP3
        # aren't RTF-observed here (this metric predates format support
        # beyond PCM); compute_audio_seconds itself DOES handle WAV.
        audio_s = compute_audio_seconds(req.fmt, audio_bytes, req.sample_rate)
        if audio_s:
            TTS_RTF.labels(provider=name).observe(gen_s / audio_s)


class _ChainSynthesizer:
    """Per-sentence synth callable for the SentenceAdapter.

    Sentence 1 tries the candidate chain (before-first-byte failover); once the first audio frame
    ships the stream locks to that candidate — every later sentence uses only it, and a failure
    then is surfaced (never a mid-stream voice switch). Mirrors the ``synthesize`` failover rules
    for the duplex path.
    """

    def __init__(
        self,
        router: TTSRouter,
        candidates: list[ResolvedTtsCandidate],
        *,
        voice_id: str | None,
        fmt: AudioFormat,
        speed: float,
        request_id: str,
        provider_overrides: ProviderOverrides | None = None,
    ) -> None:
        self._router = router
        self._candidates = candidates
        self._voice_id = voice_id
        self._fmt = fmt
        self._speed = speed
        self._request_id = request_id
        self._overrides = provider_overrides
        self._locked: ResolvedTtsCandidate | None = None

    def _req(self, candidate: ResolvedTtsCandidate, sentence: str) -> SynthesisRequest:
        return self._router._request_for(
            candidate,
            text=sentence,
            voice_id=self._voice_id,
            fmt=self._fmt,
            speed=self._speed,
            request_id=self._request_id,
        )

    async def __call__(self, sentence: str) -> AsyncGenerator[AudioChunk, None]:
        r = self._router

        if self._locked is not None:
            locked = self._locked
            name = locked.engine or ""
            engine = r._engine_for(locked, self._overrides)
            if engine is None:  # pragma: no cover — the lock implies it built once
                raise AllProvidersUnavailableError(self._voice_id or "")
            with track_model_inference(name):
                async with aclosing(engine.synthesize(self._req(locked, sentence))) as stream:
                    async for chunk in stream:
                        yield replace(chunk, provider=name, connection_id=_connection_id(locked))
            return

        last_exc: Exception | None = None
        failed_from: str | None = None
        for candidate in self._candidates:
            name = candidate.engine or ""
            if r.breaker(name).is_open():
                continue
            if failed_from is not None:
                TTS_FAILOVER.labels(from_provider=failed_from, to_provider=name).inc()
                failed_from = None
            engine = r._engine_for(candidate, self._overrides)
            if engine is None:
                continue
            breaker = r.breaker(name)
            req = self._req(candidate, sentence)
            emitted = False
            started = time.perf_counter()
            try:
                with track_model_inference(name):
                    async with aclosing(engine.synthesize(req)) as stream:
                        async for chunk in stream:
                            if not emitted:
                                TTS_TTFA.labels(provider=name, locale=req.locale).observe(
                                    time.perf_counter() - started
                                )
                                emitted = True
                                self._locked = candidate  # lock the whole stream to this candidate
                            yield replace(
                                chunk, provider=name, connection_id=_connection_id(candidate)
                            )
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

        raise AllProvidersUnavailableError(self._voice_id or "") from last_exc
