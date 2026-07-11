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
from collections.abc import AsyncIterator, Callable

import numpy as np

from tts_v2.core.audio import encode_pcm, pcm16_to_mp3, pcm16_to_wav
from tts_v2.core.config import IndicParlerConfig
from tts_v2.core.logging import get_logger
from tts_v2.core.metrics import TTS_MODEL_LOADED
from tts_v2.providers.base import AudioChunk, AudioFormat, SynthesisRequest
from tts_v2.routing.chunking import chunk_text

logger = get_logger(__name__)

_NATIVE_RATE = 44100
_MAX_SENTENCE_CHARS = 400  # Parler practical per-utterance limit


class IndicParlerProvider:
    name = "indic_parler"
    supported_locales = {"ml-IN", "en-IN"}
    native_streaming = True

    def __init__(
        self,
        config: IndicParlerConfig,
        *,
        generate: Callable[[str, str], np.ndarray] | None = None,
    ) -> None:
        self._config = config
        self._generate = generate

    def _describe(self, locale: str) -> str:
        speaker = self._config.speaker_ml if locale.startswith("ml") else self._config.speaker_en
        return (
            f"{speaker} speaks in a clear, neutral, professional tone at a natural "
            "pace, with very high quality audio and no background noise."
        )

    def _ensure_loaded(self) -> None:
        if self._generate is not None:
            return
        self._generate = self._load_model()
        TTS_MODEL_LOADED.labels(model="indic_parler").set(1)
        logger.info("tts_v2.indic_parler_loaded", device=self._config.device, model=self._config.hf_model)

    def _load_model(self) -> Callable[[str, str], np.ndarray]:
        import torch
        from parler_tts import ParlerTTSForConditionalGeneration
        from transformers import AutoTokenizer

        device = self._config.device
        model = ParlerTTSForConditionalGeneration.from_pretrained(self._config.hf_model).to(device)
        tokenizer = AutoTokenizer.from_pretrained(self._config.hf_model)
        desc_tokenizer = AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path)

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
        await asyncio.to_thread(self._ensure_loaded)
        assert self._generate is not None
        await asyncio.to_thread(self._generate, "warm up", self._describe("en-IN"))

    async def health(self) -> bool:
        return True

    async def synthesize(self, req: SynthesisRequest) -> AsyncIterator[AudioChunk]:
        self._ensure_loaded()
        assert self._generate is not None
        description = self._describe(req.locale)
        sentences = chunk_text(req.text, req.locale, _MAX_SENTENCE_CHARS)

        pcm_parts: list[bytes] = []
        for sentence in sentences:
            audio = await asyncio.to_thread(self._generate, sentence, description)
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
