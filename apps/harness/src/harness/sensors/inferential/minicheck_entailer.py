"""MiniCheck-Flan-T5 GGUF NLI entailer for the atomic-fact verifier.

The self-hosted ``NliEntailer`` upgrade to the model-free ``DeterministicOverlapEntailer``
(owner directive 2026-07-11: "GGUF everywhere"). Runs ``nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF``
under llama.cpp — MiniCheck (arXiv:2404.10774) scores ``p(hypothesis entailed by premise)``;
the flan-t5 variant builds ``'predict: ' + premise + '</s>' + hypothesis`` and reads a 2-way
softmax over the decoder's "no"/"yes" label tokens (HF vocab ids **3** / **209**, preserved by
the GGUF conversion) at the first generated position — ``P(yes) >= threshold`` ⇒ entailed.

Mirrors the guardrail service's scorer (the two services can't share a package). Same SAFETY
posture — a load-time CALIBRATION GATE (``verify_calibration``) scores MiniCheck's published
reference pair and raises ``MiniCheckCalibrationError`` if a mis-wired template/logit read
(≈0.5 / inverted) or a too-lossy quant can't reproduce its direction+margin, so a miscalibrated
model is never used. ``_atomic_fact_entailer`` treats a build/calibration failure as a config
error and falls back to the safe ``DeterministicOverlapEntailer`` (never auto-PASS).

``NliEntailer`` contract note: ``entail`` is async and a *runtime* backend outage must RAISE
(the atomic-fact sensor catches it and degrades — never auto-PASS), so ``entail`` does NOT
swallow llama.cpp errors; only construction is guarded. The blocking llama.cpp call runs in a
worker thread (``asyncio.to_thread``) so it never stalls the Temporal activity's event loop.
Determinism: greedy first-token argmax over fixed label ids ⇒ byte-identical verdicts.
Track guardrail: self-hosted, explicit local staging only — clinical text never leaves the host.
"""

from __future__ import annotations

import asyncio
import math
import time
from collections.abc import Callable
from dataclasses import dataclass

from hope_runtime_models import CacheStats, SyncModelCache

from harness.core.logging import get_logger

logger = get_logger(__name__)

# MiniCheck flan-t5 label tokens (HF vocab ids, preserved by the GGUF conversion):
# id 3 = "no" (unsupported), id 209 = "yes" (supported). support = softmax([no, yes])[1].
MINICHECK_LABEL_TOKEN_NO = 3
MINICHECK_LABEL_TOKEN_YES = 209

_PROMPT_PREFIX = "predict: "
_EOS = "</s>"

# Published model-card reference pair (lytang/MiniCheck-Flan-T5-Large) for the calibration gate.
_CAL_DOC = (
    "A group of students gather in the school library to study for their " "upcoming final exams."
)
_CAL_SUPPORTED_CLAIM = "The students are preparing for an examination."
_CAL_UNSUPPORTED_CLAIM = "The students are on vacation."
# Direction+margin — loose enough for Q6 drift, strict enough to catch a broken read (~0.5).
CAL_SUPPORTED_MIN = 0.60
CAL_UNSUPPORTED_MAX = 0.40

LogitFn = Callable[[str], tuple[float, float]]
"""``prompt -> (logit_no, logit_yes)`` at the first decoder step."""


class MiniCheckCalibrationError(RuntimeError):
    """The GGUF MiniCheck entailer failed its load-time calibration self-check."""


def _support_prob(logit_no: float, logit_yes: float) -> float:
    """2-way softmax over the (no, yes) label logits → ``P(yes)`` clamped to ``[0, 1]``."""
    ceiling = max(logit_no, logit_yes)
    exp_no = math.exp(logit_no - ceiling)
    exp_yes = math.exp(logit_yes - ceiling)
    return min(1.0, max(0.0, exp_yes / (exp_no + exp_yes)))


