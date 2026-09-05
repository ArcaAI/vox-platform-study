"""Punctuation restoration service using cadence-punctuation.

A model registry holding one or more ``PunctuationModel`` instances keyed by model
name. Every model is lazy-loaded on first use, single-flight, at most once per
process.

TASK-877 — WHICH model runs, and WHETHER punctuation runs at all, are the AGENT's
decisions: they arrive per session as ``ResolvedAsrSpec.models.punctuation.slug``
and ``postProcessing.punctuation.enabled``. The two platform keys that used to
decide instead — ``stt.punctuation.enabled`` (a boot gate that returned early and
so vetoed every agent, default OFF) and ``stt.punctuation.modelName`` (a duplicate
of the spec's slug) — are deleted.

``stt.punctuation.{device,modelCacheDir,maxLength}`` are KEPT and still read here:
device placement, cache location and window width are properties of the HOST, not
of the agent's behaviour.

The kill-switch is not needed to contain the known loader hazard. The legacy
``cadence`` wrapper cannot load under the pinned transformers 5.x (only the exact
name ``cadence-fast``, the direct loader, can), and ``_enabled`` latches to False
on the first failure — so a bad binding costs one warning per process and degrades
to passthrough, rather than raising per utterance.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any, cast

import structlog

from stt.core.config.settings import get_settings

logger = structlog.get_logger(__name__)

_models: dict[str, Any] = {}
#: The most recently loaded model name — a convenience for callers that punctuate
#: without repeating the slug. NOT a platform default: it is only ever set by a
#: load the SPEC asked for.
_default_model_name: str | None = None
#: Fail-safe latch. Starts True and only ever goes False, when a load fails.
_enabled: bool = True
_suppression_warned: bool = False
_lock = threading.Lock()

# Lazy first-use init: the default Cadence model is loaded on the
# first punctuation call (not at process boot). ``_init_done`` + ``_init_lock``
# make that load a single-flight, at-most-once attempt per process.
_init_done: bool = False
_init_lock = threading.Lock()


def _warn_suppressed_once() -> None:
    """Warn (once per process) that a spec-requested punctuation call passed through.

    The runtime entry points are only invoked when the session's spec has
    ``postProcessing.punctuation.enabled``, so reaching them without a usable model
    means either the agent bound no ``models.punctuation`` row, or that model failed
    to load and the service latched off.
    """
    global _suppression_warned
    if _suppression_warned:
        return
    _suppression_warned = True
    logger.warning(
        "The session spec requests punctuation but no model is available: the agent "
        "bound no `models.punctuation` row, or the bound model failed to load (the "
        "legacy `cadence` wrapper cannot load under the pinned transformers 5.x — "
        "bind `cadence-fast`). Text passes through unpunctuated "
        "(warned once per process)"
    )


def _load_model(model_name: str) -> Any:
    """Load a PunctuationModel by name (not thread-safe -- caller must hold _lock)."""
    from stt.punctuation import cadence_fast

    # The exact name 'cadence-fast' selects the direct
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


def initialize(model_name: str | None = None) -> bool:
    """Load one punctuation model eagerly. Returns whether a model is now loaded.

    ``model_name`` comes from the session's ``ResolvedAsrSpec``
    (``models.punctuation.slug``). With no name there is nothing to warm — process
    boot has no spec — so this returns ``False`` without loading or failing. That is
    the honest answer, not an error: the model to warm is not knowable until an
    agent has been resolved.

    On a load failure the service flips itself to disabled so every later call
    degrades to passthrough instead of re-attempting the failing load per utterance;
    the exception is re-raised so the caller logs it once.
    """
    global _default_model_name, _enabled
    if model_name is None:
        logger.info(
            "No punctuation model to warm at boot; each session loads the model its "
            "ResolvedAsrSpec names (models.punctuation)"
        )
        return False

    with _lock:
        if model_name in _models:
            logger.warning("Punctuation model already initialized, skipping", model=model_name)
            _default_model_name = model_name
            return True
        try:
            _models[model_name] = _load_model(model_name)
        except Exception:
            _enabled = False
            raise
        _default_model_name = model_name
    return True


def ensure_initialized(model_name: str | None = None) -> bool:
    """Lazily load the spec's punctuation model on first use.

    Idempotent, thread-safe, and single-flight: a given model's load is attempted at
    most once per process, and a failure latches the whole service off (``_enabled``)
    so later calls pass through rather than retry.

    Returns whether punctuation can actually run — which is what lets the callers
    below decide between punctuating and passing through.
    """
    global _init_done
    if not _enabled:
        return False
    name = model_name or _default_model_name
    if name is None:
        # The agent bound no punctuation model: nothing to load, nothing to run.
        return False
    if name in _models:
        return True
    with _init_lock:
        if not _enabled:
            return False
        if name in _models:
            return True
        try:
            initialize(name)
        except Exception:
            # initialize() already flipped the service to disabled on failure;
            # swallow here so runtime calls degrade to passthrough.
            logger.debug("Lazy punctuation initialization failed", exc_info=True)
        _init_done = True
    return _enabled and name in _models


def get_model(model_name: str | None = None) -> Any:
    """Return a loaded model by name. Lazy-loads on first use."""
    name = model_name or _default_model_name
    if name is None:
        raise RuntimeError(
            "No punctuation model named. The session's ResolvedAsrSpec must bind one "
            "(models.punctuation)."
        )

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
    executor so the event loop is never blocked — the
    streaming worker's ``asyncio.wait_for`` timeout can only fire on time
    if a first-use model load happens off the loop thread.
    """
    if not text.strip():
        return text

    loop = asyncio.get_running_loop()
    if not await loop.run_in_executor(None, ensure_initialized, model_name):
        _warn_suppressed_once()
        return text

    results = await loop.run_in_executor(
        None,
        lambda: get_model(model_name).punctuate([text], batch_size=1),
    )
    return results[0] if results else text


async def punctuate_batch(
    texts: list[str],
    batch_size: int = 8,
    model_name: str | None = None,
) -> list[str]:
    """Punctuate a list of texts. Runs sync model in executor."""
    if not texts:
        return texts

    loop = asyncio.get_running_loop()
    if not await loop.run_in_executor(None, ensure_initialized, model_name):
        _warn_suppressed_once()
        return texts

    model = get_model(model_name)
    results = await loop.run_in_executor(
        None,
        lambda: model.punctuate(texts, batch_size=batch_size),
    )
    return cast(list[str], results)


def punctuate_sync(
    texts: list[str],
    batch_size: int = 8,
    model_name: str | None = None,
) -> list[str]:
    """Punctuate a list of texts synchronously (for batch pipeline)."""
    if not texts:
        return texts
    if not ensure_initialized(model_name):
        _warn_suppressed_once()
        return texts

    model = get_model(model_name)
    return cast(list[str], model.punctuate(texts, batch_size=batch_size))


def shutdown() -> None:
    """Release all punctuation models (called during app shutdown)."""
    global _default_model_name, _init_done
    _models.clear()
    _default_model_name = None
    _init_done = False
