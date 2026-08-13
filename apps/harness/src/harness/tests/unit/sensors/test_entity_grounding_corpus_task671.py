"""The two-arm corpus control.

Before any mechanism is built, this establishes the property that makes the corpus a
valid instrument: under the **incumbent lexical sensors**, the should-recover arm and the
should-flag arm are **indistinguishable**. Both are flagged, at the same rate, for the same
reason — neither appears verbatim in the transcript.

That is what makes the joint criterion non-trivial. If the two arms scored differently
today, a mechanism could separate them without doing any inference at all, and the recovery
number would prove nothing.

Run: ``pnpm harness:test -k entity_grounding_corpus -s``
"""

from __future__ import annotations

from harness.eval.entity_grounding_corpus import CASES, total_abstracted, total_fabricated
from harness.sensors.base import NEREntity, SensorContext
from harness.sensors.computational.entity_faithfulness import EntityFaithfulnessSensor

FAITHFULNESS_THRESHOLD = 1.0
COVERAGE_THRESHOLD = 0.8


def _ents(texts: tuple[str, ...]) -> list[NEREntity]:
    return [NEREntity(text=t, type="CLINICAL") for t in texts]


def _faithfulness_score(case, note_entities: tuple[str, ...]) -> float:
    ctx = SensorContext(
        note_text=" ".join(note_entities),
        transcript_text=case.transcript,
        note_entities=_ents(note_entities),
        transcript_entities=_ents(case.transcript_entities),
    )
    return EntityFaithfulnessSensor(threshold=FAITHFULNESS_THRESHOLD).run(ctx).score


class TestCorpusShape:
    """The corpus carries both arms, and both are non-trivial."""

    def test_every_case_has_both_arms(self) -> None:
        for case in CASES:
            assert case.abstracted_entities, f"{case.name}: no should-recover arm"
            assert case.fabricated_entities, f"{case.name}: no should-flag arm"
            assert case.fabrication_basis.strip(), f"{case.name}: fabrications unjustified"

    def test_arms_are_disjoint(self) -> None:
        """A string in both arms would be simultaneously required to pass and to flag."""
        for case in CASES:
            overlap = set(case.abstracted_entities) & set(case.fabricated_entities)
            assert not overlap, f"{case.name}: {overlap} is in both arms"


class TestBothArmsAreLexicallyAbsent:
    """Neither arm appears verbatim in the transcript — the precondition for the control."""

    def test_no_arm_entity_is_lexically_present(self) -> None:
        offenders: list[str] = []
        for case in CASES:
            transcript = case.transcript.lower()
            for entity in case.abstracted_entities + case.fabricated_entities:
                if entity.lower() in transcript:
                    offenders.append(f"{case.name}: {entity!r}")
        assert not offenders, (
            "These arm entities appear verbatim in their transcript, so the lexical "
            f"sensor grounds them without inference and they carry no signal: {offenders}"
        )


class TestIncumbentCannotSeparateTheArms:
    """The control: today's lexical gate scores both arms the same, and fails both."""

    def test_lexical_faithfulness_fails_both_arms_identically(self) -> None:
        for case in CASES:
            abstracted = _faithfulness_score(case, case.abstracted_entities)
            fabricated = _faithfulness_score(case, case.fabricated_entities)
            assert abstracted < FAITHFULNESS_THRESHOLD, (
                f"{case.name}: the abstracted arm already passes lexically "
                f"({abstracted}) — it is not measuring the penalty"
            )
            assert fabricated < FAITHFULNESS_THRESHOLD, (
                f"{case.name}: the fabricated arm already passes lexically "
                f"({fabricated}) — the gate is broken, not merely lexical"
            )

    def test_report(self) -> None:
        print("\n" + "=" * 88)
        print("TASK-671 P1 — two-arm corpus, scored by the INCUMBENT lexical sensors")
        print("=" * 88)
        print(f"{'case':<28}{'abstracted':>12}{'fabricated':>12}   separable?")
        print("-" * 88)
        separable = 0
        for case in CASES:
            a = _faithfulness_score(case, case.abstracted_entities)
            f = _faithfulness_score(case, case.fabricated_entities)
            if a != f:
                separable += 1
            print(f"{case.name:<28}{a:>12.2f}{f:>12.2f}   {'yes' if a != f else 'no'}")
        print("-" * 88)
        print(f"  should-recover entities : {total_abstracted()}")
        print(f"  should-flag entities    : {total_fabricated()}")
        print(f"  cases the incumbent can separate : {separable}/{len(CASES)}")
        print()
        print("  The incumbent flags both arms alike. Any separation measured later is")
        print("  therefore attributable to inference, not to the corpus being easy.")
        print("=" * 88)

        assert separable == 0, (
            "The incumbent separates the arms, so the corpus does not isolate inference. "
            "Make the fabrications lexically indistinguishable before calibrating."
        )