class LlamaCppMiniCheckEntailer:
    """``NliEntailer`` over MiniCheck-Flan-T5 GGUF via an injected first-step logit fn.

    The scoring math + threshold are pure/deterministic; only the injected ``logit_fn``
    is model-dependent (real one from ``_make_llama_logit_fn``; faked in tests), so this
    class is hermetically testable without llama.cpp.
    """

    def __init__(self, logit_fn: LogitFn, *, threshold: float = 0.5) -> None:
        if not (0.0 <= threshold <= 1.0):
            raise ValueError("threshold must be within [0, 1]")
        self._logit_fn = logit_fn
        self._threshold = threshold

    @staticmethod
    def build_prompt(premise: str, hypothesis: str) -> str:
        """MiniCheck flan-t5 input: ``'predict: ' + premise + '</s>' + hypothesis``."""
        return f"{_PROMPT_PREFIX}{premise}{_EOS}{hypothesis}"

    def _support(self, premise: str, hypothesis: str) -> float:
        return _support_prob(*self._logit_fn(self.build_prompt(premise, hypothesis)))

    async def entail(self, premise: str, hypothesis: str) -> bool:
        """``True`` iff ``P(premise entails hypothesis) >= threshold``.

        The blocking llama.cpp inference runs in a worker thread. A runtime backend error
        propagates (per the ``NliEntailer`` contract — the sensor catches it and degrades).
        """
        prob = await asyncio.to_thread(self._support, premise, hypothesis)
        return prob >= self._threshold

    def verify_calibration(self) -> None:
        """Score MiniCheck's published reference pair; raise if direction/margin is off."""
        supported = self._support(_CAL_DOC, _CAL_SUPPORTED_CLAIM)
        unsupported = self._support(_CAL_DOC, _CAL_UNSUPPORTED_CLAIM)
        if supported < CAL_SUPPORTED_MIN or unsupported > CAL_UNSUPPORTED_MAX:
            raise MiniCheckCalibrationError(
                "MiniCheck GGUF calibration self-check failed "
                f"(supported={supported:.3f} < {CAL_SUPPORTED_MIN} or "
                f"unsupported={unsupported:.3f} > {CAL_UNSUPPORTED_MAX}): the llama.cpp "
                "template/label-logit read is likely mis-wired or the quant too lossy."
            )


def _make_llama_logit_fn(llama: object) -> LogitFn:
    """First-decoder-step label-logit reader over a loaded llama.cpp T5 handle.

    Flan-T5 is an ENCODER-DECODER: the high-level ``Llama.eval`` only runs the decoder
    (``llama_decode``) and aborts with ``"llama_encode must be called first"`` on a T5
    graph. This drives the low-level path llama-cpp-python's completion API omits for
    encoder-decoder models: tokenize the MiniCheck prompt → ``llama_encode`` the encoder
    input → ``llama_decode`` a single decoder-start token → read that step's vocab logits
    and index the label tokens (ids 3 / 209). ``P(yes)`` here is the entailment probability.

    Uses llama-cpp-python internals (``_model`` / ``_ctx`` / ``_internals.LlamaBatch``),
    which are version-sensitive — the fail-closed ``verify_calibration`` gate validates this
    wiring end-to-end on the host before the entailer is used. (Mirrors the guardrail
    service's scorer; the two services can't share a package.)
    """
    import llama_cpp
    import numpy as np  # local imports — only when a real model is loaded
    from llama_cpp._internals import LlamaBatch

    model = llama._model  # type: ignore[attr-defined]  # _LlamaModel
    ctx = llama._ctx  # type: ignore[attr-defined]      # _LlamaContext
    n_vocab = int(llama.n_vocab())  # type: ignore[attr-defined]

    # T5 decoder-start token (pad id 0 for Flan-T5); fall back sanely if metadata omits it.
    dec_start = llama_cpp.llama_model_decoder_start_token(model.model)
    if dec_start is None or dec_start < 0:
        bos = model.token_bos()
        dec_start = bos if bos is not None and bos >= 0 else 0

    def _clear_kv() -> None:
        mem = llama_cpp.llama_get_memory(ctx.ctx)
        if mem is not None:
            llama_cpp.llama_memory_clear(mem, True)

    def logit_fn(prompt: str) -> tuple[float, float]:
        _clear_kv()  # score each (premise, hypothesis) independently — no cross-pair state
        # T5 has no BOS (token_bos == -1); `special=True` maps the embedded '</s>'.
        enc = llama.tokenize(prompt.encode("utf-8"), add_bos=False, special=True)  # type: ignore[attr-defined]
        enc_batch = LlamaBatch(n_tokens=len(enc), embd=0, n_seq_max=1, verbose=False)
        enc_batch.set_batch(enc, n_past=0, logits_all=False)
        ctx.encode(enc_batch)  # llama_encode — populates the cross-attention state
        dec_batch = LlamaBatch(n_tokens=1, embd=0, n_seq_max=1, verbose=False)
        dec_batch.set_batch([dec_start], n_past=0, logits_all=False)
        ctx.decode(dec_batch)  # one decoder step; set_batch marks it logits=True
        logits = np.ctypeslib.as_array(ctx.get_logits(), shape=(n_vocab,)).astype(np.float64)
        return float(logits[MINICHECK_LABEL_TOKEN_NO]), float(logits[MINICHECK_LABEL_TOKEN_YES])

    return logit_fn


