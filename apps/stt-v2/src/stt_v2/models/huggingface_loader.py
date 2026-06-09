"""HuggingFace model loader for SafeTensor/Transformers models."""

import asyncio
import logging
import os
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
            import torch  # noqa: F401
            from transformers import (
                AutoModelForSpeechSeq2Seq,  # noqa: F401
                AutoProcessor,  # noqa: F401
                AutoTokenizer,  # noqa: F401
            )

            # Determine device and dtype
            # Device can be specified in model config; falls back to auto-detect
            requested_device = model_config.device or "auto"
            device = self._get_device(requested_device)
            torch_dtype = self._get_torch_dtype(model_config.compute_type or "auto")

            # Model source (HuggingFace model ID or local path)
            model_source = model_config.local_path or model_config.source_uri

            # Set cache directory
            cache_dir = settings.huggingface_cache_dir
            os.makedirs(cache_dir, exist_ok=True)

            logger.info(
                "Loading HuggingFace model: %s (device=%s, dtype=%s, attn_implementation=%s)",
                model_source, device, torch_dtype, model_config.attn_implementation,
            )

            # Load model in a thread pool to avoid blocking the event loop.
            model, tokenizer, processor, feature_extractor, is_multimodal_lm = await asyncio.to_thread(
                self._load_by_task,
                model_source=model_source,
                task_type=model_config.task_type,
                device=device,
                torch_dtype=torch_dtype,
                cache_dir=cache_dir,
                revision=model_config.source_revision,
                token=settings.huggingface_token,
                attn_implementation=model_config.attn_implementation,
            )

            # Estimate memory usage
            memory_mb = self._estimate_model_memory(model)

            logger.info(
                "Loaded model %s successfully (memory: ~%dMB)",
                model_config.slug, memory_mb,
            )

            extra: dict[str, Any] = {
                "source_uri": model_config.source_uri,
                "revision": model_config.source_revision,
            }
            if is_multimodal_lm:
                extra["multimodal_lm"] = True
                extra["max_audio_seconds"] = 30

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
                extra=extra,
            )

        except ImportError as e:
            raise ModelLoadError(f"Missing required package for HuggingFace loader: {e}") from e
        except Exception as e:
            raise ModelLoadError(
                f"Failed to load HuggingFace model {model_config.slug}: {e}"
            ) from e

    def _load_by_task(
        self,
        model_source: str,
        task_type: ModelTaskType,
        device: str,
        torch_dtype: Any,
        cache_dir: str,
        revision: str | None,
        token: str | None,
        attn_implementation: str | None = None,
    ) -> tuple[Any, Any, Any, Any, bool]:
        """Load model components based on task type.

        For ASR models, peeks at ``config.json`` via ``AutoConfig`` to
        auto-detect multimodal LLMs (e.g. Gemma 4) vs traditional
        Whisper / Seq2Seq / CTC models.  No manual tags needed.

        Returns:
            (model, tokenizer, processor, feature_extractor, is_multimodal_lm)
        """
        import transformers

        AutoFeatureExtractor = getattr(transformers, "AutoFeatureExtractor", None)
        AutoModelForAudioClassification = transformers.AutoModelForAudioClassification
        AutoModelForCTC = transformers.AutoModelForCTC
        AutoModelForSpeechSeq2Seq = transformers.AutoModelForSpeechSeq2Seq
        AutoProcessor = transformers.AutoProcessor
        AutoTokenizer = transformers.AutoTokenizer
        GenerationConfig = transformers.GenerationConfig
        WhisperForConditionalGeneration = transformers.WhisperForConditionalGeneration
        WhisperProcessor = transformers.WhisperProcessor

        _has_accelerate = self._has_accelerate()
        _device_map_kwargs: dict[str, Any] = {"device_map": "auto"} if _has_accelerate else {}

        model = None
        tokenizer = None
        processor = None
        feature_extractor = None
        is_multimodal_lm = False

        common_kwargs: dict[str, Any] = {
            "cache_dir": cache_dir,
            "revision": revision,
            "token": token,
        }

        resolved_attn = self._resolve_attn_implementation(attn_implementation, device)

        if task_type == ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION:
            is_multimodal_lm = self._is_multimodal_lm(transformers, model_source, common_kwargs)

            logger.info(
                "ASR branch selection: model_source=%s, is_multimodal_lm=%s",
                model_source, is_multimodal_lm,
            )

            if is_multimodal_lm:
                AutoModelForMultimodalLM = getattr(
                    transformers, "AutoModelForMultimodalLM", None,
                )
                if AutoModelForMultimodalLM is None:
                    raise ModelLoadError(
                        f"Cannot load multimodal LLM '{model_source}': "
                        "AutoModelForMultimodalLM not available in transformers"
                    )
                try:
                    import torch as _torch
                    _use_device_map = _torch.cuda.is_available() and _has_accelerate
                    _multimodal_kwargs: dict[str, Any] = {"low_cpu_mem_usage": True}
                    if _use_device_map:
                        _multimodal_kwargs["device_map"] = "auto"
                    model = AutoModelForMultimodalLM.from_pretrained(
                        model_source,
                        dtype=torch_dtype,
                        **_multimodal_kwargs,
                        **common_kwargs,
                    )
                except Exception as err:
                    raise ModelLoadError(
                        f"Cannot load multimodal LLM '{model_source}'"
                    ) from err
            else:
                attn_kwargs: dict[str, Any] = {}
                if resolved_attn is not None:
                    attn_kwargs["attn_implementation"] = resolved_attn

                # Whisper -> Seq2Seq -> CTC chain
                try:
                    model = WhisperForConditionalGeneration.from_pretrained(
                        model_source,
                        dtype=torch_dtype,
                        **_device_map_kwargs,
                        **attn_kwargs,
                        **common_kwargs,
                    )
                    generation_config = GenerationConfig.from_pretrained(model_source, **common_kwargs)
                    model.generation_config = generation_config
                    processor = WhisperProcessor.from_pretrained(model_source, **common_kwargs)
                except Exception as whisper_err:
                    logger.debug("Whisper load failed: %s", whisper_err)
                    try:
                        model = AutoModelForSpeechSeq2Seq.from_pretrained(
                            model_source,
                            dtype=torch_dtype,
                            **_device_map_kwargs,
                            **attn_kwargs,
                            **common_kwargs,
                        )
                    except Exception as seq2seq_err:
                        logger.debug("Seq2Seq load failed: %s", seq2seq_err)
                        try:
                            model = AutoModelForCTC.from_pretrained(
                                model_source,
                                dtype=torch_dtype,
                                **_device_map_kwargs,
                                **common_kwargs,
                            )
                        except Exception as err:
                            raise ModelLoadError(
                                f"Cannot load ASR model '{model_source}': "
                                "not a Whisper, Seq2Seq, or CTC model"
                            ) from err

            # Load processor/tokenizer
            if processor is None:
                try:
                    processor = AutoProcessor.from_pretrained(model_source, **common_kwargs)
                except Exception as err:
                    if is_multimodal_lm:
                        raise ModelLoadError(
                            f"Multimodal LM '{model_source}' requires AutoProcessor "
                            f"but loading failed: {err}"
                        ) from err
                    tokenizer = AutoTokenizer.from_pretrained(model_source, **common_kwargs)
                    if AutoFeatureExtractor is None:
                        raise ImportError(
                            "AutoFeatureExtractor is unavailable in the installed "
                            "transformers package"
                        ) from err
                    feature_extractor = AutoFeatureExtractor.from_pretrained(
                        model_source, **common_kwargs
                    )

        elif task_type == ModelTaskType.VOICE_ACTIVITY_DETECTION:
            # VAD models (e.g., Silero VAD, pyannote)
            model = AutoModelForAudioClassification.from_pretrained(
                model_source,
                dtype=torch_dtype,
                **common_kwargs,
            )
            if AutoFeatureExtractor is None:
                raise ImportError(
                    "AutoFeatureExtractor is unavailable in the installed transformers package"
                )
            feature_extractor = AutoFeatureExtractor.from_pretrained(model_source, **common_kwargs)

        else:
            # Generic loading
            model = AutoModelForSpeechSeq2Seq.from_pretrained(
                model_source,
                dtype=torch_dtype,
                **_device_map_kwargs,
                **common_kwargs,
            )
            processor = AutoProcessor.from_pretrained(model_source, **common_kwargs)

        if model is not None and not is_multimodal_lm:
            if task_type == ModelTaskType.VOICE_ACTIVITY_DETECTION or not _has_accelerate:
                model = model.to(device)

        return model, tokenizer, processor, feature_extractor, is_multimodal_lm

    @staticmethod
    def _has_accelerate() -> bool:
        """Check if the ``accelerate`` package is available."""
        try:
            import accelerate  # noqa: F401
            return True
        except ImportError:
            return False

    @staticmethod
    def _resolve_attn_implementation(
        requested: str | None,
        device: str,
    ) -> str | None:
        """Resolve attention implementation, validating hardware compatibility.

        Flash Attention 2 requires CUDA and the ``flash-attn`` package.
        Falls back to ``sdpa`` when flash-attn is unavailable.
        Returns None (let transformers decide) when no override is specified.
        """
        if requested is None:
            return None

        valid = {"flash_attention_2", "sdpa", "eager"}
        if requested not in valid:
            logger.warning(
                "Unknown attn_implementation '%s', ignoring. Valid: %s",
                requested,
                valid,
            )
            return None

        if requested == "flash_attention_2":
            if not device.startswith("cuda"):
                logger.warning(
                    "flash_attention_2 requires CUDA but device is '%s' "
                    "-- falling back to sdpa",
                    device,
                )
                return "sdpa"

            try:
                import flash_attn  # noqa: F401

                logger.info(
                    "Flash Attention 2 available (flash-attn %s)",
                    getattr(flash_attn, "__version__", "unknown"),
                )
                return "flash_attention_2"
            except ImportError:
                logger.warning(
                    "flash_attention_2 requested but flash-attn package is not installed "
                    "-- falling back to sdpa. Install with: pip install flash-attn --no-build-isolation"
                )
                return "sdpa"

        return requested

    @staticmethod
    def _is_multimodal_lm(
        transformers_module: Any,
        model_source: str,
        common_kwargs: dict[str, Any],
    ) -> bool:
        """Auto-detect whether *model_source* is a multimodal LLM.

        Reads ``config.json`` via ``AutoConfig`` and checks whether any
        entry in the ``architectures`` list contains ``MultimodalLM``.
        """
        AutoConfig = getattr(transformers_module, "AutoConfig", None)
        if AutoConfig is None:
            return False
        try:
            config = AutoConfig.from_pretrained(model_source, **common_kwargs)
            model_type = getattr(config, "model_type", None)
            architectures: list[str] = getattr(config, "architectures", None) or []
            has_multimodal_arch = any("MultimodalLM" in arch for arch in architectures)
            has_gemma4_conditional_arch = any(
                arch == "Gemma4ForConditionalGeneration" for arch in architectures
            )
            has_audio_config = getattr(config, "audio_config", None) is not None
            result = has_multimodal_arch or (
                model_type == "gemma4"
                and has_gemma4_conditional_arch
                and has_audio_config
            )
            logger.info(
                "_is_multimodal_lm detection: model_source=%s, model_type=%s, "
                "architectures=%s, has_audio_config=%s, result=%s",
                model_source, model_type, architectures, has_audio_config, result,
            )
            return result
        except Exception as exc:
            logger.warning(
                "Failed to auto-detect multimodal LLM: model_source=%s, error=%s",
                model_source, exc,
            )
            return False

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
