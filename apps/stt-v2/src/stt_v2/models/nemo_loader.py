"""NVIDIA NeMo ASR model loader"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from ..core.exceptions import ModelLoadError
from ..pipeline.dto import AiModelConfig, AiModelFormat
from .base_loader import BaseModelLoader, LoadedModel

logger = logging.getLogger(__name__)


_WORD_TS_CAPABLE_CLASSES = {
    "EncDecRNNTBPEModel",
    "EncDecHybridRNNTCTCBPEModel",
    "EncDecRNNTModel",
}


class NeMoLoader(BaseModelLoader):
    """Load NVIDIA NeMo ASR models."""

    @property
    def supported_formats(self) -> list[AiModelFormat]:
        return [AiModelFormat.NEMO]

    async def load(self, model_config: AiModelConfig) -> LoadedModel:
        try:
            import torch  # noqa: F401

            device = self._get_device("auto")

            try:
                from nemo.collections.asr.models import ASRModel
            except ImportError as e:
                raise ModelLoadError(
                    "NeMo toolkit not installed. Install with: "
                    "pip install 'nemo_toolkit[asr]>=2.0.0,<3.0.0'"
                ) from e

            if model_config.local_path and Path(model_config.local_path).exists():
                logger.info(
                    "Loading NeMo model from local checkpoint: %s",
                    model_config.local_path,
                )
                model = ASRModel.restore_from(model_config.local_path)
            else:
                logger.info(
                    "Loading NeMo model from pretrained: %s",
                    model_config.source_uri,
                )
                model = ASRModel.from_pretrained(model_name=model_config.source_uri)

            model = model.to(device)
            model.eval()

            model_class_name = type(model).__name__
            target_lang = getattr(getattr(model, "cfg", None), "target_lang", None)
            supports_word_ts = model_class_name in _WORD_TS_CAPABLE_CLASSES or any(
                tok in model_class_name for tok in ("RNNT", "TDT", "Hybrid")
            )

            memory_mb = self._estimate_nemo_memory(model)

            logger.info(
                "Loaded NeMo model %s (class=%s, device=%s, memory=~%dMB, lang=%s)",
                model_config.slug,
                model_class_name,
                device,
                memory_mb,
                target_lang,
            )

            return LoadedModel(
                model_id=model_config.id,
                model_slug=model_config.slug,
                model=model,
                tokenizer=None,
                processor=None,
                feature_extractor=None,
                format=AiModelFormat.NEMO,
                memory_mb=memory_mb,
                device=device,
                extra={
                    "source_uri": model_config.source_uri,
                    "model_class": model_class_name,
                    "target_lang": target_lang,
                    "supports_word_timestamps": supports_word_ts,
                    "supports_segment_timestamps": True,
                },
            )

        except ModelLoadError:
            raise
        except ImportError as e:
            raise ModelLoadError(
                "NeMo toolkit not installed. Install with: "
                "pip install 'nemo_toolkit[asr]>=2.0.0,<3.0.0'"
            ) from e
        except Exception as e:
            raise ModelLoadError(
                f"Failed to load NeMo model {model_config.slug}: {e}"
            ) from e

    async def unload(self, loaded_model: LoadedModel) -> None:
        try:
            import gc

            from .base_loader import cleanup_accelerator_memory

            if loaded_model.model is not None:
                del loaded_model.model

            gc.collect()
            cleanup_accelerator_memory()

            logger.info("Unloaded NeMo model %s", loaded_model.model_slug)
        except Exception as e:
            logger.warning("Error during NeMo model unload: %s", e)

    def estimate_memory(self, model_config: AiModelConfig) -> int:
        if model_config.memory_size_mb:
            return model_config.memory_size_mb
        if model_config.file_size_mb:
            return int(model_config.file_size_mb * 1.5)

        source = model_config.source_uri.lower()
        if "1.1b" in source or "large" in source:
            return 2000
        if "0.6b" in source or "medium" in source:
            return 1000
        if "small" in source:
            return 500
        return 1000

    def _estimate_nemo_memory(self, model: Any) -> int:
        try:
            total_params = sum(p.numel() for p in model.parameters())
            param_bytes = total_params * 4  # fp32 default
            return int(param_bytes / (1024 * 1024))
        except Exception:
            return 1500
