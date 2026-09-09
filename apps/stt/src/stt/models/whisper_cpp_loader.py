"""whisper.cpp model loader — ggml runtime for GGUF whisper-large-v3-turbo
(engine WHISPER_CPP).

Unlike ``parakeet_cpp`` (no official Python bindings), whisper.cpp has a
maintained, wheel-distributed binding — ``pywhispercpp`` (prebuilt manylinux +
macOS wheels, no torch dependency). This loader therefore imports it directly
(lazily, so the module stays import-cheap without the package installed),
following the same lazy-import-with-install-hint pattern as
``faster_whisper_loader.py`` rather than the ctypes-fallback pattern in
``parakeet_cpp_loader.py``.

``pywhispercpp.model.Model`` only auto-downloads its own catalog of official
ggml model names — a custom GGUF repo (e.g. ``oxide-lab/whisper-large-v3-turbo-GGUF``)
must be materialised locally first and the resulting ``.gguf`` file path handed
to ``Model(model=<path>)``. That fetch moved into the shared
``source_resolver`` (``local_path`` override, then ``hf:`` / ``file://`` /
``s3://`` dispatch); this module keeps only the ``.gguf`` selection tail.
"""

from __future__ import annotations

import asyncio
import glob
import logging
import os
from datetime import UTC, datetime

from ..core.config.settings import get_settings
from ..core.exceptions import ModelLoadError
from ..pipeline.dto import AiModelConfig, AiModelFormat
from .base_loader import BaseModelLoader, CredentialPosture, LoadedModel
from .source_resolver import ModelSourceError, resolve_for_model_config

logger = logging.getLogger(__name__)

_INSTALL_HINT = (
    "whisper.cpp runtime unavailable: install a 'pywhispercpp' Python "
    "binding. Install with: pip install 'pywhispercpp>=1.5.0'"
)


class WhisperCppLoader(BaseModelLoader):
    """Loader for whisper.cpp (ggml) ASR models, via ``pywhispercpp``."""

    # Runs on platform hardware from local/downloaded weights - no vendor
    # credential exists to fail closed on. Declared explicitly because the lock
    # test is default-deny: a loader that says nothing fails it.
    credential_posture = CredentialPosture.SELF_HOSTED

    @property
    def supported_formats(self) -> list[AiModelFormat]:
        return [AiModelFormat.WHISPER_CPP]

    async def load(self, model_config: AiModelConfig) -> LoadedModel:
        try:
            from pywhispercpp.model import Model
        except ImportError as e:
            raise ModelLoadError(_INSTALL_HINT) from e

        settings = get_settings()

        # The one resolver contract supplies the weights directory
        # (local_path override -> hf: / file:// / s3://); the `.gguf` selection
        # tail below is whisper.cpp-specific and stays here.
        try:
            resolved = str(await resolve_for_model_config(model_config, settings))
        except ModelSourceError as exc:
            raise ModelLoadError(
                f"Failed to resolve whisper.cpp weights for '{model_config.slug}': {exc}"
            ) from exc

        gguf_path = resolved
        if os.path.isdir(resolved):
            gguf_path = await asyncio.to_thread(self._select_gguf_file, resolved, model_config)

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

        # pywhispercpp does NOT raise when whisper.cpp fails to load the weights
        # (e.g. a non-whisper.cpp GGUF -> "invalid model data (bad magic)"): it
        # returns a handle whose `_ctx` is null. Caching that dead handle lets the
        # first transcribe segfault the whole process, so reject it here.
        if getattr(handle, "_ctx", None) is None:
            raise ModelLoadError(
                f"whisper.cpp failed to load model '{model_config.slug}' from "
                f"'{gguf_path}' (null context — the file is not a whisper.cpp GGUF, "
                f"e.g. a generic/transformers GGUF conversion). Point at a "
                f"whisper.cpp-format .gguf."
            )

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
                # The row's own quantisation (TASK-934): the engine binding log
                # reads it so it reports the weights that actually loaded.
                "compute_type": model_config.compute_type,
            },
        )

    @staticmethod
    def _select_gguf_file(repo_dir: str, model_config: AiModelConfig) -> str:
        """Pick the ggml weights file inside an already-resolved weights directory.

        Accepts both extensions whisper.cpp ships ggml weights under: the modern
        ``.gguf`` and the classic ``ggml-*.bin`` naming (e.g.
        ``ggml-whisper-turbo-…-q8_0.bin``) — pywhispercpp loads either by path.
        Requires a filename containing the configured quantization (e.g.
        ``q8_0``) when one is set — selection is ``failMode: closed`` (see
        claude/rules/09-infrastructure-devops.md Tiers): a
        registry row declaring ``q8_0`` must never silently load an ``f16`` (or
        any other) file just because it happened to be first alphabetically.
        Fetching is the resolver's job; this is only the selection tail.
        """
        candidates = sorted(
            c
            for ext in ("*.gguf", "*.bin")
            for c in glob.glob(os.path.join(repo_dir, "**", ext), recursive=True)
            # Skip macOS AppleDouble sidecars ("._name.bin") that shadow real
            # weights on some filesystems — they are tiny metadata forks, not models.
            if not os.path.basename(c).startswith("._")
        )
        if not candidates:
            raise ModelLoadError(
                f"No .gguf/.bin ggml file found for whisper.cpp model '{model_config.slug}' "
                f"(source_uri={model_config.source_uri!r}, dir={repo_dir})"
            )

        # Some GGUF repos (e.g. oxide-lab/whisper-large-v3-turbo-GGUF) ship BOTH a
        # top-level generic GGUF conversion AND the whisper.cpp-format weights in
        # a `whisper.cpp/` subdirectory. Only the latter load in the ggml runtime
        # — the top-level files fail whisper.cpp's magic check ("invalid model
        # data (bad magic)") and segfault pywhispercpp at transcribe time. When
        # that subdirectory exists, select from it exclusively.
        whisper_cpp_dir = f"{os.sep}whisper.cpp{os.sep}"
        subfolder = [c for c in candidates if whisper_cpp_dir in c]
        if subfolder:
            candidates = subfolder

        quant = (model_config.compute_type or "").lower()
        if quant:
            matching = [c for c in candidates if quant in os.path.basename(c).lower()]
            if matching:
                return matching[0]
            seen = ", ".join(os.path.basename(c) for c in candidates)
            raise ModelLoadError(
                f"No ggml weights matching requested quantization {quant!r} for "
                f"whisper.cpp model '{model_config.slug}' (dir={repo_dir}); "
                f"candidates seen: {seen}"
            )

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
