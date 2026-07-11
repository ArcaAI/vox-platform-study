"""Self-hosted MiniCheck (Flan-T5-Large) groundedness scorer — llama.cpp / GGUF backend.

Implements the ``NliScorer`` seam (``groundedness_nli.py``) using the GGUF quant
``nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF`` run under llama.cpp (owner directive
2026-07-11: "GGUF everywhere"). MiniCheck (arXiv:2404.10774) scores ``p(claim
entailed by document)`` at the sentence level; the flan-t5 variant builds the input
``'predict: ' + doc + '</s>' + claim`` and reads a 2-way softmax over the decoder's
"no"/"yes" label tokens (HF vocab ids **3** / **209**, preserved by the GGUF
conversion) at the first generated position — ``P(yes)`` is the support probability.

SAFETY — the CALIBRATION GATE. This backend CANNOT be numerically validated at build
time (no GPU/weights on CI) and the llama.cpp T5 logit read + Q6 quantisation can
perturb the score. A fail-closed wrapper (``GroundednessNliVerifier``) already
contains *errors*, but NOT a plausible-but-wrong probability that silently passes
ungrounded clinical text. So ``load_minicheck_scorer`` runs ``verify_calibration()``
against MiniCheck's own published reference pair before returning: a supported
example must score ``>= CAL_SUPPORTED_MIN`` and an unsupported example
``<= CAL_UNSUPPORTED_MAX``, else it raises ``NliModelUnavailableError`` and the gate
degrades to ``unverified``. A mis-wired template/logit read (which collapses toward
~0.5 or inverts) or a too-lossy quant therefore **refuses to enable** rather than
mis-passing. Direction+margin — not exact value — so a correct-but-quantised scorer
still passes.

The llama.cpp interaction is isolated in ``_make_llama_logit_fn`` (CALIBRATION-
PENDING, validated only end-to-end by the gate above); everything else is pure and
hermetically tested by injecting a fake ``logit_fn``. Track guardrail: self-hosted
only, explicit local staging (no HF network pull in the clinical gate) — clinical
text never leaves the host.

Known calibration-phase limitation: the reference pair is short, so the gate proves
the template + label-logit read + direction, NOT long-transcript handling. MiniCheck
windows long documents (~512-token chunks, max-aggregate); staging a long-transcript
chunker here is a documented follow-up (see the TASK-479 enablement checklist).
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence

from guardrail.core.config import GroundednessConfig
from guardrail.core.logging import get_logger
from guardrail.services.groundedness_nli import NliModelUnavailableError, NliScorer

logger = get_logger(__name__)

# MiniCheck flan-t5 label tokens (HF vocab ids, preserved by the GGUF conversion):
# id 3 = "no" (index 0, unsupported), id 209 = "yes" (index 1, supported).
# support_prob = softmax([logit_no, logit_yes])[1]  (matches Liyan06/MiniCheck).
MINICHECK_LABEL_TOKEN_NO = 3
MINICHECK_LABEL_TOKEN_YES = 209

# MiniCheck input template: 'predict: ' + doc + <eos> + claim  (T5 eos = '</s>').
_PROMPT_PREFIX = "predict: "
_EOS = "</s>"

# Published model-card reference pair (lytang/MiniCheck-Flan-T5-Large) — the
# calibration gate's ground truth. raw_prob ≈ 0.981 (supported) / ≈ 0.007 (unsupported).
_CAL_DOC = (
    "A group of students gather in the school library to study for their "
    "upcoming final exams."
)
_CAL_SUPPORTED_CLAIM = "The students are preparing for an examination."
_CAL_UNSUPPORTED_CLAIM = "The students are on vacation."
# Direction+margin tolerances: loose enough to pass a correct-but-Q6-quantised scorer,
# strict enough to fail a broken template/logit read (~0.5) or an inverted mapping.
CAL_SUPPORTED_MIN = 0.60
CAL_UNSUPPORTED_MAX = 0.40

LogitFn = Callable[[str], tuple[float, float]]
"""``prompt -> (logit_no, logit_yes)`` at the first decoder step."""


def _support_prob(logit_no: float, logit_yes: float) -> float:
    """2-way softmax over the (no, yes) label logits → ``P(yes)`` clamped to ``[0, 1]``."""
    ceiling = max(logit_no, logit_yes)  # numerically-stable softmax
    exp_no = math.exp(logit_no - ceiling)
    exp_yes = math.exp(logit_yes - ceiling)
    prob = exp_yes / (exp_no + exp_yes)
    return min(1.0, max(0.0, prob))


class LlamaCppMiniCheckScorer:
    """``NliScorer`` over MiniCheck-Flan-T5 GGUF via an injected first-step logit fn.

    The scoring math is pure and deterministic; the only model-dependent part is the
    injected ``logit_fn`` (built by ``_make_llama_logit_fn`` for production, faked in
    tests), which keeps this class hermetically testable without llama.cpp.
    """

    def __init__(self, logit_fn: LogitFn) -> None:
        self._logit_fn = logit_fn

    @staticmethod
    def build_prompt(source: str, claim: str) -> str:
        """MiniCheck flan-t5 input: ``'predict: ' + source + '</s>' + claim``."""
        return f"{_PROMPT_PREFIX}{source}{_EOS}{claim}"

    def score_pairs(self, pairs: Sequence[tuple[str, str]]) -> list[float]:
        """Return ``P(claim entailed by source)`` per pair, in order, in ``[0, 1]``."""
        scores: list[float] = []
        for source, claim in pairs:
            logit_no, logit_yes = self._logit_fn(self.build_prompt(source, claim))
            scores.append(_support_prob(logit_no, logit_yes))
        return scores

    def verify_calibration(self) -> None:
        """Score MiniCheck's published reference pair; raise if direction/margin is off.

        Fail-closed safety gate: a mis-wired template/logit read or a too-lossy quant
        raises ``NliModelUnavailableError`` so the scorer refuses to enable instead of
        silently mis-passing ungrounded clinical text.
        """
        supported, unsupported = self.score_pairs(
            [(_CAL_DOC, _CAL_SUPPORTED_CLAIM), (_CAL_DOC, _CAL_UNSUPPORTED_CLAIM)]
        )
        if supported < CAL_SUPPORTED_MIN or unsupported > CAL_UNSUPPORTED_MAX:
            raise NliModelUnavailableError(
                "MiniCheck GGUF calibration self-check failed "
                f"(supported={supported:.3f} < {CAL_SUPPORTED_MIN} or "
                f"unsupported={unsupported:.3f} > {CAL_UNSUPPORTED_MAX}): the llama.cpp "
                "template/label-logit read is likely mis-wired or the quant is too lossy "
                "— refusing to enable (fail-closed to 'unverified'). Re-validate the "
                "MiniCheck flan-t5 template + token ids (3/209) on this host."
            )


def _make_llama_logit_fn(llama: object) -> LogitFn:
    """Best-effort first-decoder-step logit reader over a loaded llama.cpp T5 handle.

    CALIBRATION-PENDING: the exact llama-cpp-python T5 encode/decode + per-step logits
    access is version-sensitive and is validated end-to-end by ``verify_calibration()``
    (NOT here). Reads the raw vocab logits at the single decoded step and indexes the
    MiniCheck label tokens (ids 3 / 209). Isolated so a wrong read is caught by the
    calibration gate rather than shipping silently.
    """
    import numpy as np  # local import — only when a real model is loaded

    def logit_fn(prompt: str) -> tuple[float, float]:
        llama.reset()  # type: ignore[attr-defined]  # score each (doc, claim) independently
        tokens = llama.tokenize(prompt.encode("utf-8"), add_bos=True, special=True)  # type: ignore[attr-defined]
        llama.eval(tokens)  # type: ignore[attr-defined]  # T5 encode + one decoder step
        logits = np.asarray(llama.scores, dtype=np.float64).reshape(-1, llama.n_vocab())  # type: ignore[attr-defined]
        last = logits[llama.n_tokens - 1]  # type: ignore[attr-defined]
        return float(last[MINICHECK_LABEL_TOKEN_NO]), float(last[MINICHECK_LABEL_TOKEN_YES])

    return logit_fn


def load_minicheck_scorer(config: GroundednessConfig) -> NliScorer:
    """Load the GGUF MiniCheck scorer; raise ``NliModelUnavailableError`` on any failure.

    Fail-closed + no network: requires an explicit local ``model_path`` (stage the
    ``.gguf`` on the host — a clinical gate never auto-downloads weights). Missing
    llama-cpp-python, an unloadable model, or a failed calibration self-check all raise
    ``NliModelUnavailableError`` so ``GroundednessNliVerifier`` degrades to ``unverified``.
    """
    if not config.model_path:
        raise NliModelUnavailableError(
            f"MiniCheck GGUF '{config.model_id}' ({config.model_file}) is not staged: set "
            "GUARDRAIL_V2_GROUNDEDNESS_MODEL_PATH to the local .gguf (no network pull in "
            "the clinical gate). Fail-closed to 'unverified'."
        )

    try:
        from llama_cpp import Llama  # type: ignore[import-not-found]
    except ImportError as exc:
        raise NliModelUnavailableError(
            "llama-cpp-python is not installed; install the guardrail 'groundedness' extra "
            "to enable the MiniCheck GGUF scorer (fail-closed to 'unverified')."
        ) from exc

    try:
        llama = Llama(
            model_path=config.model_path,
            n_ctx=config.n_ctx,
            n_threads=config.n_threads,
            n_gpu_layers=config.n_gpu_layers,
            logits_all=True,
            verbose=False,
        )
    except Exception as exc:  # noqa: BLE001 — any load failure is fail-closed
        raise NliModelUnavailableError(
            f"Could not load MiniCheck GGUF at '{config.model_path}': "
            f"{type(exc).__name__} — fail-closed to 'unverified'."
        ) from exc

    scorer = LlamaCppMiniCheckScorer(_make_llama_logit_fn(llama))
    try:
        scorer.verify_calibration()  # raises NliModelUnavailableError if mis-wired / too-lossy
    except NliModelUnavailableError:
        raise
    except Exception as exc:  # noqa: BLE001 — a llama.cpp runtime error at calibration is fail-closed
        raise NliModelUnavailableError(
            f"MiniCheck GGUF calibration raised {type(exc).__name__} — fail-closed to "
            "'unverified'."
        ) from exc
    logger.info(
        "guardrail.groundedness.minicheck_loaded",
        model_id=config.model_id,
        model_file=config.model_file,
    )
    return scorer
