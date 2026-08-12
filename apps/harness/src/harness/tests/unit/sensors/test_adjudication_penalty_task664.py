"""TASK-664 prerequisite measurement — the lexical-sensor penalty on adjudication.

`entity_faithfulness` and `coverage_omission`
(:mod:`harness.sensors.computational`) are **lexical**: they match normalized
entity surface forms against transcript / note text with ``in``. Adjudication —
the reasoning primary reconciling two specialists' findings into one note — is
**clinical inference**, which routinely renames what it records (lay term to
clinical term, brand to generic, findings to a diagnosis, two competing
diagnoses to a superordinate one).

*Beyond Literal Summarization* (arXiv 2604.14829) reports ~35% hallucination
under lexical evaluation where inference-aware evaluation gives ~9%; most of the
gap is legitimate clinical abstraction being penalised. This module quantifies
that gap **for these two sensors specifically**, by running the real sensors over
paired notes:

* **PARROTED** — clinically correct AND lexically faithful; reuses the
  transcript's exact surface forms. This is what the sensors are tuned for.
* **ADJUDICATED** — clinically correct and *better*, but lexically divergent:
  standard clinical abstraction plus a reconciliation of the two specialists'
  disagreement, often into a term neither of them literally used.

Both notes in each pair are clinically acceptable; the adjudicated one is the one
a clinician would prefer. Any score difference between them is measurement error
attributable to lexical matching, not a real quality difference.

The entity lists model what the NLP NER pass returns — the surface forms actually
present in each text. That is exactly how ``run_sensors`` builds its
:class:`SensorContext` in production (note entities from the note, transcript
entities from the transcript), so the divergence measured here is the divergence
the gate would see.

**These tests deliberately assert that the penalty EXISTS.** They are a
regression lock on a known measurement limitation, not an aspiration: if someone
later loosens the sensors so an adjudicated note scores like a parroted one, that
also lets real fabrication through, and this file must be the thing that fails.

TASK-671 UPDATE — the penalty is now COMPENSATED, not removed
-------------------------------------------------------------
TASK-671 addressed this finding, and every assertion below still holds **unchanged and
on purpose**. It must stay that way.

What TASK-671 changed is the *gate*, not these two sensors. They are still pure lexical
matchers and still carry the full 94.4% penalty **in isolation**, which is exactly what this
module measures. The fix
(:mod:`harness.sensors.inferential.entity_grounding`) keeps the lexical match as the floor
and escalates only the entities it could not ground to an entailment check, which may
*withdraw* a flag but never create one. So the isolated-sensor penalty is deliberately
preserved: it is the conservative floor the escalation stands on. Measured on the two-arm
corpus, the escalation recovers 8/16 abstracted entities (0% → 50%) while retaining 12/12
fabrications.

If a future change makes these assertions fail, that means someone loosened the LEXICAL
sensors themselves — which is the thing TASK-664 §1.4 prohibited and TASK-671 §1.2 carried
forward, because loosening them enough to admit ``paracetamol`` for ``Tylenol`` admits a
hallucinated drug name by the same amount. Recovery belongs in the escalation, where it can
be measured against a fabrication arm. Fix the change, not this file.

Gate-level recovery is asserted separately, in
``test_aggregator_supersede_task671.py`` and ``test_entity_grounding_task671.py``.

Report:  ``pnpm harness:test -k adjudication_penalty -s``
"""

from __future__ import annotations

from dataclasses import dataclass

from harness.sensors.base import NEREntity, SensorContext
from harness.sensors.computational.coverage_omission import CoverageOmissionSensor
from harness.sensors.computational.entity_faithfulness import EntityFaithfulnessSensor

# The sensors' own production defaults — not re-tuned here, on purpose.
FAITHFULNESS_THRESHOLD = 1.0
COVERAGE_THRESHOLD = 0.8


def _ents(*texts: str) -> list[NEREntity]:
    """NER spans as the NLP pass returns them (offsets are irrelevant to these sensors)."""
    return [NEREntity(text=t, type="CLINICAL") for t in texts]


