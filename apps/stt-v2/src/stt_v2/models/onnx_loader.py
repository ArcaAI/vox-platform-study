"""ONNX model loader for optimized inference."""

import logging
import os
from pathlib import Path
from typing import Any

from ..core.config.settings import get_settings
from ..core.exceptions import ModelLoadError
from ..pipeline.dto import AiModelConfig, AiModelFormat
from .base_loader import BaseModelLoader, LoadedModel
from .source_resolver import resolve_weights_or_hf_id

logger = logging.getLogger(__name__)


class ONNXLoader(BaseModelLoader):
    """Load ONNX models for optimized inference using onnxruntime."""

    @property
    def supported_formats(self) -> list[AiModelFormat]:
        return [AiModelFormat.ONNX, AiModelFormat.ONNX_OPTIMUM]

    @staticmethod
    def _resolve_num_threads() -> int:
        """Resolve ONNX Runtime intra_op thread count from settings.

        Per ONNX Runtime docs, 0 means auto-size to physical CPU core count.
        This is the recommended default.

        Returns:
            Thread count: from settings if > 0, otherwise 0 (auto).
        """
        settings = get_settings()
        configured = settings.onnx_num_threads
        if configured > 0:
            return configured

        # 0 = let ONNX Runtime auto-size to physical core count.
        # This is the official recommended default.
        return 0

    async def load(self, model_config: AiModelConfig) -> LoadedModel:
        """
        Load ONNX model using onnxruntime or optimum.

        Supports:
        - Local ONNX files (when local_path is set)
        - HuggingFace Optimum ONNX models (downloaded automatically)
        - ONNX-community models from HuggingFace

        Args:
            model_config: Model configuration

        Returns:
            LoadedModel with ONNX InferenceSession or Optimum pipeline
        """
        # Check if this is a HuggingFace model that needs Optimum
        if self._should_use_optimum(model_config):
            return await self._load_with_optimum(model_config)

        # Otherwise use standard ONNX Runtime loading
        return await self._load_with_onnxruntime(model_config)

    async def _load_with_onnxruntime(self, model_config: AiModelConfig) -> LoadedModel:
        """Load model using standard ONNX Runtime."""
        try:
            import onnxruntime as ort

            # TASK-527 — local_path (operator override) and the file:// / s3://
            # schemes are materialised by the shared resolver; a bare HuggingFace
            # id still goes through `_download_onnx_model`, whose `allow_patterns`
            # selective fetch saves tens of GB over a full snapshot.
            model_path = await resolve_weights_or_hf_id(model_config, get_settings())
            if not model_path:
                raise ModelLoadError(
                    f"ONNX model {model_config.slug} has no local path. "
                    "ONNX models must be downloaded first."
                )
            if not Path(model_path).exists():
                model_path = await self._download_onnx_model(model_config)

            model_path_obj = Path(model_path)
            if model_path_obj.is_dir():
                resolved_model_file = self._resolve_onnx_model_file(model_path_obj)
                if resolved_model_file is None:
                    raise ModelLoadError(f"No ONNX model file found in directory: {model_path}")
                model_path = str(resolved_model_file)
                model_path_obj = resolved_model_file

            if not model_path_obj.exists():
                raise ModelLoadError(f"ONNX model file not found: {model_path}")

            logger.info(f"Loading ONNX model from: {model_path}")

            # Configure execution providers
            providers = self._get_providers()

            # Session options for optimization
            num_threads = self._resolve_num_threads()

            session_options = ort.SessionOptions()
            session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            session_options.intra_op_num_threads = num_threads
            # inter_op_num_threads only matters with ORT_PARALLEL execution mode.
            # Whisper is sequential, so leave at default (1).

            logger.debug(
                "ONNX session options: intra_op_num_threads=%d (0=auto), "
                "graph_optimization=ORT_ENABLE_ALL",
                num_threads,
            )

            # Create inference session
            session = ort.InferenceSession(
                model_path,
                sess_options=session_options,
                providers=providers,
            )

            # Determine device from active provider
            device = self._determine_device(session)

            # Estimate memory
            memory_mb = self._estimate_session_memory(session, model_path)

            logger.info(
                f"Loaded ONNX model {model_config.slug} "
                f"(providers={session.get_providers()}, memory=~{memory_mb}MB)"
            )

            return LoadedModel(
                model_id=model_config.id,
                model_slug=model_config.slug,
                model=session,
                tokenizer=None,
                processor=None,
                feature_extractor=None,
                format=AiModelFormat.ONNX,
                memory_mb=memory_mb,
                device=device,
                extra={
                    "model_path": model_path,
                    "providers": session.get_providers(),
                    "input_names": [i.name for i in session.get_inputs()],
                    "output_names": [o.name for o in session.get_outputs()],
                },
            )

        except ImportError as e:
            raise ModelLoadError(
                "onnxruntime not installed. Install with: pip install onnxruntime-gpu"
            ) from e
        except Exception as e:
            raise ModelLoadError(f"Failed to load ONNX model {model_config.slug}: {e}") from e

    async def unload(self, loaded_model: LoadedModel) -> None:
        """Unload ONNX model from memory."""
        try:
            import gc

            from .base_loader import cleanup_accelerator_memory

            # ONNX sessions don't have explicit cleanup
            if loaded_model.model is not None:
                del loaded_model.model

            gc.collect()

            # Release GPU/accelerator memory (CUDA, MPS, etc.)
            cleanup_accelerator_memory()

            logger.info(f"Unloaded ONNX model {loaded_model.model_slug}")

        except Exception as e:
            logger.warning(f"Error during ONNX model unload: {e}")

    def estimate_memory(self, model_config: AiModelConfig) -> int:
        """Estimate memory requirements."""
        # Use stored file size as approximation
        if model_config.file_size_mb:
            # ONNX models typically use similar memory to file size
            # Add ~20% overhead for runtime
            return int(model_config.file_size_mb * 1.2)

        if model_config.memory_size_mb:
            return model_config.memory_size_mb

        # Default estimate
        return 500

    def _get_providers(self) -> list[str]:
        """Get ONNX execution providers in order of preference."""
        try:
            import onnxruntime as ort

            available = ort.get_available_providers()
            logger.debug(f"Available ONNX providers: {available}")

            providers: list[str] = []

            if "CUDAExecutionProvider" in available:
                providers.append("CUDAExecutionProvider")

            # Always include CPU as fallback
            providers.append("CPUExecutionProvider")
            return providers

        except Exception:
            return ["CPUExecutionProvider"]

    def _determine_device(self, session: Any) -> str:
        """Determine actual device from session providers."""
        providers = session.get_providers()
        if "CUDAExecutionProvider" in providers:
            return "cuda"
        return "cpu"

    def _estimate_session_memory(self, session: Any, model_path: str) -> int:
        """Estimate memory usage of ONNX session."""
        try:
            # Use file size as base estimate
            file_size_bytes = os.path.getsize(model_path)
            file_size_mb = file_size_bytes / (1024 * 1024)

            # Add overhead for runtime buffers
            return int(file_size_mb * 1.3)

        except Exception:
            return 500  # Default estimate

    def _should_use_optimum(self, model_config: AiModelConfig) -> bool:
        """
        Check if model should be loaded with HuggingFace Optimum.

        Returns True for:
        - Models with ONNX_OPTIMUM format
        - ASR ONNX models from onnx-community
        - ASR ONNX models whose source contains "whisper"

        Non-ASR ONNX models (for example VAD) should stay on plain
        ONNX Runtime because Optimum's speech-seq2seq loader only supports
        transformer-style speech generation models.
        """
        if model_config.format == AiModelFormat.ONNX_OPTIMUM:
            return True

        # Auto-detection only applies to standard ONNX models.
        if model_config.format != AiModelFormat.ONNX:
            return False

        # Restrict Optimum routing to ASR models.
        if not model_config.is_asr:
            return False

        source_uri = model_config.source_uri.lower()

        # ONNX-community ASR models are expected to follow Optimum layout.
        if "onnx-community" in source_uri:
            return True

        # Whisper ONNX models should use Optimum.
        if "whisper" in source_uri:
            return True

        return False

    async def _download_onnx_model(self, model_config: AiModelConfig) -> str:
        """
        Download ONNX model from HuggingFace Hub.

        When a quantization variant is specified, only the relevant ONNX files
        are downloaded (encoder + decoder for that variant) rather than every
        variant in the repo, which can save tens of GB of bandwidth.

        Args:
            model_config: Model configuration with source_uri

        Returns:
            Path to downloaded model directory or file
        """
        try:
            from huggingface_hub import snapshot_download

            settings = get_settings()
            cache_dir = settings.huggingface_cache_dir
            os.makedirs(cache_dir, exist_ok=True)

            model_id = model_config.source_uri
            revision = model_config.source_revision or "main"
            subfolder = self._resolve_subfolder(model_config)
            quantization = model_config.quantization

            logger.info(
                f"Downloading ONNX model from HuggingFace: {model_id} "
                f"(subfolder={subfolder!r}, quantization={quantization or 'default'})"
            )

            # Build allow_patterns to download only the needed files
            # Always download config/tokenizer/preprocessor files at root
            allow_patterns: list[str] = [
                "*.json",
                "*.txt",
                "config.*",
                "merges.txt",
                "vocab.json",
            ]

            # Determine ONNX file patterns based on quantization
            onnx_prefix = f"{subfolder}/" if subfolder else ""
            if quantization:
                suffix = f"_{quantization}"
                allow_patterns.extend(
                    [
                        f"{onnx_prefix}encoder_model{suffix}.onnx",
                        f"{onnx_prefix}encoder_model{suffix}.onnx_data",
                        f"{onnx_prefix}decoder_model_merged{suffix}.onnx",
                        f"{onnx_prefix}decoder_model_merged{suffix}.onnx_data",
                    ]
                )
            else:
                # Default: download base ONNX files (not quantized variants)
                allow_patterns.extend(
                    [
                        f"{onnx_prefix}encoder_model.onnx",
                        f"{onnx_prefix}encoder_model.onnx_data",
                        f"{onnx_prefix}decoder_model_merged.onnx",
                        f"{onnx_prefix}decoder_model_merged.onnx_data",
                        f"{onnx_prefix}decoder_model.onnx",
                        f"{onnx_prefix}decoder_with_past_model.onnx",
                        f"{onnx_prefix}model.onnx",
                        f"{onnx_prefix}model.onnx_data",
                    ]
                )

            local_path = snapshot_download(
                repo_id=model_id,
                revision=revision,
                cache_dir=cache_dir,
                allow_patterns=allow_patterns,
            )

            logger.info(f"Downloaded ONNX model to: {local_path}")
            return local_path

        except ImportError:
            raise ModelLoadError(
                "huggingface_hub not installed. Install with: pip install huggingface_hub"
            ) from None
        except Exception as e:
            raise ModelLoadError(f"Failed to download ONNX model: {e}") from e

    def _resolve_subfolder(self, model_config: AiModelConfig) -> str:
        """
        Resolve the subfolder for ONNX model files within a HuggingFace repo.

        onnx-community models store ONNX files in an 'onnx/' subfolder by
        convention.  If the pipeline config explicitly sets ``subfolder``,
        that value is used; otherwise we auto-detect for onnx-community
        repos.

        Returns:
            Subfolder path (e.g. "onnx") or empty string if none needed.
        """
        if model_config.subfolder:
            return model_config.subfolder

        # Auto-detect for onnx-community repos
        source = model_config.source_uri.lower()
        if "onnx-community" in source:
            return "onnx"

        return ""

    @staticmethod
    def _resolve_onnx_model_file(model_path: Path) -> Path | None:
        """Resolve a concrete ONNX file when the given path is a directory."""
        preferred_candidates = [
            model_path / "onnx" / "model.onnx",
            model_path / "model.onnx",
        ]
        for candidate in preferred_candidates:
            if candidate.is_file():
                return candidate

        top_level_onnx = sorted(model_path.glob("*.onnx"))
        if len(top_level_onnx) == 1:
            return top_level_onnx[0]

        nested_model_files = sorted(model_path.rglob("model.onnx"))
        if len(nested_model_files) == 1:
            return nested_model_files[0]

        return None

    @staticmethod
    def _resolve_quantized_file_names(
        quantization: str | None,
    ) -> dict[str, str]:
        """
        Build ``from_pretrained`` kwargs that select a specific quantized
        ONNX variant.

        For Whisper models the ONNX-community convention is:
            encoder_model{_suffix}.onnx
            decoder_model_merged{_suffix}.onnx

        If *quantization* is ``None`` the default (fp32) files are used
        and no extra kwargs are returned.

        **Important**: When ``decoder_file_name`` is provided, Optimum
        enters a non-merged code path that also tries to find a separate
        ``decoder_with_past_model.onnx``.  Since onnx-community repos
        only ship *merged* decoders, we must also pass
        ``decoder_with_past_file_name`` pointing to the same merged file
        so Optimum can resolve both roles from a single ONNX file.

        Returns:
            Dict of keyword arguments to pass to
            ``ORTModelForSpeechSeq2Seq.from_pretrained()``.
        """
        if not quantization:
            return {}

        suffix = f"_{quantization}"
        merged_decoder = f"decoder_model_merged{suffix}.onnx"
        return {
            "encoder_file_name": f"encoder_model{suffix}.onnx",
            "decoder_file_name": merged_decoder,
            "decoder_with_past_file_name": merged_decoder,
        }

    async def _load_with_optimum(self, model_config: AiModelConfig) -> LoadedModel:
        """
        Load model using HuggingFace Optimum for ONNX.

        Supports:
        - onnx-community models with files in an ``onnx/`` subfolder
        - Quantized variants (fp16, int8, q4, q4f16, bnb4, etc.)
        - Merged decoder model (``use_merged=True``) for lower memory
        """
        try:
            from optimum.onnxruntime import ORTModelForSpeechSeq2Seq
            from transformers import AutoProcessor, AutoTokenizer, GenerationConfig

            settings = get_settings()
            cache_dir = settings.huggingface_cache_dir
            os.makedirs(cache_dir, exist_ok=True)

            model_id = model_config.source_uri
            revision = model_config.source_revision or "main"

            # Resolve subfolder (auto-detect for onnx-community repos)
            subfolder = self._resolve_subfolder(model_config)

            # Resolve quantized file names (returns empty dict for default fp32)
            quantization = model_config.quantization
            quant_kwargs = self._resolve_quantized_file_names(quantization)

            quant_label = quantization or "default (fp32)"
            logger.info(
                f"Loading ONNX model with Optimum: {model_id} "
                f"(subfolder={subfolder!r}, quantization={quant_label})"
            )

            # Determine device and provider.
            # Device is always auto-detected from hardware; compute_type only affects dtype
            requested_device = self._get_device("auto")
            if requested_device == "cuda":
                provider = "CUDAExecutionProvider"
                device = "cuda"
            else:
                provider = "CPUExecutionProvider"
                device = "cpu"

            # Build session options — disable high-level graph optimizations
            # for fp16 models on CPU to avoid unsupported
            # SimplifiedLayerNormFusion nodes.
            import onnxruntime as ort

            session_options = ort.SessionOptions()

            if quantization == "fp16" and device != "cuda":
                logger.warning(
                    "fp16 quantization on CPU requires reduced graph optimization "
                    "(SimplifiedLayerNormFusion lacks fp16 CPU kernels). "
                    "Consider using q4 or int8 for CPU inference instead."
                )
                session_options.graph_optimization_level = (
                    ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
                )
            else:
                session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

            # Pre-load generation config from repo root.
            # When a subfolder is specified (e.g. "onnx"), Optimum looks for
            # generation_config.json inside that subfolder.  onnx-community
            # repos only store it at the repo root, so we must load it
            # explicitly and pass it in — otherwise Whisper timestamps
            # (no_timestamps_token_id) won't be available.
            generation_config = None
            if subfolder:
                try:
                    generation_config = GenerationConfig.from_pretrained(
                        model_id,
                        revision=revision,
                        cache_dir=cache_dir,
                    )
                    logger.debug(f"Loaded generation_config from repo root for {model_id}")
                except Exception as gc_err:
                    logger.debug(f"Could not load generation_config from root: {gc_err}")

            # Load the model with Optimum
            from_pretrained_kwargs: dict[str, Any] = {
                "subfolder": subfolder,
                "revision": revision,
                "cache_dir": cache_dir,
                "use_merged": True,
                "provider": provider,
                "session_options": session_options,
                **quant_kwargs,
            }
            if generation_config is not None:
                from_pretrained_kwargs["generation_config"] = generation_config

            model = ORTModelForSpeechSeq2Seq.from_pretrained(
                model_id,
                **from_pretrained_kwargs,
            )

            # Load processor (processor config is at repo root, not in subfolder)
            try:
                processor = AutoProcessor.from_pretrained(
                    model_id,
                    revision=revision,
                    cache_dir=cache_dir,
                )
            except Exception:
                # Fall back to tokenizer for some models
                processor = AutoTokenizer.from_pretrained(
                    model_id,
                    revision=revision,
                    cache_dir=cache_dir,
                )

            # Estimate memory
            memory_mb = self.estimate_memory(model_config)

            logger.info(
                f"Loaded ONNX model {model_config.slug} with Optimum "
                f"(device={device}, quantization={quant_label}, memory=~{memory_mb}MB)"
            )

            return LoadedModel(
                model_id=model_config.id,
                model_slug=model_config.slug,
                model=model,
                tokenizer=None,
                processor=processor,
                feature_extractor=None,
                format=AiModelFormat.ONNX_OPTIMUM,
                memory_mb=memory_mb,
                device=device,
                extra={
                    "source_uri": model_id,
                    "revision": revision,
                    "subfolder": subfolder,
                    "quantization": quantization,
                    "optimum": True,
                },
            )

        except ImportError as e:
            # Fall back to standard ONNX Runtime if Optimum not available
            logger.warning(f"Optimum not available, falling back to ONNX Runtime: {e}")
            return await self._load_with_onnxruntime(model_config)
        except Exception as e:
            raise ModelLoadError(f"Failed to load ONNX model with Optimum: {e}") from e
