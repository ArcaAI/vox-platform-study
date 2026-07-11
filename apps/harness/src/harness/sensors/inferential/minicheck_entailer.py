"""MiniCheck-Flan-T5 GGUF NLI entailer for the atomic-fact verifier (TASK-481).

The self-hosted ``NliEntailer`` upgrade to the model-free ``DeterministicOverlapEntailer``
(owner directive 2026-07-11: "GGUF everywhere"). Runs ``nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF``
under llama.cpp — MiniCheck (arXiv:2404.10774) scores ``p(hypothesis entailed by premise)``;
the flan-t5 variant builds ``'predict: ' + premise + '</s>' + hypothesis`` and reads a 2-way
softmax over the decoder's "no"/"yes" label tokens (HF vocab ids **3** / **209**, preserved by
the GGUF conversion) at the first generated position — ``P(yes) >= threshold`` ⇒ entailed.

Mirrors the guardrail TASK-479 scorer (the two services can't share a package). Same SAFETY
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
from collections.abc import Callable

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
    "A group of students gather in the school library to study for their "
    "upcoming final exams."
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
    """Best-effort first-decoder-step logit reader over a loaded llama.cpp T5 handle.

    CALIBRATION-PENDING: the exact llama-cpp-python T5 encode/decode + per-step logits
    access is version-sensitive and is validated only end-to-end by ``verify_calibration``.
    """
    import numpy as np  # local import — only when a real model is loaded

    def logit_fn(prompt: str) -> tuple[float, float]:
        llama.reset()  # type: ignore[attr-defined]
        tokens = llama.tokenize(prompt.encode("utf-8"), add_bos=True, special=True)  # type: ignore[attr-defined]
        llama.eval(tokens)  # type: ignore[attr-defined]
        logits = np.asarray(llama.scores, dtype=np.float64).reshape(-1, llama.n_vocab())  # type: ignore[attr-defined]
        last = logits[llama.n_tokens - 1]  # type: ignore[attr-defined]
        return float(last[MINICHECK_LABEL_TOKEN_NO]), float(last[MINICHECK_LABEL_TOKEN_YES])

    return logit_fn


# Process-level cache: the .gguf is loaded once per worker, keyed by model path — the
# entailer factory runs per activity invocation, but a Llama load is expensive.
_ENTAILER_CACHE: dict[str, LlamaCppMiniCheckEntailer] = {}


def load_minicheck_entailer(
    *,
    model_path: str,
    n_ctx: int = 4096,
    n_threads: int | None = None,
    n_gpu_layers: int = 0,
    threshold: float = 0.5,
) -> LlamaCppMiniCheckEntailer:
    """Load (and cache) the GGUF MiniCheck entailer; raise on any construction failure.

    Requires an explicit local ``.gguf`` (no network in the clinical path). Missing
    llama-cpp-python, an unloadable model, or a failed calibration self-check raise —
    ``_atomic_fact_entailer`` catches and falls back to the safe deterministic entailer.
    """
    cache_key = f"{model_path}|{n_ctx}|{n_threads}|{n_gpu_layers}|{threshold}"
    cached = _ENTAILER_CACHE.get(cache_key)
    if cached is not None:
        return cached

    from llama_cpp import Llama  # type: ignore[import-not-found]

    llama = Llama(
        model_path=model_path,
        n_ctx=n_ctx,
        n_threads=n_threads,
        n_gpu_layers=n_gpu_layers,
        logits_all=True,
        verbose=False,
    )
    entailer = LlamaCppMiniCheckEntailer(_make_llama_logit_fn(llama), threshold=threshold)
    entailer.verify_calibration()  # raises MiniCheckCalibrationError if mis-wired / too lossy
    _ENTAILER_CACHE[cache_key] = entailer
    logger.info("harness.atomic_fact.minicheck_loaded", model_path=model_path)
    return entailer
