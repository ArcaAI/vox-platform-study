"""The entity-grounding sensor's contract.

Behaviour under test, in the order it matters:

1. the lexical floor is never lowered — a lexically grounded entity stays grounded, and the
   backend is not even consulted when the residue is empty;
2. entailment can *withdraw* a flag (the recovery this ticket exists for);
3. entailment can *never create* one — a backend that refuses everything reproduces the
   incumbent verdict exactly;
4. a backend failure falls back to the lexical verdict rather than degrading, and the
   fallback can only ever flag MORE than a successful escalation;
5. both directions work off the same code with the premise swapped.

Run: ``pnpm harness:test -k entity_grounding_task671``
"""

from __future__ import annotations

import pytest

from harness.sensors.base import NEREntity, SensorContext
from harness.sensors.computational.coverage_omission import CoverageOmissionSensor
from harness.sensors.computational.entity_faithfulness import EntityFaithfulnessSensor
from harness.sensors.inferential.atomic_fact import DeterministicOverlapEntailer
from harness.sensors.inferential.entity_grounding import (
    NAME_COVERAGE,
    NAME_FAITHFULNESS,
    Direction,
    EntityGroundingSensor,
    frame_entity,
)

TRANSCRIPT = "She has been taking Tylenol three times a day and a Ventolin puffer when needed."
NOTE = "Plan: continue paracetamol three times daily and salbutamol inhaler as required."


def _ents(*texts: str, assertion: str | None = None) -> list[NEREntity]:
    return [NEREntity(text=t, type="CLINICAL", assertion=assertion) for t in texts]


class _Entailer:
    """Recording test double: entails exactly the hypotheses whose entity is allow-listed."""

    def __init__(self, *entailed: str) -> None:
        self._entailed = entailed
        self.calls: list[str] = []

    async def entail(self, premise: str, hypothesis: str) -> bool:
        self.calls.append(hypothesis)
        return any(e in hypothesis for e in self._entailed)


class _BrokenEntailer:
    """Backend outage."""

    async def entail(self, premise: str, hypothesis: str) -> bool:
        raise RuntimeError("NLI backend unavailable")


def _ctx(note_entities: list[NEREntity], transcript_entities: list[NEREntity]) -> SensorContext:
    return SensorContext(
        note_text=NOTE,
        transcript_text=TRANSCRIPT,
        note_entities=note_entities,
        transcript_entities=transcript_entities,
    )


def _faithfulness(entailer, threshold: float = 1.0) -> EntityGroundingSensor:
    return EntityGroundingSensor(
        entailer, direction=Direction.FAITHFULNESS, threshold=threshold
    )


class TestFraming:
    def test_entity_becomes_a_proposition(self) -> None:
        framed = frame_entity("bilateral peripheral oedema")
        assert "bilateral peripheral oedema" in framed
        assert framed.endswith(".")
        assert framed != "bilateral peripheral oedema"

    def test_framing_is_whitespace_stable(self) -> None:
        assert frame_entity("  paracetamol  ") == frame_entity("paracetamol")


class TestLexicalFloorIsPreserved:
    async def test_lexically_grounded_entities_pass_without_touching_the_backend(self) -> None:
        entailer = _Entailer()
        ctx = _ctx(_ents("Tylenol", "Ventolin"), _ents("Tylenol", "Ventolin"))
        result = await _faithfulness(entailer).arun(ctx)

        assert result.passed
        assert result.score == 1.0
        assert entailer.calls == [], "backend consulted despite an empty residue"
        assert result.details["escalated"] == 0

    async def test_matches_the_incumbent_when_nothing_is_escalated(self) -> None:
        ctx = _ctx(_ents("Tylenol"), _ents("Tylenol"))
        incumbent = EntityFaithfulnessSensor(threshold=1.0).run(ctx)
        escalated = await _faithfulness(_Entailer()).arun(ctx)
        assert escalated.score == incumbent.score
        assert escalated.passed == incumbent.passed

    async def test_absent_note_entities_are_excluded_like_the_incumbent(self) -> None:
        """"no chest pain" is not a positive claim needing grounding."""
        ctx = _ctx(_ents("chest pain", assertion="ABSENT"), _ents("Tylenol"))
        result = await _faithfulness(_Entailer()).arun(ctx)
        assert result.passed
        assert result.details["total"] == 0


class TestEntailmentWithdrawsFlags:
    async def test_an_entailed_abstraction_is_recovered(self) -> None:
        entailer = _Entailer("paracetamol", "salbutamol")
        ctx = _ctx(_ents("paracetamol", "salbutamol"), _ents("Tylenol", "Ventolin"))

        incumbent = EntityFaithfulnessSensor(threshold=1.0).run(ctx)
        assert incumbent.score == 0.0, "precondition: the incumbent flags both"

        result = await _faithfulness(entailer).arun(ctx)
        assert result.score == 1.0
        assert result.passed
        assert result.details["escalated"] == 2
        assert result.details["recovered_by_entailment"] == ["paracetamol", "salbutamol"]

    async def test_only_the_residue_is_escalated(self) -> None:
        entailer = _Entailer("paracetamol")
        ctx = _ctx(_ents("Tylenol", "paracetamol"), _ents("Tylenol"))
        await _faithfulness(entailer).arun(ctx)
        assert len(entailer.calls) == 1
        assert "paracetamol" in entailer.calls[0]


