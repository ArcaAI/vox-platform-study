"""Groundedness inferential-sensor tests (RED-first, TASK-330 Phase 2).

Heuristic under test: each ``citationsMap`` claim is entailment-checked against
(transcript ∪ that claim's own evidence) via the injected
:class:`~harness.eval.judge.base.JudgeClient`. ``score`` is the grounded fraction;
``passed`` is ``score >= groundedness_threshold`` (constructor-injected);
``claims_flagged`` are the ungrounded claim ids. The sensor also emits a RAG-triad
(``context_relevance`` / ``groundedness`` / ``answer_relevance``) plus the offending
SOAP ``sections`` into ``details`` for the later persistence/regen phase. A judge
backend failure must degrade (never auto-PASS, never raise into the loop).
"""

from __future__ import annotations

import pytest

from harness.eval.judge.base import JudgeClient, JudgeConnectionError
from harness.sensors.base import SensorContext
from harness.sensors.inferential.base import InferentialSensor
from harness.sensors.inferential.groundedness import NAME, GroundednessSensor

from ._fixtures import claim, evidence


class _Judge:
    """Stub :class:`JudgeClient`: ``supported`` unless the hypothesis hits a marker."""

    model = "stub-judge"

    def __init__(self, *, unsupported_markers: tuple[str, ...] = ()) -> None:
        self.calls: list[list[dict[str, str]]] = []
        self._markers = unsupported_markers

    async def complete(
        self,
        messages: list[dict[str, str]],
        *,
        json_mode: bool = False,
        temperature: float | None = None,
        seed: int | None = None,
    ) -> str:
        self.calls.append(messages)
        content = messages[-1]["content"].lower()
        unsupported = any(marker in content for marker in self._markers)
        return '{"supported": false}' if unsupported else '{"supported": true}'


class _FailingJudge:
    """A judge whose backend is unreachable (drives the reduced-assurance path)."""

    model = "stub-judge"

    async def complete(self, *args: object, **kwargs: object) -> str:
        raise JudgeConnectionError("judge backend offline")


def _ctx(
    claims: list[dict], *, transcript: str = "Patient has hypertension; BP elevated."
) -> SensorContext:
    return SensorContext(
        note_text="generated note",
        transcript_text=transcript,
        citations_map={"claims": claims},
    )


class TestConformance:
    def test_is_an_inferential_sensor(self):
        assert isinstance(GroundednessSensor(), InferentialSensor)

    def test_name_is_groundedness(self):
        assert GroundednessSensor().name == NAME == "groundedness"


class TestGroundedness:
    @pytest.mark.asyncio
    async def test_all_claims_grounded_passes(self):
        claims = [
            claim(
                "c-htn", text="hypertension", section="A", evidence=[evidence(quote="hypertension")]
            ),
            claim(
                "c-bp", text="BP elevated", section="O", evidence=[evidence(quote="BP elevated")]
            ),
        ]
        judge = _Judge()
        result = await GroundednessSensor(threshold=0.8).arun(_ctx(claims), judge=judge)

        assert result.name == NAME
        assert result.passed is True
        assert result.score == pytest.approx(1.0)
        assert result.claims_flagged == []
        assert result.degraded is False
        assert len(judge.calls) == 2, "one entailment call per claim"

    @pytest.mark.asyncio
    async def test_ungrounded_claim_is_flagged_and_fails(self):
        claims = [
            claim("c-pen", text="penicillin allergy", section="P"),  # not in transcript
            claim(
                "c-htn", text="hypertension", section="A", evidence=[evidence(quote="hypertension")]
            ),
        ]
        result = await GroundednessSensor(threshold=0.8).arun(
            _ctx(claims), judge=_Judge(unsupported_markers=("penicillin",))
        )

        assert result.passed is False
        assert result.score == pytest.approx(0.5)
        assert result.claims_flagged == ["c-pen"]

    @pytest.mark.asyncio
    async def test_threshold_is_constructor_injected(self):
        claims = [
            claim("c-pen", text="penicillin allergy", section="P"),
            claim("c-htn", text="hypertension", section="A"),
            claim("c-bp", text="BP elevated", section="O"),
            claim("c-hr", text="heart rate normal", section="O"),
        ]
        # 3/4 grounded = 0.75: fails the default 0.8 but passes a lenient 0.7.
        judge = _Judge(unsupported_markers=("penicillin",))
        strict = await GroundednessSensor(threshold=0.8).arun(_ctx(claims), judge=judge)
        lenient = await GroundednessSensor(threshold=0.7).arun(
            _ctx(claims), judge=_Judge(unsupported_markers=("penicillin",))
        )

        assert strict.score == pytest.approx(0.75)
        assert strict.passed is False
        assert lenient.passed is True


