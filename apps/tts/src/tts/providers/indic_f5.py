"""Self-hosted AI4Bharat IndicF5 (Malayalam) provider. EXPERIMENTAL.

IndicF5 is a flow-matching / F5 diffusion **voice-clone** model: each synthesis
needs a reference audio + its transcript (unlike Parler's description speakers).
It emits **24 kHz** natively (no resample). Full-utterance → the provider chunks
text into sentences itself and streams PCM per sentence (`native_streaming=True`),
mirroring `IndicParlerProvider`. torch/transformers are imported lazily so hermetic
tests inject a `generate` callable.

⚠️ PROD/COMMERCIAL ENABLEMENT IS NO-GO pending the owner's license review:
the released weights are a fine-tune of the CC-BY-NC SWivid F5-TTS
base (Emilia) — the MIT tag cannot override the NonCommercial restriction. Ships
`enabled=false`; NEVER set `TTS_INDICF5_ENABLED=true` in production without written
clearance. Indic Parler-TTS (Apache-2.0) remains the DEFAULT local ml engine. The
weights are also HF-gated → mirror internally before any real use.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncGenerator, Callable

import numpy as np
from hope_runtime_models import ModelCache

from tts.core.audio import encode_pcm, pcm16_to_mp3, pcm16_to_wav
from tts.core.config import IndicF5Config
from tts.core.logging import get_logger
from tts.core.metrics import TTS_MODEL_LOADED, build_model_cache_metrics_sink
from tts.providers.base import AudioChunk, AudioFormat, SynthesisRequest
from tts.routing.chunking import chunk_text

logger = get_logger(__name__)

_NATIVE_RATE = 24000  # IndicF5 is 24 kHz native (no resample)
_MAX_SENTENCE_CHARS = 300


class IndicF5Provider:
    name = "indic_f5"
    supported_locales = {"ml-IN", "en-IN"}
    native_streaming = True
    is_configured = True  # Self-hosted engine needs no credential

    def __init__(
        self,
        config: IndicF5Config,
        *,
        generate: Callable[[str], np.ndarray] | None = None,
        generate_factory: Callable[[], Callable[[str], np.ndarray]] | None = None,
        ttl_seconds: int | None = None,
        time_func: Callable[[], float] = time.monotonic,
    ) -> None:
        self._config = config
        # The model handle lives behind the
        # shared model cache, exactly as Kokoro's does, so it loads
        # on first use and is RELEASED when idle. An explicitly injected `generate`
        # bypasses the cache entirely (hermetic tests that want a permanent fake).
        self._generate = generate  # (text) -> float32 samples @ 24 kHz
        self._generate_factory = generate_factory
        self._cache: ModelCache[Callable[[str], np.ndarray]] = ModelCache(
            factory=self._load_generate,
            ttl_seconds=ttl_seconds if ttl_seconds is not None else 600,
            max_size=1,
            unload=self._unload_generate,
            time_func=time_func,
            metrics=build_model_cache_metrics_sink(),
            name="tts_indic_f5",
        )

    async def _load_generate(self, _key: str) -> Callable[[str], np.ndarray]:
        """Build the generate callable. Runs in a thread — a heavy, blocking load."""
        builder = self._generate_factory or self._load_model
        generate = await asyncio.to_thread(builder)

        TTS_MODEL_LOADED.labels(model="indic_f5").set(1)
        logger.info("tts.indic_f5_loaded", device=self._config.device, model=self._config.hf_model)
        return generate

    def _unload_generate(self, _key: str, _generate: object) -> None:
        """Drop the handle and zero the gauge; the weights free on GC."""
        TTS_MODEL_LOADED.labels(model="indic_f5").set(0)
        logger.info("tts.indic_f5_unloaded")

    async def _get_generate(self) -> Callable[[str], np.ndarray]:
        """The generate callable for this request, loading it on demand (single-flight)."""
        if self._generate is not None:
            return self._generate
        return await self._cache.get("indic_f5")

    def configure_retention(self, retention: dict[str, int]) -> None:
        """Adopt control-plane retention; absent keys keep the current value."""
        self._cache.configure(ttl_seconds=retention.get("ttl_seconds"))

    async def sweep(self) -> int:
        """Release the model if it has been idle past its TTL."""
        return await self._cache.sweep()

    def _load_model(self) -> Callable[[str], np.ndarray]:
        from transformers import AutoModel

        source = self._config.model_path or self._config.hf_model  # local mirror or gated hub
        model = AutoModel.from_pretrained(source, trust_remote_code=True).to(self._config.device)
        ref_audio = self._config.ref_audio_path
        ref_text = self._config.ref_text

        def _generate(text: str) -> np.ndarray:
            audio = model(text, ref_audio_path=ref_audio, ref_text=ref_text)
            arr = np.asarray(audio, dtype=np.float32)
            # IndicF5 may return int16-range samples; normalize to [-1, 1].
            if arr.size and np.abs(arr).max() > 1.5:
                arr = arr / 32768.0
            return arr

        return _generate

    async def warmup(self) -> None:
        generate = await self._get_generate()
        await asyncio.to_thread(generate, "warm up")

    async def health(self) -> bool:
        return True

    async def synthesize(self, req: SynthesisRequest) -> AsyncGenerator[AudioChunk, None]:
        generate = await self._get_generate()
        sentences = chunk_text(req.text, req.locale, _MAX_SENTENCE_CHARS)

        pcm_parts: list[bytes] = []
        for sentence in sentences:
            audio = await asyncio.to_thread(generate, sentence)
            pcm = encode_pcm(np.asarray(audio, dtype=np.float32), _NATIVE_RATE, req.sample_rate)
            if req.fmt == AudioFormat.PCM:
                yield AudioChunk(data=pcm)
            else:
                pcm_parts.append(pcm)

        if req.fmt != AudioFormat.PCM:
            joined = b"".join(pcm_parts)
            data = (
                pcm16_to_wav(joined, req.sample_rate)
                if req.fmt == AudioFormat.WAV
                else pcm16_to_mp3(joined, req.sample_rate)
            )
            yield AudioChunk(data=data, is_final=True)