class TestEntailmentNeverCreatesFlags:
    async def test_a_refusing_backend_reproduces_the_incumbent_exactly(self) -> None:
        """The safety-critical property: inference cannot make the gate stricter."""
        ctx = _ctx(_ents("paracetamol", "Tylenol"), _ents("Tylenol"))
        incumbent = EntityFaithfulnessSensor(threshold=1.0).run(ctx)
        result = await _faithfulness(_Entailer()).arun(ctx)  # entails nothing

        assert result.score == incumbent.score
        assert set(result.claims_flagged) == set(incumbent.claims_flagged)

    async def test_an_unentailed_fabrication_stays_flagged(self) -> None:
        entailer = _Entailer("paracetamol")  # tramadol is NOT entailed
        ctx = _ctx(_ents("tramadol"), _ents("Tylenol"))
        result = await _faithfulness(entailer).arun(ctx)

        assert not result.passed
        assert result.score == 0.0
        assert result.claims_flagged == ["tramadol"]
        assert result.details["recovered_by_entailment"] == []


class TestBackendFailureFallsBackToLexical:
    async def test_outage_yields_the_lexical_verdict_not_a_degrade(self) -> None:
        ctx = _ctx(_ents("Tylenol", "paracetamol"), _ents("Tylenol"))
        incumbent = EntityFaithfulnessSensor(threshold=1.0).run(ctx)
        result = await _faithfulness(_BrokenEntailer()).arun(ctx)

        assert result.details["escalation_unavailable"] is True
        assert result.score == incumbent.score
        assert set(result.claims_flagged) == set(incumbent.claims_flagged)
        # Explicitly NOT the sibling sensors' degrade contract: no `degraded` marker, so the
        # aggregator applies this sensor's normal severity instead of a blanket FLAG.
        assert not result.degraded

    async def test_an_empty_premise_falls_back_rather_than_affirming(self) -> None:
        ctx = SensorContext(
            note_text=NOTE,
            transcript_text="",
            note_entities=_ents("paracetamol"),
            transcript_entities=[],
        )
        result = await _faithfulness(_Entailer("paracetamol")).arun(ctx)
        assert result.details["escalation_unavailable"] is True
        assert not result.passed

    async def test_the_default_overlap_entailer_never_loosens(self) -> None:
        """The `DeterministicOverlapEntailer` fallback must not silently re-lexicalize.

        It is the model-free default when no NLI is provisioned. Whatever it does, it may
        not ground anything the lexical floor did not already ground — otherwise an
        un-provisioned deployment gets a *different, unvalidated* matcher rather than the
        incumbent's.
        """
        ctx = _ctx(_ents("paracetamol", "salbutamol", "tramadol"), _ents("Tylenol", "Ventolin"))
        incumbent = EntityFaithfulnessSensor(threshold=1.0).run(ctx)
        result = await _faithfulness(DeterministicOverlapEntailer()).arun(ctx)
        assert result.score == incumbent.score
        assert result.details["recovered_by_entailment"] == [], (
            "the model-free overlap entailer recovered an entity — it is a token-overlap "
            "check, so anything it 'entails' is a lexical match by another name"
        )


class TestCoverageDirection:
    async def test_premise_is_the_note_and_hypotheses_are_transcript_entities(self) -> None:
        entailer = _Entailer("Tylenol", "Ventolin")
        ctx = _ctx(_ents("paracetamol", "salbutamol"), _ents("Tylenol", "Ventolin"))

        incumbent = CoverageOmissionSensor(threshold=0.8).run(ctx)
        assert incumbent.score == 0.0, "precondition: the incumbent calls both omitted"

        sensor = EntityGroundingSensor(entailer, direction=Direction.COVERAGE, threshold=0.8)
        result = await sensor.arun(ctx)

        assert result.name == NAME_COVERAGE
        assert result.passed
        assert result.score == 1.0
        assert sorted(result.details["recovered_by_entailment"]) == ["Tylenol", "Ventolin"]

    async def test_names_are_distinct_per_direction(self) -> None:
        assert NAME_FAITHFULNESS != NAME_COVERAGE
        faith = _faithfulness(_Entailer())
        cov = EntityGroundingSensor(_Entailer(), direction=Direction.COVERAGE, threshold=0.8)
        assert faith.name == NAME_FAITHFULNESS
        assert cov.name == NAME_COVERAGE


@pytest.mark.parametrize("direction", list(Direction))
async def test_no_entities_is_a_vacuous_pass(direction: Direction) -> None:
    ctx = SensorContext(note_text="", transcript_text="", note_entities=[], transcript_entities=[])
    sensor = EntityGroundingSensor(_Entailer(), direction=direction, threshold=1.0)
    result = await sensor.arun(ctx)
    assert result.passed
    assert result.score == 1.0