# ---------------------------------------------------------------------------
# Process-level entailer cache
# ---------------------------------------------------------------------------
# This was previously a plain module dict "loaded once per worker, keyed by
# model path": no TTL, no bound, no unload — a GGUF loaded by one activity stayed
# resident for the life of the Temporal worker. It is now the shared HOPE cache
# contract, so retention here means what it means everywhere else (an owner
# expectation — no service exempt).
#
# The SYNC sibling is deliberate: `_atomic_fact_entailer` (activities.py)
# is a plain `def` and a `llama_cpp.Llama` construction is a blocking CPU/GPU
# call, not awaited I/O — so wrapping it in an async cache would push `async` up
# into the clinical activity chain for zero behavioural gain. Policy is shared
# with `ModelCache`; only the concurrency primitive differs.


@dataclass(frozen=True)
class _EntailerSpec:
    """The load parameters behind one cache key (the key alone cannot rebuild them)."""

    model_path: str
    n_ctx: int
    n_threads: int | None
    n_gpu_layers: int
    threshold: float

    @property
    def key(self) -> str:
        """The composite cache key — unchanged from the earlier module dict."""
        return (
            f"{self.model_path}|{self.n_ctx}|{self.n_threads}"
            f"|{self.n_gpu_layers}|{self.threshold}"
        )


_SPECS: dict[str, _EntailerSpec] = {}
_CACHE: SyncModelCache[LlamaCppMiniCheckEntailer] | None = None
_CACHE_TIME_FUNC: Callable[[], float] = time.monotonic


def _build_entailer(spec: _EntailerSpec) -> LlamaCppMiniCheckEntailer:
    """Construct the llama.cpp handle and its entailer (NOT calibrated yet).

    Factored out like the other client factories so tests can monkeypatch it —
    everything above this line is hermetic, everything below it needs weights.
    """
    from llama_cpp import Llama

    llama = Llama(
        model_path=spec.model_path,
        n_ctx=spec.n_ctx,
        n_threads=spec.n_threads,
        n_gpu_layers=spec.n_gpu_layers,
        logits_all=True,
        verbose=False,
    )
    return LlamaCppMiniCheckEntailer(_make_llama_logit_fn(llama), threshold=spec.threshold)


def _load_entailer(cache_key: str) -> LlamaCppMiniCheckEntailer:
    """Cache factory: build + calibrate. Runs on EVERY load, reloads included.

    The calibration gate is inside the factory on purpose: a reloaded entailer
    that skipped it could silently mis-score the clinical path. A failure raises,
    is NOT cached by the contract, and `_atomic_fact_entailer` falls back to the
    safe deterministic entailer.
    """
    spec = _SPECS[cache_key]
    entailer = _build_entailer(spec)
    entailer.verify_calibration()  # raises MiniCheckCalibrationError if mis-wired / too lossy
    logger.info("harness.atomic_fact.minicheck_loaded", model_path=spec.model_path)
    return entailer


