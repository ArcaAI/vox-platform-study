"""TASK-860 §2.4 — MiniCheck scores by ONE decoder step, not free-text generation.

MiniCheck-Flan-T5 reads the support probability as a 2-way softmax over the
`no`/`yes` label-token logits at the FIRST decoder step after
`"predict: " + document + "</s>" + claim`. A scorer that instead generated text
and parsed it would (a) call the model more than once per pair and (b) be
sensitive to sampling. Three fixtures pin the contract hermetically through the
injected logit function; the reference-package cross-check runs only when the
`minicheck` package is installed AND explicitly requested.
"""

from __future__ import annotations

import math
import os

import pytest

from nlp.services.entailment_scorer import EntailmentCalibration, LlamaCppMiniCheckScorer

DOCUMENT = "The patient was prescribed metformin 500 mg twice daily for type 2 diabetes."

# (claim, (logit_no, logit_yes)) — the expected support probability is the
# 2-way softmax of the pair, i.e. sigmoid(logit_yes - logit_no).
FIXTURES = [
    ("Metformin was prescribed for diabetes.", (0.0, 4.0)),
    ("The patient was started on insulin.", (4.0, 0.0)),
    ("The prescription was for twice-daily dosing.", (1.0, 1.0)),
]

CALIBRATION = EntailmentCalibration(
    adapter="minicheck-flan-t5",
    label_token_no=3,
    label_token_yes=209,
    supported_min=0.6,
    unsupported_max=0.4,
    document=DOCUMENT,
    supported_claim=FIXTURES[0][0],
    unsupported_claim=FIXTURES[1][0],
)


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def test_three_fixtures_score_as_a_single_step_label_logit_softmax():
    calls: list[str] = []
    logits = dict(FIXTURES)

    def logit_fn(prompt: str) -> tuple[float, float]:
        calls.append(prompt)
        claim = prompt.split("</s>", 1)[1]
        return logits[claim]

    scorer = LlamaCppMiniCheckScorer(logit_fn, CALIBRATION)
    scores = scorer.score_pairs([(DOCUMENT, claim) for claim, _ in FIXTURES])

    # ONE decoder step per pair — never a generation loop.
    assert len(calls) == len(FIXTURES)
    for prompt, (claim, _) in zip(calls, FIXTURES, strict=True):
        assert prompt == f"predict: {DOCUMENT}</s>{claim}"
    for score, (_, (logit_no, logit_yes)) in zip(scores, FIXTURES, strict=True):
        assert score == pytest.approx(_sigmoid(logit_yes - logit_no), abs=1e-9)
    assert scores[0] > CALIBRATION.supported_min
    assert scores[1] < CALIBRATION.unsupported_max
    assert scores[2] == pytest.approx(0.5)


def test_calibration_gate_passes_on_the_fixtures_and_refuses_a_lossy_scorer():
    from nlp.services.entailment_scorer import NliModelUnavailableError

    good = LlamaCppMiniCheckScorer(
        lambda p: (0.0, 4.0) if FIXTURES[0][0] in p else (4.0, 0.0), CALIBRATION
    )
    good.verify_calibration()  # does not raise

    lossy = LlamaCppMiniCheckScorer(lambda _p: (1.0, 1.0), CALIBRATION)  # everything 0.5
    with pytest.raises(NliModelUnavailableError):
        lossy.verify_calibration()


@pytest.mark.skipif(
    os.environ.get("HOPE_MINICHECK_REFERENCE") != "1",
    reason="reference cross-check against the `minicheck` package downloads the Flan-T5 weights; "
    "set HOPE_MINICHECK_REFERENCE=1 to run it (TASK-860 optional gate)",
)
def test_reference_package_agrees_on_the_fixture_direction():
    minicheck = pytest.importorskip(
        "minicheck", reason="`minicheck` reference package is not installed in arcaenv (TASK-860)"
    )
    from minicheck.minicheck import MiniCheck  # type: ignore[import-not-found]

    scorer = MiniCheck(model_name="flan-t5-large", cache_dir=os.environ.get("HF_HOME"))
    _pred, probs, _, _ = scorer.score(docs=[DOCUMENT] * 2, claims=[FIXTURES[0][0], FIXTURES[1][0]])
    assert probs[0] > CALIBRATION.supported_min
    assert probs[1] < CALIBRATION.unsupported_max
    assert hasattr(minicheck, "__file__")