@dataclass(frozen=True)
class AdjudicationCase:
    """One consultation: a transcript, two specialist views, and two candidate notes."""

    name: str
    abstraction: str
    transcript: str
    transcript_entities: list[NEREntity]
    specialist_a: str
    specialist_b: str
    parroted_note: str
    parroted_entities: list[NEREntity]
    adjudicated_note: str
    adjudicated_entities: list[NEREntity]
    basis: str


CASES: list[AdjudicationCase] = [
    AdjudicationCase(
        name="lay-to-clinical",
        abstraction="lay symptom description -> standard clinical term",
        transcript=(
            "Patient says he gets short of breath walking up the stairs and his "
            "ankles have been puffy for about a week."
        ),
        transcript_entities=_ents("short of breath", "ankles have been puffy"),
        specialist_a="Exertional breathlessness with ankle swelling.",
        specialist_b="Reduced exercise tolerance; peripheral oedema.",
        parroted_note=(
            "Subjective: Patient reports being short of breath walking up the stairs. "
            "Ankles have been puffy for about a week."
        ),
        parroted_entities=_ents("short of breath", "ankles have been puffy"),
        adjudicated_note=(
            "Subjective: Exertional dyspnoea on climbing stairs, with one-week history "
            "of bilateral peripheral oedema."
        ),
        adjudicated_entities=_ents("exertional dyspnoea", "bilateral peripheral oedema"),
        basis="Both specialists describe the same two findings; adjudicated to standard terms.",
    ),
    AdjudicationCase(
        name="brand-to-generic",
        abstraction="brand name -> generic (INN) drug name",
        transcript=(
            "She has been taking Tylenol three times a day and a Ventolin puffer "
            "when she needs it."
        ),
        transcript_entities=_ents("Tylenol", "Ventolin"),
        specialist_a="Tylenol TDS; Ventolin PRN.",
        specialist_b="Regular analgesia; bronchodilator as required.",
        parroted_note="Plan: Continue Tylenol three times a day and Ventolin as needed.",
        parroted_entities=_ents("Tylenol", "Ventolin"),
        adjudicated_note=(
            "Plan: Continue paracetamol 1 g three times daily and salbutamol inhaler "
            "as required."
        ),
        adjudicated_entities=_ents("paracetamol", "salbutamol"),
        basis="Specialist A named brands, B named classes; adjudicated to INN generics.",
    ),
    AdjudicationCase(
        name="findings-to-diagnosis",
        abstraction="raw findings -> named diagnosis (inference, not restatement)",
        transcript=(
            "His sugar reading this morning was 320 and he says he is thirsty all the "
            "time and getting up at night to pass urine."
        ),
        transcript_entities=_ents("sugar reading", "thirsty all the time", "pass urine"),
        specialist_a="Elevated capillary glucose with osmotic symptoms.",
        specialist_b="Polydipsia and nocturia; glucose 320.",
        parroted_note=(
            "Objective: Sugar reading 320. Subjective: thirsty all the time, getting up "
            "at night to pass urine."
        ),
        parroted_entities=_ents("sugar reading", "thirsty all the time", "pass urine"),
        adjudicated_note=(
            "Objective: Capillary blood glucose 320 mg/dL. Assessment: Hyperglycaemia "
            "with osmotic symptoms (polydipsia, nocturia)."
        ),
        adjudicated_entities=_ents(
            "capillary blood glucose", "hyperglycaemia", "polydipsia", "nocturia"
        ),
        basis="Both views agree on the findings; the primary names the syndrome they imply.",
    ),
    AdjudicationCase(
        name="disagreement-adjudicated",
        abstraction="two competing diagnoses -> reconciled term neither specialist used",
        transcript=(
            "Cough for five days with green phlegm, temperature 38.4, some crackles at "
            "the right base on listening."
        ),
        transcript_entities=_ents("cough", "green phlegm", "temperature 38.4", "crackles"),
        specialist_a="Community-acquired pneumonia, right lower lobe.",
        specialist_b="Acute bronchitis; no consolidation demonstrated.",
        parroted_note=(
            "Assessment: Cough with green phlegm, temperature 38.4, crackles at the "
            "right base."
        ),
        parroted_entities=_ents("cough", "green phlegm", "temperature 38.4", "crackles"),
        adjudicated_note=(
            "Assessment: Lower respiratory tract infection with focal right basal signs. "
            "Pneumonia is not excluded and imaging is requested; bronchitis remains the "
            "alternative."
        ),
        adjudicated_entities=_ents(
            "lower respiratory tract infection",
            "focal right basal signs",
            "pneumonia",
            "bronchitis",
        ),
        basis="Specialists disagreed; the primary records the superordinate term + both views.",
    ),
    AdjudicationCase(
        name="measurement-normalised",
        abstraction="spoken measurement -> normalised units",
        transcript=(
            "Blood pressure today was a hundred and forty over ninety, pulse eighty-eight."
        ),
        transcript_entities=_ents("a hundred and forty over ninety", "eighty-eight"),
        specialist_a="BP 140/90, HR 88.",
        specialist_b="Mildly elevated blood pressure; normal rate.",
        parroted_note=(
            "Objective: Blood pressure a hundred and forty over ninety, pulse eighty-eight."
        ),
        parroted_entities=_ents("a hundred and forty over ninety", "eighty-eight"),
        adjudicated_note="Objective: BP 140/90 mmHg, HR 88 bpm.",
        adjudicated_entities=_ents("140/90 mmHg", "88 bpm"),
        basis="Identical values; adjudicated to the recorded numeric form.",
    ),
    AdjudicationCase(
        name="temporal-abstraction",
        abstraction="relative time reference -> duration",
        transcript=(
            "The chest pain started last Tuesday and he had a similar episode back in March."
        ),
        transcript_entities=_ents("chest pain", "last Tuesday", "March"),
        specialist_a="Chest pain since last Tuesday, prior episode in March.",
        specialist_b="Recurrent chest pain; second episode this year.",
        parroted_note="Subjective: Chest pain started last Tuesday, similar episode in March.",
        parroted_entities=_ents("chest pain", "last Tuesday", "March"),
        adjudicated_note=(
            "Subjective: Six-day history of chest pain; recurrent, with a prior episode "
            "five months earlier."
        ),
        adjudicated_entities=_ents("chest pain", "six-day history", "recurrent"),
        basis="Both agree on recurrence; the primary converts to durations for the record.",
    ),
]


