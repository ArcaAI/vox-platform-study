"""NVIDIA NeMo model loader."""

import logging
from pathlib import Path
from typing import Any

from ..core.config.settings import get_settings
from ..core.exceptions import ModelLoadError
from ..pipeline.dto import AiModelConfig, AiModelFormat
from .base_loader import BaseModelLoader, LoadedModel

logger = logging.getLogger(__name__)


class NeMoLoader(BaseModelLoader):
    """Load NVIDIA NeMo ASR models."""

    @property
    def supported_formats(self) -> list[AiModelFormat]:
        return [AiModelFormat.NEMO]

    async def load(self, model_config: AiModelConfig) -> LoadedModel:
        """
        Load NeMo model from checkpoint or HuggingFace.

        Args:
            model_config: Model configuration

        Returns:
            LoadedModel with NeMo model
        """
        try:
            import torch  # noqa: F401

            # Determine device
            # Device is always auto-detected from hardware; compute_type only affects dtype
            device = self._get_device("auto")

            # Load based on source
            if model_config.local_path and Path(model_config.local_path).exists():
                model = await self._load_from_checkpoint(
                    model_config.local_path, device
                )
            elif model_config.source_uri.startswith("nvidia/"):
                # NGC model
                model = await self._load_from_ngc(
                    model_config.source_uri, device
                )
            else:
                # Try HuggingFace
                model = await self._load_from_huggingface(
                    model_config.source_uri, device
                )

            # Estimate memory
            memory_mb = self._estimate_nemo_memory(model)

            logger.info(
                f"Loaded NeMo model {model_config.slug} "
                f"(device={device}, memory=~{memory_mb}MB)"
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
                    "model_type": type(model).__name__,
                },
            )

        except ImportError as e:
            raise ModelLoadError(
                "NeMo toolkit not installed. Install with: "
                "pip install nemo_toolkit[asr]"
            ) from e
        except Exception as e:
            raise ModelLoadError(
                f"Failed to load NeMo model {model_config.slug}: {e}"
            ) from e

    async def _load_from_checkpoint(self, checkpoint_path: str, device: str) -> Any:
        """Restore model from .nemo checkpoint."""
        import nemo.collections.asr as nemo_asr

        logger.info(f"Loading NeMo model from checkpoint: {checkpoint_path}")

        # Try different model types
        model_classes = [
            nemo_asr.models.EncDecCTCModelBPE,
            nemo_asr.models.EncDecRNNTBPEModel,
            nemo_asr.models.EncDecCTCModel,
        ]

        for model_class in model_classes:
            try:
                model = model_class.restore_from(checkpoint_path)
                model = model.to(device)
                model.eval()
                return model
            except Exception as e:
                logger.debug(f"Failed to load as {model_class.__name__}: {e}")
                continue

        raise ModelLoadError(
            f"Could not load checkpoint {checkpoint_path} with any known NeMo model class"
        )

    async def _load_from_ngc(self, model_name: str, device: str) -> Any:
        """Load model from NVIDIA NGC."""
        import nemo.collections.asr as nemo_asr

        logger.info(f"Loading NeMo model from NGC: {model_name}")

        # Common NGC ASR models
        if "conformer" in model_name.lower() or "ctc" in model_name.lower():
            model = nemo_asr.models.EncDecCTCModelBPE.from_pretrained(model_name)
        elif "transducer" in model_name.lower() or "rnnt" in model_name.lower():
            model = nemo_asr.models.EncDecRNNTBPEModel.from_pretrained(model_name)
        else:
            # Default to CTC
            model = nemo_asr.models.EncDecCTCModelBPE.from_pretrained(model_name)

        model = model.to(device)
        model.eval()
        return model

    async def _load_from_huggingface(self, model_id: str, device: str) -> Any:
        """Load NeMo model from HuggingFace."""

        logger.info(f"Loading NeMo model from HuggingFace: {model_id}")

        # NeMo models on HuggingFace are typically in .nemo format
        # Try to download and load
        from huggingface_hub import hf_hub_download

        settings = get_settings()

        try:
            # Download the .nemo file
            local_path = hf_hub_download(
                repo_id=model_id,
                filename="model.nemo",  # Common filename
                cache_dir=settings.huggingface_cache_dir,
                token=settings.huggingface_token,
            )
            return await self._load_from_checkpoint(local_path, device)
        except Exception:
            # Try alternative filename
            local_path = hf_hub_download(
                repo_id=model_id,
                filename="*.nemo",
                cache_dir=settings.huggingface_cache_dir,
                token=settings.huggingface_token,
            )
            return await self._load_from_checkpoint(local_path, device)

    async def unload(self, loaded_model: LoadedModel) -> None:
        """Unload NeMo model from memory."""
        try:
            import gc

            from .base_loader import cleanup_accelerator_memory

            if loaded_model.model is not None:
                del loaded_model.model

            gc.collect()

            # Release GPU/accelerator memory (CUDA, MPS, etc.)
            cleanup_accelerator_memory()

            logger.info(f"Unloaded NeMo model {loaded_model.model_slug}")

        except Exception as e:
            logger.warning(f"Error during NeMo model unload: {e}")

    def estimate_memory(self, model_config: AiModelConfig) -> int:
        """Estimate memory requirements."""
        if model_config.memory_size_mb:
            return model_config.memory_size_mb

        if model_config.file_size_mb:
            # NeMo models have similar memory footprint to file size
            return int(model_config.file_size_mb * 1.5)

        # Default estimates based on model name
        source = model_config.source_uri.lower()

        if "large" in source:
            return 2000  # ~2GB
        elif "medium" in source:
            return 1000  # ~1GB
        elif "small" in source:
            return 500  # ~500MB
        else:
            return 1000  # Default 1GB

    def _estimate_nemo_memory(self, model: Any) -> int:
        """Estimate actual memory usage of loaded NeMo model."""
        try:

            total_params = sum(p.numel() for p in model.parameters())
            # Assuming float32 (4 bytes per param)
            param_bytes = total_params * 4
            return int(param_bytes / (1024 * 1024))
        except Exception:
            return 1000
