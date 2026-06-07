"""Citation-verify inferential-sensor tests (RED-first, TASK-330 Phase 3, Lane A).

Forked from groundedness, but the premise is the **cited chunk text ONLY** (looked
up from ``ctx.knowledge_chunks`` by each claim's ``knowledgeChunkIds``), not the
transcript. Only claims that actually cite a chunk are verified; uncited claims are
out of scope (groundedness owns transcript entailment). ``score`` is the supported
fraction over cited claims; a judge-backend failure degrades (``degraded=True``,
never auto-PASS, never raises) so the loop can surface the "unverified" badge.
"""

from __future__ import annotations

import pytest

from harness.eval.judge.base import JudgeConnectionError
from harness.sensors.base import SensorContext
from harness.sensors.inferential.base import InferentialSensor
from harness.sensors.inferential.citation_verify import NAME, CitationVerifySensor

from ._fixtures import claim


class _Judge:
    """Stub judge: ``supported`` unless the hypothesis hits an unsupported marker."""

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
    model = "stub-judge"

    async def complete(self, *args: object, **kwargs: object) -> str:
        raise JudgeConnectionError("judge backend offline")


def _ctx(claims: list[dict], chunks: dict[str, str]) -> SensorContext:
    return SensorContext(
        note_text="generated note",
        transcript_text="unrelated transcript text",
        citations_map={"claims": claims},
        knowledge_chunks=chunks,
    )


class TestConformance:
    def test_is_an_inferential_sensor(self):
        assert isinstance(CitationVerifySensor(), InferentialSensor)

    def test_name_is_citation_verify(self):
        assert CitationVerifySensor().name == NAME == "citation_verify"


class TestCitationVerify:
    @pytest.mark.asyncio
    async def test_cited_claim_supported_by_its_chunk_passes(self):
        claims = [
            claim("c-1", text="thiazide is first-line", section="P", knowledge_chunk_ids=["kc-1"]),
        ]
        chunks = {"kc-1": "First-line therapy for hypertension is a thiazide diuretic."}
        judge = _Judge()
        result = await CitationVerifySensor(threshold=0.8).arun(_ctx(claims, chunks), judge=judge)

        assert result.name == NAME
        assert result.passed is True
        assert result.score == pytest.approx(1.0)
        assert result.degraded is False
        # The premise is the cited chunk text (not the transcript).
        assert "thiazide diuretic" in judge.calls[0][-1]["content"]
        assert "unrelated transcript" not in judge.calls[0][-1]["content"]

    @pytest.mark.asyncio
    async def test_unsupported_cited_claim_is_flagged_and_fails(self):
        claims = [
            claim("c-ok", text="thiazide first-line", section="P", knowledge_chunk_ids=["kc-1"]),
            claim(
                "c-bad", text="penicillin cures sepsis", section="A", knowledge_chunk_ids=["kc-2"]
            ),
        ]
        chunks = {
            "kc-1": "First-line therapy is a thiazide.",
            "kc-2": "Sepsis requires broad-spectrum antibiotics and source control.",
        }
        result = await CitationVerifySensor(threshold=0.8).arun(
            _ctx(claims, chunks), judge=_Judge(unsupported_markers=("penicillin",))
        )
        assert result.passed is False
        assert result.score == pytest.approx(0.5)
        assert result.claims_flagged == ["c-bad"]
        # The offending claim's section is surfaced for a targeted regen.
        assert result.details["sections"] == ["A"]

    @pytest.mark.asyncio
    async def test_uncited_claims_are_out_of_scope(self):
        # A claim with no knowledgeChunkIds is groundedness' job, not citation-verify.
        claims = [
            claim("c-cited", text="thiazide", section="P", knowledge_chunk_ids=["kc-1"]),
            claim("c-uncited", text="patient is tired", section="S"),
        ]
        chunks = {"kc-1": "Thiazide is first-line."}
        judge = _Judge()
        result = await CitationVerifySensor().arun(_ctx(claims, chunks), judge=judge)

        assert result.details["total"] == 1, "only the cited claim is verified"
        assert len(judge.calls) == 1
        assert result.passed is True

    @pytest.mark.asyncio
    async def test_no_cited_claims_is_vacuous_pass(self):
        claims = [claim("c-uncited", text="patient is tired", section="S")]
        judge = _Judge()
        result = await CitationVerifySensor().arun(_ctx(claims, {}), judge=judge)
        assert result.passed is True
        assert result.score == pytest.approx(1.0)
        assert judge.calls == []

    @pytest.mark.asyncio
    async def test_cited_id_with_missing_chunk_text_is_unverifiable_fail(self):
        # The model cited an id we cannot resolve to text -> cannot confirm -> fail
        # that claim (never auto-PASS an unverifiable citation).
        claims = [claim("c-1", text="thiazide", section="P", knowledge_chunk_ids=["kc-404"])]
        result = await CitationVerifySensor().arun(_ctx(claims, {}), judge=_Judge())
        assert result.passed is False
        assert result.claims_flagged == ["c-1"]


class TestDegrade:
    @pytest.mark.asyncio
    async def test_judge_backend_failure_degrades_never_raises(self):
        claims = [claim("c-1", text="thiazide", section="P", knowledge_chunk_ids=["kc-1"])]
        result = await CitationVerifySensor().arun(
            _ctx(claims, {"kc-1": "Thiazide is first-line."}), judge=_FailingJudge()
        )
        assert result.degraded is True
        assert result.passed is False
        assert result.score == 0.0
