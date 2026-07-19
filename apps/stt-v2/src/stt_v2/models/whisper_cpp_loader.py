"""whisper.cpp model loader — ggml runtime for GGUF whisper-large-v3-turbo
(TASK-507, engine WHISPER_CPP).

Unlike ``parakeet_cpp`` (no official Python bindings), whisper.cpp has a
maintained, wheel-distributed binding — ``pywhispercpp`` (prebuilt manylinux +
macOS wheels, no torch dependency). This loader therefore imports it directly
(lazily, so the module stays import-cheap without the package installed),
following the same lazy-import-with-install-hint pattern as
``faster_whisper_loader.py`` rather than the ctypes-fallback pattern in
``parakeet_cpp_loader.py``.

``pywhispercpp.model.Model`` only auto-downloads its own catalog of official
ggml model names — a custom GGUF repo (e.g. ``oxide-lab/whisper-large-v3-turbo-GGUF``)
must be fetched via ``huggingface_hub`` first and the resulting local ``.gguf``
file path handed to ``Model(model=<path>)``.
"""

from __future__ import annotations

import asyncio
import glob
import logging
import os
from datetime import UTC, datetime

from ..core.config.settings import Settings, get_settings
from ..core.exceptions import ModelLoadError
from ..pipeline.dto import AiModelConfig, AiModelFormat
from .base_loader import BaseModelLoader, LoadedModel

logger = logging.getLogger(__name__)

_INSTALL_HINT = (
    "whisper.cpp runtime unavailable: install a 'pywhispercpp' Python "
    "binding. Install with: pip install 'pywhispercpp>=1.5.0'"
)


class WhisperCppLoader(BaseModelLoader):
    """Loader for whisper.cpp (ggml) ASR models, via ``pywhispercpp``."""

    @property
    def supported_formats(self) -> list[AiModelFormat]:
        return [AiModelFormat.WHISPER_CPP]

    async def load(self, model_config: AiModelConfig) -> LoadedModel:
        try:
            from pywhispercpp.model import Model
        except ImportError as e:
            raise ModelLoadError(_INSTALL_HINT) from e

        settings = get_settings()

        gguf_path = model_config.local_path
        if not gguf_path or not os.path.exists(gguf_path):
            gguf_path = await asyncio.to_thread(
                self._fetch_gguf_file, model_config, settings
            )

        use_gpu = (model_config.device or "auto") != "cpu"
        num_threads = settings.whisper_cpp_num_threads

        try:
            handle = await asyncio.to_thread(
                Model,
                model=gguf_path,
                n_threads=num_threads,
                context_params={"use_gpu": use_gpu},
                print_progress=False,
                print_realtime=False,
            )
        except Exception as exc:
            raise ModelLoadError(
                f"Failed to initialize whisper.cpp model '{model_config.slug}' "
                f"from '{gguf_path}': {exc}"
            ) from exc

        return LoadedModel(
            model_id=model_config.id,
            model_slug=model_config.slug,
            model=handle,
            format=AiModelFormat.WHISPER_CPP,
            memory_mb=self.estimate_memory(model_config),
            device="cpu" if not use_gpu else "auto",
            loaded_at=datetime.now(UTC),
            extra={
                "provider": "whisper_cpp",
                "model_path": gguf_path,
                "num_threads": num_threads,
            },
        )

    @staticmethod
    def _fetch_gguf_file(model_config: AiModelConfig, settings: Settings) -> str:
        """Download the HF repo and return the path to its ``.gguf`` file.

        Prefers a filename containing the configured quantization (e.g.
        ``q8_0``) when the repo ships more than one quantized variant.
        """
        try:
            from huggingface_hub import snapshot_download

            repo_dir = snapshot_download(
                repo_id=model_config.source_uri,
                revision=model_config.source_revision or "main",
                cache_dir=settings.huggingface_cache_dir,
                token=settings.huggingface_token,
            )
        except Exception as exc:
            raise ModelLoadError(
                f"Failed to fetch whisper.cpp weights '{model_config.source_uri}': {exc}"
            ) from exc

        candidates = sorted(glob.glob(os.path.join(repo_dir, "**", "*.gguf"), recursive=True))
        if not candidates:
            raise ModelLoadError(
                f"No .gguf file found in downloaded repo '{model_config.source_uri}' "
                f"(dir={repo_dir})"
            )

        quant = (model_config.compute_type or "").lower()
        if quant:
            matching = [c for c in candidates if quant in os.path.basename(c).lower()]
            if matching:
                return matching[0]

        return candidates[0]

    async def unload(self, loaded_model: LoadedModel) -> None:
        try:
            import gc

            from .base_loader import cleanup_accelerator_memory

            if loaded_model.model is not None:
                del loaded_model.model

            gc.collect()
            cleanup_accelerator_memory()

            logger.info("Unloaded whisper.cpp model %s", loaded_model.model_slug)
        except Exception as e:
            logger.warning("Error during whisper.cpp model unload: %s", e)

    def estimate_memory(self, model_config: AiModelConfig) -> int:
        if model_config.memory_size_mb:
            return model_config.memory_size_mb
        if model_config.file_size_mb:
            return int(model_config.file_size_mb * 1.2)
        return 800
