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
from collections.abc import AsyncGenerator, Callable

import numpy as np
from hope_runtime_models import ModelCache

from tts.core.audio import encode_pcm, pcm16_to_mp3, pcm16_to_wav
from tts.core.config import IndicParlerConfig
from tts.core.logging import get_logger
from tts.core.metrics import TTS_MODEL_LOADED, build_model_cache_metrics_sink
from tts.providers.base import (
    AudioChunk,
    AudioFormat,
    CredentialPosture,
    SynthesisRequest,
)
from tts.routing.chunking import chunk_text

logger = get_logger(__name__)

_NATIVE_RATE = 44100
_MAX_SENTENCE_CHARS = 400  # Parler practical per-utterance limit


def _resolve_model_source(config: IndicParlerConfig) -> tuple[str, dict[str, bool]]:
    """Where to load the Parler model + prompt tokenizer from.

    When ``model_path`` is set (an internal ungated mirror) load from it with
    ``local_files_only=True`` so transformers never touches the gated hub;
    otherwise fall back to the gated ``hf_model`` id (dev only).

    Synchronous and unaware of ``s3://`` on purpose: any ``s3://`` value in
    ``model_path`` has already been materialised into a real local directory by
    ``_resolve_s3_overrides`` (TASK-855 L6) before ``config`` reaches here, so
    from this function's point of view it is indistinguishable from an
    already-staged local mirror.
    """
    if config.model_path:
        return config.model_path, {"local_files_only": True}
    return config.hf_model, {}


def _resolve_desc_source(config: IndicParlerConfig, baked_id: str) -> tuple[str, dict[str, bool]]:
    """Where to load the description (flan-t5) tokenizer from.

    Parler bakes ``google/flan-t5-large`` as a Hub id in its config, so it is
    fetched at load even when the model is local. When ``desc_encoder_path`` is
    set load the mirrored tokenizer from it (``local_files_only``); otherwise use
    the baked id from ``model.config.text_encoder._name_or_path``.

    Same ``s3://``-unaware note as ``_resolve_model_source`` above.
    """
    if config.desc_encoder_path:
        return config.desc_encoder_path, {"local_files_only": True}
    return baked_id, {}


async def _resolve_s3_overrides(config: IndicParlerConfig) -> IndicParlerConfig:
    """Materialise an ``s3://`` local-mirror override into a real directory.

    ``model_path`` / ``desc_encoder_path`` are plain local-mirror paths
    (Mode M — an operator/admin-staged directory); this resolves the ONE new
    case, an ``s3://bucket/prefix`` value, via the mirrored resolver
    (``tts.models.source_resolver``) BEFORE ``_resolve_model_source`` /
    ``_resolve_desc_source`` (unchanged, still synchronous) ever see it. A
    config with no ``s3://`` override is returned UNCHANGED (same object),
    so the existing local-path / gated-hub behaviour is byte-for-byte
    preserved.
    """
    from tts.models.source_resolver import resolve_local_override

    updates: dict[str, str] = {}
    if config.model_path.startswith("s3://"):
        updates["model_path"] = await resolve_local_override(
            config.model_path, slug="indic_parler-model"
        )
    if config.desc_encoder_path.startswith("s3://"):
        updates["desc_encoder_path"] = await resolve_local_override(
            config.desc_encoder_path, slug="indic_parler-desc"
        )
    return config.model_copy(update=updates) if updates else config


