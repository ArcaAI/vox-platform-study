"""Golden verdict-stability + conservative-batch tests (TASK-355 Phase B / R-5).

The batching change MUST NOT change verdicts: with a judge that decides each
hypothesis identically whether asked one-at-a-time or in a JSON-array batch, the
full ``SensorResult`` is byte-identical for ``batch_size=1`` (per-claim path) and
``batch_size=3`` (forces ≥2 groups). Batch-specific failure modes (a truncated
group, a backend error) degrade conservatively (claims ungrounded / sensor
degraded), never the looser direction.
"""

from __future__ import annotations

import json

import pytest

from harness.eval.jsonio import loads_json
from harness.eval.judge.base import JudgeConnectionError
from harness.sensors.base import SensorContext
from harness.sensors.inferential.groundedness import GroundednessSensor

from ._fixtures import claim, evidence


class _ConsistentJudge:
    """Decides each hypothesis identically in single-object and array call shapes."""

    model = "stub-judge"

    def __init__(self, *, unsupported_markers: tuple[str, ...] = ()) -> None:
        self.calls: list[list[dict[str, str]]] = []
        self._markers = unsupported_markers

    def _supported(self, hypothesis: str) -> bool:
        h = hypothesis.lower()
        return not any(m in h for m in self._markers)

    async def complete(
        self,
        messages: list[dict[str, str]],
        *,
        json_mode: bool = False,
        temperature: float | None = None,
        seed: int | None = None,
    ) -> str:
        self.calls.append(messages)
        content = messages[-1]["content"]
        if "CLAIMS:" in content:  # batch shape: embedded JSON array of items
            items = loads_json(content[content.index("CLAIMS:") :])
            out = [
                {"id": it["id"], "supported": self._supported(str(it.get("hypothesis", "")))}
                for it in items
            ]
            return json.dumps(out)
        hypothesis = content.split("HYPOTHESIS:")[-1]
        return json.dumps({"supported": self._supported(hypothesis)})


def _six_claims() -> list[dict]:
    return [
        claim("c-s", text="reports headache", section="S", evidence=[evidence(quote="headache")]),
        claim("c-o", text="BP 150 over 95", section="O", evidence=[evidence(quote="BP 150/95")]),
        claim("c-a", text="essential hypertension", section="A"),
        claim("c-pen", text="penicillin allergy", section="P"),  # ungrounded marker
        claim("c-p", text="follow up in four weeks", section="P"),
        claim("c-warf", text="warfarin started", section="A"),  # ungrounded marker
    ]


def _ctx(claims: list[dict]) -> SensorContext:
    return SensorContext(
        note_text="generated note",
        transcript_text="Patient reports headache. BP 150/95. Essential hypertension. Follow up in four weeks.",
        citations_map={"claims": claims},
    )


class TestGoldenParity:
    @pytest.mark.asyncio
    async def test_single_vs_batch_results_are_identical(self):
        markers = ("penicillin", "warfarin")
        per_claim = await GroundednessSensor(threshold=0.8, batch_size=1).arun(
            _ctx(_six_claims()), judge=_ConsistentJudge(unsupported_markers=markers)
        )
        batched = await GroundednessSensor(threshold=0.8, batch_size=3).arun(
            _ctx(_six_claims()), judge=_ConsistentJudge(unsupported_markers=markers)
        )

        assert per_claim.score == batched.score
        assert per_claim.passed == batched.passed
        assert per_claim.claims_flagged == batched.claims_flagged
        assert per_claim.details == batched.details

    @pytest.mark.asyncio
    async def test_batch_uses_fewer_calls(self):
        judge = _ConsistentJudge()
        await GroundednessSensor(threshold=0.8, batch_size=3).arun(_ctx(_six_claims()), judge=judge)
        # 6 claims / batch 3 => 2 array calls (vs 6 per-claim calls).
        assert len(judge.calls) == 2


class TestBatchConservative:
    @pytest.mark.asyncio
    async def test_truncated_group_only_flags_that_group(self):
        class _TruncFirstGroup:
            model = "stub-judge"

            def __init__(self) -> None:
                self.calls = 0

            async def complete(self, messages, *, json_mode=False, temperature=None, seed=None):
                self.calls += 1
                content = messages[-1]["content"]
                items = loads_json(content[content.index("CLAIMS:") :])
                ids = [it["id"] for it in items]
                if "c-s" in ids:  # group 1 -> truncated/unparseable
                    return '[{"id":"c-s","supported":tru'
                return json.dumps([{"id": i, "supported": True} for i in ids])

        result = await GroundednessSensor(threshold=0.8, batch_size=3).arun(
            _ctx(_six_claims()), judge=_TruncFirstGroup()
        )
        # group 1 (c-s, c-o, c-a) all ungrounded; group 2 (c-pen, c-p, c-warf) grounded.
        assert result.score == pytest.approx(0.5)
        assert result.claims_flagged == ["c-s", "c-o", "c-a"]

    @pytest.mark.asyncio
    async def test_batch_backend_failure_degrades_never_raises(self):
        class _Failing:
            model = "stub-judge"

            async def complete(self, *a, **k):
                raise JudgeConnectionError("judge offline")

        result = await GroundednessSensor(threshold=0.8, batch_size=3).arun(
            _ctx(_six_claims()), judge=_Failing()
        )
        assert result.degraded is True
        assert result.passed is False
        assert result.score == 0.0
