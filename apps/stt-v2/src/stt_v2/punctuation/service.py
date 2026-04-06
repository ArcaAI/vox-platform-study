"""Punctuation restoration service using cadence-punctuation.

Provides a model registry that holds one or more PunctuationModel instances
keyed by model name.  The default model (from settings) is loaded at
application startup; pipeline-specific overrides are lazy-loaded on first use.
Whether punctuation is applied is controlled per-pipeline via YAML config.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any

import structlog

from stt_v2.core.config.settings import get_settings

logger = structlog.get_logger(__name__)

_models: dict[str, Any] = {}
_default_model_name: str | None = None
_lock = threading.Lock()


def _load_model(model_name: str) -> Any:
    """Load a PunctuationModel by name (not thread-safe -- caller must hold _lock)."""
    from cadence import PunctuationModel

    settings = get_settings()
    use_cpu = settings.punctuation_device == "cpu"
    gpu_id = None
    if not use_cpu and settings.punctuation_device not in ("cpu", "auto"):
        gpu_id = int(settings.punctuation_device.replace("cuda:", "").replace("cuda", "0"))

    logger.info(
        "Loading punctuation model",
        model=model_name,
        device=settings.punctuation_device,
        max_length=settings.punctuation_max_length,
    )

    model = PunctuationModel(
        model=model_name,
        model_path=settings.punctuation_model_cache_dir,
        cpu=use_cpu,
        gpu_id=gpu_id,
        max_length=settings.punctuation_max_length,
        sliding_window=True,
        d_type="bfloat16",
    )

    # Cadence config.json ships with use_bidirectional_attention=False (or missing),
    # which causes the Gemma-3 backbone to run with causal (left-to-right) masking.
    # Token-classification requires bidirectional context; without it the model
    # predicts sentence-end punctuation after every token.
    inner = getattr(model.model, "model", None)
    if inner is not None and hasattr(inner, "config"):
        inner.config.use_bidirectional_attention = True
        logger.info("Enabled bidirectional attention for Cadence punctuation model")

    logger.info("Punctuation model loaded successfully", model=model_name)
    return model


def initialize() -> None:
    """Load the default punctuation model. Called once during app startup."""
    global _default_model_name
    settings = get_settings()
    _default_model_name = settings.punctuation_model_name

    with _lock:
        if _default_model_name in _models:
            logger.warning("Punctuation model already initialized, skipping")
            return
        _models[_default_model_name] = _load_model(_default_model_name)


def get_model(model_name: str | None = None) -> Any:
    """Return a loaded model by name. Lazy-loads non-default models on first use."""
    name = model_name or _default_model_name
    if name is None:
        raise RuntimeError("Punctuation model not initialized. Call initialize() first.")

    model = _models.get(name)
    if model is not None:
        return model

    with _lock:
        model = _models.get(name)
        if model is not None:
            return model
        _models[name] = _load_model(name)
        return _models[name]


async def punctuate(text: str, model_name: str | None = None) -> str:
    """Punctuate a single text string. Runs sync model in executor."""
    if not text.strip():
        return text

    model = get_model(model_name)
    loop = asyncio.get_running_loop()
    results = await loop.run_in_executor(
        None,
        lambda: model.punctuate([text], batch_size=1),
    )
    return results[0] if results else text


async def punctuate_batch(
    texts: list[str], batch_size: int = 8, model_name: str | None = None,
) -> list[str]:
    """Punctuate a list of texts. Runs sync model in executor."""
    if not texts:
        return texts

    model = get_model(model_name)
    loop = asyncio.get_running_loop()
    results = await loop.run_in_executor(
        None,
        lambda: model.punctuate(texts, batch_size=batch_size),
    )
    return results


def punctuate_sync(
    texts: list[str], batch_size: int = 8, model_name: str | None = None,
) -> list[str]:
    """Punctuate a list of texts synchronously (for batch pipeline)."""
    if not texts:
        return texts

    model = get_model(model_name)
    return model.punctuate(texts, batch_size=batch_size)


def shutdown() -> None:
    """Release all punctuation models (called during app shutdown)."""
    global _default_model_name
    _models.clear()
    _default_model_name = None
