"""HuggingFace model loader for SafeTensor/Transformers models."""

import logging
import os
from transformers import GenerationConfig
from typing import Any

from ..core.config.settings import get_settings
from ..core.exceptions import ModelLoadError
from ..pipeline.dto import AiModelConfig, AiModelFormat, ModelTaskType
from .base_loader import BaseModelLoader, LoadedModel

logger = logging.getLogger(__name__)


class HuggingFaceLoader(BaseModelLoader):
    """Load models from HuggingFace Hub using Transformers library."""

    @property
    def supported_formats(self) -> list[AiModelFormat]:
        return [AiModelFormat.SAFETENSOR, AiModelFormat.PYTORCH]

    async def load(self, model_config: AiModelConfig) -> LoadedModel:
        """
        Load model using transformers library.

        Supports: AutoModelForSpeechSeq2Seq, Wav2Vec2, Whisper, etc.
        """
        settings = get_settings()

        try:
            import torch
            from transformers import (
                AutoFeatureExtractor,
                AutoModelForSpeechSeq2Seq,
                AutoProcessor,
                AutoTokenizer,
            )

            # Determine device and dtype
            # Device is always auto-detected from hardware; compute_type only affects dtype
            device = self._get_device("auto")
            torch_dtype = self._get_torch_dtype(model_config.compute_type or "auto")

            # Model source (HuggingFace model ID or local path)
            model_source = model_config.local_path or model_config.source_uri

            # Set cache directory
            cache_dir = settings.huggingface_cache_dir
            os.makedirs(cache_dir, exist_ok=True)

            logger.info(
                f"Loading HuggingFace model: {model_source} "
                f"(device={device}, dtype={torch_dtype})"
            )

            # Load model based on task type
            model, tokenizer, processor, feature_extractor = await self._load_by_task(
                model_source=model_source,
                task_type=model_config.task_type,
                device=device,
                torch_dtype=torch_dtype,
                cache_dir=cache_dir,
                revision=model_config.source_revision,
                token=settings.huggingface_token,
            )

            # Estimate memory usage
            memory_mb = self._estimate_model_memory(model)

            logger.info(
                f"Loaded model {model_config.slug} successfully "
                f"(memory: ~{memory_mb}MB)"
            )

            return LoadedModel(
                model_id=model_config.id,
                model_slug=model_config.slug,
                model=model,
                tokenizer=tokenizer,
                processor=processor,
                feature_extractor=feature_extractor,
                format=model_config.format,
                memory_mb=memory_mb,
                device=device,
                extra={
                    "source_uri": model_config.source_uri,
                    "revision": model_config.source_revision,
                },
            )

        except ImportError as e:
            raise ModelLoadError(
                f"Missing required package for HuggingFace loader: {e}"
            ) from e
        except Exception as e:
            raise ModelLoadError(
                f"Failed to load HuggingFace model {model_config.slug}: {e}"
            ) from e

    async def _load_by_task(
        self,
        model_source: str,
        task_type: ModelTaskType,
        device: str,
        torch_dtype: Any,
        cache_dir: str,
        revision: str | None,
        token: str | None,
    ) -> tuple[Any, Any, Any, Any]:
        """Load model components based on task type."""
        import torch
        from transformers import (
            AutoFeatureExtractor,
            AutoModelForAudioClassification,
            AutoModelForCTC,
            AutoModelForSpeechSeq2Seq,
            AutoProcessor,
            AutoTokenizer,
            Wav2Vec2ForCTC,
            WhisperForConditionalGeneration,
            WhisperProcessor,
        )

        model = None
        tokenizer = None
        processor = None
        feature_extractor = None

        common_kwargs = {
            "cache_dir": cache_dir,
            "revision": revision,
            "token": token,
        }

        if task_type == ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION:
            # Try loading as Whisper first
            try:
                model = WhisperForConditionalGeneration.from_pretrained(
                    model_source,
                    torch_dtype=torch_dtype,
                    low_cpu_mem_usage=True,
                    **common_kwargs,
                )
                generation_config = GenerationConfig.from_pretrained(
                    model_source, **common_kwargs
                )
                model.generation_config = generation_config
                processor = WhisperProcessor.from_pretrained(
                    model_source, **common_kwargs
                )
            except Exception:
                # Fall back to generic ASR model
                try:
                    model = AutoModelForSpeechSeq2Seq.from_pretrained(
                        model_source,
                        torch_dtype=torch_dtype,
                        low_cpu_mem_usage=True,
                        **common_kwargs,
                    )
                except Exception:
                    # Try CTC model (Wav2Vec2, HuBERT)
                    model = AutoModelForCTC.from_pretrained(
                        model_source,
                        torch_dtype=torch_dtype,
                        low_cpu_mem_usage=True,
                        **common_kwargs,
                    )

            # Load processor/tokenizer
            if processor is None:
                try:
                    processor = AutoProcessor.from_pretrained(
                        model_source, **common_kwargs
                    )
                except Exception:
                    tokenizer = AutoTokenizer.from_pretrained(
                        model_source, **common_kwargs
                    )
                    feature_extractor = AutoFeatureExtractor.from_pretrained(
                        model_source, **common_kwargs
                    )

        elif task_type == ModelTaskType.VOICE_ACTIVITY_DETECTION:
            # VAD models (e.g., Silero VAD, pyannote)
            model = AutoModelForAudioClassification.from_pretrained(
                model_source,
                torch_dtype=torch_dtype,
                **common_kwargs,
            )
            feature_extractor = AutoFeatureExtractor.from_pretrained(
                model_source, **common_kwargs
            )

        else:
            # Generic loading
            model = AutoModelForSpeechSeq2Seq.from_pretrained(
                model_source,
                torch_dtype=torch_dtype,
                low_cpu_mem_usage=True,
                **common_kwargs,
            )
            processor = AutoProcessor.from_pretrained(
                model_source, **common_kwargs
            )

        # Move model to device
        if model is not None:
            model = model.to(device)

        return model, tokenizer, processor, feature_extractor

    async def unload(self, loaded_model: LoadedModel) -> None:
        """Unload model from memory."""
        try:
            import gc

            from .base_loader import cleanup_accelerator_memory

            # Delete model components
            if loaded_model.model is not None:
                del loaded_model.model
            if loaded_model.tokenizer is not None:
                del loaded_model.tokenizer
            if loaded_model.processor is not None:
                del loaded_model.processor
            if loaded_model.feature_extractor is not None:
                del loaded_model.feature_extractor

            # Force garbage collection
            gc.collect()

            # Release GPU/accelerator memory (CUDA, MPS, etc.)
            cleanup_accelerator_memory()

            logger.info(f"Unloaded model {loaded_model.model_slug}")

        except Exception as e:
            logger.warning(f"Error during model unload: {e}")

    def estimate_memory(self, model_config: AiModelConfig) -> int:
        """Estimate memory requirements."""
        # Use stored value if available
        if model_config.memory_size_mb:
            return model_config.memory_size_mb

        # Rough estimates based on model name patterns
        source = model_config.source_uri.lower()

        if "whisper-large" in source:
            return 3000  # ~3GB
        elif "whisper-medium" in source:
            return 1500  # ~1.5GB
        elif "whisper-small" in source:
            return 500  # ~500MB
        elif "whisper-base" in source:
            return 150  # ~150MB
        elif "whisper-tiny" in source:
            return 80  # ~80MB
        elif "wav2vec2-large" in source:
            return 1200  # ~1.2GB
        elif "wav2vec2-base" in source:
            return 400  # ~400MB
        elif "silero" in source:
            return 50  # ~50MB (VAD models are small)
        else:
            return 1000  # Default 1GB estimate

    def _estimate_model_memory(self, model: Any) -> int:
        """Estimate actual memory usage of loaded model."""
        try:
            import torch

            if hasattr(model, "num_parameters"):
                # Rough estimate: 4 bytes per parameter for float32
                params = model.num_parameters()
                # Adjust for dtype (float16 = 2 bytes)
                bytes_per_param = 2 if model.dtype == torch.float16 else 4
                return int((params * bytes_per_param) / (1024 * 1024))
            return 0
        except Exception:
            return 0
