"""Punctuation restoration service using cadence-punctuation.

Provides a model registry that holds one or more PunctuationModel instances
keyed by model name.  The default model (from settings) is loaded at
application startup; pipeline-specific overrides are lazy-loaded on first use.
Whether punctuation is applied is controlled per-pipeline via YAML config.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any, cast

import structlog

from stt_v2.core.config.settings import get_settings

logger = structlog.get_logger(__name__)

_models: dict[str, Any] = {}
_default_model_name: str | None = None
_enabled: bool = True
_suppression_warned: bool = False
_lock = threading.Lock()


def _warn_suppressed_once() -> None:
    """Warn (once per process) that a pipeline-requested punctuation call was
    suppressed by the global kill-switch.

    The runtime entry points are only invoked when a pipeline's YAML config
    has ``punctuation.enabled: true``, so reaching them while the service is
    disabled means the global flag is overriding the pipeline config.
    """
    global _suppression_warned
    if _suppression_warned:
        return
    _suppression_warned = True
    logger.warning(
        "Pipeline config requests punctuation but it is suppressed: "
        "PUNCTUATION_ENABLED is false (or the Cadence model failed to load). "
        "The global kill-switch takes precedence over per-pipeline "
        "'punctuation.enabled: true'; text passes through unpunctuated "
        "(warned once per process)"
    )


def _load_model(model_name: str) -> Any:
    """Load a PunctuationModel by name (not thread-safe -- caller must hold _lock)."""
    from stt_v2.punctuation import cadence_fast

    # TASK-351 P2-2 — the exact name 'cadence-fast' selects the direct
    # transformers loader (the wrapper cannot load under transformers 5.x).
    # Wrapper spellings ('Cadence', 'Cadence-Fast') keep the legacy path.
    if model_name == cadence_fast.MODEL_NAME:
        return cadence_fast.load_model()

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


def initialize() -> bool:
    """Load the default punctuation model. Called once during app startup.

    When ``PUNCTUATION_ENABLED`` is false (the default) the Cadence model is
    never touched: we log a single INFO line and return ``False``. This keeps
    the boot log free of Cadence's internal ``FATAL: Error loading model``
    traceback, which it prints whenever its loader runs under an incompatible
    transformers version.

    Returns ``True`` only when punctuation is enabled and the model is
    actually loaded, so callers can condition their "initialized" log line
    on the real outcome.

    If the model load fails, the service flips itself to disabled so every
    runtime call degrades to passthrough instead of re-attempting the failing
    load per utterance; the exception is re-raised so the caller logs the
    failure once.
    """
    global _default_model_name, _enabled
    settings = get_settings()
    _enabled = bool(settings.punctuation_enabled)
    if not _enabled:
        logger.info(
            "Punctuation restoration disabled (PUNCTUATION_ENABLED=false); "
            "Cadence model not loaded"
        )
        return False

    _default_model_name = settings.punctuation_model_name

    with _lock:
        if _default_model_name in _models:
            logger.warning("Punctuation model already initialized, skipping")
            return True
        try:
            _models[_default_model_name] = _load_model(_default_model_name)
        except Exception:
            _enabled = False
            _default_model_name = None
            raise
    return True


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
    """Punctuate a single text string.

    Model lookup (including any lazy load) and inference both run in the
    executor so the event loop is never blocked (TASK-351 P2-2 — the
    streaming worker's ``asyncio.wait_for`` timeout can only fire on time
    if a first-use model load happens off the loop thread).
    """
    if not _enabled:
        _warn_suppressed_once()
        return text
    if not text.strip():
        return text

    loop = asyncio.get_running_loop()
    results = await loop.run_in_executor(
        None,
        lambda: get_model(model_name).punctuate([text], batch_size=1),
    )
    return results[0] if results else text


async def punctuate_batch(
    texts: list[str], batch_size: int = 8, model_name: str | None = None,
) -> list[str]:
    """Punctuate a list of texts. Runs sync model in executor."""
    if not _enabled:
        _warn_suppressed_once()
        return texts
    if not texts:
        return texts

    model = get_model(model_name)
    loop = asyncio.get_running_loop()
    results = await loop.run_in_executor(
        None,
        lambda: model.punctuate(texts, batch_size=batch_size),
    )
    return cast(list[str], results)


def punctuate_sync(
    texts: list[str], batch_size: int = 8, model_name: str | None = None,
) -> list[str]:
    """Punctuate a list of texts synchronously (for batch pipeline)."""
    if not _enabled:
        _warn_suppressed_once()
        return texts
    if not texts:
        return texts

    model = get_model(model_name)
    return cast(list[str], model.punctuate(texts, batch_size=batch_size))


def shutdown() -> None:
    """Release all punctuation models (called during app shutdown)."""
    global _default_model_name
    _models.clear()
    _default_model_name = None
