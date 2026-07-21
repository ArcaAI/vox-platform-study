"""Self-hosted AI4Bharat Indic Parler-TTS (Malayalam) provider.

Indic Parler-TTS is Apache-2.0, handles code-switched Malayalam, and emits
44.1 kHz audio (Phase 0) → resampled to 24 kHz here. It is a full-utterance model,
so the provider chunks text into sentences itself and streams PCM per sentence
(``native_streaming=True`` with an internal loop — chosen over the router's
sentence-adapter so WAV/MP3 produce a single correct container). torch/transformers
are imported lazily so hermetic tests inject a `generate` callable.

NOTE: the `ai4bharat/indic-parler-tts` weights are HF click-through gated — a
production deploy must mirror them into an internal registry (Phase 0 finding).
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Callable

import numpy as np
from hope_runtime_models import ModelCache

from tts_v2.core.audio import encode_pcm, pcm16_to_mp3, pcm16_to_wav
from tts_v2.core.config import IndicParlerConfig
from tts_v2.core.logging import get_logger
from tts_v2.core.metrics import TTS_MODEL_LOADED, build_model_cache_metrics_sink
from tts_v2.providers.base import AudioChunk, AudioFormat, SynthesisRequest
from tts_v2.routing.chunking import chunk_text

logger = get_logger(__name__)

_NATIVE_RATE = 44100
_MAX_SENTENCE_CHARS = 400  # Parler practical per-utterance limit


def _resolve_model_source(config: IndicParlerConfig) -> tuple[str, dict[str, bool]]:
    """Where to load the Parler model + prompt tokenizer from.

    When ``model_path`` is set (an internal ungated mirror) load from it with
    ``local_files_only=True`` so transformers never touches the gated hub;
    otherwise fall back to the gated ``hf_model`` id (dev only).
    """
    if config.model_path:
        return config.model_path, {"local_files_only": True}
    return config.hf_model, {}


def _resolve_desc_source(
    config: IndicParlerConfig, baked_id: str
) -> tuple[str, dict[str, bool]]:
    """Where to load the description (flan-t5) tokenizer from.

    Parler bakes ``google/flan-t5-large`` as a Hub id in its config, so it is
    fetched at load even when the model is local. When ``desc_encoder_path`` is
    set load the mirrored tokenizer from it (``local_files_only``); otherwise use
    the baked id from ``model.config.text_encoder._name_or_path``.
    """
    if config.desc_encoder_path:
        return config.desc_encoder_path, {"local_files_only": True}
    return baked_id, {}


class IndicParlerProvider:
    name = "indic_parler"
    supported_locales = {"ml-IN", "en-IN"}
    native_streaming = True

    def __init__(
        self,
        config: IndicParlerConfig,
        *,
        generate: Callable[[str, str], np.ndarray] | None = None,
        generate_factory: Callable[[], Callable[[str, str], np.ndarray]] | None = None,
        ttl_seconds: int | None = None,
        time_func: Callable[[], float] = time.monotonic,
    ) -> None:
        self._config = config
        # The model handle lives behind the
        # shared model cache, exactly as Kokoro's does, so it loads
        # on first use and is RELEASED when idle. An explicitly injected `generate`
        # bypasses the cache entirely (hermetic tests that want a permanent fake).
        self._generate = generate
        self._generate_factory = generate_factory
        self._cache: ModelCache[Callable[[str, str], np.ndarray]] = ModelCache(
            factory=self._load_generate,
            ttl_seconds=ttl_seconds if ttl_seconds is not None else 600,
            max_size=1,
            unload=self._unload_generate,
            time_func=time_func,
            metrics=build_model_cache_metrics_sink(),
            name="tts_indic_parler",
        )

    def _describe(self, locale: str) -> str:
        speaker = self._config.speaker_ml if locale.startswith("ml") else self._config.speaker_en
        return (
            f"{speaker} speaks in a clear, neutral, professional tone at a natural "
            "pace, with very high quality audio and no background noise."
        )

    async def _load_generate(self, _key: str) -> Callable[[str, str], np.ndarray]:
        """Build the generate callable. Runs in a thread — a heavy, blocking load."""
        builder = self._generate_factory or self._load_model
        generate = await asyncio.to_thread(builder)

        TTS_MODEL_LOADED.labels(model="indic_parler").set(1)
        logger.info(
            "tts_v2.indic_parler_loaded", device=self._config.device, model=self._config.hf_model
        )
        return generate

    def _unload_generate(self, _key: str, _generate: object) -> None:
        """Drop the handle and zero the gauge; the weights free on GC."""
        TTS_MODEL_LOADED.labels(model="indic_parler").set(0)
        logger.info("tts_v2.indic_parler_unloaded")

    async def _get_generate(self) -> Callable[[str, str], np.ndarray]:
        """The generate callable for this request, loading it on demand (single-flight)."""
        if self._generate is not None:
            return self._generate
        return await self._cache.get("indic_parler")

    def configure_retention(self, retention: dict[str, int]) -> None:
        """Adopt control-plane retention; absent keys keep the current value."""
        self._cache.configure(ttl_seconds=retention.get("ttl_seconds"))

    async def sweep(self) -> int:
        """Release the model if it has been idle past its TTL."""
        return await self._cache.sweep()

    def _load_model(self) -> Callable[[str, str], np.ndarray]:
        import torch
        from parler_tts import ParlerTTSForConditionalGeneration
        from transformers import AutoTokenizer

        device = self._config.device
        model_source, model_kwargs = _resolve_model_source(self._config)
        model = ParlerTTSForConditionalGeneration.from_pretrained(
            model_source, **model_kwargs
        ).to(device)
        tokenizer = AutoTokenizer.from_pretrained(model_source, **model_kwargs)
        desc_source, desc_kwargs = _resolve_desc_source(
            self._config, model.config.text_encoder._name_or_path
        )
        desc_tokenizer = AutoTokenizer.from_pretrained(desc_source, **desc_kwargs)

        def _generate(text: str, description: str) -> np.ndarray:
            desc_ids = desc_tokenizer(description, return_tensors="pt").to(device)
            prompt_ids = tokenizer(text, return_tensors="pt").to(device)
            with torch.no_grad():
                audio = model.generate(
                    input_ids=desc_ids.input_ids,
                    attention_mask=desc_ids.attention_mask,
                    prompt_input_ids=prompt_ids.input_ids,
                    prompt_attention_mask=prompt_ids.attention_mask,
                )
            return audio.cpu().to(torch.float32).numpy().squeeze()

        return _generate

    async def warmup(self) -> None:
        generate = await self._get_generate()
        await asyncio.to_thread(generate, "warm up", self._describe("en-IN"))

    async def health(self) -> bool:
        return True

    async def synthesize(self, req: SynthesisRequest) -> AsyncIterator[AudioChunk]:
        generate = await self._get_generate()
        description = self._describe(req.locale)
        sentences = chunk_text(req.text, req.locale, _MAX_SENTENCE_CHARS)

        pcm_parts: list[bytes] = []
        for sentence in sentences:
            audio = await asyncio.to_thread(generate, sentence, description)
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