def _context(case: AdjudicationCase, *, adjudicated: bool) -> SensorContext:
    return SensorContext(
        note_text=case.adjudicated_note if adjudicated else case.parroted_note,
        transcript_text=case.transcript,
        note_entities=case.adjudicated_entities if adjudicated else case.parroted_entities,
        transcript_entities=case.transcript_entities,
    )


def _scores(case: AdjudicationCase, *, adjudicated: bool) -> tuple[float, float, list[str], list[str]]:
    ctx = _context(case, adjudicated=adjudicated)
    faith = EntityFaithfulnessSensor(threshold=FAITHFULNESS_THRESHOLD).run(ctx)
    cov = CoverageOmissionSensor(threshold=COVERAGE_THRESHOLD).run(ctx)
    return faith.score, cov.score, faith.claims_flagged, cov.claims_flagged


class TestParrotedNotesScoreWell:
    """Control arm: a lexically faithful note passes both sensors on every case."""

    def test_every_parroted_note_passes_both_sensors(self) -> None:
        for case in CASES:
            faith, cov, _, _ = _scores(case, adjudicated=False)
            assert faith >= FAITHFULNESS_THRESHOLD, f"{case.name}: faithfulness {faith}"
            assert cov >= COVERAGE_THRESHOLD, f"{case.name}: coverage {cov}"


