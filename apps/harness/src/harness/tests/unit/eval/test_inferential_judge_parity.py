"""E0 parity instrument tests — the R-8 go/no-go gate (TASK-355 R-8).

A faster judge is worthless if it loosens a verdict (Phase-B batching proved this is a
*real* clinical risk, not noise). This module scores the live groundedness sensor with
TWO judges over the same claims and reports the **directional confusion matrix**:

* **unsafe flip** = incumbent says *ungrounded*, candidate says *grounded* (candidate
  LOOSENED — the unsafe direction; the gate forbids these);
* **safe flip** = incumbent grounded, candidate ungrounded (candidate stricter — tolerable).

These tests pin (1) the pure confusion math, (2) the zero-unsafe-flip gate in the
summary, and (3) that an end-to-end run with a deliberately-looser candidate is CAUGHT
(the whole point of the instrument).
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.eval.inferential_judge_parity import (
    ClaimDisagreement,
    ParityCaseResult,
    diff_verdicts,
    score_case_parity,
    summarize_parity,
)
from harness.eval.judge.base import JudgeConnectionError, Messages
from harness.eval.models import GoldenCase
from harness.sensors.inferential.granite_client import _split_premise_hypothesis


class _StubJudge:
    """A ``JudgeClient`` that calls a hypothesis *ungrounded* iff it contains a marker."""

    def __init__(self, model: str, ungrounded_markers: tuple[str, ...] = ()) -> None:
        self.model = model
        self._markers = ungrounded_markers

    async def complete(
        self, messages: Messages, *, json_mode: bool = False, temperature: float | None = None, seed: int | None = None
    ) -> str:
        _, hypothesis = _split_premise_hypothesis(messages)
        supported = not any(m in hypothesis for m in self._markers)
        return '{"supported": true}' if supported else '{"supported": false}'


class _BrokenJudge:
    model = "broken"

    async def complete(self, messages: Messages, **_: Any) -> str:
        raise JudgeConnectionError("backend down")


_CLAIMS = [{"id": "c-1", "text": "alpha"}, {"id": "c-2", "text": "bravo"}, {"id": "c-3", "text": "charlie"}]


class TestDiffVerdicts:
    def test_full_agreement_has_no_flips(self):
        counts, dis = diff_verdicts(_CLAIMS, {"c-2"}, {"c-2"}, case_id="x", transcript="t")
        assert counts == {"n_claims": 3, "agree": 3, "unsafe_flips": 0, "safe_flips": 0}
        assert dis == []

    def test_candidate_loosening_is_an_unsafe_flip(self):
        # incumbent flags c-2 ungrounded; candidate says everything grounded.
        counts, dis = diff_verdicts(_CLAIMS, {"c-2"}, set(), case_id="x", transcript="the transcript")
        assert counts == {"n_claims": 3, "agree": 2, "unsafe_flips": 1, "safe_flips": 0}
        assert len(dis) == 1
        assert dis[0].kind == "unsafe_flip"
        assert dis[0].claim_ref == "c-2"
        assert dis[0].claim_text == "bravo"
        assert dis[0].incumbent_grounded is False
        assert dis[0].candidate_grounded is True

    def test_candidate_over_flagging_is_a_safe_flip(self):
        counts, dis = diff_verdicts(_CLAIMS, set(), {"c-3"}, case_id="x", transcript="t")
        assert counts == {"n_claims": 3, "agree": 2, "unsafe_flips": 0, "safe_flips": 1}
        assert dis[0].kind == "safe_flip"
        assert dis[0].claim_ref == "c-3"

    def test_empty_text_claims_are_not_compared(self):
        claims = [{"id": "c-1", "text": ""}, {"id": "c-2", "text": "bravo"}]
        counts, _ = diff_verdicts(claims, set(), set(), case_id="x", transcript="t")
        assert counts["n_claims"] == 1  # only the non-empty claim is verifiable


def _case_result(**overrides: Any) -> ParityCaseResult:
    base: dict[str, Any] = {
        "case_id": "c1",
        "role": "calibration",
        "n_claims": 3,
        "agree": 3,
        "unsafe_flips": 0,
        "safe_flips": 0,
        "incumbent_degraded": False,
        "candidate_degraded": False,
        "incumbent_elapsed_s": 1.0,
        "candidate_elapsed_s": 0.2,
        "disagreements": [],
    }
    base.update(overrides)
    return ParityCaseResult(**base)


class TestSummarize:
    def test_zero_unsafe_flips_passes_the_gate(self):
        agg = summarize_parity([_case_result(safe_flips=2)])
        assert agg["unsafe_flips_total"] == 0
        assert agg["safe_flips_total"] == 2
        assert agg["passed"] is True

    def test_any_unsafe_flip_fails_the_gate(self):
        bad = _case_result(
            case_id="c2",
            agree=2,
            unsafe_flips=1,
            disagreements=[
                ClaimDisagreement(
                    case_id="c2",
                    claim_ref="c2-claim-2",
                    claim_text="x",
                    section="A",
                    premise_excerpt="...",
                    incumbent_grounded=False,
                    candidate_grounded=True,
                    kind="unsafe_flip",
                )
            ],
        )
        agg = summarize_parity([_case_result(), bad])
        assert agg["unsafe_flips_total"] == 1
        assert agg["passed"] is False
        assert len(agg["unsafe_flip_disagreements"]) == 1

    def test_latency_means_reported(self):
        agg = summarize_parity([_case_result(incumbent_elapsed_s=2.0, candidate_elapsed_s=0.4)])
        assert agg["incumbent_mean_elapsed_s"] == 2.0
        assert agg["candidate_mean_elapsed_s"] == 0.4

    def test_degraded_case_counted_and_excluded_from_gate(self):
        deg = _case_result(case_id="c3", n_claims=0, agree=0, candidate_degraded=True)
        agg = summarize_parity([deg])
        assert agg["n_candidate_degraded"] == 1
        # No comparable claims anywhere -> the gate cannot pass on zero evidence.
        assert agg["n_claims_compared"] == 0
        assert agg["passed"] is False


def _golden_case() -> GoldenCase:
    return GoldenCase(
        case_id="gc",
        source_documents=["Patient reports a cough."],
        generated_note=(
            "Subjective: Patient reports a cough. Patient denies fever.\n"
            "Objective: Temperature is 38 C."
        ),
        role="calibration",
    )


class TestScoreCaseParity:
    @pytest.mark.asyncio
    async def test_detects_a_candidate_that_loosens_a_verdict(self):
        incumbent = _StubJudge("incumbent", ungrounded_markers=("denies fever",))
        candidate = _StubJudge("candidate")  # says everything grounded -> loosens
        res = await score_case_parity(_golden_case(), incumbent=incumbent, candidate=candidate, threshold=0.8)
        assert res.unsafe_flips == 1
        assert res.safe_flips == 0
        assert any(d.kind == "unsafe_flip" and "denies fever" in d.claim_text for d in res.disagreements)

    @pytest.mark.asyncio
    async def test_agreeing_candidate_has_no_flips(self):
        incumbent = _StubJudge("incumbent", ungrounded_markers=("denies fever",))
        candidate = _StubJudge("candidate", ungrounded_markers=("denies fever",))
        res = await score_case_parity(_golden_case(), incumbent=incumbent, candidate=candidate, threshold=0.8)
        assert res.unsafe_flips == 0
        assert res.safe_flips == 0
        assert res.disagreements == []

    @pytest.mark.asyncio
    async def test_candidate_backend_failure_marks_degraded_not_a_flip(self):
        res = await score_case_parity(
            _golden_case(), incumbent=_StubJudge("incumbent"), candidate=_BrokenJudge(), threshold=0.8
        )
        assert res.candidate_degraded is True
        assert res.unsafe_flips == 0
        assert res.disagreements == []
