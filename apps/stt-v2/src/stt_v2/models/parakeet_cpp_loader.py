"""parakeet.cpp loader — ggml runtime for NVIDIA Parakeet/Nemotron ASR
(TASK-505 P3, engine PARAKEET_CPP).

Upstream (``mudler/parakeet.cpp``, MIT) ships a C API (``libparakeet``) and a
CLI — **no official Python bindings** as of 2026-07. This loader therefore
resolves the binding lazily, in priority order:

1. a ``parakeet_cpp`` Python module (vendored/third-party binding, if one is
   installed in the environment), or
2. a ``ctypes`` handle on the shared library at
   ``settings.parakeet_cpp_library_path`` — in which case ``model`` carries
   the raw ``(library, model_path)`` pair for the adapter to drive.

Model weights are GGUF conversions fetched via ``huggingface_hub`` (same
snapshot pattern as the ONNX loader). Supported quantizations mirror
upstream: F32/F16/Q8_0/Q6_K/Q5_K/Q4_K.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from ..core.config.settings import get_settings
from ..core.exceptions import ModelLoadError
from ..pipeline.dto import AiModelConfig, AiModelFormat
from .base_loader import BaseModelLoader, LoadedModel

logger = logging.getLogger(__name__)

# ggml quantization variants accepted for PARAKEET_CPP models.
VALID_PARAKEET_CPP_QUANTIZATIONS: list[str] = [
    "f32",
    "f16",
    "q8_0",
    "q6_k",
    "q5_k",
    "q4_k",
]


class ParakeetCppLoader(BaseModelLoader):
    """Loader for parakeet.cpp (ggml) ASR models."""

    @property
    def supported_formats(self) -> list[AiModelFormat]:
        return [AiModelFormat.PARAKEET_CPP]

    async def load(self, model_config: AiModelConfig) -> LoadedModel:
        import asyncio

        settings = get_settings()

        # 1) Fetch (or locate) the GGUF weights.
        model_path = model_config.local_path
        if not model_path:
            try:
                from huggingface_hub import snapshot_download

                model_path = await asyncio.to_thread(
                    snapshot_download,
                    repo_id=model_config.source_uri,
                    revision=model_config.source_revision or "main",
                    cache_dir=settings.huggingface_cache_dir,
                    token=settings.huggingface_token,
                )
            except Exception as exc:
                raise ModelLoadError(
                    f"Failed to fetch parakeet.cpp weights '{model_config.source_uri}': {exc}"
                ) from exc

        # 2) Resolve the runtime binding (lazy — never at module import).
        handle = await asyncio.to_thread(self._resolve_binding, model_path)

        return LoadedModel(
            model_id=model_config.id,
            model_slug=model_config.slug,
            model=handle,
            format=AiModelFormat.PARAKEET_CPP,
            memory_mb=model_config.memory_size_mb or 800,
            device=model_config.device or "auto",
            loaded_at=datetime.now(UTC),
            extra={
                "provider": "parakeet_cpp",
                "model_path": model_path,
                "num_threads": settings.parakeet_cpp_num_threads,
            },
        )

    @staticmethod
    def _resolve_binding(model_path: str) -> Any:  # binding is duck-typed
        """Import a Python binding, else open the shared library via ctypes."""
        try:
            import parakeet_cpp  # type: ignore[import-not-found]

            return parakeet_cpp.Model(model_path)
        except ImportError:
            pass

        # TASK-505 review — a raw ctypes CDLL handle is NOT drivable by the
        # adapter (it needs a binding exposing transcribe()); returning one
        # "succeeded" at load and only failed later at session build. Fail
        # HERE, at load time, with the actionable message instead.
        settings = get_settings()
        lib_path = settings.parakeet_cpp_library_path
        raise ModelLoadError(
            "parakeet.cpp runtime unavailable: install a 'parakeet_cpp' "
            "Python binding module exposing transcribe(). "
            + (
                f"(PARAKEET_CPP_LIBRARY_PATH={lib_path} is set, but the raw "
                "C library needs a Python shim — see "
                "infrastructure/docker/python-base for the build recipe.)"
                if lib_path
                else "(See infrastructure/docker/python-base for the build recipe.)"
            )
        )

    async def unload(self, loaded_model: LoadedModel) -> None:
        # Binding objects release with GC; ctypes handles hold no GPU state here.
        return None

    def estimate_memory(self, model_config: AiModelConfig) -> int:
        return model_config.memory_size_mb or 800
