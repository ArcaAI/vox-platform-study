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
    """First-decoder-step label-logit reader over a loaded llama.cpp T5 handle.

    Flan-T5 is an ENCODER-DECODER: the high-level ``Llama.eval`` only runs the decoder
    (``llama_decode``), so it aborts with ``"llama_encode must be called first"`` on a
    T5 graph. This drives the low-level path llama-cpp-python's completion API omits for
    encoder-decoder models (verified absent in 0.3.x ``llama.py``): tokenize the MiniCheck
    prompt → ``llama_encode`` the encoder input → ``llama_decode`` a single decoder-start
    token → read that step's vocab logits and index the label tokens (ids 3 / 209).
    ``P(yes)`` at this first step is MiniCheck's support probability.

    Uses llama-cpp-python internals (``_model`` / ``_ctx`` / ``_internals.LlamaBatch``),
    which are version-sensitive — hence the fail-closed ``verify_calibration()`` gate
    validates this wiring end-to-end on the host before the scorer is allowed to enable.
    """
    import llama_cpp  # local imports — only when a real model is loaded
    import numpy as np
    from llama_cpp._internals import LlamaBatch

    model = llama._model  # type: ignore[attr-defined]  # _LlamaModel
    ctx = llama._ctx  # type: ignore[attr-defined]      # _LlamaContext
    n_vocab = int(llama.n_vocab())  # type: ignore[attr-defined]

    # T5 decoder-start token (pad id 0 for Flan-T5); fall back sanely if the model
    # metadata omits it. Encoder-only handles would fail the calibration gate anyway.
    dec_start = llama_cpp.llama_model_decoder_start_token(model.model)
    if dec_start is None or dec_start < 0:
        bos = model.token_bos()
        dec_start = bos if bos is not None and bos >= 0 else 0

    def _clear_kv() -> None:
        mem = llama_cpp.llama_get_memory(ctx.ctx)
        if mem is not None:
            llama_cpp.llama_memory_clear(mem, True)

    def logit_fn(prompt: str) -> tuple[float, float]:
        _clear_kv()  # score each (doc, claim) independently — no cross-pair state
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
