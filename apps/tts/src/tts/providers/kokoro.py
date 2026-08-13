"""Self-hosted Kokoro (English) TTS provider.

Kokoro-82M is Apache-2.0, ONNX-friendly, and emits 24 kHz float audio — no
resample needed. `KPipeline` splits text internally and yields per-segment
audio, so this provider streams PCM chunks (``native_streaming=True``). The
`kokoro` package is imported lazily so hermetic tests inject a fake pipeline.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncGenerator, Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import numpy as np
from hope_runtime_models import ModelCache

from tts.core.audio import encode_pcm, pcm16_to_mp3, pcm16_to_wav
from tts.core.config import KokoroConfig
from tts.core.logging import get_logger
from tts.core.metrics import TTS_MODEL_LOADED, build_model_cache_metrics_sink
from tts.providers.base import AudioChunk, AudioFormat, SynthesisRequest

logger = get_logger(__name__)

_SAMPLE_RATE = 24000

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
    is_configured = True  # Self-hosted engine needs no credential

    def __init__(
        self,
        config: KokoroConfig,
        *,
        pipeline: Any | None = None,
        pipeline_factory: Callable[[], Any] | None = None,
        ttl_seconds: int | None = None,
        time_func: Callable[[], float] = time.monotonic,
    ) -> None:
        self._config = config
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
        pipeline = await self._get_pipeline_async()
        await asyncio.to_thread(lambda: list(pipeline("warm up.", voice=self._config.voice)))

    async def health(self) -> bool:
        return True

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
        voice = req.provider_voice or self._config.voice
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
