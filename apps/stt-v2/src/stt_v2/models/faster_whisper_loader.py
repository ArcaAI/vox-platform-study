"""faster-whisper (CTranslate2) model loader.

Loads a CT2-converted Whisper model via ``faster_whisper.WhisperModel`` and
pre-builds a ``BatchedInferencePipeline`` (stored in
``LoadedModel.extra["batched_pipeline"]``).

``faster_whisper`` is imported LAZILY inside :meth:`FasterWhisperLoader.load`
so the module (and the model cache that registers it) imports without the
package installed. The conversion runbook lives in
``stt_v2.streaming.faster_whisper_asr``.
"""

from __future__ import annotations

import asyncio
import logging

from ..core.config.settings import get_settings
from ..core.exceptions import ModelLoadError
from ..pipeline.dto import AiModelConfig, AiModelFormat
from .base_loader import BaseModelLoader, LoadedModel
from .source_resolver import resolve_weights_or_hf_id

logger = logging.getLogger(__name__)

_INSTALL_HINT = (
    "faster-whisper not installed. Install with: "
    "pip install 'faster-whisper>=1.2.1'"
)


class FasterWhisperLoader(BaseModelLoader):
    """Load CTranslate2 Whisper models through faster-whisper."""

    @property
    def supported_formats(self) -> list[AiModelFormat]:
        return [AiModelFormat.FASTER_WHISPER]

    async def load(self, model_config: AiModelConfig) -> LoadedModel:
        try:
            from faster_whisper import BatchedInferencePipeline, WhisperModel
        except ImportError as e:
            raise ModelLoadError(_INSTALL_HINT) from e

        from stt_v2.streaming.faster_whisper_asr import (
            resolve_ct2_compute_type,
            resolve_ct2_device,
        )

        try:
            base_device = self._get_device(model_config.device or "auto")
            device, device_index = resolve_ct2_device(base_device)

            compute_type = model_config.compute_type
            if not compute_type:
                compute_type = self._profile_compute_type()
            compute_type = resolve_ct2_compute_type(compute_type, device)

            # One resolver contract: local_path (operator override)
            # first, then scheme dispatch on source_uri (hf: / file:// / s3://).
            # faster-whisper also accepts a bare HF id, so a hub source_uri is
            # handed through unchanged when the resolver reports no local dir.
            model_path = await resolve_weights_or_hf_id(model_config, get_settings())

            logger.info(
                "Loading faster-whisper model %s (path=%s, device=%s:%d, "
                "compute_type=%s)",
                model_config.slug,
                model_path,
                device,
                device_index,
                compute_type,
            )

            def _load_sync() -> tuple[object, object]:
                model = WhisperModel(
                    model_path,
                    device=device,
                    device_index=device_index,
                    compute_type=compute_type,
                )
                batched = BatchedInferencePipeline(model=model)
                return model, batched

            model, batched = await asyncio.to_thread(_load_sync)

            memory_mb = self.estimate_memory(model_config)
            device_str = f"{device}:{device_index}" if device == "cuda" else device

            return LoadedModel(
                model_id=model_config.id,
                model_slug=model_config.slug,
                model=model,
                tokenizer=None,
                processor=None,
                feature_extractor=None,
                format=AiModelFormat.FASTER_WHISPER,
                memory_mb=memory_mb,
                device=device_str,
                extra={
                    "source_uri": model_config.source_uri,
                    "batched_pipeline": batched,
                    "compute_type": compute_type,
                },
            )
        except ModelLoadError:
            raise
        except Exception as e:
            raise ModelLoadError(
                f"Failed to load faster-whisper model {model_config.slug}: {e}"
            ) from e

    @staticmethod
    def _profile_compute_type() -> str | None:
        """Honor ``ExecutionProfile.asr_compute_type`` when no explicit value."""
        try:
            from stt_v2.streaming._runtime import get_execution_profile

            profile = get_execution_profile()
        except Exception:
            return None
        if profile is None:
            return None
        return getattr(profile, "asr_compute_type", None)

    async def unload(self, loaded_model: LoadedModel) -> None:
        try:
            import gc

            from .base_loader import cleanup_accelerator_memory

            if loaded_model.extra:
                loaded_model.extra.pop("batched_pipeline", None)
            if loaded_model.model is not None:
                del loaded_model.model

            gc.collect()
            cleanup_accelerator_memory()

            logger.info(
                "Unloaded faster-whisper model %s", loaded_model.model_slug
            )
        except Exception as e:
            logger.warning("Error during faster-whisper model unload: %s", e)

    def estimate_memory(self, model_config: AiModelConfig) -> int:
        if model_config.memory_size_mb:
            return model_config.memory_size_mb
        if model_config.file_size_mb:
            return int(model_config.file_size_mb * 1.2)

        source = model_config.source_uri.lower()
        if "large" in source or "turbo" in source:
            return 3000
        if "medium" in source:
            return 1500
        if "small" in source:
            return 500
        return 1500