class IndicParlerProvider:
    name = "indic_parler"
    supported_locales = {"ml-IN", "en-IN"}
    native_streaming = True
    # Operator-run engine with LOCAL weights — no vendor credential exists to
    # fail closed on. Declared explicitly because the lock test is default-deny:
    # an adapter that says nothing fails it.
    credential_posture = CredentialPosture.SELF_HOST
    is_configured = True  # Self-hosted engine needs no credential

    def __init__(
        self,
        config: IndicParlerConfig,
        *,
        generate: Callable[[str, str], np.ndarray] | None = None,
        generate_factory: Callable[[], Callable[[str, str], np.ndarray]] | None = None,
        ttl_seconds: int | None = None,
        time_func: Callable[[], float] = time.monotonic,
        warmup_speaker: str | None = None,
    ) -> None:
        self._config = config
        # Speaker used ONLY by the boot-time `warmup()` call, supplied from the
        # voice catalog at construction (`main.create_app`). None ⇒ the catalog
        # binds no Malayalam voice to indic_parler, so there is nothing to warm.
        self._warmup_speaker = warmup_speaker
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

    def _describe(self, speaker: str) -> str:
        """The description prompt Parler conditions on, for one speaker.

        Takes the SPEAKER, not the locale (TASK-799 lane C). It used to pick
        between its own `speaker_ml` / `speaker_en` settings fields — which meant
        this provider ignored `req.provider_voice` entirely and silently
        discarded the catalog binding the router had already resolved for it.
        Two representations of one fact, with the wrong one winning.
        """
        return (
            f"{speaker} speaks in a clear, neutral, professional tone at a natural "
            "pace, with very high quality audio and no background noise."
        )

    async def _load_generate(self, _key: str) -> Callable[[str, str], np.ndarray]:
        """Build the generate callable. Runs in a thread — a heavy, blocking load."""
        # Resolve any `s3://` local-mirror override HERE, in the coroutine —
        # never inside the thread the blocking torch/transformers load runs on
        # (no event loop to `await` an async download against there).
        effective_config = await _resolve_s3_overrides(self._config)
        builder = self._generate_factory or (lambda: self._load_model(effective_config))
        generate = await asyncio.to_thread(builder)

        TTS_MODEL_LOADED.labels(model="indic_parler").set(1)
        logger.info(
            "tts.indic_parler_loaded", device=self._config.device, model=self._config.hf_model
        )
        return generate

    def _unload_generate(self, _key: str, _generate: object) -> None:
        """Drop the handle and zero the gauge; the weights free on GC."""
        TTS_MODEL_LOADED.labels(model="indic_parler").set(0)
        logger.info("tts.indic_parler_unloaded")

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

    def _load_model(
        self, config: IndicParlerConfig | None = None
    ) -> Callable[[str, str], np.ndarray]:
        import torch
        from parler_tts import ParlerTTSForConditionalGeneration
        from transformers import AutoTokenizer

        # `config` is the s3-override-resolved config `_load_generate` builds;
        # defaults to `self._config` so a direct call (existing tests that
        # inject `generate_factory` never reach this method at all) is unchanged.
        cfg = config if config is not None else self._config
        device = cfg.device
        model_source, model_kwargs = _resolve_model_source(cfg)
        model = ParlerTTSForConditionalGeneration.from_pretrained(model_source, **model_kwargs).to(
            device
        )
        tokenizer = AutoTokenizer.from_pretrained(model_source, **model_kwargs)
        desc_source, desc_kwargs = _resolve_desc_source(
            cfg, model.config.text_encoder._name_or_path
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
            return np.asarray(audio.cpu().to(torch.float32).numpy().squeeze())

        return _generate

    async def warmup(self) -> None:
        """Load the weights, and run one generation when a speaker is known.

        The LOAD is unconditional — see the note on `KokoroProvider.warmup`: the
        fail-at-boot guarantee an operator buys with `TTS_WARMUP_ENABLED` lives
        in the load, not in the trial generation, so an absent catalog binding
        must not cost them the boot-time check.
        """
        generate = await self._get_generate()
        speaker = self._warmup_speaker
        if speaker is None:
            return
        await asyncio.to_thread(generate, "warm up", self._describe(speaker))

    async def health(self) -> bool:
        return True

    async def synthesize(self, req: SynthesisRequest) -> AsyncGenerator[AudioChunk, None]:
        generate = await self._get_generate()
        description = self._describe(req.provider_voice)
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
