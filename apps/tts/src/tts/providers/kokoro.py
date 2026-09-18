"""Self-hosted Kokoro (English) TTS provider.

Kokoro-82M is Apache-2.0, ONNX-friendly, and emits 24 kHz float audio — no
resample needed. `KPipeline` splits text internally and yields per-segment
audio, so this provider streams PCM chunks (``native_streaming=True``). The
`kokoro` package is imported lazily so hermetic tests inject a fake pipeline.
"""

from __future__ import annotations

import asyncio
import glob
import os
import time
from collections.abc import AsyncGenerator, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

import numpy as np
from hope_runtime_models import ModelCache

from tts.core.audio import encode_pcm, pcm16_to_mp3, pcm16_to_wav
from tts.core.config import KokoroConfig
from tts.core.logging import get_logger
from tts.core.metrics import TTS_MODEL_LOADED, build_model_cache_metrics_sink
from tts.providers.base import (
    AudioChunk,
    AudioFormat,
    CredentialPosture,
    SynthesisRequest,
)

logger = get_logger(__name__)

_SAMPLE_RATE = 24000


@dataclass(frozen=True)
class KokoroPaths:
    """Explicit weight locations inside a published Kokoro prefix (TASK-860)."""

    config_json: str
    model_pth: str
    voices_dir: str | None


def resolve_kokoro_paths(config: KokoroConfig, *, slug: str | None = None) -> KokoroPaths | None:
    """``model_path`` → the explicit `KModel(config, model)` inputs, or None.

    None (empty ``model_path``) means the dev fallback: `KPipeline` pulls
    `hexgrad/Kokoro-82M` from the Hub itself. A SET path that lacks
    `config.json` + a `.pth` checkpoint is a misconfiguration and FAILS here —
    silently falling back to a Hub download would hide a registry row whose
    weights were never published (`availability: MISSING`).

    ``slug`` names the registry row the path came from, so an operator running
    several kokoro rows learns WHICH one is unpublished. Optional because the
    hermetic suites construct a config directly; `from_spec` always supplies it.
    """
    if not config.model_path:
        return None
    root = config.model_path.rstrip("/")
    config_json = os.path.join(root, "config.json")
    checkpoints = sorted(glob.glob(os.path.join(root, "*.pth")))
    if not os.path.isfile(config_json) or not checkpoints:
        # TASK-961: name the ROW, never `TTS_KOKORO_MODEL_PATH`. That alias is
        # dead (`moved_to_row_alias`), so an operator cannot set it and cannot
        # fix anything by trying — the only supplier of this value is the
        # resolved spec's `model.localPath`, derived from the row's
        # `bucketPrefix`. Sending them to a retired env var is the same
        # misdirection as advising a HuggingFace token for a repo that is not
        # on the Hub (TASK-960 D1).
        which = f" for registry row {slug!r}" if slug else ""
        raise FileNotFoundError(
            f"Kokoro weights{which} are not present at {config.model_path!r}: no config.json and "
            "no .pth checkpoint. This path is derived from the model row's `bucketPrefix` — the "
            "row has not been published to the models bucket (publish it, or run the registry "
            "inventory to re-measure `availability`), or `bucketPrefix` is wrong. It is NOT "
            "settable from the environment."
        )
    voices_dir = os.path.join(root, "voices")
    return KokoroPaths(
        config_json=config_json,
        model_pth=checkpoints[0],
        voices_dir=voices_dir if os.path.isdir(voices_dir) else None,
    )


def resolve_kokoro_voice(paths: KokoroPaths | None, voice: str) -> str:
    """The `.pt` path of a published voice, else the bare voice name.

    `KPipeline.load_single_voice` opens a `.pt` PATH directly and only falls
    back to `hf_hub_download` for a bare name — so a published voice never
    touches the Hub, and an unpublished one behaves exactly as before.
    """
    if paths is not None and paths.voices_dir:
        candidate = os.path.join(paths.voices_dir, f"{voice}.pt")
        if os.path.isfile(candidate):
            return candidate
    return voice


# `next()` cannot signal exhaustion across a thread boundary by raising
# StopIteration (it would be swallowed by the enclosing generator machinery), so
# the pump returns this sentinel instead.
_STREAM_END = object()