def _unload_entailer(cache_key: str, _entailer: LlamaCppMiniCheckEntailer) -> None:
    """Release hook: the cache has dropped its reference; the weights free on GC.

    Deliberately NOT a destructive ``llama.close()`` — an activity that is still
    scoring holds the entailer, and closing the handle underneath it would fault
    the clinical path. The llama handle is reachable only through the entailer's
    logit closure, so the last holder releasing it frees the GGUF.
    """
    logger.info("harness.atomic_fact.minicheck_unloaded", cache_key=cache_key)


def _entailer_cache() -> SyncModelCache[LlamaCppMiniCheckEntailer]:
    """The process-wide entailer cache, built on first use from the bootstrap settings."""
    global _CACHE
    if _CACHE is None:
        from harness.core.config import get_settings
        from harness.core.metrics import build_model_cache_metrics_sink

        settings = get_settings()
        _CACHE = SyncModelCache(
            factory=_load_entailer,
            ttl_seconds=settings.model_cache_ttl_seconds,
            max_size=settings.model_cache_max_models,
            unload=_unload_entailer,
            time_func=_CACHE_TIME_FUNC,
            metrics=build_model_cache_metrics_sink(),
            name="harness_minicheck",
        )
    return _CACHE


def configure_entailer_cache(retention: dict[str, int]) -> None:
    """Adopt control-plane retention (`harness.modelCache.*`); absent keys hold.

    A gateway outage yields a partial payload, which must leave behaviour
    byte-identical rather than reset knobs to defaults. Resident entailers are
    never dropped here — new limits apply on the next sweep or access. The
    product clamp [60, 3600] is re-applied inside the shared cache.
    """
    _entailer_cache().configure(
        ttl_seconds=retention.get("ttl_seconds"),
        max_size=retention.get("max_models"),
    )


def sweep_entailer_cache() -> int:
    """Release the entailer if it has been idle past its TTL; returns how many.

    Lazy eviction on `load_minicheck_entailer` covers a worker that keeps
    verifying; this covers the one that ran a document and then went quiet — the
    case where the earlier module dict pinned a GGUF forever.
    """
    return _entailer_cache().sweep()


def entailer_cache_stats() -> CacheStats:
    """Cache snapshot — the same shape every other HOPE cache reports."""
    return _entailer_cache().stats()


def reset_entailer_cache(*, time_func: Callable[[], float] | None = None) -> None:
    """Drop the cache singleton (TESTS ONLY — does not unload a live entailer)."""
    global _CACHE, _CACHE_TIME_FUNC
    _CACHE = None
    _SPECS.clear()
    _CACHE_TIME_FUNC = time_func if time_func is not None else time.monotonic


def load_minicheck_entailer(
    *,
    model_path: str,
    n_ctx: int = 512,  # Flan-T5 train ctx; MiniCheck windows to ~512-token chunks
    n_threads: int | None = None,
    n_gpu_layers: int = 0,
    threshold: float = 0.5,
) -> LlamaCppMiniCheckEntailer:
    """Load (and cache) the GGUF MiniCheck entailer; raise on any construction failure.

    Requires an explicit local ``.gguf`` (no network in the clinical path). Missing
    llama-cpp-python, an unloadable model, or a failed calibration self-check raise —
    ``_atomic_fact_entailer`` catches and falls back to the safe deterministic entailer.

    Signature and return type are unchanged by the cache introduction: the sole call
    site stays synchronous, which is the whole reason the cache is the sync sibling.
    """
    spec = _EntailerSpec(
        model_path=model_path,
        n_ctx=n_ctx,
        n_threads=n_threads,
        n_gpu_layers=n_gpu_layers,
        threshold=threshold,
    )
    _SPECS[spec.key] = spec
    return _entailer_cache().get(spec.key)
