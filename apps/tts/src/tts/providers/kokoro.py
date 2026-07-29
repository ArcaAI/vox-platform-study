"""Self-hosted Kokoro (English) TTS provider.

Kokoro-82M is Apache-2.0, ONNX-friendly, and emits 24 kHz float audio — no
resample needed. `KPipeline` splits text internally and yields per-segment
audio, so this provider streams PCM chunks (``native_streaming=True``). The
`kokoro` package is imported lazily so hermetic tests inject a fake pipeline.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Callable
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


class KokoroProvider:
    name = "kokoro"
    supported_locales = {"en-IN", "en-US"}
    native_streaming = True

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

    async def synthesize(self, req: SynthesisRequest) -> AsyncIterator[AudioChunk]:
        pipeline = await self._get_pipeline_async()
        voice = req.provider_voice or self._config.voice
        segments = await asyncio.to_thread(
            lambda: [seg[2] for seg in pipeline(req.text, voice=voice)]
        )

        if req.fmt == AudioFormat.PCM:
            for audio in segments:
                yield AudioChunk(
                    encode_pcm(np.asarray(audio, dtype=np.float32), _SAMPLE_RATE, req.sample_rate)
                )
            return

        pcm = b"".join(
            encode_pcm(np.asarray(audio, dtype=np.float32), _SAMPLE_RATE, req.sample_rate)
            for audio in segments
        )
        data = (
            pcm16_to_wav(pcm, req.sample_rate)
            if req.fmt == AudioFormat.WAV
            else pcm16_to_mp3(pcm, req.sample_rate)
        )
        yield AudioChunk(data=data, is_final=True)
