"""Self-hosted Kokoro (English) TTS provider.

Kokoro-82M is Apache-2.0, ONNX-friendly, and emits 24 kHz float audio — no
resample needed. `KPipeline` splits text internally and yields per-segment
audio, so this provider streams PCM chunks (``native_streaming=True``). The
`kokoro` package is imported lazily so hermetic tests inject a fake pipeline.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import numpy as np

from tts_v2.core.audio import encode_pcm, pcm16_to_mp3, pcm16_to_wav
from tts_v2.core.config import KokoroConfig
from tts_v2.core.logging import get_logger
from tts_v2.core.metrics import TTS_MODEL_LOADED
from tts_v2.providers.base import AudioChunk, AudioFormat, SynthesisRequest

logger = get_logger(__name__)

_SAMPLE_RATE = 24000


class KokoroProvider:
    name = "kokoro"
    supported_locales = {"en-IN", "en-US"}
    native_streaming = True

    def __init__(self, config: KokoroConfig, *, pipeline: Any | None = None) -> None:
        self._config = config
        self._pipeline = pipeline

    def _get_pipeline(self) -> Any:
        if self._pipeline is None:
            from kokoro import KPipeline  # lazy, heavy [local] dep

            self._pipeline = KPipeline(lang_code="a")  # 'a' = American English
            TTS_MODEL_LOADED.labels(model="kokoro").set(1)
            logger.info("tts_v2.kokoro_loaded", device=self._config.device)
        return self._pipeline

    async def warmup(self) -> None:
        pipeline = self._get_pipeline()
        await asyncio.to_thread(lambda: list(pipeline("warm up.", voice=self._config.voice)))

    async def health(self) -> bool:
        return True

    async def synthesize(self, req: SynthesisRequest) -> AsyncIterator[AudioChunk]:
        pipeline = self._get_pipeline()
        voice = req.provider_voice or self._config.voice
        segments = await asyncio.to_thread(
            lambda: [seg[2] for seg in pipeline(req.text, voice=voice)]
        )

        if req.fmt == AudioFormat.PCM:
            for audio in segments:
                yield AudioChunk(encode_pcm(np.asarray(audio, dtype=np.float32), _SAMPLE_RATE, req.sample_rate))
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