class TestAdjudicatedNotesArePenalised:
    """Treatment arm: the same clinical content, abstracted, is scored as defective."""

    def test_clinically_correct_adjudication_fails_entity_faithfulness(self) -> None:
        """Abstracted note entities read as FABRICATIONS to a lexical matcher."""
        failing = [c.name for c in CASES if _scores(c, adjudicated=True)[0] < FAITHFULNESS_THRESHOLD]
        assert failing, (
            "No adjudicated case was penalised — either the cases stopped being "
            "lexically divergent, or the sensor stopped being lexical. Re-measure "
            "before trusting the gate on adjudicated notes."
        )

    def test_clinically_correct_adjudication_fails_coverage_omission(self) -> None:
        """Transcript terms recorded under a different name read as OMISSIONS."""
        failing = [c.name for c in CASES if _scores(c, adjudicated=True)[1] < COVERAGE_THRESHOLD]
        assert failing, "No adjudicated case was penalised on coverage — re-measure."

    def test_the_reconciled_disagreement_is_the_worst_penalised(self) -> None:
        """The case that most needs reasoning is the one lexical scoring punishes hardest."""
        adjudged = next(c for c in CASES if c.name == "disagreement-adjudicated")
        faith, cov, flagged_fab, flagged_omit = _scores(adjudged, adjudicated=True)
        # "lower respiratory tract infection" is an inference from the transcript,
        # so it has no lexical support; the transcript's own findings are recorded
        # under that heading rather than repeated, so they read as omitted.
        assert faith < FAITHFULNESS_THRESHOLD
        assert cov < COVERAGE_THRESHOLD
        assert flagged_fab, "the reconciled diagnosis should be flagged as unsupported"
        assert flagged_omit, "the superseded findings should be flagged as omitted"


class TestPenaltyMagnitude:
    """The number that goes in the README."""

    def test_report(self) -> None:
        rows = []
        for case in CASES:
            pf, pc, _, _ = _scores(case, adjudicated=False)
            af, ac, fflag, cflag = _scores(case, adjudicated=True)
            rows.append((case, pf, af, pc, ac, fflag, cflag))

        n = len(rows)
        pf_avg = sum(r[1] for r in rows) / n
        af_avg = sum(r[2] for r in rows) / n
        pc_avg = sum(r[3] for r in rows) / n
        ac_avg = sum(r[4] for r in rows) / n
        faith_pass = sum(1 for r in rows if r[2] >= FAITHFULNESS_THRESHOLD)
        cov_pass = sum(1 for r in rows if r[4] >= COVERAGE_THRESHOLD)

        print("\n" + "=" * 92)
        print("TASK-664 — lexical-sensor penalty on clinically-correct adjudication")
        print("=" * 92)
        print(
            f"entity_faithfulness threshold = {FAITHFULNESS_THRESHOLD:.2f}   "
            f"coverage_omission threshold = {COVERAGE_THRESHOLD:.2f}\n"
        )
        print(f"{'case':<28}{'faith(par)':>11}{'faith(adj)':>11}{'cov(par)':>10}{'cov(adj)':>10}")
        print("-" * 92)
        for case, pf, af, pc, ac, _, _ in rows:
            print(f"{case.name:<28}{pf:>11.2f}{af:>11.2f}{pc:>10.2f}{ac:>10.2f}")
        print("-" * 92)
        print(f"{'MEAN':<28}{pf_avg:>11.3f}{af_avg:>11.3f}{pc_avg:>10.3f}{ac_avg:>10.3f}")
        print()
        print(f"  entity_faithfulness penalty : {pf_avg - af_avg:.3f} absolute "
              f"({(pf_avg - af_avg) / pf_avg * 100:.1f}% relative)")
        print(f"  coverage_omission   penalty : {pc_avg - ac_avg:.3f} absolute "
              f"({(pc_avg - ac_avg) / pc_avg * 100:.1f}% relative)")
        print(f"  adjudicated notes passing entity_faithfulness : {faith_pass}/{n}")
        print(f"  adjudicated notes passing coverage_omission   : {cov_pass}/{n}")
        print()
        print("  Per-case flags on the ADJUDICATED (clinically correct) notes:")
        for case, _, _, _, _, fflag, cflag in rows:
            if fflag:
                print(f"    {case.name}: 'fabricated' -> {fflag}")
            if cflag:
                print(f"    {case.name}: 'omitted'    -> {cflag}")
        print()
        print("  Every adjudicated note above is clinically correct. Each point of penalty")
        print("  is measurement error from lexical matching, not a documentation defect.")
        print("=" * 92)

        # Lock the finding: the penalty is real and large on both sensors.
        assert pf_avg - af_avg > 0.5, "faithfulness penalty vanished — re-measure"
        assert pc_avg - ac_avg > 0.5, "coverage penalty vanished — re-measure"