class TestRagTriad:
    @pytest.mark.asyncio
    async def test_details_carry_rag_triad_breakdown_and_sections(self):
        claims = [
            claim("c-pen", text="penicillin allergy", section="P"),  # no evidence, ungrounded
            claim(
                "c-htn", text="hypertension", section="A", evidence=[evidence(quote="hypertension")]
            ),
        ]
        result = await GroundednessSensor().arun(
            _ctx(claims), judge=_Judge(unsupported_markers=("penicillin",))
        )

        details = result.details
        # groundedness 0.5; context-relevance 0.5 (1/2 claims carry evidence);
        # answer-relevance 1.0 (both claims assert text) => mean ~= 0.6667.
        assert details["rag_triad_score"] == pytest.approx((0.5 + 0.5 + 1.0) / 3)
        triad = details["rag_triad"]
        assert triad["groundedness"] == pytest.approx(0.5)
        assert triad["context_relevance"] == pytest.approx(0.5)
        assert triad["answer_relevance"] == pytest.approx(1.0)
        # The ungrounded claim sits in the Plan section -> regen target "P".
        assert details["sections"] == ["P"]
        assert details["ungrounded"] == ["c-pen"]
        assert details["total"] == 2

    @pytest.mark.asyncio
    async def test_all_grounded_triad_is_one_and_no_sections(self):
        claims = [
            claim(
                "c-htn", text="hypertension", section="A", evidence=[evidence(quote="hypertension")]
            ),
        ]
        result = await GroundednessSensor().arun(_ctx(claims), judge=_Judge())
        assert result.details["rag_triad_score"] == pytest.approx(1.0)
        assert result.details["sections"] == []


class TestDegradeAndEmpty:
    @pytest.mark.asyncio
    async def test_judge_backend_failure_degrades_never_raises(self):
        claims = [claim("c-htn", text="hypertension", section="A")]
        result = await GroundednessSensor().arun(_ctx(claims), judge=_FailingJudge())
        assert result.degraded is True
        assert result.passed is False
        assert result.score == 0.0

    @pytest.mark.asyncio
    async def test_no_claims_is_vacuously_grounded(self):
        # citation_presence owns the "note but no claims" degradation; groundedness
        # has nothing to entail, so it vacuously passes without calling the judge.
        judge = _Judge()
        result = await GroundednessSensor().arun(_ctx([]), judge=judge)
        assert result.passed is True
        assert result.score == pytest.approx(1.0)
        assert judge.calls == []


class TestOnClaimCallback:
    """TASK-355 Phase D Slice 5d (Q5) — the per-claim path notifies an optional
    ``on_claim(claim_id, supported)`` callback AS EACH verdict resolves, so the
    activity can stream it live. Best-effort + verdict-preserving: a callback that
    raises must NEVER degrade the pass or change the aggregate verdict."""

    @pytest.mark.asyncio
    async def test_on_claim_fires_once_per_verifiable_claim_with_its_verdict(self):
        claims = [
            claim("c-pen", text="penicillin allergy", section="P"),  # ungrounded
            claim("c-htn", text="hypertension", section="A", evidence=[evidence(quote="hypertension")]),
        ]
        seen: list[tuple[str, bool]] = []

        async def on_claim(claim_id: str, supported: bool) -> None:
            seen.append((claim_id, supported))

        result = await GroundednessSensor(threshold=0.8).arun(
            _ctx(claims), judge=_Judge(unsupported_markers=("penicillin",)), on_claim=on_claim
        )

        # One callback per claim, each carrying that claim's resolved verdict.
        assert sorted(seen) == [("c-htn", True), ("c-pen", False)]
        # The aggregate is unchanged by the callback (parity with the no-callback path).
        assert result.score == pytest.approx(0.5)
        assert result.claims_flagged == ["c-pen"]

    @pytest.mark.asyncio
    async def test_empty_hypothesis_claim_does_not_emit(self):
        # An empty claim asserts nothing (aggregated grounded) and makes no judge
        # call — so it must not produce a live event either. (The `claim` helper
        # substitutes the id for empty text, so override text="" directly.)
        claims = [{**claim("c-empty"), "text": ""}, claim("c-htn", text="hypertension")]
        seen: list[tuple[str, bool]] = []

        async def on_claim(claim_id: str, supported: bool) -> None:
            seen.append((claim_id, supported))

        await GroundednessSensor().arun(_ctx(claims), judge=_Judge(), on_claim=on_claim)

        assert [c for c, _ in seen] == ["c-htn"]

    @pytest.mark.asyncio
    async def test_callback_error_never_degrades_or_changes_the_verdict(self):
        claims = [
            claim("c-pen", text="penicillin allergy", section="P"),
            claim("c-htn", text="hypertension", section="A"),
        ]

        async def on_claim(claim_id: str, supported: bool) -> None:
            raise RuntimeError("redis down")

        result = await GroundednessSensor(threshold=0.8).arun(
            _ctx(claims), judge=_Judge(unsupported_markers=("penicillin",)), on_claim=on_claim
        )

        # The pass completes normally — a broken live feed is swallowed.
        assert result.degraded is False
        assert result.score == pytest.approx(0.5)
        assert result.claims_flagged == ["c-pen"]

    @pytest.mark.asyncio
    async def test_no_callback_keeps_the_legacy_signature_working(self):
        # Omitting on_claim is the legacy call site — must behave exactly as before.
        claims = [claim("c-htn", text="hypertension")]
        result = await GroundednessSensor().arun(_ctx(claims), judge=_Judge())
        assert result.passed is True


def test_arun_is_a_coroutine_using_the_injected_judge():
    """The shared judge is passed per-call (not constructor-injected)."""
    import inspect

    assert inspect.iscoroutinefunction(GroundednessSensor.arun)
    sig = inspect.signature(GroundednessSensor.arun)
    assert "judge" in sig.parameters
    assert isinstance(_Judge(), JudgeClient)