async def _aiter_segment_audio(
    pipeline: Any, text: str, voice: str, worker: ThreadPoolExecutor
) -> AsyncGenerator[Any, None]:
    """Yield one segment's audio at a time from the SYNCHRONOUS KPipeline.

    `KPipeline(...)` is a blocking generator, so every step of it — construction
    and each `next()` — runs on `worker`, never on the event loop. Only ONE
    segment is in flight at a time: the previous one is released as soon as the
    caller has encoded it, so nothing accumulates across the utterance.

    `worker` is the provider's single inference thread, NOT `asyncio.to_thread`'s
    shared default executor. See `KokoroProvider._get_worker` for why.
    """
    loop = asyncio.get_running_loop()
    segments = await loop.run_in_executor(worker, lambda: iter(pipeline(text, voice=voice)))

    def _next() -> Any:
        try:
            return next(segments)
        except StopIteration:
            return _STREAM_END

    while True:
        segment = await loop.run_in_executor(worker, _next)
        if segment is _STREAM_END:
            return
        audio = segment[2]
        # Drop the tuple before yielding: holding it would keep this segment
        # alive for the whole time the caller spends encoding the next one.
        del segment
        yield audio
        del audio


class KokoroProvider:
    name = "kokoro"
    supported_locales = {"en-IN", "en-US"}
    native_streaming = True
    # Operator-run engine with LOCAL weights — no vendor credential exists to
    # fail closed on. Declared explicitly because the lock test is default-deny:
    # an adapter that says nothing fails it.
    credential_posture = CredentialPosture.SELF_HOST
    is_configured = True  # Self-hosted engine needs no credential
    #: TASK-990 F5. This engine loads its weights on FIRST USE and releases them
    #: when idle (`ModelCache`, TTL), so `health()` answering False is an
    #: expected steady state rather than a fault. `/health/ready` reads this to
    #: tell the two apart; without it a truthful `health()` would make a lazily
    #: unloaded pod permanently NotReady whenever `TTS_WARMUP_ENABLED` is false
    #: — which is the default.
    loads_on_demand = True

    @classmethod
    def from_spec(
        cls, settings: Any, candidate: Any, override: dict[str, str]
    ) -> KokoroProvider | None:
        """Build a REQUEST-SCOPED engine for one resolved TTS spec candidate.

        Kokoro takes ONE fact from the spec — where its published weights are (`model.localPath`,
        the registry row's derived mirror). Empty means the dev Hub fallback, exactly as the
        retired `TTS_KOKORO_MODEL_PATH` did. `override` is unused: a self-hosted engine
        authenticates to nothing, and accepting a credential here would invent an override path
        that does not exist.

        The instance is cached by the router on the facts below, so a resident pipeline stays
        resident across requests that name the same weights.
        """
        del override
        return cls(
            settings.kokoro.model_copy(update={"model_path": candidate.model.local_path or ""}),
            ttl_seconds=settings.model_cache_ttl_seconds,
            slug=candidate.model.slug,
        )

    def __init__(
        self,
        config: KokoroConfig,
        *,
        pipeline: Any | None = None,
        pipeline_factory: Callable[[], Any] | None = None,
        ttl_seconds: int | None = None,
        time_func: Callable[[], float] = time.monotonic,
        warmup_voice: str | None = None,
        slug: str | None = None,
    ) -> None:
        self._config = config
        # TASK-961: the registry row this engine was built for, carried ONLY so
        # an unpublished-weights failure can name it. `from_spec` supplies it.
        self._slug = slug
        # The voice used ONLY by the boot-time `warmup()` call. It comes from the
        # voice catalog at construction (`main.create_app`), which is the single
        # source of provider voice names since lane C — the `voice`
        # settings field that used to hold `af_heart` a second time is gone.
        # None ⇒ the catalog binds no English voice to kokoro, so there is
        # nothing to warm; inventing a name here would put a voice into the
        # catalog's job without putting it in the catalog.
        self._warmup_voice = warmup_voice
        # TASK-860: explicit published-weight paths (None = Hub fallback).
        # Resolved at construction so a misconfigured mount fails at boot.
        self._paths = resolve_kokoro_paths(config, slug=slug)
        # The pipeline handle lives behind the shared
        # model cache, so it loads on first use and is RELEASED when idle. An
        # explicitly injected `pipeline` bypasses the cache entirely (hermetic
        # tests that want a permanent fake).
        self._injected = pipeline
        self._pipeline_factory = pipeline_factory
        self._worker: ThreadPoolExecutor | None = None
        self._cache: ModelCache[Any] = ModelCache(
            factory=self._load_pipeline,
            ttl_seconds=ttl_seconds if ttl_seconds is not None else 600,
            max_size=1,
            unload=self._unload_pipeline,
            time_func=time_func,
            metrics=build_model_cache_metrics_sink(),
            name="tts_kokoro",
        )

    async def _load_pipeline(self, _key: str) -> Any:
        """Build the KPipeline. Runs in a thread — it is a heavy, blocking load."""
        if self._pipeline_factory is not None:
            pipeline = await asyncio.to_thread(self._pipeline_factory)
        elif self._paths is not None:
            from kokoro import KModel, KPipeline  # lazy, heavy [local] dep

            paths = self._paths

            def _build_from_paths() -> Any:
                # Explicit config + checkpoint: bypasses the Hub entirely
                # (verified in kokoro/model.py — TASK-860 §2.4).
                kmodel = KModel(config=paths.config_json, model=paths.model_pth)
                return KPipeline(lang_code="a", model=kmodel)  # 'a' = American English

            pipeline = await asyncio.to_thread(_build_from_paths)
        else:
            from kokoro import KPipeline  # lazy, heavy [local] dep

            pipeline = await asyncio.to_thread(
                lambda: KPipeline(lang_code="a")
            )  # 'a' = American English

        TTS_MODEL_LOADED.labels(model="kokoro").set(1)
        logger.info("tts.kokoro_loaded", device=self._config.device)
        return pipeline

    def _unload_pipeline(self, _key: str, _pipeline: Any) -> None:
        """Drop the handle and zero the gauge; the weights free on GC."""
        TTS_MODEL_LOADED.labels(model="kokoro").set(0)
        logger.info("tts.kokoro_unloaded")

    def _get_worker(self) -> ThreadPoolExecutor:
        """The ONE thread that ever runs Kokoro inference in this process.

        Not `asyncio.to_thread` (the loop's shared default executor), and not a
        thread per request, for three reasons — all measured in the built image:

        * **It bounds peak memory.** Peak RSS is dominated by the torch forward
          pass of the single largest segment (~1.2 GB over the resident model),
          NOT by buffered audio. One inference thread therefore caps the peak at
          one segment's worth no matter how many requests arrive at once; the
          previous code let N concurrent requests run N inferences in parallel
          and pay N times that. Synthesis serialises behind this worker, which
          is the right trade on a CPU-only pod where parallel inference does not
          buy throughput anyway.
        * **A thread per request is worse than a shared one.** Fresh threads get
          fresh glibc malloc arenas and fresh torch per-thread state: a
          per-utterance executor measured 1527 MB on a trivial 12-char synthesis
          against 1242 MB when the thread is reused.
        * **A saturated default executor would stall synthesis.** Borrowing the
          shared pool makes audio wait behind unrelated blocking work.

        Created lazily so a provider that is registered but never used (the
        keyless-readiness path) costs no thread, and never shut down — it lives
        as long as the provider, i.e. the process.
        """
        if self._worker is None:
            self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kokoro-synth")
        return self._worker

    async def _get_pipeline_async(self) -> Any:
        """The pipeline for this request, loading it on demand (single-flight)."""
        if self._injected is not None:
            return self._injected
        return await self._cache.get("kokoro")

    def configure_retention(self, retention: dict[str, int]) -> None:
        """Adopt control-plane retention; absent keys keep the current value."""
        self._cache.configure(ttl_seconds=retention.get("ttl_seconds"))

    async def sweep(self) -> int:
        """Release the pipeline if it has been idle past its TTL."""
        return await self._cache.sweep()

    async def warmup(self) -> None:
        """Load the weights, and run one synthesis when a voice is known.

        The LOAD is unconditional, and that split is the point: what
        `TTS_WARMUP_ENABLED` buys an operator is fail-at-boot on a broken or
        missing model, and that failure happens during the load. The trial
        synthesis needs a voice name, which comes from the catalog — so if the
        catalog binds no English voice to kokoro there is no name to use, but
        skipping the load as well would silently give a fail-at-boot operator no
        boot-time check at all.
        """
        pipeline = await self._get_pipeline_async()
        if self._warmup_voice is None:
            return
        voice = resolve_kokoro_voice(self._paths, self._warmup_voice)
        await asyncio.to_thread(lambda: list(pipeline("warm up.", voice=voice)))

    async def health(self) -> bool:
        """True once the pipeline is RESIDENT in this process.

        TASK-990 F5. This used to be ``return True``, unconditionally, with no
        check that ``_get_pipeline_async()`` had ever completed. Combined with
        ``TTS_WARMUP_ENABLED`` defaulting to false, that made a TTS pod report
        Ready — and take traffic — before any Kokoro weight was in memory, so
        the first real request paid the entire cold load. The health signal
        asserted something it had never measured.

        What it measures now is residency and only residency. It deliberately
        does NOT attempt a load: a probe that loads ~1.2 GB of weights as a side
        effect would turn every readiness poll into the cold start it is
        supposed to report on, and would make an idle, TTL-evicted pipeline
        reload on a timer forever.

        False therefore means "not resident", which is NOT the same as "broken",
        and the two must not be conflated by the caller. The class attribute
        ``loads_on_demand`` is the discriminator that lets ``/health/ready`` report this as
        degraded-but-ready rather than pulling the pod from the Service
        endpoints (see ``tts.api.endpoints.health.readiness``). A genuinely
        broken mount never reaches this method at all: ``resolve_kokoro_paths``
        raises at CONSTRUCTION when the published weights are absent.
        """
        if self._injected is not None:
            return True
        return "kokoro" in self._cache.cached_keys()

    async def synthesize(self, req: SynthesisRequest) -> AsyncGenerator[AudioChunk, None]:
        """Stream the utterance segment by segment.

        PCM is emitted as each segment is produced — `native_streaming = True`
        promises exactly this, and the previous implementation did not deliver
        it: it drained the whole pipeline into a list first, so first audio for a
        4096-char input arrived after the full 65 s synthesis instead of ~7 s.

        WAV and MP3 genuinely CANNOT be framed incrementally here — the RIFF
        header carries the total byte count, and `pcm16_to_mp3` encodes and
        flushes one whole buffer — so they still accumulate. They accumulate PCM16
        BYTES though (2 bytes/sample, ~48 KB per second of audio), releasing each
        float32 segment as it is encoded, rather than holding every segment of the
        utterance live at once.
        """
        pipeline = await self._get_pipeline_async()
        # `req.provider_voice` is ALWAYS the catalog binding: the router resolves
        # it from `voice.bindings[name]`, and `candidates()` skips any provider a
        # voice is not bound to. There is deliberately no config fallback — one
        # would only ever fire on a path that cannot occur, and would substitute
        # a different voice than the caller asked for if it ever did.
        voice = resolve_kokoro_voice(self._paths, req.provider_voice)
        worker = self._get_worker()

        if req.fmt == AudioFormat.PCM:
            async for audio in _aiter_segment_audio(pipeline, req.text, voice, worker):
                yield AudioChunk(
                    encode_pcm(np.asarray(audio, dtype=np.float32), _SAMPLE_RATE, req.sample_rate)
                )
            return

        pcm = bytearray()
        async for audio in _aiter_segment_audio(pipeline, req.text, voice, worker):
            pcm += encode_pcm(np.asarray(audio, dtype=np.float32), _SAMPLE_RATE, req.sample_rate)
        data = (
            pcm16_to_wav(bytes(pcm), req.sample_rate)
            if req.fmt == AudioFormat.WAV
            else pcm16_to_mp3(bytes(pcm), req.sample_rate)
        )
        yield AudioChunk(data=data, is_final=True)
