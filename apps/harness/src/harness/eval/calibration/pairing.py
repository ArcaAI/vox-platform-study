"""Turn paired PDSQI-9 scores into rater matrices for reliability stats.

Pools the present 1–5 Likert dimensions across cases into two aligned 1-D arrays
(``judge`` vs ``human``), the input to :func:`intraclass_correlation` /
:func:`gwet_ac2`.
"""

from __future__ import annotations

import numpy as np

from harness.eval.models import PDSQI_LIKERT_DIMENSIONS, PDSQIScore


def pdsqi_likert_pairs(
    judge_scores: list[PDSQIScore], human_scores: list[PDSQIScore]
) -> tuple[np.ndarray, np.ndarray]:
    """Pool the common present Likert dimensions across cases.

    For each case, every 1–5 dimension present in *both* the judge and clinician
    score contributes one paired observation.
    """
    if len(judge_scores) != len(human_scores):
        raise ValueError("judge_scores and human_scores must have equal length")

    judge_vals: list[int] = []
    human_vals: list[int] = []
    for judge, human in zip(judge_scores, human_scores, strict=False):
        j_items = judge.likert_items()
        h_items = human.likert_items()
        for dim in PDSQI_LIKERT_DIMENSIONS:
            if dim in j_items and dim in h_items:
                judge_vals.append(j_items[dim])
                human_vals.append(h_items[dim])

    return np.array(judge_vals, dtype=float), np.array(human_vals, dtype=float)
